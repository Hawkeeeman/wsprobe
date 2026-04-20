#!/usr/bin/env python3
"""
Refresh a SnapTrade connection so that accounts appear (sync holdings).
Then list user accounts and print account IDs for use with buy_tsx.py or CLI.

Loads credentials from .env.secret. Optional: pass connection (authorization) ID;
otherwise uses the first connection returned by the API.

SnapTrade: POST /authorizations/{authorizationId}/refresh triggers async sync;
accounts may appear after a short delay.
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
    client_id = os.environ.get("SNAPTRADE_CLIENT_ID", "").strip()
    api_key = os.environ.get("SNAPTRADE_API_KEY") or os.environ.get("SNAPTRADE_CONSUMER_KEY", "")
    api_key = api_key.strip()
    user_id = os.environ.get("SNAPTRADE_USER_ID", "").strip()
    user_secret = os.environ.get("SNAPTRADE_USER_SECRET", "").strip()
    if not all([client_id, api_key, user_id, user_secret]):
        sys.exit("Missing SNAPTRADE_* in .env.secret. Run sync_cli_config_to_env.py first.")

    from snaptrade_client import SnapTrade
    snaptrade = SnapTrade(client_id=client_id, consumer_key=api_key)

    # Optional connection ID from argv (e.g. 6ae42e64-8f31-4b95-b61a-692eba4e8bbe)
    auth_id_arg = (sys.argv[1] if len(sys.argv) > 1 else "").strip()

    # List connections (authorizations)
    try:
        conns = snaptrade.connections.list_brokerage_authorizations(
            user_id=user_id,
            user_secret=user_secret,
        )
    except Exception as e:
        sys.exit(f"list_brokerage_authorizations failed: {e}")

    body = getattr(conns, "body", conns)
    if isinstance(body, list):
        conn_list = body
    else:
        conn_list = [body] if body else []
    if not conn_list:
        sys.exit("No connections found. Connect Wealthsimple via SnapTrade portal first.")

    # Resolve authorization ID
    auth_id = None
    for c in conn_list:
        cid = c.get("id") if isinstance(c, dict) else getattr(c, "id", None)
        if auth_id_arg and str(cid) == auth_id_arg:
            auth_id = str(cid)
            break
        if not auth_id:
            auth_id = str(cid)
    if not auth_id:
        auth_id = auth_id_arg or str(conn_list[0].get("id") if isinstance(conn_list[0], dict) else getattr(conn_list[0], "id", None))
    if not auth_id:
        sys.exit("Could not get authorization ID from connections.")

    print(f"Refreshing connection {auth_id} ...")
    try:
        snaptrade.connections.refresh_brokerage_authorization(
            authorization_id=auth_id,
            user_id=user_id,
            user_secret=user_secret,
        )
    except Exception as e:
        sys.exit(f"refresh_brokerage_authorization failed: {e}")
    print("Refresh triggered (async). Waiting 8s for sync ...")
    time.sleep(8)

    # List accounts
    try:
        r = snaptrade.account_information.list_user_accounts(
            user_id=user_id,
            user_secret=user_secret,
        )
    except Exception as e:
        sys.exit(f"list_user_accounts failed: {e}")

    accounts = getattr(r, "body", r)
    if not isinstance(accounts, list):
        accounts = [accounts] if accounts else []
    if not accounts:
        print("No accounts returned yet. Try running this script again in a minute.")
        return
    print("\nAccounts (use SNAPTRADE_ACCOUNT_ID for buy_tsx.py):")
    for acc in accounts:
        aid = acc.get("id") if isinstance(acc, dict) else getattr(acc, "id", None)
        name = acc.get("name") if isinstance(acc, dict) else getattr(acc, "name", "")
        print(f"  {aid}  {name}")
    print("\nOptional: add to .env.secret:")
    first_id = accounts[0].get("id") if isinstance(accounts[0], dict) else getattr(accounts[0], "id", None)
    if first_id:
        print(f"  SNAPTRADE_ACCOUNT_ID={first_id}")


if __name__ == "__main__":
    main()
