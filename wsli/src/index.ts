#!/usr/bin/env node
import { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";
import readline from "node:readline";

const VERSION = "0.1.0";
const GRAPHQL_URL = "https://my.wealthsimple.com/graphql";
const TRADE_SERVICE_BASE = "https://trade-service.wealthsimple.com";
const OAUTH_TOKEN_URL = "https://api.production.wealthsimple.com/v1/oauth/v2/token";
const OAUTH_TOKEN_INFO_URL = "https://api.production.wealthsimple.com/v1/oauth/v2/token/info";
const DEFAULT_OAUTH_CLIENT_ID = "4da53ac2b03225bed1550eba8e4611e086c7b905a3855e6ed12ea08c246758fa";
const CONFIG_DIR = path.join(os.homedir(), ".config", "wsli");
const SESSION_FILE = path.join(CONFIG_DIR, "session.json");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const LOG_FILE = path.join(CONFIG_DIR, "logs.jsonl");
const BUY_HISTORY_FILE = path.join(CONFIG_DIR, "buy_history.jsonl");
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
  json?: boolean;
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
    console.log(JSON.stringify(out, null, 2));
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

function extractFirstJsonObject(raw: string): string {
  const text = raw.trim();
  if (!text) throw new Error("No JSON input received.");
  let start = text.indexOf("{");
  while (start >= 0) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === "\"") {
          inString = false;
        }
        continue;
      }
      if (ch === "\"") {
        inString = true;
        continue;
      }
      if (ch === "{") depth += 1;
      if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          const candidate = text.slice(start, i + 1);
          JSON.parse(candidate);
          return candidate;
        }
      }
    }
    start = text.indexOf("{", start + 1);
  }
  throw new Error("Could not parse a JSON object from input.");
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

  if (process.env.WEALTHSIMPLE_OAUTH_JSON) {
    const data = JSON.parse(process.env.WEALTHSIMPLE_OAUTH_JSON) as OAuthBundle;
    if (!data.access_token) throw new Error("WEALTHSIMPLE_OAUTH_JSON must include access_token.");
    return data;
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
    "No credentials found. Run wsli import-session <tokens.json> or set WEALTHSIMPLE_ACCESS_TOKEN."
  );
}

