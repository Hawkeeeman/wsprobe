# wsprobe

Local CLI and optional web UI for Wealthsimple read-only GraphQL checks, plus Trade REST market buys.

## Install

```bash
pip install -e .
```

Use the same Python (or a venv) for `pip` and when you run `wsprobe`, so the console script and the package stay in sync.

**If `wsprobe doctor` is “invalid choice”** another `wsprobe` is earlier on your `PATH` than this project. This package also installs a **`wsp`** command (read-only GraphQL tool only) so you can run it without that conflict:

```bash
wsp doctor
wsp lookup AAPL
```

Or from this repo, `python3 -m wsprobe …` always uses this tree. After `pip install -e .`, run `wsp --version` to confirm the `package: …/wsprobe` path. Reinstall with the same `python3 -m pip` you use to run the tool so PATH scripts match.

## Quick start

```bash
wsp onboard
wsp ping
# or: python3 -m wsprobe
```

`wsp onboard` prints a console snippet for `my.wealthsimple.com`, then waits for you to paste the snippet output back into the terminal and saves it to `~/.config/wsprobe/session.json`.

## Local web UI

```bash
pip install -e '.[web]'
wsprobe-serve
```

Then open `http://127.0.0.1:8765/`.

## Notes

- GraphQL mutations are blocked in `wsprobe/client.py`.
- OAuth refresh is supported using `refresh_token` when available.
- SnapTrade support is optional (`pip install -e '.[trade]'`).
