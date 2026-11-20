# Anywhere: hosts, remote access, sync and snapshots

Goal: start a task on one machine (the work Mac), go home, and continue on another
(the Windows PC) without losing anything. Install with one command. Wooky stays
account-free: no hosted relay, no Wooky cloud, and agent sign-ins never leave a machine.

## Words

- **Device**: one Wooky install (a server plus its WOOKY_HOME). Has a stable `deviceId`
  (random, created on first start, stored in WOOKY_HOME/device.json) and a user-editable name.
- **Environment**: a Wooky server a client is connected to. The local server is the
  environment `local`; a paired remote device is another environment. A client (web,
  desktop, phone browser) can hold several environments and switch between them.
- **Host**: a device other devices connect to as clients. Every device *can* be a host;
  hosting is off until the user enables it.
- **Peer**: two devices that each run their own agents and sync with each other.
- **Snapshot**: a recorded state of something synced (a project's files, a thread, the
  settings) that the user can revert to. "Git for Wooky stuff."

## Topologies (the user picks per device, Settings → Anywhere)

1. **Host mode.** One always-on device (home server, Proxmox LXC, VPS, spare Mac) runs the
   agents. Laptops open it as an environment. Tasks keep running when a laptop sleeps.
   Optional: mirror the host's project files to the laptop's own checkout (file sync).
2. **Peer mode.** No server. Each laptop runs its own agents. Synced categories flow both
   ways. A running task stays on the device it started on; "Continue on this device"
   transfers the thread (see Threads).
3. **Both.** Peers plus a host. The host is just another peer that never sleeps.

## Connections (how a client reaches a device)

`RemoteConnection` is a tagged union; Tailscale is the default and is detected
automatically.

| kind        | what                                                                                                                          |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `tailscale` | `tailscale status --json` gives the MagicDNS name and tailnet IP. Optional `tailscale serve` for HTTPS on 443. Default.      |
| `direct`    | `http(s)://host:port` on the LAN or any routable address.                                                                    |
| `url`       | Any user-supplied URL (reverse proxy, Cloudflare Tunnel, ngrok). Must be https unless the host is a private/loopback address. |
| `ssh`       | The client spawns `ssh -N -L <localPort>:127.0.0.1:<remotePort> user@host` and connects to the forwarded port.                |

