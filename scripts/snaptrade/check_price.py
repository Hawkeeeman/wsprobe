#!/usr/bin/env python3
"""
Get the current price of a stock symbol via SnapTrade.
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

    symbol = (sys.argv[1] if len(sys.argv) > 1 else "FTEC.V").upper()

    from snaptrade_client import SnapTrade

    snaptrade = SnapTrade(client_id=client_id, consumer_key=api_key)

    # Try to get symbol info
    try:
        # Get list of supported brokers to see what's available
        print(f"\nLooking up price for: {symbol}")
        print("\nNote: SnapTrade reference data API may require specific parameters.")
        print("You can also check the price on Google Finance, Yahoo Finance, or your brokerage app.\n")

        # Try the quotes endpoint
        quotes = snaptrade.reference_data.get_symbol_quote(
            user_id=user_id,
            user_secret=user_secret,
            ticker_id=symbol,
        )
        print(f"Quote response: {quotes}")

    except Exception as e:
        print(f"Error getting quote: {e}")
        print(f"\nPlease check the price of {symbol} on your brokerage app or at:")
        print(f"  - https://www.google.com/search?q={symbol}+stock")
        print(f"  - https://finance.yahoo.com/quote/{symbol}")

if __name__ == "__main__":
    main()
