"""Local web UI for wsprobe (127.0.0.1 only). Install: pip install '.[web]' then wsprobe-serve."""

from __future__ import annotations

import argparse
import io
import json
import sys
from pathlib import Path
from typing import Any, Optional
from urllib.parse import unquote

from pydantic import BaseModel

from wsprobe import __version__
from wsprobe.cli import (
    cmd_doctor,
    cmd_lookup,
    cmd_preview_buy,
    cmd_restrictions,
    cmd_security,
    run_ping_with_token,
)
from wsprobe.credentials import SESSION_FILE, _persist_bundle, ensure_fresh_access_token, load_oauth_bundle

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
    token_file: Optional[str],
    oauth_cookie_value: Optional[str] = None,
) -> tuple[str, str]:
    from argparse import Namespace

    if oauth_cookie_value:
        try:
            bundle = _bundle_from_oauth_cookie_value(oauth_cookie_value)
            _persist_bundle(SESSION_FILE, bundle)
            token = ensure_fresh_access_token(bundle, persist_path=SESSION_FILE)
        except SystemExit as e:
            raise HTTPException(status_code=401, detail=str(e)) from e
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Credential resolution failed: {e}") from e
        return token, "oauth-cookie"

    ns = Namespace(
        access_token=None,
        cookies_browser=None,
        token_file=token_file,
        command="ping",
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


class DoctorBody(SessionBody):
    pass


class LookupBody(SessionBody):
    query: str
    limit: int = 20


app = FastAPI(
    title="wsprobe",
    version=__version__,
    description="Wealthsimple read-only GraphQL checks on your machine. Bind is loopback-only by default.",
)


@app.get("/api/meta")
def meta() -> dict[str, Any]:
    return {"version": __version__, "wsprobe": True}


@app.post("/api/doctor")
def api_doctor(body: DoctorBody) -> dict[str, Any]:
    token, src = resolve_session_token(
        token_file=body.token_file,
        oauth_cookie_value=body.oauth_cookie_value,
    )
    args = _ns(
        json=True,
        cookies_browser=None,
        token_file=None,
        access_token=token,
        command="doctor",
    )
    code, out, err = _capture_stdio(cmd_doctor, args)
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


@app.post("/api/lookup")
def api_lookup(body: LookupBody) -> dict[str, Any]:
    q = (body.query or "").strip()
    if not q:
        raise HTTPException(status_code=400, detail="query is required")
    lim = max(1, min(int(body.limit or 20), 50))
    token, src = resolve_session_token(
        token_file=body.token_file,
        oauth_cookie_value=body.oauth_cookie_value,
    )
    args = _ns(
        query=q,
        lookup_limit=lim,
        json=True,
        cookies_browser=None,
        token_file=None,
        access_token=token,
        command="lookup",
    )
    code, out, err = _capture_stdio(cmd_lookup, args)
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


@app.post("/api/ping")
def api_ping(body: PingBody) -> dict[str, Any]:
    token, src = resolve_session_token(
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
    print("Quit with Ctrl+C. This UI is read-only (GraphQL queries only).", file=sys.stderr)
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