Binding: by default the server binds 127.0.0.1 only (today's behaviour). Enabling hosting
binds the chosen interfaces: the tailnet IP (default), all interfaces, or stays loopback-only
for `ssh`/`url` (the tunnel does the exposure).

`tailscale serve --https=443` never points at the normal loopback listener: Tailscale proxies
from 127.0.0.1, which would let any tailnet peer inherit loopback trust. Enabling
`hosting.tailscaleServe` opens a **separate** loopback listener on its own ephemeral port and
points Serve at that port instead. On this listener every request needs a device token; the
loopback bypass is disabled. The normal loopback listener is unchanged. As defence in depth,
any request carrying `Tailscale-User-Login`, `Tailscale-User-Name`, `X-Forwarded-For`,
`X-Forwarded-Host` or `Forwarded` is treated as remote on every listener.

## Pairing and auth

- Any non-loopback connection needs a **device token**. Loopback stays as today, plus a
  local token (G29) for non-browser local processes is a later hardening step.
- The host creates a **pairing code**: 8 characters from an unambiguous alphabet, single
  use, 10 minute expiry. Shown in Settings → Anywhere → "Pair a device" with a QR code of
  `wooky://pair?url=…&code=…` and printed by `wooky pair` on the CLI.
- The client calls the unauthenticated HTTP endpoint `POST /pair` with
  `{code, deviceId, deviceName, platform}`. The host returns `{token, hostDeviceId, hostName}`.
  The token is 32 random bytes, base64url. The host stores only its SHA-256 plus
  metadata (`PairedDevice`). Five wrong codes in a minute locks pairing for one minute.
- Clients send the token as `Authorization: Bearer` (non-browser) or, for the browser UI
  served by the host, as an HttpOnly SameSite=Strict cookie set by `/pair`.
  Origin/Host checks stay for cookie auth.
- Paired devices can be renamed and revoked. Revoking closes their open sockets at once.
- Remote clients never get the folder picker. They may get `fs.searchEntries` only inside
  registered projects.
- Desktop clients keep tokens in Electron `safeStorage`. A server acting as a sync peer keeps them in
  WOOKY_HOME/peers.json, mode 0600 (on Windows, under the user profile ACL).

A bearer token or `wooky.token.*` websocket subprotocol is an explicit presentation: if one is
presented and its lookup fails, the request gets 401 even from loopback. The only exception is a
stale `wooky_token` cookie on plain loopback with no proxy headers, which may be ignored so the
local UI does not lock itself out.

The public/private split is deliberate:

- **Public, no token:** `GET`/`HEAD` for `index.html`, built static assets (js/css/fonts/images,
  manifest and icons) and SPA routes such as `/project/abc`, plus `GET /pair` as the no-JS
  fallback. The QR target `<url>/#/pair?code=…` must load on an unpaired phone. These hold no
  user data.
- **Authenticated:** `/ws`, `/sync/*`, `POST /pair`, and every data or API route. `/healthz` answers
  only `ok` and stays authenticated (401 without a token on a remote listener).

### Trust model

A paired device is trusted like you at the keyboard, except it cannot change how agents are
launched, change hosting, or pair or revoke devices. Concretely, these stay loopback-only:
`providers.signIn`, `settings.put` touching `hosting`, a provider's `binaryPath`, `env` or
`extraArgs`, or `acpAgents`, and every `remote.*` admin RPC. A `settings.put` patch from a paired
device that touches any of them is rejected whole, not partially applied. A paired device also
never gets the folder picker.

Who is "the operator" comes only from the authenticated identity: a `/ws` connection is local when
`authenticateRequest` resolved it to the unpaired `local` client (loopback, no proxy headers, not the
Tailscale Serve listener, no valid device token). It never depends on how a token was presented. A
paired device that sends only its `wooky_token` cookie is still that paired device, not the operator,
so the rules above and the transfer guard (`thread.claim` / `thread.import`) apply to it. Presenting a
token explicitly (bearer or `wooky.token.` subprotocol) only decides whether the browser `Origin` is
checked, because a cookie rides along on cross-site requests.

Project settings (scripts, worktree setup, shared files) are editable from paired devices, like
running commands in the terminal. The pairing token is the trust boundary: revoking a device
closes its sockets at once, so it can no longer read or change anything.

## Sync

Per device, `SyncSettings`:

```
enabled: boolean                       // master switch, default false
categories: {
  files: boolean        default true   // project working copies, incl. uncommitted
  threads: boolean      default true   // conversations, turns, checkpoints, queue
  settings: boolean     default true   // device settings except device-local keys
  themes: boolean       default true   // themes and wallpapers
  ignoredFiles: boolean default false  // also sync files matched by .gitignore
}
intervalSec: number     default 30     // file scan interval; also on turn.finished
retention: { keepDays: 30, keepMin: 50 }  // snapshot pruning
peers: deviceId[]                      // which paired devices to sync with
projectMap: { [projectId]: { [deviceId]: localPath } }  // same project, different paths
```

Device-local keys never sync: binary paths, env, window state, sync settings themselves.

### Files: shadow repos and snapshots

- Each synced project gets a **shadow git dir** at WOOKY_HOME/sync/<projectId>.git with
  `core.worktree` = the project path. It never touches the project's own `.git`, index or
  refs, and it works for folders that are not git repos.
- A **file snapshot** = `GIT_INDEX_FILE=<tmp> git add -A` (respecting .gitignore unless
  `ignoredFiles`; always excluding `.git/` and WOOKY_HOME), `write-tree`, `commit-tree`
  with parent = the previous snapshot. Ref: `refs/wooky/snap/<deviceId>/<projectId>` (tip).
  The commit message records JSON metadata: deviceId, reason
  (`interval|turn|before-apply|manual|revert`), threadId/turnId if any, plus the project
  repo's HEAD sha and branch.
- Snapshots are only written when the tree changed.
- **Transfer**: `git bundle create - <tip> ^<last-known-remote-tip>` streamed over HTTP
  `GET /sync/bundle?project=…&since=…` (token-authenticated), applied with `git bundle unbundle`
  into the receiver's shadow repo under `refs/wooky/peer/<deviceId>/<projectId>`.
  WS pushes `sync.available {deviceId, projectId, tip}` so peers pull promptly.
- **Apply** (receiver):
  1. Take a `before-apply` snapshot of the local working copy. This is the backup.
  2. If the local tree equals the last tree applied from that peer (no local edits
     since), check out the incoming tree into the working copy (write changed files,
     delete removed ones, only paths tracked by the snapshot). Fast-forward.
  3. Otherwise run a three-way merge with `git merge-tree --write-tree` (base = last common
     snapshot). A clean merge is applied. A conflicted merge is NOT applied: it raises a
     `SyncConflict` that the user resolves (keep mine / take theirs / open both) in the UI.
  4. Never apply while a turn is running in that project on this device. Queue until it finishes.
  5. Project git state: if the snapshot's HEAD commit is reachable (fetch the project's
     branch objects via the same bundle) and the local repo is on the same branch with
     a clean fast-forward, move the branch. Otherwise only the working tree syncs, and a
     notice says the branches differ.
