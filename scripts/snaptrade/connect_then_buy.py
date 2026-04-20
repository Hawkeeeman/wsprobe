#!/usr/bin/env python3
"""
1. Get Wealthsimple connection portal URL and open browser.
2. Wait for user to complete connection (poll every 5s, up to 3 min).
3. Refresh the new connection.
4. Poll for accounts every 5s, up to 2 min.
5. Place BUY order (default: 10 shares SMC.TO).

Requires .env.secret (run sync_cli_config_to_env.py first).
"""
import os
import sys
import time
import webbrowser
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

    symbol = (sys.argv[1] if len(sys.argv) > 1 else "SMC.TO").upper()
    units = float(sys.argv[2]) if len(sys.argv) > 2 else 10.0

    from snaptrade_client import SnapTrade
    st = SnapTrade(client_id=client_id, consumer_key=consumer_key)

    # 1. Get portal URL and open browser
    print("Getting connection portal URL...")
    r = st.authentication.login_snap_trade_user(
        user_id=user_id,
        user_secret=user_secret,
        broker="WEALTHSIMPLETRADE",
        connection_type="trade",
    )
    body = getattr(r, "body", r)
    if isinstance(body, dict):
        url = body.get("redirectURI") or body.get("redirect_uri")
    else:
        url = getattr(body, "redirect_uri", None) or getattr(body, "redirectURI", None)
    if not url:
        sys.exit("No redirect URI in login response.")
    webbrowser.open(url)
    print("Browser opened. Complete Wealthsimple login in the portal.")
    print("Waiting for new connection (polling every 5s, max 3 min)...")

    # 2. Wait for new connection
    auth_id = None
    for _ in range(36):
        time.sleep(5)
        conns = st.connections.list_brokerage_authorizations(user_id=user_id, user_secret=user_secret)
        clist = getattr(conns, "body", conns)
        if not isinstance(clist, list):
            clist = [clist] if clist else []
        for c in clist:
            cid = c.get("id") if isinstance(c, dict) else getattr(c, "id", None)
            disabled = c.get("disabled") if isinstance(c, dict) else getattr(c, "disabled", True)
            if cid and not disabled:
                auth_id = str(cid)
                break
        if auth_id:
            print(f"Connection found: {auth_id}")
            break
    if not auth_id:
        sys.exit("No connection found after 3 min. Complete login in the browser and run again.")

    # 3. Refresh connection
    print("Refreshing connection...")
    st.connections.refresh_brokerage_authorization(
        authorization_id=auth_id,
        user_id=user_id,
        user_secret=user_secret,
    )
    print("Waiting 15s for initial account sync...")
    time.sleep(15)

    # 4. Poll for accounts
    account_id = None
    for i in range(24):
        r = st.account_information.list_user_accounts(user_id=user_id, user_secret=user_secret)
        accounts = getattr(r, "body", r)
        if isinstance(accounts, list) and accounts:
            acc = accounts[0]
            account_id = acc.get("id") if isinstance(acc, dict) else getattr(acc, "id", None)
            if account_id:
                print(f"Account found: {account_id}")
                break
        time.sleep(5)
        print(f"  {(i+1)*5}s ...")

    if not account_id:
        sys.exit("No accounts appeared. Try: snaptrade reconnect " + auth_id + " then run this again in 1–2 min.")

    # 5. Place order
    print(f"Placing order: BUY {units} {symbol} ...")
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

if __name__ == "__main__":
    main()
