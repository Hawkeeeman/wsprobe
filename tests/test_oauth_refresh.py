"""Unit tests for OAuth refresh helpers (mocked HTTP)."""

from __future__ import annotations

import json
import os
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from wsprobe import oauth_refresh
from wsprobe import credentials
from wsprobe.credentials import ensure_fresh_access_token, load_oauth_bundle


def _jwt_with_exp(exp: int) -> str:
    import base64

    payload = json.dumps({"exp": exp, "sub": "identity-test"}).encode()
    b64 = base64.urlsafe_b64encode(payload).decode().rstrip("=")
    return f"alg.{b64}.sig"


class TestJwtHelpers(unittest.TestCase):
    def test_expired_access_needs_refresh(self) -> None:
        past = int(time.time()) - 3600
        tok = _jwt_with_exp(past)
        self.assertTrue(oauth_refresh.access_token_needs_refresh(tok, skew_seconds=0))

    def test_fresh_access_no_refresh(self) -> None:
        future = int(time.time()) + 3600
        tok = _jwt_with_exp(future)
        self.assertFalse(oauth_refresh.access_token_needs_refresh(tok, skew_seconds=120))


class TestRefreshHttp(unittest.TestCase):
    def test_refresh_posts_expected_json(self) -> None:
        captured: dict = {}

        class Resp:
            status = 200

            def __enter__(self) -> Resp:
                return self

            def __exit__(self, *a: object) -> None:
                return None

            def read(self) -> bytes:
                return json.dumps(
                    {
                        "access_token": "new-access",
                        "refresh_token": "new-refresh",
                        "expires_in": 1800,
                        "token_type": "Bearer",
                    }
                ).encode()

        def fake_open(req: object, timeout: float = 0, context: object = None) -> Resp:
            assert hasattr(req, "data")
            captured["body"] = json.loads(getattr(req, "data").decode())
            return Resp()

        with patch("wsprobe.oauth_refresh.urllib.request.urlopen", side_effect=fake_open):
            out = oauth_refresh.refresh_access_token("old-refresh-token")

        self.assertEqual(captured["body"]["grant_type"], "refresh_token")
        self.assertEqual(captured["body"]["refresh_token"], "old-refresh-token")
        self.assertEqual(captured["body"]["client_id"], oauth_refresh.DEFAULT_OAUTH_CLIENT_ID)
        self.assertEqual(out["access_token"], "new-access")


class TestEnsureFresh(unittest.TestCase):
    def setUp(self) -> None:
        self._old_no_refresh = os.environ.pop("WSPROBE_NO_REFRESH", None)

    def tearDown(self) -> None:
        if self._old_no_refresh is not None:
            os.environ["WSPROBE_NO_REFRESH"] = self._old_no_refresh
        else:
            os.environ.pop("WSPROBE_NO_REFRESH", None)

    def test_no_refresh_env_skips_network(self) -> None:
        os.environ["WSPROBE_NO_REFRESH"] = "1"
        future = int(time.time()) + 10_000
        tok = _jwt_with_exp(future)
        bundle = {"access_token": tok, "refresh_token": "should-not-be-used"}
        out = ensure_fresh_access_token(bundle, persist_path=None)
        self.assertEqual(out, tok)

    def test_expired_without_refresh_exits(self) -> None:
        os.environ.pop("WSPROBE_NO_REFRESH", None)
        past = int(time.time()) - 100
        bundle = {"access_token": _jwt_with_exp(past)}
        with self.assertRaises(SystemExit):
            ensure_fresh_access_token(bundle, persist_path=None)

    def test_expired_triggers_refresh_and_persist(self) -> None:
        os.environ.pop("WSPROBE_NO_REFRESH", None)
        past = int(time.time()) - 100
        old_access = _jwt_with_exp(past)
        bundle = {
            "access_token": old_access,
            "refresh_token": "rt-secret",
        }

        class Resp:
            status = 200

            def __enter__(self) -> Resp:
                return self

            def __exit__(self, *a: object) -> None:
                return None

            def read(self) -> bytes:
                return json.dumps(
                    {
                        "access_token": "refreshed",
                        "refresh_token": "rt-new",
                        "expires_in": 1800,
                    }
                ).encode()

        tmp = Path(__file__).resolve().parent / "_tmp_oauth_test.json"
        if tmp.is_file():
            tmp.unlink()
        try:
            with patch("wsprobe.oauth_refresh.urllib.request.urlopen", return_value=Resp()):
                out = ensure_fresh_access_token(bundle, persist_path=tmp)
            self.assertEqual(out, "refreshed")
            data = json.loads(tmp.read_text(encoding="utf-8"))
            self.assertEqual(data["access_token"], "refreshed")
            self.assertEqual(data["refresh_token"], "rt-new")
        finally:
            if tmp.is_file():
                tmp.unlink()

    def test_force_refresh_even_if_token_not_expiring(self) -> None:
        future = int(time.time()) + 10_000
        bundle = {
            "access_token": _jwt_with_exp(future),
            "refresh_token": "rt-secret",
        }

        class Resp:
            status = 200

            def __enter__(self) -> Resp:
                return self

            def __exit__(self, *a: object) -> None:
                return None

            def read(self) -> bytes:
                return json.dumps({"access_token": "forced-refresh"}).encode()

        with patch("wsprobe.oauth_refresh.urllib.request.urlopen", return_value=Resp()):
            out = ensure_fresh_access_token(bundle, persist_path=None, force_refresh=True)
        self.assertEqual(out, "forced-refresh")