- **Revert**: any snapshot can be restored into the working copy. The restore itself
  takes a `before-apply` snapshot first, so it can be undone.
- **Retention**: prune snapshot history older than keepDays while keeping at least keepMin,
  by rewriting the chain (squash old ones) and `git gc --prune=now` on the shadow repo.

As built (A2, `apps/server/src/sync/`, git calls in `apps/server/src/git/shadow.ts`):

- The tip ref is `refs/wooky/snap/<deviceId>` in one shadow repo per project. Incoming peer history
  lands in `refs/wooky/peer/<deviceId>`, and `refs/wooky/applied/<deviceId>` records the last peer
  commit applied (the merge base next time; an empty tree when there is none).
- Snapshots use a private index file in the shadow dir (not a throwaway), so unchanged files are not
  re-hashed. The scan lists candidates with `git ls-files`, stats them (size cap, fingerprint), then
  `update-index`. Interval scans skip git when the fingerprint is unchanged.
- Peers share a project through `projectMap`: a project's shared id is the map key whose entry for
  this device is its folder, else its own id. `GET /sync/tips` and `/sync/bundle?project=` use shared ids.
- A clean `merge-tree` is applied. A conflict applies nothing. Resolving applies the clean part of the
  merge too, and `mine` / `theirs` / `both` decide only the conflicting paths (`both` also writes
  `<name>.theirs<ext>`). Merging needs Git 2.40 (`--merge-base`); older Git raises a conflict on every
  divergence.
- Project branch moves are not done: only the working tree syncs. The snapshot message records the
  project's HEAD and branch for a later station.
- Only the sender's `refs/wooky/snap/<id>` chain is listed by `sync.snapshots.list`.
- `/sync/*` runs on the real auth: the guarded HTTP handler checks `authenticateRequest` first, then
  the sync routes demand a device token (loopback `local` gets 401) and serve only deviceIds listed in
  `sync.peers` (403 otherwise). Revoking a device makes its token 401 at once. Outgoing pulls read
  tokens from the `PeerDirectory` (`peers.json`); the device id is `remote.device.id()`, the single
  `device.json` loader. Pairing must be done both ways for two-way sync. There is no test-peers env
  hook or `--test-hooks` flag.
- `scripts/live-sync-proof.mjs` boots two real servers, pairs them, syncs a project at two paths, raises
  a conflict, reverts from a `before-apply` snapshot and revokes a device.

### Threads

- Every thread has an **owner device**, the one that runs its turns. Default: the creator.
- Threads sync as **read-only replicas** to peers. The owner sends the thread's events as
  a JSON event batch (`GET /sync/threads?since=<seq>`). The receiver stores them in a
  separate `replica_events` table keyed by (ownerDeviceId, seq) and folds them with the
  same reducer into `ReadModel.replicas`.
