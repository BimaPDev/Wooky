import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FailoverSettings } from "@wooky/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { EffectRunner } from "../effects/runner.ts";
import { openEventStore } from "../store/event-store.ts";
import { createDispatcher } from "./dispatcher.ts";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop() as string, { recursive: true, force: true });
});

describe("dispatcher projectBusy", () => {
  it("refuses turn.start and queue.promote while the project is being written by a sync", async () => {
    const home = await mkdtemp(join(tmpdir(), "wooky-dispatch-"));
    dirs.push(home);
    let n = 0;
    const store = openEventStore(home, () => "2026-01-01T00:00:00.000Z");
    let busy = false;
    const dispatcher = createDispatcher({
      store,
      runner: { enqueue() {} } as unknown as EffectRunner,
      ctx: {
        now: () => "2026-01-01T00:00:00.000Z",
        newId: (prefix) => `${prefix}_${(n += 1)}`,
        capabilities: () => ({}),
        failoverSettings: FailoverSettings.parse({}),
      },
      projectBusy: () => busy,
    });
    dispatcher.dispatch({ type: "project.add", commandId: "c1", root: home, name: "p" });
    const projectId = Object.keys(store.model.projects)[0] as string;
    dispatcher.dispatch({
      type: "thread.create",
      commandId: "c2",
      projectId,
      provider: "demo",
      model: "demo",
      runtimeMode: "full",
      isolate: false,
    });
    const threadId = Object.keys(store.model.threads)[0] as string;

    busy = true;
    expect(() =>
      dispatcher.dispatch({ type: "turn.start", commandId: "c3", threadId, prompt: "hi" }),
    ).toThrow(/applying a sync/);
    expect(store.model.turns[threadId] ?? []).toEqual([]);

    busy = false;
    expect(
      dispatcher.dispatch({ type: "turn.start", commandId: "c3", threadId, prompt: "hi" }),
    ).toMatchObject({ accepted: true });
    store.close();
  });
});
