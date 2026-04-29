from __future__ import annotations

import json
import os
import sys
from typing import Any, Callable, Iterable, Optional
from urllib.parse import unquote
from pathlib import Path

from wsprobe.oauth_refresh import jwt_exp_unix


class CookieReadError(RuntimeError):
    def __init__(self, browser: str, attempts: list[str]):
        self.browser = browser
        self.attempts = attempts
        super().__init__(self._build_message())

    def _build_message(self) -> str:
        if not self.attempts:
            return "could not read cookie DB"
        return "could not read cookie DB; tried: " + " | ".join(self.attempts)


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
    """Return the freshest parsed _oauth2_access_v2 JSON or None."""
    candidates: list[tuple[int, int, int, dict[str, Any]]] = []
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
        if not data or not data.get("access_token"):
            continue
        created_at = data.get("created_at")
        try:
            created_score = int(created_at) if created_at is not None else 0
        except (TypeError, ValueError):
            created_score = 0
        access = str(data.get("access_token") or "").strip()
        jwt_exp = jwt_exp_unix(access) if access else None
        exp_score = int(jwt_exp) if jwt_exp is not None else 0
        cookie_exp = getattr(cookie, "expires", None)
        try:
            cookie_exp_score = int(cookie_exp) if cookie_exp is not None else 0
        except (TypeError, ValueError):
            cookie_exp_score = 0
        candidates.append((created_score, exp_score, cookie_exp_score, data))
    if not candidates:
        return None
    candidates.sort(key=lambda row: (row[0], row[1], row[2]), reverse=True)
    return candidates[0][3]


def _oauth_access_token_from_jar(jar: object) -> Optional[str]:
    bundle = oauth2_bundle_from_jar(jar)
    if not bundle:
        return None
    tok = bundle.get("access_token")
    return str(tok) if tok else None


