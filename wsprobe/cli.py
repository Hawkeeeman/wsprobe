from __future__ import annotations

import argparse
import sys
from typing import Any

from wsprobe import __version__
from wsprobe.client import format_json, graphql_request, identity_id_from_token
from wsprobe.credentials import (
    CONFIG_FILE,
    ensure_fresh_access_token,
    load_oauth_bundle,
    resolve_access_token,
    resolve_access_token_force_refresh,
)
from wsprobe.queries import (
    FETCH_IDENTITY_PACKAGES,
    FETCH_SECURITY,
    FETCH_SECURITY_QUOTES,
    FETCH_SO_ORDERS_LIMIT_ORDER_RESTRICTIONS,
)


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


def run_ping_with_token(token: str, args: argparse.Namespace) -> int:
    sub = identity_id_from_token(token)
    if not sub:
        raise SystemExit("Could not read identity id from token")

    status, payload, raw = graphql_request(
        access_token=token,
        operation_name="FetchIdentityPackages",
        query=FETCH_IDENTITY_PACKAGES,
        variables={"id": sub},
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
    injected_token = getattr(args, "access_token", None)
    token = str(injected_token) if injected_token else resolve_access_token(args)
    status, payload, raw = graphql_request(
        access_token=token,
        operation_name=operation_name,
        query=query,
        variables=variables,
    )
    if status == 401:
        refreshed = resolve_access_token_force_refresh(args)
        status, payload, raw = graphql_request(
            access_token=refreshed,
            operation_name=operation_name,
            query=query,
            variables=variables,
        )
    return status, payload, raw


def cmd_easy(args: argparse.Namespace) -> int:
    """Auto-find cookies, then connectivity check — minimal thinking."""
    bundle, persist, src = load_oauth_bundle(args)
    if not args.json and src.startswith("browser:"):
        print(f"Using cookies from: {src.split(':', 1)[1]}", file=sys.stderr)
    token = ensure_fresh_access_token(bundle, persist_path=persist)
    return run_ping_with_token(token, args)


def cmd_ping(args: argparse.Namespace) -> int:
    return run_ping_with_token(resolve_access_token(args), args)


def cmd_security(args: argparse.Namespace) -> int:
    sid = args.security_id.strip()
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
                "securityId": args.security_id.strip(),
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


def cmd_preview_buy(args: argparse.Namespace) -> int:
    """
    Buy-intent preview: read-only GraphQL only. Never submits or finalizes an order
    (mutations are blocked in the HTTP client).
    """
    sid = args.security_id.strip()
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
        variables={"securityId": sid, "currency": None},
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

    if args.json:
        out = {
            "preview_only": True,
            "no_submit": True,
            "http": {"security": st_a, "restrictions": st_b},
            "graphql": {"security": pl_a, "restrictions": pl_b},
            "intent": intent,
        }
        print(format_json(out))
        return 0 if st_a == 200 and st_b == 200 and not err_a and not err_b else 1

    print("=" * 64, file=sys.stderr)
    print(" PREVIEW ONLY — no order submitted or finalized", file=sys.stderr)
    print(" (wsprobe only sends GraphQL queries; mutations are blocked)", file=sys.stderr)
    print("=" * 64, file=sys.stderr)
    print()
    print("Intent")
    print(f"  Side:        BUY")
    print(f"  Order type:  {order.upper()}" + (f" @ {limit_px:g}" if order == "limit" and limit_px else ""))
    print(f"  Shares:      {shares:g}")
    print(f"  Security id: {sid}")
    if sym:
        print(f"  Symbol:      {sym}")
    if assume is not None:
        approx = assume * shares
        print()
        print("Rough notional (your --assume-price × shares; informational only)")
        print(f"  ~ ${approx:,.2f}  (assumed ${assume:g} × {shares:g} sh)")

    print()
    print("Eligibility / security (API)")
    if sec:
        print(format_json(sec))
    else:
        print("(no security data)")

    print()
    print("Limit-order restrictions (API)")
    if rest:
        print(format_json(rest))
    else:
        print("(no restrictions data)")

    if err_a or err_b:
        print()
        print("GraphQL errors:", file=sys.stderr)
        if err_a:
            print(format_json(err_a), file=sys.stderr)
        if err_b:
            print(format_json(err_b), file=sys.stderr)
        return 1

    print()
    print("Place any real trade in the official Wealthsimple app or website.", file=sys.stderr)
    return 0


def cmd_buy(args: argparse.Namespace) -> int:
    """Real market buy via Wealthsimple Trade REST (trade-service), using the same OAuth token as GraphQL."""
    if not getattr(args, "confirm", False):
        print(
            "This places a REAL market BUY on Wealthsimple Trade (trade-service.wealthsimple.com).\n"
            "Uses the same session as wsprobe GraphQL (browser cookies / WEALTHSIMPLE_ACCESS_TOKEN + optional refresh).\n"
            "Easiest: wsprobe buy --symbol VFV.TO --shares 1 --confirm   (one account only; else add --account-id)\n"
            "Or: wsprobe buy --security-id sec-s-… --shares 1 --confirm\n",
            file=sys.stderr,
        )
        return 1
    try:
        from wsprobe.trade_service import pick_account_id, place_market_buy as ws_place, symbol_to_security_id

        def _submit_with_token(token: str) -> dict[str, Any]:
            account_id = pick_account_id(token, getattr(args, "account_id", None))
            sym_arg = getattr(args, "symbol", None)
            if sym_arg and str(sym_arg).strip():
                security_id = symbol_to_security_id(token, str(sym_arg).strip())
            else:
                security_id = str(args.security_id).strip()
            return ws_place(
                token,
                account_id=account_id,
                security_id=security_id,
                quantity=float(args.shares),
            )

        token = resolve_access_token(args)
        try:
            out = _submit_with_token(token)
        except RuntimeError as e:
            if "HTTP 401" not in str(e):
                raise
            refreshed = resolve_access_token_force_refresh(args)
            out = _submit_with_token(refreshed)
    except Exception as e:
        print(str(e), file=sys.stderr)
        return 1
    if args.json:
        print(format_json({"ok": True, "order": out}))
    else:
        print("Order submitted (Wealthsimple Trade). Response:", file=sys.stderr)
        print(format_json(out))
    return 0


def cmd_snaptrade_buy(args: argparse.Namespace) -> int:
    """Market buy via SnapTrade (optional; separate from direct Wealthsimple session)."""
    if not getattr(args, "confirm", False):
        print(
            "Places a REAL market BUY via SnapTrade. Needs: pip install 'wsprobe[trade]' and SNAPTRADE_* env.\n"
            "Example: wsprobe snaptrade-buy HOD.TO 2 --confirm\n",
            file=sys.stderr,
        )
        return 1
    try:
        from wsprobe.snaptrade_buy import format_order_result, place_market_buy

        out = place_market_buy(
            args.symbol,
            float(args.units),
            account_id=getattr(args, "account_id", None),
        )
    except ImportError as e:
        print(str(e), file=sys.stderr)
        return 1
    except Exception as e:
        print(str(e), file=sys.stderr)
        return 1
    if args.json:
        print(format_json({"ok": True, "order": out}))
    else:
        print("Order submitted (SnapTrade). Response:", file=sys.stderr)
        print(format_order_result(out))
    return 0


def cmd_trade_accounts(args: argparse.Namespace) -> int:
    """List Trade account ids (GET /account/list)."""
    try:
        from wsprobe.trade_service import list_accounts

        token = resolve_access_token(args)
        try:
            rows = list_accounts(token)
        except RuntimeError as e:
            if "HTTP 401" not in str(e):
                raise
            refreshed = resolve_access_token_force_refresh(args)
            rows = list_accounts(refreshed)
    except Exception as e:
        print(str(e), file=sys.stderr)
        return 1
    if args.json:
        print(format_json({"accounts": rows}))
        return 0
    for a in rows:
        if not isinstance(a, dict):
            continue
        aid = a.get("id", "")
        atype = a.get("account_type", "")
        cur = (a.get("base_currency") or "") if isinstance(a.get("base_currency"), str) else ""
        print(f"{aid}\t{atype}\t{cur}".strip())
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="wsprobe",
        description=(
            "Wealthsimple GraphQL (read-only) + Trade REST buys. "
            "GraphQL mutations stay blocked; real buys use trade-service (wsprobe buy) with your OAuth token. "
            "Easiest check: run wsprobe with no arguments — it tries common browsers for you."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Easiest flow:\n"
            "  1) pip install (see install-wsprobe.sh in repo)\n"
            "  2) Log in at my.wealthsimple.com, then quit the browser\n"
            "  3) Run:  wsprobe\n"
            "\n"
            "More:\n"
            "  %(prog)s easy              same as bare %(prog)s\n"
            "  %(prog)s --cookies-from-browser firefox ping\n"
            "  %(prog)s --cookies-from-browser chrome security sec-s-…\n"
            "  %(prog)s preview-buy sec-s-… --shares 1 --order market --assume-price 264\n"
            "  %(prog)s trade-accounts            list account ids (Trade REST)\n"
            "  %(prog)s buy --symbol VFV.TO --shares 1 --confirm   market buy (easiest; one account)\n"
            "  %(prog)s snaptrade-buy HOD.TO 1 --confirm   buy via SnapTrade (optional)\n"
        ),
    )
    p.add_argument(
        "--version",
        action="version",
        version=f"%(prog)s {__version__}",
    )
    p.add_argument(
        "--cookies-from-browser",
        dest="cookies_browser",
        metavar="BROWSER",
        help=(
            "Use this browser's cookie store (chrome, firefox, edge, opera, opera_gx, brave, safari, vivaldi). "
            "Quit the browser before running if cookie read fails."
        ),
    )
    p.add_argument(
        "--token-file",
        metavar="PATH",
        help='JSON file with access_token (optional refresh_token for auto-refresh)',
    )
    p.add_argument(
        "--json",
        action="store_true",
        help="Print wrapped JSON where applicable",
    )

    sub = p.add_subparsers(dest="command")

    sp = sub.add_parser(
        "easy",
        help="Auto-detect browser cookies + connectivity check (default if you type nothing)",
    )
    sp.set_defaults(func=cmd_easy)

    sp = sub.add_parser(
        "ping",
        help="Connectivity check (identity packages)",
    )
    sp.set_defaults(func=cmd_ping)

    sp = sub.add_parser(
        "security",
        help="Security details by id (sec-s-… from the app URL)",
    )
    sp.add_argument("security_id", help="Wealthsimple security id")
    sp.set_defaults(func=cmd_security)

    sp = sub.add_parser(
        "preview-buy",
        help="Buy-intent preview (queries only; does not submit or finalize an order)",
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
        "trade-accounts",
        help="List Wealthsimple Trade account ids (uses OAuth token from cookies/env)",
    )
    sp.set_defaults(func=cmd_trade_accounts)

    sp = sub.add_parser(
        "buy",
        help="REAL market buy via Wealthsimple Trade REST (same OAuth token as GraphQL)",
    )
    sp.add_argument(
        "--account-id",
        default=None,
        metavar="ID",
        help="Trade account id (optional if you only have one account; else see trade-accounts)",
    )
    buy_target = sp.add_mutually_exclusive_group(required=True)
    buy_target.add_argument(
        "--symbol",
        metavar="TICKER",
        help="Stock/ETF ticker to search (e.g. VFV.TO, AAPL)",
    )
    buy_target.add_argument(
        "--security-id",
        metavar="ID",
        help="Security id sec-s-… (if you already copied it from the app URL)",
    )
    sp.add_argument(
        "--shares",
        type=float,
        required=True,
        metavar="N",
        help="Share quantity",
    )
    sp.add_argument(
        "--confirm",
        action="store_true",
        help="Required: acknowledge this submits a real order",
    )
    sp.set_defaults(func=cmd_buy)

    sp = sub.add_parser(
        "snaptrade-buy",
        help="REAL market buy via SnapTrade (optional; needs pip install wsprobe[trade])",
    )
    sp.add_argument("symbol", help='Ticker, e.g. NVDA or HOD.TO')
    sp.add_argument(
        "units",
        nargs="?",
        type=float,
        default=1.0,
        help="Number of shares/units (default: 1)",
    )
    sp.add_argument(
        "--confirm",
        action="store_true",
        help="Required: acknowledge this submits a real order via SnapTrade",
    )
    sp.add_argument(
        "--account-id",
        default=None,
        metavar="ID",
        help="SnapTrade account id (default: SNAPTRADE_ACCOUNT_ID or first linked account)",
    )
    sp.set_defaults(func=cmd_snaptrade_buy)

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
