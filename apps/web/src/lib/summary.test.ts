import type { TimelineItem } from "@wooky/contracts";
import { describe, expect, it } from "vitest";
import { formatDuration, summarizeTurn } from "./summary.ts";

const tool = (id: string): TimelineItem => ({
  kind: "tool",
  id,
  tool: "read",
  title: "Read a",
  name: "Read",
  status: "done",
});

describe("summarizeTurn", () => {
  it("formats durations", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(12_400)).toBe("12s");
    expect(formatDuration(72_000)).toBe("1m 12s");
    expect(formatDuration(3_780_000)).toBe("1h 3m");
  });

  it("counts tool steps and distinct changed files", () => {
    const summary = summarizeTurn({
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:01:12.000Z",
      items: [
        tool("a"),
        tool("b"),
        { kind: "reasoning", id: "r", text: "hm" },
        tool("c"),
        tool("d"),
        { kind: "message", id: "m", role: "assistant", text: "done" },
      ],
      changedFiles: ["a.ts", "b.ts", "c.ts", "a.ts"],
    });
    expect(summary.text).toBe("Worked for 1m 12s · 4 steps · 3 files changed");
    expect(summary.changedFiles).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("does not count the time spent waiting on an approval as work", () => {
    const base = {
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:10:00.000Z",
      items: [],
      changedFiles: [],
    };
    expect(summarizeTurn({ ...base, waitedMs: 8 * 60_000 }).text).toBe("Worked for 2m 0s");
    // A request still open when the turn ended counts from when it opened.
    expect(
      summarizeTurn({ ...base, waitedMs: 60_000, waitingSince: "2026-01-01T00:05:00.000Z" }).text,
    ).toBe("Worked for 4m 0s");
    // Old turns carry neither field.
    expect(summarizeTurn(base).text).toBe("Worked for 10m 0s");
  });

  it("uses singular forms and omits empty parts", () => {
    const base = { startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:05.000Z" };
    expect(summarizeTurn({ ...base, items: [tool("a")], changedFiles: ["x"] }).text).toBe(
      "Worked for 5s · 1 step · 1 file changed",
    );
    expect(summarizeTurn({ ...base, items: [], changedFiles: [] }).text).toBe("Worked for 5s");
  });

  it("measures a running turn against now", () => {
    const summary = summarizeTurn(
      { startedAt: "2026-01-01T00:00:00.000Z", endedAt: null, items: [], changedFiles: [] },
      Date.parse("2026-01-01T00:00:30.000Z"),
    );
    expect(summary.durationMs).toBe(30_000);
  });
});
