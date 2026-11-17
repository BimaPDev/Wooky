# AGE — agent rules

AGE is a local-first workspace for coding agents. It drives the agent CLIs the user
already has installed and signed in to (Claude Code, Cursor Agent, Codex, plus a free
Demo agent), shows what they are doing while they work, and keeps their changes
reviewable. AGE has no model and no account of its own.

## Principles

1. **Bring your own agent.** Never resell, proxy or store credentials. Ask the CLI or SDK
   whether it is signed in; never read its credential files.
2. **Server is authoritative.** Clients (web, desktop) are remote controls: they send
   commands and render pushed events. They never touch the filesystem or providers.
3. **Pure core, messy edges.** Orchestration decides; it does no I/O. All protocol
   weirdness lives in provider adapters and the git service.
4. **Calm and legible.** Show the agent's work as it happens, collapse it when done,
   keep answers readable. No decoration that does not carry meaning.
5. **Performance is a feature.** Small websocket payloads, no continuously repainting
   animations, settled content never re-renders. A dropped frame is a bug.
6. **Isolation and consent.** Parallel threads get their own worktree. Every turn is
   checkpointed under hidden git refs. Gated actions show an approval card with a diff.
7. **Simple first.** The smallest design that behaves correctly. No architecture for show.

## Glossary

- **Provider**: a runtime AGE drives (claude, cursor, codex, demo). **Adapter**: the code
  translating its native protocol into `ProviderEvent`s.
- **Project**: a directory. **Thread**: a durable conversation in a project, bound to a
  provider + model + runtime mode, optionally with its own worktree.
- **Turn**: one prompt → agent work → finish cycle, bracketed by checkpoints.
- **Command**: a client intent (has `commandId`, idempotent). **Event**: a committed
  decision (has gap-free `seq`). **Read model**: `applyEvents(empty, log)`.
- **Handoff**: switching a thread to another provider mid-conversation; the next turn
  receives the prior transcript as context.

## Layout

| Path                 | Owns                                                                    |
| -------------------- | ----------------------------------------------------------------------- |
| `packages/contracts` | zod schemas for the wire and storage. No logic. Imports only `zod`.     |
| `packages/domain`    | Pure read-model reducer + selectors, shared by server and clients.      |
| `apps/server`        | WebSocket RPC, orchestrator, event store, adapters, git, the `age` bin. |
| `apps/web`           | React + Vite UI. Talks to the server only via `/ws`.                    |
| `apps/desktop`       | Electron shell that starts the server and loads the web UI.             |
| `scripts`            | Checks and dev runner.                                                  |

## Architecture in one paragraph

A client sends `dispatch(command)`. The orchestrator validates it against the read model
and returns events plus effects, with no I/O. The event store commits the events, the
command receipt and the effects in one SQLite transaction, then pushes the events to
subscribers. The effect runner performs effects (start a provider turn, capture a
checkpoint, create a worktree) and feeds results back as new commands or internal events.
Adapters emit `ProviderEvent`s, which become `turn.*` events. See `docs/architecture.md`.

## Boundaries (enforced by `pnpm boundaries`)

- `contracts` imports only `zod`; `domain` imports only `@age/contracts`.
- `apps/web` never imports node built-ins or server code.
- `child_process` only under `apps/server/src/{providers,git,terminal,process}/`.
- Never kill by pattern (`pkill`, `killall`). Kill only a PID you spawned.
- Spawn with argv arrays, never `shell: true`.
- Tests wait on events or promises, never on sleeps.
- Every React `useEffect` has a `// sync: <external system>` comment. Derive state in render.
- Web components use CSS variables from `apps/web/src/styles/tokens.css`, never literal colours.

Escape hatch: `// age-allow <rule-id>: <reason>` on the line above, only with a real reason.
For `color` only, `// age-allow-file color: <reason>` as a file's first line exempts the whole file (theme data, tests, fixtures).

## Checks

Node 24 is required (`.nvmrc`; run `nvm use`). It provides the built-in `node:sqlite` used by the event store.

| Command                  | When                                                 |
| ------------------------ | ---------------------------------------------------- |
| `pnpm check:fast`        | Pre-commit hook: prettier, oxlint, boundaries.       |
| `pnpm check`             | Before handing work back: + typecheck, vitest, knip. |
| `pnpm vitest run <file>` | While iterating.                                     |

Test what can break: orchestration decisions, provider protocol translation, event
replay, persistence, git checkpoint/restore, parsing of external formats. Skip tests for
type-guaranteed or trivial code. A bug fix starts with a failing test.

Use the **demo** provider for development and tests. Real provider turns spend the
user's quota; do not run them unless the task says so.

## Coding taste

- Prefer inferred types. No `any`. Validate everything crossing a process boundary with zod.
- Comments are off by default; write one only for a real constraint, in four lines max.
- Transport handlers decode input, call a service, map errors. Nothing else.
- Every "add" has a matching "remove" (project add/remove, worktree create/remove, ...).
- New dependencies need a strong reason. Say it in your hand-back.

## UI taste

- Near-monochrome: layered dark surfaces, warm off-white text, one accent. Colour only for
  meaning: amber = waiting on you, red = error, green/red = diff counts, provider marks.
- Depth from layering and 1px hairlines, not gradients, glows or bevels.
- Inter for UI, a monospace only for code, paths and terminal output. Sentence case. No
  uppercase tracked labels, no emoji, no exclamation marks.
- Motion: short, one-shot, `transform`/`opacity` only. Respect reduced motion. The only
  loop allowed is the working indicator.
- Every interactive element has hover, active and focus-visible states, an accessible name
  and keyboard access.

## Never

- Never write to the user's real data directory (`~/.age`) from tests or dev. Dev uses
  `AGE_HOME=.age-dev`.
- Never commit plans, scratch notes, screenshots or secrets.
- Never start long-lived background processes you do not stop.
