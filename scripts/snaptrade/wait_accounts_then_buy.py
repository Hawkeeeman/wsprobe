#!/usr/bin/env python3
"""
Refresh connection, poll for accounts until they appear (up to 90s), then place buy.
Uses .env.secret (run sync_cli_config_to_env.py first if needed).
"""
import os
import sys
import time
from pathlib import Path

def _load_secret_env():
    root = Path(__file__).resolve().parent
    secret_path = root / ".env.secret"
    if not secret_path.exists():
        sys.exit(".env.secret not found. Run sync_cli_config_to_env.py first.")
    from dotenv import load_dotenv
    load_dotenv(secret_path, override=True)

def main():
    _load_secret_env()
    client_id = (os.environ.get("SNAPTRADE_CLIENT_ID") or "").strip()
    consumer_key = (os.environ.get("SNAPTRADE_CONSUMER_KEY") or os.environ.get("SNAPTRADE_API_KEY") or "").strip()
    user_id = (os.environ.get("SNAPTRADE_USER_ID") or "").strip()
    user_secret = (os.environ.get("SNAPTRADE_USER_SECRET") or "").strip()
    if not all([client_id, consumer_key, user_id, user_secret]):
        sys.exit("Missing SNAPTRADE_* in .env.secret.")

    auth_id = (sys.argv[1] if len(sys.argv) > 1 else "").strip() or "6ae42e64-8f31-4b95-b61a-692eba4e8bbe"
    symbol = (sys.argv[2] if len(sys.argv) > 2 else "SMC.TO").upper()
    units = float(sys.argv[3]) if len(sys.argv) > 3 else 10.0

    from snaptrade_client import SnapTrade
    st = SnapTrade(client_id=client_id, consumer_key=consumer_key)

    print("Refreshing connection", auth_id, "...")
    try:
        st.connections.refresh_brokerage_authorization(
            authorization_id=auth_id,
            user_id=user_id,
            user_secret=user_secret,
        )
    except Exception as e:
        sys.exit(f"Refresh failed: {e}")

    print("Polling for accounts (up to 90s) ...")
    account_id = None
    for i in range(18):
        time.sleep(5)
        r = st.account_information.list_user_accounts(user_id=user_id, user_secret=user_secret)
        accounts = getattr(r, "body", r)
        if isinstance(accounts, list) and accounts:
            acc = accounts[0]
            account_id = acc.get("id") if isinstance(acc, dict) else getattr(acc, "id", None)
            if account_id:
                print(f"Account found: {account_id}")
                break
        print(f"  {(i+1)*5}s ...")

    if not account_id:
        sys.exit("No accounts appeared after 90s. Check SnapTrade dashboard or try again later.")

    print(f"Placing order: BUY {units} {symbol} ...")
    try:
        order = st.trading.place_force_order(
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
    except Exception as e:
        sys.exit(f"Place order failed: {e}")

if __name__ == "__main__":
    main()
