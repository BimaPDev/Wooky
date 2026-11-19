import type { FleetRow, Thread, ThreadGroup } from "@age/contracts";
import { describe, expect, it } from "vitest";
import {
  BOARD_STATUS_LABEL,
  buildSidebarTree,
  fanoutTargetError,
  filterFleetRows,
  fleetRoleLabel,
  formatRelativeActivity,
  groupFleetRows,
  jumpItemsFromRows,
  lastAssistantText,
  promptPreview,
  rankJumpItems,
  summarizeStatuses,
  workerCountLabel,
} from "./helpers.ts";

const at = "2026-01-01T00:00:00.000Z";

const thread = (id: string, extra: Partial<Thread> = {}): Thread => ({
  id,
  projectId: "p1",
  title: id,
  provider: "demo",
  model: "demo",
  runtimeMode: "approve",
  worktree: null,
  providerSessionId: null,
  queue: [],
  status: "idle",
  createdAt: at,
  updatedAt: at,
  ...extra,
});

const row = (threadId: string, extra: Partial<FleetRow> = {}): FleetRow => ({
  threadId,
  projectId: "p1",
  title: threadId,
  provider: "demo",
  model: "demo",
  role: "solo",
  status: "idle",
  lastActivityAt: at,
  ...extra,
});

describe("groupFleetRows", () => {
  it("groups by status with waiting first, then working, done, failed, idle", () => {
    const rows = [
      row("idle", { status: "idle" }),
      row("failed", { status: "failed" }),
      row("done", { status: "done", role: "worker" }),
      row("working", { status: "working" }),
      row("waiting", { status: "waiting", waitingOn: "approval" }),
    ];
    expect(
      groupFleetRows(rows).map((group) => [group.status, group.label, group.rows.length]),
    ).toEqual([
      ["waiting", BOARD_STATUS_LABEL.waiting, 1],
      ["working", BOARD_STATUS_LABEL.working, 1],
      ["done", BOARD_STATUS_LABEL.done, 1],
      ["failed", BOARD_STATUS_LABEL.failed, 1],
      ["idle", BOARD_STATUS_LABEL.idle, 1],
    ]);
  });

  it("drops empty status groups and keeps activity order inside a group", () => {
    const rows = [row("newer", { status: "idle" }), row("older", { status: "idle" })];
    expect(groupFleetRows(rows).map((group) => group.rows.map((item) => item.threadId))).toEqual([
      ["newer", "older"],
    ]);
  });
});

const projectName = (id: string) => (id === "p2" ? "marketing-site" : "orders-api");

describe("filterFleetRows", () => {
  it("matches title, project, provider and model", () => {
    const rows = [
      row("a", { title: "Paginate orders", provider: "claude", model: "opus" }),
      row("b", { title: "Fix cache", projectId: "p2", provider: "codex", model: "gpt" }),
    ];
    expect(filterFleetRows(rows, "paginate", projectName).map((item) => item.threadId)).toEqual([
      "a",
    ]);
    expect(filterFleetRows(rows, "marketing", projectName).map((item) => item.threadId)).toEqual([
      "b",
    ]);
    expect(filterFleetRows(rows, "opus", projectName).map((item) => item.threadId)).toEqual(["a"]);
  });
});

describe("buildSidebarTree", () => {
  it("nests workers under their coordinator and keeps solos at the top level", () => {
    const coordinator = thread("coord", { role: "coordinator", title: "Lead" });
    const workerA = thread("w1", { role: "worker", parentThreadId: "coord" });
    const workerB = thread("w2", { role: "worker", parentThreadId: "coord" });
    const solo = thread("solo");
    const nodes = buildSidebarTree(
      [coordinator, workerA, workerB, solo],
      [coordinator, workerA, workerB, solo],
      {},
    );
    expect(nodes).toEqual([
      { kind: "coordinator", thread: coordinator, workers: [workerA, workerB] },
      { kind: "thread", thread: solo },
    ]);
  });

  it("nests fan-out members under a group named after the prompt", () => {
    const a = thread("a", { role: "worker", groupId: "g1" });
    const b = thread("b", { role: "worker", groupId: "g1" });
    const solo = thread("solo");
    const group: ThreadGroup = {
      id: "g1",
      projectId: "p1",
      kind: "fanout",
      prompt: "Try three models",
      threadIds: ["a", "b"],
      createdAt: at,
    };
    const nodes = buildSidebarTree([a, solo, b], [a, b, solo], { g1: group });
    expect(nodes[0]).toEqual({ kind: "group", group, threads: [a, b] });
    expect(nodes[1]).toEqual({ kind: "thread", thread: solo });
  });

  it("emits the coordinator when only a worker is in the visible list", () => {
    const coordinator = thread("coord", { role: "coordinator" });
    const worker = thread("w1", { role: "worker", parentThreadId: "coord" });
    const nodes = buildSidebarTree([worker], [coordinator, worker], {});
    expect(nodes).toEqual([{ kind: "coordinator", thread: coordinator, workers: [worker] }]);
  });

  it("does not treat orchestrated groups as fan-out rows", () => {
    const coordinator = thread("coord", { role: "coordinator", groupId: "orch" });
    const worker = thread("w1", { role: "worker", parentThreadId: "coord", groupId: "orch" });
    const orch: ThreadGroup = {
      id: "orch",
      projectId: "p1",
      kind: "orchestrated",
      prompt: "Split the work",
      coordinatorThreadId: "coord",
      threadIds: ["w1"],
      createdAt: at,
    };
    const nodes = buildSidebarTree([coordinator, worker], [coordinator, worker], { orch });
    expect(nodes).toEqual([{ kind: "coordinator", thread: coordinator, workers: [worker] }]);
  });
});

