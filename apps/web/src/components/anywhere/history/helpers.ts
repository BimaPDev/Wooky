import type { Snapshot, SnapshotReason } from "@wooky/contracts";

export const PAGE_SIZE = 25;

export const reasonLabels: Record<SnapshotReason, string> = {
  interval: "Automatic",
  turn: "After a turn",
  manual: "Saved by you",
  "before-apply": "Backup",
  revert: "Revert",
  incoming: "From another device",
};

export interface DeviceNames {
  localDeviceId: string | null;
  names: Readonly<Record<string, string>>;
}

export function deviceName(devices: DeviceNames, deviceId: string): string {
  if (deviceId === devices.localDeviceId) return "This device";
  return devices.names[deviceId] ?? "Another device";
}

/** "Backup", "Saved by you", "From Work Mac" … the reason as one row label. */
export function reasonText(snapshot: Pick<Snapshot, "reason" | "deviceId">, devices: DeviceNames) {
  if (snapshot.reason === "incoming") return `From ${deviceName(devices, snapshot.deviceId)}`;
  return reasonLabels[snapshot.reason];
}

export function summaryText(summary: Snapshot["summary"]): string {
  if (!summary) return "No file changes";
  return `${summary.filesChanged} ${summary.filesChanged === 1 ? "file" : "files"}`;
}

/** Newest first, first page then older pages, no row twice. */
export function mergePages(head: readonly Snapshot[], tail: readonly Snapshot[]): Snapshot[] {
  const seen = new Set<string>();
  const merged: Snapshot[] = [];
  for (const snapshot of [...head, ...tail]) {
    if (seen.has(snapshot.id)) continue;
    seen.add(snapshot.id);
    merged.push(snapshot);
  }
  return merged;
}

const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const dayClock = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** "14:02" today, "Nov 18, 14:02" before. */
export function whenText(iso: string, now: number = Date.now()): string {
  const at = new Date(iso);
  const today = new Date(now);
  const sameDay =
    at.getFullYear() === today.getFullYear() &&
    at.getMonth() === today.getMonth() &&
    at.getDate() === today.getDate();
  return sameDay ? clock.format(at) : dayClock.format(at);
}

export function togglePath(selected: readonly string[], path: string): string[] {
  return selected.includes(path) ? selected.filter((entry) => entry !== path) : [...selected, path];
}
