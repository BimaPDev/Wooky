// age-allow-file color: dev fixture themes are user data stored as hex, like the server sends them.
import {
  DeviceSettings,
  type AppearanceTheme,
  type DeviceSettings as DeviceSettingsValue,
  type FileDiff,
  type ProviderStatus,
  type ReadModel,
  type RpcMethod,
  type RpcParams,
  type RpcResult,
  type Thread,
  type Turn,
} from "@age/contracts";
import type { Backend } from "../state/backend.ts";

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
      { id: "claude-opus-5-5", label: "Opus 5.5" },
      { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
    ],
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
};

const fixtureThemes: AppearanceTheme[] = [
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
];

let fixtureSettings: DeviceSettingsValue = DeviceSettings.parse({
  activeThemeId: "default",
  colorMode: "system",
  threadNotifications: "banner",
  inAppNotifications: true,
  projectGrouping: true,
  confirmDelete: true,
  confirmArchive: true,
});

function respond(method: RpcMethod, params: unknown): unknown {
  switch (method) {
    case "snapshot":
      return fixtureModel;
    case "providers.list":
      return fixtureProviders;
    case "git.diff":
      return diffs[(params as RpcParams<"git.diff">).threadId] ?? [];
    case "fs.pickable":
      return [
        { path: "/Users/demo/code/orders-api", isGitRepo: true },
        { path: "/Users/demo/code/site", isGitRepo: true },
        { path: "/Users/demo/Downloads", isGitRepo: false },
      ].filter((entry) => entry.path.includes((params as RpcParams<"fs.pickable">).query ?? ""));
    case "dispatch":
      console.info("AGE fixture dispatch", params);
      return { accepted: true, duplicate: false, seq: fixtureModel.seq };
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
    case "terminal.open":
      return { sessionId: "term_fixture", shell: "fixture" };
    case "terminal.write":
    case "terminal.resize":
    case "terminal.close":
      return { ok: true as const };
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
    call: <M extends RpcMethod>(method: M, params: RpcParams<M>) =>
      Promise.resolve(respond(method, params) as RpcResult<M>),
  };
}
