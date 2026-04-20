#!/usr/bin/env python3
"""Get portal URL for snaptrade-cli-omar user."""
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

    # Try to get portal for snaptrade-cli-omar
    user_id = "snaptrade-cli-omar"

    print(f"\nTrying user: {user_id}\n")

    try:
        # First, we need to reset the user secret to get a new one
        reset = snaptrade.authentication.reset_snap_trade_user_secret(
            user_id=user_id,
        )
        print(f"Reset response: {reset}")

        body = reset.body
        user_secret = body.get('userSecret') or body.get('user_secret')

        print(f"\nNew user secret: {user_secret}\n")

        # Now get portal URL
        portal = snaptrade.authentication.login_snap_trade_user(
            user_id=user_id,
            user_secret=user_secret,
        )

        redirect_uri = portal.body.get('redirectURI')

        print("="*60)
        print(f" PORTAL URL FOR: {user_id}")
        print("="*60)
        print(f"\n{redirect_uri}\n")
        print("="*60)
        print("\nAdd this to your .env.secret:")
        print(f"SNAPTRADE_USER_ID={user_id}")
        print(f"SNAPTRADE_USER_SECRET={user_secret}")
        print("="*60)

    except Exception as e:
        print(f"Error: {e}")
        print("\nThis user might need to be registered first, or the connection")
        print("might be under a different user.")

if __name__ == "__main__":
    main()
