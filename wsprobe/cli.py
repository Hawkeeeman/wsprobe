from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.parse import unquote

from wsprobe import __version__
from wsprobe.client import (
    format_json,
    graphql_request,
    identity_id_for_graphql,
)
from wsprobe.oauth_refresh import access_token_needs_refresh, jwt_exp_unix
from wsprobe.credentials import (
    CONFIG_FILE,
    SESSION_FILE,
    _persist_bundle,
    ensure_fresh_access_token,
    load_oauth_bundle,
    resolve_access_token,
    resolve_access_token_force_refresh,
)
from wsprobe.queries import (
    FETCH_IDENTITY_PACKAGES,
    FETCH_SECURITY,
    FETCH_SECURITY_QUOTES,
    FETCH_SECURITY_SEARCH,
    FETCH_SO_ORDERS_LIMIT_ORDER_RESTRICTIONS,
)

_PACKAGE_DIR = str(Path(__file__).resolve().parent)


def _cli_invocation_name() -> str:
    """`prog` for argparse: script basename, or "wsprobe" for -m / -c / odd argv0."""
    if not sys.argv:
        return "wsprobe"
    a0 = Path(sys.argv[0]).name
    if a0 in ("__main__.py", "-c", ""):
        return "wsprobe"
    return a0


def _print_result(payload: dict[str, Any], *, as_json: bool) -> None:
    if as_json:
        print(format_json(payload))
        return
    errs = payload.get("errors")
    data = payload.get("data")
    if errs:
        print("errors:", file=sys.stderr)
        print(format_json(errs), file=sys.stderr)
    if data is not None:
        print(format_json(data))


def run_ping_with_token(
    token: str,
    args: argparse.Namespace,
    *,
    oauth_bundle: dict[str, Any] | None = None,
) -> int:
    sub = identity_id_for_graphql(token, oauth_bundle)
    if not sub:
        # Check if token looks like a valid JWT (3 parts, starts with eyJ which is {" base64 encoded)
        if not token or len(token.split(".")) != 3 or not token.startswith("eyJ"):
            raise SystemExit(
                "Invalid or test token detected. "
                "Please log in at https://my.wealthsimple.com, then run wsprobe again."
            )
        raise SystemExit("Could not read identity id from token (token may be expired or malformed)")

    status, payload, raw = graphql_request(
        access_token=token,
        operation_name="FetchIdentityPackages",
        query=FETCH_IDENTITY_PACKAGES,
        variables={"id": sub},
        oauth_bundle=oauth_bundle,
    )
    if raw:
        print(raw, file=sys.stderr)
        return 1
    assert payload is not None
    if args.json:
        print(format_json({"http_status": status, "body": payload}))
    else:
        print(f"HTTP {status}")
        _print_result(payload, as_json=False)
    return 0 if status == 200 and not payload.get("errors") else 1


def _graphql_query_with_auth_retry(
    args: argparse.Namespace,
    *,
    operation_name: str,
    query: str,
    variables: dict[str, Any],
) -> tuple[int, dict[str, Any] | None, str | None]:
    bundle, persist, _src = load_oauth_bundle(args)
    injected_token = getattr(args, "access_token", None)
    if injected_token:
        token = str(injected_token)
    else:
        token = ensure_fresh_access_token(bundle, persist_path=persist)
    status, payload, raw = graphql_request(
        access_token=token,
        operation_name=operation_name,
        query=query,
        variables=variables,
        oauth_bundle=bundle,
    )
    if status == 401:
        refreshed = ensure_fresh_access_token(bundle, persist_path=persist, force_refresh=True)
        status, payload, raw = graphql_request(
            access_token=refreshed,
            operation_name=operation_name,
            query=query,
            variables=variables,
            oauth_bundle=bundle,
        )
    return status, payload, raw


def cmd_easy(args: argparse.Namespace) -> int:
    """Resolve saved/env credentials, then connectivity check."""
    bundle, persist, _src = load_oauth_bundle(args)
    token = ensure_fresh_access_token(bundle, persist_path=persist)
    return run_ping_with_token(token, args, oauth_bundle=bundle)


def cmd_ping(args: argparse.Namespace) -> int:
    bundle, persist, _ = load_oauth_bundle(args)
    token = ensure_fresh_access_token(bundle, persist_path=persist)
    return run_ping_with_token(token, args, oauth_bundle=bundle)


