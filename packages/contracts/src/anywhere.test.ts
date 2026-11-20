import { describe, expect, it } from "vitest";
import { DeviceSettings } from "./appearance.ts";
import { Command } from "./commands.ts";
import { AgeEvent } from "./events.ts";
import { Project, Thread } from "./model.ts";
import {
  DeviceInfo,
  Environment,
  HostingSettings,
  PairRequest,
  PairResponse,
  PairedDevice,
  PairedDeviceView,
  PairingCode,
  RemoteConnection,
  TailscaleStatus,
} from "./remote.ts";
import { RpcMethods, RpcPush } from "./rpc.ts";
import { ProjectScript, ProjectSettings } from "./scripts.ts";
import {
  ConflictResolution,
  Snapshot,
  SyncConflict,
  SyncPush,
  SyncSettings,
  SyncStatus,
} from "./sync.ts";
import { TerminalInfo, TerminalPush } from "./terminal.ts";

const at = "2026-01-01T00:00:00.000Z";

const device: DeviceInfo = {
  deviceId: "dev-1",
  name: "Work Mac",
  platform: "darwin",
  version: "0.0.0",
};

const bareThread = {
  id: "t1",
  projectId: "p1",
  title: "New thread",
  provider: "demo" as const,
  model: "demo",
  runtimeMode: "approve" as const,
  worktree: null,
  providerSessionId: null,
  status: "idle" as const,
  createdAt: at,
  updatedAt: at,
};

describe("remote contracts", () => {
  it("defaults hosting and accepts each connection kind", () => {
    expect(HostingSettings.parse({})).toEqual({
      enabled: false,
      bind: "tailscale",
      port: 4317,
      tailscaleServe: false,
    });
    expect(DeviceSettings.parse({}).hosting).toEqual(HostingSettings.parse({}));
    expect(DeviceSettings.parse({}).environments).toEqual([]);
    expect(DeviceSettings.parse({}).sync.enabled).toBe(false);

    const tailscale = RemoteConnection.parse({
      kind: "tailscale",
      hostName: "work.tail.ts.net",
      port: 4317,
      https: true,
    });
    expect(tailscale).toMatchObject({ kind: "tailscale", https: true });

    expect(RemoteConnection.parse({ kind: "direct", url: "http://192.168.1.9:4317" }).kind).toBe(
      "direct",
    );
    expect(RemoteConnection.parse({ kind: "direct", url: "http://example.com" }).kind).toBe(
      "direct",
    );
    expect(
      RemoteConnection.parse({
        kind: "ssh",
        target: "bimap@home",
        remotePort: 4317,
        localPort: 4318,
      }).kind,
    ).toBe("ssh");
    expect(
      RemoteConnection.safeParse({ kind: "ssh", target: "home", remotePort: 4317 }).success,
    ).toBe(false);
    expect(
      RemoteConnection.safeParse({
        kind: "ssh",
        target: "-oProxyCommand=calc@host",
        remotePort: 22,
      }).success,
    ).toBe(false);
    expect(
      RemoteConnection.safeParse({
        kind: "ssh",
        target: "user@host",
        remotePort: 22,
        identityFile: "-oProxyCommand=calc",
      }).success,
    ).toBe(false);
    expect(
      RemoteConnection.safeParse({ kind: "ssh", target: "user@host", remotePort: 0 }).success,
    ).toBe(false);
    expect(
      RemoteConnection.parse({
        kind: "ssh",
        target: "user@host.example",
        remotePort: 22,
        identityFile: "/home/user/.ssh/id_ed25519",
      }).kind,
    ).toBe("ssh");
  });

  it("rejects plain http on a public host for url connections", () => {
    expect(RemoteConnection.safeParse({ kind: "url", url: "http://example.com" }).success).toBe(
      false,
    );
    expect(RemoteConnection.safeParse({ kind: "url", url: "http://8.8.8.8" }).success).toBe(false);
    expect(RemoteConnection.safeParse({ kind: "url", url: "http://172.15.0.1" }).success).toBe(
      false,
    );
    expect(RemoteConnection.safeParse({ kind: "url", url: "http://100.128.0.1" }).success).toBe(
      false,
    );
    expect(RemoteConnection.safeParse({ kind: "url", url: "ftp://localhost" }).success).toBe(false);
    expect(
      RemoteConnection.safeParse({ kind: "url", url: "http://evil.com@10.0.0.1" }).success,
    ).toBe(false);
    expect(
      RemoteConnection.safeParse({ kind: "direct", url: "http://evil.com@10.0.0.1" }).success,
    ).toBe(false);
    expect(RemoteConnection.safeParse({ kind: "url", url: "http://[fd00::1]" }).success).toBe(true);
    expect(RemoteConnection.safeParse({ kind: "url", url: "http://[fe80::1]" }).success).toBe(true);
    expect(RemoteConnection.safeParse({ kind: "url", url: "http://[febf::1]" }).success).toBe(true);
    expect(RemoteConnection.safeParse({ kind: "url", url: "http://[fec0::1]" }).success).toBe(
      false,
    );

    const allowed = [
      "https://example.com",
      "http://localhost:4317",
      "http://127.0.0.1:4317",
      "http://[::1]:4317",
      "http://10.1.2.3",
      "http://172.16.0.1",
      "http://172.31.255.255",
      "http://192.168.0.1",
      "http://100.64.0.1",
      "http://100.127.255.255",
      "http://work.tail.ts.net",
    ];
    expect(
      allowed.filter((url) => !RemoteConnection.safeParse({ kind: "url", url }).success),
    ).toEqual([]);
  });

  it("parses pairing, devices, and the pair HTTP bodies", () => {
    const code = PairingCode.parse({
      code: "23456789",
      expiresAt: at,
      url: "http://100.64.0.1:4317",
    });
    expect(code.code).toBe("23456789");
    expect(
      PairingCode.parse({ code: "abcdefgh", expiresAt: at, url: "http://localhost" }).code,
    ).toBe("ABCDEFGH");
    expect(
      PairingCode.safeParse({ code: "00000000", expiresAt: at, url: "http://localhost" }).success,
    ).toBe(false);
    expect(
      PairingCode.safeParse({ code: "2345678O", expiresAt: at, url: "http://localhost" }).success,
    ).toBe(false);
    expect(
      PairingCode.safeParse({ code: "2345678", expiresAt: at, url: "http://localhost" }).success,
    ).toBe(false);

    const paired = PairedDevice.parse({
      deviceId: "dev-2",
      name: "Windows",
      platform: "win32",
      pairedAt: at,
      lastSeenAt: null,
      tokenHash: "abc",
      revoked: false,
    });
    expect(PairedDeviceView.parse(paired)).toEqual({
      deviceId: "dev-2",
      name: "Windows",
      platform: "win32",
      pairedAt: at,
      lastSeenAt: null,
      revoked: false,
    });
    expect(PairedDeviceView.safeParse(paired).data).not.toHaveProperty("tokenHash");

    expect(PairRequest.parse({ code: "ABCDEFGH", device })).toMatchObject({ device });
    expect(PairResponse.parse({ token: "tok", host: device }).host.deviceId).toBe("dev-1");
    expect(
      TailscaleStatus.parse({
        installed: true,
        running: true,
        hostName: "work.tail.ts.net",
        ips: ["100.64.0.1"],
      }).ips,
    ).toEqual(["100.64.0.1"]);

    const env = Environment.parse({
      id: "home",
      label: "Home",
      connection: { kind: "url", url: "https://wooky.example" },
      addedAt: at,
    });
    expect(env.deviceId).toBeUndefined();
  });
});