describe("fanoutTargetError", () => {
  it("requires two to six complete provider and model pairs", () => {
    expect(fanoutTargetError([{ provider: "claude", model: "opus" }])).toBe(
      "Pick at least two agents.",
    );
    expect(
      fanoutTargetError([
        { provider: "claude", model: "opus" },
        { provider: "demo", model: "demo" },
      ]),
    ).toBeNull();
    expect(
      fanoutTargetError([
        { provider: "claude", model: "opus" },
        { provider: "claude", model: "sonnet" },
      ]),
    ).toBeNull();
    expect(
      fanoutTargetError([
        { provider: "claude", model: "opus" },
        { provider: "demo", model: "   " },
      ]),
    ).toBe("Each agent needs a provider and a model.");
    expect(
      fanoutTargetError(
        Array.from({ length: 7 }, (_, index) => ({ provider: "demo", model: `m${index}` })),
      ),
    ).toBe("At most six agents.");
  });
});

describe("rankJumpItems", () => {
  it("keeps waiting-on-you first, then fuzzy rank", () => {
    const items = jumpItemsFromRows(
      [
        row("idle-cache", { title: "Fix the cache", status: "idle" }),
        row("wait-cache", { title: "Fix the cache tests", status: "waiting" }),
        row("wait-page", { title: "Paginate list", status: "waiting" }),
        row("work-page", { title: "Paginate list follow-up", status: "working" }),
      ],
      () => "orders-api",
    );
    expect(rankJumpItems(items, "").map((item) => item.threadId)).toEqual([
      "wait-cache",
      "wait-page",
      "idle-cache",
      "work-page",
    ]);
    expect(rankJumpItems(items, "page").map((item) => item.threadId)).toEqual([
      "wait-page",
      "work-page",
    ]);
    expect(rankJumpItems(items, "cache")[0]?.threadId).toBe("wait-cache");
  });
});

describe("copy helpers", () => {
  it("summarises worker and group status counts", () => {
    expect(workerCountLabel(3, 1)).toBe("3 workers, 1 waiting");
    expect(workerCountLabel(1, 0)).toBe("1 worker");
    expect(summarizeStatuses(["done", "done", "working"])).toBe("1 working, 2 done");
  });

  it("labels roles and truncates prompts", () => {
    expect(fleetRoleLabel({ role: "coordinator" })).toBe("Coordinator");
    expect(fleetRoleLabel({ role: "worker", parentThreadId: "c" }, "Lead")).toBe("Worker of Lead");
    expect(fleetRoleLabel({ role: "worker", groupId: "g" })).toBe("Fan-out");
    expect(fleetRoleLabel({ role: "solo" })).toBe("Solo");
    expect(promptPreview("Try three models on pagination")).toBe("Try three models on pagination");
    expect(promptPreview("x".repeat(60)).endsWith("…")).toBe(true);
    expect(lastAssistantText("")).toBe("No final message yet.");
  });

  it("formats relative activity without ticking", () => {
    const now = Date.parse("2026-01-01T01:00:00.000Z");
    expect(formatRelativeActivity("2026-01-01T00:59:50.000Z", now)).toBe("now");
    expect(formatRelativeActivity("2026-01-01T00:10:00.000Z", now)).toBe("50m");
    expect(formatRelativeActivity("2026-01-01T00:00:00.000Z", now)).toBe("1h");
  });
});
