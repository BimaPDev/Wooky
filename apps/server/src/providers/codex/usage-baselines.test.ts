import { describe, expect, it } from "vitest";
import { createUsageBaselineStore } from "./usage-baselines.ts";

describe("createUsageBaselineStore", () => {
  const totals = (n: number) => ({ inputTokens: n, outputTokens: n });

  it("returns what was stored and undefined-free null for unknown threads", () => {
    const store = createUsageBaselineStore(3);
    store.set("a", totals(1));
    expect(store.get("a")).toEqual(totals(1));
    expect(store.get("missing")).toBeNull();
  });

  it("evicts the least recently used thread once the bound is exceeded", () => {
    const store = createUsageBaselineStore(2);
    store.set("a", totals(1));
    store.set("b", totals(2));
    // Reading refreshes recency, so "b" is now the oldest.
    expect(store.get("a")).toEqual(totals(1));
    store.set("c", totals(3));
    expect(store.get("b")).toBeNull();
    expect(store.get("a")).toEqual(totals(1));
    expect(store.get("c")).toEqual(totals(3));
    expect(store.size()).toBe(2);
  });

  it("re-inserting an existing thread replaces it without growing the store", () => {
    const store = createUsageBaselineStore(2);
    store.set("a", totals(1));
    store.set("b", totals(2));
    store.set("a", totals(9));
    store.set("c", totals(3));
    expect(store.get("b")).toBeNull();
    expect(store.get("a")).toEqual(totals(9));
  });

  it("defaults to a bound of 1,000 threads", () => {
    const store = createUsageBaselineStore();
    for (let i = 0; i < 1_005; i += 1) store.set(`t${String(i)}`, totals(i));
    expect(store.size()).toBe(1_000);
    expect(store.get("t0")).toBeNull();
    expect(store.get("t1004")).toEqual(totals(1004));
  });
});