describe("sync and script contracts", () => {
  it("defaults sync settings and project scripts", () => {
    expect(SyncSettings.parse({})).toEqual({
      enabled: false,
      categories: {
        files: true,
        threads: true,
        settings: true,
        themes: true,
        ignoredFiles: false,
      },
      intervalSec: 30,
      retention: { keepDays: 30, keepMin: 50 },
      peers: [],
      projectMap: {},
    });
    expect(SyncSettings.safeParse({ intervalSec: 4 }).success).toBe(false);
    expect(SyncSettings.safeParse({ intervalSec: 3601 }).success).toBe(false);
    expect(ProjectSettings.parse({})).toEqual({ scripts: [] });
    expect(Project.parse({ id: "p1", name: "app", root: "/work", createdAt: at }).settings).toEqual(
      {
        scripts: [],
      },
    );

    const script = ProjectScript.parse({ id: "dev", name: "Dev", command: "pnpm dev" });
    expect(script.runOnWorktreeCreate).toBe(false);
    expect(
      ProjectScript.parse({
        id: "dev",
        name: "Dev",
        command: "pnpm dev",
        previewUrl: "http://localhost:${PORT}",
        runOnWorktreeCreate: true,
      }).previewUrl,
    ).toBe("http://localhost:${PORT}");
  });

  it("parses snapshots, conflicts, and resolutions", () => {
    const snapshot = Snapshot.parse({
      id: "abc123",
      kind: "files",
      projectId: "p1",
      threadId: null,
      deviceId: "dev-1",
      reason: "manual",
      createdAt: at,
      summary: { filesChanged: 2, insertions: 10, deletions: 1 },
      parentId: null,
    });
    expect(snapshot.kind).toBe("files");
    expect(Snapshot.safeParse({ ...snapshot, reason: "hourly" }).success).toBe(false);

    const conflict: SyncConflict = SyncConflict.parse({
      id: "c1",
      projectId: "p1",
      peerDeviceId: "dev-2",
      mine: "aaa",
      theirs: "bbb",
      base: null,
      paths: ["src/app.ts"],
      createdAt: at,
    });
    expect(ConflictResolution.parse("both")).toBe("both");
    expect(ConflictResolution.safeParse("union").success).toBe(false);
    const status = SyncStatus.parse({ enabled: true, peers: [], conflicts: [conflict] });
    expect(status.conflicts).toHaveLength(1);

    const push = SyncPush.parse({ push: "sync", kind: "snapshot", snapshot });
    expect(push.kind).toBe("snapshot");
    expect(SyncPush.parse({ push: "sync", kind: "status", ...status }).kind).toBe("status");
    const pushed = RpcPush.parse({ push: "sync", kind: "conflict", conflict });
    expect(pushed.push === "sync" && pushed.kind === "conflict").toBe(true);
  });
});

