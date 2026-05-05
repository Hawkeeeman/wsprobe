#!/usr/bin/env node
import { Command } from "commander";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";
import readline from "node:readline";

const VERSION = "0.2.1";
const GRAPHQL_URL = "https://my.wealthsimple.com/graphql";
const TRADE_SERVICE_BASE = "https://trade-service.wealthsimple.com";
const OAUTH_TOKEN_URL = "https://api.production.wealthsimple.com/v1/oauth/v2/token";
const OAUTH_TOKEN_INFO_URL = "https://api.production.wealthsimple.com/v1/oauth/v2/token/info";
const SESSION_INFO_URL = "https://api.production.wealthsimple.com/api/sessions";
const DEFAULT_OAUTH_CLIENT_ID = "4da53ac2b03225bed1550eba8e4611e086c7b905a3855e6ed12ea08c246758fa";
const CONFIG_DIR = path.join(os.homedir(), ".config", "wsli");
const SESSION_FILE = path.join(CONFIG_DIR, "session.json");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const ACCOUNT_ALIASES_FILE = path.join(CONFIG_DIR, "account_aliases.json");
const LOG_FILE = path.join(CONFIG_DIR, "logs.jsonl");
const BUY_HISTORY_FILE = path.join(CONFIG_DIR, "buy_history.jsonl");
const KEEPALIVE_PID_FILE = path.join(CONFIG_DIR, "keepalive.pid");
const DEFAULT_API_VERSION = "12";
const SESSION_ID = crypto.randomUUID().replace(/-/g, "").slice(0, 12);

const FETCH_TRADE_ACCOUNT_LIST = `
query FetchTradeAccountList($identityId: ID!, $pageSize: Int = 50, $cursor: String) {
  identity(id: $identityId) {
    id
    accounts(filter: {}, first: $pageSize, after: $cursor) {
      pageInfo { hasNextPage endCursor __typename }
      edges {
        node {
          id
          status
          unifiedAccountType
          nickname
          currency
          custodianAccounts { id branch status __typename }
          financials {
            currentCombined {
              netLiquidationValue { amount currency __typename }
              netDeposits { amount currency __typename }
              __typename
            }
            __typename
          }
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
}
`;

const FETCH_ACCOUNT_POSITIONS = `
query FetchAccountPositions($accountId: ID!) {
  account(id: $accountId) {
    id
    positions {
      id
      symbol
      name
      quantity
      value
      currency
      __typename
    }
    __typename
  }
}
`;

const FETCH_SECURITY = `
query FetchSecurity($securityId: ID!) {
  security(id: $securityId) {
    id
    active
    buyable
    wsTradeEligible
    wsTradeIneligibilityReason
    status
    securityType
    stock { symbol name primaryExchange __typename }
    __typename
  }
}
`;

const FETCH_SECURITY_QUOTES = `
query FetchIntraDayChartQuotes(
  $id: ID!
  $date: Date
  $tradingSession: TradingSession
  $currency: Currency
  $period: ChartPeriod
) {
  security(id: $id) {
    id
    chartBarQuotes(
      date: $date
      tradingSession: $tradingSession
      currency: $currency
      period: $period
    ) {
      securityId
      price
      sessionPrice
      timestamp
      currency
      marketStatus
      __typename
    }
    __typename
  }
}
`;

const FETCH_SO_ORDERS_LIMIT_ORDER_RESTRICTIONS = `
query FetchSoOrdersLimitOrderRestrictions($args: SoOrders_LimitOrderRestrictionsArgs!) {
  soOrdersLimitOrderRestrictions(args: $args) {
    limitPriceThresholds
    __typename
  }
}
`;

const FETCH_SECURITY_SEARCH = `
query FetchSecuritySearchResult($query: String!) {
  securitySearch(input: {query: $query}) {
    results {
      id
      buyable
      status
      stock { symbol name primaryExchange __typename }
      __typename
    }
    __typename
  }
}
`;

const MUTATION_SO_ORDERS_ORDER_CREATE = `
mutation SoOrdersOrderCreate($input: SoOrders_CreateOrderInput!) {
  soOrdersCreateOrder(input: $input) {
    errors { code message __typename }
    order { orderId createdAt __typename }
    __typename
  }
}
`;

const MUTATION_FUNDING_INTENT_INTERNAL_TRANSFER_CREATE = `
mutation FundingIntentInternalTransferCreate($input: CreateFundingIntentInternalTransferInput!) {
  createFundingIntentInternalTransfer: create_funding_intent_internal_transfer(input: $input) {
    ... on FundingIntent {
      id
      __typename
    }
    __typename
  }
}
`;

const FETCH_SO_ORDERS_EXTENDED_ORDER = `
query FetchSoOrdersExtendedOrder($branchId: String!, $externalId: String!) {
  soOrdersExtendedOrder(branchId: $branchId, externalId: $externalId) {
    accountId
    canonicalAccountId
    securityId
    status
    submittedQuantity
    submittedNetValue
    averageFilledPrice
    filledQuantity
    rejectionCode
    rejectionCause
    __typename
  }
}
`;

type OAuthBundle = {
  access_token: string;
  refresh_token?: string;
  client_id?: string;
  [key: string]: unknown;
};

type GlobalOptions = {
  tokenFile?: string;
  accessToken?: string;
  refreshToken?: string;
};

const EXPORT_SESSION_SNIPPET = `(() => {
  const out = { access_token: "", refresh_token: "", client_id: "" };
  const cookie = document.cookie.match(/(?:^|;\\s*)_oauth2_access_v2=([^;]+)/);
  if (!cookie) {
    console.error("Cookie _oauth2_access_v2 not found. Ensure you are logged in at my.wealthsimple.com.");
    return;
  }
  try {
    const parsed = JSON.parse(decodeURIComponent(cookie[1].trim()));
    if (typeof parsed.access_token === "string") out.access_token = parsed.access_token;
    if (typeof parsed.refresh_token === "string") out.refresh_token = parsed.refresh_token;
    if (typeof parsed.client_id === "string") out.client_id = parsed.client_id;
    if (!out.access_token) {
      console.error("No access_token found in cookie payload.");
      return;
    }
    console.log(\`access_token=\${out.access_token}\`);
    if (out.refresh_token) console.log(\`refresh_token=\${out.refresh_token}\`);
    if (out.client_id) console.log(\`client_id=\${out.client_id}\`);
  } catch (err) {
    console.error("Failed to parse cookie payload:", err);
  }
})();`;

function ensureConfigDir(): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
}

function readJsonFile(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

function writeJsonFile(filePath: string, data: unknown): void {
  ensureConfigDir();
  writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function parseSessionInput(raw: string): OAuthBundle {
  const text = raw.trim();
  if (!text) throw new Error("No session input received.");
  if (text.startsWith("{") && text.endsWith("}")) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const access = parsed.access_token;
      if (typeof access !== "string" || !access.trim()) {
        throw new Error("Session input must include access_token.");
      }
      const payload: OAuthBundle = { access_token: access.trim() };
      if (typeof parsed.refresh_token === "string" && parsed.refresh_token.trim()) {
        payload.refresh_token = parsed.refresh_token.trim();
      }
      if (typeof parsed.client_id === "string" && parsed.client_id.trim()) {
        payload.client_id = parsed.client_id.trim();
      }
      return payload;
    } catch (err) {
      if (err instanceof Error && err.message === "Session input must include access_token.") {
        throw err;
      }
      throw new Error("Invalid JSON session input.");
    }
  }
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const payload: OAuthBundle = { access_token: "" };
  for (const line of lines) {
    const accessMatch = line.match(/(?:^|\s)access[_-]?token\s*=\s*(.+)$/i);
    if (accessMatch?.[1]?.trim()) {
      payload.access_token = accessMatch[1].trim();
      continue;
    }
    const refreshMatch = line.match(/(?:^|\s)refresh[_-]?token\s*=\s*(.+)$/i);
    if (refreshMatch?.[1]?.trim()) {
      payload.refresh_token = refreshMatch[1].trim();
      continue;
    }
    const clientMatch = line.match(/(?:^|\s)client[_-]?id\s*=\s*(.+)$/i);
    if (clientMatch?.[1]?.trim()) {
      payload.client_id = clientMatch[1].trim();
      continue;
    }
    const splitAt = line.indexOf("=");
    if (splitAt <= 0) continue;
    const key = line.slice(0, splitAt).trim().toLowerCase();
    const value = line.slice(splitAt + 1).trim();
    if (!value) continue;
    if (key === "access_token" || key === "access-token") payload.access_token = value;
    if (key === "refresh_token" || key === "refresh-token") payload.refresh_token = value;
    if (key === "client_id" || key === "client-id") payload.client_id = value;
  }
  if (!payload.access_token) {
    if (lines.length === 1 && !lines[0].includes("=")) {
      payload.access_token = lines[0];
    } else {
      throw new Error("Session input must include access_token.");
    }
  }
  return payload;
}

async function readAllStdinInteractive(): Promise<string> {
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const lines: string[] = [];
    await new Promise<void>((resolve) => {
      rl.on("line", (line) => {
        lines.push(line);
      });
      rl.on("close", () => resolve());
    });
    return lines.join("\n");
  }
  return readFileSync(0, "utf-8");
}

function writeJsonl(filePath: string, row: Record<string, unknown>): void {
  ensureConfigDir();
  const payload = { ...row };
  const line = `${JSON.stringify(payload)}\n`;
  if (existsSync(filePath)) {
    const prior = readFileSync(filePath, "utf-8");
    writeFileSync(filePath, prior + line, "utf-8");
  } else {
    writeFileSync(filePath, line, "utf-8");
  }
}

function readJsonl(filePath: string, limit: number): Record<string, unknown>[] {
  if (limit <= 0 || !existsSync(filePath)) return [];
  const lines = readFileSync(filePath, "utf-8").split("\n");
  const out: Record<string, unknown>[] = [];
  for (const line of lines) {
    const text = line.trim();
    if (!text) continue;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object") out.push(parsed as Record<string, unknown>);
    } catch {
      // ignore malformed rows
    }
  }
  return out.length > limit ? out.slice(-limit) : out;
}

function appendLog(entry: Record<string, unknown>): void {
  writeJsonl(LOG_FILE, {
    ts_utc: new Date().toISOString(),
    log_id: `log-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`,
    session_id: SESSION_ID,
    level: "info",
    ...entry
  });
}

function appendBuyHistory(entry: Record<string, unknown>): void {
  const historyId = String(entry.history_id ?? "").trim() || `trd-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
  writeJsonl(BUY_HISTORY_FILE, {
    ts_utc: new Date().toISOString(),
    history_id: historyId,
    ...entry
  });
  appendLog({
    event: "buy_history_append",
    history_id: historyId,
    status: String(entry.status ?? "unknown"),
    symbol: entry.symbol,
    account_id: entry.account_id,
    order_id: entry.order_id
  });
}

function ensureHistoryIds(rows: Record<string, unknown>[]): { rows: Record<string, unknown>[]; updated: boolean } {
  let updated = false;
  const normalized = rows.map((row) => {
    const existing = String(row.history_id ?? "").trim();
    if (existing) return row;
    updated = true;
    return {
      ...row,
      history_id: `trd-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`
    };
  });
  return { rows: normalized, updated };
}

function writeJsonlRows(filePath: string, rows: Record<string, unknown>[]): void {
  const content = rows.map((row) => JSON.stringify(row)).join("\n");
  writeFileSync(filePath, content ? `${content}\n` : "", "utf-8");
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const raw = Buffer.from(parts[1], "base64url").toString("utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function jwtExpUnix(accessToken: string): number | null {
  const payload = decodeJwtPayload(accessToken);
  if (!payload || typeof payload.exp !== "number") return null;
  return payload.exp;
}

function accessTokenNeedsRefresh(accessToken: string, skewSeconds = 120): boolean {
  const exp = jwtExpUnix(accessToken);
  if (exp === null) return false;
  return Date.now() / 1000 >= exp - skewSeconds;
}

function identityIdFromToken(token: string): string | null {
  const payload = decodeJwtPayload(token);
  if (!payload) return null;
  const sub = payload.sub;
  if (typeof sub === "string" && sub.trim()) return sub;
  const canonical = payload.identity_canonical_id;
  if (typeof canonical === "string" && canonical.trim()) return canonical;
  const identityId = payload.identity_id;
  if (typeof identityId === "string" && identityId.trim()) return identityId;
  return null;
}

function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function maybeStartKeepalive(bundle: OAuthBundle): void {
  if (!bundle.refresh_token) return;
  let existingPid = 0;
  if (existsSync(KEEPALIVE_PID_FILE)) {
    const raw = readFileSync(KEEPALIVE_PID_FILE, "utf-8").trim();
    existingPid = Number.parseInt(raw, 10);
  }
  if (isProcessRunning(existingPid)) return;
  const entryScript = process.argv[1];
  if (!entryScript) return;
  const child = spawn(process.execPath, [entryScript, "keepalive"], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  writeFileSync(KEEPALIVE_PID_FILE, `${child.pid}\n`, "utf-8");
  appendLog({ event: "auth_keeper_autostart", status: "ok", pid: child.pid });
}

function keepaliveStatus(): "Active" | "Inactive" {
  if (!existsSync(KEEPALIVE_PID_FILE)) return "Inactive";
  const raw = readFileSync(KEEPALIVE_PID_FILE, "utf-8").trim();
  const pid = Number.parseInt(raw, 10);
  return isProcessRunning(pid) ? "Active" : "Inactive";
}

function readKeepalivePid(): number {
  if (!existsSync(KEEPALIVE_PID_FILE)) return 0;
  const raw = readFileSync(KEEPALIVE_PID_FILE, "utf-8").trim();
  return Number.parseInt(raw, 10);
}

function writeKeepalivePid(pid: number): void {
  writeFileSync(KEEPALIVE_PID_FILE, `${pid}\n`, "utf-8");
}

function clearKeepalivePidIfOwned(ownerPid: number): void {
  const pid = readKeepalivePid();
  if (pid !== ownerPid) return;
  try {
    unlinkSync(KEEPALIVE_PID_FILE);
  } catch {
    // ignore cleanup errors
  }
}

function tokenFingerprint(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 12);
}

function jitterDelayMs(baseMs: number): number {
  const min = Math.max(1, Math.floor(baseMs * 0.8));
  const max = Math.max(min, Math.ceil(baseMs * 1.2));
  return min + Math.floor(Math.random() * (max - min + 1));
}

async function sleepMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function getSessionInfo(accessToken: string): Promise<Record<string, unknown> | null> {
  const response = await fetch(SESSION_INFO_URL, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`
    }
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`session info HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

function extractActivityAgeSeconds(sessionInfo: Record<string, unknown>): number | null {
  const now = Date.now() / 1000;
  const candidateKeys = ["last_active_at", "last_activity_at", "last_seen_at", "updated_at", "created_at"];
  for (const key of candidateKeys) {
    const raw = sessionInfo[key];
    if (typeof raw !== "string" || !raw.trim()) continue;
    const parsed = Date.parse(raw);
    if (!Number.isFinite(parsed)) continue;
    return Math.max(0, now - parsed / 1000);
  }
  return null;
}

function extractIdleTimeoutSeconds(sessionInfo: Record<string, unknown>): number {
  const candidateKeys = ["idle_timeout_seconds", "idle_timeout_s", "idleTimeoutSeconds", "max_idle_seconds"];
  for (const key of candidateKeys) {
    const raw = sessionInfo[key];
    const parsed = typeof raw === "number" ? raw : Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return 900;
}

async function refreshAccessToken(bundle: OAuthBundle): Promise<OAuthBundle> {
  if (!bundle.refresh_token) {
    throw new Error("Access token expired or near expiry and no refresh token is available.");
  }
  const body = {
    grant_type: "refresh_token",
    refresh_token: bundle.refresh_token,
    client_id: bundle.client_id ?? process.env.WEALTHSIMPLE_OAUTH_CLIENT_ID ?? DEFAULT_OAUTH_CLIENT_ID
  };
  const response = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      origin: "https://my.wealthsimple.com",
      referer: "https://my.wealthsimple.com/",
      "x-wealthsimple-client": "@wealthsimple/wealthsimple"
    },
    body: JSON.stringify(body)
  });
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok || typeof payload.access_token !== "string") {
    throw new Error(`OAuth refresh failed HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }
  return { ...bundle, ...payload, access_token: payload.access_token as string };
}