- **Continue on this device**: `thread.claim` on the receiver. It asks the owner to
  `thread.release`, then imports the thread as its own (a new local thread with the
  transcript as handoff context, the same as a provider handoff) and links `movedFrom`. The
  owner's copy shows "moved to <device>" and refuses new turns. Files arrive through file
  sync, which is required for claim. When file sync is on, a claim first snapshots and pulls the
    project from the owner (`apps/server/src/transfer/file-sync.ts`, through the sync engine) and waits
    at most 30 seconds. If the owner is offline, refuses, or the pull does not finish in time, the claim
    fails with a reason that says so, and nothing is released or imported. After the owner released
    (a forced release stops its turn first) the pull is repeated for the final files; if that one fails
    the claim fails with that reason and can be run again. Which local project a claim lands in is
    `projectMap[<owner's project id>][<this device>]` (a folder path, as the sync engine reads it; a
    local project id is also accepted), else the project with the same id.
  - A running turn refuses the release. A claim with `force` first asks the owner to
    interrupt the turn and sends the release again only once the turn ended, so the owner
    never releases a thread with a turn still running.
  - A release is bound to the authenticated device: a paired device can only release a thread
    to itself, and only while it is a sync peer. `thread.claim` and `thread.import` are never
    accepted from a paired device.
  - The import is built from the replica before the release, is idempotent per claim id,
    survives a crash after the owner released (a durable `claim_checkpoints` row), and always
    lands at `approve` whatever the peer's runtime mode was. Imported history is validated
    (schema, size caps, at most 500 turns); checkpoint refs, native session ids and unsafe
    changed-file paths are cleared.
  - Housekeeping (hourly): replica events of owners that are no longer peers, of threads that
    now live here, were removed on the owner or sat idle for 90 days are dropped (the pull
    cursor stays); claims that never reached the owner expire after an hour; a leftover release
    marker expires after a day.
- Host mode needs none of this: the client just views the host's environment.

### Settings and themes

Last writer wins per top-level key, with `{value, updatedAt, deviceId}` stamps. An equal time
goes to the larger device id, so peers converge. Only an allowlist of appearance and behaviour
keys travels; `hosting`, `sync`, `environments`, `deviceName`, `acpAgents` and a provider's
`binaryPath`, `env` and `extraArgs` stay on the device that set them, and the receiver strips
them again. A key edited locally is stamped the next time settings are exported, and a value
applied from a peer keeps the peer's stamp, so it is never sent back as newer. Themes from a
peer go through the normal theme validation and never overwrite a theme this device already has.
Each accepted change is recorded so it can be reverted.

## One-command install

Served from GitHub release assets of the Wooky repo (the user publishes; nothing is pushed
by agents). `WOOKY_REPO` overrides the source.

- macOS/Linux: `curl -fsSL <release>/install.sh | bash`
- Windows: `irm <release>/install.ps1 | iex`
- Proxmox VE host: `bash -c "$(curl -fsSL <release>/proxmox.sh)"` creates a Debian 13 LXC
  (prompts for CTID, cores, RAM and disk, defaulting to 2/4096/16G; unprivileged; nesting
  on), installs Tailscale inside (optional), then runs install.sh in the container.

install.sh / install.ps1:
1. Detect OS/arch. Install Node 24 into WOOKY_HOME/runtime if `node` is missing or older,
   as a portable tarball/zip from nodejs.org with SHA-256 verified against SHASUMS256.txt.
2. Download `wooky-<version>.tgz` (server bundle + web dist + package.json for native
   deps), verify its SHA-256 from the release, unpack to ~/.wooky/app/<version>, and
   `npm install --omit=dev` for node-pty (build tools are a soft requirement; without
   them the terminal falls back to pipes).
3. Put a `wooky` launcher on PATH (~/.local/bin or %LOCALAPPDATA%\Wooky\bin).
4. Optional `--service`: launchd LaunchAgent (macOS), systemd user unit plus
   `loginctl enable-linger` (Linux), or a Scheduled Task at logon (Windows). Default on
   for Linux servers and containers.
