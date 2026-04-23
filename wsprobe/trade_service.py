"""Wealthsimple Trade REST (https://trade-service.wealthsimple.com).

Uses the same OAuth bearer token as GraphQL. These calls go **directly** to
Wealthsimple Trade — not SnapTrade, not a third-party broker API.
"""

from __future__ import annotations

import json
import ssl
import time
import urllib.error
import urllib.request
from typing import Any
from urllib.parse import quote

TRADE_SERVICE_BASE = "https://trade-service.wealthsimple.com"
_TRANSIENT_ORDER_STATUSES = {"", "new", "pending", "queued", "accepted", "open", "submitted", "in_progress"}

# CLI --account-type aliases → Wealthsimple account_type values (from /account/list).
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
    if status != 200:
        raise RuntimeError(f"securities?query= HTTP {status}: {body}")
    if not isinstance(body, dict):
        raise RuntimeError(f"Unexpected securities search response: {body}")
    results = body.get("results")
    if not isinstance(results, list):
        raise RuntimeError(f"securities search missing results: {body}")
    return [r for r in results if isinstance(r, dict)]


def symbol_to_security_id(access_token: str, symbol: str) -> str:
    sym = symbol.strip().upper()
    if not sym:
        raise ValueError("symbol is empty")
    rows = search_securities(access_token, sym)
    if not rows:
        raise RuntimeError(f"No security found for {symbol!r}. Try the full ticker (e.g. VFV.TO).")
    for r in rows:
        stock = r.get("stock") if isinstance(r.get("stock"), dict) else {}
        rsym = (stock.get("symbol") or "").strip().upper()
        if rsym == sym:
            rid = r.get("id")
            if rid:
                return str(rid)
    rid = rows[0].get("id")
    if rid:
        return str(rid)
    raise RuntimeError("Search returned entries without id")


def list_accounts(access_token: str) -> list[dict[str, Any]]:
    status, body = _request("GET", "/account/list", access_token=access_token)
    if status != 200:
        raise RuntimeError(f"account/list HTTP {status}: {body}")
    if not isinstance(body, dict):
        raise RuntimeError(f"Unexpected account/list response: {body}")
    results = body.get("results")
    if not isinstance(results, list):
        raise RuntimeError(f"account/list missing results: {body}")
    return [r for r in results if isinstance(r, dict)]


def list_positions(access_token: str, account_id: str) -> list[dict[str, Any]]:
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


def pick_trade_account_id(
    access_token: str,
    *,
    explicit_account_id: str | None,
    account_type: str | None,
) -> str:
    """
    Resolve which Trade account id to use for orders or positions.

    - explicit_account_id wins if set (must exist in /account/list).
    - Else if account_type is set (e.g. tfsa, rrsp), match exactly one account.
    - Else if there is exactly one account, use it.
    - Else require the user to disambiguate (wsprobe accounts).
    """
    rows = list_accounts(access_token)
    if explicit_account_id and str(explicit_account_id).strip():
        aid = str(explicit_account_id).strip()
        if not any(str(r.get("id")) == aid for r in rows):
            raise RuntimeError(
                f"No Trade account with id {aid!r}. Run: wsprobe accounts — ids come from that list."
            )
        return aid

    if account_type and str(account_type).strip():
        acceptable = _account_types_for_filter(str(account_type))
        matches = [r for r in rows if str(r.get("account_type") or "") in acceptable]
        if len(matches) != 1:
            found = [(r.get("id"), r.get("account_type")) for r in rows]
            raise RuntimeError(
                f"Expected exactly one account for type {account_type!r} "
                f"(matches {acceptable}); found {len(matches)}. Accounts: {found}. "
                "Use --account-id from `wsprobe accounts` or a more specific --account-type."
            )
        rid = matches[0].get("id")
        if not rid:
            raise RuntimeError("Matched account missing id")
        return str(rid)

    if len(rows) == 1:
        rid = rows[0].get("id")
        if rid:
            return str(rid)
        raise RuntimeError("Account list entry missing id")
    preview = [(r.get("id"), r.get("account_type")) for r in rows]
    raise RuntimeError(
        "You have multiple Trade accounts — choose one:\n"
        "  wsprobe accounts\n"
        "Then pass  --account-id <id>  or  --account-type tfsa|rrsp|resp|…  "
        f"(accounts: {preview})"
    )


def get_security(access_token: str, security_id: str) -> dict[str, Any]:
    sid = security_id.strip()
    status, body = _request("GET", f"/securities/{sid}", access_token=access_token)
    if status != 200:
        raise RuntimeError(f"securities/{sid[:16]}… HTTP {status}: {body}")
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
    finalize_timeout_s: float = 30.0,
) -> dict[str, Any]:
    """
    POST /orders — market buy on Wealthsimple Trade (direct REST).

    For equities, includes limit_price from live quote (required by WS for market buys).
    """
    if quantity <= 0:
        raise ValueError("quantity must be positive")
    aid = account_id.strip()
    sid = security_id.strip()
    if not aid or not sid:
        raise ValueError("account_id and security_id are required")

    details = get_security(access_token, sid)
    crypto = _is_crypto(details)
    quote = details.get("quote") if isinstance(details.get("quote"), dict) else {}
    amount_raw = quote.get("amount") if isinstance(quote, dict) else None

    body: dict[str, Any] = {
        "account_id": aid,
        "security_id": sid,
        "quantity": float(quantity),
        "order_type": "buy_quantity",
        "order_sub_type": "market",
        "time_in_force": "day",
    }
    if not crypto:
        if amount_raw is None:
            raise RuntimeError(
                "No quote.amount on security; cannot build market buy. "
                "Check security id or try again when quotes are available."
            )
        body["limit_price"] = float(amount_raw)

    status, resp = _request("POST", "/orders", access_token=access_token, json_body=body)
    if status not in (200, 201):
        raise RuntimeError(f"orders HTTP {status}: {resp}")
    if not isinstance(resp, dict):
        raise RuntimeError(f"Unexpected order response: {resp}")
    return wait_for_order_finalization(
        access_token,
        _order_id(resp),
        timeout_s=finalize_timeout_s,
    )


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