def cmd_security(args: argparse.Namespace) -> int:
    sid = _normalize_security_id(args.security_id)
    status, payload, raw = _graphql_query_with_auth_retry(
        args,
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
    if raw:
        print(raw, file=sys.stderr)
        return 1
    assert payload is not None
    if args.json:
        print(format_json({"http_status": status, "body": payload}))
    else:
        print(f"HTTP {status}")
        _print_result(payload, as_json=False)
    return 0 if status == 200 and not payload.get("errors") else 1


def cmd_restrictions(args: argparse.Namespace) -> int:
    side = args.side.upper()
    if side not in ("BUY", "SELL"):
        raise SystemExit("side must be BUY or SELL")
    status, payload, raw = _graphql_query_with_auth_retry(
        args,
        operation_name="FetchSoOrdersLimitOrderRestrictions",
        query=FETCH_SO_ORDERS_LIMIT_ORDER_RESTRICTIONS,
        variables={
            "args": {
                "securityId": _normalize_security_id(args.security_id),
                "side": side,
            }
        },
    )
    if raw:
        print(raw, file=sys.stderr)
        return 1
    assert payload is not None
    if args.json:
        print(format_json({"http_status": status, "body": payload}))
    else:
        print(f"HTTP {status}")
        _print_result(payload, as_json=False)
    return 0 if status == 200 and not payload.get("errors") else 1


def cmd_config_path(_: argparse.Namespace) -> int:
    print(str(CONFIG_FILE))
    return 0


def cmd_session_path(_: argparse.Namespace) -> int:
    """Where OAuth tokens are saved when not using env / --token-file."""
    print(str(SESSION_FILE))
    return 0


def _bundle_from_pasted_text(raw: str) -> dict[str, Any]:
    text = (raw or "").strip()
    if not text:
        raise SystemExit("No input received.")

    candidates: list[str] = [text]
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    if lines:
        candidates.append(lines[-1])

    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        candidates.append(text[start : end + 1])

    for cand in candidates:
        c = cand.strip()
        if not c:
            continue
        for payload in (c, unquote(c)):
            try:
                data = json.loads(payload)
            except json.JSONDecodeError:
                continue
            if isinstance(data, dict) and data.get("access_token"):
                return data

    raise SystemExit("Could not parse credentials JSON. Paste the console output JSON object.")


def _normalize_security_id(raw: str) -> str:
    val = (raw or "").strip()
    if not val:
        raise SystemExit("security_id is required (expected format: sec-s-...)")

    if "sec-s-" in val and not val.startswith("sec-s-"):
        start = val.find("sec-s-")
        end = len(val)
        for sep in ("?", "&", "#", "/", " "):
            idx = val.find(sep, start)
            if idx != -1:
                end = min(end, idx)
        val = val[start:end]

    if not val.startswith("sec-s-"):
        raise SystemExit(
            "Invalid security_id format. Expected a Wealthsimple security id like "
            "'sec-s-...'. Use `wsprobe lookup <ticker>` to find it."
        )
    return val


def _resolve_security_id_from_query(args: argparse.Namespace, query_text: str) -> str:
    q = (query_text or "").strip()
    if not q:
        raise SystemExit("security_id is required (expected sec-s-... or a ticker like GOOG)")

    status, payload, raw = _graphql_query_with_auth_retry(
        args,
        operation_name="FetchSecuritySearchResult",
        query=FETCH_SECURITY_SEARCH,
        variables={"query": q},
    )
    if raw:
        raise SystemExit(raw)
    if status != 200 or not isinstance(payload, dict):
        raise SystemExit(f"Security lookup failed (HTTP {status}).")
    if payload.get("errors"):
        raise SystemExit(format_json(payload.get("errors")))

    block = (payload.get("data") or {}).get("securitySearch")
    results = block.get("results") if isinstance(block, dict) else None
    if not isinstance(results, list) or not results:
        raise SystemExit(f"No security found for '{q}'.")

    q_upper = q.upper()
    exact_symbol = None
    for item in results:
        if not isinstance(item, dict):
            continue
        stock = item.get("stock")
        sym = stock.get("symbol") if isinstance(stock, dict) else None
        if isinstance(sym, str) and sym.upper() == q_upper:
            exact_symbol = item
            break

    chosen = exact_symbol if exact_symbol is not None else results[0]
    sid = chosen.get("id") if isinstance(chosen, dict) else None
    if not isinstance(sid, str) or not sid.startswith("sec-s-"):
        raise SystemExit(
            f"Could not resolve a valid security id for '{q}'. "
            "Run `wsprobe lookup <ticker>` and pass the sec-s-... id."
        )
    return sid


def _resolve_security_id_arg(args: argparse.Namespace, raw: str) -> str:
    try:
        return _normalize_security_id(raw)
    except SystemExit:
        return _resolve_security_id_from_query(args, raw)


def cmd_import_session(args: argparse.Namespace) -> int:
    """Write pasted credentials JSON to session.json."""
    path_arg = getattr(args, "import_session_file", None)
    if path_arg:
        raw = Path(path_arg).expanduser().read_text(encoding="utf-8")
    else:
        raw = sys.stdin.read()
    if not raw.strip():
        raise SystemExit("No JSON input (give a file path or pipe JSON on stdin)")
    data = _bundle_from_pasted_text(raw)
    _persist_bundle(SESSION_FILE, data)
    print(f"Saved credentials to {SESSION_FILE}", file=sys.stderr)
    return 0


def cmd_preview_buy(args: argparse.Namespace) -> int:
    """
    Read-only buy preflight using GraphQL queries only.
    Never submits, confirms, or finalizes an order.
    """
    sid = _resolve_security_id_arg(args, args.security_id)
    shares = float(args.shares)
    if shares <= 0:
        raise SystemExit("--shares must be positive")

    order = str(args.order).lower()
    if order == "limit" and args.limit_price is None:
        raise SystemExit("limit orders require --limit-price")
    if order == "market" and args.limit_price is not None:
        print("Note: --limit-price is ignored for market orders.", file=sys.stderr)
    limit_px = float(args.limit_price) if args.limit_price is not None else None
    if limit_px is not None and limit_px <= 0:
        raise SystemExit("--limit-price must be positive")

    assume = float(args.assume_price) if getattr(args, "assume_price", None) is not None else None

    st_a, pl_a, raw_a = _graphql_query_with_auth_retry(
        args,
        operation_name="FetchSecurity",
        query=FETCH_SECURITY,
        variables={"securityId": sid},
    )
    st_b, pl_b, raw_b = _graphql_query_with_auth_retry(
        args,
        operation_name="FetchSoOrdersLimitOrderRestrictions",
        query=FETCH_SO_ORDERS_LIMIT_ORDER_RESTRICTIONS,
        variables={"args": {"securityId": sid, "side": "BUY"}},
    )
    if raw_a or raw_b:
        print(raw_a or raw_b or "", file=sys.stderr)
        return 1
    assert pl_a is not None and pl_b is not None

    sec = (pl_a.get("data") or {}).get("security") if isinstance(pl_a, dict) else None
    rest = (pl_b.get("data") or {}).get("soOrdersLimitOrderRestrictions") if isinstance(pl_b, dict) else None
    err_a = pl_a.get("errors") if isinstance(pl_a, dict) else None
    err_b = pl_b.get("errors") if isinstance(pl_b, dict) else None

    stock = (sec or {}).get("stock") if isinstance(sec, dict) else None
    sym = (stock or {}).get("symbol") if isinstance(stock, dict) else None

    intent: dict[str, Any] = {
        "side": "BUY",
        "order_type": order.upper(),
        "shares": shares,
        "security_id": sid,
        "limit_price": limit_px,
        "assumed_price_per_share_usd": assume,
    }

    restrictions_unprocessable = bool(
        isinstance(err_b, list)
        and any(
            isinstance(e, dict)
            and isinstance(e.get("extensions"), dict)
            and e.get("extensions", {}).get("code") == "UNPROCESSABLE_ENTITY"
            for e in err_b
        )
    )
    restrictions_skipped = bool(restrictions_unprocessable and not rest)

    if args.json:
        ok_security = st_a == 200 and not err_a
        ok_restrictions = st_b == 200 and (not err_b or restrictions_skipped)
        ready = bool(ok_security and ok_restrictions)
        out = {
            "preview_only": True,
            "no_submit": True,
            "checked": {
                "security_quote_lookup": True,
                "buy_side_limit_restrictions": True,
            },
            "notes": {
                "restrictions_skipped": restrictions_skipped,
                "restrictions_skip_reason": (
                    "UNPROCESSABLE_ENTITY from restrictions endpoint"
                    if restrictions_skipped
                    else None
                ),
            },
            "result": {
                "security_ok": ok_security,
                "restrictions_ok": ok_restrictions,
                "ready_for_real_buy_command": ready,
            },
            "http": {"security": st_a, "restrictions": st_b},
            "graphql": {"security": pl_a, "restrictions": pl_b},
            "intent": intent,
        }
        print(format_json(out))
        return 0 if ready else 1

    print("=" * 68, file=sys.stderr)
    print(" PREVIEW MODE ONLY (READ-ONLY)", file=sys.stderr)
    print(" This command does NOT place a trade.", file=sys.stderr)
    print(" It only runs two GraphQL queries:", file=sys.stderr)
    print("   1) security + quote lookup", file=sys.stderr)
    print("   2) BUY-side limit-order restrictions lookup", file=sys.stderr)
    print("=" * 68, file=sys.stderr)
    print()
    print("Requested intent")
    print(f"  Side:            BUY")
    print(f"  Order type:      {order.upper()}" + (f" @ {limit_px:g}" if order == "limit" and limit_px else ""))
    print(f"  Shares:          {shares:g}")
    print(f"  Security id:     {sid}")
    if sym:
        print(f"  Symbol:          {sym}")
    if assume is not None:
        approx = assume * shares
        print()
        print("Rough notional (from your --assume-price; informational only)")
        print(f"  ~ ${approx:,.2f}  (assumed ${assume:g} × {shares:g} sh)")

    print()
    print("Check 1/2: security + quote")
    print(f"  HTTP status:     {st_a}")
    if err_a:
        print("  GraphQL errors:  yes")
    else:
        print("  GraphQL errors:  no")
    if sec:
        buyable = sec.get("buyable") if isinstance(sec, dict) else None
        eligible = sec.get("wsTradeEligible")
        if eligible is None and isinstance(sec, dict):
            eligible = sec.get("ws_trade_eligible")
        if buyable is not None:
            print(f"  buyable:         {buyable}")
        if eligible is not None:
            print(f"  ws_trade_eligible: {eligible}")
        print("  Raw payload:")
        print(format_json(sec))
    else:
        print("  (no security data)")

    print()
    print("Check 2/2: BUY-side limit-order restrictions")
    print(f"  HTTP status:     {st_b}")
    if err_b and not restrictions_skipped:
        print("  GraphQL errors:  yes")
    else:
        print("  GraphQL errors:  no")
        if restrictions_skipped:
            print("  note:            endpoint returned UNPROCESSABLE_ENTITY; skipping restrictions check")
    if rest:
        print("  Raw payload:")
        print(format_json(rest))
    else:
        print("  (no restrictions data)")

    blocking_err_b = bool(err_b) and not restrictions_skipped
    if err_a or blocking_err_b:
        print()
        print("Preview failed: GraphQL errors detected.", file=sys.stderr)
        if err_a:
            print(format_json(err_a), file=sys.stderr)
        if blocking_err_b:
            print(format_json(err_b), file=sys.stderr)
        return 1

    print()
    print("Preview complete: checks ran successfully.", file=sys.stderr)
    print("No order was submitted.", file=sys.stderr)
    print(
        "To place a real market buy (Wealthsimple Trade REST, not SnapTrade):",
        file=sys.stderr,
    )
    print(
        "  wsprobe buy --symbol TICKER --shares N --account-type tfsa --confirm",
        file=sys.stderr,
    )
    print("  wsprobe buy --security-id sec-s-… --shares N --account-id <id> --confirm", file=sys.stderr)
    print("List accounts:  wsprobe accounts", file=sys.stderr)
    return 0


def _trade_rest_call(args: argparse.Namespace, func: Callable[[str], Any]) -> Any:
    """Run func(access_token). Refresh once on HTTP 401 from Trade REST."""
    token = resolve_access_token(args)
    try:
        return func(token)
    except RuntimeError as e:
        if " 401" in str(e) or "HTTP 401" in str(e):
            token2 = resolve_access_token_force_refresh(args)
            return func(token2)
        raise


def cmd_accounts(args: argparse.Namespace) -> int:
    """List Trade accounts: balances and ids (for --account-id / --account-type)."""
    from wsprobe import trade_service as ts

    def work(token: str) -> list[dict[str, Any]]:
        return ts.list_accounts(token)

    try:
        rows = _trade_rest_call(args, work)
    except Exception as e:
        print(str(e), file=sys.stderr)
        return 1

    if args.json:
        print(format_json({"accounts": rows}))
        return 0

    if not rows:
        print("No Trade accounts returned.", file=sys.stderr)
        return 1

    print("Wealthsimple Trade accounts (from trade-service). Use an id with buy/positions.", file=sys.stderr)
    print()
    for r in rows:
        aid = r.get("id") or "—"
        raw_type = r.get("account_type") or "—"
        label = ts.account_type_display(str(raw_type) if raw_type != "—" else None)
        st = r.get("status") or "—"
        bp = ts.format_money(r.get("buying_power"))
        bal = ts.format_money(r.get("current_balance"))
        print(f"  {label} ({raw_type})")
        print(f"    account id:       {aid}")
        print(f"    status:           {st}")
        print(f"    buying power:     {bp}")
        print(f"    current balance:  {bal}")
        print()
    return 0


def cmd_positions(args: argparse.Namespace) -> int:
    """Open positions in one Trade account (holdings + quantities)."""
    from wsprobe import trade_service as ts

    def work(token: str) -> tuple[str, list[dict[str, Any]], list[dict[str, Any]]]:
        accts = ts.list_accounts(token)
        aid = ts.pick_trade_account_id(
            token,
            explicit_account_id=getattr(args, "account_id", None),
            account_type=getattr(args, "account_type", None),
        )
        pos = ts.list_positions(token, aid)
        return aid, pos, accts

    try:
        account_id, positions, accounts = _trade_rest_call(args, work)
    except Exception as e:
        print(str(e), file=sys.stderr)
        return 1

    acct = next((a for a in accounts if str(a.get("id")) == account_id), None)
    label = ts.account_type_display(str(acct.get("account_type")) if isinstance(acct, dict) else None)

    if args.json:
        print(
            format_json(
                {
                    "account_id": account_id,
                    "account_type": (acct or {}).get("account_type"),
                    "account_label": label,
                    "positions": positions,
                }
            )
        )
        return 0

    print(f"Positions — {label} — {account_id}", file=sys.stderr)
    print(f"Buying power: {ts.format_money((acct or {}).get('buying_power'))}", file=sys.stderr)
    print()
    if not positions:
        print("No open positions in this account.", file=sys.stderr)
        return 0

    sym_w = max(6, max(len(((p.get("stock") or {}) if isinstance(p.get("stock"), dict) else {}).get("symbol") or "") for p in positions))
    print(f"{'Symbol':{sym_w}}  Qty      Market value (if present)")
    for p in positions:
        st = (p.get("stock") or {}) if isinstance(p.get("stock"), dict) else {}
        sym = st.get("symbol") or "—"
        qty = p.get("quantity")
        mbv = ts.format_money(p.get("market_book_value"))
        print(f"{sym:{sym_w}}  {qty!s:7}  {mbv}")
    return 0


def cmd_portfolio(args: argparse.Namespace) -> int:
    """All Trade accounts: cash fields + every open position (where your money is)."""
    from wsprobe import trade_service as ts

    def work(token: str) -> list[dict[str, Any]]:
        accounts = ts.list_accounts(token)
        blocks: list[dict[str, Any]] = []
        for acc in accounts:
            aid = str(acc.get("id") or "").strip()
            if not aid:
                continue
            try:
                pos = ts.list_positions(token, aid)
            except RuntimeError:
                pos = []
            blocks.append({"account": acc, "positions": pos})
        return blocks

    try:
        blocks = _trade_rest_call(args, work)
    except Exception as e:
        print(str(e), file=sys.stderr)
        return 1

    if args.json:
        print(format_json({"portfolio": blocks}))
        return 0

    print("Portfolio (Wealthsimple Trade — cash + holdings per account)", file=sys.stderr)
    print()
    for block in blocks:
        acc = block["account"]
        positions = block["positions"]
        aid = acc.get("id")
        raw_type = acc.get("account_type")
        label = ts.account_type_display(str(raw_type) if raw_type else None)
        print(f"=== {label} ({raw_type}) ===")
        print(f"account id:        {aid}")
        print(f"buying power:      {ts.format_money(acc.get('buying_power'))}")
        print(f"current balance:   {ts.format_money(acc.get('current_balance'))}")
        print(f"net deposits:    {ts.format_money(acc.get('net_deposits'))}")
        print()
        if not positions:
            print("  (no positions)")
        else:
            sym_w = max(6, max(len(((p.get("stock") or {}) if isinstance(p.get("stock"), dict) else {}).get("symbol") or "") for p in positions))
            print(f"  {'Symbol':{sym_w}}  Qty      Market book value")
            for p in positions:
                st = (p.get("stock") or {}) if isinstance(p.get("stock"), dict) else {}
                sym = st.get("symbol") or "—"
                qty = p.get("quantity")
                mbv = ts.format_money(p.get("market_book_value"))
                print(f"  {sym:{sym_w}}  {qty!s:7}  {mbv}")
        print()
    return 0


def cmd_buy(args: argparse.Namespace) -> int:
    """
    Real market buy via Wealthsimple Trade REST (direct to trade-service).
    Not SnapTrade. Requires explicit --confirm.
    """
    from wsprobe import trade_service as ts

    sym = getattr(args, "buy_symbol", None)
    sec_id = getattr(args, "buy_security_id", None)
    has_sym = bool(sym and str(sym).strip())
    has_sec = bool(sec_id and str(sec_id).strip())
    if has_sym and has_sec:
        raise SystemExit("Use either --symbol or --security-id, not both.")
    if not has_sym and not has_sec:
        raise SystemExit("Provide --symbol TICKER or --security-id sec-s-…")

    if not args.confirm:
        print(
            "This submits a REAL market BUY to Wealthsimple Trade (trade-service.wealthsimple.com).\n"
            "It is a direct REST order — not SnapTrade, not GraphQL.\n"
            "Uses the same OAuth session as the rest of wsprobe (onboard / session.json).\n",
            file=sys.stderr,
        )
        print(
            "Choose the account (TFSA is common for long-term investing; not tax advice):\n"
            "  wsprobe accounts\n"
            "  wsprobe buy --symbol VFV.TO --shares 1 --account-type tfsa --confirm\n"
            "  wsprobe buy --security-id sec-s-… --shares 1 --account-id <id-from-accounts> --confirm\n",
            file=sys.stderr,
        )
        print("Preflight only (no order):  wsprobe preview-buy …", file=sys.stderr)
        return 1

    def submit(token: str) -> dict[str, Any]:
        account_id = ts.pick_trade_account_id(
            token,
            explicit_account_id=getattr(args, "buy_account_id", None),
            account_type=getattr(args, "buy_account_type", None),
        )
        if has_sym:
            security_id = ts.symbol_to_security_id(token, str(sym).strip())
        else:
            security_id = _normalize_security_id(str(sec_id).strip())
        return ts.place_market_buy(
            token,
            account_id=account_id,
            security_id=security_id,
            quantity=float(args.shares),
        )

    try:
        out = _trade_rest_call(args, submit)
    except Exception as e:
        print(str(e), file=sys.stderr)
        return 1

    if args.json:
        print(format_json({"ok": True, "order": out}))
    else:
        print("Order submitted to Wealthsimple Trade (direct REST). Final status:", file=sys.stderr)
        print(format_json(out))
    return 0


def _access_token_brief(access: str) -> dict[str, Any]:
    exp = jwt_exp_unix(access)
    brief: dict[str, Any] = {
        "needs_refresh_soon": access_token_needs_refresh(access),
    }
    if exp is not None:
        brief["expires_at_utc"] = datetime.fromtimestamp(exp, tz=timezone.utc).strftime(
            "%Y-%m-%d %H:%M:%S UTC"
        )
        brief["expires_at_unix"] = exp
    return brief


def cmd_lookup(args: argparse.Namespace) -> int:
    q = (getattr(args, "query", None) or "").strip()
    if not q:
        raise SystemExit("Enter a search string (ticker, name, or ISIN). Example:  wsprobe lookup AAPL")
    limit = int(getattr(args, "lookup_limit", 20))
    limit = max(1, min(limit, 50))

    status, payload, raw = _graphql_query_with_auth_retry(
        args,
        operation_name="FetchSecuritySearchResult",
        query=FETCH_SECURITY_SEARCH,
        variables={"query": q},
    )
    if raw:
        print(raw, file=sys.stderr)
        return 1
    assert payload is not None
    data = payload.get("data") if isinstance(payload, dict) else None
    err = payload.get("errors") if isinstance(payload, dict) else None
    block = (data or {}).get("securitySearch") if isinstance(data, dict) else None
    results: list[dict[str, Any]] = []
    if isinstance(block, dict) and block.get("results"):
        raw_results = block["results"]
        if isinstance(raw_results, list):
            for item in raw_results:
                if isinstance(item, dict):
                    results.append(item)
    results = results[:limit]

    if args.json:
        print(
            format_json(
                {
                    "http_status": status,
                    "query": q,
                    "errors": err,
                    "results": results,
                }
            )
        )
        if status != 200 or err:
            return 1
        return 0

    print(f"HTTP {status}", file=sys.stderr)
    if err:
        print("errors:", file=sys.stderr)
        print(format_json(err), file=sys.stderr)
        return 1

    if not results:
        print("No results (try a different search string).", file=sys.stderr)
        return 1

    q_upper = q.upper()
    for row in results:
        st = (row.get("stock") or {}) if isinstance(row.get("stock"), dict) else {}
        sym = (st.get("symbol") or "") or ""
        if sym.upper() == q_upper:
            row["_exact_symbol_match"] = True
    try:
        results.sort(
            key=lambda r: (not r.get("_exact_symbol_match", False), (r.get("stock") or {}).get("symbol") or ""),
        )
    except (TypeError, ValueError, AttributeError):
        pass
    for r in results:
        r.pop("_exact_symbol_match", None)

    name_w = max(len("Name"), max(len((x.get("stock") or {}).get("name") or "") for x in results))
    sym_w = max(len("Symbol"), max(len((x.get("stock") or {}).get("symbol") or "") for x in results))
    line = f"{'Symbol':{sym_w}}  {'Name':{name_w}}  Exchange  Security id"
    print(line)
    for row in results:
        st = (row.get("stock") or {}) if isinstance(row.get("stock"), dict) else {}
        sym = st.get("symbol") or "—"
        name = (st.get("name") or "")[:80] or "—"
        ex = st.get("primaryExchange") or "—"
        sid = row.get("id") or "—"
        print(f"{sym:{sym_w}}  {name:{name_w}}  {ex}  {sid}")
    print(
        "\nUse  wsprobe security <id>  or  wsprobe preview-buy <id> …  with a security id above. "
        "Balances and holdings:  wsprobe accounts  /  wsprobe portfolio"
    )
    return 0


def cmd_doctor(args: argparse.Namespace) -> int:
    import os as _os

    report: dict[str, Any] = {
        "wsprobe_version": __version__,
        "wprobe_no_refresh": _os.environ.get("WSPROBE_NO_REFRESH", "").strip().lower() in ("1", "true", "yes"),
    }
    try:
        bundle, persist, src = load_oauth_bundle(args)
    except SystemExit as e:
        report["ok"] = False
        report["credentials"] = {"error": str(e)}
        if args.json:
            print(format_json(report))
        else:
            print("wsprobe doctor", file=sys.stderr)
            print("  Credentials: failed —", e, file=sys.stderr)
        return 1

    path_label = str(persist) if persist is not None else None
    report["credentials"] = {
        "source": src,
        "persist_path": path_label,
        "has_refresh_token": bool((bundle.get("refresh_token") or "").strip()),
    }
    acc = str(bundle.get("access_token") or "")
    report["access_token"] = _access_token_brief(acc)

    token = ensure_fresh_access_token(bundle, persist_path=persist)
    sub = identity_id_for_graphql(token, bundle)
    if not sub:
        report["ok"] = False
        report["graphql_identity"] = {
            "ok": False,
            "detail": "Could not read identity id from token (expired, malformed, or missing claims).",
        }
        if args.json:
            print(format_json(report))
        else:
            _print_doctor_text(report, ok=False)
        return 1

    st, pl, raw = graphql_request(
        access_token=token,
        operation_name="FetchIdentityPackages",
        query=FETCH_IDENTITY_PACKAGES,
        variables={"id": sub},
        oauth_bundle=bundle,
    )
    if st == 401 and bundle.get("refresh_token"):
        token = ensure_fresh_access_token(bundle, persist_path=persist, force_refresh=True)
        st, pl, raw = graphql_request(
            access_token=token,
            operation_name="FetchIdentityPackages",
            query=FETCH_IDENTITY_PACKAGES,
            variables={"id": sub},
            oauth_bundle=bundle,
        )

    gq_ok = st == 200 and isinstance(pl, dict) and not pl.get("errors")
    report["graphql_identity"] = {
        "ok": gq_ok,
        "http_status": st,
        "graphql_errors": pl.get("errors") if isinstance(pl, dict) else None,
    }
    if raw:
        report["graphql_identity"]["raw"] = raw
    report["ok"] = bool(gq_ok)

    if args.json:
        print(format_json(report))
    else:
        _print_doctor_text(report, ok=bool(gq_ok))
    return 0 if gq_ok else 1


def _print_doctor_text(report: dict[str, Any], *, ok: bool) -> None:
    print("wsprobe doctor", file=sys.stderr)
    cred = report.get("credentials") or {}
    if cred.get("error"):
        print("  Credentials: failed —", cred["error"], file=sys.stderr)
        return
    print("  Credentials: ok —", cred.get("source"), file=sys.stderr)
    if cred.get("persist_path"):
        print("  Save tokens to:     ", cred["persist_path"], file=sys.stderr)
    print("  refresh_token:      ", "yes" if cred.get("has_refresh_token") else "no", file=sys.stderr)
    at = report.get("access_token") or {}
    if at.get("expires_at_utc"):
        print("  access JWT expires:", at["expires_at_utc"], file=sys.stderr)
    elif at:
        print("  access JWT:         (no exp claim in token)", file=sys.stderr)
    if at.get("needs_refresh_soon"):
        print("  note:              token is expired or expiring (refresh was applied if available)", file=sys.stderr)
    gq = report.get("graphql_identity") or {}
    if gq.get("ok"):
        print("  GraphQL identity:   HTTP 200, no errors", file=sys.stderr)
    else:
        print("  GraphQL identity:   failed (HTTP", gq.get("http_status"), ")", file=sys.stderr)
        if gq.get("graphql_errors"):
            print(format_json(gq["graphql_errors"]), file=sys.stderr)
    print(
        "All checks passed." if ok else "One or more checks failed.",
        file=sys.stderr,
    )


def cmd_export_session_snippet(args: argparse.Namespace) -> int:
    """Print JS for pasting into DevTools on my.wealthsimple.com to build session.json."""
    print(
        "Copy only the JavaScript below into the browser console (not this shell command).\n",
        file=sys.stderr,
    )
    base = Path(__file__).resolve().parent
    path = base / "export_session_console.js"
    sys.stdout.write(path.read_text(encoding="utf-8"))
    return 0


def cmd_onboard(args: argparse.Namespace) -> int:
    print(
        "Step 1: open https://my.wealthsimple.com and sign in.\n"
        "Step 2: paste this snippet into DevTools Console and run it.\n",
        file=sys.stderr,
    )
    cmd_export_session_snippet(args)
    print(
        "\n\nStep 3: paste the console output JSON below, then press Ctrl-D:\n",
        file=sys.stderr,
    )
    raw = sys.stdin.read()
    data = _bundle_from_pasted_text(raw)
    _persist_bundle(SESSION_FILE, data)
    print(f"Saved credentials to {SESSION_FILE}", file=sys.stderr)
    return 0


def cmd_snippet(args: argparse.Namespace) -> int:
    """Alias for onboard: print snippet, then wait for pasted JSON and save."""
    return cmd_onboard(args)



def build_parser(*, prog: str | None = None) -> argparse.ArgumentParser:
    inv = prog or _cli_invocation_name()
    p = argparse.ArgumentParser(
        prog=inv,
        description=(
            "Wealthsimple: read-only GraphQL (mutations blocked in this tool) plus Trade REST "
            "for accounts, positions, portfolio, and optional real market buys (direct to "
            "trade-service — not SnapTrade). If another program named wsprobe is on your PATH, "
            "use the wsp command (same install) or see --version for the package path."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Easiest flow:\n"
            "  1) pip install (see install-wsprobe.sh in repo)\n"
            "  2) Run:  wsprobe onboard\n"
            "  3) Paste snippet in browser console, then paste JSON back into terminal\n"
            "  4) Run:  wsp   or  wsprobe   (after  pip install -e .  in this project)\n"
            "\n"
            "More:\n"
            "  %(prog)s easy              same as bare %(prog)s\n"
            "  %(prog)s snippet           print snippet, wait for pasted JSON, save session\n"
            "  %(prog)s onboard           guided one-time credential import flow\n"
            "  %(prog)s lookup AAPL        resolve ticker/search text → security ids (sec-s-…)\n"
            "  %(prog)s doctor             credentials + GraphQL health (try this if auth fails)\n"
            "  %(prog)s accounts            Trade accounts (ids, TFSA/RRSP, buying power)\n"
            "  %(prog)s portfolio           all accounts: cash + holdings\n"
            "  %(prog)s positions --account-type tfsa   holdings in one account\n"
            "  %(prog)s preview-buy …       read-only buy checks (no order)\n"
            "  %(prog)s buy --symbol X --shares 1 --account-type tfsa --confirm   real market buy\n"
            "  %(prog)s export-session-snippet     print JS: paste on my.wealthsimple.com → session.json\n"
            "  %(prog)s session-path               print where session.json lives (~/.config/wsprobe/)\n"
            "  %(prog)s import-session tokens.json   save tokens to session.json (or stdin)\n"
            "  %(prog)s --access-token \"$JWT\" ping   use this JWT instead of browser/session file\n"
            "  export WEALTHSIMPLE_OAUTH_JSON='{\"access_token\":\"…\",\"refresh_token\":\"…\"}'   env bundle\n"
        ),
    )
    p.add_argument(
        "--version",
        action="version",
        version=f"%(prog)s {__version__}  [package: {_PACKAGE_DIR}]",
    )
    p.add_argument(
        "--token-file",
        metavar="PATH",
        help='JSON file with access_token (optional refresh_token for auto-refresh)',
    )
    p.add_argument(
        "--access-token",
        dest="access_token",
        metavar="JWT",
        help=(
            "Use this bearer JWT for this run (skips browser/session file). "
            "Optional refresh: --refresh-token or WEALTHSIMPLE_REFRESH_TOKEN. "
            "Or set WEALTHSIMPLE_OAUTH_JSON to a JSON object with access_token and optional refresh_token. "
            "Avoid passing secrets on the command line (shell history); prefer env or import-session."
        ),
    )
    p.add_argument(
        "--refresh-token",
        dest="refresh_token",
        metavar="TOKEN",
        default=None,
        help="Use with --access-token (overrides WEALTHSIMPLE_REFRESH_TOKEN for this run).",
    )
    p.add_argument(
        "--json",
        action="store_true",
        help="Print wrapped JSON where applicable",
    )

    sub = p.add_subparsers(dest="command")

    sp = sub.add_parser(
        "easy",
        help="Connectivity check using saved/env credentials (default if you type nothing)",
    )
    sp.set_defaults(func=cmd_easy)

    sp = sub.add_parser(
        "onboard",
        help="Guided setup: paste console snippet output and save credentials",
    )
    sp.set_defaults(func=cmd_onboard)

    sp = sub.add_parser(
        "snippet",
        help="Print snippet, then wait for pasted JSON and save credentials",
    )
    sp.set_defaults(func=cmd_snippet)

    sp = sub.add_parser(
        "ping",
        help="Connectivity check (identity packages)",
    )
    sp.set_defaults(func=cmd_ping)

    sp = sub.add_parser(
        "lookup",
        help="Search by ticker, name, or text → security ids (sec-s-…)",
    )
    sp.add_argument(
        "query",
        help="e.g. AAPL, company name, or other search text (same as the app search)",
    )
    sp.add_argument(
        "--limit",
        dest="lookup_limit",
        type=int,
        default=20,
        metavar="N",
        help="max rows to show (default: 20, max: 50)",
    )
    sp.set_defaults(func=cmd_lookup)

    sp = sub.add_parser(
        "doctor",
        help="Check credentials, token expiry hint, and GraphQL identity query",
    )
    sp.set_defaults(func=cmd_doctor)

    sp = sub.add_parser("status", help="Same as doctor")
    sp.set_defaults(func=cmd_doctor)

    sp = sub.add_parser(
        "security",
        help="Security details by id (sec-s-… from the app URL)",
    )
    sp.add_argument("security_id", help="Wealthsimple security id")
    sp.set_defaults(func=cmd_security)

    sp = sub.add_parser(
        "preview-buy",
        help="Read-only buy preflight (queries only; never submits an order)",
    )
    sp.add_argument("security_id", help="Wealthsimple security id, e.g. sec-s-…")
    sp.add_argument(
        "--shares",
        type=float,
        required=True,
        metavar="N",
        help="Share quantity (supports decimals if your account supports fractional)",
    )
    sp.add_argument(
        "--order",
        choices=("market", "limit"),
        default="market",
        help="market or limit (default: market)",
    )
    sp.add_argument(
        "--limit-price",
        type=float,
        default=None,
        metavar="USD",
        help="Required when --order limit",
    )
    sp.add_argument(
        "--assume-price",
        type=float,
        default=None,
        metavar="USD",
        help="Optional: last price per share to estimate notional (not from API)",
    )
    sp.set_defaults(func=cmd_preview_buy)

    sp = sub.add_parser(
        "accounts",
        help="List Trade accounts (ids, registered type, buying power, balances)",
    )
    sp.set_defaults(func=cmd_accounts)

    sp = sub.add_parser(
        "positions",
        help="Holdings in one Trade account (use --account-id or --account-type if you have several)",
    )
    sp.add_argument(
        "--account-id",
        dest="account_id",
        default=None,
        metavar="ID",
        help="Trade account id from wsprobe accounts (e.g. tfsa-…)",
    )
    sp.add_argument(
        "--account-type",
        dest="account_type",
        default=None,
        metavar="TYPE",
        help="Shorthand: tfsa, rrsp, resp, fhsa, joint, non_registered, … (exactly one account must match)",
    )
    sp.set_defaults(func=cmd_positions)

    sp = sub.add_parser(
        "portfolio",
        help="All Trade accounts: cash fields plus every open position",
    )
    sp.set_defaults(func=cmd_portfolio)

    sp = sub.add_parser(
        "buy",
        help="Place a real market BUY on Wealthsimple Trade (REST). Not SnapTrade. Requires --confirm",
        description=(
            "Submits a market buy to trade-service.wealthsimple.com using your saved session. "
            "Choose the account with --account-id (from wsprobe accounts) or --account-type tfsa|rrsp|… "
            "When you have only one Trade account, that account is used automatically."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sp.add_argument(
        "--symbol",
        "-s",
        dest="buy_symbol",
        default=None,
        metavar="TICKER",
        help="Ticker (e.g. VFV.TO); resolved via Trade search",
    )
    sp.add_argument(
        "--security-id",
        dest="buy_security_id",
        default=None,
        metavar="sec-s-…",
        help="Wealthsimple security id instead of --symbol",
    )
    sp.add_argument(
        "--shares",
        type=float,
        required=True,
        metavar="N",
        help="Share quantity (fractional if your account supports it)",
    )
    sp.add_argument(
        "--account-id",
        dest="buy_account_id",
        default=None,
        metavar="ID",
        help="Trade account id (from wsprobe accounts)",
    )
    sp.add_argument(
        "--account-type",
        dest="buy_account_type",
        default=None,
        metavar="TYPE",
        help="tfsa, rrsp, resp, fhsa, … — must match exactly one account",
    )
    sp.add_argument(
        "--confirm",
        action="store_true",
        help="Required to actually submit the order (safety latch)",
    )
    sp.set_defaults(func=cmd_buy)

    sp = sub.add_parser(
        "restrictions",
        help="Limit-order restriction thresholds (read-only)",
    )
    sp.add_argument(
        "--security-id",
        required=True,
        metavar="ID",
        help="Security id (sec-s-…)",
    )
    sp.add_argument(
        "--side",
        choices=("BUY", "SELL", "buy", "sell"),
        default="BUY",
        help="BUY or SELL (default: BUY)",
    )
    sp.set_defaults(func=cmd_restrictions)

    sp = sub.add_parser(
        "config-path",
        help="Print default config.json path",
    )
    sp.set_defaults(func=cmd_config_path)

    sp = sub.add_parser(
        "session-path",
        help="Print path to session.json (saved OAuth tokens)",
    )
    sp.set_defaults(func=cmd_session_path)

    sp = sub.add_parser(
        "import-session",
        help="Save JSON credentials to session.json (from file or stdin)",
        description=(
            "Reads JSON with access_token (and optional refresh_token, client_id) and merges into "
            + str(SESSION_FILE)
            + ". Example:  wsprobe import-session ~/tokens.json   or   pbpaste | wsprobe import-session"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sp.add_argument(
        "import_session_file",
        nargs="?",
        metavar="FILE",
        help="JSON file; omit to read JSON from stdin",
    )
    sp.set_defaults(func=cmd_import_session)

    sp = sub.add_parser(
        "export-session-snippet",
        help="Print console script: paste on my.wealthsimple.com to emit ~/.config/wsprobe/session.json",
    )
    sp.set_defaults(func=cmd_export_session_snippet)

    return p


def main(argv: list[str] | None = None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    if not argv:
        argv = ["easy"]

    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command is None or getattr(args, "func", None) is None:
        args.command = "easy"
        args.func = cmd_easy

    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
