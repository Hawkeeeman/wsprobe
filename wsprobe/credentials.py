"""Load OAuth bundle (access + optional refresh) and refresh when the JWT is near expiry."""

from __future__ import annotations

import json
import os
from argparse import Namespace
from pathlib import Path
from typing import Any

from wsprobe.oauth_refresh import (
    DEFAULT_OAUTH_CLIENT_ID,
    access_token_needs_refresh,
    refresh_access_token,
)

CONFIG_DIR = Path.home() / ".config" / "wsprobe"
CONFIG_FILE = CONFIG_DIR / "config.json"
SESSION_FILE = CONFIG_DIR / "session.json"


def _merge_refresh_response(bundle: dict[str, Any], new_tok: dict[str, Any]) -> dict[str, Any]:
    out = dict(bundle)
    out["access_token"] = new_tok["access_token"]
    if new_tok.get("refresh_token"):
        out["refresh_token"] = new_tok["refresh_token"]
    if new_tok.get("expires_in") is not None:
        out["expires_in"] = new_tok["expires_in"]
    if new_tok.get("scope"):
        out["scope"] = new_tok["scope"]
    if new_tok.get("token_type"):
        out["token_type"] = new_tok["token_type"]
    if new_tok.get("created_at") is not None:
        out["created_at"] = new_tok["created_at"]
    return out


def _persist_bundle(path: Path, bundle: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    existing: dict[str, Any] = {}
    if path.is_file():
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                existing = raw
        except json.JSONDecodeError:
            pass
    for key in ("access_token", "refresh_token", "client_id"):
        if key in bundle and bundle[key]:
            existing[key] = bundle[key]
    path.write_text(json.dumps(existing, indent=2, sort_keys=True), encoding="utf-8")


def _load_bundle_from_file(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    if isinstance(data, dict) and data.get("access_token"):
        return data
    return None


def ensure_fresh_access_token(
    bundle: dict[str, Any],
    *,
    persist_path: Path | None,
    force_refresh: bool = False,
) -> str:
    """
    Return a usable access_token, refreshing via refresh_token when JWT is near expiry.
    """
    if os.environ.get("WSPROBE_NO_REFRESH", "").strip() in ("1", "true", "yes"):
        tok = bundle.get("access_token")
        if not tok:
            raise SystemExit("No access_token in credential bundle")
        return str(tok)

    access = bundle.get("access_token")
    if not access:
        raise SystemExit("No access_token in credential bundle")
    access_s = str(access)

    refresh = bundle.get("refresh_token")
    refresh_s = str(refresh).strip() if refresh else ""

    if not force_refresh and not access_token_needs_refresh(access_s):
        return access_s

    if not refresh_s:
        raise SystemExit(
            "Access token is expired or near expiry and no refresh_token is available. "
            "Run wsprobe onboard again, or add refresh_token to your token file / "
            "set WEALTHSIMPLE_REFRESH_TOKEN."
        )

    cid = bundle.get("client_id")
    client_id = str(cid).strip() if cid else DEFAULT_OAUTH_CLIENT_ID
    env_cid = os.environ.get("WEALTHSIMPLE_OAUTH_CLIENT_ID", "").strip()
    if env_cid:
        client_id = env_cid

    try:
        new_tok = refresh_access_token(refresh_s, client_id=client_id)
    except RuntimeError as e:
        raise SystemExit(
            "Access token expired and refresh failed. "
            "Log in at https://my.wealthsimple.com again (or set fresh "
            "WEALTHSIMPLE_ACCESS_TOKEN / refresh_token in config). "
            f"Detail: {e}"
        ) from e

    merged = _merge_refresh_response(bundle, new_tok)
    if persist_path is not None:
        _persist_bundle(persist_path, merged)

    new_access = merged.get("access_token")
    if not new_access:
        raise SystemExit("Refresh succeeded but no access_token in merged bundle")
    return str(new_access)


def load_oauth_bundle(args: Namespace) -> tuple[dict[str, Any], Path | None, str]:
    """
    Resolve OAuth credentials and return (bundle, persist_path, source_label).
    """
    injected = getattr(args, "access_token", None)
    if injected:
        d: dict[str, Any] = {"access_token": str(injected)}
        cli_refresh = getattr(args, "refresh_token", None)
        if cli_refresh:
            cr = str(cli_refresh).strip()
            if cr:
                d["refresh_token"] = cr
        else:
            r = os.environ.get("WEALTHSIMPLE_REFRESH_TOKEN", "").strip()
            if r:
                d["refresh_token"] = r
        cid = os.environ.get("WEALTHSIMPLE_OAUTH_CLIENT_ID", "").strip()
        if cid:
            d["client_id"] = cid
        return d, None, "injected"

    if getattr(args, "token_file", None):
        p = Path(args.token_file).expanduser()
        data = json.loads(p.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or not data.get("access_token"):
            raise SystemExit(f"No access_token in {p}")
        return data, p, f"file:{p}"

    oauth_json = os.environ.get("WEALTHSIMPLE_OAUTH_JSON", "").strip()
    if oauth_json:
        try:
            data = json.loads(oauth_json)
        except json.JSONDecodeError as e:
            raise SystemExit(f"WEALTHSIMPLE_OAUTH_JSON must be valid JSON: {e}") from e
        if not isinstance(data, dict) or not data.get("access_token"):
            raise SystemExit("WEALTHSIMPLE_OAUTH_JSON must be a JSON object with access_token")
        return data, None, "env:oauth_json"

    env = os.environ.get("WEALTHSIMPLE_ACCESS_TOKEN", "").strip()
    if env:
        d = {"access_token": env}
        r = os.environ.get("WEALTHSIMPLE_REFRESH_TOKEN", "").strip()
        if r:
            d["refresh_token"] = r
        cid = os.environ.get("WEALTHSIMPLE_OAUTH_CLIENT_ID", "").strip()
        if cid:
            d["client_id"] = cid
        return d, None, "env"

    if CONFIG_FILE.is_file():
        data = _load_bundle_from_file(CONFIG_FILE)
        if data:
            return data, CONFIG_FILE, f"config:{CONFIG_FILE}"

    session = _load_bundle_from_file(SESSION_FILE)
    if session:
        return session, SESSION_FILE, f"session:{SESSION_FILE}"

    raise SystemExit(
        "No credentials found.\n"
        "Run onboarding once:\n"
        "  wsprobe onboard\n"
        "Or paste JSON into  wsprobe import-session  (see  wsprobe session-path  for file location)\n"
        "Or set WEALTHSIMPLE_OAUTH_JSON (JSON with access_token + optional refresh_token), "
        "or WEALTHSIMPLE_ACCESS_TOKEN / WEALTHSIMPLE_REFRESH_TOKEN / --token-file / "
        f"{CONFIG_FILE}"
    )


def resolve_access_token(args: Namespace) -> str:
    bundle, persist, _src = load_oauth_bundle(args)
    return ensure_fresh_access_token(bundle, persist_path=persist)


def resolve_access_token_force_refresh(args: Namespace) -> str:
    bundle, persist, _src = load_oauth_bundle(args)
    return ensure_fresh_access_token(bundle, persist_path=persist, force_refresh=True)