5. Optional `--host`: enable hosting and print a pairing code + QR in the terminal.
6. Optional `--agents claude,codex,opencode`: install those CLIs with their official
   installers, then tell the user to sign in via `wooky` terminal or the web UI.
7. Idempotent: rerunning upgrades. `wooky update` does the same. `wooky uninstall` removes
   the service and app dir and keeps WOOKY_HOME unless `--purge`.

Flags are also env vars (`WOOKY_SERVICE=1` …) because `curl | bash` cannot pass flags
easily.

## Contracts

The sections above are the behaviour. This section is the wire. Where they differ, this
section wins: `POST /pair` is `PairRequest` / `PairResponse` (a `DeviceInfo` on each side),
not the flat field list in Pairing and auth. A peer learns that a snapshot exists from a
`SyncPush` of kind `snapshot`. There is no separate `sync.available` push.

Schemas live in `packages/contracts`. Old logs omit the new fields and decode to the defaults.

### Schemas

- `DeviceId`, `DevicePlatform`, `DeviceInfo`
- `RemoteConnection` — `tailscale` `{hostName, port, https}`, `direct` `{url}` (any http(s) URL,
  including a public host; the UI warns), `url` `{url}` (https, or http only for localhost, 127/8,
  `::1`, 10/8, 172.16/12, 192.168/16, 100.64/10, `*.ts.net`, IPv6 ULA `fd00::/8`, and link-local
  `fe80::/10`). Both `direct` and `url` reject userinfo (`@` in the authority). `ssh`
  `{target, remotePort, localPort?, identityFile?}`: `target` matches
  `^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$` and neither `target` nor `identityFile` may start with `-`.
  Ports are integers from 1 to 65535.
- `Environment` `{id, label, deviceId?, connection, addedAt}` — the local server is not stored
- `PairedDevice` `{deviceId, name, platform, pairedAt, lastSeenAt, tokenHash, revoked}`
- `PairedDeviceView` — `PairedDevice` without `tokenHash`
- `PairingCode` `{code, expiresAt, url}` — `code` is uppercased, then checked as 8 characters from
  `23456789ABCDEFGHJKMNPQRSTUVWXYZ`
- `HostingSettings` `{enabled: false, bind: "tailscale", port: 4317, tailscaleServe: false}`
- `PairRequest` `{code, device: DeviceInfo}`, `PairResponse` `{token, host: DeviceInfo}`
- `TailscaleStatus` `{installed, running, hostName, ips, serveError?}` — `serveError` is set when
  `tailscale serve` could not be enabled or disabled, and stays on the wire.
- `SyncCategories` `{files: true, threads: true, settings: true, themes: true, ignoredFiles: false}`
- `SyncRetention` `{keepDays: 30, keepMin: 50}`
- `SyncSettings` `{enabled: false, categories, intervalSec: 30 (5–3600), retention, peers: [], projectMap: {}}`
- `SnapshotKind` `files | thread | settings | themes`
- `SnapshotReason` `interval | turn | before-apply | manual | revert | incoming`
- `SnapshotSummary` `{filesChanged, insertions, deletions}`
- `Snapshot` `{id, kind, projectId, threadId, deviceId, reason, createdAt, summary, parentId}` —
  `id` is the shadow commit sha or a uuid. `sync.snapshots.create`'s `label` is not a field;
  the sync engine puts it in the commit message.
- `SyncPeerStatus` `{deviceId, name, state: idle|syncing|offline|error, lastSyncAt, error}`
- `SyncConflict` `{id, projectId, peerDeviceId, mine, theirs, base, paths, createdAt}`
- `ConflictResolution` `mine | theirs | both` — `both` keeps theirs as files with a `.theirs` suffix
- `SyncStatus` `{enabled, peers, conflicts}`
- `ProjectScript` `{id, name, command, icon?, runOnWorktreeCreate: false, previewUrl?}`
- `SharedPath` `{path, mode: link|copy}` — relative, no `..`, not inside `.git`
- `ProjectPrompt` `{id, name (≤60), text (≤20000)}` — a reusable prompt preset, listed under `/` in the composer
- `ProjectSettings` `{scripts: [], worktreeSetup?, defaultPreviewUrl?, sharedPaths: [], prompts: [] (≤50)}` — `previewUrl` may contain `${PORT}`
- `TerminalSize` `{cols, rows}`
- `TerminalInfo` `{sessionId, title, cwd, shell, pty, createdAt, exited, projectId, scriptId}` —
  `pty: false` is the pipe fallback
