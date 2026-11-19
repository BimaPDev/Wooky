// age-allow-file color: dev fixture themes are user data stored as hex, like the server sends them.
import {
  AppearanceTheme,
  DeviceSettings,
  type AgeEvent,
  type AppearanceTheme as AppearanceThemeValue,
  type Command,
  type DeviceSettings as DeviceSettingsValue,
  type FileDiff,
  type Origin,
  type ProviderStatus,
  type ReadModel,
  type RpcMethod,
  type RpcParams,
  type RpcResult,
  type Thread,
  type Turn,
  type UsageHistoryBucket,
  type UsageHistoryResult,
  type UsageWindowDays,
} from "@wooky/contracts";
import { fleetRows } from "@wooky/domain";
import { receiveEvent, useStore } from "../state/store.ts";
import {
  looksLikeSvg,
  looksLikeT3code,
  themeFromT3code,
  wallpaperThemeFromSvg,
} from "../components/theme-studio/helpers.ts";
import type { Backend } from "../state/backend.ts";
import { RpcCallError } from "../rpc/client.ts";

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const thread = (fields: Partial<Thread> & Pick<Thread, "id" | "projectId" | "title">): Thread => ({
  provider: "claude",
  model: "claude-opus-5-5",
  runtimeMode: "approve",
  worktree: null,
  providerSessionId: null,
  queue: [],
  status: "idle",
  createdAt: ago(600),
  updatedAt: ago(60),
  ...fields,
});

const turn = (fields: Partial<Turn> & Pick<Turn, "id" | "threadId" | "prompt">): Turn => ({
  provider: "claude",
  model: "claude-opus-5-5",
  status: "completed",
  items: [],
  startedAt: ago(30),
  endedAt: ago(28.8),
  checkpointBefore: null,
  checkpointAfter: null,
  changedFiles: [],
  usage: null,
  error: null,
  ...fields,
});

const paginationPatch = `--- a/src/api/list.ts
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
\\ No newline at end of file
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

const readmePatch = `--- a/README.md
+++ b/README.md
@@ -12,3 +12,4 @@ Run the API with \`pnpm dev\`.
 ## Orders

-List endpoints return everything.
+List endpoints are paginated. Pass \`cursor\` and \`limit\`.
+The default page size is 50.
`;

const finishedAnswer = `Orders are now paginated with a cursor.

## What changed

- \`listOrders\` takes an optional \`cursor\` and a \`limit\` (default **50**).
- A test covers paging forward with a cursor.
- The README explains the new parameters.

\`\`\`ts
const page = await listOrders(cursor, 25);
\`\`\`

The full suite passes. See the [Prisma docs](https://www.prisma.io/docs) for cursor details.`;

const liveText = `I found the flaky test. It races the cache warm-up in \`beforeAll\`, so the first request sometimes sees an empty cache.

The fix is to await \`warmCache()\` before the server starts listening. I'm now`;

