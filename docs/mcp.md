# MCP

Outside agents drive a running Wooky through `wooky mcp`. It is a stdio server: one JSON-RPC
2.0 object per line on stdout, logs on stderr only. It does not start Wooky. It finds the
server the same way `wooky agents` does: `$WOOKY_SERVER_URL`, or `WOOKY_HOME/server.json` when
that pid is still alive. If nothing is listening, a tool call returns the sentence
"Wooky is not running. Start it with `wooky` or open the app." The next call tries again.

The protocol version is `2025-06-18`. Older clients that send `2025-03-26` or `2024-11-05` are
accepted. A client that names any other version is answered with `2025-06-18`, the newest this
server speaks. That is MCP's negotiation rule: the server picks the version, and the client
disconnects if it cannot use it.

`wooky_approve` is not in the tool list unless the process is started with `--allow-approvals`.
`--read-only` exposes only overview, list, read, and wait, plus the brain read tools. `--projects id,id` limits every tool
to those projects; any other project id is rejected. Filesystem and folder-picker RPCs are not
exposed.

`--allow-global-write` lets `brain_write` save a global memory directly when the process has no
agent token. Without it, every global write goes to the brain inbox for approval. A host that
passes an environment allowlist drops `WOOKY_AGENT_TOKEN`, so this default keeps an agent from
writing global memory as the user. See `docs/brain.md`.

A task is a new thread plus its first turn, the same two commands the composer sends
(`thread.create`, then `turn.start`). `runtimeMode` defaults to `approve`. `auto-edits` and
`full` are rejected unless the process was started with `--allow-full`, which raises the ceiling
to `full`. In approve mode the approval card is shown in the Wooky UI, `wooky_wait` returns
`blocked` with the approval id, and answering it from MCP takes `--allow-approvals`. `isolate`
defaults to true: the thread gets its own git worktree. `provider` and `model` follow the
composer: the first available provider (disabled ones are skipped), then that provider's
`defaultModel`, otherwise its first model. Demo is used only when that choice lands on it.

## Add it

Claude Code:

```text
claude mcp add wooky -- wooky mcp
```

Flags go after `mcp`:

```text
claude mcp add wooky -- wooky mcp --read-only
claude mcp add wooky -- wooky mcp --projects proj_a,proj_b --allow-approvals --allow-full
```

Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.wooky]
command = "wooky"
args = ["mcp"]
```

Claude Desktop, in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "wooky": {
      "command": "wooky",
      "args": ["mcp"]
    }
  }
}
```

Cursor, in `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "wooky": {
      "command": "wooky",
      "args": ["mcp"]
    }
  }
}
```

`wooky` has to be on `PATH`. A running server writes `WOOKY_HOME/bin/wooky`. Set `WOOKY_HOME` in
the client's env when this process should talk to a server that is not the default `~/.wooky`.

## Tools

| Tool                 | What it returns                                                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wooky_overview`     | Server version, projects (`id`, `name`, `path`), thread counts by status.                                                                                                             |
| `wooky_list_threads` | `projectId?`, `status?`, `limit` ≤ 50. Id, title, provider, model, status, last activity, worktree branch.                                                                            |
| `wooky_create_task`  | `projectId`, `prompt`, `provider?`, `model?`, `runtimeMode?` (`approve`, `auto-edits`, `full`), `isolate?` (default true), `title?`. Returns `threadId`. `full` needs `--allow-full`. |
| `wooky_send`         | `threadId`, `prompt`. Starts a turn, or queues the prompt when one is already running.                                                                                                |
| `wooky_wait`         | `threadId`, `timeoutMs` ≤ 600000 (default 120000). Resolves when the current turn finishes. A pending approval or question returns immediately.                                       |
| `wooky_read`         | `threadId`, `sinceTurn?`. Final assistant text of each turn, plus a diff stat. About 20000 characters, then a truncation note.                                                        |
| `wooky_interrupt`    | `threadId`.                                                                                                                                                                           |
| `wooky_approve`      | `threadId`, `approvalId`, `decision` of `approve` or `deny`. Only with `--allow-approvals`.                                                                                           |

Brain tools read and write Wooky Brain memories and coordinate fleet runs. They are hidden by
`--read-only` where noted, and all require a valid agent token when the server enforces it.

| Tool            | What it does                                                        | Flags / notes                                                                                                                                        |
| --------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `brain_ls`      | List a brain folder.                                                | read-only ok                                                                                                                                         |
| `brain_read`    | Read a memory at tier 0/1/2.                                        | read-only ok                                                                                                                                         |
| `brain_search`  | Search memories by query/scope/prefix.                              | read-only ok                                                                                                                                         |
| `brain_write`   | Write a project memory, or queue a global memory in the inbox.      | hidden by `--read-only`; `--projects` restricts project scope; `--allow-global-write` allows direct global write only when no agent token is present |
| `brain_claim`   | Claim a path/glob/label in the current fleet run.                   | hidden by `--read-only`; requires fleet agent token; held result is fenced as untrusted worker output                                                |
| `brain_release` | Release a claim owned by the caller thread.                         | hidden by `--read-only`; requires fleet agent token                                                                                                  |
| `brain_handoff` | Record a handoff for the coordinator/sibling in the same fleet run. | hidden by `--read-only`; requires fleet agent token                                                                                                  |
| `brain_finding` | Record a live finding for the current fleet run.                    | hidden by `--read-only`; requires fleet agent token                                                                                                  |

See `docs/brain.md` for scopes, trust, inbox, prompt injection, and claim semantics.
