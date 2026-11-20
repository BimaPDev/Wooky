import { randomBytes } from "node:crypto";
import { chmodSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

/** Writes JSON via a temp file in the same directory, then mode 0600. */
export function writePrivateJson(path: string, value: unknown): void {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // The temp file was already renamed, or never created.
    }
    throw error;
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows stores the ACL on the profile instead of a POSIX mode.
  }
}
