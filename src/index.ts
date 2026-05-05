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
    session_id: SESSION_ID,
    level: "info",
    ...entry
  });
}

function appendBuyHistory(entry: Record<string, unknown>): void {
  writeJsonl(BUY_HISTORY_FILE, {
    ts_utc: new Date().toISOString(),
    ...entry
  });
  appendLog({
    event: "buy_history_append",
    status: String(entry.status ?? "unknown"),
    symbol: entry.symbol,
    account_id: entry.account_id,
    order_id: entry.order_id
  });
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
  const response = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      accept: "*/*",
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      origin: "https://my.wealthsimple.com",
      referer: "https://my.wealthsimple.com/",
      "user-agent": "wsli",
      "x-ws-api-version": DEFAULT_API_VERSION,
      "x-ws-profile": "trade",
      "x-ws-operation-name": operationName,
      "x-ws-client-library": "wsli",
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

function globMatch(text: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(text);
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

async function resolveSecurityIdArg(token: string, bundle: OAuthBundle, raw: string): Promise<string> {
  try {
    return normalizeSecurityId(raw);
  } catch {
    const payload = await graphqlRequest(token, "FetchSecuritySearchResult", FETCH_SECURITY_SEARCH, { query: raw }, bundle);
    const results = ((((payload.data as Record<string, unknown>)?.securitySearch as Record<string, unknown>)?.results) as Record<string, unknown>[] | undefined) ?? [];
    if (!results.length) throw new Error(`No security found for '${raw}'.`);
    const exact = results.find((item) => {
      const stock = item.stock as Record<string, unknown> | undefined;
      return String(stock?.symbol ?? "").toUpperCase() === raw.toUpperCase();
    });
    const looksLikeTicker = /^[A-Za-z][A-Za-z0-9.-]{0,9}$/.test(raw.trim());
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

function assertBuyOrderNotRejected(order: Record<string, unknown>): void {
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

async function waitForOrderStatus(token: string, externalId: string, timeoutSeconds = 30): Promise<Record<string, unknown>> {
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
      if (!["", "new", "pending", "queued", "accepted", "open", "submitted", "in_progress"].includes(status)) {
        return order;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Order ${externalId} did not finalize in ${timeoutSeconds}s`);
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
      "Wealthsimple CLI: read-only GraphQL plus Trade REST (accounts, portfolio, funding, preview-buy, market buy/sell with --confirm)."
    )
    .version(VERSION);

  program.command("config-path").action(() => {
    console.log(CONFIG_FILE);
  });

  program.command("session-path").action(() => {
    console.log(SESSION_FILE);
  });

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
        print({
          action,
          token_info: tokenInfo ?? {},
          session_info: sessionInfo ?? {},
          expires_in: expiresIn,
          idle_mode: isIdle,
          next_probe_ms: cadenceMs
        });
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
      const opts = program.opts<GlobalOptions>();
      const { token } = await resolveAccessToken(opts);
      const limit = Math.max(1, Math.min(50, Number.parseInt(cmdOpts.limit, 10) || 20));
      const payload = await tradeRequest(token, "GET", `/securities?query=${encodeURIComponent(query)}`) as Record<string, unknown>;
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
    .command("restrictions")
    .requiredOption("--security-id <id>", "Security id (sec-s-...)")
    .option("--side <side>", "BUY or SELL", "BUY")
    .action(async (cmdOpts: { securityId: string; side: string }) => {
      const opts = program.opts<GlobalOptions>();
      const { token, bundle } = await resolveAccessToken(opts);
      const side = cmdOpts.side.toUpperCase();
      if (side !== "BUY" && side !== "SELL") throw new Error("--side must be BUY or SELL");
      const payload = await graphqlRequest(token, "FetchSoOrdersLimitOrderRestrictions", FETCH_SO_ORDERS_LIMIT_ORDER_RESTRICTIONS, {
        args: {
          securityId: normalizeSecurityId(cmdOpts.securityId),
          side
        }
      }, bundle);
      print(payload);
    });

  program
    .command("preview-buy")
    .argument("[securityOrQuery]", "Security id or ticker/query")
    .option("--symbol <ticker>", "Ticker/search text instead of positional arg")
    .requiredOption("--shares <n>", "Share quantity")
    .option("--order <type>", "market or limit", "market")
    .option("--limit-price <n>", "Required when --order limit")
    .option("--assume-price <n>", "Informational notional estimate only")
    .action(async (securityOrQuery: string | undefined, cmdOpts: Record<string, string | undefined>) => {
      const opts = program.opts<GlobalOptions>();
      const { token, bundle } = await resolveAccessToken(opts);
      if (securityOrQuery && cmdOpts.symbol) throw new Error("Use either positional security/query or --symbol, not both.");
      const chosen = String(cmdOpts.symbol ?? securityOrQuery ?? "").trim();
      if (!chosen) throw new Error("Provide security id/search query or --symbol.");
      const shares = Number.parseFloat(String(cmdOpts.shares ?? ""));
      if (!Number.isFinite(shares) || shares <= 0) throw new Error("--shares must be positive");
      const order = String(cmdOpts.order ?? "market").toLowerCase();
      const limitPrice = cmdOpts.limitPrice !== undefined ? Number.parseFloat(String(cmdOpts.limitPrice)) : undefined;
      if (order === "limit" && (limitPrice === undefined || !Number.isFinite(limitPrice) || limitPrice <= 0)) {
        throw new Error("limit orders require positive --limit-price");
      }
      const sid = await resolveSecurityIdArg(token, bundle, chosen);
      const [securityPayload, restrictionsPayload] = await Promise.all([
        graphqlRequest(token, "FetchSecurity", FETCH_SECURITY, { securityId: sid }, bundle),
        graphqlRequest(token, "FetchSoOrdersLimitOrderRestrictions", FETCH_SO_ORDERS_LIMIT_ORDER_RESTRICTIONS, {
          args: { securityId: sid, side: "BUY" }
        }, bundle)
      ]);
      const out = {
        preview_only: true,
        no_submit: true,
        intent: {
          side: "BUY",
          order_type: order.toUpperCase(),
          shares,
          security_id: sid,
          limit_price: limitPrice ?? null,
          assumed_price_per_share_usd: cmdOpts.assumePrice ? Number.parseFloat(String(cmdOpts.assumePrice)) : null
        },
        result: {
          security_ok: true,
          restrictions_ok: true,
          ready_for_real_buy_command: true
        },
        graphql: {
          security: securityPayload,
          restrictions: restrictionsPayload
        }
      };
      print(out);
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
        cmdOpts.accountIndex ? Number.parseInt(cmdOpts.accountIndex, 10) : undefined
      );
      const payload = await graphqlRequest(token, "FetchAccountPositions", FETCH_ACCOUNT_POSITIONS, { accountId }, bundle);
      const positions = ((payload.data as Record<string, unknown>)?.account as Record<string, unknown>)?.positions ?? [];
      print(positions);
    });

  program.command("portfolio").action(async () => {
    const opts = program.opts<GlobalOptions>();
    const { token, bundle } = await resolveAccessToken(opts);
    const accounts = await listAccounts(token, bundle);
    const out: Record<string, unknown>[] = [];
    for (const account of accounts) {
      const accountId = String(account.id);
      const payload = await graphqlRequest(token, "FetchAccountPositions", FETCH_ACCOUNT_POSITIONS, { accountId }, bundle);
      const positions = ((payload.data as Record<string, unknown>)?.account as Record<string, unknown>)?.positions ?? [];
      out.push({ account, positions });
    }
    print(out);
  });

  program.command("funding").action(async () => {
    const opts = program.opts<GlobalOptions>();
    const { token, bundle } = await resolveAccessToken(opts);
    const rows = await listAccounts(token, bundle);
    const funding = rows.map((row) => ({
      id: row.id,
      account_type: row.account_type,
      current_balance: row.current_balance,
      net_deposits: row.net_deposits
    }));
    print(funding);
  });

  program
    .command("buy")
    .argument("[target]", "Ticker or security id")
    .option("--symbol <ticker>")
    .option("--security-id <id>")
    .option("--shares <n>")
    .option("--dollars <amount>")
    .option("--order <type>", "market or limit", "market")
    .option("--limit-price <n>", "Required when --order limit")
    .option("--account-id <id>")
    .option("--account-type <type>")
    .option("--account-index <n>")
    .option("--confirm", "Required safety latch")
    .action(async (target: string | undefined, cmdOpts: Record<string, string | boolean | undefined>) => {
      if (!cmdOpts.confirm) throw new Error("Missing --confirm safety latch.");
      const opts = program.opts<GlobalOptions>();
      const { token, bundle } = await resolveAccessToken(opts);
      const accountId = await resolveAccountId(
        token,
        bundle,
        cmdOpts.accountId as string | undefined,
        cmdOpts.accountType as string | undefined,
        cmdOpts.accountIndex ? Number.parseInt(String(cmdOpts.accountIndex), 10) : undefined
      );
      const symbol = String(cmdOpts.symbol ?? target ?? "").trim();
      const securityId = String(cmdOpts.securityId ?? "").trim();
      if (!securityId && !symbol) throw new Error("Provide --security-id or ticker/symbol.");
      const resolvedSecurityId = securityId || await resolveSecurityIdArg(token, bundle, symbol);
      const shares = cmdOpts.shares ? Number.parseFloat(String(cmdOpts.shares)) : undefined;
      const dollars = cmdOpts.dollars ? Number.parseFloat(String(cmdOpts.dollars)) : undefined;
      if ((shares === undefined) === (dollars === undefined)) {
        throw new Error("Provide exactly one of --shares or --dollars.");
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
      if (orderStyle === "limit" && dollars !== undefined) {
        throw new Error("limit buys currently require --shares (not --dollars).");
      }
      if (orderStyle === "limit" && shares !== undefined && !Number.isInteger(shares)) {
        throw new Error("limit buys require whole shares (fractional shares are not accepted).");
      }
      let accountCurrency: string | null = null;
      if (orderStyle === "limit" && shares !== undefined && limitPrice !== undefined) {
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
        executionType: shares && shares % 1 !== 0 ? "FRACTIONAL" : dollars ? "FRACTIONAL" : "REGULAR",
        orderType: dollars ? "BUY_VALUE" : "BUY_QUANTITY",
        securityId: resolvedSecurityId,
        timeInForce: orderStyle === "limit" || (shares && shares % 1 === 0) ? "DAY" : null
      };
      if (shares !== undefined) input.quantity = shares;
      if (dollars !== undefined) input.value = dollars;
      if (limitPrice !== undefined) input.limitPrice = limitPrice;
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
      const order = await waitForOrderStatus(token, externalId);
      assertBuyOrderNotRejected(order);
      appendBuyHistory({
        status: String(order.status ?? "unknown"),
        symbol: symbol || null,
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
    .option("--symbol <ticker>")
    .option("--security-id <id>")
    .option("--shares <n>")
    .option("--account-id <id>")
    .option("--account-type <type>")
    .option("--account-index <n>")
    .option("--confirm", "Required safety latch")
    .action(async (cmdOpts: Record<string, string | boolean | undefined>) => {
      if (!cmdOpts.confirm) throw new Error("Missing --confirm safety latch.");
      const opts = program.opts<GlobalOptions>();
      const { token, bundle } = await resolveAccessToken(opts);
      const accountId = await resolveAccountId(
        token,
        bundle,
        cmdOpts.accountId as string | undefined,
        cmdOpts.accountType as string | undefined,
        cmdOpts.accountIndex ? Number.parseInt(String(cmdOpts.accountIndex), 10) : undefined
      );
      const shares = Number.parseFloat(String(cmdOpts.shares ?? ""));
      if (!Number.isFinite(shares) || shares <= 0) throw new Error("--shares must be a positive number.");
      let securityId = String(cmdOpts.securityId ?? "");
      if (!securityId) {
        const symbol = String(cmdOpts.symbol ?? "");
        if (!symbol) throw new Error("Provide --security-id or --symbol.");
        const search = await tradeRequest(token, "GET", `/securities?query=${encodeURIComponent(symbol)}`) as Record<string, unknown>;
        securityId = String(((search.results as Record<string, unknown>[])[0] ?? {}).id ?? "");
      }
      if (!securityId) throw new Error("Could not resolve security id.");
      const security = await tradeRequest(token, "GET", `/securities/${securityId}`) as Record<string, unknown>;
      const quote = (security.quote as Record<string, unknown> | undefined)?.amount;
      if (quote === undefined || quote === null) throw new Error("Missing quote amount for market sell.");
      const payload = await tradeRequest(token, "POST", "/orders", {
        account_id: accountId,
        security_id: securityId,
        quantity: shares,
        order_type: "sell_quantity",
        order_sub_type: "market",
        time_in_force: "day",
        limit_price: Number(quote)
      }) as Record<string, unknown>;
      const orderId = String(payload.order_id ?? payload.id ?? "");
      if (!orderId) throw new Error("Sell response missing order id.");
      const orders = await tradeRequest(token, "GET", "/orders") as Record<string, unknown>;
      const row = ((orders.results as Record<string, unknown>[]) ?? []).find(
        (entry) => String(entry.order_id ?? entry.id ?? "") === orderId
      );
      appendBuyHistory({
        status: String((row ?? payload).status ?? "unknown"),
        symbol: cmdOpts.symbol ? String(cmdOpts.symbol) : null,
        security_id: securityId,
        account_id: accountId,
        order_id: orderId,
        external_id: null,
        submitted_quantity: shares,
        submitted_value: null,
        filled_quantity: (row ?? payload).filled_quantity ?? null,
        average_filled_price: (row ?? payload).average_filled_price ?? null
      });
      print(row ?? payload);
    });

  program
    .command("logs")
    .option("--limit <n>", "Show last N rows", "50")
    .option("--level <level>", "Filter level")
    .option("--event <glob>", "Filter event by glob pattern")
    .option("--since <span>", "Filter by age: 30m, 2h, 1d")
    .option("--clear", "Delete log file")
    .action((cmdOpts: { limit: string; level?: string; event?: string; since?: string; clear?: boolean }) => {
      if (cmdOpts.clear) {
        if (existsSync(LOG_FILE)) {
          writeFileSync(LOG_FILE, "", "utf-8");
          print({ deleted: [LOG_FILE], missing: [] });
        } else {
          print({ deleted: [], missing: [LOG_FILE] });
        }
        return;
      }
      const limit = Math.max(1, Number.parseInt(cmdOpts.limit, 10) || 50);
      const rows = readJsonl(LOG_FILE, limit * 10);
      const level = (cmdOpts.level ?? "").trim().toLowerCase();
      const eventGlob = (cmdOpts.event ?? "").trim();
      const sinceSeconds = parseSinceSeconds(cmdOpts.since ?? "");
      const cutoff = sinceSeconds !== null ? Date.now() / 1000 - sinceSeconds : null;
      const filtered = rows.filter((row) => {
        if (level && String(row.level ?? "").toLowerCase() !== level) return false;
        if (eventGlob && !globMatch(String(row.event ?? ""), eventGlob)) return false;
        if (cutoff !== null) {
          const ts = parseIsoToUnix(String(row.ts_utc ?? ""));
          if (ts === null || ts < cutoff) return false;
        }
        return true;
      });
      const output = filtered.length > limit ? filtered.slice(-limit) : filtered;
      print({ path: LOG_FILE, entries: output });
    });

  program
    .command("history")
    .option("--limit <n>", "Show last N rows", "50")
    .option("--symbol <ticker>", "Filter by symbol")
    .option("--status <status>", "Filter by status")
    .option("--account-id <id>", "Filter by account id")
    .option("--since <span>", "Filter by age: 30m, 2h, 1d")
    .option("--clear", "Delete history file")
    .action((cmdOpts: { limit: string; symbol?: string; status?: string; accountId?: string; since?: string; clear?: boolean }) => {
      if (cmdOpts.clear) {
        if (existsSync(BUY_HISTORY_FILE)) {
          writeFileSync(BUY_HISTORY_FILE, "", "utf-8");
          print({ deleted: [BUY_HISTORY_FILE], missing: [] });
        } else {
          print({ deleted: [], missing: [BUY_HISTORY_FILE] });
        }
        return;
      }
      const limit = Math.max(1, Number.parseInt(cmdOpts.limit, 10) || 50);
      const rows = readJsonl(BUY_HISTORY_FILE, limit * 10);
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
      const output = filtered.length > limit ? filtered.slice(-limit) : filtered;
      print({ path: BUY_HISTORY_FILE, entries: output });
    });

  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
});
