from __future__ import annotations

import json
import ssl
import urllib.error
import urllib.request
from typing import Any


GRAPHQL_URL = "https://my.wealthsimple.com/graphql"
DEFAULT_API_VERSION = "12"


def _assert_query_only(document: str) -> None:
    """Block mutations so orders can never be submitted/finalized via this tool."""
    stripped = document.lstrip()
    if stripped.lower().startswith("mutation"):
        raise ValueError("wsprobe refuses GraphQL mutations (no submit/finalize)")


def identity_id_from_token(token: str) -> str | None:
    parts = token.split(".")
    if len(parts) < 2:
        return None
    payload_b64 = parts[1]
    pad = "=" * (-len(payload_b64) % 4)
    try:
        raw = __import__("base64").urlsafe_b64decode(payload_b64 + pad)
        data = json.loads(raw.decode("utf-8"))
        sub = data.get("sub")
        return str(sub) if sub else None
    except (ValueError, json.JSONDecodeError, UnicodeDecodeError):
        return None


def graphql_request(
    *,
    access_token: str,
    operation_name: str,
    query: str,
    variables: dict[str, Any] | None = None,
    profile: str = "trade",
    timeout_s: float = 30.0,
) -> tuple[int, dict[str, Any] | None, str | None]:
    _assert_query_only(query)

    identity_id = identity_id_from_token(access_token)
    headers = {
        "accept": "*/*",
        "content-type": "application/json",
        "authorization": f"Bearer {access_token}",
        "origin": "https://my.wealthsimple.com",
        "referer": "https://my.wealthsimple.com/",
        "user-agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        "x-ws-api-version": DEFAULT_API_VERSION,
        "x-ws-profile": profile,
        "x-ws-operation-name": operation_name,
        "x-ws-client-library": "wsprobe",
    }
    if identity_id:
        headers["x-ws-identity-id"] = identity_id

    body = json.dumps(
        {
            "operationName": operation_name,
            "query": query,
            "variables": variables or {},
        }
    ).encode("utf-8")

    req = urllib.request.Request(
        GRAPHQL_URL,
        data=body,
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
            return status, json.loads(text), None
        except json.JSONDecodeError:
            return status, None, text

    try:
        return status, json.loads(text), None
    except json.JSONDecodeError:
        return status, None, text


def format_json(data: Any) -> str:
    return json.dumps(data, indent=2, ensure_ascii=False, sort_keys=True)
