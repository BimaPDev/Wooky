# Brain

Wooky Brain is memory the agents Wooky runs can share: preferences, decisions, conventions,
gotchas and playbooks that outlive a thread. It borrows tiered loading from OpenViking and a
queryable store of typed records from Omnigraph, and stays native to Wooky: plain Markdown
files, one SQLite cache, no model and no embeddings.

This page is the design for all five steps. B1 and B2 exist today.

| Step | What                                                                                                                     | State |
| ---- | ------------------------------------------------------------------------------------------------------------------------ | ----- |
| B1   | Contracts, file store, path and secret safety, FTS5 index, deterministic overviews                                       | done  |
| B2   | Server RPC, caller permissions, the inbox, and `wooky mcp` tools `brain_ls`, `brain_read`, `brain_search`, `brain_write` | done  |
| B3   | L0 injection into turn prompts within a token budget; fleet-run claims and handoffs (`brain_claim`, `brain_release`)     | next  |
| B4   | Post-turn and post-fleet-run extraction by a cheap model; the inbox; LLM-written overviews                               |       |
| B5   | Web Brain panel: tree, viewer, editor, inbox                                                                             |       |

## Two scopes

| Scope   | URI                                  | Lives in                      | Trust  |
| ------- | ------------------------------------ | ----------------------------- | ------ |
| Global  | `brain://global/<path>`              | `<WOOKY_HOME>/brain/global/`  | `user` |
| Project | `brain://project/<projectId>/<path>` | `<projectRoot>/.wooky/brain/` | `repo` |

The global brain holds what is true across projects: the user's preferences, lessons, notes on
models and providers, playbooks. It is the user's own data and never leaves their machine.

The project brain sits next to `.claude` and `.cursor` and is committed with the repo. It holds
architecture notes, decisions, conventions and gotchas, so a teammate who clones the repo and
runs an agent gets them too.

Live fleet-run state (claims, handoffs, findings while workers run) is temporary and is not a
memory. It goes in SQLite under `WOOKY_HOME`, never in repo files (B3).

## Memories

A memory is a Markdown file under a scope, addressed by a URI:

```
---
summary: "Use pnpm, never npm; the lockfile is pnpm-lock.yaml"
kind: "convention"
tags: ["tooling"]
status: "active"
updatedAt: "2026-11-23T10:00:00.000Z"
source: {"threadId":"thread_1","agent":"claude","at":"2026-11-23T10:00:00.000Z"}
---

Free-form Markdown body.
```

Every frontmatter value is a JSON value on one line. That is valid YAML, so other tools can read
the file, and our parser stays a few lines long.

| Field       | Rule                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------- |
| `summary`   | Required. One line, at most 200 characters. This is L0.                                           |
| `kind`      | `preference`, `decision`, `convention`, `gotcha`, `lesson`, `playbook`, `provider-note`, `note`   |
| `tags`      | Up to 12 lowercase tags, each up to 40 characters.                                                |
| `status`    | `active`, `proposed` or `archived`.                                                               |
| `pinned`    | Optional boolean. B3 always injects pinned L0.                                                    |
| `updatedAt` | ISO time. The store stamps it on every write; it moves strictly forward.                          |
| `source`    | Optional: `threadId`, `turnId`, `fleetRunId`, `agent`, `at`. Where an automatic memory came from. |

### Paths

A path is at most 6 segments. Each segment is lowercase `[a-z0-9][a-z0-9._-]*`, up to 64
characters. A path ending in `.md` is a memory; anything else is a folder. Rejected: `..`,
absolute paths, backslashes, empty segments, NUL, `%` (so no percent-encoding tricks), uppercase,
a leading dot, a trailing dot, Windows device names, and `.md` on any folder. `_overview.md` is
reserved for L1 and can never be written as a memory, because `_` is not a valid first character.

### Reading and writing

Writing is strict: unknown frontmatter fields, a bad `kind`, a multi-line or over-long summary,
or a caller-supplied `updatedAt` is an error naming the field. Reading is forgiving, because
people edit these files by hand and a repo can hold anything. A bad field falls back to a
default. A file with no frontmatter is a `note` whose summary is its first line and whose
`updatedAt` is the file's mtime. Nothing a human wrote makes a read fail.

Writes are atomic (a temp file in the same folder, then rename). `expectedUpdatedAt` makes a
write conditional: if the file's current `updatedAt` differs, or the file is missing, the write
fails with `conflict` and the message carries the current value. `expectedUpdatedAt: null` means
create-only: the file must not exist, and `conflict` is returned if it does. Leaving the option out
is an unconditional write. `.wooky/brain/` is created by
the first write and never by a read.

