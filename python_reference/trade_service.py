"""Wealthsimple Trade REST (https://trade-service.wealthsimple.com).

Uses the same OAuth bearer token as GraphQL. These calls go **directly** to
Wealthsimple Trade (not a third-party broker API).
"""

from __future__ import annotations

import json
import ssl
import time
import urllib.error
import urllib.request
import uuid
from typing import Any
from urllib.parse import quote

from wsprobe.client import graphql_request, identity_id_for_graphql
from wsprobe.queries import (
    FETCH_SECURITY_QUOTES,
    FETCH_SO_ORDERS_EXTENDED_ORDER,
    FETCH_TRADE_ACCOUNT_LIST,
    MUTATION_SO_ORDERS_ORDER_CREATE,
)

TRADE_SERVICE_BASE = "https://trade-service.wealthsimple.com"
_TRANSIENT_ORDER_STATUSES = {"", "new", "pending", "queued", "accepted", "open", "submitted", "in_progress"}


def _raise_trade_rest_unavailable(endpoint: str, status: int, payload: Any) -> None:
    if status == 404:
        raise RuntimeError(
            "Wealthsimple Trade REST endpoint is unavailable: "
            f"{endpoint} returned 404. The web app now submits orders through GraphQL, "
            "and wsprobe currently blocks GraphQL mutations. Use the web app to place the order."
        )
    raise RuntimeError(f"{endpoint} HTTP {status}: {payload}")

# CLI --account-type aliases → legacy REST account_type values (ca_*), matched after GraphQL mapping.
_ACCOUNT_TYPE_ALIASES: dict[str, tuple[str, ...]] = {
    "tfsa": ("ca_tfsa",),
    "rrsp": ("ca_rrsp",),
    "resp": ("ca_resp", "ca_individual_resp", "ca_family_resp"),
    "fhsa": ("ca_fhsa",),
    "joint": ("ca_joint",),
    "non_registered": ("ca_non_registered",),
    "margin": ("ca_non_registered",),
    "cash": ("ca_non_registered",),
    "rrif": ("ca_rrif",),
    "lira": ("ca_lira",),
    "lrsp": ("ca_lrsp",),
}

# GraphQL Account.unifiedAccountType → ca_* (same labels pick_trade_account_id expects).
_UNIFIED_TO_CA: dict[str, str] = {
    "SELF_DIRECTED_TFSA": "ca_tfsa",
    "MANAGED_TFSA": "ca_tfsa",
    "SELF_DIRECTED_RRSP": "ca_rrsp",
    "MANAGED_RRSP": "ca_rrsp",
    "SELF_DIRECTED_SPOUSAL_RRSP": "ca_rrsp",
    "SELF_DIRECTED_NON_REGISTERED": "ca_non_registered",
    "SELF_DIRECTED_NON_REGISTERED_MARGIN": "ca_non_registered",
    "SELF_DIRECTED_JOINT_NON_REGISTERED": "ca_joint",
    "MANAGED_JOINT": "ca_joint",
    "SELF_DIRECTED_FHSA": "ca_fhsa",
    "MANAGED_FHSA": "ca_fhsa",
    "SELF_DIRECTED_INDIVIDUAL_RESP": "ca_individual_resp",
    "SELF_DIRECTED_FAMILY_RESP": "ca_family_resp",
    "SELF_DIRECTED_RESP": "ca_resp",
    "MANAGED_RESP": "ca_resp",
    "SELF_DIRECTED_RRIF": "ca_rrif",
    "SELF_DIRECTED_LIRA": "ca_lira",
    "SELF_DIRECTED_LRSP": "ca_lrsp",
    "SELF_DIRECTED_CRYPTO": "ca_non_registered",
}


def _account_type_from_unified(unified: str | None) -> str | None:
    if not unified:
        return None
    u = str(unified).strip()
    if u in _UNIFIED_TO_CA:
        return _UNIFIED_TO_CA[u]
    up = u.upper()
    if "TFSA" in up:
        return "ca_tfsa"
    if "FHSA" in up:
        return "ca_fhsa"
    if "SPOUSAL" in up and "RRSP" in up:
        return "ca_rrsp"
    if "RRSP" in up:
        return "ca_rrsp"
    if "INDIVIDUAL_RESP" in up:
        return "ca_individual_resp"
    if "FAMILY_RESP" in up:
        return "ca_family_resp"
    if "RESP" in up:
        return "ca_resp"
    if "JOINT" in up and "NON_REGISTERED" in up:
        return "ca_joint"
    if "NON_REGISTERED" in up or "MARGIN" in up:
        return "ca_non_registered"
    if "RRIF" in up:
        return "ca_rrif"
    if "LIRA" in up:
        return "ca_lira"
    if "LRSP" in up:
        return "ca_lrsp"
    return None


