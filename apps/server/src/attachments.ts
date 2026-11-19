import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { ATTACHMENT_MAX_BYTES, type Attachment } from "@age/contracts";
import { ServiceError } from "./errors.ts";

export interface AttachmentStore {
  put(input: { name: string; dataBase64: string }): Promise<Attachment>;
  remove(id: string): Promise<{ removed: boolean }>;
}

export const ATTACHMENTS_DIR = "attachments";
const ID_PATTERN = /^[0-9a-f-]{36}$/;

/**
 * Attached files live at AGE_HOME/attachments/<id>/<name>. The prompt names that path, so
 * any agent CLI can read the file with its own tools. Sent attachments stay on disk because
 * the transcript points at them; only files removed before sending are deleted.
 */
export function createAttachmentStore(home: string): AttachmentStore {
  const root = join(home, ATTACHMENTS_DIR);
  return {
    async put({ name, dataBase64 }) {
      const bytes = Buffer.from(dataBase64, "base64");
      if (bytes.length > ATTACHMENT_MAX_BYTES) {
        throw new ServiceError(
          "bad_request",
          `Attachments are at most ${ATTACHMENT_MAX_BYTES / 1024 / 1024} MB.`,
        );
      }
      const id = randomUUID();
      const fileName = safeName(name);
      const dir = join(root, id);
      await mkdir(dir, { recursive: true });
      const path = join(dir, fileName);
      await writeFile(path, bytes);
      return { id, name: fileName, path, size: bytes.length };
    },
    async remove(id) {
      if (!ID_PATTERN.test(id)) return { removed: false };
      const dir = join(root, id);
      try {
        await rm(dir, { recursive: true });
        return { removed: true };
      } catch {
        return { removed: false };
      }
    },
  };
}

function safeName(name: string): string {
  const printable = [...name.replaceAll("\\", "/")].filter((char) => char >= " ").join("");
  const cleaned = basename(printable).trim();
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "attachment" : cleaned;
}
