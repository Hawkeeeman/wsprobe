#!/usr/bin/env bash
# Check that SnapTrade env vars are set (e.g. after loading .env.secret).
# Usage: source .env.secret && ./check_snaptrade_env.sh
#    or: set -a; source .env.secret; set +a; ./check_snaptrade_env.sh
set -e
test -n "${SNAPTRADE_CLIENT_ID}" || { echo "SNAPTRADE_CLIENT_ID not set"; exit 1; }
test -n "${SNAPTRADE_CONSUMER_KEY}" || { echo "SNAPTRADE_CONSUMER_KEY not set"; exit 1; }
test -n "${SNAPTRADE_USER_ID}" || { echo "SNAPTRADE_USER_ID not set"; exit 1; }
test -n "${SNAPTRADE_USER_SECRET}" || { echo "SNAPTRADE_USER_SECRET not set"; exit 1; }
echo "SnapTrade env vars present"