- `PullRequest` `{url, number, state: open|merged|closed, branch}`
- `ThreadMovedTo` `{deviceId, at}`, `ThreadMovedFrom` `{deviceId, threadId}`
- `HistoryTurn` — a `Turn` whose status is `completed`, `interrupted`, or `failed` (not `running`)
- `PendingClaim` `{claimId, ownerDeviceId, ownerThreadId, projectId, at}`
- `ReplicaSlice` `{seq, threads, turns}`, `ReplicaModel` `{replicas: { [deviceId]: ReplicaSlice }}`

`Project.settings` is `ProjectSettings` (default `{scripts: [], sharedPaths: [], prompts: []}`).

`Thread` adds `ownerDeviceId` (`null` means this device), `movedTo`, `movedFrom`, and
`pullRequest`, each defaulting to `null`.

`DeviceSettings` adds `deviceName?`, `hosting`, `sync`, and `environments` (default `[]`).
`DeviceSettingsPatch` keeps only the keys that were sent, and its nested objects are partial
with no defaults. `{sync: {enabled: true}}` does not include `hosting`, `environments`, `peers`,
`projectMap`, `categories`, `retention`, or `intervalSec`. `applySettingsPatch` in
`@wooky/domain` deep-merges `sync` (including `categories` and `retention`), `hosting`, and
`failover`. `peers` and `projectMap` replace the whole value when they are sent. Other
top-level keys replace as before.

`ReadModel.pendingClaims` defaults to `{}`. A `thread.claimRequested` adds one entry. A second
request for the same owner device and thread, while one is still pending, changes nothing.
`thread.claimFailed`, or a `thread.imported` that carries the same `claimId`, removes it.

`ReplicaModel` is not on the local snapshot. A3 stores replica events apart from the local log
and folds each owner's batch with `applyReplicaEvents(model, ownerDeviceId, events)`, which runs
the same reducer. The slice keeps that owner's threads, turns, and the seq of the last applied
replica event. Local threads stay local.

`TerminalPush.kind` gains `replay`. `data` is the buffered scrollback.

### Commands

Each carries `commandId`.

- `project.configure` `{projectId, settings}` → `project.configured` `{projectId, settings}`
- `thread.release` `{threadId, toDeviceId, force?}` → `thread.released` `{threadId, toDeviceId}`
  The release time is the event's `at`. The reducer sets `movedTo` to `{deviceId: toDeviceId, at}`.
- `thread.claim` `{ownerDeviceId, ownerThreadId, projectId, force?}` → `thread.claimRequested`
  `{claimId, ownerDeviceId, ownerThreadId, projectId}`. `claimId` is the command id. The time is
  the event's `at`. Failure is `thread.claimFailed` `{claimId, reason}`. Success is
  `thread.imported` with optional `claimId`.
- `thread.import` `{sourceDeviceId, sourceThreadId, projectId, title, provider, model, transcript, historyTurns?}`
  → `thread.imported` `{thread, sourceDeviceId, sourceThreadId, transcript, historyTurns, claimId?}`
  `historyTurns` is at most 500 `HistoryTurn`s and defaults to `[]`. The reducer sets `movedFrom`,
  remaps each turn's `threadId` to the new local thread, and stores them. A later `turn.started`
  appends a new turn with its own id. `transcript` stays on the event for the provider handoff.

### Events

- `thread.prLinked` `{threadId, pullRequest}` — internal, emitted by the git effect. `pullRequest`
  may be null to clear it.

### RPCs

Params → result.