function loadBundleFromPath(filePath: string): OAuthBundle | null {
  if (!existsSync(filePath)) return null;
  const raw = readJsonFile(filePath);
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  if (typeof data.access_token !== "string" || !data.access_token.trim()) return null;
  return data as OAuthBundle;
}

async function resolveOAuthBundle(opts: GlobalOptions): Promise<OAuthBundle> {
  if (opts.accessToken) {
    const bundle: OAuthBundle = { access_token: opts.accessToken };
    if (opts.refreshToken) bundle.refresh_token = opts.refreshToken;
    if (process.env.WEALTHSIMPLE_OAUTH_CLIENT_ID) bundle.client_id = process.env.WEALTHSIMPLE_OAUTH_CLIENT_ID;
    return bundle;
  }

  if (opts.tokenFile) {
    const fileBundle = loadBundleFromPath(path.resolve(opts.tokenFile));
    if (!fileBundle) throw new Error(`No access_token in ${opts.tokenFile}`);
    return fileBundle;
  }

  if (process.env.WEALTHSIMPLE_ACCESS_TOKEN) {
    return {
      access_token: process.env.WEALTHSIMPLE_ACCESS_TOKEN,
      refresh_token: process.env.WEALTHSIMPLE_REFRESH_TOKEN,
      client_id: process.env.WEALTHSIMPLE_OAUTH_CLIENT_ID
    };
  }

  const configBundle = loadBundleFromPath(CONFIG_FILE);
  if (configBundle) return configBundle;

  const sessionBundle = loadBundleFromPath(SESSION_FILE);
  if (sessionBundle) return sessionBundle;

  throw new Error(
    "No credentials found. Run wsli setup or wsli import-session <tokens.txt>, or set WEALTHSIMPLE_ACCESS_TOKEN. " +
      `(Session file: ${SESSION_FILE}.)`
  );
}

async function resolveAccessToken(opts: GlobalOptions): Promise<{ token: string; bundle: OAuthBundle }> {
  let bundle = await resolveOAuthBundle(opts);
  const noRefresh = ["1", "true", "yes"].includes(
    String(process.env.WSLI_NO_REFRESH ?? "").trim().toLowerCase()
  );
  if (!noRefresh && accessTokenNeedsRefresh(bundle.access_token) && bundle.refresh_token) {
    try {
      bundle = await refreshAccessToken(bundle);
      writeJsonFile(SESSION_FILE, bundle);
    } catch (err) {
      const exp = jwtExpUnix(bundle.access_token);
      const stillValid = exp !== null && Date.now() / 1000 < exp;
      if (stillValid) {
        appendLog({
          event: "oauth_refresh_skipped",
          status: "warn",
          message: err instanceof Error ? err.message : String(err)
        });
      } else {
        throw err;
      }
    }
  }
  return { token: bundle.access_token, bundle };
}

async function graphqlRequest(
  token: string,
  operationName: string,
  query: string,
  variables: Record<string, unknown>,
  bundle?: OAuthBundle
): Promise<Record<string, unknown>> {
  const identityId = identityIdFromToken(token) ?? (bundle?.identity_canonical_id as string | undefined);
  const varsObj = variables as Record<string, unknown>;
  const argsObj = (varsObj.args as Record<string, unknown> | undefined) ?? {};
  const inputObj = (varsObj.input as Record<string, unknown> | undefined) ?? {};
  const securityIdCandidate =
    (typeof varsObj.securityId === "string" && varsObj.securityId) ||
    (typeof varsObj.id === "string" && String(varsObj.id).startsWith("sec-s-") ? (varsObj.id as string) : "") ||
    (typeof argsObj.securityId === "string" && argsObj.securityId) ||
    (typeof inputObj.securityId === "string" && inputObj.securityId) ||
    "";
  const refererPath = securityIdCandidate
    ? `https://my.wealthsimple.com/app/security-details/${securityIdCandidate}`
    : "https://my.wealthsimple.com/";
  const pageName = securityIdCandidate ? "page-security-details" : "page-home";
  const response = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      accept: "*/*",
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      origin: "https://my.wealthsimple.com",
      referer: refererPath,
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
      "x-ws-api-version": DEFAULT_API_VERSION,
      "x-ws-profile": "trade",
      "x-ws-locale": "en-CA",
      "x-ws-client-tier": "core",
      "x-platform-os": "web",
      "x-ws-request-timeout": "4000",
      "x-ws-device-id": "182f4094-2830-4847-bede-e73731e65c8a",
      "x-ws-operation-name": operationName,
      "x-ws-client-library": "wsli",
      "x-ws-page": pageName,
      ...(identityId ? { "x-ws-identity-id": identityId } : {})
    },
    body: JSON.stringify({ operationName, query, variables })
  });
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`${operationName} HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }
  const errs = payload.errors;
  if (Array.isArray(errs) && errs.length) throw new Error(`${operationName} errors: ${JSON.stringify(errs)}`);
  return payload;
}

async function tradeRequest(
  token: string,
  method: string,
  pathName: string,
  body?: Record<string, unknown>
): Promise<unknown> {
  const response = await fetch(`${TRADE_SERVICE_BASE}${pathName}`, {
    method,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      origin: "https://my.wealthsimple.com",
      referer: "https://my.wealthsimple.com/"
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${pathName} HTTP ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

function print(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function accountTypeFromUnified(unified?: string): string | null {
  if (!unified) return null;
  const map: Record<string, string> = {
    SELF_DIRECTED_TFSA: "ca_tfsa",
    MANAGED_TFSA: "ca_tfsa",
    SELF_DIRECTED_RRSP: "ca_rrsp",
    MANAGED_RRSP: "ca_rrsp",
    SELF_DIRECTED_NON_REGISTERED: "ca_non_registered",
    SELF_DIRECTED_NON_REGISTERED_MARGIN: "ca_non_registered",
    SELF_DIRECTED_JOINT_NON_REGISTERED: "ca_joint",
    SELF_DIRECTED_FHSA: "ca_fhsa",
    SELF_DIRECTED_RESP: "ca_resp",
    SELF_DIRECTED_RRIF: "ca_rrif",
    SELF_DIRECTED_LIRA: "ca_lira",
    SELF_DIRECTED_LRSP: "ca_lrsp"
  };
  if (map[unified]) return map[unified];
  const up = unified.toUpperCase();
  if (up.includes("TFSA")) return "ca_tfsa";
  if (up.includes("FHSA")) return "ca_fhsa";
  if (up.includes("RRSP")) return "ca_rrsp";
  if (up.includes("RESP")) return "ca_resp";
  if (up.includes("JOINT")) return "ca_joint";
  if (up.includes("NON_REGISTERED") || up.includes("MARGIN")) return "ca_non_registered";
  return null;
}

function parseIsoToUnix(value: string): number | null {
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return null;
  return ts / 1000;
}

function parseSinceSeconds(value: string): number | null {
  const text = (value ?? "").trim().toLowerCase();
  if (!text) return null;
  const match = text.match(/^(\d+)([smhd])$/);
  if (!match) throw new Error("--since must look like 30m, 2h, 1d, or 45s");
  const qty = Number.parseInt(match[1], 10);
  const unit = match[2];
  const mult: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  return qty * mult[unit];
}

function parsePositiveIntOption(value: string | undefined, optionName: string, defaultValue?: number): number {
  if (value === undefined || value === "") {
    if (defaultValue !== undefined) return defaultValue;
    throw new Error(`${optionName} is required.`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${optionName} must be a positive integer.`);
  }
  return parsed;
}

function globMatch(text: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(text);
}

function formatMoney(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatLocalTime(value: string): string {
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return value || "Unknown";
  const local = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(ts));
  const zone = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
    .formatToParts(new Date(ts))
    .find((part) => part.type === "timeZoneName")?.value;
  return zone ? `${local} ${zone}` : local;
}

