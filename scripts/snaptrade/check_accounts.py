#!/usr/bin/env python3
"""Check connected SnapTrade accounts."""
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

    print(f"\nUsing User ID: {user_id}\n")

    from snaptrade_client import SnapTrade

    snaptrade = SnapTrade(client_id=client_id, consumer_key=api_key)

    # Check all connections (authorizations)
    try:
        connections = snaptrade.connections.list_brokerage_authorizations(
            user_id=user_id,
            user_secret=user_secret,
        )
        body = getattr(connections, "body", connections)
        print("="*60)
        print(" CONNECTIONS (BROKERAGE AUTHORIZATIONS)")
        print("="*60)
        print(f"\n{body}\n")
        print("="*60)
    except Exception as e:
        print(f"Error checking connections: {e}")

    # Check accounts
    try:
        accounts = snaptrade.account_information.list_user_accounts(
            user_id=user_id,
            user_secret=user_secret,
        )
        print("="*60)
        print(" ACCOUNTS")
        print("="*60)
        print(f"\n{accounts}\n")
        print("="*60)
    except Exception as e:
        print(f"Error checking accounts: {e}")

if __name__ == "__main__":
    main()