describe("terminal, commands, events, and rpc", () => {
  it("keeps pipe pushes and adds replay", () => {
    expect(
      TerminalPush.parse({ push: "terminal", sessionId: "s", kind: "data", data: "hi" }).kind,
    ).toBe("data");
    expect(
      TerminalPush.parse({ push: "terminal", sessionId: "s", kind: "replay", data: "scrollback" })
        .data,
    ).toBe("scrollback");
    const info = TerminalInfo.parse({
      sessionId: "s",
      title: "zsh",
      cwd: "/work",
      shell: "zsh",
      pty: false,
      createdAt: at,
      exited: false,
      projectId: null,
      scriptId: null,
    });
    expect(info.pty).toBe(false);
  });

  it("decodes old threads and the new commands and events", () => {
    const thread = Thread.parse(bareThread);
    expect(thread.ownerDeviceId).toBeNull();
    expect(thread.movedTo).toBeNull();
    expect(thread.movedFrom).toBeNull();
    expect(thread.pullRequest).toBeNull();

    expect(
      Command.parse({
        commandId: "c1",
        type: "project.configure",
        projectId: "p1",
        settings: { scripts: [] },
      }).type,
    ).toBe("project.configure");
    expect(
      Command.parse({
        commandId: "c2",
        type: "thread.release",
        threadId: "t1",
        toDeviceId: "dev-2",
        force: true,
      }),
    ).toMatchObject({ force: true });
    expect(
      Command.parse({
        commandId: "c3",
        type: "thread.import",
        sourceDeviceId: "dev-2",
        sourceThreadId: "t9",
        projectId: "p1",
        title: "Moved",
        provider: "demo",
        model: "demo",
        transcript: "prior turns",
      }).type,
    ).toBe("thread.import");

    const released = AgeEvent.parse({
      seq: 1,
      at,
      commandId: "c2",
      type: "thread.released",
      threadId: "t1",
      toDeviceId: "dev-2",
    });
    expect(released.type).toBe("thread.released");

    const imported = AgeEvent.parse({
      seq: 2,
      at,
      commandId: "c3",
      type: "thread.imported",
      thread: bareThread,
      sourceDeviceId: "dev-2",
      sourceThreadId: "t9",
      transcript: "prior turns",
    });
    expect(imported).toMatchObject({
      type: "thread.imported",
      thread: { ownerDeviceId: null },
    });

    const linked = AgeEvent.parse({
      seq: 3,
      at,
      commandId: null,
      type: "thread.prLinked",
      threadId: "t1",
      pullRequest: {
        url: "https://github.com/acme/app/pull/4",
        number: 4,
        state: "open",
        branch: "wooky/t1",
      },
    });
    expect(linked.type).toBe("thread.prLinked");
  });

  it("describes the new rpc methods", () => {
    expect(RpcMethods["device.info"].params.parse({})).toEqual({});
    expect(RpcMethods["device.rename"].result.parse(device).name).toBe("Work Mac");
    expect(
      RpcMethods["git.status"].result.parse({
        branch: "main",
        upstream: null,
        ahead: 0,
        behind: 1,
        dirty: false,
        hasRemote: true,
        ghAvailable: true,
        ghAuthed: false,
      }).behind,
    ).toBe(1);
    expect(RpcMethods["git.commit"].result.parse({ sha: "abc" }).sha).toBe("abc");
    expect(
      RpcMethods["git.push"].params.parse({ threadId: "t1", setUpstream: true }).setUpstream,
    ).toBe(true);
    expect(
      RpcMethods["git.pr.create"].result.parse({
        url: "https://github.com/acme/app/pull/4",
        number: 4,
      }).number,
    ).toBe(4);
    expect(RpcMethods["git.pr.status"].result.parse(null)).toBeNull();
    expect(RpcMethods["sync.now"].result.parse({ ok: true })).toEqual({ ok: true });
    expect(
      RpcMethods["sync.conflicts.resolve"].params.parse({ conflictId: "c1", resolution: "mine" })
        .resolution,
    ).toBe("mine");
    expect(
      RpcMethods["sync.snapshots.diff"].params.parse({ snapshotId: "abc", against: "working" })
        .against,
    ).toBe("working");
    expect(
      RpcMethods["sync.snapshots.restore"].result.parse({ backupSnapshotId: "bak" })
        .backupSnapshotId,
    ).toBe("bak");
    expect(
      RpcMethods["terminal.open"].params.parse({ size: { cols: 80, rows: 24 }, projectId: "p1" }),
    ).toEqual({
      size: { cols: 80, rows: 24 },
      projectId: "p1",
    });
    expect(
      RpcMethods["scripts.run"].params.parse({ projectId: "p1", scriptId: "dev" }).scriptId,
    ).toBe("dev");
    expect(RpcMethods["remote.devices.revoke"].result.parse({ ok: true })).toEqual({ ok: true });
  });
});
