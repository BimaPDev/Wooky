// wooky-allow-file color: fixture data, no colours
import type {
  AgeEvent,
  Command,
  DeviceInfo,
  FileDiff,
  ReplicaModel,
  Snapshot,
  SyncStatus,
  Thread,
  Turn,
} from "@wooky/contracts";
import { RpcCallError } from "../rpc/client.ts";

/** Fixture data for snapshot history, conflicts, peer threads and "Continue on this device". */

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const HOME = "dev-home";
const WORK = "dev-work";
const PC = "dev-pc";

const device: DeviceInfo = {
  deviceId: HOME,
  name: "Home Mac",
  platform: "darwin",
  version: "0.1.0",
};

export const fixtureProjectMap = { p1: { [HOME]: "/Users/demo/code/orders-api" } };

const listPatchA = `--- a/src/api/list.ts
+++ b/src/api/list.ts
@@ -1,9 +1,12 @@
 import { db } from "../db.ts";

-export async function listOrders() {
-  return db.orders.findMany();
+export async function listOrders(cursor?: string, limit = 50) {
+  return db.orders.findMany({
+    take: limit,
+    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
+  });
 }

 export async function countOrders() {
   return db.orders.count();
 }
`;

const listPatchTheirs = `--- a/src/api/list.ts
+++ b/src/api/list.ts
@@ -1,9 +1,11 @@
 import { db } from "../db.ts";

-export async function listOrders() {
-  return db.orders.findMany();
+export async function listOrders(page = 1, size = 100) {
+  return db.orders.findMany({ take: size, skip: (page - 1) * size });
 }

 export async function countOrders() {
   return db.orders.count();
 }
`;

const testPatch = `--- /dev/null
+++ b/src/api/list.test.ts
@@ -0,0 +1,8 @@
+import { expect, it } from "vitest";
+import { listOrders } from "./list.ts";
+
+it("pages with a cursor", async () => {
+  const first = await listOrders(undefined, 2);
+  const next = await listOrders(first.at(-1)?.id, 2);
+  expect(next[0]?.id).not.toBe(first[0]?.id);
+});
`;

const readmeMine = `--- a/README.md
+++ b/README.md
@@ -12,3 +12,4 @@ Run the API with \`pnpm dev\`.
 ## Orders

-List endpoints return everything.
+List endpoints are paginated. Pass \`cursor\` and \`limit\`.
+The default page size is 50.
`;

const readmeTheirs = `--- a/README.md
+++ b/README.md
@@ -12,3 +12,3 @@ Run the API with \`pnpm dev\`.
 ## Orders

-List endpoints return everything.
+List endpoints take \`page\` and \`size\` (up to 100).
`;

const configPatch = `--- a/wooky.config.json
+++ b/wooky.config.json
@@ -1,5 +1,5 @@
 {
   "name": "orders-api",
-  "port": 3000,
+  "port": 3100,
   "db": "postgres://localhost/orders"
 }
`;

const file = (path: string, status: FileDiff["status"], patch: string): FileDiff => {
  const lines = patch.split("\n");
  return {
    path,
    status,
    additions: lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
    deletions: lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length,
    patch,
  };
};

const listA = file("src/api/list.ts", "modified", listPatchA);
const listTest = file("src/api/list.test.ts", "added", testPatch);
const readmeA = file("README.md", "modified", readmeMine);
const config = file("wooky.config.json", "modified", configPatch);

function snapshot(
  n: number,
  minutes: number,
  reason: Snapshot["reason"],
  summary: [number, number, number] | null,
  extra: Partial<Snapshot> = {},
): Snapshot {
  return {
    id: `s-${String(n).padStart(2, "0")}`,
    kind: "files",
    projectId: "p1",
    threadId: null,
    deviceId: HOME,
    reason,
    createdAt: ago(minutes),
    summary: summary
      ? { filesChanged: summary[0], insertions: summary[1], deletions: summary[2] }
      : null,
    parentId: `s-${String(n + 1).padStart(2, "0")}`,
    ...extra,
  };
}

/** Newest first. 32 rows, so a page of 25 leaves a second page behind "Load older". */
const featured: Snapshot[] = [
  snapshot(1, 4, "interval", [3, 14, 3]),
  snapshot(2, 11, "turn", [4, 31, 7], { threadId: "t1" }),
  snapshot(3, 19, "incoming", [2, 9, 2], { deviceId: WORK }),
  snapshot(4, 19, "before-apply", [2, 9, 2]),
  snapshot(5, 42, "manual", [5, 48, 12]),
  snapshot(6, 64, "revert", [2, 6, 19], { threadId: "t1" }),
  snapshot(7, 64, "before-apply", [2, 6, 19]),
  snapshot(8, 95, "turn", [3, 22, 5], { threadId: "t2" }),
];

