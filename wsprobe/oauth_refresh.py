"""Wealthsimple web OAuth2: refresh access tokens (same host as my.wealthsimple.com)."""

from __future__ import annotations

import json
import random
import ssl
import time
import urllib.error
import urllib.request
import uuid
from typing import Any

# Public web client id shipped with my.wealthsimple.com (not a user secret).
DEFAULT_OAUTH_CLIENT_ID = (
    "4da53ac2b03225bed1550eba8e4611e086c7b905a3855e6ed12ea08c246758fa"
)

OAUTH_TOKEN_URL = "https://api.production.wealthsimple.com/v1/oauth/v2/token"
OAUTH_TOKEN_INFO_URL = "https://api.production.wealthsimple.com/v1/oauth/v2/token/info"
SESSION_INFO_URL = "https://api.production.wealthsimple.com/api/sessions"


class AuthRequestError(RuntimeError):
    def __init__(self, message: str, *, status: int | None = None, transient: bool = False) -> None:
        super().__init__(message)
        self.status = status
        self.transient = transient


def _auth_json_request(
    method: str,
    url: str,
    *,
    timeout_s: float,
    access_token: str | None = None,
    json_body: dict[str, Any] | None = None,
) -> tuple[int, dict[str, Any]]:
    headers = {
        "accept": "application/json",
        "content-type": "application/json",
        "origin": "https://my.wealthsimple.com",
        "x-wealthsimple-client": "@wealthsimple/wealthsimple",
    }
    if access_token:
        headers["authorization"] = f"Bearer {access_token}"
    data = json.dumps(json_body).encode("utf-8") if json_body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, timeout=timeout_s, context=ctx) as resp:
            status = getattr(resp, "status", 200) or 200
            text = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        status = e.code
        text = e.read().decode("utf-8", errors="replace")
        try:
            payload = json.loads(text) if text.strip() else {}
        except json.JSONDecodeError:
            payload = {"_raw_preview": " ".join(text.split())[:320]}
        raise AuthRequestError(
            f"Auth endpoint failed HTTP {status}: {payload}",
            status=status,
            transient=status >= 500,
        ) from None
    except (urllib.error.URLError, TimeoutError) as e:
        raise AuthRequestError(
            f"Auth endpoint network error: {e}",
            transient=True,
        ) from e
    try:
        payload = json.loads(text) if text.strip() else {}
    except json.JSONDecodeError as e:
        raise AuthRequestError(f"Auth endpoint invalid JSON: {text[:300]}") from e
    if not isinstance(payload, dict):
        raise AuthRequestError(f"Auth endpoint invalid payload type: {type(payload).__name__}")
    return status, payload


def _browser_like_refresh_headers(*, access_token: str | None = None) -> dict[str, str]:
    try:
        from wsprobe.browser_cookies import wealthsimple_request_context_first_available

        ctx = wealthsimple_request_context_first_available()
    except Exception:
        ctx = {}
    session_id = (ctx.get("ws_global_visitor_id") or "").strip() or str(uuid.uuid4())
    device_id = (ctx.get("wssdi") or "").strip() or str(uuid.uuid4())
    app_instance = str(uuid.uuid4())
    headers = {
        "accept": "application/json",
        "accept-language": "en-US,en;q=0.9",
        "content-type": "application/json",
        "origin": "https://my.wealthsimple.com",
        "referer": "https://my.wealthsimple.com/",
        "user-agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/146.0.0.0 Safari/537.36"
        ),
        "sec-ch-ua": '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"macOS"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-site",
        "x-wealthsimple-client": "@wealthsimple/wealthsimple",
        "x-ws-client-tier": "core",
        "x-platform-os": "web",
        "x-ws-profile": "invest",
        "x-ws-api-version": "12",
        "x-app-instance-id": app_instance,
        "x-ws-session-id": session_id,
        "x-ws-device-id": device_id,
    }
    if access_token:
        headers["authorization"] = f"Bearer {access_token}"
    cookie_header = (ctx.get("cookie_header") or "").strip()
    if cookie_header:
        headers["cookie"] = cookie_header
    return headers


