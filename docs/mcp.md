# MCP

Outside agents drive a running Wooky through `wooky mcp`. It is a stdio server: one JSON-RPC
2.0 object per line on stdout, logs on stderr only. It does not start Wooky. It finds the
server the same way `wooky agents` does: `$WOOKY_SERVER_URL`, or `WOOKY_HOME/server.json` when
that pid is still alive. If nothing is listening, a tool call returns the sentence
"Wooky is not running. Start it with `wooky` or open the app." The next call tries again.

The protocol version is `2025-06-18`. Older clients that send `2025-03-26` or `2024-11-05` are
accepted.

`wooky_approve` is not in the tool list unless the process is started with `--allow-approvals`.
`--read-only` exposes only overview, list, read, and wait. `--projects id,id` limits every tool
to those projects; any other project id is rejected. Filesystem and folder-picker RPCs are not
exposed.

A task is a new thread plus its first turn, the same two commands the composer sends
(`thread.create`, then `turn.start`). The turn runs in full mode, so edits and commands do not
stop for an approval card. `isolate` defaults to true: the thread gets its own git worktree.
`provider` and `model` default to `demo`.

## Add it

Claude Code:

```text
claude mcp add wooky -- wooky mcp
```

Flags go after `mcp`:

```text
claude mcp add wooky -- wooky mcp --read-only
claude mcp add wooky -- wooky mcp --projects proj_a,proj_b --allow-approvals
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

| Tool                 | What it returns                                                                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `wooky_overview`     | Server version, projects (`id`, `name`, `path`), thread counts by status.                                                                       |
| `wooky_list_threads` | `projectId?`, `status?`, `limit` ≤ 50. Id, title, provider, model, status, last activity, worktree branch.                                      |
| `wooky_create_task`  | `projectId`, `prompt`, `provider?`, `model?`, `isolate?` (default true), `title?`. Returns `threadId`.                                          |
| `wooky_send`         | `threadId`, `prompt`. Starts a turn, or queues the prompt when one is already running.                                                          |
| `wooky_wait`         | `threadId`, `timeoutMs` ≤ 600000 (default 120000). Resolves when the current turn finishes. A pending approval or question returns immediately. |
| `wooky_read`         | `threadId`, `sinceTurn?`. Final assistant text of each turn, plus a diff stat. About 20000 characters, then a truncation note.                  |
| `wooky_interrupt`    | `threadId`.                                                                                                                                     |
| `wooky_approve`      | `threadId`, `approvalId`, `decision` of `approve` or `deny`. Only with `--allow-approvals`.                                                     |