export const fixtureModel: ReadModel = {
  seq: 42,
  projects: {
    p1: { id: "p1", name: "orders-api", root: "/Users/demo/code/orders-api", createdAt: ago(900) },
    p2: { id: "p2", name: "marketing-site", root: "/Users/demo/code/site", createdAt: ago(800) },
  },
  threads: {
    t1: thread({
      id: "t1",
      projectId: "p1",
      title: "Paginate the orders list",
      updatedAt: ago(28),
      worktree: { path: "/Users/demo/.age/worktrees/t1", branch: "age/paginate-orders" },
    }),
    t2: thread({
      id: "t2",
      projectId: "p1",
      title: "Fix the flaky cache test",
      provider: "codex",
      model: "gpt-5.5-codex",
      runtimeMode: "auto-edits",
      status: "running",
      updatedAt: ago(0.2),
      worktree: { path: "/Users/demo/.age/worktrees/t2", branch: "age/fix-flaky-cache" },
    }),
    t3: thread({
      id: "t3",
      projectId: "p1",
      title: "Rename the config loader",
      provider: "cursor",
      model: "auto",
      status: "waiting",
      updatedAt: ago(2),
    }),
    t4: thread({
      id: "t4",
      projectId: "p2",
      title: "Upgrade the build tooling",
      provider: "demo",
      model: "demo",
      status: "error",
      updatedAt: ago(45),
    }),
    t5: thread({ id: "t5", projectId: "p2", title: "New thread", updatedAt: ago(120) }),
    t6: thread({
      id: "t6",
      projectId: "p1",
      title: "P0 UI fixture",
      provider: "claude",
      model: "claude-opus-5-5",
      interactionMode: "plan",
      status: "waiting",
      updatedAt: ago(0.05),
      queue: [
        { id: "q1", prompt: "Also update the README", queuedAt: ago(0.2) },
        { id: "q2", prompt: "Add a migration note", queuedAt: ago(0.1) },
      ],
    }),
    t7: thread({
      id: "t7",
      projectId: "p1",
      title: "Shared workspace peer",
      updatedAt: ago(5),
    }),
    t8: thread({
      id: "t8",
      projectId: "p1",
      title: "Failover: running on a fallback",
      provider: "codex",
      model: "gpt-5.5-codex",
      updatedAt: ago(1),
      failover: {
        original: { provider: "claude", model: "claude-opus-5-5" },
        switchedAt: ago(4),
        reason: "quota",
        resetAt: ago(-90),
        switches: 1,
      },
    }),
    t9: thread({
      id: "t9",
      projectId: "p1",
      title: "Failover: switched back",
      updatedAt: ago(1),
    }),
    t10: thread({
      id: "t10",
      projectId: "p1",
      title: "Failover: no switch happened",
      status: "error",
      updatedAt: ago(1),
    }),
    "t-coord": thread({
      id: "t-coord",
      projectId: "p1",
      title: "Coordinate the pagination work",
      role: "coordinator",
      groupId: "g-orch",
      updatedAt: ago(8),
    }),
    "t-w1": thread({
      id: "t-w1",
      projectId: "p1",
      title: "Draft the API change",
      role: "worker",
      parentThreadId: "t-coord",
      groupId: "g-orch",
      isolate: true,
      status: "waiting",
      updatedAt: ago(1),
      worktree: { path: "/Users/demo/.age/worktrees/t-w1", branch: "age/draft-api" },
    }),
    "t-w2": thread({
      id: "t-w2",
      projectId: "p1",
      title: "Write the tests",
      provider: "codex",
      model: "gpt-5.5-codex",
      role: "worker",
      parentThreadId: "t-coord",
      groupId: "g-orch",
      isolate: true,
      status: "running",
      updatedAt: ago(0.4),
      worktree: { path: "/Users/demo/.age/worktrees/t-w2", branch: "age/write-tests" },
    }),
    "t-w3": thread({
      id: "t-w3",
      projectId: "p1",
      title: "Update the README",
      provider: "demo",
      model: "demo",
      role: "worker",
      parentThreadId: "t-coord",
      groupId: "g-orch",
      isolate: true,
      updatedAt: ago(12),
      report: {
        turnId: "uw3",
        summary: "Documented cursor pagination in the README.",
        diffStat: { files: 1, additions: 2, deletions: 1 },
        at: ago(12),
      },
      worktree: { path: "/Users/demo/.age/worktrees/t-w3", branch: "age/update-readme" },
    }),
    "t-f1": thread({
      id: "t-f1",
      projectId: "p1",
      title: "Claude pagination",
      role: "worker",
      groupId: "g-fan",
      isolate: true,
      updatedAt: ago(6),
      report: {
        turnId: "uf1",
        summary: "Cursor pagination on listOrders with a test and README note.",
        diffStat: { files: 3, additions: 15, deletions: 3 },
        at: ago(6),
      },
      worktree: { path: "/Users/demo/.age/worktrees/t-f1", branch: "age/fanout-claude" },
    }),
    "t-f2": thread({
      id: "t-f2",
      projectId: "p1",
      title: "Codex pagination",
      provider: "codex",
      model: "gpt-5.5-codex",
      role: "worker",
      groupId: "g-fan",
      isolate: true,
      updatedAt: ago(7),
      report: {
        turnId: "uf2",
        summary: "Offset pagination plus a smaller page size default.",
        diffStat: { files: 2, additions: 8, deletions: 2 },
        at: ago(7),
      },
      worktree: { path: "/Users/demo/.age/worktrees/t-f2", branch: "age/fanout-codex" },
    }),
    "t-f3": thread({
      id: "t-f3",
      projectId: "p1",
      title: "Demo pagination",
      provider: "demo",
      model: "demo",
      role: "worker",
      groupId: "g-fan",
      isolate: true,
      status: "error",
      updatedAt: ago(9),
      report: {
        turnId: "uf3",
        summary: "Turn failed while editing listOrders.",
        diffStat: { files: 1, additions: 5, deletions: 2 },
        at: ago(9),
      },
      worktree: { path: "/Users/demo/.age/worktrees/t-f3", branch: "age/fanout-demo" },
    }),
  },
  turns: {
    t1: [
      turn({
        id: "u1",
        threadId: "t1",
        prompt: "Paginate the orders list endpoint with a cursor and document it.",
        changedFiles: ["src/api/list.ts", "src/api/list.test.ts", "README.md"],
        checkpointBefore: "refs/age/checkpoints/t1/u1/before",
        checkpointAfter: "refs/age/checkpoints/t1/u1/after",
        startedAt: ago(30),
        endedAt: ago(28.8),
        items: [
          {
            kind: "reasoning",
            id: "u1r",
            text: "The list endpoint returns every row. A cursor keeps pages stable while orders are inserted.",
          },
          {
            kind: "tool",
            id: "u1a",
            tool: "read",
            title: "Read src/api/list.ts",
            name: "Read",
            status: "done",
            files: ["src/api/list.ts"],
            output: "export async function listOrders() {\n  return db.orders.findMany();\n}",
          },
          {
            kind: "tool",
            id: "u1b",
            tool: "edit",
            title: "Edit src/api/list.ts",
            name: "Edit",
            status: "done",
            files: ["src/api/list.ts"],
          },
          {
            kind: "tool",
            id: "u1c",
            tool: "edit",
            title: "Create src/api/list.test.ts",
            name: "Write",
            status: "done",
            files: ["src/api/list.test.ts"],
          },
          {
            kind: "tool",
            id: "u1d",
            tool: "command",
            title: "pnpm vitest run src/api",
            name: "Bash",
            status: "done",
            output:
              " ✓ src/api/list.test.ts (1 test) 12ms\n\n Test Files  1 passed (1)\n      Tests  1 passed (1)",
          },
          { kind: "message", id: "u1m", role: "assistant", text: finishedAnswer },
        ],
      }),
    ],
    t2: [
      turn({
        id: "u2",
        threadId: "t2",
        prompt: "The cache test fails about one run in five. Find out why and fix it.",
        provider: "codex",
        model: "gpt-5.5-codex",
        status: "running",
        startedAt: ago(1.3),
        endedAt: null,
        items: [
          {
            kind: "reasoning",
            id: "u2r",
            text: "Intermittent failures usually mean ordering. I'll look at setup hooks first.",
          },
          {
            kind: "tool",
            id: "u2a",
            tool: "search",
            title: "Search for warmCache",
            name: "grep",
            status: "done",
            output:
              "src/cache.ts:14  export async function warmCache()\ntest/cache.test.ts:6  void warmCache();",
          },
          {
            kind: "tool",
            id: "u2b",
            tool: "read",
            title: "Read test/cache.test.ts",
            name: "read",
            status: "done",
            files: ["test/cache.test.ts"],
          },
          {
            kind: "tool",
            id: "u2c",
            tool: "command",
            title: "pnpm vitest run test/cache.test.ts --repeat 20",
            name: "shell",
            status: "failed",
            output: "Tests  4 failed | 16 passed (20)",
          },
          { kind: "message", id: "u2m", role: "assistant", text: liveText },
          {
            kind: "tool",
            id: "u2d",
            tool: "edit",
            title: "Edit test/cache.test.ts",
            name: "apply_patch",
            status: "running",
            files: ["test/cache.test.ts"],
          },
        ],
      }),
    ],
    t3: [
      turn({
        id: "u3",
        threadId: "t3",
        prompt: "Rename loadConfig to readConfig everywhere.",
        provider: "cursor",
        model: "auto",
        status: "running",
        startedAt: ago(2.5),
        endedAt: null,
        items: [
          {
            kind: "tool",
            id: "u3a",
            tool: "search",
            title: "Search for loadConfig",
            name: "grep",
            status: "done",
            output: "src/config.ts\nsrc/main.ts",
          },
          {
            kind: "approval",
            id: "u3p",
            requestId: "r3",
            tool: "edit",
            title: "Edit src/config.ts",
            detail: "Rename the exported function.",
            decision: null,
            diff: '--- a/src/config.ts\n+++ b/src/config.ts\n@@ -3,5 +3,5 @@\n import { parse } from "./parse.ts";\n \n-export function loadConfig(path: string) {\n+export function readConfig(path: string) {\n   return parse(readFileSync(path, "utf8"));\n }\n',
          },
        ],
      }),
    ],
    t4: [
      turn({
        id: "u4a",
        threadId: "t4",
        provider: "demo",
        model: "demo",
        prompt: "Check which build tools are outdated.",
        startedAt: ago(50),
        endedAt: ago(49.5),
        items: [
          {
            kind: "approval",
            id: "u4ap",
            requestId: "r4",
            tool: "command",
            title: "Run pnpm outdated",
            detail: "Lists outdated packages.",
            decision: "allow",
          },
          {
            kind: "tool",
            id: "u4t",
            tool: "command",
            title: "pnpm outdated",
            name: "Bash",
            status: "done",
            output: "vite  7.1.0  8.3.8",
          },
          {
            kind: "message",
            id: "u4m",
            role: "assistant",
            text: "Only Vite is behind: 7.1 to 8.3.",
          },
        ],
      }),
      turn({
        id: "u4b",
        threadId: "t4",
        provider: "demo",
        model: "demo",
        prompt: "Upgrade Vite and fix anything that breaks.",
        status: "failed",
        startedAt: ago(46),
        endedAt: ago(45),
        error: "The agent process exited unexpectedly (code 1).",
        items: [
          {
            kind: "tool",
            id: "u4c",
            tool: "command",
            title: "pnpm add -D vite@8",
            name: "Bash",
            status: "failed",
            output: "ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/vite: Not Found",
          },
          { kind: "error", id: "u4e", message: "The package registry could not be reached." },
        ],
      }),
    ],
    t5: [],
    t6: [
      turn({
        id: "u6a",
        threadId: "t6",
        prompt: "Answer a question and approve the plan",
        status: "completed",
        startedAt: ago(40),
        endedAt: ago(38),
        items: [
          {
            kind: "question",
            id: "u6q-done",
            requestId: "rq-done",
            questions: [
              {
                id: "picked",
                header: "Database",
                question: "Which store?",
                options: [{ label: "SQLite", description: "Local file" }],
                multiSelect: false,
                allowCustom: false,
              },
            ],
            answers: { picked: ["SQLite"] },
          },
          {
            kind: "plan",
            id: "u6plan-old",
            markdown: "## Old plan\n\n1. Sketch\n2. Pause",
            status: "superseded",
          },
        ],
      }),
      turn({
        id: "u6b",
        threadId: "t6",
        prompt: "Plan pagination changes",
        status: "running",
        interactionMode: "plan",
        startedAt: ago(1),
        endedAt: null,
        items: [
          {
            kind: "question",
            id: "u6q-open",
            requestId: "rq-open",
            questions: [
              {
                id: "style",
                header: "API style",
                question: "How should clients page?",
                options: [
                  { label: "Cursor", description: "Stable cursor token" },
                  { label: "Offset", description: "Skip/limit" },
                ],
                multiSelect: false,
                allowCustom: true,
              },
            ],
            answers: null,
          },
          {
            kind: "plan",
            id: "u6plan-new",
            markdown:
              "## Plan\n\n- Add `cursor` to `listOrders`\n- Cover with a vitest\n- Document defaults",
            status: "proposed",
          },
        ],
      }),
    ],
    t7: [
      turn({
        id: "u7",
        threadId: "t7",
        prompt: "Touch shared files after t6",
        checkpointBefore: "refs/age/checkpoints/t7/u7/before",
        startedAt: ago(4),
        endedAt: ago(3.5),
        items: [{ kind: "message", id: "u7m", role: "assistant", text: "Updated shared config." }],
      }),
    ],
    t8: [
      turn({
        id: "u8a",
        threadId: "t8",
        prompt: "Add retry with backoff to the sync job.",
        status: "failed",
        startedAt: ago(5),
        endedAt: ago(4.5),
        error: "Claude usage limit reached.",
        failure: { kind: "quota", resetAt: ago(-90), message: "Claude usage limit reached." },
      }),
      turn({
        id: "u8b",
        threadId: "t8",
        prompt: "Add retry with backoff to the sync job.",
        provider: "codex",
        model: "gpt-5.5-codex",
        origin: {
          kind: "failover",
          from: { provider: "claude", model: "claude-opus-5-5" },
          to: { provider: "codex", model: "gpt-5.5-codex" },
          failure: { kind: "quota", resetAt: ago(-90), message: "Claude usage limit reached." },
          switches: 1,
        },
        startedAt: ago(4),
        endedAt: ago(1.5),
        items: [
          {
            kind: "message",
            id: "u8bm",
            role: "assistant",
            text: "The sync job now retries three times with exponential backoff.",
          },
        ],
      }),
    ],
    "t-coord": [
      turn({
        id: "ucoord",
        threadId: "t-coord",
        prompt: "Split pagination across workers.",
        startedAt: ago(20),
        endedAt: ago(18),
        items: [
          {
            kind: "message",
            id: "ucoordm",
            role: "assistant",
            text: "I spawned workers for the API, tests, and README.",
          },
        ],
      }),
    ],
    t9: [
      turn({
        id: "u9a",
        threadId: "t9",
        prompt: "Summarize the open migrations.",
        status: "failed",
        startedAt: ago(90),
        endedAt: ago(89),
        error: "Claude rate limit reached.",
        failure: { kind: "rate_limit", message: "Claude rate limit reached." },
      }),
      turn({
        id: "u9b",
        threadId: "t9",
        prompt: "Summarize the open migrations.",
        provider: "codex",
        model: "gpt-5.5-codex",
        origin: {
          kind: "failover",
          from: { provider: "claude", model: "claude-opus-5-5" },
          to: { provider: "codex", model: "gpt-5.5-codex" },
          failure: { kind: "rate_limit", message: "Claude rate limit reached." },
          switches: 1,
        },
        startedAt: ago(88),
        endedAt: ago(86),
        items: [
          { kind: "message", id: "u9bm", role: "assistant", text: "Two migrations are open." },
        ],
      }),
      turn({
        id: "u9c",
        threadId: "t9",
        prompt: "Now draft the rollback plan.",
        origin: {
          kind: "restore",
          from: { provider: "codex", model: "gpt-5.5-codex" },
          to: { provider: "claude", model: "claude-opus-5-5" },
        },
        startedAt: ago(3),
        endedAt: ago(1.5),
        items: [{ kind: "message", id: "u9cm", role: "assistant", text: "Rollback drafted." }],
      }),
    ],
    t10: [
      turn({
        id: "u10",
        threadId: "t10",
        prompt: "Refactor the retry helper.",
        status: "failed",
        startedAt: ago(3),
        endedAt: ago(2.5),
        error: "Claude usage limit reached. Resets at 3:00 PM.",
        failure: {
          kind: "quota",
          resetAt: ago(-90),
          message: "Claude usage limit reached. Resets at 3:00 PM.",
        },
      }),
    ],
    "t-w1": [
      turn({
        id: "uw1",
        threadId: "t-w1",
        prompt: "Draft the API change.",
        status: "running",
        startedAt: ago(3),
        endedAt: null,
        items: [
          {
            kind: "approval",
            id: "uw1a",
            requestId: "rw1",
            tool: "edit",
            title: "Edit src/api/list.ts",
            detail: "Add cursor arguments to listOrders.",
            decision: null,
          },
        ],
      }),
    ],
    "t-w2": [
      turn({
        id: "uw2",
        threadId: "t-w2",
        prompt: "Write the tests.",
        provider: "codex",
        model: "gpt-5.5-codex",
        status: "running",
        startedAt: ago(2),
        endedAt: null,
        items: [
          {
            kind: "tool",
            id: "uw2t",
            tool: "edit",
            title: "Edit src/api/list.test.ts",
            name: "Write",
            status: "running",
          },
        ],
      }),
    ],
    "t-w3": [
      turn({
        id: "uw3",
        threadId: "t-w3",
        prompt: "Update the README.",
        provider: "demo",
        model: "demo",
        startedAt: ago(14),
        endedAt: ago(12),
        changedFiles: ["README.md"],
        items: [
          {
            kind: "message",
            id: "uw3m",
            role: "assistant",
            text: "Documented cursor pagination in the README.",
          },
        ],
      }),
    ],
    "t-f1": [
      turn({
        id: "uf1",
        threadId: "t-f1",
        prompt: "Paginate the orders list three ways.",
        startedAt: ago(16),
        endedAt: ago(6),
        changedFiles: ["src/api/list.ts", "src/api/list.test.ts", "README.md"],
        items: [
          {
            kind: "message",
            id: "uf1m",
            role: "assistant",
            text: "Cursor pagination on listOrders with a test and a README note.",
          },
        ],
      }),
    ],
    "t-f2": [
      turn({
        id: "uf2",
        threadId: "t-f2",
        prompt: "Paginate the orders list three ways.",
        provider: "codex",
        model: "gpt-5.5-codex",
        startedAt: ago(16),
        endedAt: ago(7),
        changedFiles: ["src/api/list.ts", "README.md"],
        items: [
          {
            kind: "message",
            id: "uf2m",
            role: "assistant",
            text: "Offset pagination with a default page size of 25.",
          },
        ],
      }),
    ],
    "t-f3": [
      turn({
        id: "uf3",
        threadId: "t-f3",
        prompt: "Paginate the orders list three ways.",
        provider: "demo",
        model: "demo",
        status: "failed",
        startedAt: ago(16),
        endedAt: ago(9),
        error: "The demo agent stopped on a conflicted edit.",
        changedFiles: ["src/api/list.ts"],
        items: [
          {
            kind: "error",
            id: "uf3e",
            message: "The demo agent stopped on a conflicted edit.",
          },
        ],
      }),
    ],
  },
  cooldowns: { claude: { until: ago(-90), reason: "quota" } },
  groups: {
    "g-orch": {
      id: "g-orch",
      projectId: "p1",
      kind: "orchestrated",
      prompt: "Split pagination across workers.",
      coordinatorThreadId: "t-coord",
      threadIds: ["t-w1", "t-w2", "t-w3"],
      createdAt: ago(20),
    },
    "g-fan": {
      id: "g-fan",
      projectId: "p1",
      kind: "fanout",
      prompt: "Paginate the orders list three ways.",
      threadIds: ["t-f1", "t-f2", "t-f3"],
      createdAt: ago(16),
    },
  },
  reviewNotes: {
    t1: [
      {
        id: "rn1",
        threadId: "t1",
        path: "src/api/list.ts",
        line: 5,
        side: "new",
        body: "Clamp take to 100. A caller can ask for a page the size of the table.",
        createdAt: ago(20),
      },
      {
        id: "rn2",
        threadId: "t1",
        path: "src/api/list.ts",
        line: 4,
        side: "old",
        body: "This query had no limit. Confirm nothing relied on the full list.",
        createdAt: ago(19),
      },
      {
        id: "rn3",
        threadId: "t1",
        path: "src/api/list.test.ts",
        line: 3,
        side: "new",
        body: "Add a case for a cursor past the last order.",
        createdAt: ago(18),
      },
    ],
  },
};

