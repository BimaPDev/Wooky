import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSaver } from "./saver.ts";

function deferred() {
  let resolve!: () => void;
  let reject!: () => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createSaver", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces rapid edits into one trailing save", async () => {
    const sent: number[] = [];
    const idle = vi.fn<(outcome: "saved" | "failed") => void>();
    const saver = createSaver<number>({
      delayMs: 200,
      send: async (value) => void sent.push(value),
      onIdle: idle,
    });
    saver.push(1);
    saver.push(2);
    saver.push(3);
    await vi.advanceTimersByTimeAsync(199);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual([3]);
    expect(idle).toHaveBeenCalledExactlyOnceWith("saved");
  });

  it("keeps one request in flight and reports idle only for the latest value", async () => {
    const first = deferred();
    const second = deferred();
    const gates = [first, second];
    const sent: number[] = [];
    const idle = vi.fn<(outcome: "saved" | "failed") => void>();
    const saver = createSaver<number>({
      delayMs: 200,
      send: (value) => {
        sent.push(value);
        return (gates.shift() as ReturnType<typeof deferred>).promise;
      },
      onIdle: idle,
    });
    saver.push(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(sent).toEqual([1]);

    saver.push(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(sent).toEqual([1]);

    first.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(idle).not.toHaveBeenCalled();
    expect(sent).toEqual([1, 2]);

    second.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(idle).toHaveBeenCalledExactlyOnceWith("saved");
  });

  it("reports a failure for the latest value and flushes on demand", async () => {
    const gate = deferred();
    const idle = vi.fn<(outcome: "saved" | "failed") => void>();
    const saver = createSaver<number>({
      delayMs: 200,
      send: () => gate.promise,
      onIdle: idle,
    });
    saver.push(1);
    saver.flush();
    gate.reject();
    await vi.advanceTimersByTimeAsync(0);
    expect(idle).toHaveBeenCalledExactlyOnceWith("failed");
  });
});