export const fixtureSnapshots: Snapshot[] = [
  ...featured,
  ...Array.from({ length: 24 }, (_, index) =>
    snapshot(
      9 + index,
      120 + index * 35,
      index % 5 === 3 ? "turn" : "interval",
      [1 + (index % 3), 4 + index, index % 4],
      index % 5 === 3 ? { threadId: "t1" } : {},
    ),
  ),
];

function diffFor(snapshotId: string, against: string | undefined): FileDiff[] {
  if (against === "working") return [readmeA, config];
  if (snapshotId === "s-01-mine") return [];
  const index = fixtureSnapshots.findIndex((entry) => entry.id === snapshotId);
  if (index < 0) return [];
  const row = fixtureSnapshots[index];
  const count = Math.min(row?.summary?.filesChanged ?? 2, 4);
  return [listA, listTest, readmeA, config].slice(0, Math.max(count, 1));
}

const initialConflicts: SyncStatus["conflicts"] = [
  {
    id: "conflict-1",
    projectId: "p1",
    peerDeviceId: WORK,
    mine: "s-01",
    theirs: "peer-work-1",
    base: "s-05",
    paths: ["src/api/list.ts", "README.md"],
    createdAt: ago(6),
  },
];

let conflicts = [...initialConflicts];
const initialSnapshots = [...fixtureSnapshots];

/** Tests share this module, so they put the mutable fixture state back before each case. */
export function resetAnywhereHistoryFixture(): void {
  conflicts = [...initialConflicts];
  fixtureSnapshots.splice(0, fixtureSnapshots.length, ...initialSnapshots);
}

const conflictDiffs: Record<string, FileDiff[]> = {
  "s-01": [listA, readmeA],
  "peer-work-1": [
    file("src/api/list.ts", "modified", listPatchTheirs),
    file("README.md", "modified", readmeTheirs),
  ],
};

function syncStatus(): SyncStatus {
  return {
    enabled: true,
    peers: [
      { deviceId: WORK, name: "Work Mac", state: "idle", lastSyncAt: ago(3), error: null },
      { deviceId: PC, name: "Windows PC", state: "offline", lastSyncAt: ago(1500), error: null },
    ],
    conflicts,
  };
}

const peerThread = (
  fields: Partial<Thread> & Pick<Thread, "id" | "title" | "ownerDeviceId">,
): Thread => ({
  projectId: "p1",
  provider: "claude",
  model: "claude-opus-5-5",
  runtimeMode: "auto-edits",
  worktree: null,
  providerSessionId: null,
  movedTo: null,
  movedFrom: null,
  pullRequest: null,
  queue: [],
  status: "idle",
  createdAt: ago(900),
  updatedAt: ago(30),
  ...fields,
});

const peerTurn = (fields: Partial<Turn> & Pick<Turn, "id" | "threadId" | "prompt">): Turn => ({
  provider: "claude",
  model: "claude-opus-5-5",
  status: "completed",
  items: [],
  startedAt: ago(50),
  endedAt: ago(46),
  checkpointBefore: null,
  checkpointAfter: null,
  changedFiles: [],
  usage: null,
  error: null,
  ...fields,
});

