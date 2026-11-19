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

The server registry knows every kind. This tree ships adapters for Claude, Cursor,
Codex and Demo only. OpenCode and ACP stay unregistered until their adapter stations
land. A kind with no adapter is absent from `providers.list`.

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

This is not the ACP model-id form below. OpenCode has its own adapter.

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
