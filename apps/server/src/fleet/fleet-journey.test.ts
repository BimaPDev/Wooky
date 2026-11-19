import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { childrenOf } from "@wooky/domain";
import { createEffectRunner } from "../effects/runner.ts";
import { createGitService } from "../git/service.ts";
import { cleanupTestRepos, makeRepo } from "../git/test-repo.ts";
import { createDispatcher } from "../orchestrator/dispatcher.ts";
import { createDemoAdapter } from "../providers/demo/adapter.ts";
import { createProviderRegistry } from "../providers/registry.ts";
import { openEventStore } from "../store/event-store.ts";
import { createFakeGit, tempDir, testContext, waitForEvent } from "../testing.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  await cleanupTestRepos();
});

describe("fleet journey", () => {
  it("spawns two demo workers, reports with diffStat, and merges one on a real repo", async () => {
    const home = await tempDir("fleet-journey");
    const root = await makeRepo();
    const realGit = createGitService();
    const { git: fakeGit } = createFakeGit();
    const ctx = testContext();
    const store = openEventStore(home, ctx.now);
    const providers = createProviderRegistry([createDemoAdapter({ stepMs: 0 })]);
    let send: (
      command: Parameters<ReturnType<typeof createDispatcher>["dispatch"]>[0],
    ) => void = () => {};
    const runner = createEffectRunner({
      store,
      providers,
      git: fakeGit,
      newId: ctx.newId,
      dispatch: (command) => send(command),
    });
    const dispatcher = createDispatcher({ store, runner, ctx });
    send = (command) => dispatcher.dispatch(command);
    cleanups.push(async () => {
      await runner.shutdown();
      store.close();
    });

    dispatcher.dispatch({ commandId: "p", type: "project.add", root });
    dispatcher.dispatch({
      commandId: "c",
      type: "thread.create",
      projectId: Object.keys(store.model.projects)[0] ?? "",
      provider: "demo",
      model: "demo",
      runtimeMode: "full",
      isolate: false,
    });
    const coordId = Object.keys(store.model.threads)[0] ?? "";

    for (const prompt of ["worker one", "worker two"]) {
      const before = store.model.seq;
      dispatcher.dispatch({
        commandId: `spawn-${prompt}`,
        type: "thread.spawn",
        parentThreadId: coordId,
        provider: "demo",
        model: "demo",
        prompt,
        title: prompt,
      });
      const spawned = await waitForEvent(
        store,
        "thread.spawned",
        (event) => event.parentThreadId === coordId && event.seq > before,
      );
      await waitForEvent(store, "turn.finished", (event) => event.threadId === spawned.thread.id);
      const report = await waitForEvent(
        store,
        "worker.reported",
        (event) => event.workerThreadId === spawned.thread.id,
      );
      expect(report.diffStat?.files).toBeGreaterThan(0);
    }

    expect(childrenOf(store.model, coordId)).toHaveLength(2);

    const mergeTarget = childrenOf(store.model, coordId)[0]?.id ?? "";
    const worktree = await realGit.createWorktree(root, mergeTarget);
    await writeFile(join(worktree.path, "fleet-land.txt"), "landed\n");
    await realGit.commitWorktreeChanges(root, worktree, `AGE: ${mergeTarget}`);
    const merged = await realGit.mergeWorktree(root, worktree, "squash", mergeTarget, "Fleet land");
    expect(merged.ok).toBe(true);
    if (!merged.ok) throw new Error("expected merge");
    expect(existsSync(join(root, "fleet-land.txt"))).toBe(true);
  }, 30_000);
});