export const fixtureReplicas: ReplicaModel = {
  replicas: {
    [WORK]: {
      seq: 118,
      threads: {
        "w-upload": peerThread({
          id: "w-upload",
          title: "Retry failed uploads",
          ownerDeviceId: WORK,
          updatedAt: ago(35),
        }),
        "w-billing": peerThread({
          id: "w-billing",
          title: "Migrate billing webhooks",
          ownerDeviceId: WORK,
          status: "running",
          updatedAt: ago(1),
        }),
        "w-tz": peerThread({
          id: "w-tz",
          title: "Fix timezone bug in reports",
          ownerDeviceId: WORK,
          status: "waiting",
          updatedAt: ago(9),
        }),
      },
      turns: {
        "w-upload": [
          peerTurn({
            id: "wt-1",
            threadId: "w-upload",
            prompt: "Uploads fail silently when the network drops. Add a retry with backoff.",
            changedFiles: ["src/upload/client.ts", "src/upload/client.test.ts"],
            items: [
              {
                kind: "tool",
                id: "wi-1",
                tool: "read",
                title: "Read src/upload/client.ts",
                name: "Read",
                status: "done",
              },
              {
                kind: "tool",
                id: "wi-2",
                tool: "edit",
                title: "Edit src/upload/client.ts",
                name: "Edit",
                status: "done",
              },
              {
                kind: "tool",
                id: "wi-3",
                tool: "command",
                title: "pnpm test upload",
                name: "Bash",
                status: "done",
                output: "4 passed",
              },
              {
                kind: "message",
                id: "wi-4",
                role: "assistant",
                text: "Uploads now retry up to **4 times** with exponential backoff (250 ms, 500 ms, 1 s, 2 s) and give up with a clear error.\n\nI added a test that drops the connection twice and checks the third attempt succeeds.",
              },
            ],
          }),
          peerTurn({
            id: "wt-2",
            threadId: "w-upload",
            prompt: "Also log each retry at debug level.",
            startedAt: ago(40),
            endedAt: ago(35),
            items: [
              {
                kind: "message",
                id: "wi-5",
                role: "assistant",
                text: "Each retry now logs `upload retry n/4` with the delay. Nothing else changed.",
              },
            ],
          }),
        ],
        "w-billing": [
          peerTurn({
            id: "wt-3",
            threadId: "w-billing",
            prompt: "Move the billing webhooks to the new signing scheme.",
            status: "running",
            startedAt: ago(6),
            endedAt: null,
            items: [
              {
                kind: "tool",
                id: "wi-6",
                tool: "search",
                title: "Search webhook handlers",
                name: "Grep",
                status: "done",
              },
              {
                kind: "tool",
                id: "wi-7",
                tool: "edit",
                title: "Edit src/billing/webhook.ts",
                name: "Edit",
                status: "running",
              },
            ],
          }),
        ],
        "w-tz": [
          peerTurn({
            id: "wt-4",
            threadId: "w-tz",
            prompt: "Reports show the wrong day near midnight. Find out why.",
            status: "running",
            startedAt: ago(12),
            endedAt: null,
            items: [
              {
                kind: "approval",
                id: "wi-8",
                requestId: "wr-1",
                tool: "command",
                title: "Run pnpm test reports",
                detail: "pnpm test reports",
                decision: null,
              },
            ],
          }),
        ],
      },
    },
    [PC]: {
      seq: 40,
      threads: {
        "pc-paths": peerThread({
          id: "pc-paths",
          title: "Windows path handling",
          ownerDeviceId: PC,
          provider: "codex",
          model: "gpt-5.5-codex",
          updatedAt: ago(1500),
        }),
      },
      turns: {
        "pc-paths": [
          peerTurn({
            id: "pt-1",
            threadId: "pc-paths",
            prompt: "Normalise backslashes in project roots.",
            provider: "codex",
            model: "gpt-5.5-codex",
            startedAt: ago(1510),
            endedAt: ago(1500),
            items: [
              {
                kind: "message",
                id: "pi-1",
                role: "assistant",
                text: "Project roots are normalised on add. A trailing separator no longer makes two projects.",
              },
            ],
          }),
        ],
      },
    },
  },
};

/** Local threads for the moved-to and continued-from banners. Merged into the fixture model. */
export const fixtureMovedThreads: Record<string, Thread> = {
  "t-moved": peerThread({
    id: "t-moved",
    title: "Tidy the export script",
    ownerDeviceId: null,
    movedTo: { deviceId: WORK, at: ago(55) },
    updatedAt: ago(55),
  }),
  "t-continued": peerThread({
    id: "t-continued",
    title: "Cache invalidation on refunds",
    ownerDeviceId: null,
    movedFrom: { deviceId: WORK, threadId: "w-old" },
    updatedAt: ago(70),
  }),
};

export const fixtureMovedTurns: Record<string, Turn[]> = {
  "t-moved": [
    peerTurn({
      id: "mt-1",
      threadId: "t-moved",
      prompt: "Tidy scripts/export.ts so the flags read clearly.",
      items: [
        {
          kind: "message",
          id: "mi-1",
          role: "assistant",
          text: "Flags are grouped and documented in the `--help` output.",
        },
      ],
    }),
  ],
  "t-continued": [
    peerTurn({
      id: "ct-1",
      threadId: "t-continued",
      prompt: "Invalidate the order cache when a refund lands.",
      items: [
        {
          kind: "message",
          id: "ci-1",
          role: "assistant",
          text: "Refunds now evict the order and its customer summary from the cache.",
        },
      ],
    }),
  ],
};

