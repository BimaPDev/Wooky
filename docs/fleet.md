# Fleet

A thread can run alone, coordinate other threads, or work as one of them. Fan-out runs
one prompt on several agents at once. The user compares their diffs, picks a winner, and
merges that worktree back into the project branch. Review notes on a diff go back to the
agent as one prompt.

The shapes live in `@wooky/contracts`. `@wooky/domain` folds the events and derives the board.
`decide` currently rejects every fleet command with `not implemented`. The server station
enforces the rules below; the reducer only records events that were accepted.

Older event logs still decode. Every new field on `Thread` is optional, and a snapshot
without `groups` or `reviewNotes` reads as two empty maps.

## Concepts

| Term        | Meaning                                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Solo        | A thread with no `role`. It has not joined a fleet.                                                                               |
| Coordinator | A thread whose `role` is `coordinator`. It spawns workers.                                                                        |
| Worker      | A thread whose `role` is `worker`. Spawned workers set `parentThreadId`. Fan-out workers set `groupId` and no parent.             |
| Group       | `ThreadGroup`. `fanout` shares one prompt across isolated threads. `orchestrated` names the coordinator that spawned its workers. |
| Merge       | `Thread.merge`. Absent until the first attempt to land the worktree branch on the project's current branch.                       |
| Review note | A comment on one diff line (`old` or `new`). Sending them clears them.                                                            |
| Report      | `Thread.report`. The latest summary a spawned worker produced for its coordinator.                                                |

`fleetRows` is the board. It lists every thread.

## Limits

- **Depth 1.** A worker (or any thread that already has `parentThreadId`) cannot spawn. A solo or a coordinator can. The first successful spawn sets the parent's `role` to `coordinator`.
- **8 live workers.** A live worker is a child whose fleet status is `working`, `waiting`, or `idle`. `done` and `failed` do not count. Removed threads are gone.
- **6 fan-out targets.** `fanout.start` takes from 1 to 6 `{ provider, model }` pairs.
- Review note bodies are 1 to 4000 characters. Lines are integers of 1 or more.
- A worker report summary is at most 8000 characters.
- `agents.wait` accepts a timeout up to 600000 ms (ten minutes).

`FLEET_LIMITS` in `@wooky/contracts` is the same set of numbers.

## Commands

Each command carries a `commandId`, like every other command. The events below are what a
successful decision commits. Effects (create a worktree, run a turn, run git) stay in the
server.

### `thread.spawn`

Params: `parentThreadId`, `provider`, `model`, optional `runtimeMode`, `prompt`, optional `title`.

Reject when the parent is missing, the parent is a worker or itself has a parent, or the
parent already has 8 live workers. `runtimeMode` defaults to the parent's. The worker
inherits the parent's project, is `isolate: true`, has `role: "worker"` and
`parentThreadId`, and starts idle with `worktree: null` until `thread.worktreeBound`.

Events, in order:

1. On the parent's first spawn, `group.created` for an `orchestrated` group: new id,
   `coordinatorThreadId` = parent, `threadIds` including the new worker, `prompt` = this
   prompt. Later spawns of the same parent emit `group.created` again with the **same**
   group id and the expanded `threadIds`. The reducer replaces the group.
2. `thread.spawned` `{ thread, parentThreadId }`. The reducer stores the worker (filling
   `role: "worker"` and `parentThreadId` when the payload omitted them), sets the parent's
   role to `coordinator`, and appends the worker to `thread.groupId`'s `threadIds` when
   that group already exists.
3. `turn.started` for the worker, plus a `worktree.create` effect and a `turn.run` effect.
   The same busy and plan-mode rules as `turn.start` apply.

### `fanout.start`

Params: `projectId`, `prompt`, `targets` (1 to 6), `runtimeMode`, optional `title`.

Reject when the project is missing. Creates one `fanout` group and one isolated thread per
target. The threads share `groupId`, use `role: "worker"`, and have no parent. There is no
coordinator.

Events: `group.created` (kind `fanout`, `threadIds` = every new thread, no
`coordinatorThreadId`) and, per target, `thread.created` then `turn.started`, with the
same worktree and turn effects as an isolated `thread.create` plus `turn.start`. Put
`groupId` on each thread in `thread.created`. `groupThreads` follows `threadIds`, not a
scan of `groupId`.

### `fanout.pick`

Params: `groupId`, `threadId`.

Reject when the group is missing or `threadId` is not in `threadIds`. Emits
`group.winnerPicked`. Does not merge.

### `thread.merge`

Params: `threadId`, `strategy` (`merge` or `squash`), optional `message`.

Reject when the thread is missing, `worktree` is null, or a turn is running or waiting.
The project's current branch is the target.

Events: `thread.mergeChanged` with `status: "merging"` and `targetBranch`, then, when git
finishes, another `thread.mergeChanged` with `merged` (and `commit`), `conflict`, or
`failed` (and `message`). The reducer stores the latest `merge` and nothing else.

### `review.addNote` / `review.removeNote` / `review.send`

`review.addNote` params: `threadId`, `path`, `line`, `side` (`old` or `new`), `body`.
Emits `review.noteAdded`. Reject when the thread is missing.

`review.removeNote` params: `threadId`, `noteId`. Emits `review.noteRemoved`. Reject when
the note is not on that thread.

