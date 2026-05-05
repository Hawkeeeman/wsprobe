# wsli

`wsli` is a Node 20+ CLI for Wealthsimple account, portfolio, and trading workflows. It supports read-only GraphQL and Trade REST calls for accounts, positions, portfolio, funding, plus `preview-buy`, live `buy`, and `sell`.

## Install

```bash
npm install -g wsli
```

Then confirm the CLI is on your `PATH`:

```bash
wsli --help
```

If your shell cannot find `wsli`, ensure npm's global bin directory is on your `PATH`:

```bash
npm prefix -g
```

## Quick start

Set up a session and confirm the default session path:

```bash
wsli setup
wsli session-path
```

The default session file is `~/.config/wsli/session.json`.

## Safety

- `preview-buy` is read-only.
- Live `buy` and `sell` commands require explicit flags and should be treated as real brokerage actions.
- `sell` requires `--confirm`.

## Commands

Use `wsli --help` and `wsli <command> --help` for details.

| Area | Commands |
|------|----------|
| Session | `setup`, `snippet`, `import-session`, `config-path`, `session-path`, `ping`, `keepalive` |
| Market data | `lookup`, `security`, `restrictions` |
| Account | `accounts`, `positions`, `position-for-symbol`, `portfolio` |
| Orders | `preview-buy` (read-only), `buy` (supports `--order market|limit|stop_limit|stop_market`, with `--stop-price` for stop orders), `sell` (supports `--order market|limit`, `--sell-all`, `--confirm` required), `transfer` (internal account transfer with `--from/--to` selectors, `--confirm` required), `trade-smoke` |
| Aliases | `account-alias list`, `account-alias set`, `account-alias remove`, `account-alias-path` |
| Diagnostics | `logs`, `history` |

For `buy --order limit`, `buy --order stop_limit`, and `buy --order stop_market`, use whole shares with `--shares`. Stop-limit requires both `--stop-price` and `--limit-price`; stop-market requires only `--stop-price`.

## Flags and environment

CLI flags:

- `--token-file`
- `--access-token`
- `--refresh-token`

Environment variables:

- `WEALTHSIMPLE_ACCESS_TOKEN`
- `WEALTHSIMPLE_REFRESH_TOKEN`
- `WEALTHSIMPLE_OAUTH_JSON`
- `WEALTHSIMPLE_OAUTH_CLIENT_ID`
- `WSLI_NO_REFRESH=1` or `true` to disable OAuth refresh

For JSON account summaries:

```bash
wsli accounts --json
wsli accounts --json --pretty
```

## From source

```bash
git clone https://github.com/Hawkeeeman/wsli.git
cd wsli
npm install
npm run build
```

Run from the repo with either:

```bash
./wsli --help
npm run wsli -- --help
```

The root `wsli` launcher rebuilds from `src/` when `dist/` is missing or stale, then runs the CLI.

## Develop

```bash
npm run dev -- --help
npm run check
```