class TestCredentialSourceOrder(unittest.TestCase):
    def test_oauth_json_env_skips_session(self) -> None:
        session_path = Path(__file__).resolve().parent / "_tmp_session_oauthjson.json"
        session_path.write_text(
            json.dumps({"access_token": "wrong", "refresh_token": "x"}),
            encoding="utf-8",
        )
        old_session = credentials.SESSION_FILE
        credentials.SESSION_FILE = session_path
        old_oauth = os.environ.pop("WEALTHSIMPLE_OAUTH_JSON", None)
        try:
            os.environ["WEALTHSIMPLE_OAUTH_JSON"] = json.dumps(
                {"access_token": "from-env-json", "refresh_token": "rt-env"}
            )
            ns = type(
                "Ns",
                (),
                {
                    "access_token": None,
                    "refresh_token": None,
                    "cookies_browser": None,
                    "token_file": None,
                    "command": "ping",
                },
            )()
            bundle, persist, src = load_oauth_bundle(ns)
            self.assertEqual(bundle["access_token"], "from-env-json")
            self.assertEqual(bundle["refresh_token"], "rt-env")
            self.assertIsNone(persist)
            self.assertEqual(src, "env:oauth_json")
        finally:
            credentials.SESSION_FILE = old_session
            if old_oauth is not None:
                os.environ["WEALTHSIMPLE_OAUTH_JSON"] = old_oauth
            else:
                os.environ.pop("WEALTHSIMPLE_OAUTH_JSON", None)
            if session_path.is_file():
                session_path.unlink()

    def test_cli_refresh_pairs_with_access_token(self) -> None:
        ns = type(
            "Ns",
            (),
            {
                "access_token": "acc",
                "refresh_token": "cli-rt",
                "cookies_browser": None,
                "token_file": None,
                "command": "ping",
            },
        )()
        bundle, persist, src = load_oauth_bundle(ns)
        self.assertEqual(bundle["access_token"], "acc")
        self.assertEqual(bundle["refresh_token"], "cli-rt")
        self.assertEqual(src, "injected")

    @patch("wsprobe.browser_cookies.oauth2_bundle_first_available", side_effect=SystemExit(1))
    def test_session_file_used_when_config_missing(
        self, _mock_first_browser: object
    ) -> None:
        """No browser session: fall back to session.json (browser try fails first)."""
        session_path = Path(__file__).resolve().parent / "_tmp_session.json"
        data = {"access_token": "session-token", "refresh_token": "session-refresh"}
        session_path.write_text(json.dumps(data), encoding="utf-8")
        old_session = credentials.SESSION_FILE
        old_config = credentials.CONFIG_FILE
        credentials.SESSION_FILE = session_path
        credentials.CONFIG_FILE = Path(__file__).resolve().parent / "_tmp_missing_config.json"
        try:
            ns = type(
                "Ns",
                (),
                {
                    "access_token": None,
                    "cookies_browser": None,
                    "token_file": None,
                    "command": "ping",
                },
            )()
            bundle, persist, src = load_oauth_bundle(ns)
            self.assertEqual(bundle["access_token"], "session-token")
            self.assertEqual(persist, session_path)
            self.assertTrue(src.startswith("session:"))
        finally:
            credentials.SESSION_FILE = old_session
            credentials.CONFIG_FILE = old_config
            if session_path.is_file():
                session_path.unlink()


if __name__ == "__main__":
    unittest.main()
