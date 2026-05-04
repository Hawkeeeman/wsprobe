# wsli

Wealthsimple CLI (Node.js): read-only GraphQL, Trade REST for accounts / positions / portfolio / funding, read-only `preview-buy`, and real market **buy** / **sell** with `--confirm`.

## Requirements

- [Node.js](https://nodejs.org/) 20+

## Install

From a clone of this repo:

```bash
npm install
npm run build
node dist/index.js --help
```

This repo includes an executable **`wsli`** launcher at the root (runs `node dist/index.js`). If `~/work/wsprobe` is on your `PATH`, the bare command `wsli` works after a new shell (or `source ~/.zshrc`).

**`zsh: command not found: wsli`** — until the repo is on `PATH`, from this directory use any of:

```bash
node dist/index.js ping --json
npm run wsli -- ping --json
npm exec wsli -- ping --json
```

To use the bare `wsli` command: `npm link` in the repo root, then put npm’s global bin on your `PATH` (often `$(npm prefix -g)/bin`; check with `npm prefix -g`). Or: `npm install -g .` from the repo, or `npm install -g wsli` once published.

## Credentials

OAuth bundle is stored at **`~/.config/wsli/session.json`** (see `wsli session-path`).

If you previously used the removed Python tool, **`~/.config/wsprobe/session.json`** is still read automatically when the wsli session file is missing.

## Commands

Run `node dist/index.js --help` (or `npm run wsli -- --help`) and the same with `<command> --help`.

Core commands: `setup`, `onboard`, `snippet`, `config-path`, `session-path`, `import-session`, `ping`, `keepalive`, `lookup`, `security`, `restrictions`, `preview-buy`, `accounts`, `positions`, `portfolio`, `funding`, `buy`, `sell` (buy/sell require `--confirm`), `logs`, `history`.

## Env / flags

- `--token-file`, `--access-token`, `--refresh-token`, `--json`
- `WEALTHSIMPLE_ACCESS_TOKEN`, `WEALTHSIMPLE_REFRESH_TOKEN`, `WEALTHSIMPLE_OAUTH_JSON`, `WEALTHSIMPLE_OAUTH_CLIENT_ID`
- `WSLI_NO_REFRESH` or `WSPROBE_NO_REFRESH`: set to `1` / `true` to skip OAuth refresh

## Develop

```bash
npm run dev -- --help
npm run check
```