def jwt_exp_unix(access_token: str) -> int | None:
    parts = access_token.split(".")
    if len(parts) < 2:
        return None
    payload_b64 = parts[1]
    pad = "=" * (-len(payload_b64) % 4)
    try:
        raw = __import__("base64").urlsafe_b64decode(payload_b64 + pad)
        data = json.loads(raw.decode("utf-8"))
    except (ValueError, json.JSONDecodeError, UnicodeDecodeError):
        return None
    exp = data.get("exp") if isinstance(data, dict) else None
    if exp is None:
        return None
    try:
        return int(exp)
    except (TypeError, ValueError):
        return None


def access_token_needs_refresh(access_token: str, *, skew_seconds: int = 120) -> bool:
    """True if JWT exp is missing or within skew_seconds of now (client-side hint only)."""
    exp = jwt_exp_unix(access_token)
    if exp is None:
        return False
    return time.time() >= float(exp) - float(skew_seconds)


def refresh_access_token(
    refresh_token: str,
    *,
    client_id: str = DEFAULT_OAUTH_CLIENT_ID,
    access_token: str | None = None,
    timeout_s: float = 30.0,
) -> dict[str, Any]:
    """
    POST /v1/oauth/v2/token with grant_type=refresh_token.
    Returns JSON body (access_token, refresh_token, expires_in, ...).
    """
    rt = refresh_token.strip()
    if not rt:
        raise ValueError("refresh_token is empty")

    body = {
        "grant_type": "refresh_token",
        "refresh_token": rt,
        "client_id": client_id,
    }
    headers = _browser_like_refresh_headers(access_token=access_token)
    req = urllib.request.Request(
        OAUTH_TOKEN_URL,
        data=json.dumps(body).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, timeout=timeout_s, context=ctx) as resp:
            status = getattr(resp, "status", 200) or 200
            text = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        status = e.code
        text = e.read().decode("utf-8", errors="replace")
        try:
            payload = json.loads(text) if text.strip() else {}
        except json.JSONDecodeError:
            payload = {"_raw_preview": " ".join(text.split())[:320]}
        raise RuntimeError(f"OAuth refresh failed HTTP {status}: {payload}") from None
    except (urllib.error.URLError, TimeoutError) as e:
        raise RuntimeError(f"OAuth refresh network error: {e}") from e
    try:
        out = json.loads(text) if text.strip() else {}
    except json.JSONDecodeError as e:
        raise RuntimeError(f"OAuth refresh invalid JSON: {text[:300]}") from e
    if not isinstance(out, dict):
        raise RuntimeError(f"OAuth refresh invalid payload type: {type(out).__name__}")
    if status != 200:
        raise RuntimeError(f"OAuth refresh unexpected HTTP {status}: {out}")
    if not out.get("access_token"):
        raise RuntimeError(f"OAuth refresh missing access_token: {out!r}")
    return out


def get_token_info(access_token: str, *, timeout_s: float = 20.0) -> dict[str, Any]:
    status, payload = _auth_json_request(
        "GET",
        OAUTH_TOKEN_INFO_URL,
        timeout_s=timeout_s,
        access_token=access_token.strip(),
    )
    if status != 200:
        raise AuthRequestError(f"Token info unexpected HTTP {status}", status=status)
    return payload


def get_session_info(access_token: str, *, timeout_s: float = 20.0) -> dict[str, Any]:
    status, payload = _auth_json_request(
        "GET",
        SESSION_INFO_URL,
        timeout_s=timeout_s,
        access_token=access_token.strip(),
    )
    if status != 200:
        raise AuthRequestError(f"Session info unexpected HTTP {status}", status=status)
    return payload


def jitter_delay(base_s: float) -> float:
    return max(0.0, base_s + random.uniform(0.0, min(1.0, base_s * 0.25)))