def _loaders() -> dict[str, Callable[[], object]]:
    import browser_cookie3 as bc3

    def _expand_globs(base: Path, patterns: list[str]) -> list[Path]:
        out: list[Path] = []
        seen: set[Path] = set()
        for pat in patterns:
            for p in base.glob(pat):
                rp = p.resolve()
                if rp in seen:
                    continue
                seen.add(rp)
                out.append(rp)
        return out

    def _candidate_paths(browser: str) -> list[Path]:
        home = Path.home()
        appdata = Path(os.environ.get("APPDATA", ""))
        localapp = Path(os.environ.get("LOCALAPPDATA", ""))

        if sys.platform == "darwin":
            base = home / "Library/Application Support"
            chromium_based: dict[str, list[str]] = {
                "chrome": ["Google/Chrome/Default/Network/Cookies", "Google/Chrome/Default/Cookies"],
                "edge": ["Microsoft Edge/Default/Network/Cookies", "Microsoft Edge/Default/Cookies"],
                "brave": ["BraveSoftware/Brave-Browser/Default/Network/Cookies", "BraveSoftware/Brave-Browser/Default/Cookies"],
                "vivaldi": ["Vivaldi/Default/Network/Cookies", "Vivaldi/Default/Cookies"],
                "chromium": ["Chromium/Default/Network/Cookies", "Chromium/Default/Cookies"],
                "opera": [
                    "com.operasoftware.Opera/Cookies",
                    "com.operasoftware.Opera/Default/Cookies",
                    "com.operasoftware.Opera/Default/Network/Cookies",
                ],
                "opera_gx": [
                    "com.operasoftware.OperaGX/Cookies",
                    "com.operasoftware.OperaGX/Default/Cookies",
                    "com.operasoftware.OperaGX/Default/Network/Cookies",
                ],
            }
            if browser in chromium_based:
                return [base / rel for rel in chromium_based[browser]]
            if browser == "firefox":
                return _expand_globs(
                    home / "Library/Application Support/Firefox/Profiles",
                    ["*/cookies.sqlite"],
                )
            return []

        if sys.platform.startswith("win"):
            chromium_roots: dict[str, list[Path]] = {
                "chrome": [localapp / "Google/Chrome/User Data/Default"],
                "edge": [localapp / "Microsoft/Edge/User Data/Default"],
                "brave": [localapp / "BraveSoftware/Brave-Browser/User Data/Default"],
                "vivaldi": [localapp / "Vivaldi/User Data/Default"],
                "chromium": [localapp / "Chromium/User Data/Default"],
                "opera": [appdata / "Opera Software/Opera Stable"],
                "opera_gx": [appdata / "Opera Software/Opera GX Stable"],
            }
            if browser in chromium_roots:
                out: list[Path] = []
                for root in chromium_roots[browser]:
                    out.append(root / "Network/Cookies")
                    out.append(root / "Cookies")
                return out
            if browser == "firefox":
                return _expand_globs(appdata / "Mozilla/Firefox/Profiles", ["*/cookies.sqlite"])
            return []

        chromium_roots_linux: dict[str, list[Path]] = {
            "chrome": [home / ".config/google-chrome/Default"],
            "edge": [home / ".config/microsoft-edge/Default"],
            "brave": [home / ".config/BraveSoftware/Brave-Browser/Default"],
            "vivaldi": [home / ".config/vivaldi/Default"],
            "chromium": [home / ".config/chromium/Default"],
            "opera": [home / ".config/opera"],
            "opera_gx": [home / ".config/opera-gx"],
        }
        if browser in chromium_roots_linux:
            out = []
            for root in chromium_roots_linux[browser]:
                out.append(root / "Network/Cookies")
                out.append(root / "Cookies")
            return out
        if browser == "firefox":
            return _expand_globs(home / ".mozilla/firefox", ["*/cookies.sqlite"])
        return []

    def _with_cookie_attempts(
        loader: Callable[..., object],
        browser: str,
        candidates: list[Path],
    ) -> Callable[[], object]:
        def _load() -> object:
            attempts: list[str] = []
            for path in candidates:
                if not path.is_file():
                    attempts.append(f"{path} [missing]")
                    continue
                try:
                    return loader(cookie_file=str(path))
                except Exception as e:
                    attempts.append(f"{path} [{type(e).__name__}: {e}]")
            try:
                return loader()
            except Exception as e:
                attempts.append(f"<browser-cookie3 default lookup> [{type(e).__name__}: {e}]")
                raise CookieReadError(browser, attempts) from e
            if attempts:
                raise CookieReadError(browser, attempts)
            raise CookieReadError(browser, ["<no candidate paths discovered>"])

        return _load

    base_loaders: dict[str, Callable[..., object]] = {
        "chrome": bc3.chrome,
        "chromium": bc3.chromium,
        "edge": bc3.edge,
        "firefox": bc3.firefox,
        "opera": bc3.opera,
        "opera_gx": bc3.opera_gx,
        "brave": bc3.brave,
        "safari": bc3.safari,
        "vivaldi": bc3.vivaldi,
    }
    wrapped: dict[str, Callable[[], object]] = {}
    for name, loader in base_loaders.items():
        wrapped[name] = _with_cookie_attempts(loader, name, _candidate_paths(name))
    return wrapped


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
        except Exception as e:
            detail = str(e).strip() if str(e).strip() else "could not read cookie DB"
            tried.append(f"{name} ({detail})")
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


def wealthsimple_request_context_first_available(
    browsers: Iterable[str] | None = None,
) -> dict[str, str]:
    """
    Return best-effort browser request context for wealthsimple.com:
    browser name, cookie header value, and selected cookie values.
    """
    try:
        loaders = _loaders()
    except ImportError:
        return {}
    order = tuple(browsers) if browsers is not None else DEFAULT_TRY_BROWSERS
    for name in order:
        fn = loaders.get(name)
        if fn is None:
            continue
        try:
            jar = fn()
        except Exception:
            continue
        cookie_pairs: list[tuple[str, str]] = []
        selected: dict[str, str] = {}
        for cookie in jar:
            dom = (getattr(cookie, "domain", None) or "").lower()
            if "wealthsimple.com" not in dom:
                continue
            cname = str(getattr(cookie, "name", "") or "")
            cval_raw = getattr(cookie, "value", "")
            cval = cval_raw.decode("utf-8", errors="replace") if isinstance(cval_raw, bytes) else str(cval_raw)
            if not cname or not cval:
                continue
            cookie_pairs.append((cname, cval))
            if cname in ("wssdi", "_cfuvid", "ws_global_visitor_id"):
                selected[cname] = cval
        if not cookie_pairs:
            continue
        # Preserve first-seen order while deduplicating by name.
        seen: set[str] = set()
        header_parts: list[str] = []
        for cname, cval in cookie_pairs:
            if cname in seen:
                continue
            seen.add(cname)
            header_parts.append(f"{cname}={cval}")
        if not header_parts:
            continue
        out = {"browser": name, "cookie_header": "; ".join(header_parts)}
        out.update(selected)
        return out
    return {}