const busy = () =>
  typeof location !== "undefined" && new URLSearchParams(location.search).has("restoreBusy");

export function anywhereHistoryRespond(method: string, params: unknown): { value: unknown } | null {
  switch (method) {
    case "device.info":
      return { value: device };
    // The Changes panel's ship menu reads these; the fixture had no answer for them.
    case "git.status":
      return {
        value: {
          branch: "wooky/paginate-orders",
          upstream: null,
          ahead: 0,
          behind: 0,
          dirty: true,
          hasRemote: false,
          ghAvailable: false,
          ghAuthed: false,
        },
      };
    case "git.pr.status":
      return { value: null };
    case "sync.status":
      return { value: syncStatus() };
    case "sync.replicas":
      return { value: fixtureReplicas };
    case "sync.snapshots.list": {
      const { limit = 25, before } = params as { limit?: number; before?: string };
      const start = before ? fixtureSnapshots.findIndex((entry) => entry.id === before) + 1 : 0;
      return { value: fixtureSnapshots.slice(start, start + limit) };
    }
    case "sync.snapshots.diff": {
      const { snapshotId, against } = params as { snapshotId: string; against?: string };
      const forConflict = conflictDiffs[snapshotId];
      return {
        value:
          forConflict && against && against !== "working"
            ? forConflict
            : diffFor(snapshotId, against),
      };
    }
    case "sync.snapshots.restore": {
      if (busy())
        throw new RpcCallError(
          "conflict",
          "An agent is working in this project. Restore when it finishes.",
        );
      return { value: { backupSnapshotId: `backup-${Date.now()}` } };
    }
    case "sync.snapshots.create": {
      const { label } = params as { projectId: string; label?: string };
      const created = snapshot(0, 0, "manual", [1, 2, 0]);
      const row = {
        ...created,
        id: `s-new-${fixtureSnapshots.length}`,
        parentId: fixtureSnapshots[0]?.id ?? null,
      };
      if (label) console.info("Wooky fixture snapshot label", label);
      fixtureSnapshots.unshift(row);
      return { value: row };
    }
    case "sync.conflicts.resolve": {
      const { conflictId } = params as { conflictId: string };
      conflicts = conflicts.filter((entry) => entry.id !== conflictId);
      return { value: { ok: true } };
    }
    default:
      return null;
  }
}

type Draft = AgeEvent extends infer Event
  ? Event extends AgeEvent
    ? Omit<Event, "seq" | "at"> & { at?: string }
    : never
  : never;
type Inject = (drafts: readonly Draft[]) => void;

/** Claims: the Work Mac thread "Retry failed uploads" moves; the busy one fails until forced. */
export function anywhereHistoryCommand(command: Command, inject: Inject): boolean {
  if (command.type !== "thread.claim") return false;
  inject([
    {
      type: "thread.claimRequested",
      commandId: command.commandId,
      claimId: command.commandId,
      ownerDeviceId: command.ownerDeviceId,
      ownerThreadId: command.ownerThreadId,
      projectId: command.projectId,
    },
  ]);
  const owner = fixtureReplicas.replicas[command.ownerDeviceId]?.threads[command.ownerThreadId];
  const turns = fixtureReplicas.replicas[command.ownerDeviceId]?.turns[command.ownerThreadId] ?? [];
  setTimeout(() => {
    if (!owner) return;
    if (owner.status === "running" && !command.force) {
      inject([
        {
          type: "thread.claimFailed",
          commandId: null,
          claimId: command.commandId,
          reason: "The agent on Work Mac is busy with a running turn.",
        },
      ]);
      return;
    }
    const id = `t-claimed-${owner.id}`;
    inject([
      {
        type: "thread.imported",
        commandId: command.commandId,
        claimId: command.commandId,
        sourceDeviceId: command.ownerDeviceId,
        sourceThreadId: owner.id,
        transcript: "",
        historyTurns: turns
          .filter((turn) => turn.status !== "running")
          .map((turn) => ({ ...turn, status: "completed" as const })),
        thread: { ...owner, id, projectId: command.projectId, ownerDeviceId: null, status: "idle" },
      },
    ]);
  }, 1800);
  return true;
}
