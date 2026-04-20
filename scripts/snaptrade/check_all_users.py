#!/usr/bin/env python3
"""Check all SnapTrade users to find which one has accounts."""
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

    # Get all users
    users = snaptrade.authentication.list_snap_trade_users()
    user_list = users.body

    print("\n" + "="*60)
    print(" CHECKING ALL USERS FOR ACCOUNTS")
    print("="*60 + "\n")

    for user_id in user_list:
        print(f"Checking user: {user_id}")

        # For each user, we need to get their secret to check accounts
        # But we can't do that easily. Instead, let's just try the known users.
        print(f"  - Need user_secret to check accounts")

    # Let's try with a hardcoded list of known users
    known_users = [
        ('snaptrade-cli-omar', None),
        ('hawk', None),
        ('Hawk', None),
    ]

    print("\n" + "="*60)
    print(" KNOWN USERS (you may need to set their secrets)")
    print("="*60 + "\n")

    for user_id, _ in known_users:
        print(f"  {user_id}")

    print("\n" + "="*60)
    print(" IMPORTANT")
    print("="*60)
    print("\nThe connection might be under a different user.")
    print("\nTo use a different user, update your .env.secret:")
    print("  SNAPTRADE_USER_ID=snaptrade-cli-omar")
    print("  SNAPTRADE_USER_SECRET=... (need the secret for this user)")
    print("\n" + "="*60 + "\n")

if __name__ == "__main__":
    main()
