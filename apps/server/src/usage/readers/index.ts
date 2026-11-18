import type { HistoryReader } from "../history-reader.ts";
import { claudeHistoryReader } from "./claude.ts";
import { codexHistoryReader } from "./codex.ts";
import { cursorHistoryReader } from "./cursor.ts";
import { opencodeHistoryReader } from "./opencode.ts";

/** Every local history reader. The history worker runs all of them over the window. */
export const HISTORY_READERS: readonly HistoryReader[] = [
  claudeHistoryReader,
  cursorHistoryReader,
  codexHistoryReader,
  opencodeHistoryReader,
];
