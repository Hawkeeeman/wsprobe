"""Local web UI for wsprobe (127.0.0.1 only). Install: pip install '.[web]' then wsprobe-serve."""

from __future__ import annotations

import argparse
import io
import json
import sys
from pathlib import Path
from typing import Any, Optional
from urllib.parse import unquote

from pydantic import BaseModel, Field

from wsprobe import __version__
from wsprobe.cli import (
    cmd_preview_buy,
    cmd_restrictions,
    cmd_security,
    run_ping_with_token,
)
from wsprobe.credentials import CONFIG_FILE, ensure_fresh_access_token, load_oauth_bundle

try:
    from fastapi import FastAPI, HTTPException
    from fastapi.responses import FileResponse
except ImportError as e:  # pragma: no cover - exercised when [web] not installed
    raise ImportError(
        "Web UI requires optional deps. Run: pip install 'wsprobe[web]' or pip install -e '.[web]'"
    ) from e

STATIC_DIR = Path(__file__).resolve().parent / "static"


def _bundle_from_oauth_cookie_value(raw_value: str) -> dict[str, Any]:
    raw = (raw_value or "").strip()
    if not raw:
        raise SystemExit("oauth_cookie_value is empty")
    try:
        data = json.loads(unquote(raw))
    except json.JSONDecodeError:
        data = json.loads(raw)
    if not isinstance(data, dict) or not data.get("access_token"):
        raise SystemExit("oauth_cookie_value does not contain a valid access_token")
    return data


