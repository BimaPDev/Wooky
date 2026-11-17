import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProviderEvent } from "@age/contracts";
import { describe, expect, it } from "vitest";
import { CursorTranslator, resetTranslateIds } from "./translate.ts";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

async function lines(name: string): Promise<string[]> {
  const raw = await readFile(join(fixtureDir, name), "utf8");
  return raw.split("\n").filter((l) => l.trim());
}

async function translateFixture(name: string): Promise<ProviderEvent[]> {
  resetTranslateIds();
  const t = new CursorTranslator();
  const events: ProviderEvent[] = [];
  for (const line of await lines(name)) {
    events.push(...t.translate(JSON.parse(line) as Record<string, unknown>));
  }
  return events;
}

function lastDone(events: ProviderEvent[]) {
  return events.filter((e) => e.type === "done").at(-1);
}

describe("CursorTranslator", () => {
  it("translates message streaming from simple-message fixture", async () => {
    const events = await translateFixture("simple-message.ndjson");
    expect(events.some((e) => e.type === "session")).toBe(true);
    expect(events.some((e) => e.type === "item" && e.item.kind === "reasoning")).toBe(true);
    expect(events.some((e) => e.type === "item" && e.item.kind === "message")).toBe(true);
    const deltas = events.filter((e) => e.type === "delta");
    expect(deltas.length).toBeGreaterThan(0);
    const done = lastDone(events);
    expect(done?.status).toBe("completed");
  });

  it("translates tool lifecycle", async () => {
    const events = await translateFixture("tools.ndjson");
    const tools = events.filter((e) => e.type === "item" && e.item.kind === "tool");
    expect(tools.length).toBeGreaterThanOrEqual(4);
    const read = tools.find(
      (e) => e.type === "item" && e.item.kind === "tool" && e.item.title.startsWith("Read"),
    );
    expect(read?.type === "item" && read.item.kind === "tool" && read.item.tool).toBe("read");
    const failed = tools.find(
      (e) => e.type === "item" && e.item.kind === "tool" && e.item.status === "failed",
    );
    expect(failed).toBeDefined();
    expect(events.some((e) => e.type === "usage")).toBe(true);
  });

  it("maps error result to failed done", async () => {
    const events = await translateFixture("error-result.ndjson");
    const done = lastDone(events);
    expect(done?.status).toBe("failed");
    expect(done?.error).toBe("Something went wrong");
  });

  it("ignores unknown event types", async () => {
    const events = await translateFixture("unknown-events.ndjson");
    expect(events.some((e) => e.type === "item" && e.item.kind === "message")).toBe(true);
    expect(lastDone(events)?.status).toBe("completed");
  });

  it("emits exactly one done event", async () => {
    for (const name of [
      "simple-message.ndjson",
      "tools.ndjson",
      "error-result.ndjson",
      "unknown-events.ndjson",
    ]) {
      resetTranslateIds();
      const t = new CursorTranslator();
      const events: ProviderEvent[] = [];
      for (const line of await lines(name)) {
        events.push(...t.translate(JSON.parse(line) as Record<string, unknown>));
      }
      const dones = events.filter((e) => e.type === "done");
      expect(dones.length, `${name} should emit exactly one done`).toBe(1);
      expect(events.at(-1)?.type).toBe("done");
    }
  });

  it("finish emits done when stream ends without result", () => {
    resetTranslateIds();
    const t = new CursorTranslator();
    const tail = t.finish(0, null, false);
    expect(tail).toHaveLength(1);
    expect(tail).toEqual([{ type: "done", status: "completed", error: null }]);
  });
});