def _money_from_graphql_fragment(m: Any) -> dict[str, Any] | None:
    if not isinstance(m, dict):
        return None
    amt = m.get("amount")
    cur = m.get("currency")
    if amt is None and cur is None:
        return None
    out: dict[str, Any] = {}
    if amt is not None:
        out["amount"] = amt
    if cur is not None:
        out["currency"] = cur
    return out if out else None


def _graphql_account_to_row(node: dict[str, Any]) -> dict[str, Any]:
    unified = node.get("unifiedAccountType")
    mapped = _account_type_from_unified(str(unified) if unified is not None else None)
    trade_custodian = False
    for ca in node.get("custodianAccounts") or []:
        if isinstance(ca, dict) and str(ca.get("branch") or "").upper() in ("WS", "TR"):
            trade_custodian = True
            break
    fin = node.get("financials") if isinstance(node.get("financials"), dict) else {}
    combined = fin.get("currentCombined") if isinstance(fin.get("currentCombined"), dict) else {}
    nlv = _money_from_graphql_fragment(combined.get("netLiquidationValue"))
    nd = _money_from_graphql_fragment(combined.get("netDeposits"))
    row: dict[str, Any] = {
        "id": node.get("id"),
        "status": node.get("status"),
        "account_type": mapped,
        "unified_account_type": unified,
        "nickname": node.get("nickname"),
        "currency": node.get("currency"),
        "current_balance": nlv,
        "buying_power": None,
        "net_deposits": nd,
        "trade_custodian": trade_custodian,
    }
    return row


def account_type_display(account_type: str | None) -> str:
    """Short label for humans (e.g. ca_tfsa → TFSA)."""
    if not account_type:
        return "—"
    raw = str(account_type).strip()
    table = {
        "ca_tfsa": "TFSA",
        "ca_rrsp": "RRSP",
        "ca_resp": "RESP",
        "ca_individual_resp": "Individual RESP",
        "ca_family_resp": "Family RESP",
        "ca_fhsa": "FHSA",
        "ca_joint": "Joint",
        "ca_non_registered": "Non-registered",
        "ca_rrif": "RRIF",
        "ca_lira": "LIRA",
        "ca_lrsp": "LRSP",
    }
    return table.get(raw, raw.replace("ca_", "").replace("_", " ").upper())


def _request(
    method: str,
    path: str,
    *,
    access_token: str,
    json_body: dict[str, Any] | None = None,
    timeout_s: float = 45.0,
) -> tuple[int, Any]:
    url = f"{TRADE_SERVICE_BASE}{path}"
    headers = {
        "accept": "application/json",
        "authorization": f"Bearer {access_token}",
        "content-type": "application/json",
        "origin": "https://my.wealthsimple.com",
        "referer": "https://my.wealthsimple.com/",
        "user-agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
    }
    data: bytes | None = None
    if json_body is not None:
        data = json.dumps(json_body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, timeout=timeout_s, context=ctx) as resp:
            status = getattr(resp, "status", 200) or 200
            text = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        status = e.code
        text = e.read().decode("utf-8", errors="replace")
        try:
            return status, json.loads(text)
        except json.JSONDecodeError:
            preview = " ".join(text.split())
            if len(preview) > 320:
                preview = preview[:320] + "..."
            return status, {"_raw_preview": preview}

    try:
        return status, json.loads(text) if text.strip() else {}
    except json.JSONDecodeError:
        return status, {"_raw": text}


def search_securities(access_token: str, query: str) -> list[dict[str, Any]]:
    q = quote(query.strip(), safe="")
    status, body = _request("GET", f"/securities?query={q}", access_token=access_token)
    if status == 404:
        # Fallback to GraphQL search
        from wsprobe.queries import FETCH_SECURITY_SEARCH
        gql_status, gql_body, _ = graphql_request(
            access_token=access_token,
            operation_name="FetchSecuritySearchResult",
            query=FETCH_SECURITY_SEARCH,
            variables={"query": query.strip()},
        )
        if gql_status == 200 and isinstance(gql_body, dict):
            block = (gql_body.get("data") or {}).get("securitySearch") or {}
            results = block.get("results") if isinstance(block, dict) else None
            if isinstance(results, list):
                return [r for r in results if isinstance(r, dict)]
        return []
    if status != 200:
        _raise_trade_rest_unavailable("securities?query=", status, body)
    if not isinstance(body, dict):
        raise RuntimeError(f"Unexpected securities search response: {body}")
    results = body.get("results")
    if not isinstance(results, list):
        raise RuntimeError(f"securities search missing results: {body}")
    return [r for r in results if isinstance(r, dict)]


