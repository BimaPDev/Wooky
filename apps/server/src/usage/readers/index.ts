import type { Origin } from "@age/contracts";
import type { HistoryReader } from "../history-reader.ts";
import { claudeHistoryReader } from "./claude.ts";

/** Placeholder that finds nothing. Each real reader replaces one stub entry below. */
function stubReader(origin: Origin): HistoryReader {
  return {
    origin,
    read: async () => ({ records: [], report: { origin, status: "missing", files: 0 } }),
  };
}

// STUB: Station 3 replaces these three with the real imports from ./cursor.ts, ./opencode.ts
// and ./codex.ts.
const stubCursorReader = stubReader("cursor");
const stubOpencodeReader = stubReader("opencode");
const stubCodexReader = stubReader("codex");

/** Every local history reader. The history worker runs all of them over the window. */
export const HISTORY_READERS: readonly HistoryReader[] = [
  claudeHistoryReader,
  stubCursorReader,
  stubCodexReader,
  stubOpencodeReader,
];
