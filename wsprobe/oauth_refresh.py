"""Wealthsimple web OAuth2: refresh access tokens (same host as my.wealthsimple.com)."""

from __future__ import annotations

import json
import ssl
import time
import urllib.error
import urllib.request
from typing import Any

# Public web client id shipped with my.wealthsimple.com (not a user secret).
DEFAULT_OAUTH_CLIENT_ID = (
    "4da53ac2b03225bed1550eba8e4611e086c7b905a3855e6ed12ea08c246758fa"
)

OAUTH_TOKEN_URL = "https://api.production.wealthsimple.com/v1/oauth/v2/token"


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
    timeout_s: float = 30.0,
) -> dict[str, Any]:
    """
    POST /v1/oauth/v2/token with grant_type=refresh_token.
    Returns JSON body (access_token, refresh_token, expires_in, ...).
    """
    rt = refresh_token.strip()
    if not rt:
        raise ValueError("refresh_token is empty")

    body = json.dumps(
        {
            "grant_type": "refresh_token",
            "refresh_token": rt,
            "client_id": client_id,
        }
    ).encode("utf-8")

    req = urllib.request.Request(
        OAUTH_TOKEN_URL,
        data=body,
        headers={
            "accept": "application/json",
            "content-type": "application/json",
            "origin": "https://my.wealthsimple.com",
            "x-wealthsimple-client": "@wealthsimple/wealthsimple",
        },
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
            err_body = json.loads(text)
        except json.JSONDecodeError:
            preview = " ".join(text.split())
            if len(preview) > 320:
                preview = preview[:320] + "..."
            err_body = {"_raw_preview": preview}
        raise RuntimeError(
            f"OAuth refresh failed HTTP {status}: {err_body}"
        ) from None

    if status != 200:
        raise RuntimeError(f"OAuth refresh unexpected HTTP {status}: {text[:500]}")

    try:
        out = json.loads(text)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"OAuth refresh invalid JSON: {text[:300]}") from e

    if not isinstance(out, dict) or not out.get("access_token"):
        raise RuntimeError(f"OAuth refresh missing access_token: {out!r}")

    return out
