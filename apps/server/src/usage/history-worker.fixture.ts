import { join } from "node:path";
import type { Origin } from "@wooky/contracts";
import type { HistoryReader, HistoryRecord } from "./history-reader.ts";

/** Test double for a real reader: parses `<home>/fake-<origin>/*.jsonl` through `ctx.fs`. */
export const fakeReaderRuns = new Map<Origin, number>();

interface FakeLine {
  at: number;
  model: string;
  session: string;
  input: number;
  cacheRead?: number;
  cacheWrite?: number;
  output: number;
  reported?: number;
  key?: string;
}

export function fakeReader(origin: Origin): HistoryReader {
  return {
    origin,
    async read(ctx) {
      fakeReaderRuns.set(origin, (fakeReaderRuns.get(origin) ?? 0) + 1);
      const dir = join(ctx.homeDir, `fake-${origin}`);
      let names: readonly string[];
      try {
        names = await ctx.fs.readdir(dir);
      } catch {
        return { records: [], report: { origin, status: "missing", files: 0 } };
      }
      const records: HistoryRecord[] = [];
      for (const name of names) {
        if (ctx.signal.aborted) throw new Error("aborted");
        const text = new TextDecoder().decode(await ctx.fs.readFile(join(dir, name)));
        for (const line of text.split("\n")) {
          if (line.trim() === "") continue;
          const row = JSON.parse(line) as FakeLine;
          const record: HistoryRecord = {
            origin,
            model: row.model,
            sessionKey: row.session,
            at: row.at,
            inputTokens: row.input,
            cacheReadTokens: row.cacheRead ?? 0,
            cacheWriteTokens: row.cacheWrite ?? 0,
            outputTokens: row.output,
          };
          if (row.reported !== undefined) record.reportedCostUsd = row.reported;
          if (row.key !== undefined) record.dedupeKey = row.key;
          records.push(record);
        }
      }
      return { records, report: { origin, status: "ok", files: names.length } };
    },
  };
}

/** Throws with a path in the message, to prove a failing reader leaks nothing. */
export function explodingReader(origin: Origin): HistoryReader {
  return {
    origin,
    read: async (ctx) => {
      throw Object.assign(new Error(`cannot open ${join(ctx.homeDir, "secret-project")}`), {
        code: "EACCES",
      });
    },
  };
}

/** Loaded by the real worker in the round-trip test, in place of the production registry. */
export const HISTORY_READERS: readonly HistoryReader[] = [
  fakeReader("claude"),
  explodingReader("codex"),
];

export const FIXTURE_READERS_URL = import.meta.url;
