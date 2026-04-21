"""Wealthsimple Trade REST (trade-service.wealthsimple.com) — same session token as GraphQL."""

from __future__ import annotations

import json
import ssl
import time
import urllib.error
import urllib.request
from typing import Any, List, Optional, Tuple
from urllib.parse import quote

TRADE_SERVICE_BASE = "https://trade-service.wealthsimple.com"
_TRANSIENT_ORDER_STATUSES = {"", "new", "pending", "queued", "accepted", "open", "submitted", "in_progress"}


def _request(
    method: str,
    path: str,
    *,
    access_token: str,
    json_body: Optional[dict[str, Any]] = None,
    timeout_s: float = 45.0,
) -> Tuple[int, Any]:
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
    data: Optional[bytes] = None
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


def search_securities(access_token: str, query: str) -> List[dict[str, Any]]:
    """GET /securities?query=… — ticker search (e.g. AAPL, VFV.TO)."""
    q = quote(query.strip(), safe="")
    status, body = _request("GET", f"/securities?query={q}", access_token=access_token)
    if status != 200:
        raise RuntimeError(f"securities?query= HTTP {status}: {body}")
    if not isinstance(body, dict):
        raise RuntimeError(f"Unexpected securities search response: {body}")
    results = body.get("results")
    if not isinstance(results, list):
        raise RuntimeError(f"securities search missing results: {body}")
    out: List[dict[str, Any]] = []
    for r in results:
        if isinstance(r, dict):
            out.append(r)
    return out


def symbol_to_security_id(access_token: str, symbol: str) -> str:
    """Resolve a ticker to sec-s-… using Trade search; prefers exact symbol match."""
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


def pick_account_id(access_token: str, explicit: Optional[str]) -> str:
    """Use explicit account id, or the only linked account if there is exactly one."""
    if explicit and str(explicit).strip():
        return str(explicit).strip()
    rows = list_accounts(access_token)
    if not rows:
        raise RuntimeError("No Trade accounts found for this login.")
    if len(rows) == 1:
        rid = rows[0].get("id")
        if rid:
            return str(rid)
        raise RuntimeError("Account list entry missing id")
    raise RuntimeError(
        "You have multiple Trade accounts — add --account-id <id> (run: wsprobe trade-accounts)"
    )


def list_accounts(access_token: str) -> list[dict[str, Any]]:
    status, body = _request("GET", "/account/list", access_token=access_token)
    if status != 200:
        raise RuntimeError(f"account/list HTTP {status}: {body}")
    if not isinstance(body, dict):
        raise RuntimeError(f"Unexpected account/list response: {body}")
    results = body.get("results")
    if not isinstance(results, list):
        raise RuntimeError(f"account/list missing results: {body}")
    return results


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
    if st in ("cryptocurrency", "crypto") or "crypto" in it:
        return True
    return False


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
        status = str(row.get("status") or "").strip().lower()
        if status not in _TRANSIENT_ORDER_STATUSES:
            return row
        if time.monotonic() >= deadline:
            break
        time.sleep(max(poll_interval_s, 0.1))
    raise RuntimeError(f"Order {order_id} did not finalize within {timeout_s:g}s (last status: {last_seen})")


def place_market_buy(
    access_token: str,
    *,
    account_id: str,
    security_id: str,
    quantity: float,
    finalize_timeout_s: float = 30.0,
) -> dict[str, Any]:
    """
    POST /orders — market buy (same field names as wstrade-api / MarkGalloway API.md).
    For equities, includes limit_price from live quote (required by WS trade backend for market buys).
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
