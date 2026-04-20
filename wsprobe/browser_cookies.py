from __future__ import annotations

import json
import os
import sys
from typing import Any, Callable, Iterable, Optional
from urllib.parse import unquote
from pathlib import Path


def _parse_oauth2_cookie_value(raw: str) -> Optional[dict[str, Any]]:
    try:
        data = json.loads(unquote(raw))
    except (json.JSONDecodeError, TypeError, ValueError):
        try:
            data = json.loads(raw)
        except (json.JSONDecodeError, TypeError, ValueError):
            return None
    return data if isinstance(data, dict) else None


def oauth2_bundle_from_jar(jar: object) -> Optional[dict[str, Any]]:
    """Return parsed _oauth2_access_v2 JSON (access_token, refresh_token, …) or None."""
    for cookie in jar:
        dom = (getattr(cookie, "domain", None) or "").lower()
        if "wealthsimple.com" not in dom:
            continue
        if cookie.name != "_oauth2_access_v2":
            continue
        raw = cookie.value
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8", errors="replace")
        data = _parse_oauth2_cookie_value(raw)
        if data and data.get("access_token"):
            return data
    return None


def _oauth_access_token_from_jar(jar: object) -> Optional[str]:
    bundle = oauth2_bundle_from_jar(jar)
    if not bundle:
        return None
    tok = bundle.get("access_token")
    return str(tok) if tok else None


def _loaders() -> dict[str, Callable[[], object]]:
    import browser_cookie3 as bc3

    def _with_cookie_candidates(
        loader: Callable[..., object],
        candidates: list[Path],
    ) -> Callable[[], object]:
        def _load() -> object:
            last_exc: Exception | None = None
            for path in candidates:
                if not path.is_file():
                    continue
                try:
                    return loader(cookie_file=str(path))
                except Exception as e:
                    last_exc = e
            if last_exc is not None:
                raise last_exc
            return loader()

        return _load

    opera_candidates = [
        Path.home() / "Library/Application Support/com.operasoftware.Opera/Cookies",
        Path.home() / "Library/Application Support/com.operasoftware.Opera/Default/Cookies",
        Path.home() / "Library/Application Support/com.operasoftware.Opera/Default/Network/Cookies",
    ]
    opera_gx_candidates = [
        Path.home() / "Library/Application Support/com.operasoftware.OperaGX/Cookies",
        Path.home() / "Library/Application Support/com.operasoftware.OperaGX/Default/Cookies",
        Path.home() / "Library/Application Support/com.operasoftware.OperaGX/Default/Network/Cookies",
    ]

    return {
        "chrome": bc3.chrome,
        "chromium": bc3.chromium,
        "edge": bc3.edge,
        "firefox": bc3.firefox,
        "opera": _with_cookie_candidates(bc3.opera, opera_candidates),
        "opera_gx": _with_cookie_candidates(bc3.opera_gx, opera_gx_candidates),
        "brave": bc3.brave,
        "safari": bc3.safari,
        "vivaldi": bc3.vivaldi,
    }


# Order tuned for “most people first” (Chrome/Edge-heavy desktops).
DEFAULT_TRY_BROWSERS: tuple[str, ...] = (
    "chrome",
    "edge",
    "firefox",
    "opera",
    "opera_gx",
    "brave",
    "vivaldi",
    "safari",
    "chromium",
)


def oauth2_bundle_first_available(
    browsers: Iterable[str] | None = None,
) -> tuple[dict[str, Any], str]:
    """Try each browser until _oauth2_access_v2 is found. Returns (bundle dict, browser_name)."""
    try:
        loaders = _loaders()
    except ImportError as e:
        raise SystemExit(
            "Missing dependency. Run: pip install -e .   (includes browser-cookie3)"
        ) from e

    order = tuple(browsers) if browsers is not None else DEFAULT_TRY_BROWSERS
    tried: list[str] = []

    if os.environ.get("WSPROBE_QUIET") != "1":
        print("Looking for a Wealthsimple login in your browsers…", file=sys.stderr)

    for name in order:
        fn = loaders.get(name)
        if fn is None:
            continue
        try:
            jar = fn()
        except Exception:
            tried.append(f"{name} (could not read cookie DB — quit that browser and retry)")
            continue
        bundle = oauth2_bundle_from_jar(jar)
        if bundle and bundle.get("access_token"):
            return bundle, name

    raise SystemExit(
        "No Wealthsimple login found.\n"
        "  1) Open https://my.wealthsimple.com and sign in\n"
        "  2) Quit the browser completely (important on Mac/Windows)\n"
        "  3) Run: wsprobe   or   wsprobe easy\n"
        + (
            "\nTried: " + "; ".join(tried)
            if tried
            else ""
        )
    )


def access_token_first_available(
    browsers: Iterable[str] | None = None,
) -> tuple[str, str]:
    """Try each browser until Wealthsimple OAuth token is found. Returns (token, browser_name)."""
    bundle, name = oauth2_bundle_first_available(browsers)
    tok = bundle.get("access_token")
    assert tok
    return str(tok), name


def oauth2_bundle_from_browser(browser: str) -> dict[str, Any]:
    try:
        loaders = _loaders()
    except ImportError as e:
        raise SystemExit(
            "Missing dependency. Run: pip install -e .   (includes browser-cookie3)"
        ) from e

    b = browser.strip().lower().replace(" ", "_").replace("-", "_")
    aliases = {"opergx": "opera_gx", "gx": "opera_gx"}
    b = aliases.get(b, b)

    fn = loaders.get(b)
    if fn is None:
        raise SystemExit(
            f"Unknown browser {browser!r}. Use one of: {', '.join(sorted(loaders))}"
        )

    try:
        jar = fn()
    except Exception as e:
        raise SystemExit(
            f"Could not read cookies from {browser!r}. "
            "Quit that browser completely (or try another browser), then retry. "
            f"Detail: {e}"
        ) from e

    bundle = oauth2_bundle_from_jar(jar)
    if bundle and bundle.get("access_token"):
        return bundle

    raise SystemExit(
        "No Wealthsimple login cookie found. "
        "Open https://my.wealthsimple.com in that browser, sign in, quit the browser, "
        "then run the same command again."
    )


def access_token_from_browser(browser: str) -> str:
    bundle = oauth2_bundle_from_browser(browser)
    return str(bundle["access_token"])
