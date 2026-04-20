#!/usr/bin/env python3
"""
Register a new SnapTrade user to get USER_ID and USER_SECRET.
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

    if not client_id or not api_key:
        sys.exit("Missing SNAPTRADE_CLIENT_ID or SNAPTRADE_API_KEY in .env.secret")

    from snaptrade_client import SnapTrade

    snaptrade = SnapTrade(client_id=client_id, consumer_key=api_key)

    # Register a new user (provide any unique userId)
    import uuid
    user = snaptrade.authentication.register_snap_trade_user(
        user_id=str(uuid.uuid4()),  # Generate unique user ID
    )

    body = getattr(user, "body", user)
    user_id = body.user_id if hasattr(body, "user_id") else body.get("user_id") or body.get("userId")
    user_secret = body.user_secret if hasattr(body, "user_secret") else body.get("user_secret") or body.get("userSecret")

    print("\n=== SnapTrade User Registered ===")
    print(f"USER_ID: {user_id}")
    print(f"USER_SECRET: {user_secret}")
    print("\nAdd these to your .env.secret file:")
    print(f'SNAPTRADE_USER_ID={user_id}')
    print(f'SNAPTRADE_USER_SECRET={user_secret}')
    print("\nYou'll also need to connect your brokerage account via the portal URL.")

    # Get portal URL (without specifying broker to show all options)
    portal = snaptrade.authentication.login_snap_trade_user(
        user_id=user_id,
        user_secret=user_secret,
    )
    portal_body = getattr(portal, "body", portal)
    redirect_url = portal_body.redirect_uri if hasattr(portal_body, "redirect_uri") else portal_body.get("redirect_uri") or portal_body.get("redirectUri")
    print(f"\n=== Connect Your Brokerage Account ===")
    print(f"Portal URL: {redirect_url}")
    print("\nOpen this URL in your browser to connect your Wealthsimple account.")

if __name__ == "__main__":
    main()
