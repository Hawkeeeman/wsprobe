#!/usr/bin/env python3
"""
Get the SnapTrade portal URL to connect your brokerage account.
"""
import os
import sys
from pathlib import Path

def _load_secret_env():
    root = Path(__file__).resolve().parent
    secret_path = root / ".env.secret"
    if not secret_path.exists():
        sys.exit(".env.secret not found")
    from dotenv import load_dotenv
    load_dotenv(secret_path, override=True)

def main():
    _load_secret_env()

    client_id = os.environ.get("SNAPTRADE_CLIENT_ID", "").strip()
    api_key = os.environ.get("SNAPTRADE_API_KEY", "").strip()
    user_id = os.environ.get("SNAPTRADE_USER_ID", "").strip()
    user_secret = os.environ.get("SNAPTRADE_USER_SECRET", "").strip()

    if not all([client_id, api_key, user_id, user_secret]):
        sys.exit("Missing credentials in .env.secret")

    from snaptrade_client import SnapTrade

    snaptrade = SnapTrade(client_id=client_id, consumer_key=api_key)

    # Get portal URL
    portal = snaptrade.authentication.login_snap_trade_user(
        user_id=user_id,
        user_secret=user_secret,
    )

    # Access the body dict
    body = portal.body
    redirect_uri = body.get('redirectURI')

    print("\n" + "="*60)
    print(" SNAPTRADE CONNECTION PORTAL")
    print("="*60)
    print("\nOpen this URL in your browser to connect your brokerage account:")
    print(f"\n{redirect_uri}\n")
    print("="*60)
    print("\nAfter connecting your account, you can run the buy script:")
    print("  python3 buy_tsx.py FTEC.V 100")
    print("="*60)

if __name__ == "__main__":
    main()