def symbol_to_security_id(access_token: str, symbol: str) -> str:
    """
    Resolve a ticker symbol to a Wealthsimple security id.

    Supports exchange filtering to disambiguate tickers that trade on multiple exchanges:
    - Prefix notation: TSX:AAPL, tsx:aapl, NYSE:TLT (case-insensitive)
    - Suffix notation: AAPL.TO, TLT.TO (Canadian convention)

    When no exchange filter is provided, returns the first match (existing behavior).
    """
    raw = symbol.strip()
    if not raw:
        raise ValueError("symbol is empty")

    # Parse exchange filter from prefix (e.g. "TSX:AAPL") or suffix (e.g. "AAPL.TO")
    exchange_filter = None
    search_symbol = raw.upper()

    # Check for prefix notation: EXCHANGE:SYMBOL
    if ":" in raw:
        parts = raw.split(":", 1)
        if len(parts) == 2:
            exchange_filter = parts[0].strip().upper()
            search_symbol = parts[1].strip().upper()

    # Check for suffix notation: SYMBOL.EXCHANGE (only if no prefix was found)
    if exchange_filter is None and "." in raw:
        parts = raw.rsplit(".", 1)
        if len(parts) == 2:
            # Extract the exchange from the suffix (e.g. ".TO" -> "TSX" or "TO")
            suffix = parts[1].strip().upper()
            # Common suffixes and their exchange names
            suffix_to_exchange = {
                "TO": "TSX",
                "V": "TSXV",
                "N": "NYSE",
                "OQ": "NASDAQ",
            }
            exchange_filter = suffix_to_exchange.get(suffix, suffix)
            search_symbol = parts[0].strip().upper()

    if not search_symbol:
        raise ValueError("symbol is empty after parsing exchange filter")

    rows = search_securities(access_token, search_symbol)
    if not rows:
        raise RuntimeError(f"No security found for {symbol!r}. Try the full ticker (e.g. VFV.TO).")

    # Filter by exchange if specified
    if exchange_filter:
        filtered_rows = []
        for r in rows:
            stock = r.get("stock") if isinstance(r.get("stock"), dict) else {}
            exchange = (stock.get("primaryExchange") or "").strip().upper()
            # Case-insensitive partial match for exchange name
            if exchange_filter in exchange:
                filtered_rows.append(r)

        if not filtered_rows:
            # Build helpful error message with available exchanges
            available_exchanges = []
            for r in rows:
                stock = r.get("stock") if isinstance(r.get("stock"), dict) else {}
                ex = (stock.get("primaryExchange") or "").strip()
                sym = (stock.get("symbol") or "").strip()
                if ex:
                    available_exchanges.append(f"{ex} ({sym})")

            exchanges_str = ", ".join(available_exchanges) if available_exchanges else "no exchanges listed"
            raise RuntimeError(
                f"No security found for {symbol!r} with exchange filter '{exchange_filter}'. "
                f"Available exchanges for {search_symbol}: {exchanges_str}"
            )
        rows = filtered_rows

    # Try exact symbol match first
    for r in rows:
        stock = r.get("stock") if isinstance(r.get("stock"), dict) else {}
        rsym = (stock.get("symbol") or "").strip().upper()
        if rsym == search_symbol:
            rid = r.get("id")
            if rid:
                return str(rid)

    # Fall back to first result
    rid = rows[0].get("id")
    if rid:
        return str(rid)
    raise RuntimeError("Search returned entries without id")