export const fixtureProviders: ProviderStatus[] = [
  {
    kind: "claude",
    label: "Claude Code",
    installed: true,
    authenticated: true,
    version: "2.4.1",
    problem: null,
    models: [
      {
        id: "default",
        label: "Default (recommended)",
        resolvedModel: "claude-opus-5-5",
        efforts: ["low", "medium", "high", "max"],
      },
      {
        id: "claude-opus-5-5",
        label: "Opus 5.5",
        efforts: ["low", "medium", "high", "max"],
      },
      {
        id: "claude-sonnet-5-5",
        label: "Sonnet 5.5",
        efforts: ["low", "medium", "high"],
      },
      { id: "claude-haiku-5-5", label: "Haiku 5.5" },
    ],
    capabilities: { planMode: true, questions: true, queue: true, rewind: true },
  },
  {
    kind: "codex",
    label: "Codex",
    installed: true,
    authenticated: true,
    version: "0.98.0",
    problem: null,
    models: [{ id: "gpt-5.5-codex", label: "GPT-5.5 Codex" }],
  },
  {
    kind: "cursor",
    label: "Cursor Agent",
    installed: false,
    authenticated: null,
    version: null,
    problem: "Cursor Agent is not installed. Install it with the Cursor CLI installer.",
    models: [{ id: "auto", label: "Auto" }],
  },
  {
    kind: "demo",
    label: "Demo",
    installed: true,
    authenticated: true,
    version: null,
    problem: null,
    models: [{ id: "demo", label: "Demo" }],
    capabilities: { planMode: false, questions: true, queue: true },
  },
];

