import { describe, expect, it } from "vitest";
import { emptyReadModel } from "@wooky/domain";
import type { ReadModel } from "@wooky/contracts";
import { createWorkspaceSearch } from "./search.ts";

function modelFor(cwd: string): Pick<ReadModel, "threads" | "projects"> {
  const model = emptyReadModel();
  return {
    projects: { p1: { id: "p1", root: cwd } },
    threads: { t1: { id: "t1", projectId: "p1" } },
  } as unknown as typeof model;
}

describe("workspace search", () => {
  const listing = [
    "README.md",
    "src/app.ts",
    "src/deep/app.tsx",
    "src/lib/application.ts",
    "docs/my-app-notes.md",
    "other/a_p_p.txt",
  ];
  const service = (files = listing, calls?: string[]) =>
    createWorkspaceSearch({
      model: () => modelFor("/ws"),
      listFiles: async (cwd) => {
        calls?.push(cwd);
        return files;
      },
    });

  it("ranks exact, prefix, substring, path substring, then subsequence", async () => {
    const results = await service().search({ threadId: "t1", query: "app" });
    expect(results.map((r) => r.path)).toEqual([
      "src/app.ts",
      "src/deep/app.tsx",
      "src/lib/application.ts",
      "docs/my-app-notes.md",
      "other/a_p_p.txt",
    ]);
  });

  it("matches path substrings and subsequences below basename matches", async () => {
    const results = await service().search({ threadId: "t1", query: "lib/app" });
    expect(results.map((r) => r.path)).toEqual(["src/lib/application.ts"]);
    const sub = await service().search({ threadId: "t1", query: "sdat" });
    expect(sub.map((r) => r.path)).toEqual(["src/deep/app.tsx"]);
  });

  it("derives directory entries and returns top-level entries for an empty query", async () => {
    const top = await service().search({ threadId: "t1", query: "" });
    expect(top).toEqual([
      { path: "docs", kind: "dir" },
      { path: "other", kind: "dir" },
      { path: "src", kind: "dir" },
      { path: "README.md", kind: "file" },
    ]);
    const dirs = await service().search({ threadId: "t1", query: "deep" });
    expect(dirs[0]).toEqual({ path: "src/deep", kind: "dir" });
  });

  it("respects the limit and never returns paths outside the workspace", async () => {
    const s = service(["../escape.txt", "/etc/passwd", "ok.txt", "a/../b.txt"]);
    expect(await s.search({ threadId: "t1", query: "" })).toEqual([
      { path: "ok.txt", kind: "file" },
    ]);
    expect(await service().search({ threadId: "t1", query: "", limit: 1 })).toHaveLength(1);
  });

  it("rejects an unknown thread with not_found", async () => {
    await expect(service().search({ threadId: "nope", query: "x" })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("reuses the listing within the TTL and refreshes after it", async () => {
    const calls: string[] = [];
    let clock = 0;
    const s = createWorkspaceSearch({
      model: () => modelFor("/ws"),
      listFiles: async (cwd) => {
        calls.push(cwd);
        return listing;
      },
      now: () => clock,
    });
    await s.search({ threadId: "t1", query: "a" });
    await s.search({ threadId: "t1", query: "ap" });
    clock = 4_999;
    await s.search({ threadId: "t1", query: "app" });
    expect(calls).toHaveLength(1);
    clock = 5_000;
    await s.search({ threadId: "t1", query: "app" });
    expect(calls).toHaveLength(2);
  });
});