async function resolveAccessToken(opts: GlobalOptions): Promise<{ token: string; bundle: OAuthBundle }> {
  let bundle = await resolveOAuthBundle(opts);
  const noRefresh = ["1", "true", "yes"].includes(
    String(process.env.WSPROBE_NO_REFRESH ?? process.env.WSLI_NO_REFRESH ?? "").trim().toLowerCase()
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

function print(data: unknown, asJson = false): void {
  if (asJson) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
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
  return rows;
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
    const candidate = exact ?? results[0];
    const sid = String(candidate.id ?? "");
    if (!sid.startsWith("sec-s-")) throw new Error(`Could not resolve valid security id for '${raw}'.`);
    return sid;
  }
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
    const payload = await graphqlRequest(token, "FetchSoOrdersExtendedOrder", FETCH_SO_ORDERS_EXTENDED_ORDER, {
      branchId: "TR",
      externalId
    });
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
    .option("--refresh-token <token>", "Refresh token for this run")
    .option("--json", "JSON output");
}

async function main(): Promise<void> {
  const program = withGlobalOptions(new Command())
    .name("wsli")
    .description("NPM-native Wealthsimple CLI")
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
    console.error("\nStep 3: Paste the resulting JSON here and press Ctrl-D:\n");
    const raw = await readAllStdinInteractive();
    const parsedText = extractFirstJsonObject(raw);
    const payload = JSON.parse(parsedText) as Record<string, unknown>;
    if (typeof payload.access_token !== "string" || !payload.access_token.trim()) {
      throw new Error("Imported JSON is missing access_token.");
    }
    writeJsonFile(SESSION_FILE, payload);
    appendLog({ event: "session_import", status: "ok", source: "setup" });
    console.error(`Saved credentials to ${SESSION_FILE}`);
  };

  program.command("setup").description("Interactive onboarding flow").action(runSetup);

  program
    .command("snippet")
    .description("Print browser console snippet for session export")
    .action(() => {
      console.log(EXPORT_SESSION_SNIPPET);
    });

  program.command("onboard").description("Alias for setup").action(runSetup);

  program
    .command("import-session")
    .argument("[file]", "JSON file with access_token")
    .action(async (file?: string) => {
      const content = file ? readFileSync(path.resolve(file), "utf-8") : await readAllStdinInteractive();
      const parsedText = extractFirstJsonObject(content);
      const payload = JSON.parse(parsedText) as Record<string, unknown>;
      if (typeof payload.access_token !== "string" || !payload.access_token.trim()) {
        throw new Error("Session import requires access_token.");
      }
      writeJsonFile(SESSION_FILE, payload);
      appendLog({ event: "session_import", status: "ok", source: file ? "file" : "stdin" });
      console.log(`Saved session to ${SESSION_FILE}`);
    });

  program.command("ping").action(async () => {
    const opts = program.opts<GlobalOptions>();
    const { token } = await resolveAccessToken(opts);
    const response = await fetch(OAUTH_TOKEN_INFO_URL, {
      headers: { accept: "application/json", authorization: `Bearer ${token}` }
    });
    const payload = await response.json();
    print({ status: response.status, payload }, !!opts.json);
    if (!response.ok) process.exit(1);
  });

  program
    .command("keepalive")
    .option("--once", "Run one probe/refresh cycle and exit")
    .action(async (cmdOpts: { once?: boolean }) => {
      const opts = program.opts<GlobalOptions>();
      const runCycle = async (): Promise<void> => {
        const bundle = await resolveOAuthBundle(opts);
        const noRefresh = ["1", "true", "yes"].includes(
          String(process.env.WSPROBE_NO_REFRESH ?? process.env.WSLI_NO_REFRESH ?? "").trim().toLowerCase()
        );
        let access = bundle.access_token;
        let tokenInfo: Record<string, unknown> = {};
        appendLog({ event: "auth_keeper_cycle", status: "start" });
        try {
          const response = await fetch(OAUTH_TOKEN_INFO_URL, {
            headers: { accept: "application/json", authorization: `Bearer ${access}` }
          });
          tokenInfo = (await response.json()) as Record<string, unknown>;
          if (response.status === 401 || response.status === 403) {
            if (noRefresh) throw new Error("Token probe returned 401/403 and refresh is disabled (WSPROBE_NO_REFRESH).");
            if (!bundle.refresh_token) throw new Error("Token probe failed and no refresh_token available.");
            const refreshed = await refreshAccessToken(bundle);
            access = refreshed.access_token;
            writeJsonFile(SESSION_FILE, refreshed);
            tokenInfo = {
              refreshed: true,
              created_at: refreshed.created_at ?? null,
              expires_in: refreshed.expires_in ?? null
            };
          } else if (!response.ok) {
            throw new Error(`token/info HTTP ${response.status}: ${JSON.stringify(tokenInfo)}`);
          }
        } catch (error) {
          appendLog({
            event: "auth_keeper_cycle",
            status: "error",
            message: error instanceof Error ? error.message : String(error)
          });
          throw new Error(`keepalive probe failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        appendLog({
          event: "auth_keeper_cycle",
          status: "ok",
          expires_in: tokenInfo.expires_in ?? null
        });
        print({ action: "probe", token_info: tokenInfo }, !!opts.json);
      };
      if (cmdOpts.once) {
        await runCycle();
        return;
      }
      while (true) {
        await runCycle();
        await new Promise((resolve) => setTimeout(resolve, 75_000));
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
      print(results, !!opts.json);
    });

  program.command("accounts").action(async () => {
    const opts = program.opts<GlobalOptions>();
    const { token, bundle } = await resolveAccessToken(opts);
    const rows = await listAccounts(token, bundle);
    print(rows, !!opts.json);
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
      print(payload, !!opts.json);
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
      print(payload, !!opts.json);
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
      print(out, !!opts.json);
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
      print(positions, !!opts.json);
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
    print(out, !!opts.json);
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
    print(funding, !!opts.json);
  });

  program
    .command("buy")
    .argument("[target]", "Ticker or security id")
    .option("--symbol <ticker>")
    .option("--security-id <id>")
    .option("--shares <n>")
    .option("--dollars <amount>")
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
      const symbol = String(cmdOpts.symbol ?? target ?? "");
      const securityId = String(cmdOpts.securityId ?? "");
      const resolvedSecurityId = securityId || String(((await tradeRequest(token, "GET", `/securities?query=${encodeURIComponent(symbol)}`) as Record<string, unknown>).results as Record<string, unknown>[])[0]?.id ?? "");
      if (!resolvedSecurityId) throw new Error("Could not resolve security id.");
      const shares = cmdOpts.shares ? Number.parseFloat(String(cmdOpts.shares)) : undefined;
      const dollars = cmdOpts.dollars ? Number.parseFloat(String(cmdOpts.dollars)) : undefined;
      if ((shares === undefined) === (dollars === undefined)) {
        throw new Error("Provide exactly one of --shares or --dollars.");
      }
      const externalId = `order-${crypto.randomUUID()}`;
      const input: Record<string, unknown> = {
        canonicalAccountId: accountId,
        externalId,
        executionType: shares && shares % 1 !== 0 ? "FRACTIONAL" : dollars ? "FRACTIONAL" : "REGULAR",
        orderType: dollars ? "BUY_VALUE" : "BUY_QUANTITY",
        securityId: resolvedSecurityId,
        timeInForce: shares && shares % 1 === 0 ? "DAY" : null
      };
      if (shares !== undefined) input.quantity = shares;
      if (dollars !== undefined) input.value = dollars;
      await graphqlRequest(token, "SoOrdersOrderCreate", MUTATION_SO_ORDERS_ORDER_CREATE, { input }, bundle);
      const order = await waitForOrderStatus(token, externalId);
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
      print(order, !!opts.json);
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
      print(row ?? payload, !!opts.json);
    });

  program
    .command("logs")
    .option("--limit <n>", "Show last N rows", "50")
    .option("--level <level>", "Filter level")
    .option("--event <glob>", "Filter event by glob pattern")
    .option("--since <span>", "Filter by age: 30m, 2h, 1d")
    .option("--clear", "Delete log file")
    .action((cmdOpts: { limit: string; level?: string; event?: string; since?: string; clear?: boolean }) => {
      const opts = program.opts<GlobalOptions>();
      if (cmdOpts.clear) {
        if (existsSync(LOG_FILE)) {
          writeFileSync(LOG_FILE, "", "utf-8");
          print({ deleted: [LOG_FILE], missing: [] }, !!opts.json);
        } else {
          print({ deleted: [], missing: [LOG_FILE] }, !!opts.json);
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
      print({ path: LOG_FILE, entries: output }, !!opts.json);
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
      const opts = program.opts<GlobalOptions>();
      if (cmdOpts.clear) {
        if (existsSync(BUY_HISTORY_FILE)) {
          writeFileSync(BUY_HISTORY_FILE, "", "utf-8");
          print({ deleted: [BUY_HISTORY_FILE], missing: [] }, !!opts.json);
        } else {
          print({ deleted: [], missing: [BUY_HISTORY_FILE] }, !!opts.json);
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
      print({ path: BUY_HISTORY_FILE, entries: output }, !!opts.json);
    });

  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
});
