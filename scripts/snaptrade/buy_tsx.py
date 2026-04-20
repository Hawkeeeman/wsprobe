#!/usr/bin/env python3
"""
Buy TSX (Wealthsimple) via SnapTrade test API.
Loads credentials from .env.secret; use test -n "$SNAPTRADE_CLIENT_ID" etc. to verify they are set.
"""
import os
import sys
from pathlib import Path

# Load .env.secret from repo root (same dir as this script's parent if run from repo)
def _load_secret_env():
    root = Path(__file__).resolve().parent
    secret_path = root / ".env.secret"
    if not secret_path.exists():
        sys.exit(".env.secret not found at " + str(secret_path))
    from dotenv import load_dotenv
    load_dotenv(secret_path, override=True)


def _require_env(*keys: str) -> None:
    missing = [k for k in keys if not (os.environ.get(k) or "").strip()]
    if missing:
        sys.exit("Missing in .env.secret (use test -n to verify): " + ", ".join(missing))


def main():
    _load_secret_env()
    _require_env(
        "SNAPTRADE_CLIENT_ID",
        "SNAPTRADE_USER_ID",
        "SNAPTRADE_USER_SECRET",
    )
    client_id = os.environ["SNAPTRADE_CLIENT_ID"].strip()
    consumer_key = (os.environ.get("SNAPTRADE_CONSUMER_KEY") or os.environ.get("SNAPTRADE_API_KEY") or "").strip()
    if not consumer_key:
        sys.exit("Missing SNAPTRADE_CONSUMER_KEY or SNAPTRADE_API_KEY in .env.secret")
    user_id = os.environ["SNAPTRADE_USER_ID"].strip()
    user_secret = os.environ["SNAPTRADE_USER_SECRET"].strip()
    account_id = (os.environ.get("SNAPTRADE_ACCOUNT_ID") or "").strip()

    symbol = (sys.argv[1] if len(sys.argv) > 1 else "HOD.TO").upper()
    units = float(sys.argv[2]) if len(sys.argv) > 2 else 1.0

    from snaptrade_client import SnapTrade

    snaptrade = SnapTrade(client_id=client_id, consumer_key=consumer_key)

    if not account_id:
        r = snaptrade.account_information.list_user_accounts(
            user_id=user_id,
            user_secret=user_secret,
        )
        accounts = getattr(r, "body", r)
        if not isinstance(accounts, list):
            accounts = [accounts] if accounts else []
        if not accounts:
            sys.exit(
                "No accounts found. If you use a test API key (e.g. LOOMLY-TEST-GLESE), "
                "it may not sync real brokerage accounts. Use a production key from dashboard.snaptrade.com "
                "and reconnect Wealthsimple. See README_SNAPTRADE.md."
            )
        acc = accounts[0]
        account_id = acc.get("id") if isinstance(acc, dict) else getattr(acc, "id", None)
        if not account_id:
            sys.exit("Could not get account id from list_user_accounts response.")
        print("Using account:", account_id)

    order = snaptrade.trading.place_force_order(
        user_id=user_id,
        user_secret=user_secret,
        account_id=account_id,
        action="BUY",
        order_type="Market",
        time_in_force="Day",
        symbol=symbol,
        universal_symbol_id=None,
        units=units,
        notional_value=None,
        price=None,
        stop=None,
        trading_session="REGULAR",
    )
    body = getattr(order, "body", order)
    print("Order placed:", body)


if __name__ == "__main__":
    main()
