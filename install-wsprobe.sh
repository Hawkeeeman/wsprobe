#!/usr/bin/env sh
set -e
cd "$(dirname "$0")"
echo "Installing wsprobe (user site-packages)..."
python3 -m pip install --user -e .
echo ""
echo "Done. From this folder you can run:"
echo "  python3 -m wsprobe"
echo "Optional read-only browser UI (pip install -e '.[web]'), same OAuth as wsprobe:"
echo "  wsprobe-serve"
echo "  open http://127.0.0.1:8765/"
echo "(Run 'wsprobe onboard' once to save credentials, then use wsprobe/wsp normally.)"
