import type { Thread } from "@wooky/contracts";
import { describe, expect, it } from "vitest";
import { isSettledStatus, isWorkingStatus, partitionSidebarThreads } from "./sidebar-sections.ts";

const base = (status: Thread["status"]): Thread => ({
  id: "t1",
  projectId: "p1",
  title: "Example",
  provider: "demo",
  model: "demo",
  runtimeMode: "approve",
  worktree: null,
  providerSessionId: null,
  ownerDeviceId: null,
  movedTo: null,
  movedFrom: null,
  pullRequest: null,
  queue: [],
  status,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("sidebar Working / Settled grouping", () => {
  it("treats running and waiting as working", () => {
    expect(isWorkingStatus("running")).toBe(true);
    expect(isWorkingStatus("waiting")).toBe(true);
    expect(isWorkingStatus("idle")).toBe(false);
  });

  it("treats idle as settled", () => {
    expect(isSettledStatus("idle")).toBe(true);
    expect(isSettledStatus("error")).toBe(false);
  });

  it("partitions threads into working, settled and listed", () => {
    const threads = [
      base("running"),
      { ...base("waiting"), id: "t2" },
      { ...base("idle"), id: "t3" },
      { ...base("error"), id: "t4" },
    ];
    const parts = partitionSidebarThreads(threads);
    expect(parts.working.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(parts.settled.map((t) => t.id)).toEqual(["t3"]);
    expect(parts.listed.map((t) => t.id)).toEqual(["t4"]);
  });
});
