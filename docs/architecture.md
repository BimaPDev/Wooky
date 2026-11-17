# Architecture

## Process model

```
 web / desktop client ──ws /ws──▶ age server ──▶ provider adapters ──▶ claude / cursor-agent / codex / demo
        ▲   (commands, snapshot,       │
        └── pushed events)             ├── orchestrator (pure)
                                       ├── event store (node:sqlite, AGE_HOME/state.sqlite)
                                       ├── effect runner
                                       └── git service (worktrees, checkpoints, diffs)
```

One server per machine owns all state. The desktop app starts the same server and loads
the same web UI, so web and desktop never diverge.

## Write path

1. Client calls `dispatch(command)` with a fresh `commandId`.
2. If a receipt for `commandId` exists, return the original result (`duplicate: true`).
3. `decide(readModel, command, ctx) → { events, effects } | rejection`. Pure. `ctx` supplies
   ids and the clock so tests are deterministic.
4. In one transaction: append events (assign `seq`), store receipt, enqueue effects.
5. Apply events to the in-memory read model, push them to subscribers, ack the client.
6. The effect runner picks up effects in order and records outcomes as events.

An ack means "intent recorded", not "work finished".

## Turn lifecycle

```
turn.start ─▶ turn.started (checkpointBefore captured first)
          ─▶ adapter.runTurn(...)  →  ProviderEvent stream
               session  → thread.sessionBound
               item     → turn.itemUpserted
               delta    → turn.itemDelta          (batched ~30 ms to keep frames cheap)
               approval → turn.itemUpserted(approval) + approval.requested … approval.resolved
               done     → capture checkpointAfter, diff → turn.finished
```

`turn.interrupt` aborts the adapter's `AbortSignal`; the adapter still emits one `done`.
On server start, any turn left `running` is finished as `interrupted`: effects tied to a
lost process are retired, never replayed.

## Checkpoints

Before and after each turn the git service snapshots the working tree into a commit built
from a temporary index (`GIT_INDEX_FILE`), stored at
`refs/age/checkpoints/<threadId>/<turnId>/{before,after}`. User branches, index and stash
are untouched. `turn.revert` restores `before` and drops that turn and later ones from the
read model. Non-git projects run without checkpoints.

## Providers

| Provider | Transport                                                             | Notes                                                                     |
| -------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| claude   | `@anthropic-ai/claude-agent-sdk` `query()`; `canUseTool` → approvals  | resumes with session id                                                   |
| cursor   | `cursor-agent -p --output-format stream-json --stream-partial-output` | `--resume <chatId>`; approval via runtime mode (`--force` only in `full`) |
| codex    | `codex app-server` JSON-RPC over stdio                                | approvals are server requests                                             |
| demo     | scripted, deterministic, free                                         | used by tests and UI work                                                 |

## Read path

Clients call `snapshot` once, then `subscribe({ fromSeq })`. Every push is applied with
`@age/domain`'s `applyEvent`, the same reducer the server uses. A reconnect re-subscribes
from the last applied `seq`; duplicates are ignored by the reducer.