function formatAge(value: string): string | null {
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return null;
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function titleCase(value: string): string {
  if (!value) return "Unknown";
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function displayStatus(value: string): string {
  const clean = value.trim().toLowerCase();
  if (!clean) return "Unknown";
  if (clean === "new") return "Pending";
  return titleCase(clean);
}

function accountTypeLabel(value: string): string {
  const clean = value.trim().toLowerCase();
  const map: Record<string, string> = {
    ca_tfsa: "TFSA",
    ca_rrsp: "RRSP",
    ca_fhsa: "FHSA",
    ca_resp: "RESP",
    ca_joint: "Joint",
    ca_non_registered: "Non-registered",
    ca_rrif: "RRIF",
    ca_lira: "LIRA",
    ca_lrsp: "LRSP"
  };
  return map[clean] ?? titleCase(clean.replace(/^ca_/, "") || "account");
}

function buildAccountLabelMap(accounts: Record<string, unknown>[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of accounts) {
    const id = String(row.id ?? "").trim();
    if (!id) continue;
    const type = accountTypeLabel(String(row.account_type ?? ""));
    const nickname = String(row.nickname ?? "").trim();
    const label = nickname ? `${type} (${nickname})` : type;
    out.set(id, label);
  }
  return out;
}

function formatHistoryEntry(row: Record<string, unknown>, index: number, accountLabels: Map<string, string>): string {
  const historyId = String(row.history_id ?? "").trim();
  const side = String(row.side ?? "").trim().toLowerCase();
  const orderStyle = String(row.order_style ?? "").trim();
  const action = `${orderStyle ? `${titleCase(orderStyle)} ` : ""}${titleCase(side || "trade")}`.trim();
  const symbol = String(row.symbol ?? "").trim().toUpperCase() || "Unknown";
  const accountId = String(row.account_id ?? "").trim();
  const account = accountLabels.get(accountId) ?? "Unknown";
  const status = displayStatus(String(row.status ?? "unknown"));
  const tsUtc = String(row.ts_utc ?? "");
  const tsLabel = formatLocalTime(tsUtc);
  const age = formatAge(tsUtc);
  const submittedValue = Number(row.submitted_value);
  const submittedQuantity = Number(row.submitted_quantity);
  const averageFillPrice = Number(row.average_filled_price);
  const filledQuantity = Number(row.filled_quantity);
  const limitPrice = Number(row.limit_price);
  const stopPrice = Number(row.stop_price);
  const lines: string[] = [];
  lines.push(`Trade ${index + 1}`);
  if (historyId) lines.push(`ID: ${historyId}`);
  lines.push(`Time: ${tsLabel}${age ? ` (${age})` : ""}`);
  lines.push(`Action: ${action}`);
  lines.push(`Stock: ${symbol}`);
  lines.push(`Account: ${account}`);
  if (Number.isFinite(submittedValue) && submittedValue > 0) {
    lines.push(`Amount: ${formatMoney(submittedValue)}`);
  } else if (Number.isFinite(submittedQuantity) && submittedQuantity > 0) {
    lines.push(`Amount: ${submittedQuantity} ${submittedQuantity === 1 ? "share" : "shares"}`);
  } else {
    lines.push("Amount: Unknown");
  }
  if (Number.isFinite(limitPrice) && limitPrice > 0) lines.push(`Limit: ${formatMoney(limitPrice)}`);
  if (Number.isFinite(stopPrice) && stopPrice > 0) lines.push(`Stop: ${formatMoney(stopPrice)}`);
  lines.push(`Status: ${status}`);
  if (Number.isFinite(filledQuantity) && filledQuantity > 0) {
    const fillText = Number.isFinite(averageFillPrice) && averageFillPrice > 0
      ? `${filledQuantity} @ ${formatMoney(averageFillPrice)}`
      : `${filledQuantity}`;
    lines.push(`Fill: ${fillText}`);
  }
  const rejection = String(row.rejection_message ?? row.rejection_cause ?? "").trim();
  if (rejection) lines.push(`Reason: ${rejection}`);
  return lines.join("\n");
}

function formatLogEntry(row: Record<string, unknown>, index: number): string {
  const logId = String(row.log_id ?? "").trim();
  const event = String(row.event ?? "unknown").trim() || "unknown";
  const tsUtc = String(row.ts_utc ?? "");
  const tsLabel = formatLocalTime(tsUtc);
  const age = formatAge(tsUtc);
  const level = String(row.level ?? "").trim().toLowerCase();
  const status = String(row.status ?? "").trim();
  const symbol = String(row.symbol ?? "").trim().toUpperCase();
  const message = String(row.message ?? "").trim();
  const code = String(row.rejection_code ?? "").trim();
  const accountId = String(row.account_id ?? "").trim();
  const sessionId = String(row.session_id ?? "").trim();
  const securityId = String(row.security_id ?? "").trim();
  const orderId = String(row.order_id ?? "").trim();
  const externalId = String(row.external_id ?? "").trim();
  const side = String(row.side ?? "").trim();
  const orderStyle = String(row.order_style ?? "").trim();
  const orderType = String(row.order_type ?? "").trim();
  const executionType = String(row.execution_type ?? "").trim();
  const quantity = Number(row.quantity ?? row.submitted_quantity);
  const value = Number(row.value ?? row.submitted_value);
  const limitPrice = Number(row.limit_price);
  const stopPrice = Number(row.stop_price);
  const filledQty = Number(row.filled_quantity);
  const avgFillPrice = Number(row.average_filled_price);
  const expiresIn = Number(row.expires_in);
  const nextProbeMs = Number(row.next_probe_ms);
  const coreKeys = new Set([
    "log_id",
    "ts_utc",
    "event",
    "status",
    "level",
    "message",
    "rejection_code",
    "symbol",
    "account_id",
    "session_id",
    "security_id",
    "order_id",
    "external_id",
    "side",
    "order_style",
    "order_type",
    "execution_type",
    "quantity",
    "submitted_quantity",
    "value",
    "submitted_value",
    "limit_price",
    "stop_price",
    "filled_quantity",
    "average_filled_price",
    "expires_in",
    "next_probe_ms"
  ]);
  const extraLines = Object.entries(row)
    .filter(([key, value]) => !coreKeys.has(key) && value !== null && value !== undefined && String(value).trim() !== "")
    .map(([key, value]) => {
      if (typeof value === "object") return `  ${key}: ${JSON.stringify(value)}`;
      return `  ${key}: ${String(value)}`;
    });
  const lines: string[] = [];
  lines.push(`Log ${index + 1}`);
  if (logId) lines.push(`ID: ${logId}`);
  lines.push(`Time: ${tsLabel}${age ? ` (${age})` : ""}`);
  lines.push(`Event: ${titleCase(event)}`);
  if (status) lines.push(`Status: ${displayStatus(status)}`);
  if (level) lines.push(`Level: ${titleCase(level)}`);
  if (sessionId) lines.push(`Session: ${sessionId}`);
  if (symbol) lines.push(`Symbol: ${symbol}`);
  if (accountId) lines.push(`Account: ${accountId}`);
  if (securityId) lines.push(`Security: ${securityId}`);
  if (side || orderStyle || orderType || executionType) {
    const tradeParts = [
      side ? titleCase(side) : "",
      orderStyle ? titleCase(orderStyle) : "",
      orderType ? titleCase(orderType) : "",
      executionType ? titleCase(executionType) : ""
    ].filter(Boolean);
    lines.push(`Trade: ${tradeParts.join(" | ")}`);
  }
  if (Number.isFinite(quantity) && quantity > 0) lines.push(`Quantity: ${formatQuantity(quantity)}`);
  if (Number.isFinite(value) && value > 0) lines.push(`Value: ${value.toFixed(2)}`);
  if (Number.isFinite(limitPrice) && limitPrice > 0) lines.push(`Limit: ${limitPrice.toFixed(2)}`);
  if (Number.isFinite(stopPrice) && stopPrice > 0) lines.push(`Stop: ${stopPrice.toFixed(2)}`);
  if (Number.isFinite(filledQty) && filledQty > 0) {
    const fill = Number.isFinite(avgFillPrice) && avgFillPrice > 0
      ? `${formatQuantity(filledQty)} @ ${avgFillPrice.toFixed(2)}`
      : formatQuantity(filledQty);
    lines.push(`Fill: ${fill}`);
  }
  if (Number.isFinite(expiresIn) && expiresIn >= 0) lines.push(`Expires In: ${Math.floor(expiresIn)}s`);
  if (Number.isFinite(nextProbeMs) && nextProbeMs >= 0) lines.push(`Next Probe: ${Math.floor(nextProbeMs / 1000)}s`);
  if (orderId) lines.push(`Order ID: ${orderId}`);
  if (externalId) lines.push(`External ID: ${externalId}`);
  if (code) lines.push(`Code: ${code}`);
  if (message) lines.push(`Message: ${message}`);
  if (extraLines.length) lines.push(`Details:\n${extraLines.join("\n")}`);
  return lines.join("\n");
}

function ensureLogIds(rows: Record<string, unknown>[]): { rows: Record<string, unknown>[]; updated: boolean } {
  let updated = false;
  const normalized = rows.map((row) => {
    const existing = String(row.log_id ?? "").trim();
    if (existing) return row;
    updated = true;
    return {
      ...row,
      log_id: `log-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`
    };
  });
  return { rows: normalized, updated };
}

async function listAccounts(token: string, bundle: OAuthBundle): Promise<Record<string, unknown>[]> {
  const identityId = identityIdFromToken(token) ?? (bundle.identity_canonical_id as string | undefined);
  if (!identityId) throw new Error("Could not resolve identity id from token.");
  const rows: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  while (true) {
    const payload = await graphqlRequest(token, "FetchTradeAccountList", FETCH_TRADE_ACCOUNT_LIST, {
      identityId,
      pageSize: 50,
      cursor
    }, bundle);
    const data = payload.data as Record<string, unknown> | undefined;
    const identity = data?.identity as Record<string, unknown> | undefined;
    const accounts = identity?.accounts as Record<string, unknown> | undefined;
    const edges = (accounts?.edges as unknown[]) ?? [];
    for (const edge of edges) {
      const node = (edge as Record<string, unknown>).node as Record<string, unknown> | undefined;
      if (!node) continue;
      if (String(node.status ?? "").toLowerCase() !== "open") continue;
      const financials = (node.financials as Record<string, unknown> | undefined)?.currentCombined as Record<string, unknown> | undefined;
      const custodianAccounts = (node.custodianAccounts as unknown[]) ?? [];
      const tradeCustodian = custodianAccounts.some((entry) => {
        const branch = String((entry as Record<string, unknown>).branch ?? "").toUpperCase();
        return branch === "WS" || branch === "TR";
      });
      rows.push({
        id: node.id,
        status: node.status,
        account_type: accountTypeFromUnified(node.unifiedAccountType as string | undefined),
        unified_account_type: node.unifiedAccountType,
        nickname: node.nickname,
        currency: node.currency,
        current_balance: financials?.netLiquidationValue ?? null,
        net_deposits: financials?.netDeposits ?? null,
        trade_custodian: tradeCustodian
      });
    }
    const pageInfo = accounts?.pageInfo as Record<string, unknown> | undefined;
    if (!pageInfo?.hasNextPage) break;
    cursor = String(pageInfo.endCursor ?? "");
    if (!cursor) break;
  }
  for (const row of rows) {
    const accountId = String(row.id ?? "");
    if (!accountId) {
      row.stocks_value = null;
      row.liquid_to_buy = null;
      continue;
    }
    try {
      const payload = await graphqlRequest(token, "FetchAccountPositions", FETCH_ACCOUNT_POSITIONS, { accountId }, bundle);
      const positions = (((payload.data as Record<string, unknown>)?.account as Record<string, unknown>)?.positions ??
        []) as Record<string, unknown>[];
      const stockValue = positions.reduce((sum, position) => {
        const parsed = Number(position.value);
        return Number.isFinite(parsed) ? sum + parsed : sum;
      }, 0);
      row.stocks_value = {
        amount: stockValue.toFixed(2),
        currency: String((row.current_balance as Record<string, unknown> | null)?.currency ?? row.currency ?? "").trim()
      };
      const currentBalanceAmount = Number((row.current_balance as Record<string, unknown> | null)?.amount);
      row.liquid_to_buy = Number.isFinite(currentBalanceAmount)
        ? {
            amount: (currentBalanceAmount - stockValue).toFixed(2),
            currency: String((row.current_balance as Record<string, unknown> | null)?.currency ?? row.currency ?? "").trim()
          }
        : null;
    } catch {
      row.stocks_value = null;
      row.liquid_to_buy = null;
    }
  }
  return rows;
}

function formatMoneyDisplay(value: unknown): string {
  if (value === null || value === undefined) return "—";
  const o = value as Record<string, unknown>;
  const amount = o.amount;
  const currency = String(o.currency ?? "").trim();
  if (amount === null || amount === undefined || amount === "") return "—";
  const a = String(amount);
  return currency ? `${a} ${currency}` : a;
}

function formatCurrencyAmount(amount: number, currency?: string): string {
  if (!Number.isFinite(amount)) return "—";
  const code = String(currency ?? "").trim().toUpperCase();
  if (!code) return amount.toFixed(2);
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: code,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${code}`;
  }
}

function moneyParts(value: unknown): { amount: number; currency: string | null } | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const amount = Number(row.amount);
  if (!Number.isFinite(amount)) return null;
  const currency = String(row.currency ?? "").trim().toUpperCase() || null;
  return { amount, currency };
}

function formatQuantity(value: unknown): string {
  const qty = Number(value);
  if (!Number.isFinite(qty)) return "—";
  return Number.isInteger(qty) ? `${qty}` : qty.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

function portfolioAccountLabel(account: Record<string, unknown>): string {
  const type = accountTypeLabel(String(account.account_type ?? ""));
  const nickname = String(account.nickname ?? "").trim();
  return nickname ? `${nickname} (${type})` : type;
}

function formatPortfolioHuman(
  rows: Array<{ account: Record<string, unknown>; positions: Record<string, unknown>[] }>
): string {
  const accountSummaries = rows.map(({ account, positions }) => {
    const balance = moneyParts(account.current_balance);
    const cash = moneyParts(account.liquid_to_buy);
    const holdings = positions
      .map((position) => {
        const value = Number(position.value);
        if (!Number.isFinite(value) || value <= 0) return null;
        return {
          symbol: String(position.symbol ?? "").trim().toUpperCase() || "—",
          name: String(position.name ?? "").trim(),
          quantity: Number(position.quantity),
          value,
          currency: String(position.currency ?? account.currency ?? "").trim().toUpperCase() || "USD"
        };
      })
      .filter((position): position is {
        symbol: string;
        name: string;
        quantity: number;
        value: number;
        currency: string;
      } => position !== null)
      .sort((a, b) => b.value - a.value);

    const invested = holdings.reduce((sum, position) => sum + position.value, 0);

    return {
      label: portfolioAccountLabel(account),
      balance,
      cash,
      invested,
      currency: String(account.currency ?? "").trim().toUpperCase() || balance?.currency || cash?.currency || "USD",
      holdings
    };
  });

  const totalValue = accountSummaries.reduce((sum, row) => sum + (row.balance?.amount ?? 0), 0);
  const totalCash = accountSummaries.reduce((sum, row) => sum + (row.cash?.amount ?? 0), 0);
  const totalInvested = accountSummaries.reduce((sum, row) => sum + row.invested, 0);
  const totalHoldings = accountSummaries.reduce((sum, row) => sum + row.holdings.length, 0);
  const portfolioCurrency = accountSummaries.find((row) => row.balance?.currency)?.balance?.currency
    ?? accountSummaries.find((row) => row.cash?.currency)?.cash?.currency
    ?? accountSummaries[0]?.currency
    ?? "USD";

  const lines = [
    "Portfolio",
    `Total value  ${formatCurrencyAmount(totalValue, portfolioCurrency)}`,
    `Invested     ${formatCurrencyAmount(totalInvested, portfolioCurrency)}`,
    `Cash         ${formatCurrencyAmount(totalCash, portfolioCurrency)}`,
    `Accounts     ${accountSummaries.length}`,
    `Holdings     ${totalHoldings}`
  ];

  for (const summary of accountSummaries) {
    lines.push("");
    lines.push(summary.label);
    lines.push(`Value        ${formatCurrencyAmount(summary.balance?.amount ?? 0, summary.balance?.currency ?? summary.currency)}`);
    lines.push(`Cash         ${formatCurrencyAmount(summary.cash?.amount ?? 0, summary.cash?.currency ?? summary.currency)}`);
    if (!summary.holdings.length) {
      lines.push("No holdings");
      continue;
    }
    for (const holding of summary.holdings) {
      const positionWeight = summary.invested > 0 ? Math.round((holding.value / summary.invested) * 100) : 0;
      const details = [`${formatQuantity(holding.quantity)} sh`, formatCurrencyAmount(holding.value, holding.currency)];
      if (positionWeight > 0) details.push(`${positionWeight}%`);
      const namePart = holding.name ? ` - ${holding.name}` : "";
      lines.push(`${holding.symbol}${namePart}`);
      lines.push(`  ${details.join("  ")}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

const ACCOUNTS_LABEL_W = 20;

function accountsKv(label: string, value: string): string {
  const v = value.trim() === "" ? "—" : value.trim();
  return `  ${label.padEnd(ACCOUNTS_LABEL_W)}  ${v}`;
}

function formatAccountsHuman(rows: Record<string, unknown>[]): string {
  const legend =
    "Open accounts only. Fields below match buy/sell --account-type (account_type).\n" +
    "trade_custodian: yes = WS/TR branch (CLI can place orders here).\n" +
    "liquid_to_buy is estimated as total balance minus current stock positions.\n";
  const blocks = rows.map((row, i) => {
    const n = i + 1;
    const sep = `── Account ${n} of ${rows.length} ──`;
    return [
      "",
      sep,
      "",
      accountsKv("id", String(row.id ?? "")),
      accountsKv("nickname", String(row.nickname ?? "")),
      accountsKv("account_type", String(row.account_type ?? "")),
      accountsKv("unified_type", String(row.unified_account_type ?? "")),
      accountsKv("currency", String(row.currency ?? "")),
      accountsKv("balance", formatMoneyDisplay(row.current_balance)),
      accountsKv("liquid_to_buy", formatMoneyDisplay(row.liquid_to_buy)),
      accountsKv("in_stocks", formatMoneyDisplay(row.stocks_value)),
      accountsKv("net_deposits", formatMoneyDisplay(row.net_deposits)),
      accountsKv("trade_custodian", row.trade_custodian === true ? "yes" : "no")
    ].join("\n");
  });
  return legend + blocks.join("\n") + "\n";
}

function normalizeAccountTypeSelector(value: string): string[] {
  const clean = value.trim().toLowerCase().replace("-", "_");
  const aliases: Record<string, string[]> = {
    tfsa: ["ca_tfsa"],
    rrsp: ["ca_rrsp"],
    resp: ["ca_resp", "ca_individual_resp", "ca_family_resp"],
    fhsa: ["ca_fhsa"],
    joint: ["ca_joint"],
    non_registered: ["ca_non_registered"],
    margin: ["ca_non_registered"],
    cash: ["ca_non_registered"],
    rrif: ["ca_rrif"],
    lira: ["ca_lira"],
    lrsp: ["ca_lrsp"]
  };
  if (aliases[clean]) return aliases[clean];
  if (clean.startsWith("ca_")) return [clean];
  return [`ca_${clean}`];
}

function normalizeAccountSelectorText(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function readAccountAliases(): Record<string, string> {
  if (!existsSync(ACCOUNT_ALIASES_FILE)) return {};
  try {
    const raw = readJsonFile(ACCOUNT_ALIASES_FILE);
    if (!raw || typeof raw !== "object") return {};
    const out: Record<string, string> = {};
    for (const [accountId, alias] of Object.entries(raw as Record<string, unknown>)) {
      const id = String(accountId ?? "").trim();
      const label = String(alias ?? "").trim();
      if (!id || !label) continue;
      out[id] = label;
    }
    return out;
  } catch {
    return {};
  }
}

function writeAccountAliases(aliases: Record<string, string>): void {
  writeJsonFile(ACCOUNT_ALIASES_FILE, aliases);
}

function normalizeAlias(value: string): string {
  return normalizeAccountSelectorText(value);
}

function selectorAliases(selector: string): string[] {
  const normalized = normalizeAccountSelectorText(selector);
  const aliasMap: Record<string, string[]> = {
    tfsa: ["tfsa"],
    rrsp: ["rrsp"],
    fhsa: ["fhsa"],
    resp: ["resp"],
    rrif: ["rrif"],
    lira: ["lira"],
    lrsp: ["lrsp"],
    joint: ["joint"],
    nonregistered: ["nonregistered", "nonreg", "nonregisteredaccount", "personal"],
    chequing: ["chequing", "checking", "cash", "spend"],
    cash: ["cash", "chequing", "checking", "spend"]
  };
  return Object.entries(aliasMap)
    .filter(([, variants]) => variants.includes(normalized))
    .map(([key]) => key);
}

function accountMatchesSelector(account: Record<string, unknown>, selector: string): boolean {
  const normalizedSelector = normalizeAccountSelectorText(selector);
  if (!normalizedSelector) return false;
  const accountId = String(account.id ?? "");
  if (accountId === selector.trim()) return true;
  const accountType = String(account.account_type ?? "");
  const unified = String(account.unified_account_type ?? "").toUpperCase();
  const nickname = String(account.nickname ?? "");
  const candidates = [
    accountId,
    accountType,
    unified,
    nickname,
    accountType.replace(/^ca_/, ""),
    unified.replace(/^SELF_DIRECTED_/, "")
  ].map(normalizeAccountSelectorText);
  if (candidates.some((value) => value === normalizedSelector)) return true;
  const aliasKeys = selectorAliases(selector);
  if (!aliasKeys.length) return false;
  if (aliasKeys.includes("chequing") || aliasKeys.includes("cash")) {
    if (unified === "CASH") return true;
  }
  if (aliasKeys.includes("nonregistered")) {
    if (unified.includes("NON_REGISTERED") || accountType === "ca_non_registered") return true;
  }
  for (const key of aliasKeys) {
    if (key === "chequing" || key === "cash" || key === "nonregistered") continue;
    if (unified.includes(key.toUpperCase()) || accountType.includes(key)) return true;
  }
  return false;
}

function resolveAccountIdBySelector(
  accounts: Record<string, unknown>[],
  selector: string,
  optionName: string,
  aliases?: Record<string, string>
): string {
  const query = selector.trim();
  if (!query) throw new Error(`${optionName} cannot be empty.`);
  const normalizedQuery = normalizeAlias(query);
  if (aliases && normalizedQuery) {
    const aliasMatches = Object.entries(aliases)
      .filter(([, alias]) => normalizeAlias(alias) === normalizedQuery)
      .map(([accountId]) => accountId);
    if (aliasMatches.length === 1) return aliasMatches[0];
    if (aliasMatches.length > 1) {
      throw new Error(`Alias '${selector}' maps to multiple accounts in ${ACCOUNT_ALIASES_FILE}.`);
    }
  }
  const matches = accounts.filter((account) => accountMatchesSelector(account, query));
  if (!matches.length) {
    throw new Error(`No account matches ${optionName} '${selector}'. Run 'wsli accounts' to see available accounts.`);
  }
  if (matches.length > 1) {
    const ids = matches.map((account) => String(account.id ?? "")).join(", ");
    throw new Error(`Multiple accounts match ${optionName} '${selector}': ${ids}. Use explicit --from-account-id/--to-account-id.`);
  }
  return String(matches[0].id ?? "");
}

function normalizeSecurityId(raw: string): string {
  const value = (raw ?? "").trim();
  if (!value) throw new Error("security_id is required (expected sec-s-...)");
  if (value.startsWith("sec-s-")) return value;
  if (value.includes("sec-s-")) {
    const start = value.indexOf("sec-s-");
    const tail = value.slice(start);
    const cutAt = ["?", "&", "#", "/", " "]
      .map((sep) => tail.indexOf(sep))
      .filter((idx) => idx >= 0)
      .sort((a, b) => a - b)[0];
    return cutAt === undefined ? tail : tail.slice(0, cutAt);
  }
  throw new Error("Invalid security_id format. Expected sec-s-...");
}

function matchesExchange(primaryExchange: string, market: string): boolean {
  const exchange = primaryExchange.trim().toUpperCase();
  const wanted = market.trim().toUpperCase();
  if (!exchange || !wanted) return false;
  return exchange === wanted || exchange.includes(wanted) || wanted.includes(exchange);
}

function parseMarketQualifiedTicker(raw: string): { symbol: string; market?: string } {
  const value = raw.trim();
  const match = /^([A-Za-z]{2,10})\.([A-Za-z][A-Za-z0-9.-]{0,9})$/.exec(value);
  if (!match) return { symbol: value };
  return {
    market: match[1].toUpperCase(),
    symbol: match[2].toUpperCase()
  };
}

async function resolveSecurityIdArg(token: string, bundle: OAuthBundle, raw: string, market?: string): Promise<string> {
  try {
    return normalizeSecurityId(raw);
  } catch {
    const payload = await graphqlRequest(token, "FetchSecuritySearchResult", FETCH_SECURITY_SEARCH, { query: raw }, bundle);
    const results = ((((payload.data as Record<string, unknown>)?.securitySearch as Record<string, unknown>)?.results) as Record<string, unknown>[] | undefined) ?? [];
    if (!results.length) throw new Error(`No security found for '${raw}'.`);
    const exactMatches = results.filter((item) => {
      const stock = item.stock as Record<string, unknown> | undefined;
      return String(stock?.symbol ?? "").toUpperCase() === raw.toUpperCase();
    });
    const normalizedMarket = String(market ?? "").trim();
    const exact = normalizedMarket
      ? exactMatches.find((item) => {
        const stock = item.stock as Record<string, unknown> | undefined;
        const primaryExchange = String(stock?.primaryExchange ?? "");
        return matchesExchange(primaryExchange, normalizedMarket);
      })
      : exactMatches[0];
    const looksLikeTicker = /^[A-Za-z][A-Za-z0-9.-]{0,9}$/.test(raw.trim());
    if (looksLikeTicker && exactMatches.length > 1 && !normalizedMarket) {
      const exchanges = exactMatches
        .map((item) => {
          const stock = item.stock as Record<string, unknown> | undefined;
          return String(stock?.primaryExchange ?? "").trim();
        })
        .filter(Boolean)
        .slice(0, 5)
        .join(", ");
      throw new Error(
        `Ticker '${raw}' matches multiple markets (${exchanges || "unknown exchanges"}). ` +
          "Pass --market (for example: TSX, NYSE, NASDAQ)."
      );
    }
    if (looksLikeTicker && normalizedMarket && !exact) {
      throw new Error(`No exact ticker match for '${raw}' on market '${normalizedMarket}'.`);
    }
    if (!exact && looksLikeTicker) {
      const sample = results
        .slice(0, 5)
        .map((item) => {
          const stock = item.stock as Record<string, unknown> | undefined;
          return String(stock?.symbol ?? "").trim();
        })
        .filter(Boolean)
        .join(", ");
      throw new Error(
        `No exact ticker match for '${raw}'. Top matches: ${sample || "none"}. ` +
          "Use an exact symbol or pass --security-id."
      );
    }
    const candidate = exact ?? results[0];
    const sid = String(candidate.id ?? "");
    if (!sid.startsWith("sec-s-")) throw new Error(`Could not resolve valid security id for '${raw}'.`);
    return sid;
  }
}

async function assertDollarBuyEligibleSecurity(token: string, bundle: OAuthBundle, securityId: string): Promise<void> {
  const payload = await graphqlRequest(token, "FetchSecurity", FETCH_SECURITY, { securityId }, bundle);
  const security = (payload.data as Record<string, unknown> | undefined)?.security as Record<string, unknown> | undefined;
  if (!security) throw new Error("Could not load security details for dollar buy.");
  const buyable = security.buyable === true;
  const eligible = security.wsTradeEligible === true;
  if (!buyable || !eligible) {
    const reason = String(security.wsTradeIneligibilityReason ?? "").trim();
    const stock = security.stock as Record<string, unknown> | undefined;
    const sym = String(stock?.symbol ?? "").trim();
    const name = String(stock?.name ?? "").trim();
    const label = sym ? `${sym}${name ? ` (${name})` : ""}` : securityId;
    throw new Error(
      `Dollar buys are fractional buys; ${label} is not eligible for fractional trading right now ` +
        `(buyable=${String(security.buyable)}, wsTradeEligible=${String(security.wsTradeEligible)}` +
        `${reason ? `, reason=${reason}` : ""}). Use --shares for whole-share orders when supported, ` +
        "or pick a fractional-eligible symbol."
    );
  }
}

function assertOrderNotRejected(order: Record<string, unknown>): void {
  const status = String(order.status ?? "").toLowerCase();
  if (status !== "rejected") return;
  const code = String(order.rejectionCode ?? "").trim();
  const cause = String(order.rejectionCause ?? "").trim();
  if (code === "submitted_quantity_zero") {
    throw new Error(
      "Order rejected: submitted quantity rounded to zero. " +
        "This usually means the dollar amount is below the broker's minimum notional for that symbol " +
        "(dollar buys still must map to a non-zero fractional share)."
    );
  }
  if (code === "balance_insufficient_cash") {
    throw new Error(
      "Order rejected: insufficient trading cash for this order. " +
        "Note: account balance shown in `wsli accounts` can differ from immediately available trading cash " +
        "(holds/unsettled cash/etc.)." +
        (cause ? ` Details: ${cause}` : "")
    );
  }
  throw new Error(`Order rejected${code ? ` (${code})` : ""}.${cause ? ` ${cause}` : ""}`);
}

async function resolveAccountId(
  token: string,
  bundle: OAuthBundle,
  accountId?: string,
  accountType?: string,
  accountIndex?: number
): Promise<string> {
  if (accountId && (accountType || accountIndex !== undefined)) {
    throw new Error("Use either --account-id or (--account-type with optional --account-index), not both.");
  }
  if (accountIndex !== undefined && !accountType) {
    throw new Error("--account-index requires --account-type.");
  }
  const accounts = await listAccounts(token, bundle);
  if (accountId) {
    const row = accounts.find((account) => String(account.id ?? "") === accountId);
    if (!row) throw new Error(`No account found with id ${accountId}`);
    return accountId;
  }
  if (accountType) {
    const acceptable = normalizeAccountTypeSelector(accountType);
    const matches = accounts.filter((account) => acceptable.includes(String(account.account_type ?? "")));
    if (accountIndex !== undefined) {
      if (accountIndex < 1 || accountIndex > matches.length) {
        throw new Error(`--account-index ${accountIndex} is out of range for ${accountType}`);
      }
      return String(matches[accountIndex - 1].id);
    }
    if (matches.length !== 1) {
      throw new Error(`Expected exactly one account for ${accountType}; found ${matches.length}.`);
    }
    return String(matches[0].id);
  }
  if (accounts.length === 1) return String(accounts[0].id);
  throw new Error("Multiple accounts found. Provide --account-id or --account-type.");
}

async function waitForOrderStatus(
  token: string,
  externalId: string,
  timeoutSeconds = 30,
  acceptPending = false
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    let payload: Record<string, unknown>;
    try {
      payload = await graphqlRequest(token, "FetchSoOrdersExtendedOrder", FETCH_SO_ORDERS_EXTENDED_ORDER, {
        branchId: "TR",
        externalId
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('"code":"NOT_FOUND"')) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }
      throw error;
    }
    const order = (payload.data as Record<string, unknown>)?.soOrdersExtendedOrder as Record<string, unknown> | undefined;
    if (order) {
      const status = String(order.status ?? "").toLowerCase();
      if (acceptPending && ["new", "pending", "queued", "accepted", "open", "submitted", "in_progress"].includes(status)) {
        return order;
      }
      if (!["", "new", "pending", "queued", "accepted", "open", "submitted", "in_progress"].includes(status)) {
        return order;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Order ${externalId} did not finalize in ${timeoutSeconds}s`);
}

function numericQuantity(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function resolveSymbolFromSecurityId(token: string, bundle: OAuthBundle, securityId: string): Promise<string> {
  const payload = await graphqlRequest(token, "FetchSecurity", FETCH_SECURITY, { securityId }, bundle);
  const security = (payload.data as Record<string, unknown> | undefined)?.security as Record<string, unknown> | undefined;
  const stock = security?.stock as Record<string, unknown> | undefined;
  const symbol = String(stock?.symbol ?? "").trim().toUpperCase();
  if (!symbol) throw new Error(`Could not resolve symbol for ${securityId}.`);
  return symbol;
}

function fallbackQuantityFromHistory(accountId: string, securityId: string, symbol: string): number {
  const rows = readJsonl(BUY_HISTORY_FILE, 2000);
  let qty = 0;
  for (const row of rows) {
    const rowAccount = String(row.account_id ?? "").trim();
    if (rowAccount !== accountId) continue;
    const rowSecurity = String(row.security_id ?? "").trim();
    const rowSymbol = String(row.symbol ?? "").trim().toUpperCase();
    const status = String(row.status ?? "").trim().toLowerCase();
    if (status !== "filled") continue;
    if (rowSecurity !== securityId && rowSymbol !== symbol) continue;
    const side = String(row.side ?? "").trim().toLowerCase();
    const filledQty = numericQuantity(row.filled_quantity);
    const submittedQty = numericQuantity(row.submitted_quantity);
    const delta = filledQty > 0 ? filledQty : submittedQty;
    if (delta <= 0) continue;
    if (side === "buy") qty += delta;
    if (side === "sell") qty -= delta;
  }
  return qty < 0 ? 0 : qty;
}

async function resolvePositionQuantity(
  token: string,
  bundle: OAuthBundle,
  accountId: string,
  securityId: string,
  symbol: string
): Promise<{ liveQuantity: number; fallbackQuantity: number; resolvedQuantity: number; source: "positions" | "history_fallback" }> {
  const payload = await graphqlRequest(token, "FetchAccountPositions", FETCH_ACCOUNT_POSITIONS, { accountId }, bundle);
  const positions = ((payload.data as Record<string, unknown>)?.account as Record<string, unknown>)?.positions ?? [];
  const symbolUp = symbol.trim().toUpperCase();
  const livePosition = (positions as Record<string, unknown>[]).find(
    (row) => String(row.symbol ?? "").trim().toUpperCase() === symbolUp
  );
  const liveQuantity = livePosition ? numericQuantity((livePosition as Record<string, unknown>).quantity) : 0;
  const fallbackQuantity = fallbackQuantityFromHistory(accountId, securityId, symbolUp);
  if (liveQuantity > 0) {
    return { liveQuantity, fallbackQuantity, resolvedQuantity: liveQuantity, source: "positions" };
  }
  return { liveQuantity, fallbackQuantity, resolvedQuantity: fallbackQuantity, source: "history_fallback" };
}

async function submitAndWaitOrder(
  token: string,
  bundle: OAuthBundle,
  input: Record<string, unknown>,
  logEvent: "buy_submit_attempt" | "sell_submit_attempt",
  logMeta: Record<string, unknown>
): Promise<Record<string, unknown>> {
  appendLog({
    event: logEvent,
    status: "start",
    ...logMeta
  });
  const createPayload = await graphqlRequest(token, "SoOrdersOrderCreate", MUTATION_SO_ORDERS_ORDER_CREATE, { input }, bundle);
  const createData = (createPayload.data as Record<string, unknown> | undefined)?.soOrdersCreateOrder as
    | Record<string, unknown>
    | undefined;
  const createErrors = Array.isArray(createData?.errors) ? (createData?.errors as unknown[]) : [];
  if (createErrors.length > 0) {
    const first = (createErrors[0] ?? {}) as Record<string, unknown>;
    const code = String(first.code ?? "unknown");
    const message = String(first.message ?? "Order create failed.");
    appendLog({
      event: logEvent,
      status: "rejected",
      rejection_code: code,
      rejection_message: message,
      ...logMeta
    });
    throw new Error(`Order create rejected (${code}): ${message}`);
  }
  const createdOrder = (createData?.order as Record<string, unknown> | undefined) ?? {};
  appendLog({
    event: logEvent,
    status: "accepted",
    order_id: String(createdOrder.orderId ?? ""),
    created_at: createdOrder.createdAt ?? null,
    ...logMeta
  });
  const externalId = String(input.externalId ?? "");
  const order = await waitForOrderStatus(token, externalId);
  assertOrderNotRejected(order);
  return order;
}

function withGlobalOptions(command: Command): Command {
  return command
    .option("--token-file <path>", "JSON file containing OAuth bundle")
    .option("--access-token <jwt>", "Access token for this run")
    .option("--refresh-token <token>", "Refresh token for this run");
}

async function main(): Promise<void> {
  const program = withGlobalOptions(new Command())
    .name("wsli")
    .description(
      "Wealthsimple CLI: read-only GraphQL plus Trade REST (accounts, portfolio, market buy/sell with --confirm, plus --dry-run)."
    )
    .version(VERSION);

  program.command("config-path").action(() => {
    console.log(CONFIG_FILE);
  });

  program.command("session-path").action(() => {
    console.log(SESSION_FILE);
  });

  program.command("account-alias-path").action(() => {
    console.log(ACCOUNT_ALIASES_FILE);
  });

  program
    .command("account-alias")
    .description("Manage local account aliases used by transfer selectors.")
    .addCommand(
      new Command("list")
        .description("List local account aliases.")
        .option("--json", "Output JSON")
        .action(async (cmdOpts: { json?: boolean }) => {
          const aliases = readAccountAliases();
          const entries = Object.entries(aliases)
            .map(([account_id, alias]) => ({ account_id, alias }))
            .sort((a, b) => a.alias.localeCompare(b.alias));
          if (cmdOpts.json) {
            print({ path: ACCOUNT_ALIASES_FILE, aliases: entries });
            return;
          }
          if (!entries.length) {
            console.log("No account aliases set.");
            return;
          }
          const lines = [`Aliases (${entries.length})`];
          for (const row of entries) {
            lines.push(`${row.alias} -> ${row.account_id}`);
          }
          console.log(lines.join("\n"));
        })
    )
    .addCommand(
      new Command("set")
        .description("Set or replace alias for an account.")
        .argument("<account-selector>", "Account id, alias, nickname, or type selector")
        .argument("<alias>", "Alias label (must be unique)")
        .action(async (accountSelector: string, alias: string) => {
          const aliasText = alias.trim();
          if (!aliasText) throw new Error("Alias cannot be empty.");
          const aliasKey = normalizeAlias(aliasText);
          if (!aliasKey) throw new Error("Alias must contain letters or numbers.");
          const opts = program.opts<GlobalOptions>();
          const { token, bundle } = await resolveAccessToken(opts);
          const accounts = await listAccounts(token, bundle);
          const aliases = readAccountAliases();
          const accountId = resolveAccountIdBySelector(accounts, accountSelector, "<account-selector>", aliases);
          for (const [existingId, existingAlias] of Object.entries(aliases)) {
            if (existingId === accountId) continue;
            if (normalizeAlias(existingAlias) === aliasKey) {
              throw new Error(`Alias '${aliasText}' is already used by account ${existingId}.`);
            }
          }
          aliases[accountId] = aliasText;
          writeAccountAliases(aliases);
          print({ saved: true, account_id: accountId, alias: aliasText, path: ACCOUNT_ALIASES_FILE });
        })
    )
    .addCommand(
      new Command("remove")
        .description("Remove alias by alias text or account selector.")
        .argument("<alias-or-account>", "Alias label or account selector")
        .action(async (aliasOrAccount: string) => {
          const aliases = readAccountAliases();
          const raw = aliasOrAccount.trim();
          if (!raw) throw new Error("<alias-or-account> cannot be empty.");
          const normalized = normalizeAlias(raw);
          let accountId = Object.entries(aliases)
            .find(([, alias]) => normalizeAlias(alias) === normalized)?.[0];
          if (!accountId) {
            const opts = program.opts<GlobalOptions>();
            const { token, bundle } = await resolveAccessToken(opts);
            const accounts = await listAccounts(token, bundle);
            try {
              accountId = resolveAccountIdBySelector(accounts, raw, "<alias-or-account>", aliases);
            } catch {
              accountId = undefined;
            }
          }
          if (!accountId || !aliases[accountId]) {
            throw new Error(`No alias found for '${aliasOrAccount}'.`);
          }
          const removedAlias = aliases[accountId];
          delete aliases[accountId];
          writeAccountAliases(aliases);
          print({ removed: true, account_id: accountId, alias: removedAlias, path: ACCOUNT_ALIASES_FILE });
        })
    );

  const runSetup = async (): Promise<void> => {
    console.error("Step 1: Open https://my.wealthsimple.com and sign in.");
    console.error("Step 2: Paste this snippet in DevTools Console and run it:\n");
    console.log(EXPORT_SESSION_SNIPPET);
    console.error("\nStep 3: Paste the token lines here and press Ctrl-D:\n");
    const raw = await readAllStdinInteractive();
    const payload = parseSessionInput(raw);
    if (typeof payload.access_token !== "string" || !payload.access_token.trim()) {
      throw new Error("Session input is missing access_token.");
    }
    writeJsonFile(SESSION_FILE, payload);
    appendLog({ event: "session_import", status: "ok", source: "setup" });
    maybeStartKeepalive(payload);
    console.error(`Saved credentials to ${SESSION_FILE}`);
  };

  program.command("setup").description("Interactive onboarding flow").action(runSetup);

  program
    .command("snippet")
    .description("Print browser console snippet for session export")
    .action(() => {
      console.log(EXPORT_SESSION_SNIPPET);
    });

  program
    .command("import-session")
    .argument("[file]", "Text file with access_token")
    .action(async (file?: string) => {
      const content = file ? readFileSync(path.resolve(file), "utf-8") : await readAllStdinInteractive();
      const payload = parseSessionInput(content);
      if (typeof payload.access_token !== "string" || !payload.access_token.trim()) {
        throw new Error("Session import requires access_token.");
      }
      writeJsonFile(SESSION_FILE, payload);
      appendLog({ event: "session_import", status: "ok", source: file ? "file" : "stdin" });
      maybeStartKeepalive(payload);
      console.log(`Saved session to ${SESSION_FILE}`);
    });

  program.command("ping").action(async () => {
    const opts = program.opts<GlobalOptions>();
    const { token } = await resolveAccessToken(opts);
    const response = await fetch(OAUTH_TOKEN_INFO_URL, {
      headers: { accept: "application/json", authorization: `Bearer ${token}` }
    });
    await response.json().catch(() => ({}));
    const exp = jwtExpUnix(token);
    const lifetime = exp !== null ? Math.max(0, Math.floor(exp - Date.now() / 1000)) : null;
    const out = { status: response.status, lifetime };
    console.log(JSON.stringify(out));
    console.log(`keepalive: ${keepaliveStatus()}`);
    if (!response.ok) process.exit(1);
  });

  program
    .command("keepalive")
    .option("--once", "Run one probe/refresh cycle and exit")
    .action(async (cmdOpts: { once?: boolean }) => {
      const activeProbeMs = 75_000;
      const idleProbeMs = 150_000;
      const prepareProbeMs = 60_000;
      const refreshThresholdSeconds = 300;
      const criticalThresholdSeconds = 90;
      const maxRetries = 2;
      const degradedAuthFailures = 2;
      const retryBackoffMs = [2_000, 5_000, 15_000];
      const thisPid = process.pid;
      const existingPid = readKeepalivePid();
      if (isProcessRunning(existingPid) && existingPid !== thisPid && !cmdOpts.once) {
        throw new Error(`keepalive already running with pid ${existingPid}`);
      }
      if (!cmdOpts.once) writeKeepalivePid(thisPid);
      const cleanupPid = (): void => {
        if (!cmdOpts.once) clearKeepalivePidIfOwned(thisPid);
      };
      process.once("SIGINT", cleanupPid);
      process.once("SIGTERM", cleanupPid);
      process.once("exit", cleanupPid);
      const opts = program.opts<GlobalOptions>();
      let consecutiveProbeFailures = 0;
      let consecutiveAuthFailures = 0;
      let wasIdle = false;
      let nextProbeMs = activeProbeMs;
      const runCycle = async (): Promise<void> => {
        const bundle = await resolveOAuthBundle(opts);
        const noRefresh = ["1", "true", "yes"].includes(
          String(process.env.WSLI_NO_REFRESH ?? "").trim().toLowerCase()
        );
        let access = bundle.access_token;
        let tokenInfo: Record<string, unknown> | null = null;
        let sessionInfo: Record<string, unknown> | null = null;
        let expiresIn = Math.max(0, Math.floor((jwtExpUnix(access) ?? Date.now() / 1000) - Date.now() / 1000));
        const accessFpBefore = tokenFingerprint(access);
        let action: "probe" | "refresh" = "probe";
        let refreshVerified = false;
        let refreshNote = "probe_only";
        appendLog({ event: "auth_keeper_cycle", status: "start" });
        try {
          let probeAttempt = 0;
          let authProbeFailed = false;
          while (true) {
            try {
              const response = await fetch(OAUTH_TOKEN_INFO_URL, {
                headers: { accept: "application/json", authorization: `Bearer ${access}` }
              });
              tokenInfo = (await response.json()) as Record<string, unknown>;
              if (response.status === 401 || response.status === 403) {
                consecutiveAuthFailures += 1;
                authProbeFailed = true;
              } else if (!response.ok) {
                throw new Error(`token/info HTTP ${response.status}: ${JSON.stringify(tokenInfo)}`);
              } else {
                sessionInfo = await getSessionInfo(access);
                consecutiveAuthFailures = 0;
                consecutiveProbeFailures = 0;
              }
              break;
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              if (probeAttempt >= maxRetries) throw new Error(message);
              consecutiveProbeFailures += 1;
              const waitMs = jitterDelayMs(retryBackoffMs[Math.min(probeAttempt, retryBackoffMs.length - 1)]);
              appendLog({
                event: "auth_probe_retry",
                status: "retrying",
                retry_attempt: probeAttempt + 1,
                retry_delay_ms: waitMs,
                message
              });
              probeAttempt += 1;
              await sleepMs(waitMs);
            }
          }

          const parsedProbeExpires = Number(tokenInfo?.expires_in);
          if (Number.isFinite(parsedProbeExpires) && parsedProbeExpires >= 0) {
            expiresIn = Math.floor(parsedProbeExpires);
          } else {
            const expUnix = jwtExpUnix(access);
            expiresIn = expUnix !== null ? Math.max(0, Math.floor(expUnix - Date.now() / 1000)) : 0;
          }

          const forceRefresh = ["1", "true", "yes"].includes(
            String(process.env.WSLI_KEEPALIVE_FORCE_REFRESH ?? "").trim().toLowerCase()
          );
          let shouldRefresh = forceRefresh || expiresIn <= refreshThresholdSeconds || authProbeFailed;
          let forcePriority = expiresIn <= criticalThresholdSeconds;
          if (consecutiveAuthFailures >= degradedAuthFailures) {
            shouldRefresh = true;
            forcePriority = true;
          }

          if (shouldRefresh) {
            action = "refresh";
            if (noRefresh) {
              throw new Error("Refresh required but disabled (WSLI_NO_REFRESH).");
            }
            if (!bundle.refresh_token) {
              throw new Error("Refresh required but no refresh_token available.");
            }
            const createdBefore = tokenInfo?.created_at;
            const expiresBefore = expiresIn;
            const expUnixBefore = jwtExpUnix(access);
            const fpBefore = tokenFingerprint(access);
            let refreshAttempt = 0;
            while (true) {
              try {
                const refreshed = await refreshAccessToken(bundle);
                access = refreshed.access_token;
                writeJsonFile(SESSION_FILE, refreshed);
                const verifyResponse = await fetch(OAUTH_TOKEN_INFO_URL, {
                  headers: { accept: "application/json", authorization: `Bearer ${access}` }
                });
                const verifyInfo = (await verifyResponse.json()) as Record<string, unknown>;
                if (!verifyResponse.ok) {
                  throw new Error(`refresh verify HTTP ${verifyResponse.status}: ${JSON.stringify(verifyInfo)}`);
                }
                sessionInfo = await getSessionInfo(access);
                const createdChanged = verifyInfo.created_at !== createdBefore;
                const expiresAfter = Number(verifyInfo.expires_in);
                const expiresJumped = Number.isFinite(expiresAfter) && expiresAfter >= expiresBefore + 240;
                const expUnixAfter = jwtExpUnix(access);
                const expUnixJumped =
                  expUnixBefore !== null && expUnixAfter !== null && expUnixAfter >= expUnixBefore + 240;
                const fpChanged = tokenFingerprint(access) !== fpBefore;
                refreshVerified = createdChanged || expiresJumped || expUnixJumped || fpChanged;
                if (!refreshVerified) {
                  refreshNote = "not_rotated";
                  throw new Error("refresh verification did not show token rollover");
                }
                tokenInfo = verifyInfo;
                expiresIn = Number.isFinite(expiresAfter)
                  ? Math.floor(expiresAfter)
                  : Math.max(0, Math.floor((jwtExpUnix(access) ?? Date.now() / 1000) - Date.now() / 1000));
                consecutiveAuthFailures = 0;
                refreshNote = "verified";
                break;
              } catch (error) {
                if (refreshAttempt >= maxRetries) {
                  throw new Error(error instanceof Error ? error.message : String(error));
                }
                const waitMs = jitterDelayMs(retryBackoffMs[Math.min(refreshAttempt, retryBackoffMs.length - 1)]);
                appendLog({
                  event: "auth_refresh_retry",
                  status: "retrying",
                  retry_attempt: refreshAttempt + 1,
                  retry_delay_ms: waitMs,
                  critical: forcePriority,
                  message: error instanceof Error ? error.message : String(error)
                });
                refreshAttempt += 1;
                await sleepMs(waitMs);
              }
            }
          }
        } catch (error) {
          appendLog({
            event: "auth_keeper_cycle",
            status: "error",
            message: error instanceof Error ? error.message : String(error)
          });
          throw new Error(`keepalive probe failed: ${error instanceof Error ? error.message : String(error)}`);
        }

        const activityAgeSeconds = sessionInfo ? extractActivityAgeSeconds(sessionInfo) : null;
        const idleTimeoutSeconds = sessionInfo ? extractIdleTimeoutSeconds(sessionInfo) : 900;
        const isIdleBySession = activityAgeSeconds !== null && activityAgeSeconds >= idleTimeoutSeconds;
        const isIdle = isIdleBySession;
        const nowIdleToActive = wasIdle && !isIdle;
        wasIdle = isIdle;
        let cadenceMs = isIdle ? idleProbeMs : activeProbeMs;
        if (!isIdle && expiresIn > refreshThresholdSeconds && expiresIn <= 900) {
          cadenceMs = Math.min(cadenceMs, prepareProbeMs);
        }
        if (nowIdleToActive) cadenceMs = 0;
        nextProbeMs = cadenceMs;
        if (action === "refresh" && !refreshVerified) {
          throw new Error("refresh path did not produce verified token state");
        }

        appendLog({
          event: "auth_keeper_cycle",
          status: "ok",
          action,
          token_before_fp: accessFpBefore,
          token_after_fp: tokenFingerprint(access),
          expires_in: expiresIn,
          refresh_verified: refreshVerified,
          refresh_note: refreshNote,
          session_info_unavailable: sessionInfo === null,
          activity_age_s: activityAgeSeconds,
          idle_timeout_s: idleTimeoutSeconds,
          idle_mode: isIdle,
          next_probe_ms: cadenceMs,
          probe_failures: consecutiveProbeFailures,
          auth_failures: consecutiveAuthFailures
        });
        const refreshFlag = action === "refresh" ? (refreshVerified ? "yes" : "no") : "n/a";
        const sessionFlag = sessionInfo === null ? "unavailable" : "ok";
        const nextProbeSeconds = Math.floor(cadenceMs / 1000);
        const parts = [
          `action=${action}`,
          `expires_in=${expiresIn}s`,
          `refresh_verified=${refreshFlag}`,
          `idle_mode=${isIdle ? "yes" : "no"}`,
          `session_info=${sessionFlag}`,
          `next_probe=${nextProbeSeconds}s`,
          `probe_failures=${consecutiveProbeFailures}`,
          `auth_failures=${consecutiveAuthFailures}`
        ];
        console.log(parts.join(" "));
      };
      if (cmdOpts.once) {
        await runCycle();
        return;
      }
      try {
        while (true) {
          await runCycle();
          await sleepMs(nextProbeMs);
        }
      } finally {
        cleanupPid();
      }
    });

  program
    .command("lookup")
    .argument("<query>", "Ticker or search text")
    .option("--limit <n>", "Max rows", "20")
    .action(async (query: string, cmdOpts: { limit: string }) => {
      const limit = Math.min(50, parsePositiveIntOption(cmdOpts.limit, "--limit", 20));
      const opts = program.opts<GlobalOptions>();
      const { token } = await resolveAccessToken(opts);
      let payload: Record<string, unknown>;
      try {
        payload = await tradeRequest(token, "GET", `/securities?query=${encodeURIComponent(query)}`) as Record<string, unknown>;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("HTTP 404")) {
          throw new Error(
            "Lookup endpoint is currently unavailable for this account/session. " +
            "Use a security id directly or try again later."
          );
        }
        throw new Error(`Lookup failed: ${message}`);
      }
      const results = Array.isArray(payload.results) ? payload.results.slice(0, limit) : [];
      print(results);
    });

  program
    .command("accounts")
    .description("List open accounts (GraphQL) as readable blocks.")
    .action(async () => {
      const opts = program.opts<GlobalOptions>();
      const { token, bundle } = await resolveAccessToken(opts);
      const rows = await listAccounts(token, bundle);
      if (!rows.length) {
        console.error("No open accounts returned.");
        return;
      }
      console.log(formatAccountsHuman(rows));
    });

  program
    .command("security")
    .argument("<securityId>", "Wealthsimple security id (sec-s-...)")
    .action(async (securityId: string) => {
      const opts = program.opts<GlobalOptions>();
      const { token, bundle } = await resolveAccessToken(opts);
      const sid = normalizeSecurityId(securityId);
      const payload = await graphqlRequest(token, "FetchIntraDayChartQuotes", FETCH_SECURITY_QUOTES, {
        id: sid,
        date: null,
        tradingSession: "OVERNIGHT",
        currency: null,
        period: "ONE_DAY"
      }, bundle);
      print(payload);
    });

  program
    .command("positions")
    .option("--account-id <id>")
    .option("--account-type <type>")
    .option("--account-index <n>")
    .action(async (cmdOpts: { accountId?: string; accountType?: string; accountIndex?: string }) => {
      const opts = program.opts<GlobalOptions>();
      const { token, bundle } = await resolveAccessToken(opts);
      const accountId = await resolveAccountId(
        token,
        bundle,
        cmdOpts.accountId,
        cmdOpts.accountType,
        cmdOpts.accountIndex !== undefined ? Number.parseInt(cmdOpts.accountIndex, 10) : undefined
      );
      const payload = await graphqlRequest(token, "FetchAccountPositions", FETCH_ACCOUNT_POSITIONS, { accountId }, bundle);
      const positions = ((payload.data as Record<string, unknown>)?.account as Record<string, unknown>)?.positions ?? [];
      print(positions);
    });

  program.command("portfolio").action(async () => {
    const opts = program.opts<GlobalOptions>();
    const { token, bundle } = await resolveAccessToken(opts);
    const accounts = await listAccounts(token, bundle);
    const out: Array<{ account: Record<string, unknown>; positions: Record<string, unknown>[] }> = [];
    for (const account of accounts) {
      const accountId = String(account.id);
      const payload = await graphqlRequest(token, "FetchAccountPositions", FETCH_ACCOUNT_POSITIONS, { accountId }, bundle);
      const positions = ((((payload.data as Record<string, unknown>)?.account as Record<string, unknown>)?.positions) ??
        []) as Record<string, unknown>[];
      out.push({ account, positions });
    }
    console.log(formatPortfolioHuman(out));
  });

  program
    .command("transfer")
    .description("Transfer cash between Wealthsimple accounts.")
    .requiredOption("--amount <n>", "Amount to transfer")
    .option("--currency <code>", "Destination currency (defaults to CAD)", "CAD")
    .option("--from <selector>", "Source account selector (e.g., chequing, tfsa, non-registered, or account id)")
    .option("--from-account-id <id>")
    .option("--from-account-type <type>")
    .option("--from-account-index <n>")
    .option("--to <selector>", "Destination account selector (e.g., tfsa, chequing, non-registered, or account id)")
    .option("--to-account-id <id>")
    .option("--to-account-type <type>")
    .option("--to-account-index <n>")
    .option("--dry-run", "Validate inputs and show payload without submitting")
    .option("--confirm", "Required safety latch")
    .action(async (cmdOpts: Record<string, string | boolean | undefined>) => {
      const opts = program.opts<GlobalOptions>();
      const { token, bundle } = await resolveAccessToken(opts);
      const dryRun = cmdOpts.dryRun === true;
      const amount = Number.parseFloat(String(cmdOpts.amount ?? ""));
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error("--amount must be a positive number.");
      }
      const fromSelector = String(cmdOpts.from ?? "").trim();
      const toSelector = String(cmdOpts.to ?? "").trim();
      const hasFromLegacy =
        cmdOpts.fromAccountId !== undefined || cmdOpts.fromAccountType !== undefined || cmdOpts.fromAccountIndex !== undefined;
      const hasToLegacy = cmdOpts.toAccountId !== undefined || cmdOpts.toAccountType !== undefined || cmdOpts.toAccountIndex !== undefined;
      if (fromSelector && hasFromLegacy) {
        throw new Error("Use either --from or --from-account-* options, not both.");
      }
      if (toSelector && hasToLegacy) {
        throw new Error("Use either --to or --to-account-* options, not both.");
      }
      const accounts = await listAccounts(token, bundle);
      const aliases = readAccountAliases();
      const fromAccountId = fromSelector
        ? resolveAccountIdBySelector(accounts, fromSelector, "--from", aliases)
        : await resolveAccountId(
          token,
          bundle,
          cmdOpts.fromAccountId as string | undefined,
          cmdOpts.fromAccountType as string | undefined,
          cmdOpts.fromAccountIndex !== undefined ? Number.parseInt(String(cmdOpts.fromAccountIndex), 10) : undefined
        );
      const toAccountId = toSelector
        ? resolveAccountIdBySelector(accounts, toSelector, "--to", aliases)
        : await resolveAccountId(
          token,
          bundle,
          cmdOpts.toAccountId as string | undefined,
          cmdOpts.toAccountType as string | undefined,
          cmdOpts.toAccountIndex !== undefined ? Number.parseInt(String(cmdOpts.toAccountIndex), 10) : undefined
        );
      if (fromAccountId === toAccountId) {
        throw new Error("Source and destination accounts must be different.");
      }
      const destinationCurrency = String(cmdOpts.currency ?? "CAD").trim().toUpperCase();
      if (!destinationCurrency) {
        throw new Error("--currency cannot be empty.");
      }
      const idempotencyKey = `transfer-${crypto.randomUUID()}`;
      const input: Record<string, unknown> = {
        source: { id: fromAccountId, type: "Account" },
        destination: { id: toAccountId, type: "Account" },
        requested_amount_unit: "QUANTITY",
        requested_amount_value: String(amount),
        source_currency: destinationCurrency,
        destination_currency: destinationCurrency,
        product_attribution: "simple_mm_web",
        idempotency_key: idempotencyKey
      };
      if (dryRun) {
        print({
          dry_run: true,
          no_submit: true,
          ready_for_submit: true,
          intent: {
            from_account_id: fromAccountId,
            to_account_id: toAccountId,
            amount,
            destination_currency: destinationCurrency
          },
          mutation_input: input
        });
        return;
      }
      if (!cmdOpts.confirm) throw new Error("Missing --confirm safety latch.");
      appendLog({
        event: "transfer_submit_attempt",
        status: "start",
        from_account_id: fromAccountId,
        to_account_id: toAccountId,
        amount,
        destination_currency: destinationCurrency,
        idempotency_key: idempotencyKey
      });
      const payload = await graphqlRequest(
        token,
        "FundingIntentInternalTransferCreate",
        MUTATION_FUNDING_INTENT_INTERNAL_TRANSFER_CREATE,
        { input },
        bundle
      );
      const result =
        (payload.data as Record<string, unknown> | undefined)?.createFundingIntentInternalTransfer ??
        (payload.data as Record<string, unknown> | undefined) ??
        payload;
      appendLog({
        event: "transfer_submit_attempt",
        status: "accepted",
        from_account_id: fromAccountId,
        to_account_id: toAccountId,
        amount,
        destination_currency: destinationCurrency,
        idempotency_key: idempotencyKey
      });
      print(result);
    });

  program
    .command("buy")
    .argument("[target]", "Ticker or security id")
    .option("--symbol <ticker>")
    .option("--security-id <id>")
    .option("--market <exchange>", "Required for ticker buys (example: TSX, NYSE, NASDAQ)")
    .option("--shares <n>")
    .option("--dollars <amount>")
    .option("--order <type>", "market, limit, stop_limit, or stop_market", "market")
    .option("--limit-price <n>", "Required when --order limit")
    .option("--stop-price <n>", "Required when --order stop_limit")
    .option("--account-id <id>")
    .option("--account-type <type>")
    .option("--account-index <n>")
    .option("--dry-run", "Validate inputs and show order payload without submitting")
    .option("--confirm", "Required safety latch")
    .action(async (target: string | undefined, cmdOpts: Record<string, string | boolean | undefined>) => {
      const opts = program.opts<GlobalOptions>();
      const { token, bundle } = await resolveAccessToken(opts);
      const dryRun = cmdOpts.dryRun === true;
      const accountId = await resolveAccountId(
        token,
        bundle,
        cmdOpts.accountId as string | undefined,
        cmdOpts.accountType as string | undefined,
        cmdOpts.accountIndex !== undefined ? Number.parseInt(String(cmdOpts.accountIndex), 10) : undefined
      );
      const symbol = String(cmdOpts.symbol ?? target ?? "").trim();
      const securityId = String(cmdOpts.securityId ?? "").trim();
      const marketOption = String(cmdOpts.market ?? "").trim();
      if (!securityId && !symbol) throw new Error("Provide --security-id or ticker/symbol.");
      const parsed = parseMarketQualifiedTicker(symbol);
      const requestedSymbol = parsed.symbol;
      const qualifiedMarket = parsed.market;
      if (qualifiedMarket && marketOption && qualifiedMarket.toUpperCase() !== marketOption.toUpperCase()) {
        throw new Error(`Conflicting market values: '${qualifiedMarket}' in ticker and '--market ${marketOption}'.`);
      }
      const market = marketOption || qualifiedMarket || "";
      if (!securityId && !market) {
        throw new Error("Ticker buys require a market: use TSX.SHOP style or pass --market.");
      }
      const resolvedSecurityId = securityId || await resolveSecurityIdArg(token, bundle, requestedSymbol, market);
      const shares = cmdOpts.shares ? Number.parseFloat(String(cmdOpts.shares)) : undefined;
      const dollars = cmdOpts.dollars ? Number.parseFloat(String(cmdOpts.dollars)) : undefined;
      if ((shares === undefined) === (dollars === undefined)) {
        throw new Error("Provide exactly one of --shares or --dollars.");
      }
      const orderStyleRaw = String(cmdOpts.order ?? "market").trim().toLowerCase().replace("-", "_");
      const orderStyle = orderStyleRaw === "stoplimit" ? "stop_limit" : orderStyleRaw;
      if (!["market", "limit", "stop_limit", "stop_market"].includes(orderStyle)) {
        throw new Error("--order must be market, limit, stop_limit, or stop_market.");
      }
      const limitPrice = cmdOpts.limitPrice !== undefined ? Number.parseFloat(String(cmdOpts.limitPrice)) : undefined;
      const stopPrice = cmdOpts.stopPrice !== undefined ? Number.parseFloat(String(cmdOpts.stopPrice)) : undefined;
      if (orderStyle === "limit" && (limitPrice === undefined || !Number.isFinite(limitPrice) || limitPrice <= 0)) {
        throw new Error("limit orders require positive --limit-price.");
      }
      if (orderStyle === "stop_limit") {
        if (limitPrice === undefined || !Number.isFinite(limitPrice) || limitPrice <= 0) {
          throw new Error("stop_limit orders require positive --limit-price.");
        }
        if (stopPrice === undefined || !Number.isFinite(stopPrice) || stopPrice <= 0) {
          throw new Error("stop_limit orders require positive --stop-price.");
        }
      }
      if (orderStyle === "stop_market") {
        if (stopPrice === undefined || !Number.isFinite(stopPrice) || stopPrice <= 0) {
          throw new Error("stop_market orders require positive --stop-price.");
        }
        if (limitPrice !== undefined) {
          throw new Error("--limit-price is not used with --order stop_market.");
        }
      }
      if (orderStyle === "market" && (limitPrice !== undefined || stopPrice !== undefined)) {
        throw new Error("--limit-price/--stop-price can only be used with --order limit, --order stop_limit, or --order stop_market.");
      }
      if (orderStyle === "stop_market" && limitPrice !== undefined) {
        throw new Error("--limit-price cannot be used with --order stop_market.");
      }
      if (orderStyle === "limit" && stopPrice !== undefined) {
        throw new Error("--stop-price can only be used with --order stop_limit.");
      }
      if ((orderStyle === "limit" || orderStyle === "stop_limit" || orderStyle === "stop_market") && dollars !== undefined) {
        throw new Error("limit, stop_limit, and stop_market buys require --shares (not --dollars).");
      }
      if ((orderStyle === "limit" || orderStyle === "stop_limit" || orderStyle === "stop_market") && shares !== undefined && !Number.isInteger(shares)) {
        throw new Error("limit, stop_limit, and stop_market buys require whole shares (fractional shares are not accepted).");
      }
      let accountCurrency: string | null = null;
      if ((orderStyle === "limit" || orderStyle === "stop_limit") && shares !== undefined && limitPrice !== undefined) {
        const accounts = await listAccounts(token, bundle);
        const account = accounts.find((row) => String(row.id ?? "") === accountId);
        const liquid = Number((account?.liquid_to_buy as Record<string, unknown> | undefined)?.amount);
        accountCurrency = String((account?.liquid_to_buy as Record<string, unknown> | undefined)?.currency ?? "").trim() || null;
        const estimatedCost = shares * limitPrice;
        if (Number.isFinite(liquid) && accountCurrency === "USD" && liquid < estimatedCost) {
          throw new Error(
            `Insufficient USD buying power for limit buy (need about ${estimatedCost.toFixed(2)} USD, available ${liquid.toFixed(2)} USD). ` +
              "Add funds before submitting."
          );
        }
      }
      if (dollars !== undefined) {
        await assertDollarBuyEligibleSecurity(token, bundle, resolvedSecurityId);
      }
      const externalId = `order-${crypto.randomUUID()}`;
      const input: Record<string, unknown> = {
        canonicalAccountId: accountId,
        externalId,
        executionType:
          orderStyle === "limit"
            ? "LIMIT"
            : orderStyle === "stop_limit"
              ? "STOP_LIMIT"
              : orderStyle === "stop_market"
                ? "STOP"
              : shares && shares % 1 !== 0
                ? "FRACTIONAL"
                : dollars
                  ? "FRACTIONAL"
                  : "REGULAR",
        orderType: dollars ? "BUY_VALUE" : "BUY_QUANTITY",
        securityId: resolvedSecurityId,
        timeInForce: shares && shares % 1 === 0 ? "DAY" : null
      };
      if (orderStyle === "limit" || orderStyle === "stop_limit" || orderStyle === "stop_market") input.tradingSession = "REGULAR";
      if (shares !== undefined) input.quantity = shares;
      if (dollars !== undefined) input.value = dollars;
      if (limitPrice !== undefined) input.limitPrice = limitPrice;
      if (stopPrice !== undefined) input.stopPrice = stopPrice;
      if (dryRun) {
        const securityPayload = await graphqlRequest(token, "FetchSecurity", FETCH_SECURITY, { securityId: resolvedSecurityId }, bundle);
        let restrictionsPayload: Record<string, unknown> | null = null;
        let restrictionsWarning: string | null = null;
        try {
          restrictionsPayload = await graphqlRequest(token, "FetchSoOrdersLimitOrderRestrictions", FETCH_SO_ORDERS_LIMIT_ORDER_RESTRICTIONS, {
            args: { securityId: resolvedSecurityId, side: "BUY" }
          }, bundle);
        } catch (error) {
          restrictionsWarning = error instanceof Error ? error.message : String(error);
        }
        print({
          dry_run: true,
          no_submit: true,
          ready_for_submit: true,
          intent: {
            side: "BUY",
            symbol: requestedSymbol || null,
            security_id: resolvedSecurityId,
            account_id: accountId,
            order_style: orderStyle,
            shares: shares ?? null,
            dollars: dollars ?? null,
            limit_price: limitPrice ?? null,
            stop_price: stopPrice ?? null
          },
          order_input: input,
          graphql: {
            security: securityPayload,
            restrictions: restrictionsPayload
          },
          warnings: restrictionsWarning ? [restrictionsWarning] : []
        });
        return;
      }
      if (!cmdOpts.confirm) throw new Error("Missing --confirm safety latch.");
      appendLog({
        event: "buy_submit_attempt",
        status: "start",
        account_id: accountId,
        security_id: resolvedSecurityId,
        external_id: externalId,
        order_style: orderStyle,
        execution_type: input.executionType,
        order_type: input.orderType,
        limit_price: input.limitPrice ?? null,
        stop_price: input.stopPrice ?? null,
        account_currency: accountCurrency,
        quantity: input.quantity ?? null,
        value: input.value ?? null
      });
      const createPayload = await graphqlRequest(token, "SoOrdersOrderCreate", MUTATION_SO_ORDERS_ORDER_CREATE, { input }, bundle);
      const createData = (createPayload.data as Record<string, unknown> | undefined)?.soOrdersCreateOrder as
        | Record<string, unknown>
        | undefined;
      const createErrors = Array.isArray(createData?.errors) ? (createData?.errors as unknown[]) : [];
      if (createErrors.length > 0) {
        const first = (createErrors[0] ?? {}) as Record<string, unknown>;
        const code = String(first.code ?? "unknown");
        const message = String(first.message ?? "Order create failed.");
        appendLog({
          event: "buy_submit_attempt",
          status: "rejected",
          account_id: accountId,
          security_id: resolvedSecurityId,
          external_id: externalId,
          rejection_code: code,
          rejection_message: message
        });
        throw new Error(`Order create rejected (${code}): ${message}`);
      }
      const createdOrder = (createData?.order as Record<string, unknown> | undefined) ?? {};
      appendLog({
        event: "buy_submit_attempt",
        status: "accepted",
        account_id: accountId,
        security_id: resolvedSecurityId,
        external_id: externalId,
        order_id: String(createdOrder.orderId ?? ""),
        created_at: createdOrder.createdAt ?? null
      });
      const order = await waitForOrderStatus(token, externalId, 30, orderStyle === "stop_limit" || orderStyle === "stop_market");
      assertOrderNotRejected(order);
      appendBuyHistory({
        side: "buy",
        status: String(order.status ?? "unknown"),
        symbol: requestedSymbol || symbol || null,
        security_id: resolvedSecurityId,
        account_id: accountId,
        order_id: String(order.orderId ?? order.id ?? ""),
        external_id: externalId,
        submitted_quantity: shares ?? null,
        submitted_value: dollars ?? null,
        filled_quantity: order.filledQuantity ?? null,
        average_filled_price: order.averageFilledPrice ?? null
      });
      print(order);
    });

  program
    .command("sell")
    .argument("[target]", "Ticker or security id")
    .option("--symbol <ticker>")
    .option("--security-id <id>")
    .option("--shares <n>")
    .option("--sell-all", "Sell full symbol position using live positions or history fallback")
    .option("--order <type>", "market or limit", "market")
    .option("--limit-price <n>", "Required when --order limit")
    .option("--account-id <id>")
    .option("--account-type <type>")
    .option("--account-index <n>")
    .option("--dry-run", "Validate inputs and show order payload without submitting")
    .option("--confirm", "Required safety latch")
    .action(async (target: string | undefined, cmdOpts: Record<string, string | boolean | undefined>) => {
      const opts = program.opts<GlobalOptions>();
      const { token, bundle } = await resolveAccessToken(opts);
      const dryRun = cmdOpts.dryRun === true;
      const accountId = await resolveAccountId(
        token,
        bundle,
        cmdOpts.accountId as string | undefined,
        cmdOpts.accountType as string | undefined,
        cmdOpts.accountIndex !== undefined ? Number.parseInt(String(cmdOpts.accountIndex), 10) : undefined
      );
      const symbol = String(cmdOpts.symbol ?? target ?? "").trim();
      const securityId = String(cmdOpts.securityId ?? "").trim();
      if (!securityId && !symbol) throw new Error("Provide --security-id or ticker/symbol.");
      const resolvedSecurityId = securityId || await resolveSecurityIdArg(token, bundle, symbol);
      const resolvedSymbol = symbol ? symbol.toUpperCase() : await resolveSymbolFromSecurityId(token, bundle, resolvedSecurityId);
      const hasShares = cmdOpts.shares !== undefined;
      const sellAll = cmdOpts.sellAll === true;
      if (hasShares === sellAll) {
        throw new Error("Provide exactly one of --shares or --sell-all.");
      }
      let shares: number;
      if (sellAll) {
        const position = await resolvePositionQuantity(token, bundle, accountId, resolvedSecurityId, resolvedSymbol);
        shares = position.resolvedQuantity;
        if (!Number.isFinite(shares) || shares <= 0) {
          throw new Error(`No sellable ${resolvedSymbol} shares found for --sell-all.`);
        }
      } else {
        shares = Number.parseFloat(String(cmdOpts.shares ?? ""));
        if (!Number.isFinite(shares) || shares <= 0) throw new Error("--shares must be a positive number.");
      }
      const orderStyle = String(cmdOpts.order ?? "market").trim().toLowerCase();
      if (orderStyle !== "market" && orderStyle !== "limit") {
        throw new Error("--order must be market or limit.");
      }
      const limitPrice = cmdOpts.limitPrice !== undefined ? Number.parseFloat(String(cmdOpts.limitPrice)) : undefined;
      if (orderStyle === "limit" && (limitPrice === undefined || !Number.isFinite(limitPrice) || limitPrice <= 0)) {
        throw new Error("limit orders require positive --limit-price.");
      }
      if (orderStyle === "market" && limitPrice !== undefined) {
        throw new Error("--limit-price can only be used with --order limit.");
      }
      if (orderStyle === "limit" && !Number.isInteger(shares)) {
        throw new Error("limit sells require whole shares.");
      }
      const externalId = `order-${crypto.randomUUID()}`;
      const input: Record<string, unknown> = {
        canonicalAccountId: accountId,
        externalId,
        executionType: orderStyle === "limit" ? "LIMIT" : shares % 1 !== 0 ? "FRACTIONAL" : "REGULAR",
        orderType: "SELL_QUANTITY",
        securityId: resolvedSecurityId,
        timeInForce: shares % 1 === 0 ? "DAY" : null
      };
      if (shares !== undefined) input.quantity = shares;
      if (orderStyle === "limit") input.tradingSession = "REGULAR";
      if (limitPrice !== undefined) input.limitPrice = limitPrice;
      if (dryRun) {
        print({
          dry_run: true,
          no_submit: true,
          ready_for_submit: true,
          intent: {
            side: "SELL",
            symbol: resolvedSymbol,
            security_id: resolvedSecurityId,
            account_id: accountId,
            sell_all: sellAll,
            order_style: orderStyle,
            shares,
            limit_price: limitPrice ?? null
          },
          order_input: input
        });
        return;
      }
      if (!cmdOpts.confirm) throw new Error("Missing --confirm safety latch.");
      const order = await submitAndWaitOrder(token, bundle, input, "sell_submit_attempt", {
        account_id: accountId,
        security_id: resolvedSecurityId,
        external_id: externalId,
        order_style: orderStyle,
        execution_type: input.executionType,
        order_type: input.orderType,
        limit_price: input.limitPrice ?? null,
        quantity: input.quantity ?? null
      });
      appendBuyHistory({
        status: String(order.status ?? "unknown"),
        side: "sell",
        symbol: resolvedSymbol || null,
        security_id: resolvedSecurityId,
        account_id: accountId,
        order_id: String(order.orderId ?? order.id ?? ""),
        external_id: externalId,
        submitted_quantity: shares,
        submitted_value: null,
        filled_quantity: order.filledQuantity ?? null,
        average_filled_price: order.averageFilledPrice ?? null
      });
      print(order);
    });

  program
    .command("position-for-symbol")
    .argument("<target>", "Ticker or security id")
    .option("--account-id <id>")
    .option("--account-type <type>")
    .option("--account-index <n>")
    .action(async (target: string, cmdOpts: { accountId?: string; accountType?: string; accountIndex?: string }) => {
      const opts = program.opts<GlobalOptions>();
      const { token, bundle } = await resolveAccessToken(opts);
      const accountId = await resolveAccountId(
        token,
        bundle,
        cmdOpts.accountId,
        cmdOpts.accountType,
        cmdOpts.accountIndex !== undefined ? Number.parseInt(cmdOpts.accountIndex, 10) : undefined
      );
      const resolvedSecurityId = await resolveSecurityIdArg(token, bundle, target);
      const resolvedSymbol = await resolveSymbolFromSecurityId(token, bundle, resolvedSecurityId);
      const position = await resolvePositionQuantity(token, bundle, accountId, resolvedSecurityId, resolvedSymbol);
      print({
        account_id: accountId,
        security_id: resolvedSecurityId,
        symbol: resolvedSymbol,
        live_quantity: position.liveQuantity,
        fallback_quantity: position.fallbackQuantity,
        resolved_quantity: position.resolvedQuantity,
        source: position.source
      });
    });

  program
    .command("trade-smoke")
    .argument("<target>", "Ticker or security id")
    .option("--shares <n>", "Whole shares to test", "1")
    .requiredOption("--buy-limit-price <n>", "Limit price for buy step")
    .option("--sell-limit-price <n>", "Limit price for sell step (defaults to buy price)")
    .option("--account-id <id>")
    .option("--account-type <type>")
    .option("--account-index <n>")
    .option("--confirm", "Required safety latch")
    .action(async (target: string, cmdOpts: Record<string, string | boolean | undefined>) => {
      if (!cmdOpts.confirm) throw new Error("Missing --confirm safety latch.");
      const opts = program.opts<GlobalOptions>();
      const { token, bundle } = await resolveAccessToken(opts);
      const accountId = await resolveAccountId(
        token,
        bundle,
        cmdOpts.accountId as string | undefined,
        cmdOpts.accountType as string | undefined,
        cmdOpts.accountIndex !== undefined ? Number.parseInt(String(cmdOpts.accountIndex), 10) : undefined
      );
      const shares = Number.parseFloat(String(cmdOpts.shares ?? "1"));
      if (!Number.isFinite(shares) || shares <= 0 || !Number.isInteger(shares)) {
        throw new Error("--shares must be a positive whole number.");
      }
      const buyLimitPrice = Number.parseFloat(String(cmdOpts.buyLimitPrice ?? ""));
      if (!Number.isFinite(buyLimitPrice) || buyLimitPrice <= 0) {
        throw new Error("--buy-limit-price must be positive.");
      }
      const sellLimitPrice = cmdOpts.sellLimitPrice !== undefined
        ? Number.parseFloat(String(cmdOpts.sellLimitPrice))
        : buyLimitPrice;
      if (!Number.isFinite(sellLimitPrice) || sellLimitPrice <= 0) {
        throw new Error("--sell-limit-price must be positive.");
      }
      const resolvedSecurityId = await resolveSecurityIdArg(token, bundle, target);
      const resolvedSymbol = await resolveSymbolFromSecurityId(token, bundle, resolvedSecurityId);
      const before = await resolvePositionQuantity(token, bundle, accountId, resolvedSecurityId, resolvedSymbol);

      const buyExternalId = `order-${crypto.randomUUID()}`;
      const buyInput: Record<string, unknown> = {
        canonicalAccountId: accountId,
        externalId: buyExternalId,
        executionType: "LIMIT",
        orderType: "BUY_QUANTITY",
        securityId: resolvedSecurityId,
        timeInForce: "DAY",
        tradingSession: "REGULAR",
        quantity: shares,
        limitPrice: buyLimitPrice
      };
      const buyOrder = await submitAndWaitOrder(token, bundle, buyInput, "buy_submit_attempt", {
        account_id: accountId,
        security_id: resolvedSecurityId,
        external_id: buyExternalId,
        order_style: "limit",
        execution_type: "LIMIT",
        order_type: "BUY_QUANTITY",
        limit_price: buyLimitPrice,
        quantity: shares,
        smoke_test: true
      });
      appendBuyHistory({
        side: "buy",
        status: String(buyOrder.status ?? "unknown"),
        symbol: resolvedSymbol,
        security_id: resolvedSecurityId,
        account_id: accountId,
        order_id: String(buyOrder.orderId ?? buyOrder.id ?? ""),
        external_id: buyExternalId,
        submitted_quantity: shares,
        submitted_value: null,
        filled_quantity: buyOrder.filledQuantity ?? null,
        average_filled_price: buyOrder.averageFilledPrice ?? null
      });

      const afterBuy = await resolvePositionQuantity(token, bundle, accountId, resolvedSecurityId, resolvedSymbol);
      const sellQuantity = afterBuy.resolvedQuantity;
      if (sellQuantity <= 0) {
        throw new Error("Buy step filled but no sellable quantity detected for sell step.");
      }

      const sellExternalId = `order-${crypto.randomUUID()}`;
      const sellInput: Record<string, unknown> = {
        canonicalAccountId: accountId,
        externalId: sellExternalId,
        executionType: "LIMIT",
        orderType: "SELL_QUANTITY",
        securityId: resolvedSecurityId,
        timeInForce: "DAY",
        tradingSession: "REGULAR",
        quantity: sellQuantity,
        limitPrice: sellLimitPrice
      };
      const sellOrder = await submitAndWaitOrder(token, bundle, sellInput, "sell_submit_attempt", {
        account_id: accountId,
        security_id: resolvedSecurityId,
        external_id: sellExternalId,
        order_style: "limit",
        execution_type: "LIMIT",
        order_type: "SELL_QUANTITY",
        limit_price: sellLimitPrice,
        quantity: sellQuantity,
        smoke_test: true
      });
      appendBuyHistory({
        side: "sell",
        status: String(sellOrder.status ?? "unknown"),
        symbol: resolvedSymbol,
        security_id: resolvedSecurityId,
        account_id: accountId,
        order_id: String(sellOrder.orderId ?? sellOrder.id ?? ""),
        external_id: sellExternalId,
        submitted_quantity: sellQuantity,
        submitted_value: null,
        filled_quantity: sellOrder.filledQuantity ?? null,
        average_filled_price: sellOrder.averageFilledPrice ?? null
      });

      const afterSell = await resolvePositionQuantity(token, bundle, accountId, resolvedSecurityId, resolvedSymbol);
      const pass = afterSell.resolvedQuantity <= 0;
      print({
        pass,
        account_id: accountId,
        security_id: resolvedSecurityId,
        symbol: resolvedSymbol,
        before,
        buy: {
          shares,
          limit_price: buyLimitPrice,
          status: buyOrder.status,
          filled_quantity: buyOrder.filledQuantity ?? null,
          average_filled_price: buyOrder.averageFilledPrice ?? null
        },
        after_buy: afterBuy,
        sell: {
          shares: sellQuantity,
          limit_price: sellLimitPrice,
          status: sellOrder.status,
          filled_quantity: sellOrder.filledQuantity ?? null,
          average_filled_price: sellOrder.averageFilledPrice ?? null
        },
        after_sell: afterSell
      });
    });

  program
    .command("logs")
    .option("--limit <n>", "Show last N rows", "50")
    .option("--all", "Show all log rows")
    .option("--level <level>", "Filter level")
    .option("--event <glob>", "Filter event by glob pattern")
    .option("--since <span>", "Filter by age: 30m, 2h, 1d")
    .option("--clear-last <n>", "Delete the last N logs")
    .option("--clear-id <id>", "Delete one log by log ID")
    .option("--dry-run", "Preview delete effect without changing logs")
    .option("--yes", "Confirm destructive clear operation")
    .option("--json", "Output raw JSON log entries")
    .option("--clear", "Delete log file")
    .action((cmdOpts: {
      limit: string;
      all?: boolean;
      level?: string;
      event?: string;
      since?: string;
      clearLast?: string;
      clearId?: string;
      dryRun?: boolean;
      yes?: boolean;
      json?: boolean;
      clear?: boolean;
    }) => {
      const clearModes = [cmdOpts.clear === true, Boolean(cmdOpts.clearLast), Boolean(cmdOpts.clearId)].filter(Boolean).length;
      if (clearModes > 1) throw new Error("Use only one clear mode at a time: --clear, --clear-last, or --clear-id.");
      if (clearModes > 0 && !cmdOpts.dryRun && cmdOpts.yes !== true) {
        throw new Error("Destructive clear requires --yes. Use --dry-run to preview first.");
      }
      if (cmdOpts.clear) {
        if (cmdOpts.dryRun) {
          const existing = existsSync(LOG_FILE);
          const count = existing ? readJsonl(LOG_FILE, Number.MAX_SAFE_INTEGER).length : 0;
          print({ dry_run: true, action: "clear", target: LOG_FILE, would_delete: count });
          return;
        }
        if (existsSync(LOG_FILE)) {
          writeFileSync(LOG_FILE, "", "utf-8");
          print({ deleted: [LOG_FILE], missing: [] });
        } else {
          print({ deleted: [], missing: [LOG_FILE] });
        }
        return;
      }
      if (cmdOpts.clearLast) {
        const removeCount = parsePositiveIntOption(cmdOpts.clearLast, "--clear-last");
        const ensured = ensureLogIds(readJsonl(LOG_FILE, Number.MAX_SAFE_INTEGER));
        const rows = ensured.rows;
        if (ensured.updated) writeJsonlRows(LOG_FILE, rows);
        if (removeCount > rows.length) {
          throw new Error(`Cannot clear last ${removeCount} logs; only ${rows.length} logs exist.`);
        }
        if (cmdOpts.dryRun) {
          const affected = rows.slice(rows.length - removeCount).map((row) => String(row.log_id ?? ""));
          print({ dry_run: true, action: "clear_last", remove_count: removeCount, would_delete_ids: affected });
          return;
        }
        const keep = rows.slice(0, rows.length - removeCount);
        writeJsonlRows(LOG_FILE, keep);
        print({ cleared: removeCount, remaining: keep.length });
        return;
      }
      if (cmdOpts.clearId) {
        const targetId = cmdOpts.clearId.trim();
        if (!targetId) throw new Error("--clear-id requires a non-empty ID.");
        const ensured = ensureLogIds(readJsonl(LOG_FILE, Number.MAX_SAFE_INTEGER));
        const rows = ensured.rows;
        if (ensured.updated) writeJsonlRows(LOG_FILE, rows);
        const keep = rows.filter((row) => String(row.log_id ?? "").trim() !== targetId);
        if (keep.length === rows.length) {
          throw new Error(`No log found with log ID '${targetId}'.`);
        }
        if (cmdOpts.dryRun) {
          print({ dry_run: true, action: "clear_id", would_delete_id: targetId, matches: rows.length - keep.length });
          return;
        }
        writeJsonlRows(LOG_FILE, keep);
        print({ cleared_id: targetId, remaining: keep.length });
        return;
      }
      const limit = parsePositiveIntOption(cmdOpts.limit, "--limit", 50);
      const rows = readJsonl(LOG_FILE, Number.MAX_SAFE_INTEGER);
      const ensured = ensureLogIds(rows);
      const normalizedRows = ensured.rows;
      if (ensured.updated) writeJsonlRows(LOG_FILE, normalizedRows);
      const level = (cmdOpts.level ?? "").trim().toLowerCase();
      const eventGlob = (cmdOpts.event ?? "").trim();
      const sinceSeconds = parseSinceSeconds(cmdOpts.since ?? "");
      const cutoff = sinceSeconds !== null ? Date.now() / 1000 - sinceSeconds : null;
      const filtered = normalizedRows.filter((row) => {
        if (level && String(row.level ?? "").toLowerCase() !== level) return false;
        if (eventGlob && !globMatch(String(row.event ?? ""), eventGlob)) return false;
        if (cutoff !== null) {
          const ts = parseIsoToUnix(String(row.ts_utc ?? ""));
          if (ts === null || ts < cutoff) return false;
        }
        return true;
      });
      const output = cmdOpts.all ? filtered : (filtered.length > limit ? filtered.slice(-limit) : filtered);
      if (cmdOpts.json) {
        print({ path: LOG_FILE, entries: output });
        return;
      }
      if (!output.length) {
        console.log("No log entries found.");
        return;
      }
      const latest = output[output.length - 1];
      const summary = [
        `Showing ${output.length} logs`,
        cmdOpts.all ? "mode=all" : `mode=latest-${limit}`,
        level ? `level=${level}` : "",
        eventGlob ? `event=${eventGlob}` : "",
        cmdOpts.since ? `since=${cmdOpts.since}` : "",
        `latest_event=${String(latest.event ?? "unknown")}`,
        `latest_status=${String(latest.status ?? "unknown")}`
      ].filter(Boolean).join(" | ");
      const blocks = output.map((row, index) => formatLogEntry(row, index));
      console.log(`${summary}\n\n${blocks.join("\n\n")}`);
    });

  program
    .command("history")
    .option("--limit <n>", "Show last N rows (default: all)")
    .option("--symbol <ticker>", "Filter by symbol")
    .option("--status <status>", "Filter by status")
    .option("--account-id <id>", "Filter by account id")
    .option("--since <span>", "Filter by age: 30m, 2h, 1d")
    .option("--clear-last <n>", "Delete the last N trades")
    .option("--clear-id <id>", "Delete one trade by history ID")
    .option("--dry-run", "Preview delete effect without changing history")
    .option("--yes", "Confirm destructive clear operation")
    .option("--json", "Output raw JSON history entries")
    .option("--clear", "Delete history file")
    .action(async (cmdOpts: {
      limit: string;
      symbol?: string;
      status?: string;
      accountId?: string;
      since?: string;
      clearLast?: string;
      clearId?: string;
      dryRun?: boolean;
      yes?: boolean;
      json?: boolean;
      clear?: boolean;
    }) => {
      const clearModes = [cmdOpts.clear === true, Boolean(cmdOpts.clearLast), Boolean(cmdOpts.clearId)].filter(Boolean).length;
      if (clearModes > 1) throw new Error("Use only one clear mode at a time: --clear, --clear-last, or --clear-id.");
      if (clearModes > 0 && !cmdOpts.dryRun && cmdOpts.yes !== true) {
        throw new Error("Destructive clear requires --yes. Use --dry-run to preview first.");
      }
      if (cmdOpts.clear) {
        if (cmdOpts.dryRun) {
          const existing = existsSync(BUY_HISTORY_FILE);
          const count = existing ? readJsonl(BUY_HISTORY_FILE, Number.MAX_SAFE_INTEGER).length : 0;
          print({ dry_run: true, action: "clear", target: BUY_HISTORY_FILE, would_delete: count });
          return;
        }
        if (existsSync(BUY_HISTORY_FILE)) {
          writeFileSync(BUY_HISTORY_FILE, "", "utf-8");
          print({ deleted: [BUY_HISTORY_FILE], missing: [] });
        } else {
          print({ deleted: [], missing: [BUY_HISTORY_FILE] });
        }
        return;
      }
      if (cmdOpts.clearLast) {
        const removeCount = parsePositiveIntOption(cmdOpts.clearLast, "--clear-last");
        const ensured = ensureHistoryIds(readJsonl(BUY_HISTORY_FILE, Number.MAX_SAFE_INTEGER));
        const rows = ensured.rows;
        if (ensured.updated) writeJsonlRows(BUY_HISTORY_FILE, rows);
        if (removeCount > rows.length) {
          throw new Error(`Cannot clear last ${removeCount} trades; only ${rows.length} trades exist.`);
        }
        if (cmdOpts.dryRun) {
          const affected = rows.slice(rows.length - removeCount).map((row) => String(row.history_id ?? ""));
          print({ dry_run: true, action: "clear_last", remove_count: removeCount, would_delete_ids: affected });
          return;
        }
        const keep = rows.slice(0, rows.length - removeCount);
        writeJsonlRows(BUY_HISTORY_FILE, keep);
        print({ cleared: removeCount, remaining: keep.length });
        return;
      }
      if (cmdOpts.clearId) {
        const targetId = cmdOpts.clearId.trim();
        if (!targetId) throw new Error("--clear-id requires a non-empty ID.");
        const ensured = ensureHistoryIds(readJsonl(BUY_HISTORY_FILE, Number.MAX_SAFE_INTEGER));
        const rows = ensured.rows;
        if (ensured.updated) writeJsonlRows(BUY_HISTORY_FILE, rows);
        const keep = rows.filter((row) => String(row.history_id ?? "").trim() !== targetId);
        if (keep.length === rows.length) {
          throw new Error(`No trade found with history ID '${targetId}'.`);
        }
        if (cmdOpts.dryRun) {
          print({ dry_run: true, action: "clear_id", would_delete_id: targetId, matches: rows.length - keep.length });
          return;
        }
        writeJsonlRows(BUY_HISTORY_FILE, keep);
        print({ cleared_id: targetId, remaining: keep.length });
        return;
      }
      const parsedLimit = cmdOpts.limit !== undefined ? Number.parseInt(cmdOpts.limit, 10) : undefined;
      if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit <= 0)) {
        throw new Error("--limit must be a positive integer.");
      }
      const limit = parsedLimit;
      const ensured = ensureHistoryIds(readJsonl(BUY_HISTORY_FILE, Number.MAX_SAFE_INTEGER));
      const rows = ensured.rows;
      if (ensured.updated) writeJsonlRows(BUY_HISTORY_FILE, rows);
      const symbol = (cmdOpts.symbol ?? "").trim().toUpperCase();
      const status = (cmdOpts.status ?? "").trim().toLowerCase();
      const accountId = (cmdOpts.accountId ?? "").trim();
      const sinceSeconds = parseSinceSeconds(cmdOpts.since ?? "");
      const cutoff = sinceSeconds !== null ? Date.now() / 1000 - sinceSeconds : null;
      const filtered = rows.filter((row) => {
        if (symbol && String(row.symbol ?? "").trim().toUpperCase() !== symbol) return false;
        if (status && String(row.status ?? "").trim().toLowerCase() !== status) return false;
        if (accountId && String(row.account_id ?? "").trim() !== accountId) return false;
        if (cutoff !== null) {
          const ts = parseIsoToUnix(String(row.ts_utc ?? ""));
          if (ts === null || ts < cutoff) return false;
        }
        return true;
      });
      const output = limit !== undefined ? filtered.slice(-limit) : filtered;
      if (cmdOpts.json) {
        print({ path: BUY_HISTORY_FILE, entries: output });
        return;
      }
      if (!output.length) {
        console.log("No history entries found.");
        return;
      }
      const opts = program.opts<GlobalOptions>();
      const { token, bundle } = await resolveAccessToken(opts);
      const accounts = await listAccounts(token, bundle);
      const accountLabels = buildAccountLabelMap(accounts);
      const blocks = output.map((row, index) => formatHistoryEntry(row, index, accountLabels));
      console.log(blocks.join("\n\n"));
    });

  const normalizedArgv = process.argv.map((arg) => (arg === "-all" ? "--all" : arg));
  await program.parseAsync(normalizedArgv);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
});