const diffs: Record<string, FileDiff[]> = {
  t1: [
    {
      path: "src/api/list.ts",
      status: "modified",
      additions: 5,
      deletions: 2,
      patch: paginationPatch,
    },
    { path: "src/api/list.test.ts", status: "added", additions: 8, deletions: 0, patch: testPatch },
    { path: "README.md", status: "modified", additions: 2, deletions: 1, patch: readmePatch },
    { path: "docs/logo.png", status: "added", additions: 0, deletions: 0 },
  ],
  "t-f1": [
    {
      path: "src/api/list.ts",
      status: "modified",
      additions: 5,
      deletions: 2,
      patch: paginationPatch,
    },
    { path: "src/api/list.test.ts", status: "added", additions: 8, deletions: 0, patch: testPatch },
    { path: "README.md", status: "modified", additions: 2, deletions: 1, patch: readmePatch },
  ],
  "t-f2": [
    {
      path: "src/api/list.ts",
      status: "modified",
      additions: 5,
      deletions: 2,
      patch: paginationPatch,
    },
    { path: "README.md", status: "modified", additions: 2, deletions: 1, patch: readmePatch },
  ],
  "t-f3": [
    {
      path: "src/api/list.ts",
      status: "modified",
      additions: 5,
      deletions: 2,
      patch: paginationPatch,
    },
  ],
  "t-w3": [
    { path: "README.md", status: "modified", additions: 2, deletions: 1, patch: readmePatch },
  ],
};

