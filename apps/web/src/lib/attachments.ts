import type { Attachment } from "@wooky/contracts";

/** A file in the composer: still uploading, saved on the server, or refused. */
export type ComposerAttachment =
  | { key: string; name: string; status: "uploading" }
  | { key: string; name: string; status: "ready"; attachment: Attachment }
  | { key: string; name: string; status: "failed"; error: string };

/**
 * Agents read attachments with their own file tools, so the prompt names each saved path.
 * The list goes after the text so the user's words stay first.
 */
export function promptWithAttachments(prompt: string, attachments: readonly Attachment[]): string {
  const text = prompt.trim();
  if (attachments.length === 0) return text;
  const list = attachments.map((entry) => `- ${entry.path}`).join("\n");
  const block = `Attached ${attachments.length === 1 ? "file" : "files"}:\n${list}`;
  return text ? `${text}\n\n${block}` : block;
}

export function readyAttachments(items: readonly ComposerAttachment[]): Attachment[] {
  return items.flatMap((item) => (item.status === "ready" ? [item.attachment] : []));
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