def list_accounts(
    access_token: str,
    *,
    oauth_bundle: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """
    List brokerage accounts via GraphQL (my.wealthsimple.com). Trade-service
    GET /account/list no longer responds (404); account ids still work for Trade REST orders.
    """
    iid = identity_id_for_graphql(access_token, oauth_bundle)
    if not iid:
        raise RuntimeError(
            "Could not resolve identity id for account list (JWT sub / identity_canonical_id missing)."
        )
    rows: list[dict[str, Any]] = []
    cursor: str | None = None
    while True:
        st, pl, raw = graphql_request(
            access_token=access_token,
            operation_name="FetchTradeAccountList",
            query=FETCH_TRADE_ACCOUNT_LIST,
            variables={"identityId": iid, "pageSize": 50, "cursor": cursor},
            oauth_bundle=oauth_bundle,
        )
        if st == 401:
            raise RuntimeError(f"accounts GraphQL HTTP {st}")
        if not isinstance(pl, dict):
            raise RuntimeError(f"accounts GraphQL invalid response: {raw or pl!r}")
        errs = pl.get("errors")
        if errs:
            raise RuntimeError(f"accounts GraphQL errors: {errs}")
        data = pl.get("data")
        if not isinstance(data, dict):
            raise RuntimeError(f"accounts GraphQL missing data: {pl}")
        identity = data.get("identity")
        if not isinstance(identity, dict):
            raise RuntimeError(f"accounts GraphQL missing identity: {data}")
        acct_conn = identity.get("accounts")
        if not isinstance(acct_conn, dict):
            raise RuntimeError(f"accounts GraphQL missing accounts: {identity}")
        edges = acct_conn.get("edges")
        if not isinstance(edges, list):
            raise RuntimeError(f"accounts GraphQL missing edges: {acct_conn}")
        for edge in edges:
            if not isinstance(edge, dict):
                continue
            node = edge.get("node")
            if not isinstance(node, dict):
                continue
            if str(node.get("status") or "").lower() != "open":
                continue
            rows.append(_graphql_account_to_row(node))
        page = acct_conn.get("pageInfo")
        if not isinstance(page, dict) or not page.get("hasNextPage"):
            break
        end = page.get("endCursor")
        if not end:
            break
        cursor = str(end)
    return rows


def list_positions(
    access_token: str,
    account_id: str,
    oauth_bundle: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """
    List positions for a Trade account.

    Args:
        access_token: OAuth bearer token
        account_id: Wealthsimple Trade account id
        oauth_bundle: Optional OAuth bundle (not currently used, kept for interface compatibility)

    Returns:
        List of position dicts
    """
    aid = quote(str(account_id).strip(), safe="")
    status, body = _request("GET", f"/account/positions?account_id={aid}", access_token=access_token)
    if status == 200 and isinstance(body, dict):
        results = body.get("results")
        if isinstance(results, list):
            rows = [r for r in results if isinstance(r, dict)]
            if rows:
                return rows
    status2, body2 = _request("GET", "/account/positions", access_token=access_token)
    if status2 != 200 or not isinstance(body2, dict):
        raise RuntimeError(f"positions HTTP {status} / {status2}: {body} / {body2}")
    results2 = body2.get("results")
    if not isinstance(results2, list):
        raise RuntimeError(f"positions missing results: {body2}")
    needle = str(account_id).strip()
    return [r for r in results2 if isinstance(r, dict) and str(r.get("account_id", "")) == needle]


def _account_types_for_filter(user_type: str) -> tuple[str, ...]:
    u = user_type.strip().lower().replace("-", "_")
    if not u:
        raise ValueError("empty account type")
    if u in _ACCOUNT_TYPE_ALIASES:
        return _ACCOUNT_TYPE_ALIASES[u]
    if u.startswith("ca_"):
        return (u,)
    return (f"ca_{u}",)


def _is_trade_orderable_account(row: dict[str, Any]) -> bool:
    if not isinstance(row, dict):
        return False
    unified = str(row.get("unified_account_type") or "").strip().upper()
    if unified == "CASH":
        return False
    if bool(row.get("trade_custodian")):
        return True
    # Keep this permissive for known self-directed brokerage account types.
    return bool(str(row.get("account_type") or "").strip())


def pick_trade_account_id(
    access_token: str,
    *,
    explicit_account_id: str | None,
    account_type: str | None,
    account_index: int | None = None,
    oauth_bundle: dict[str, Any] | None = None,
    require_trade_orderable: bool = False,
) -> str:
    """
    Resolve which Trade account id to use for orders or positions.

    - explicit_account_id wins if set (must exist in the GraphQL account list).
    - Else if account_type is set (e.g. tfsa, rrsp), match exactly one account
      unless --account-index is provided.
    - Else if there is exactly one account, use it.
    - Else require the user to disambiguate (wsprobe accounts).
    """
    rows = list_accounts(access_token, oauth_bundle=oauth_bundle)
    if explicit_account_id and str(explicit_account_id).strip():
        aid = str(explicit_account_id).strip()
        row = next((r for r in rows if str(r.get("id")) == aid), None)
        if row is None:
            raise RuntimeError(
                f"No Trade account with id {aid!r}. Run: wsprobe accounts — ids come from that list."
            )
        if require_trade_orderable and not _is_trade_orderable_account(row):
            raise RuntimeError(
                f"Account {aid!r} is not orderable for stock/ETF trades in this flow "
                "(its custodian branch is not WS/TR). Choose a self-directed brokerage account "
                "from `wsprobe accounts` (for example TFSA/RRSP/non-registered)."
            )
        return aid

    if account_type and str(account_type).strip():
        raw_selector = str(account_type).strip()
        exact_id_match = next((r for r in rows if str(r.get("id") or "") == raw_selector), None)
        if exact_id_match is not None:
            rid = exact_id_match.get("id")
            if not rid:
                raise RuntimeError("Matched account missing id")
            return str(rid)
        acceptable = _account_types_for_filter(str(account_type))
        matches = [r for r in rows if str(r.get("account_type") or "") in acceptable]
        if require_trade_orderable:
            matches = [r for r in matches if _is_trade_orderable_account(r)]
        if account_index is not None:
            idx = int(account_index)
            if idx < 1:
                raise RuntimeError("--account-index must be >= 1")
            if idx > len(matches):
                raise RuntimeError(
                    f"--account-index {idx} is out of range for type {account_type!r}; "
                    f"found {len(matches)} match(es)."
                )
            rid = matches[idx - 1].get("id")
            if not rid:
                raise RuntimeError("Matched account missing id")
            return str(rid)
        if len(matches) != 1:
            found = [(r.get("id"), r.get("account_type")) for r in rows]
            raise RuntimeError(
                f"Expected exactly one account for type {account_type!r} "
                f"(matches {acceptable}); found {len(matches)}. Accounts: {found}. "
                "Use --account-id from `wsprobe accounts` or pass --account-index N."
            )
        rid = matches[0].get("id")
        if not rid:
            raise RuntimeError("Matched account missing id")
        return str(rid)

    if len(rows) == 1:
        r0 = rows[0]
        rid = r0.get("id")
        if not rid:
            raise RuntimeError("Account list entry missing id")
        if require_trade_orderable and not _is_trade_orderable_account(r0):
            raise RuntimeError(
                "Only one account is available and it is not orderable for stock/ETF trades in this flow "
                "(custodian branch is not WS/TR). Use a self-directed brokerage account id."
            )
        if r0.get("account_type") or r0.get("trade_custodian"):
            return str(rid)
        raise RuntimeError(
            "Only one open account was returned and it does not look like a Trade brokerage account "
            "(no mapped type and no WS/TR custodian). Use --account-id with a self-directed account id."
        )
    if account_index is not None:
        idx = int(account_index)
        if idx < 1:
            raise RuntimeError("--account-index must be >= 1")
        if idx > len(rows):
            raise RuntimeError(f"--account-index {idx} is out of range; found {len(rows)} account(s).")
        rid = rows[idx - 1].get("id")
        if not rid:
            raise RuntimeError("Selected account missing id")
        return str(rid)
    preview = [(r.get("id"), r.get("account_type")) for r in rows]
    raise RuntimeError(
        "You have multiple Trade accounts — choose one:\n"
        "  wsprobe accounts\n"
        "Then pass  --account-id <id>  or  --account-type tfsa|rrsp|resp|… [--account-index N]  "
        f"(accounts: {preview})"
    )


def get_security(access_token: str, security_id: str) -> dict[str, Any]:
    sid = security_id.strip()
    status, body = _request("GET", f"/securities/{sid}", access_token=access_token)
    if status == 404:
        # Fallback: fetch security info via GraphQL quotes
        gql_status, gql_body, _ = graphql_request(
            access_token=access_token,
            operation_name="FetchIntraDayChartQuotes",
            query=FETCH_SECURITY_QUOTES,
            variables={
                "id": sid,
                "date": None,
                "tradingSession": "OVERNIGHT",
                "currency": None,
                "period": "ONE_DAY",
            },
        )
        if gql_status == 200 and isinstance(gql_body, dict):
            sec_data = (gql_body.get("data") or {}).get("security") or {}
            if sec_data:
                bars = sec_data.get("chartBarQuotes") or []
                price = None
                for b in reversed(bars):
                    p = b.get("price")
                    if p is not None:
                        try:
                            price = float(p)
                        except (TypeError, ValueError):
                            pass
                        break
                return {"stock": {"symbol": None}, "quote": {"amount": price} if price else {}}
        return {"stock": {"symbol": None}, "quote": {}}
    if status != 200:
        _raise_trade_rest_unavailable(f"securities/{sid[:16]}…", status, body)
    if not isinstance(body, dict):
        raise RuntimeError(f"Unexpected security response: {body}")
    return body


def _is_crypto(security: dict[str, Any]) -> bool:
    st = (security.get("security_type") or "").lower()
    it = (security.get("investment_type") or "").lower()
    return st in ("cryptocurrency", "crypto") or "crypto" in it


def _order_id(order: dict[str, Any]) -> str:
    oid = order.get("order_id") or order.get("id")
    if not oid:
        raise RuntimeError(f"Order response missing order_id/id: {order}")
    return str(oid)


def get_order(access_token: str, order_id: str) -> dict[str, Any]:
    status, body = _request("GET", "/orders", access_token=access_token)
    if status != 200:
        raise RuntimeError(f"orders HTTP {status}: {body}")
    if not isinstance(body, dict):
        raise RuntimeError(f"Unexpected orders response: {body}")
    results = body.get("results")
    if not isinstance(results, list):
        raise RuntimeError(f"orders missing results: {body}")
    needle = order_id.strip()
    for row in results:
        if not isinstance(row, dict):
            continue
        rid = row.get("order_id") or row.get("id")
        if rid and str(rid) == needle:
            return row
    raise RuntimeError(f"Order {needle} not found in /orders response")


def wait_for_order_finalization(
    access_token: str,
    order_id: str,
    *,
    timeout_s: float = 30.0,
    poll_interval_s: float = 1.0,
) -> dict[str, Any]:
    deadline = time.monotonic() + max(timeout_s, 0.1)
    last_seen: dict[str, Any] | None = None
    while True:
        row = get_order(access_token, order_id)
        last_seen = row
        st = str(row.get("status") or "").strip().lower()
        if st not in _TRANSIENT_ORDER_STATUSES:
            return row
        if time.monotonic() >= deadline:
            break
        time.sleep(max(poll_interval_s, 0.1))
    raise RuntimeError(
        f"Order {order_id} did not finalize within {timeout_s:g}s (last status: {last_seen})"
    )


def place_market_buy(
    access_token: str,
    *,
    account_id: str,
    security_id: str,
    quantity: float,
    value: float | None = None,
    limit_price: float | None = None,
    finalize_timeout_s: float = 30.0,
) -> dict[str, Any]:
    """
    Place a buy order via GraphQL (whole shares for limit orders, fractional for market orders).

    Args:
        access_token: OAuth bearer token
        account_id: Wealthsimple Trade account id
        security_id: Wealthsimple security id (sec-s-...)
        quantity: Number of shares (whole shares required for limit orders)
        value: Dollar amount for fractional market orders (mutually exclusive with quantity when fractional)
        limit_price: Limit price per share (for limit orders; whole shares only)
        finalize_timeout_s: Seconds to wait for order finalization

    Returns:
        Order dict from GraphQL query
    """
    if quantity is not None and quantity <= 0:
        raise ValueError("quantity must be positive")
    if value is not None and value <= 0:
        raise ValueError("value must be positive")
    if limit_price is not None and limit_price <= 0:
        raise ValueError("limit_price must be positive")

    # Limit orders require whole shares
    if limit_price is not None:
        if quantity is None or quantity % 1 != 0:
            raise ValueError("Limit orders require whole shares only (quantity must be an integer)")
        if value is not None:
            raise ValueError("Limit orders cannot use dollar value (use --shares instead of --dollars)")

    aid = account_id.strip()
    sid = security_id.strip()
    if not aid or not sid:
        raise ValueError("account_id and security_id are required")

    external_id = f"order-{uuid.uuid4()}"

    # Determine execution type and order type
    if limit_price is not None:
        # Limit order: whole shares only
        exec_type = "REGULAR"
        order_type = "BUY_QUANTITY"
    elif quantity is not None and quantity % 1 == 0:
        # Whole share market order
        exec_type = "REGULAR"
        order_type = "BUY_QUANTITY"
    else:
        # Fractional market order (BUY_VALUE)
        exec_type = "FRACTIONAL"
        order_type = "BUY_VALUE"

    payload_amount: float | None = None

    if order_type == "BUY_VALUE":
        # Fetch current price for fractional orders
        st_q, pl_q, raw_q = graphql_request(
            access_token=access_token,
            operation_name="FetchIntraDayChartQuotes",
            query=FETCH_SECURITY_QUOTES,
            variables={
                "id": sid,
                "date": None,
                "tradingSession": "OVERNIGHT",
                "currency": None,
                "period": "ONE_DAY",
            },
        )
        if st_q != 200 or not isinstance(pl_q, dict):
            raise RuntimeError(f"FetchIntraDayChartQuotes HTTP {st_q}: {raw_q or pl_q}")
        if pl_q.get("errors"):
            raise RuntimeError(f"FetchIntraDayChartQuotes errors: {pl_q['errors']}")
        bars = (((pl_q.get("data") or {}).get("security") or {}).get("chartBarQuotes") or [])
        prices = []
        for b in bars:
            if isinstance(b, dict):
                p = b.get("price")
                try:
                    if p is not None:
                        prices.append(float(p))
                except (TypeError, ValueError):
                    pass
        if not prices:
            raise RuntimeError("No market price available for fractional BUY_VALUE conversion.")
        qty_for_calc = quantity if quantity is not None else (value if value is not None else 0)
        payload_amount = round(max(float(qty_for_calc) * prices[-1], 0.01), 2)
        if payload_amount <= 0:
            raise RuntimeError("Computed fractional order value is not positive.")

    input_payload: dict[str, Any] = {
        "canonicalAccountId": aid,
        "externalId": external_id,
        "executionType": exec_type,
        "orderType": order_type,
        "securityId": sid,
        "timeInForce": None if exec_type == "FRACTIONAL" else "DAY",
    }

    if limit_price is not None:
        input_payload["limitPrice"] = float(limit_price)
        input_payload["quantity"] = float(quantity)
    elif order_type == "BUY_VALUE":
        input_payload["value"] = payload_amount
    else:
        # Market order with whole shares
        input_payload["quantity"] = float(quantity)

    st, pl, raw = graphql_request(
        access_token=access_token,
        operation_name="SoOrdersOrderCreate",
        query=MUTATION_SO_ORDERS_ORDER_CREATE,
        variables={"input": input_payload},
    )
    if st != 200 or not isinstance(pl, dict):
        raise RuntimeError(f"SoOrdersOrderCreate HTTP {st}: {raw or pl}")
    if pl.get("errors"):
        raise RuntimeError(f"SoOrdersOrderCreate errors: {pl['errors']}")
    block = (pl.get("data") or {}).get("soOrdersCreateOrder")
    if not isinstance(block, dict):
        raise RuntimeError(f"SoOrdersOrderCreate missing response block: {pl}")
    create_errors = block.get("errors")
    if isinstance(create_errors, list) and create_errors:
        raise RuntimeError(f"SoOrdersOrderCreate rejected: {create_errors}")

    deadline = time.monotonic() + max(finalize_timeout_s, 0.1)
    last: dict[str, Any] | None = None
    while True:
        st2, pl2, raw2 = graphql_request(
            access_token=access_token,
            operation_name="FetchSoOrdersExtendedOrder",
            query=FETCH_SO_ORDERS_EXTENDED_ORDER,
            variables={"branchId": "TR", "externalId": external_id},
        )
        if st2 != 200 or not isinstance(pl2, dict):
            raise RuntimeError(f"FetchSoOrdersExtendedOrder HTTP {st2}: {raw2 or pl2}")
        if pl2.get("errors"):
            raise RuntimeError(f"FetchSoOrdersExtendedOrder errors: {pl2['errors']}")
        order = (pl2.get("data") or {}).get("soOrdersExtendedOrder")
        if isinstance(order, dict):
            last = order
            status = str(order.get("status") or "").lower().strip()
            if status and status not in _TRANSIENT_ORDER_STATUSES:
                return order
        if time.monotonic() >= deadline:
            break
        time.sleep(1.0)
    raise RuntimeError(
        f"Order {external_id} did not finalize within {finalize_timeout_s:g}s (last status: {last})"
    )


def place_market_sell(
    access_token: str,
    *,
    account_id: str,
    security_id: str,
    quantity: float,
    limit_price: float | None = None,
    finalize_timeout_s: float = 30.0,
) -> dict[str, Any]:
    """
    Sell via GraphQL SoOrdersOrderCreate mutation.

    Args:
        access_token: OAuth bearer token
        account_id: Wealthsimple Trade account id
        security_id: Wealthsimple security id (sec-s-...)
        quantity: Number of shares to sell
        limit_price: Limit price per share (optional; for limit orders)
        finalize_timeout_s: Seconds to wait for order finalization

    Returns:
        Order dict from GraphQL query
    """
    if quantity <= 0:
        raise ValueError("quantity must be positive")
    if limit_price is not None and limit_price <= 0:
        raise ValueError("limit_price must be positive")
    aid = account_id.strip()
    sid = security_id.strip()
    if not aid or not sid:
        raise ValueError("account_id and security_id are required")

    external_id = f"order-{uuid.uuid4()}"

    # Determine execution type based on quantity
    is_fractional = quantity % 1 != 0
    exec_type = "FRACTIONAL" if is_fractional else "REGULAR"

    # Build GraphQL mutation payload for sell
    input_payload: dict[str, Any] = {
        "canonicalAccountId": aid,
        "externalId": external_id,
        "executionType": exec_type,
        "orderType": "SELL_QUANTITY",
        "quantity": float(quantity),
        "securityId": sid,
    }
    if exec_type == "REGULAR":
        input_payload["timeInForce"] = "DAY"
    if limit_price is not None:
        input_payload["limitPrice"] = float(limit_price)

    st, pl, raw = graphql_request(
        access_token=access_token,
        operation_name="SoOrdersOrderCreate",
        query=MUTATION_SO_ORDERS_ORDER_CREATE,
        variables={"input": input_payload},
    )
    if st != 200 or not isinstance(pl, dict):
        raise RuntimeError(f"SoOrdersOrderCreate HTTP {st}: {raw or pl}")
    if pl.get("errors"):
        raise RuntimeError(f"SoOrdersOrderCreate errors: {pl['errors']}")
    block = (pl.get("data") or {}).get("soOrdersCreateOrder")
    if not isinstance(block, dict):
        raise RuntimeError(f"SoOrdersOrderCreate missing response block: {pl}")
    create_errors = block.get("errors")
    if isinstance(create_errors, list) and create_errors:
        raise RuntimeError(f"SoOrdersOrderCreate rejected: {create_errors}")

    deadline = time.monotonic() + max(finalize_timeout_s, 0.1)
    last: dict[str, Any] | None = None
    while True:
        st2, pl2, raw2 = graphql_request(
            access_token=access_token,
            operation_name="FetchSoOrdersExtendedOrder",
            query=FETCH_SO_ORDERS_EXTENDED_ORDER,
            variables={"branchId": "TR", "externalId": external_id},
        )
        if st2 != 200 or not isinstance(pl2, dict):
            raise RuntimeError(f"FetchSoOrdersExtendedOrder HTTP {st2}: {raw2 or pl2}")
        if pl2.get("errors"):
            raise RuntimeError(f"FetchSoOrdersExtendedOrder errors: {pl2['errors']}")
        order = (pl2.get("data") or {}).get("soOrdersExtendedOrder")
        if isinstance(order, dict):
            last = order
            status = str(order.get("status") or "").lower().strip()
            if status and status not in _TRANSIENT_ORDER_STATUSES:
                return order
        if time.monotonic() >= deadline:
            break
        time.sleep(1.0)
    raise RuntimeError(
        f"Order {external_id} did not finalize within {finalize_timeout_s:g}s (last status: {last})"
    )


# REST fallback (commented out - kept for reference in case needed)
# def place_market_sell_rest(
#     access_token: str,
#     *,
#     account_id: str,
#     security_id: str,
#     quantity: float,
#     limit_price: float | None = None,
#     finalize_timeout_s: float = 30.0,
# ) -> dict[str, Any]:
#     """POST /orders — market or limit sell on Wealthsimple Trade (direct REST - fallback)."""
#     if quantity <= 0:
#         raise ValueError("quantity must be positive")
#     if limit_price is not None and limit_price <= 0:
#         raise ValueError("limit_price must be positive")
#     aid = account_id.strip()
#     sid = security_id.strip()
#     if not aid or not sid:
#         raise ValueError("account_id and security_id are required")
#
#     details = get_security(access_token, sid)
#     crypto = _is_crypto(details)
#     quote = details.get("quote") if isinstance(details.get("quote"), dict) else {}
#     amount_raw = quote.get("amount") if isinstance(quote, dict) else None
#
#     # Determine order sub_type based on whether limit_price is provided
#     if limit_price is not None:
#         order_sub_type = "limit"
#         limit_price_value = float(limit_price)
#     else:
#         order_sub_type = "market"
#         if not crypto:
#             if amount_raw is None:
#                 raise RuntimeError(
#                     "No quote.amount on security; cannot build market sell. "
#                     "Check security id or try again when quotes are available."
#                 )
#             limit_price_value = float(amount_raw)
#         else:
#             limit_price_value = None
#
#     body: dict[str, Any] = {
#         "account_id": aid,
#         "security_id": sid,
#         "quantity": float(quantity),
#         "order_type": "sell_quantity",
#         "order_sub_type": order_sub_type,
#         "time_in_force": "day",
#     }
#     if limit_price_value is not None:
#         body["limit_price"] = limit_price_value
#
#     status, resp = _request("POST", "/orders", access_token=access_token, json_body=body)
#     if status not in (200, 201):
#         _raise_trade_rest_unavailable("orders", status, resp)
#     if not isinstance(resp, dict):
#         raise RuntimeError(f"Unexpected order response: {resp}")
#     return wait_for_order_finalization(
#         access_token,
#         _order_id(resp),
#         timeout_s=finalize_timeout_s,
#     )


def format_money(m: Any) -> str:
    if not isinstance(m, dict):
        return "—"
    amt = m.get("amount")
    cur = m.get("currency") or ""
    if amt is None:
        return "—"
    try:
        return f"{float(amt):,.4f} {cur}".strip()
    except (TypeError, ValueError):
        return f"{amt} {cur}".strip()
