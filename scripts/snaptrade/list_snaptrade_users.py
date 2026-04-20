#!/usr/bin/env python3
"""List all SnapTrade users for this client."""
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

    from snaptrade_client import SnapTrade

    snaptrade = SnapTrade(client_id=client_id, consumer_key=api_key)

    # List all users for this client
    try:
        users = snaptrade.authentication.list_snap_trade_users()
        print("="*60)
        print(" ALL SNAPTRADE USERS")
        print("="*60)
        print(f"\n{users}\n")
        print("="*60)
    except Exception as e:
        print(f"Error listing users: {e}")

if __name__ == "__main__":
    main()