`review.send` params: `threadId`, optional `extra`. Reject when the thread is missing, or
when it has no notes and `extra` is blank. Build the prompt with
`formatReviewPrompt(reviewNotesFor(model, threadId), extra)`. If the thread is busy, emit
`queue.added`; otherwise emit `turn.started` and a `turn.run` effect. Then emit
`review.notesSent` `{ threadId, noteIds }` for the notes that went into the prompt. The
reducer drops those ids. Notes are not sorted in the log; `reviewNotesFor` sorts them by
path, then line, then id.

## Worker reports

When `turn.finished` commits for a thread that has `parentThreadId`, the server also
commits `worker.reported`:

```text
{ coordinatorThreadId, workerThreadId, turnId, summary, diffStat? }
```

`summary` is at most 8000 characters. `diffStat` is `{ files, additions, deletions }` when
the worktree changed. The reducer stores this as `thread.report` on the worker (the
previous report is replaced) and does not touch the coordinator.

The server then dispatches a follow-up on the coordinator: `turn.start` with
`whenBusy: "queue"` when the coordinator is busy, otherwise an immediate turn. The prompt
is `formatWorkerReport`:

```text
Worker <title> (<workerThreadId>) finished turn <turnId>.

<summary>

<files> files, +<additions> -<deletions>
```

The title segment is omitted when the worker has no title. The diff line is omitted when
there is no `diffStat`. Fan-out workers have no parent, so they are not reported; the user
compares them on the board.

This applies to every terminal turn status (`completed`, `interrupted`, `failed`). The
summary says which.

## Board status

`fleetRows(model)` returns one `FleetRow` per thread, newest `updatedAt` first (`threadId`
breaks ties). `lastActivityAt` is `updatedAt`. `role` is the thread's role, or `solo` when
the field is absent. `diffStat` is copied from `thread.report` when present.

Status, first match wins:

1. **waiting** — the running turn has an open approval or question. `waitingOn` is
   `approval` when any approval is open, otherwise `question`.
2. **working** — a turn is running.
3. **failed** — the latest turn failed.
4. **done** — the thread is a worker, or it has a `groupId` and is not the coordinator,
   and the latest turn `completed` or was `interrupted`.
5. **idle** — everything else, including a solo or coordinator whose turn completed, and a
   worker that has not started.

`childrenOf(model, threadId)` lists workers whose `parentThreadId` matches, oldest first.
`groupThreads(model, groupId)` lists `threadIds` in order, skipping ids that have no
thread. `reviewNotesFor` returns the shared empty array when a thread has no notes.

## RPC

`fleet.overview` takes `{}` and returns `FleetRow[]`. Clients can render `fleetRows`
instead; the method exists for the CLI and for anything without the read model.

`git.mergePreview` takes `{ threadId }` and returns `{ targetBranch, ahead, behind, files: { path, additions, deletions }[], conflicts }`. It does not merge.

The agent CLI talks to these methods. They do not take a `commandId`; spawning still
mints one inside the server and dispatches `thread.spawn`.

| Method          | Params                                     | Result                                          |
| --------------- | ------------------------------------------ | ----------------------------------------------- |
| `agents.spawn`  | same as `thread.spawn` without `commandId` | `{ threadId }`                                  |
| `agents.list`   | `{ parentThreadId }`                       | `FleetRow[]` for that parent's children         |
| `agents.wait`   | `{ threadIds, timeoutMs }`                 | `{ finished, pending }`                         |
| `agents.result` | `{ threadId }`                             | `{ status, summary, diffStat?, worktreePath? }` |

`agents.wait` returns when every listed thread is `done` or `failed`, or when `timeoutMs`
elapses. `finished` is the ids that reached one of those two statuses. `pending` is the
rest. `agents.result` reads `thread.report` for `summary` and `diffStat`, and
`worktree.path` for `worktreePath`. `summary` is `""` when the worker has not reported.

## `age agents`

A coordinator calls this from its shell during a turn. It speaks the RPC above to the
local server. `spawn` and `list` use `$AGE_THREAD_ID` as `parentThreadId` and exit with
`AGE_THREAD_ID is not set` when that variable is missing. The server is `$AGE_SERVER_URL`,
or `AGE_HOME/server.json` when that file names a pid that is still alive. Otherwise the
command exits with `AGE server is not running`.

```text
age agents spawn --provider <kind> --model <id> [--title <text>] [--runtime-mode approve|auto-edits|full] [--prompt-file <path>] -- <prompt...>
age agents list [--json]
age agents wait [--timeout <seconds>] <threadId>...
age agents result <threadId> [--json]
```

`--timeout` is seconds, default 600, and is sent as `timeoutMs`. A prompt of `-`, or
`--prompt-file -`, is read from stdin. `spawn` prints the new thread id. `list` prints one
row per child: id, status, provider, model, title. `--json` prints the `FleetRow` array.
`wait` prints one line per id, `<id> finished` or `<id> pending`, then exits 0 when none
are pending and 2 when any remain. `result` prints the status, the summary, the diff stat
when present, and the worktree path. `--json` prints the `AgentResult` object.

The server writes `AGE_HOME/server.json` (`url`, `pid`, `startedAt`) and `AGE_HOME/bin/age`
when it starts, and removes both when it stops. The shim runs this repo's `bin.ts` with
the same Node the server is running under. Turns on a solo or coordinator thread receive
`AGE_THREAD_ID`, `AGE_SERVER_URL`, that `bin` directory on `PATH`, and a short note on how
to delegate. A worker receives a one-line note that it cannot spawn.
