import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { childrenOf } from "@age/domain";
import { createEffectRunner } from "../effects/runner.ts";
import { createDispatcher } from "../orchestrator/dispatcher.ts";
import { createDemoAdapter } from "../providers/demo/adapter.ts";
import { createProviderRegistry } from "../providers/registry.ts";
import { openEventStore } from "../store/event-store.ts";
import { createFakeGit, tempDir, testContext, waitForEvent } from "../testing.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("fleet journey", () => {
  it("spawns two workers on the demo provider, reports to the coordinator, and merges one", async () => {
    const home = await tempDir("fleet-journey");
    const root = await tempDir("fleet-root");
    const ctx = testContext();
    const store = openEventStore(home, ctx.now);
    const { git } = createFakeGit();
    const providers = createProviderRegistry([createDemoAdapter({ stepMs: 0 })]);
    let send: (
      command: Parameters<ReturnType<typeof createDispatcher>["dispatch"]>[0],
    ) => void = () => {};
    const runner = createEffectRunner({
      store,
      providers,
      git,
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
      dispatcher.dispatch({
        commandId: `spawn-${prompt}`,
        type: "thread.spawn",
        parentThreadId: coordId,
        provider: "demo",
        model: "demo",
        prompt,
      });
      const workerId = childrenOf(store.model, coordId).at(-1)?.id ?? "";
      await waitForEvent(store, "worker.reported", (event) => event.workerThreadId === workerId);
      await runner.idle();
    }

    expect(childrenOf(store.model, coordId)).toHaveLength(2);
    expect(
      (store.model.threads[coordId]?.queue.length ?? 0) + (store.model.turns[coordId]?.length ?? 0),
    ).toBeGreaterThanOrEqual(1);

    const mergeTarget = childrenOf(store.model, coordId)[0]?.id ?? "";
    await waitForEvent(store, "thread.worktreeBound", (event) => event.threadId === mergeTarget);
    dispatcher.dispatch({
      commandId: "merge",
      type: "thread.merge",
      threadId: mergeTarget,
      strategy: "merge",
    });
    await waitForEvent(
      store,
      "thread.mergeChanged",
      (event) => event.threadId === mergeTarget && event.merge.status === "merged",
    );
    expect(store.model.threads[mergeTarget]?.merge?.status).toBe("merged");
    expect(join(root, ".worktrees", mergeTarget)).toBeTruthy();
  }, 30_000);
});