def resolve_session_token(
    *,
    browser: Optional[str],
    token_file: Optional[str],
    oauth_cookie_value: Optional[str] = None,
) -> tuple[str, str]:
    from argparse import Namespace

    if oauth_cookie_value:
        try:
            bundle = _bundle_from_oauth_cookie_value(oauth_cookie_value)
            from wsprobe.credentials import SESSION_FILE, _persist_bundle

            _persist_bundle(SESSION_FILE, bundle)
            token = ensure_fresh_access_token(bundle, persist_path=SESSION_FILE)
        except SystemExit as e:
            raise HTTPException(status_code=401, detail=str(e)) from e
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Credential resolution failed: {e}") from e
        return token, "oauth-cookie"

    ns = Namespace(
        access_token=None,
        cookies_browser=browser,
        token_file=token_file,
        command="easy",
    )
    try:
        bundle, persist, src = load_oauth_bundle(ns)
        token = ensure_fresh_access_token(bundle, persist_path=persist)
    except SystemExit as e:
        raise HTTPException(status_code=401, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Credential resolution failed: {e}") from e
    return token, src


def _capture_stdio(fn: Any, *a: Any, **kw: Any) -> tuple[int, str, str]:
    out_b = io.StringIO()
    err_b = io.StringIO()
    old_out, old_err = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = out_b, err_b
    try:
        code = int(fn(*a, **kw))
    except SystemExit as e:
        code = int(e.code) if isinstance(e.code, int) else 1
        msg = str(e)
        if msg:
            print(msg, file=sys.stderr)
    except Exception as e:
        code = 1
        print(str(e), file=sys.stderr)
    finally:
        sys.stdout, sys.stderr = old_out, old_err
    return code, out_b.getvalue(), err_b.getvalue()


def _ns(**kwargs: Any) -> argparse.Namespace:
    return argparse.Namespace(**kwargs)


class SessionBody(BaseModel):
    browser: Optional[str] = Field(
        default=None,
        description="chrome, firefox, edge, … or omit to auto-detect",
    )
    token_file: Optional[str] = None
    oauth_cookie_value: Optional[str] = None


class PingBody(SessionBody):
    pass


class SecurityBody(SessionBody):
    security_id: str


class RestrictionsBody(SessionBody):
    security_id: str
    side: str = "BUY"


class PreviewBuyBody(SessionBody):
    security_id: str
    shares: float
    order: str = "market"
    limit_price: Optional[float] = None
    assume_price: Optional[float] = None


class WealthsimpleBuyBody(SessionBody):
    """Market buy via Wealthsimple Trade REST (same OAuth token as other endpoints)."""

    shares: float
    confirm: bool = False
    account_id: Optional[str] = None
    symbol: Optional[str] = None
    security_id: Optional[str] = None


app = FastAPI(
    title="wsprobe",
    version=__version__,
    description=(
        "Wealthsimple read-only GraphQL checks on your machine; POST /api/buy uses Trade REST (real orders). "
        "Bind is loopback-only by default."
    ),
)


@app.get("/api/meta")
def meta() -> dict[str, Any]:
    return {"version": __version__, "wsprobe": True}


@app.post("/api/ping")
def api_ping(body: PingBody) -> dict[str, Any]:
    token, src = resolve_session_token(
        browser=body.browser,
        token_file=body.token_file,
        oauth_cookie_value=body.oauth_cookie_value,
    )
    code, out, err = _capture_stdio(run_ping_with_token, token, _ns(json=True))
    payload: dict[str, Any] = {
        "credential_source": src,
        "exit_code": code,
        "stderr": err or None,
    }
    try:
        payload["data"] = json.loads(out) if out.strip() else None
    except json.JSONDecodeError:
        payload["raw_stdout"] = out
    if code != 0:
        raise HTTPException(status_code=502, detail=payload)
    return payload


@app.post("/api/security")
def api_security(body: SecurityBody) -> dict[str, Any]:
    token, src = resolve_session_token(
        browser=body.browser,
        token_file=body.token_file,
        oauth_cookie_value=body.oauth_cookie_value,
    )
    args = _ns(
        security_id=body.security_id.strip(),
        json=True,
        cookies_browser=None,
        token_file=None,
        access_token=token,
    )
    code, out, err = _capture_stdio(cmd_security, args)
    payload: dict[str, Any] = {
        "credential_source": src,
        "exit_code": code,
        "stderr": err or None,
    }
    try:
        payload["data"] = json.loads(out) if out.strip() else None
    except json.JSONDecodeError:
        payload["raw_stdout"] = out
    if code != 0:
        raise HTTPException(status_code=502, detail=payload)
    return payload


@app.post("/api/restrictions")
def api_restrictions(body: RestrictionsBody) -> dict[str, Any]:
    token, src = resolve_session_token(
        browser=body.browser,
        token_file=body.token_file,
        oauth_cookie_value=body.oauth_cookie_value,
    )
    side = body.side.upper()
    if side not in ("BUY", "SELL"):
        raise HTTPException(status_code=400, detail="side must be BUY or SELL")
    args = _ns(
        security_id=body.security_id.strip(),
        side=side,
        json=True,
        cookies_browser=None,
        token_file=None,
        access_token=token,
    )
    code, out, err = _capture_stdio(cmd_restrictions, args)
    payload: dict[str, Any] = {
        "credential_source": src,
        "exit_code": code,
        "stderr": err or None,
    }
    try:
        payload["data"] = json.loads(out) if out.strip() else None
    except json.JSONDecodeError:
        payload["raw_stdout"] = out
    if code != 0:
        raise HTTPException(status_code=502, detail=payload)
    return payload


@app.post("/api/preview-buy")
def api_preview_buy(body: PreviewBuyBody) -> dict[str, Any]:
    token, src = resolve_session_token(
        browser=body.browser,
        token_file=body.token_file,
        oauth_cookie_value=body.oauth_cookie_value,
    )
    order = body.order.lower()
    if order not in ("market", "limit"):
        raise HTTPException(status_code=400, detail="order must be market or limit")
    if body.shares <= 0:
        raise HTTPException(status_code=400, detail="shares must be positive")
    if order == "limit" and body.limit_price is None:
        raise HTTPException(status_code=400, detail="limit orders require limit_price")
    args = _ns(
        security_id=body.security_id.strip(),
        shares=float(body.shares),
        order=order,
        limit_price=body.limit_price,
        assume_price=body.assume_price,
        json=True,
        cookies_browser=None,
        token_file=None,
        access_token=token,
    )
    code, out, err = _capture_stdio(cmd_preview_buy, args)
    payload: dict[str, Any] = {
        "credential_source": src,
        "exit_code": code,
        "stderr": err or None,
    }
    try:
        payload["data"] = json.loads(out) if out.strip() else None
    except json.JSONDecodeError:
        payload["raw_stdout"] = out
    if code != 0:
        raise HTTPException(status_code=502, detail=payload)
    return payload


@app.post("/api/buy")
def api_wealthsimple_buy(body: WealthsimpleBuyBody) -> dict[str, Any]:
    if not body.confirm:
        raise HTTPException(
            status_code=400,
            detail="Refusing: set confirm=true to submit a real market buy (Wealthsimple Trade REST).",
        )
    if body.shares <= 0:
        raise HTTPException(status_code=400, detail="shares must be positive")
    sym = (body.symbol or "").strip()
    sec = (body.security_id or "").strip()
    if sym and sec:
        raise HTTPException(status_code=400, detail="Provide only one of: symbol, security_id")
    if not sym and not sec:
        raise HTTPException(status_code=400, detail="Provide symbol (e.g. VFV.TO) or security_id (sec-s-…)")
    token, src = resolve_session_token(
        browser=body.browser,
        token_file=body.token_file,
        oauth_cookie_value=body.oauth_cookie_value,
    )
    try:
        from wsprobe.trade_service import pick_account_id, place_market_buy as ws_buy, symbol_to_security_id

        account_id = pick_account_id(token, body.account_id)
        security_id = symbol_to_security_id(token, sym) if sym else sec
        order_payload = ws_buy(
            token,
            account_id=account_id,
            security_id=security_id,
            quantity=float(body.shares),
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    return {
        "ok": True,
        "credential_source": src,
        "account_id": account_id,
        "security_id": security_id,
        "shares": body.shares,
        "order": order_payload,
    }


@app.post("/api/trade-accounts")
def api_trade_accounts(body: PingBody) -> dict[str, Any]:
    token, src = resolve_session_token(
        browser=body.browser,
        token_file=body.token_file,
        oauth_cookie_value=body.oauth_cookie_value,
    )
    try:
        from wsprobe.trade_service import list_accounts

        rows = list_accounts(token)
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    return {"credential_source": src, "accounts": rows}


@app.get("/")
def index() -> FileResponse:
    index_path = STATIC_DIR / "index.html"
    if not index_path.is_file():
        raise HTTPException(status_code=500, detail="Missing static/index.html in package")
    return FileResponse(index_path)


def main(argv: list[str] | None = None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    p = argparse.ArgumentParser(prog="wsprobe-serve", description="Local web UI for wsprobe (127.0.0.1).")
    p.add_argument("--host", default="127.0.0.1", help="Bind address (default: 127.0.0.1 only)")
    p.add_argument("--port", type=int, default=8765, metavar="N")
    args = p.parse_args(argv)
    if args.host not in ("127.0.0.1", "localhost"):
        print(
            "Refusing to bind to a non-loopback address by default (session tokens). "
            "If you need LAN access, run with an explicit reverse proxy you control.",
            file=sys.stderr,
        )
        return 1

    import uvicorn

    print(f"wsprobe {__version__} — open http://{args.host}:{args.port}/ in your browser", file=sys.stderr)
    print("Quit with Ctrl+C. Preview GraphQL is read-only; real buys: POST /api/buy (Trade REST).", file=sys.stderr)
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