Caps: body at most 16 KB, summary at most 200 characters, at most 2000 memories per scope.
Hand-edited files over 64 KB are not read or indexed.

## Tiered loading

| Tier | Source                                | Use                                                     |
| ---- | ------------------------------------- | ------------------------------------------------------- |
| L0   | `summary` in the memory's frontmatter | Listings, search hits, and prompt injection (B3)        |
| L1   | `_overview.md` in each folder         | What a folder holds, so an agent can pick where to look |
| L2   | The body                              | Read on demand                                          |

`read(uri, tier)`: for a memory, tier 0 is the frontmatter with an empty body and tiers 1 and 2
add the body. A memory has no middle layer; its L1 is its folder's overview. For a folder, tier 0
is the overview's summary line and tiers 1 and 2 are the overview.

In B1 an overview is generated deterministically on every write, removal or archive in that
folder and in every folder above it (their counts change too). It lists each child memory's
summary and kind and each subfolder with its memory count, up to 80 memories and 40 folders.
Archived memories are left out. The file carries the tag `auto`. An overview without that tag was
written by a person (or by B4's model) and is never overwritten. An empty folder loses its
overview and is removed.

## Retrieval

Search is SQLite FTS5 with BM25 ranking at `<WOOKY_HOME>/brain/index.sqlite`, with filters on
scope and path prefix. Columns are weighted: summary 6, tags 3, path 2, body 1. Terms use the
`porter unicode61` tokenizer, so `install` finds `installing`. There are no embeddings in v1.

The index is a cache. Everything in it can be rebuilt from the files, so a missing, corrupt
(`SQLITE_CORRUPT`, `SQLITE_NOTADB`) or old-schema index is deleted and rebuilt. A locked or
otherwise unopenable index is not: that is reported as `unavailable` or `internal`, and the file
stays. Queries wait up to 2 seconds for another connection's lock (`busy_timeout`), and a sync
takes the write lock up front (`BEGIN IMMEDIATE`). A search first syncs the scopes it covers:

1. Scan the scope's root (symbolic links skipped and logged).
2. Compare each file's mtime and size to the indexed row. Equal means unchanged.
3. Otherwise hash the content; an equal hash only refreshes the row.
4. Rows whose files are gone are dropped.

A file modified within 2 seconds of when it was indexed is always re-hashed, because a second edit
in the same filesystem clock tick can keep the same mtime and size. A file whose mtime is more than
2 seconds in the future is hashed once and then trusted while its mtime and size stay the same, so
a skewed clock or a `touch -d` does not make every search re-read it.

The query is reduced to lowercase letter and digit words (at most 16, each quoted and joined with
`OR`) before it reaches FTS5. Operators, quotes, `NEAR`, column filters and `*` have no meaning;
`"foo" OR bar*` is searched as the words foo, or, bar and cannot raise a syntax error.

### FTS5 availability

FTS5 is probed at runtime: opening the index tries `CREATE VIRTUAL TABLE temp.fts5_probe USING
fts5(x)`. On Node 24.18.0 (macOS) that succeeds, and tests run both modes. If a build ever lacks
FTS5, the index falls back to an ordinary table, and the search reads the candidate rows and scores
them in JavaScript (summary 6, tags 3, path 2, body 1 per matching term). There is no `LIKE`. It
returns the same shape with cruder ranking. The mode is
part of the schema version, so switching rebuilds the tables.

## Approval policy

| Origin                                                | Where it goes               | Status                                 |
| ----------------------------------------------------- | --------------------------- | -------------------------------------- |
| Project memory written by an agent (B2, B4)           | `.wooky/brain/` directly    | `active`, with `source`, not pinned    |
| Global memory written by an agent (B2, B4)            | `<WOOKY_HOME>/brain/inbox/` | `proposed`, until the user approves    |
| Global write that asks to `propose` (B2, `wooky mcp`) | `<WOOKY_HOME>/brain/inbox/` | `proposed`, with an anonymous `source` |
| Anything the user writes themselves                   | Where they put it           | What they set                          |

Project memories are saved straight away because they are reviewable in the repo diff and
revertable in git. Global ones are not, so they wait.

## Caller identity and permissions

Every brain RPC takes an optional `agentToken`, the same HMAC token `wooky agents` uses. The
server turns it into a caller:

| Token                                      | Caller                                                                                 |
| ------------------------------------------ | -------------------------------------------------------------------------------------- |
| absent                                     | `user`: the app, the web panel, a person at a terminal, or a host that did not pass it |
| valid                                      | `agent`: bound to one thread, and through it one project and one provider              |
| present but invalid, or its thread is gone | `forbidden`                                                                            |

| Operation                              | `user`                         | `agent`                                                          |
| -------------------------------------- | ------------------------------ | ---------------------------------------------------------------- |
| `list`, `read`, `search`               | any scope                      | global and its own project; another project is `forbidden`       |
| `write` to global                      | direct, unless `propose: true` | always queued in the inbox, whatever it asks for                 |
| `write` to a project                   | any project                    | its own project only, direct; `pinned` dropped; `source` stamped |
| `archive`, `remove`                    | any scope                      | its own project only; global is `forbidden`                      |
| `reindex`, `inbox.list/approve/reject` | yes                            | `forbidden`                                                      |

`propose` is downgrade-only. A global write with `propose: true` goes to the inbox even for a
`user` caller, and nothing makes a write more privileged. `wooky mcp` sends it on every global
write unless it was started with `--allow-global-write`, because many MCP hosts pass an
environment allowlist and the token would never arrive; without `propose` a missing token would
mean "user". Failing closed costs a person an extra click and costs an injected agent its write.

An agent cannot set `pinned`: it is dropped from agent project writes and from proposals, so
pinning is always a user action (a user write, or `inbox.approve` with edits). `status` on a
proposal is always `proposed`, and `active` once approved. The server stamps `source`
(`threadId`, `agent`, `at`) over anything the agent sent. A proposal that has no thread (a
tokenless `propose`) gets `source.agent = "mcp"`, so it is still seen as agent-authored.

**Limit.** The token is a capability held in the agent's environment, and every client on the
loopback port is "local". This model confines agents that only use tools. An agent with a shell
can read its own token, call the RPC without one (becoming `user`), or write the files directly.
Paired remote devices keep full user-level brain access, because they can already prompt agents
and approve their work. Agents can overwrite project memories a person wrote: a project brain is
reviewed in the repo diff, not guarded by the server.

### Provenance and trust

The store reports `trust: "user"` for global and `"repo"` for project, and then downgrades: a
global memory whose frontmatter carries an agent `source` (`threadId`, `agent`, `turnId` or
`fleetRunId`) is `repo`, so it stays fenced as data after the user approves it. The rule is in
`brain/trust.ts`: `isAgentAuthored(frontmatter)` and `effectiveTrust({ trust, frontmatter })`.
`read`, `list` and `search` apply it already. B3's context builder takes `trust` from those
results; anything that builds a prompt from raw frontmatter must call `effectiveTrust`, never read
the scope alone. A person who rewrites an approved memory by hand and drops `source` makes it
theirs.

## The inbox

Agent proposals for global memories wait in `<WOOKY_HOME>/brain/inbox/`, one file per proposal:
`<id>.json`, with `id` matching `[a-z0-9][a-z0-9_-]{0,127}`.

```json
{
  "id": "prop_...",
  "targetUri": "brain://global/lessons/pnpm.md",
  "frontmatter": {
    "summary": "...",
    "kind": "lesson",
    "tags": [],
    "status": "proposed",
    "updatedAt": "...",
    "source": { "threadId": "...", "agent": "claude", "at": "..." }
  },
  "body": "...",
  "createdAt": "2026-11-23T10:00:00.000Z",
  "baseUpdatedAt": null
}
```

`baseUpdatedAt` is the target's `updatedAt` when the proposal was made, or `null` when the target
did not exist.

- **Checks** are the store's: path, body size, frontmatter, and the secret scan, all at proposal
  time. A file that does not parse is skipped and logged.
- **Caps.** At most 200 proposals in all, and at most 20 per thread. A new proposal for the same
  target from the same thread replaces that thread's earlier one. Beyond a cap the write fails with
  `conflict`.
- **Approve** writes the memory as `active` with `expectedUpdatedAt = baseUpdatedAt`, so it returns
  `conflict` if the target changed or appeared after the proposal; two proposals for one target
  cannot both land. The proposal stays until the user resolves it. `inbox.approve` also takes
  `edits: { frontmatter, body }`: the edited version is validated, written under the same condition
  and the proposal deleted in one step, never write-then-reject. An edit that omits `source` keeps
  the proposal's.
- **Approve is idempotent.** After the write, the file is removed (retried once). If that fails the
  proposal is marked spent (in memory, and `consumedAt` in the file if it can be rewritten),
  hidden from the list and never applied again.
- **List** adds `overwrites` and `existingSummary` when the target exists now, and `stale` when it
  differs from `baseUpdatedAt`, so a panel can warn before the user approves.
- **Reject** deletes the file.

## RPC

All brain methods are in `packages/contracts/src/rpc.ts`, and each accepts `agentToken`.

| Method                | Params                                                                                             | Result                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `brain.list`          | `uri`, `includeArchived?`                                                                          | `BrainTreeNode[]`                                            |
| `brain.read`          | `uri`, `tier`                                                                                      | `BrainEntry`                                                 |
| `brain.search`        | `query`, `scopes`, `pathPrefix?`, `limit?`, `includeArchived?`                                     | `BrainSearchHit[]`                                           |
| `brain.write`         | `uri`, `frontmatter`, `body`, `expectedUpdatedAt?` (string, or `null` for create-only), `propose?` | `{ uri, updatedAt, created, queued, proposalId?, message? }` |
| `brain.archive`       | `uri`                                                                                              | `{ uri, updatedAt, created }`                                |
| `brain.remove`        | `uri`                                                                                              | `{ ok: true }`                                               |
| `brain.reindex`       | `scope?`                                                                                           | counts and `scopes`                                          |
| `brain.inbox.list`    |                                                                                                    | proposals with `overwrites`, `existingSummary?`, `stale`     |
| `brain.inbox.approve` | `id`, `edits?`                                                                                     | `{ id, uri, updatedAt, created }`                            |
| `brain.inbox.reject`  | `id`                                                                                               | `{ id, ok: true }`                                           |

Errors are `bad_request`, `not_found`, `conflict`, `forbidden`, `internal`. A missing project
folder says `Project folder is missing for <id>.` and never names a path.

## MCP tools

`wooky mcp` exposes `brain_ls`, `brain_read`, `brain_search` and `brain_write` next to the task
tools. Flags:

- `--read-only`: no `brain_write`.
- `--projects id,id`: project URIs and scopes outside the list are refused before any RPC. Global
  stays reachable.
- `--allow-global-write`: a global `brain_write` with no agent token saves directly instead of
  going to the inbox. Use it only for a client a person drives. It never affects a call that does
  carry a token, which is always queued.

`brain_write` takes `uri`, `summary`, `kind`, `body`, `tags?`, `status?` and `expectedUpdatedAt?`.
There is no `pinned`. Without `expectedUpdatedAt` it is a create and fails with `conflict` if the
memory exists; to update, read the memory and pass its `updatedAt`.

Memory text reaches the agent as data. Anything with `trust: "repo"` (project memories and
agent-authored global ones) is wrapped as `<repo-memory-<nonce> uri="..." untrusted="true">` ...
`</repo-memory-<nonce>>`, where the nonce is 16 random hex digits chosen for each call, preceded by
a line saying it is project data and not instructions. Inside, text is NFKC-folded, zero-width and
bidi characters are dropped, and every `<` and `>` (including full-width and `‹ ›` look-alikes) is
escaped. B3's `sanitize` in `brain/context.ts` does the same; the two copies are separate on
purpose (B3 lives on another branch) and should be merged into one helper later.

### How the token reaches `wooky mcp`

Wooky puts `WOOKY_THREAD_ID`, `WOOKY_SERVER_URL`, `WOOKY_AGENT_TOKEN` and a `PATH` with the
`wooky` shim into the environment of every provider child it starts (Claude, Codex, Cursor,
OpenCode, ACP agents). It does not add a `wooky` MCP server to any session: a person configures
`wooky mcp` in the host CLI (`docs/mcp.md`). So the token reaches `wooky mcp` only if the host
passes its own environment on to MCP servers, and many do not (an environment allowlist). That is
why a missing token must not mean "user" for a write, and why `propose` exists. If Wooky ever
injects the server itself, it should list `WOOKY_AGENT_TOKEN` in the server's own `env` entry so it
survives an allowlist: Claude Code (`mcpServers.<name>.env`), Codex (`mcp_servers.<name>.env`) and
ACP agents (`mcpServers: [{ name, command, args, env: [{ name, value }] }]`, which OpenCode also
takes) all can. Cursor Agent reads `.cursor/mcp.json` and has no per-session MCP option, so it
cannot.

## Security

A project brain arrives with cloned repos. It is untrusted input, as untrusted as any file in the
repo, and the store treats it that way.

- **Never leave the root.** Before every read, write, list and scan, each component from the
  project folder (or `WOOKY_HOME`) down is `lstat`-ed. Any symbolic link is refused, including
  `.wooky` and `.wooky/brain` themselves, and the real path must stay under the root. Files are
  opened with `O_NOFOLLOW` and checked with `fstat`. Scans and reindexing skip links and log them,
  and never follow them. A hostile brain therefore cannot make Wooky read or overwrite
  `~/.ssh/...` through a link. A race that swaps a path after the check is not defended
  against beyond `O_NOFOLLOW`; the attacker would need to be running code on the machine already.
- **Bounded.** A listing reads at most 5000 directory entries, and reading stops when its budget is
  gone. A `list` shares one budget between its listing and its folder counts. A walk of the whole
  brain (the memory-count check on a write, the overview refresh, a reindex) gets
  `3 * 2000 + 1000 = 7000` entries: room for the memory cap, an `_overview.md` per folder and the
  folders themselves, so any valid brain under the cap is counted exactly, even one folder per
  memory. A write uses two such budgets, each its own: one for the memory-count check, one for the
  walk that refreshes overviews. That refresh walks the whole brain once and derives every
  ancestor's count from that single walk, so it costs one tree, not one per level. If the walk is
  cut short (a tree past that ceiling) its counts would be wrong, so the overviews are left exactly
  as they were and the write still succeeds (it is logged). Walks go at most 6 levels deep. In a
  `list` or an overview that is not stored yet, a folder count that was cut short is marked
  `capped` (and shown as `N+`); a written `_overview.md` never says `N+`.
- **Trust field.** Every result (`BrainEntry`, `BrainSearchHit`, `BrainTreeNode`) carries `trust`:
  `"user"` for global, `"repo"` for project. B3 uses it to fence repo content in prompts as data
  to consider, not instructions to follow. Frontmatter `summary` text is repo content too.
- **No secrets.** Writes are scanned and rejected for AWS access keys (`AKIA…`) and secret keys
  (only next to `aws…secret` context), GitHub tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`,
  `github_pat_`), GitLab (`glpat-`), `sk-` and `sk-ant-` keys, Stripe (`sk_live_`, `rk_live_`,
  `sk_test_`), Google (`AIza…`), npm (`npm_…`), Hugging Face (`hf_…`), SendGrid (`SG.…`), Slack
  tokens (`xox?-`) and webhook URLs, PEM and PGP private keys, JWT-shaped tokens, URLs with
  `user:password@` (or `:password@` with no user), `Authorization: Bearer …`, and
  `password|passwd|secret|token|api_key|api key = <16+ character value>` (letters, digits and
  common symbols with high entropy; for an api key, letters alone are enough unless the value is a
  camelCase identifier such as `XApiKeyHeaderName`). Placeholders are not flagged: URL passwords
  `password`, `pass`, `secret`, `changeme`, `guest`, `root`, `example`, `test` or equal to the user
  name (unless it looks random), template placeholders (`${VAR}`, `$VAR`, `<…>`, `{{…}}`,
  `%(…)s`, `%VAR%`; a leading `%` or `$` alone is not one, so a percent-encoded password is
  flagged), and passwords that do not look random on `localhost`, `127.0.0.1` or `::1` (not when
  the authority holds another `@`: the host is what follows the last one). Up to 16 spaces may
  surround the `=` or `:`. A value on a later line is found when it follows the key within two
  blank lines, indented by up to 64 characters, with an optional `|` or `>` block marker (`-` or
  `+` chomping) after the key; a value any further away is not found.
  Frontmatter over 8 KB serialized is refused with `bad_request` before it is scanned; below that,
  every key and every string value is scanned as the writer spelled it (JSON escaping would hide a
  quoted value) and as serialized. The body is scanned too, all before the frontmatter is
  validated. The error names the pattern and the line, never the value, and no error ever
  contains an unrecognized key or a rejected value. The scan is a net for accidents, not
  a guarantee: do not rely on it to make a hostile write safe.
- **Capped.** Body, summary and count caps above.

## Hardening

What a hostile repo or a bad file cannot do to the store, and where the test is.

| Defense                                                                                                                                       | Test                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Every secret pattern is linear: bounded repetitions, lookbehind anchors, lines scanned in windows of 4096 plus a bounded line-pair pass       | `safety.test.ts` (time)                 |
| A project brain that overlaps the global brain's folder, or a project that is the data folder, is `forbidden`                                 | `hardening.test.ts` (overlaps)          |
| `read` never throws on file content: a bad `updatedAt` (year 10000, `+010000`, `-000001`) or mtime falls back; unknown frontmatter is a note  | `frontmatter.test.ts`, fuzz             |
| Nothing but a `ServiceError` leaves the store; logs name an error code, never a dump, and add the stack only for a bug (not fs or SQLite)     | `hardening.test.ts` (guard)             |
| Scan budgets: memory count and overview refresh each get their own; one walk gives every ancestor's count; a cut-short walk leaves overviews  | `hardening.test.ts` (scan budget)       |
| Case-insensitive filesystems: a path whose on-disk spelling differs is not found for reads and refused for writes                             | `hardening.test.ts` (letter case)       |
| Project files with other hard links are not read, listed or indexed                                                                           | `hardening.test.ts` (hard links)        |
| Secrets are scanned before validation and never echoed, including keys                                                                        | `hardening.test.ts`, `safety.test.ts`   |
| A `WOOKY_HOME` that does not exist yet is resolved through its nearest existing ancestor, so a symlinked parent is fine                       | `hardening.test.ts` (symlink)           |
| The index is deleted only when corrupt (in `search` and `reindex`); a failed ROLLBACK keeps the original error; lock waits, `BEGIN IMMEDIATE` | `search-index.test.ts`, `store.test.ts` |
| A future mtime is hashed once, not on every search                                                                                            | `search-index.test.ts`                  |
| Reads open with `O_NOFOLLOW` and `O_NONBLOCK`, and refuse anything that is not a regular file after `fstat`                                   | `hardening.test.ts` (pipe)              |

## Code map (B1)

| Path                                    | Owns                                                                              |
| --------------------------------------- | --------------------------------------------------------------------------------- |
| `packages/contracts/src/brain.ts`       | Zod schemas, URI and path grammar, `trust`                                        |
| `apps/server/src/brain/paths.ts`        | `BrainRoot`: the only code that touches a brain's filesystem                      |
| `apps/server/src/brain/frontmatter.ts`  | Strict serializer, strict write validation, tolerant reader                       |
| `apps/server/src/brain/safety.ts`       | Secret scan and size caps                                                         |
| `apps/server/src/brain/search-index.ts` | FTS5 (or fallback) cache and incremental sync                                     |
| `apps/server/src/brain/store.ts`        | `createBrainStore`: list, read, write, archive, remove, search, overview, reindex |

`createBrainStore({ home, resolveProjectRoot })` takes `WOOKY_HOME` and a function from project id
to its folder (null for an unknown project). Errors are `ServiceError`s: `bad_request`,
`not_found`, `conflict` and `forbidden` (a symbolic link or escape attempt).

## Code map (B2)

| Path                               | Owns                                                                  |
| ---------------------------------- | --------------------------------------------------------------------- |
| `apps/server/src/brain/service.ts` | `createBrainService`: caller identity, permissions, the RPC handlers  |
| `apps/server/src/brain/inbox.ts`   | `createBrainInbox`: propose, list, approve, reject, caps, idempotency |
| `apps/server/src/brain/trust.ts`   | `isAgentAuthored`, `effectiveTrust`, `sanitizeAgentFrontmatter`       |
| `apps/server/src/cli/mcp-tools.ts` | The four `brain_*` tools, flags, the nonce fence                      |
| `apps/server/src/cli/mcp.ts`       | Flag parsing for `wooky mcp`                                          |
| `apps/server/src/transport/ws.ts`  | Decodes `brain.*` and calls the service, nothing else                 |

## Later steps

**B3, prompts and fleets.** When a turn starts, inject the L0 lines of pinned and relevant
memories within a token budget, fenced by `trust`. Fleet runs get claims (a worker says which
files or topics it holds, `brain_claim` and `brain_release`) and handoffs and findings (what it
learned for the next worker). All of it lives in SQLite under `WOOKY_HOME` while the run is live;
whatever is worth keeping graduates to a memory through B4.

**B4, extraction.** After a turn or a fleet run a cheap model proposes memories from the
transcript. Project proposals are written as `active` with `source`; global ones go to the inbox as
`proposed`. The same step can write LLM-authored L1 overviews, replacing the `auto` one.

**B5, UI.** A Brain panel in the web app: a tree of both scopes, a viewer with the three tiers, an
editor that sends `expectedUpdatedAt`, and the inbox with approve (with edits) and reject. It
should show `overwrites` and `stale` before the user approves.
