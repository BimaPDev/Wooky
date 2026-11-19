# Providers

AGE drives agent CLIs. It does not ship a model or an account. A provider adapter
translates one CLI's protocol into `ProviderEvent`s. The client only ever sees
`ProviderKind`, a model id, and `ProviderStatus`.

| Kind       | What it runs                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------ |
| `claude`   | Claude Code, through the Agent SDK                                                               |
| `cursor`   | `cursor-agent`                                                                                   |
| `codex`    | `codex app-server`                                                                               |
| `demo`     | A scripted local agent, used by tests and UI work                                                |
| `opencode` | The `opencode` CLI                                                                               |
| `acp`      | One adapter for any [Agent Client Protocol](https://agentclientprotocol.com) agent the user adds |

The server registry ships an adapter for every kind. A kind with no adapter is absent
from `providers.list`.

## Settings

Device settings (the machine's `settings.json`, served by `settings.get`) gain:

- `providers`: a partial record of `ProviderKind` to `ProviderSettings`. A missing kind
  means defaults. Unknown keys are rejected.
- `acpAgents`: up to 20 `AcpAgentConfig` values. Ids must be unique.

`ProviderSettings`:

| Field          | Limit                                          | Default |
| -------------- | ---------------------------------------------- | ------- |
| `binaryPath`   | optional string, 1–500 characters              | unset   |
| `defaultModel` | optional string, 1–200 characters              | unset   |
| `customModels` | up to 50 strings, each 1–200 characters        | `[]`    |
| `extraArgs`    | up to 20 strings, each up to 4096 characters   | `[]`    |
| `env`          | up to 20 entries; key 1–256, value up to 16384 | `{}`    |

`AcpAgentConfig`:

| Field     | Limit                                              | Default |
| --------- | -------------------------------------------------- | ------- |
| `id`      | slug `^[a-z0-9][a-z0-9-]{0,31}$` (1–32 characters) |         |
| `name`    | string, 1–40 characters                            |         |
| `command` | string, 1–200 characters                           |         |
| `args`    | up to 20 strings, each up to 4096 characters       | `[]`    |
| `env`     | same shape as `ProviderSettings.env`               | `{}`    |
| `models`  | optional; up to 50 strings, each 1–200 characters  | unset   |
| `enabled` | boolean                                            |         |

`command` is the executable. `args` are argv entries. `extraArgs` are further argv
entries the adapter appends. Nothing here is joined into a shell command, and nothing
is passed with `shell: true`.

`env` is merged into the child environment. For an ACP agent, `providers.acp.env`
wins on a key that both maps set; `providers.acp.extraArgs` are appended after the
agent's `args`. `providers.acp.binaryPath` does not choose the executable. The
executable is `AcpAgentConfig.command`. For OpenCode, `providers.opencode.binaryPath`
replaces the `opencode` executable when set.

`env` is stored only in local `settings.json`. It is not written to the event log.
Adapters and the server must not log it.

`settings.put` replaces `providers` and `acpAgents` as whole values when the patch
includes them. Send the full record or list you want to keep.

## Where model ids come from

`ProviderStatus.modelsSource` and each model's own `modelsSource` are optional, so
probes from older adapters still parse. A model uses its own value when set, otherwise
the provider's.

| Value    | Meaning                                                        |
| -------- | -------------------------------------------------------------- |
| `live`   | The CLI reported this id                                       |
| `static` | Built into AGE                                                 |
| `custom` | The user added it (`customModels`, or an ACP agent's `models`) |

## OpenCode

The thread's `provider` is `opencode`. Its `model` is an id printed by `opencode models`,
unchanged. Those ids look like `provider/model`. One of them is `opencode/big-pickle`.
AGE does not keep a second copy of that catalog: the adapter asks the CLI (`live`) and
shows `providers.opencode.customModels` beside it (`custom`).

This is not the ACP model-id form below. OpenCode has its own adapter. It runs
`opencode acp` (or `binaryPath` plus `acp` when that is set) and appends
`providers.opencode.extraArgs`. `providers.opencode.env` is merged into the child
environment and is not logged.

The status probe runs `opencode --version`, then `opencode models`. Model ids are
cached for five minutes. `authenticated` stays null: those two commands do not say
whether a login is required. A sign-in error in their output is reported as signed out.

After `session/new`, the adapter selects the thread's model with
`session/set_config_option` when the session advertises a `model` option
(`{ configId: "model", value: "<id>" }`). If that option is absent it tries
`session/set_model`. If the agent implements neither, the turn continues on the
agent's default and says so. `opencode acp` has no `--model` flag. OpenCode 1.19.6
can create a file in the workspace without sending `session/request_permission`.
When it does ask, the approval card is the same one the ACP adapter uses.

## ACP

One adapter, kind `acp`, speaks [Agent Client Protocol](https://agentclientprotocol.com)
JSON-RPC over stdio. The user adds each agent under `acpAgents`. A thread on this
provider stores `model` as either:

- `<agentId>` — the agent, and no model id
- `<agentId>/<modelId>` — the agent, then the model id it should use

The first `/` is the split. Further slashes stay inside `modelId`, so
`gemini/google/gemini-2.5-pro` is agent `gemini` and model `google/gemini-2.5-pro`.
`parseAcpModel` does that split and returns null when the agent id is not a slug, or
the model id is empty or longer than 200 characters.

`AcpAgentConfig.models`, when set, lists those `modelId` values (not the agent prefix).
When it is omitted, the user has not listed any. `providers.acp.defaultModel` and
`providers.acp.customModels` use the full thread form (`<agentId>` or
`<agentId>/<modelId>`).

### Adding an agent

Check the agent's docs before relying on a flag. The commands below are the ones those
docs showed when this page was written.

Gemini CLI. The example below is `gemini --experimental-acp`. Current Gemini CLI docs
also show `gemini --acp`. Check the agent's docs.

```json
{
  "id": "gemini",
  "name": "Gemini CLI",
  "command": "gemini",
  "args": ["--experimental-acp"],
  "enabled": true
}
```

Goose. Check the agent's docs.

```json
{
  "id": "goose",
  "name": "Goose",
  "command": "goose",
  "args": ["acp"],
  "enabled": true
}
```

Kiro. Check the agent's docs. The CLI binary is `kiro-cli`, and `kiro-cli acp` is the
ACP server.

```json
{
  "id": "kiro",
  "name": "Kiro",
  "command": "kiro-cli",
  "args": ["acp"],
  "enabled": true
}
```

## What the ACP adapter does

One process per turn. Frames are JSON-RPC 2.0, one JSON object per line. A line
over 1 MiB is dropped and the next line is read. Every inbound object is checked
with zod. A line that is not a JSON-RPC 2.0 message is dropped. Unknown
notification methods, and unknown `session/update` discriminators, are passed to
the debug channel (`AGE_DEBUG=1` prints them). They do not fail the turn.

The client advertises no filesystem and no terminal capabilities, so the agent
uses its own tools. `fs/read_text_file` and `fs/write_text_file` are not
implemented.

A turn calls `initialize` (protocol version 1), then `session/load` when the
agent advertised `loadSession` and the thread already has a session id. Otherwise
it calls `session/new`. The session id is stored only when `loadSession` is
advertised, so an agent that cannot resume gets the handoff transcript on the
next turn, the same way a provider with no native session does. Loading a session
replays history; those updates are not copied into the new turn. If `session/load`
fails, the turn starts a new session and says so.

`session/update` becomes provider events:

| Update                | Event                                                                            |
| --------------------- | -------------------------------------------------------------------------------- |
| `agent_message_chunk` | assistant message, then deltas                                                   |
| `agent_thought_chunk` | reasoning, then deltas                                                           |
| `tool_call`           | tool item. `execute` is a command, `fetch` is web, `delete` and `move` are edits |
| `tool_call_update`    | the same tool item, replaced                                                     |
| `plan`                | a plan                                                                           |
| `usage_update`        | usage. `used` is reported as input tokens. A USD `cost` is `costUsd`             |

Tool output previews stop at 4 KB.

`session/request_permission` becomes an approval card. Allow maps to `allow_once`
(or `allow_always` if that is the only allow option). Deny maps to `reject_once`
(or `reject_always`). Full access picks allow without a card. Auto-edits does the
same for edits, and still asks for commands. Plan mode always asks. Cancelling the
turn answers the pending request with `cancelled`, sends `session/cancel`, and
kills the process group if the prompt has not returned within 3 seconds.

A prompt error whose text matches the shared classifier becomes that failure
(`rate_limit`, `quota`, `overloaded`, `auth`). ACP's `auth_required` error
(`-32000`) is `auth`. A crash is a failed turn. Its stderr tail is classified the
same way.

The status probe, for each enabled agent, checks that `command` resolves and then
runs `initialize` with a 4 second timeout. The version line is the agent's name
and version. `authenticated` is true when `authMethods` is empty, and null when
the agent advertises a login method: initialize lists methods, it does not say
whether they have been used. Models are the agent's `models` list as
`<agentId>/<modelId>` with source `custom`, or just `<agentId>` when that list
is omitted. `providers.acp.extraArgs` are appended after the agent's `args`.
`providers.acp.env` overrides the agent's `env` on the same key. Neither is logged.
The fleet variables (`AGE_THREAD_ID`, `AGE_SERVER_URL`, the `age` shim on `PATH`)
are applied on top, and the coordinator instructions are prefixed to the first
prompt of a new session.

The server passes the current device settings into both adapters when it builds
them. Probes and turns read that function, so a settings change is visible on the
next probe or turn.
