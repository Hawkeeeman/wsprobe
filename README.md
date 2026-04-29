# wsprobe

Local CLI and optional web UI for Wealthsimple: read-only GraphQL, Trade REST for accounts/portfolio, and optional direct market buys (same OAuth session).

## Install

```bash
pip install -e .
```

Use the same Python (or a venv) for `pip` and when you run `wsprobe`, so the console script and the package stay in sync.

**If `wsprobe setup` is “invalid choice”** another `wsprobe` is earlier on your `PATH` than this project. This package also installs a **`wsp`** command (read-only GraphQL tool only) so you can run it without that conflict:

```bash
wsp lookup AAPL
```

Or from this repo, `python3 -m wsprobe …` always uses this tree. After `pip install -e .`, run `wsp --version` to confirm the `package: …/wsprobe` path. Reinstall with the same `python3 -m pip` you use to run the tool so PATH scripts match.

## Quick start

```bash
wsp setup
wsp keepalive
# or: python3 -m wsprobe
```

`wsp setup` prints a console snippet for `my.wealthsimple.com`, then waits for you to paste the snippet output back into the terminal and saves it to `~/.config/wsprobe/session.json`.

After `wsp setup` (or `wsp import-session`), `wsprobe` now auto-starts `wsp keepalive` in the background by default (disable with `--no-auto-keepalive`).
The background process writes logs to `~/.config/wsprobe/keepalive.log` and PID to `~/.config/wsprobe/keepalive.pid`.
Structured refresh history is also saved to `~/.config/wsprobe/refresh_history.jsonl` and can be viewed with `wsp logs` (or `wsprobe logs`). Clear it with `wsp logs --clear`.
Buy history is saved to `~/.config/wsprobe/buy_history.jsonl` for successful `buy` commands and can be viewed with `wsp history` (or `wsprobe history`). Clear it with `wsp history --clear`.

`wsp keepalive` now uses an adaptive auth probe loop: token health is read from `/v1/oauth/v2/token/info`, probe cadence shifts between active and idle windows using `wsstg::lastActivityTime` and `wsstg::sessionInactivityTimeoutMinutes`, and refresh decisions are driven by live `expires_in` bands (prepare, refresh, and critical windows). Refresh attempts are verified by checking token rollover (`created_at` or a significant `expires_in` jump), with transient retry backoff before session degradation. If refresh still fails, it can recover from a logged-in browser session (disable with `--no-browser-recover`).
`wsp logs --limit 100` is read-only and only prints history; it does not trigger network auth activity.

## Local web UI

```bash
pip install -e '.[web]'
wsprobe-serve
```

Then open `http://127.0.0.1:8765/`.

## Notes

- GraphQL mutations are blocked in `wsprobe/client.py`; market buys use Trade REST (`wsprobe buy`, see `--help`).
- OAuth refresh is supported using `refresh_token` when available.
