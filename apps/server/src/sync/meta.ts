import { SnapshotReason, type Snapshot } from "@wooky/contracts";
import { z } from "zod";

/** What a snapshot commit message carries as JSON, after a one-line subject. */
export const SnapshotMeta = z.object({
  deviceId: z.string().min(1),
  reason: SnapshotReason,
  at: z.string(),
  threadId: z.string().nullable().default(null),
  turnId: z.string().nullable().default(null),
  label: z.string().nullable().default(null),
  head: z.string().nullable().default(null),
  branch: z.string().nullable().default(null),
  skipped: z.array(z.string()).default([]),
});
export type SnapshotMeta = z.infer<typeof SnapshotMeta>;

export function encodeMeta(meta: SnapshotMeta): string {
  return `wooky snapshot: ${meta.reason}\n\n${JSON.stringify(meta)}\n`;
}

export function decodeMeta(message: string): SnapshotMeta | null {
  const body = message.split("\n\n")[1];
  if (!body) return null;
  try {
    const parsed = SnapshotMeta.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function toSnapshot(
  projectId: string,
  entry: {
    id: string;
    parentId: string | null;
    summary: NonNullable<Snapshot["summary"]>;
  },
  meta: SnapshotMeta,
): Snapshot {
  return {
    id: entry.id,
    kind: "files",
    projectId,
    threadId: meta.threadId,
    deviceId: meta.deviceId,
    reason: meta.reason,
    label: meta.label?.slice(0, 200) ?? null,
    createdAt: meta.at,
    summary: entry.summary,
    parentId: entry.parentId,
  };
}
