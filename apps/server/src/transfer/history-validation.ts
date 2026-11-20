import { HistoryTurn } from "@wooky/contracts";

/** Most finished turns copied from a peer. Matches the contract's array cap. */
export const MAX_IMPORT_TURNS = 500;
/** One turn larger than this is dropped; the thread stays usable without it. */
export const MAX_TURN_BYTES = 512 * 1024;
export const MAX_IMPORT_BYTES = 8 * 1024 * 1024;
export const MAX_TITLE = 200;
export const MAX_FILE_PATH = 1024;

/** A relative path with no `..` segment, no drive or root, and no control characters. */
export function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || path.length > MAX_FILE_PATH) return false;
  if (path.includes("\0") || path.includes("\n") || path.includes("\r")) return false;
  if (path.startsWith("/") || path.startsWith("\\") || /^[a-zA-Z]:/.test(path)) return false;
  return !path.split(/[\\/]/).some((segment) => segment === "..");
}

function cleanTurn(turn: HistoryTurn): HistoryTurn {
  return {
    ...turn,
    checkpointBefore: null,
    checkpointAfter: null,
    nativeRef: null,
    changedFiles: turn.changedFiles.filter(isSafeRelativePath),
    items: turn.items.map((item) =>
      item.kind === "tool" && item.files
        ? { ...item, files: item.files.filter(isSafeRelativePath) }
        : item,
    ),
  };
}

/**
 * Turns copied from another device are untrusted. Keep the ones that match the schema and
 * fit the size caps, newest first when the budget runs out. Checkpoint refs and native
 * session ids belong to the other device's repository and provider session, so they are
 * cleared: a ref from a peer must never reach a local `git` call.
 */
export function validateHistoryTurns(input: unknown): HistoryTurn[] {
  if (!Array.isArray(input)) return [];
  const kept: HistoryTurn[] = [];
  let bytes = 0;
  for (let index = input.length - 1; index >= 0 && kept.length < MAX_IMPORT_TURNS; index -= 1) {
    const parsed = HistoryTurn.safeParse(input[index]);
    if (!parsed.success) continue;
    const turn = cleanTurn(parsed.data);
    const size = Buffer.byteLength(JSON.stringify(turn), "utf8");
    if (size > MAX_TURN_BYTES) continue;
    if (bytes + size > MAX_IMPORT_BYTES) break;
    bytes += size;
    kept.push(turn);
  }
  return kept.reverse();
}

export function importTitle(title: string): string {
  const trimmed = title.trim().slice(0, MAX_TITLE);
  return trimmed.length > 0 ? trimmed : "Imported thread";
}
