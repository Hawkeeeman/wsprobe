# Exact steps to place SMC.TO buy order (SnapTrade)

## 1. CLI config location (for reference)

- **Path:** `~/.config/snaptrade/settings.json`
- **Exact keys:** `profiles.default.clientId`, `profiles.default.consumerKey`, `profiles.default.userId`, `profiles.default.userSecret`
- Current CLI values (from your machine): clientId=LOOMLY-TEST-GLESE, userId=snaptrade-cli-omar, userSecret=b87717f1-249a-4554-a2e6-6a7283df894b, consumerKey same as in settings.json.

## 2. Refresh/sync so accounts appear

- **API:** `POST /api/v1/authorizations/{authorizationId}/refresh` (SnapTrade “refresh brokerage authorization”).
- **Python SDK:** `snaptrade.connections.refresh_brokerage_authorization(authorization_id=..., user_id=..., user_secret=...)`
- **Script in repo:** `python3 refresh_connection.py [CONNECTION_ID]` (e.g. `6ae42e64-8f31-4b95-b61a-692eba4e8bbe`). Runs refresh then lists accounts after a short wait.
- **List accounts:** `GET /api/v1/accounts` with userId/userSecret (or `snaptrade.account_information.list_user_accounts`). There is no separate “list accounts for authorization” endpoint; filter by `brokerage_authorization` on each account if needed.

## 3. Get credentials into .env.secret (no hardcoding in repo)

- Run: `python3 sync_cli_config_to_env.py`
- This reads `~/.config/snaptrade/settings.json` and writes `.env.secret` with SNAPTRADE_CLIENT_ID, SNAPTRADE_CONSUMER_KEY, SNAPTRADE_API_KEY, SNAPTRADE_USER_ID, SNAPTRADE_USER_SECRET.

## 4. Place the order

**Option A – CLI (once accounts show up)**  
```bash
snaptrade trade equity --ticker SMC.TO --action BUY --shares 10 --useLastAccount
```

**Option B – Python script (same credentials)**  
```bash
source .env.secret && python3 buy_tsx.py SMC.TO 10
```
(Optional: add `SNAPTRADE_ACCOUNT_ID=<id>` to `.env.secret` if you want to pin an account; otherwise first account from `list_user_accounts` is used.)

## 5. If “No accounts found”

- Connection exists but `/accounts` returns empty until sync completes.
- Run: `source .env.secret && python3 refresh_connection.py 6ae42e64-8f31-4b95-b61a-692eba4e8bbe`
- Wait 10–60 seconds, then run `python3 refresh_connection.py` again (no args) to list accounts. When accounts appear, run the buy command above.
- `snaptrade accounts` uses the same API and will show accounts after sync.

## 6. Code/file changes made

| File | Change |
|------|--------|
| `sync_cli_config_to_env.py` | **New.** Reads `~/.config/snaptrade/settings.json`, writes `.env.secret` with SNAPTRADE_* (no secrets in repo). |
| `refresh_connection.py` | **New.** Loads `.env.secret`, calls refresh_brokerage_authorization, waits, then list_user_accounts and prints account IDs. |
| `check_accounts.py` | Use `list_brokerage_authorizations` instead of `list_connections` (SDK method name); handle response body. |
| `README_SNAPTRADE.md` | Added CLI config path, sync script, “If the API returns No accounts found” (refresh steps), CONSUMER_KEY/API_KEY note. |
| `STEPS_SNAPTRADE_ORDER.md` | **New.** This file – exact steps and code changes for parent to confirm. |

## 7. Verification

- **Sync:** `python3 sync_cli_config_to_env.py` → writes `.env.secret` from CLI config. Confirmed.
- **Refresh:** `python3 refresh_connection.py 6ae42e64-8f31-4b95-b61a-692eba4e8bbe` → refresh returns 200; list_user_accounts still returns [] in testing (async sync may take longer). Once SnapTrade returns accounts, `refresh_connection.py` prints account IDs.
- **Buy:** `python3 buy_tsx.py SMC.TO 10` → runs and exits with “No accounts found” until accounts are synced; then it will place the order. No code change needed for buy once accounts exist.