function svgDataUrl(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

const emberSvg = svgDataUrl(
  `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#1c1814"><animate attributeName="fill" values="#1c1814;#4a3018;#1c1814" dur="8s" repeatCount="indefinite"/></rect></svg>`,
);
const tideSvg = svgDataUrl(
  `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#0c1418"><animate attributeName="fill" values="#0c1418;#1a3344;#0c1418" dur="10s" repeatCount="indefinite"/></rect></svg>`,
);

const fixtureThemes: AppearanceThemeValue[] = [
  {
    version: 1,
    id: "default",
    name: "Default",
    appearance: "dark",
    canvas: "#0d0d0c",
    accent: "#d7c9a7",
    colors: {},
    css: "",
    builtin: true,
  },
  {
    version: 1,
    id: "abyss",
    name: "Abyss",
    appearance: "dark",
    canvas: "#0b0a12",
    accent: "#a78bfa",
    colors: {},
    css: "",
    builtin: true,
  },
  {
    version: 1,
    id: "wall-ember",
    name: "Ember",
    appearance: "dark",
    canvas: "#1c1814",
    accent: "#e2a54a",
    colors: {},
    css: "",
    builtin: true,
    background: {
      image: emberSvg,
      fit: "cover",
      dim: 40,
      blur: 0,
      panelBlur: 16,
      surfaceOpacity: 72,
      animated: true,
    },
    variants: {
      light: {
        canvas: "#f4f3ef",
        accent: "#8a6a3b",
        colors: {},
      },
    },
  },
  {
    version: 1,
    id: "wall-tide",
    name: "Tide",
    appearance: "dark",
    canvas: "#0c1418",
    accent: "#8fb3e6",
    colors: {},
    css: "",
    builtin: true,
    background: {
      image: tideSvg,
      fit: "cover",
      dim: 35,
      blur: 2,
      panelBlur: 12,
      surfaceOpacity: 78,
      animated: true,
    },
  },
];

function themeSummaryExtras(theme: AppearanceThemeValue): {
  hasWallpaper: boolean;
  animated: boolean;
  modes: Array<"dark" | "light">;
} {
  const modes: Array<"dark" | "light"> = [theme.appearance];
  const other = theme.appearance === "dark" ? "light" : "dark";
  if (theme.variants?.[other]) modes.push(other);
  const layers = [
    theme.background,
    theme.variants?.dark?.background,
    theme.variants?.light?.background,
  ];
  return {
    hasWallpaper: layers.some((layer) => layer?.image !== undefined),
    animated: layers.some((layer) => layer?.animated === true),
    modes,
  };
}

let fixtureSettings: DeviceSettingsValue = DeviceSettings.parse({
  activeThemeId: "default",
  colorMode: "system",
  threadNotifications: "banner",
  inAppNotifications: true,
  projectGrouping: true,
  confirmDelete: true,
  confirmArchive: true,
  importLocalHistory: true,
});

function fixtureUsageMode(): string | null {
  if (typeof location === "undefined") return null;
  return new URLSearchParams(location.search).get("usage");
}

function dayKey(offset: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - offset);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function makeBucket(
  day: string,
  origin: Origin,
  model: string,
  scale: number,
  unpriced = false,
): UsageHistoryBucket {
  const input = Math.round(80_000 * scale);
  const cacheRead = Math.round(400_000 * scale);
  const cacheWrite = Math.round(20_000 * scale);
  const output = Math.round(12_000 * scale);
  const costUsd = unpriced ? 0 : Number((scale * 4.2).toFixed(2));
  const split = unpriced
    ? { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, other: 0 }
    : {
        input: Number((costUsd * 0.12).toFixed(2)),
        cacheRead: Number((costUsd * 0.5).toFixed(2)),
        cacheWrite: Number((costUsd * 0.18).toFixed(2)),
        output: Number((costUsd * 0.15).toFixed(2)),
        other: Number((costUsd * 0.05).toFixed(2)),
      };
  return {
    day,
    origin,
    model,
    inputTokens: input,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    outputTokens: output,
    costUsd,
    costByType: split,
    cacheSavingsUsd: unpriced ? 0 : Number((scale * 1.1).toFixed(2)),
    records: Math.max(1, Math.round(scale * 6)),
    unpricedRecords: unpriced ? Math.max(1, Math.round(scale * 6)) : 0,
  };
}

function fixtureUsageHistory(windowDays: UsageWindowDays): UsageHistoryResult {
  const mode = fixtureUsageMode();
  if (mode === "empty") {
    return {
      version: 1,
      buckets: [],
      sources: [
        { origin: "claude", status: "missing", files: 0, distinctSessions: 0, refreshing: false },
        { origin: "cursor", status: "missing", files: 0, distinctSessions: 0, refreshing: false },
        { origin: "codex", status: "missing", files: 0, distinctSessions: 0, refreshing: false },
        { origin: "opencode", status: "missing", files: 0, distinctSessions: 0, refreshing: false },
        {
          origin: "antigravity",
          status: "missing",
          files: 0,
          distinctSessions: 0,
          refreshing: false,
        },
      ],
      pricing: { status: "ok", asOf: new Date().toISOString() },
      generatedAt: new Date().toISOString(),
    };
  }

  const days = Math.min(windowDays === 1 ? 1 : windowDays, 90);
  const buckets: UsageHistoryBucket[] = [];
  for (let offset = 0; offset < days; offset += 1) {
    const day = dayKey(offset);
    const wave = 0.35 + ((offset % 11) / 11) * 1.4;
    buckets.push(makeBucket(day, "cursor", "default", wave * 1.1));
    buckets.push(makeBucket(day, "claude", "claude-opus-5-5", wave * 0.55));
    buckets.push(makeBucket(day, "codex", "gpt-5.2-codex", wave * 0.2));
    buckets.push(makeBucket(day, "opencode", "gemini-flash", wave * 0.08, offset % 17 === 0));
  }

  const refreshing = mode === "refreshing";

  return {
    version: 1,
    buckets,
    sources: [
      {
        origin: "cursor",
        status: "ok",
        files: 33,
        distinctSessions: 578,
        refreshing,
      },
      {
        origin: "claude",
        status: "partial",
        files: 158,
        distinctSessions: 70,
        refreshing: false,
        note: "one transcript could not be read",
      },
      {
        origin: "codex",
        status: "ok",
        files: 3,
        distinctSessions: 12,
        refreshing: refreshing,
      },
      {
        origin: "opencode",
        status: "ok",
        files: 1,
        distinctSessions: 6,
        refreshing: false,
      },
      {
        origin: "antigravity",
        status: "missing",
        files: 0,
        distinctSessions: 0,
        refreshing: false,
      },
    ],
    pricing: refreshing
      ? { status: "unavailable" }
      : { status: "stale", asOf: new Date(Date.now() - 40 * 60 * 60 * 1000).toISOString() },
    generatedAt: new Date().toISOString(),
  };
}

type FixtureDraft = AgeEvent extends infer Event
  ? Event extends AgeEvent
    ? Omit<Event, "seq" | "at"> & { at?: string }
    : never
  : never;

function injectFixtureEvents(drafts: readonly FixtureDraft[]): void {
  const at = new Date().toISOString();
  for (const draft of drafts) {
    const seq = Math.max(fixtureModel.seq, useStore.getState().model.seq) + 1;
    receiveEvent({ at, ...draft, seq } as AgeEvent);
    Object.assign(fixtureModel, useStore.getState().model);
  }
}

function applyFixtureCommand(command: Command): void {
  const at = new Date().toISOString();
  if (command.type === "fanout.start") {
    const groupId = `g-${command.commandId}`;
    const threadIds = command.targets.map((_, index) => `t-${command.commandId}-${index}`);
    const title = command.title?.trim() || command.prompt.trim() || "Fan-out";
    injectFixtureEvents([
      {
        type: "group.created",
        commandId: command.commandId,
        group: {
          id: groupId,
          projectId: command.projectId,
          kind: "fanout",
          prompt: command.prompt,
          threadIds,
          createdAt: at,
        },
      },
      ...command.targets.map((target, index) => ({
        type: "thread.created" as const,
        commandId: command.commandId,
        thread: thread({
          id: threadIds[index] ?? `t-${command.commandId}-${index}`,
          projectId: command.projectId,
          title,
          provider: target.provider,
          model: target.model,
          runtimeMode: command.runtimeMode,
          role: "worker",
          groupId,
          isolate: true,
          status: "idle",
          createdAt: at,
          updatedAt: at,
        }),
      })),
    ]);
    return;
  }
  if (command.type === "thread.create") {
    injectFixtureEvents([
      {
        type: "thread.created",
        commandId: command.commandId,
        thread: thread({
          id: `t-${command.commandId}`,
          projectId: command.projectId,
          title: command.title?.trim() || "New thread",
          provider: command.provider,
          model: command.model,
          runtimeMode: command.runtimeMode,
          ...(command.effort ? { effort: command.effort } : {}),
          ...(command.isolate ? { isolate: true } : {}),
          createdAt: at,
          updatedAt: at,
        }),
      },
    ]);
    return;
  }
  if (command.type === "thread.configure") {
    const current = fixtureModel.threads[command.threadId];
    if (!current) return;
    injectFixtureEvents([
      {
        type: "thread.configured",
        commandId: command.commandId,
        threadId: command.threadId,
        provider: command.provider ?? current.provider,
        model: command.model ?? current.model,
        runtimeMode: command.runtimeMode ?? current.runtimeMode,
        handoff: command.provider !== undefined && command.provider !== current.provider,
        ...(command.interactionMode ? { interactionMode: command.interactionMode } : {}),
        ...(command.effort ? { effort: command.effort } : {}),
      },
    ]);
    return;
  }
  if (command.type === "fanout.pick") {
    injectFixtureEvents([
      {
        type: "group.winnerPicked",
        commandId: command.commandId,
        groupId: command.groupId,
        threadId: command.threadId,
      },
    ]);
    return;
  }
  if (command.type === "thread.merge") {
    injectFixtureEvents([
      {
        type: "thread.mergeChanged",
        commandId: command.commandId,
        threadId: command.threadId,
        merge: { status: "merging", targetBranch: "main", at },
      },
      {
        type: "thread.mergeChanged",
        commandId: command.commandId,
        threadId: command.threadId,
        merge: { status: "merged", targetBranch: "main", commit: "fixture", at },
      },
    ]);
  }
}

function respond(method: RpcMethod, params: unknown): unknown {
  switch (method) {
    case "snapshot":
      return fixtureModel;
    case "providers.list":
      return fixtureProviders;
    case "providers.signIn": {
      const provider = (params as RpcParams<"providers.signIn">).provider;
      const command =
        provider === "claude"
          ? "claude auth login"
          : provider === "codex"
            ? "codex login"
            : "agent login";
      return { opened: true as const, command };
    }
    case "git.diff":
      return diffs[(params as RpcParams<"git.diff">).threadId] ?? [];
    case "fs.pickable":
      return [
        { path: "/Users/demo/code/orders-api", isGitRepo: true },
        { path: "/Users/demo/code/site", isGitRepo: true },
        { path: "/Users/demo/Downloads", isGitRepo: false },
      ].filter((entry) => entry.path.includes((params as RpcParams<"fs.pickable">).query ?? ""));
    case "fs.pickFolder":
      return { path: null, supported: false };
    case "projects.scratch": {
      const existing = Object.values(fixtureModel.projects).find((entry) => entry.scratch);
      if (existing) return { projectId: existing.id };
      injectFixtureEvents([
        {
          type: "project.added",
          commandId: null,
          project: {
            id: "p-scratch",
            name: "No project",
            root: "/Users/demo/.age/scratch",
            createdAt: new Date().toISOString(),
            scratch: true,
          },
        },
      ]);
      return { projectId: "p-scratch" };
    }
    case "dispatch": {
      const command = params as Command;
      console.info("AGE fixture dispatch", params);
      applyFixtureCommand(command);
      return { accepted: true, duplicate: false, seq: fixtureModel.seq };
    }
    case "subscribe":
      return { replayed: 0 };
    case "settings.get":
      return fixtureSettings;
    case "settings.put": {
      fixtureSettings = { ...fixtureSettings, ...(params as RpcParams<"settings.put">).settings };
      return fixtureSettings;
    }
    case "themes.list":
      return {
        themesDir: "/tmp/age-fixture/themes",
        activeThemeId: fixtureSettings.activeThemeId,
        themes: fixtureThemes.map((theme) => ({
          id: theme.id,
          name: theme.name,
          appearance: theme.appearance,
          canvas: theme.canvas,
          accent: theme.accent,
          builtin: Boolean(theme.builtin),
          hasCss: theme.css.length > 0,
          ...themeSummaryExtras(theme),
        })),
      };
    case "themes.get": {
      const id = (params as RpcParams<"themes.get">).id;
      const theme = fixtureThemes.find((entry) => entry.id === id);
      if (!theme) throw new Error(`Theme "${id}" was not found.`);
      return theme;
    }
    case "themes.put": {
      const theme = { ...(params as RpcParams<"themes.put">).theme, builtin: false };
      const index = fixtureThemes.findIndex((entry) => entry.id === theme.id);
      if (index >= 0) fixtureThemes[index] = theme;
      else fixtureThemes.push(theme);
      return theme;
    }
    case "themes.delete": {
      const id = (params as RpcParams<"themes.delete">).id;
      const index = fixtureThemes.findIndex((entry) => entry.id === id && !entry.builtin);
      if (index < 0) throw new Error(`Theme "${id}" was not found.`);
      fixtureThemes.splice(index, 1);
      if (fixtureSettings.activeThemeId === id) fixtureSettings.activeThemeId = "default";
      return { deleted: true };
    }
    case "themes.import": {
      const { text, filename, activate } = params as RpcParams<"themes.import">;
      let theme: AppearanceThemeValue;
      let format: "age" | "t3code" | "svg";
      if (looksLikeSvg(text, filename)) {
        theme = AppearanceTheme.parse(wallpaperThemeFromSvg(text, filename));
        format = "svg";
      } else {
        let raw: unknown;
        try {
          raw = JSON.parse(text);
        } catch {
          throw new Error("That file is not valid JSON.");
        }
        const parsed = AppearanceTheme.safeParse(
          raw && typeof raw === "object" ? { ...raw, builtin: false } : raw,
        );
        if (parsed.success) {
          theme = parsed.data;
          format = "age";
        } else if (looksLikeT3code(raw)) {
          theme = AppearanceTheme.parse(themeFromT3code(raw));
          format = "t3code";
        } else {
          const issue = parsed.error.issues[0];
          throw new Error(
            issue ? `${issue.path.join(".") || "theme"}: ${issue.message}` : "Invalid theme.",
          );
        }
      }
      if (fixtureThemes.some((entry) => entry.id === theme.id && entry.builtin)) {
        theme = { ...theme, id: `${theme.id}-imported` };
      }
      const index = fixtureThemes.findIndex((entry) => entry.id === theme.id);
      if (index >= 0) fixtureThemes[index] = theme;
      else fixtureThemes.push(theme);
      if (activate) fixtureSettings = { ...fixtureSettings, activeThemeId: theme.id };
      return { theme, format };
    }
    case "themes.activate": {
      const id = (params as RpcParams<"themes.activate">).id;
      fixtureSettings = { ...fixtureSettings, activeThemeId: id };
      return fixtureSettings;
    }
    case "terminal.open":
      return { sessionId: "term_fixture", shell: "fixture" };
    case "terminal.write":
    case "terminal.resize":
    case "terminal.close":
      return { ok: true as const };
    case "usage.history":
      return fixtureUsageHistory((params as RpcParams<"usage.history">).windowDays);
    case "fleet.overview":
      return [...fleetRows(fixtureModel)];
    case "agents.list": {
      const parent = (params as RpcParams<"agents.list">).parentThreadId;
      return fleetRows(fixtureModel).filter((row) =>
        parent ? row.parentThreadId === parent : true,
      );
    }
    case "git.mergePreview": {
      const threadId = (params as RpcParams<"git.mergePreview">).threadId;
      if (threadId === "t-f3") {
        return {
          targetBranch: "main",
          ahead: 1,
          behind: 1,
          files: [{ path: "src/api/list.ts", additions: 5, deletions: 2 }],
          conflicts: ["src/api/list.ts"],
        };
      }
      if (threadId === "t-f2") {
        return {
          targetBranch: "main",
          ahead: 2,
          behind: 0,
          files: [
            { path: "src/api/list.ts", additions: 5, deletions: 2 },
            { path: "README.md", additions: 2, deletions: 1 },
          ],
          conflicts: [],
        };
      }
      if (threadId === "t-f1" || threadId.startsWith("t-w") || threadId.startsWith("t-f")) {
        return {
          targetBranch: "main",
          ahead: 3,
          behind: 0,
          files: [
            { path: "src/api/list.ts", additions: 5, deletions: 2 },
            { path: "src/api/list.test.ts", additions: 8, deletions: 0 },
            { path: "README.md", additions: 2, deletions: 1 },
          ],
          conflicts: [],
        };
      }
      const files = (diffs[threadId] ?? []).map((file) => ({
        path: file.path,
        additions: file.additions,
        deletions: file.deletions,
      }));
      return {
        targetBranch: "main",
        ahead: files.length > 0 ? 2 : 0,
        behind: 0,
        files,
        conflicts: [],
      };
    }
    case "agents.spawn":
      return { threadId: "t-fixture-worker" };
    case "agents.wait":
      return { finished: [], pending: (params as RpcParams<"agents.wait">).threadIds };
    case "agents.result":
      return { status: "idle" as const, summary: "" };
    case "attachments.put": {
      const { name, dataBase64 } = params as RpcParams<"attachments.put">;
      const id = crypto.randomUUID();
      const size = Math.floor((dataBase64.length * 3) / 4);
      return { id, name, path: `/Users/demo/.age/attachments/${id}/${name}`, size };
    }
    case "attachments.remove":
      return { removed: true };
    case "usage.limits":
      return [
        {
          provider: "claude",
          available: true,
          plan: "max",
          windows: [
            {
              id: "five_hour",
              label: "5-hour",
              usedPercent: 42,
              resetsAt: new Date(Date.now() + 2 * 60 * 60_000 + 14 * 60_000).toISOString(),
            },
            {
              id: "seven_day",
              label: "Weekly",
              usedPercent: 81,
              resetsAt: new Date(Date.now() + 3 * 24 * 60 * 60_000).toISOString(),
            },
          ],
          checkedAt: new Date().toISOString(),
          problem: null,
        },
        {
          provider: "codex",
          available: true,
          plan: "plus",
          windows: [
            {
              id: "primary",
              label: "5-hour",
              usedPercent: 18,
              resetsAt: new Date(Date.now() + 4 * 60 * 60_000).toISOString(),
            },
            {
              id: "secondary",
              label: "Weekly",
              usedPercent: 55,
              resetsAt: new Date(Date.now() + 5 * 24 * 60 * 60_000).toISOString(),
            },
          ],
          checkedAt: new Date().toISOString(),
          problem: null,
        },
        {
          provider: "cursor",
          available: false,
          plan: null,
          windows: [],
          checkedAt: new Date().toISOString(),
          problem: "Cursor Agent does not report plan limits.",
        },
        {
          provider: "demo",
          available: false,
          plan: null,
          windows: [],
          checkedAt: new Date().toISOString(),
          problem: "Demo does not report plan limits.",
        },
      ];
  }
}

export function createFixtureBackend(): Backend {
  return {
    call: <M extends RpcMethod>(method: M, params: RpcParams<M>) => {
      if (method === "fs.searchEntries") {
        return Promise.reject(
          new RpcCallError("unavailable", "File search is not available yet."),
        ) as Promise<RpcResult<M>>;
      }
      return Promise.resolve(respond(method, params) as RpcResult<M>);
    },
  };
}