- `device.info` `{}` → `DeviceInfo`
- `device.rename` `{name}` → `DeviceInfo`
- `remote.tailscaleStatus` `{}` → `TailscaleStatus`
- `remote.pairingCode.create` `{}` → `PairingCode`
- `remote.devices.list` `{}` → `PairedDeviceView[]`
- `remote.devices.revoke` `{deviceId}` → `{ok: true}`
- `remote.devices.rename` `{deviceId, name}` → `PairedDeviceView`
- `sync.status` `{}` → `SyncStatus`
- `sync.now` `{projectId?}` → `{ok: true}`
- `sync.snapshots.list` `{kind?, projectId?, threadId?, limit?, before?}` → `Snapshot[]`
- `sync.snapshots.diff` `{snapshotId, against?: snapshotId | "working"}` → same result as `git.diff`
- `sync.snapshots.restore` `{snapshotId, paths?}` → `{backupSnapshotId}`
- `sync.snapshots.create` `{projectId, label?}` → `Snapshot`
- `sync.conflicts.resolve` `{conflictId, resolution}` → `{ok: true}`
- `terminal.list` `{}` → `TerminalInfo[]`
- `terminal.attach` `{sessionId}` → `TerminalInfo` (the server then pushes `replay`)
- `terminal.open` keeps `cwd`, `cols`, `rows`, and adds optional `projectId`, `scriptId`, `size`.
  The result is still `{sessionId, shell, lineEnding?}`. `TerminalInfo` fields (`title`, `cwd`,
  `pty`, `createdAt`, `exited`, `projectId`, `scriptId`) are optional on this result until T1
  fills them. `terminal.list`, `terminal.attach`, and `scripts.run` return `TerminalInfo`.
- `scripts.run` `{projectId, scriptId, threadId?}` → `TerminalInfo`
- `scripts.suggestSharedPaths` `{projectId}` → `string[]` (gitignored top-level entries of the project root)
- `git.status` `{threadId}` → `{branch, upstream, ahead, behind, dirty, hasRemote, ghAvailable, ghAuthed}`
- `git.commit` `{threadId, message}` → `{sha}`
- `git.push` `{threadId, setUpstream?}` → `{ok: true, remoteUrl}`
- `git.pr.create` `{threadId, title, body, base?, draft?}` → `{url, number}`
- `git.pr.status` `{threadId}` → `Thread["pullRequest"]`

### Terminals

Sessions are owned by the server. A client disconnect detaches; it does not kill the shell.

- A running session with zero subscribers is killed after 24 hours detached (a constant; settings can come later).
- An exited session stays in `terminal.list` / `terminal.attach` for 10 minutes after exit, then is dropped.
- At most 16 sessions. `terminal.open` reaps exited sessions first. If all 16 are still live, it returns a conflict that says how many of those are detached.
- Timers are unref'd and cleared on `closeAll`.

### Pushes

`SyncPush` joins the websocket push union:

- `{push: "sync", kind: "status", enabled, peers, conflicts}`
- `{push: "sync", kind: "snapshot", snapshot}`
- `{push: "sync", kind: "conflict", conflict}`

## Stations

- S0 contracts, domain, this doc
- W1 Windows: process-tree kill, Windows CI, fix Windows test failures
- A1 server: device identity, hosting bind, pairing + token auth, Tailscale detection, `wooky pair`
- A2 server: sync engine (shadow repos, snapshots, bundles, apply, conflicts, retention, restore)
- A3 server: thread replicas + claim/release/import, settings/themes sync
- A4 web: environments switcher, pairing UI, Settings → Anywhere (hosting, sync categories, peers), snapshot history + diff + restore, conflict cards, phone layout + PWA manifest
- I1 installer: release bundle, install.sh, install.ps1, proxmox.sh, services, `wooky update|uninstall`
- T1 PTY terminal (node-pty + @xterm/xterm, reattach, multiple tabs, pipe fallback)
- G1 commit/push/PR (git service + gh CLI + web)
- P1 project scripts + worktree setup + preview URL
- M1 MCP server (`wooky mcp` stdio bridge)
