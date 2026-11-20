# Wooky

A local-first workspace for coding agents. Wooky drives the agent CLIs you already have
installed and signed in to (Claude Code, Cursor Agent, Codex) plus a free Demo agent. It has
no model or account of its own. See `AGENTS.md` for the rules and `docs/architecture.md`.

## Requirements

- Node 24 or newer (`.nvmrc`), pnpm 10, git
- At least one agent CLI signed in (Claude Code, Cursor Agent, Codex). The Demo agent needs nothing.

## Run

```sh
pnpm install
pnpm --filter @wooky/web build
pnpm --filter @wooky/server start --port 4317 --web-dist apps/web/dist
# open http://127.0.0.1:4317
```

Desktop window (after the server is running):

```sh
pnpm --filter @wooky/desktop build
# macOS / Linux
WOOKY_DESKTOP_URL=http://127.0.0.1:4317 pnpm --filter @wooky/desktop start
# Windows PowerShell
$env:WOOKY_DESKTOP_URL="http://127.0.0.1:4317"; pnpm --filter @wooky/desktop start
```

`pnpm dev` (server + hot-reload web UI) uses POSIX process groups and is macOS/Linux only for now.
State lives in `~/.wooky` (override with `--home` or `WOOKY_HOME`).

## Checks

`pnpm check` runs format, lint, architecture boundaries, typecheck, tests and unused-code checks.
`pnpm check:fast` is what the pre-commit hook runs.

## Status

The Codex adapter was built against the public protocol docs only and has open review findings
(see `DELEGATION.md`). Windows has not been tested.
