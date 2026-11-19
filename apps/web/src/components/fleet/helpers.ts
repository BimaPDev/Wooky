import type {
  AgeEvent,
  FleetRow,
  FleetStatus,
  ProviderKind,
  ReadModel,
  Thread,
  ThreadGroup,
} from "@age/contracts";
import { FLEET_LIMITS } from "@age/contracts";
import { fleetRows } from "@age/domain";
import { fuzzyFilter } from "../../lib/fuzzy.ts";

export const FANOUT_MIN_TARGETS = 2;
export const FANOUT_MAX_TARGETS = FLEET_LIMITS.maxFanoutTargets;

export const BOARD_STATUS_ORDER = ["waiting", "working", "done", "failed", "idle"] as const;

export const BOARD_STATUS_LABEL: Record<FleetStatus, string> = {
  waiting: "Waiting on you",
  working: "Working",
  done: "Done",
  failed: "Failed",
  idle: "Idle",
};

export interface FanoutTargetDraft {
  provider: string;
  model: string;
}

export interface JumpItem {
  threadId: string;
  title: string;
  projectName: string;
  provider: ProviderKind;
  model: string;
  status: FleetStatus;
}

export type SidebarTreeNode =
  | { kind: "thread"; thread: Thread }
  | { kind: "orphaned"; thread: Thread }
  | { kind: "coordinator"; thread: Thread; workers: Thread[] }
  | { kind: "group"; group: ThreadGroup; threads: Thread[] };

let fleetRowsCache: { seq: number; rows: readonly FleetRow[] } | null = null;
let statusCache: { signature: string; map: Readonly<Record<string, FleetStatus>> } | null = null;

/** One fleetRows pass per model.seq, shared by the board, sidebar and jump switcher. */
export function selectFleetRows(model: ReadModel): readonly FleetRow[] {
  if (fleetRowsCache?.seq === model.seq) return fleetRowsCache.rows;
  const rows = fleetRows(model);
  fleetRowsCache = { seq: model.seq, rows };
  return rows;
}

/** Cheap key so itemDelta does not rebuild the sidebar status map. */
export function fleetStatusSignature(model: ReadModel): string {
  return Object.values(model.threads)
    .map((thread) => {
      const last = model.turns[thread.id]?.at(-1);
      const activeId = last?.status === "running" ? last.id : "";
      const pending =
        last?.status === "running"
          ? last.items.filter(
              (item) =>
                (item.kind === "approval" && item.decision === null) ||
                (item.kind === "question" && item.answers === null && !item.dismissed),
            ).length
          : 0;
      return `${thread.id}:${thread.status}:${last?.status ?? ""}:${activeId}:${pending}`;
    })
    .toSorted()
    .join("\n");
}

export function selectFleetStatusById(model: ReadModel): Readonly<Record<string, FleetStatus>> {
  const signature = fleetStatusSignature(model);
  if (statusCache?.signature === signature) return statusCache.map;
  const map = Object.fromEntries(selectFleetRows(model).map((row) => [row.threadId, row.status]));
  statusCache = { signature, map };
  return map;
}

export function groupIdFromCreatedEvent(event: AgeEvent, commandId: string): string | null {
  if (event.type === "group.created" && event.commandId === commandId) return event.group.id;
  return null;
}

export function groupIdFromDispatchAck(ack: {
  commandId: string;
  events?: unknown;
}): string | null {
  if (!Array.isArray(ack.events)) return null;
  for (const event of ack.events) {
    if (!event || typeof event !== "object") continue;
    const groupId = groupIdFromCreatedEvent(event as AgeEvent, ack.commandId);
    if (groupId) return groupId;
  }
  return null;
}

export interface BoardGroup {
  status: FleetStatus;
  label: string;
  rows: FleetRow[];
}

export function groupFleetRows(rows: readonly FleetRow[]): BoardGroup[] {
  const buckets: Record<FleetStatus, FleetRow[]> = {
    waiting: [],
    working: [],
    done: [],
    failed: [],
    idle: [],
  };
  for (const row of rows) buckets[row.status].push(row);
  return BOARD_STATUS_ORDER.filter((status) => buckets[status].length > 0).map((status) => ({
    status,
    label: BOARD_STATUS_LABEL[status],
    rows: buckets[status],
  }));
}

export function filterFleetRows(
  rows: readonly FleetRow[],
  query: string,
  projectName: (id: string) => string,
) {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows.slice();
  return rows.filter((row) => {
    const haystack = [
      row.title,
      projectName(row.projectId),
      row.provider,
      row.model,
      row.role,
      row.parentThreadId ?? "",
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  });
}

export function fanoutTargetError(targets: readonly FanoutTargetDraft[]): string | null {
  if (targets.length < FANOUT_MIN_TARGETS) return "Pick at least two agents.";
  if (targets.length > FANOUT_MAX_TARGETS) return "At most six agents.";
  if (targets.some((target) => !target.provider || !target.model.trim()))
    return "Each agent needs a provider and a model.";
  return null;
}

export function rankJumpItems(items: readonly JumpItem[], query: string): JumpItem[] {
  const matched = fuzzyFilter(
    items,
    query,
    (item) => `${item.title} ${item.projectName} ${item.provider} ${item.model} ${item.status}`,
  );
  return matched.toSorted(
    (a, b) => Number(b.status === "waiting") - Number(a.status === "waiting"),
  );
}

export function jumpItemsFromRows(
  rows: readonly FleetRow[],
  projectName: (id: string) => string,
): JumpItem[] {
  return rows.map((row) => ({
    threadId: row.threadId,
    title: row.title || "Untitled thread",
    projectName: projectName(row.projectId),
    provider: row.provider,
    model: row.model,
    status: row.status,
  }));
}

export function buildSidebarTree(
  visible: readonly Thread[],
  all: readonly Thread[],
  groups: Readonly<Record<string, ThreadGroup>>,
): SidebarTreeNode[] {
  const allById = new Map(all.map((thread) => [thread.id, thread]));
  const visibleIds = new Set(visible.map((thread) => thread.id));
  const used = new Set<string>();
  const nodes: SidebarTreeNode[] = [];

  const fanoutById = new Map<string, ThreadGroup>();
  for (const group of Object.values(groups)) {
    if (group.kind !== "fanout") continue;
    const members = group.threadIds.filter((id) => allById.has(id));
    if (members.length === 0) continue;
    if (members.some((id) => visibleIds.has(id))) fanoutById.set(group.id, group);
  }

  const coordinatorIds = new Set<string>();
  for (const thread of all) {
    if (
      thread.parentThreadId &&
      (visibleIds.has(thread.id) || visibleIds.has(thread.parentThreadId))
    )
      coordinatorIds.add(thread.parentThreadId);
  }
  for (const thread of visible) {
    if (thread.role === "coordinator") coordinatorIds.add(thread.id);
  }

  const emitCoordinator = (id: string) => {
    const thread = allById.get(id);
    if (!thread || used.has(thread.id)) return;
    used.add(thread.id);
    const workers = all.filter((child) => child.parentThreadId === id);
    for (const worker of workers) used.add(worker.id);
    nodes.push({ kind: "coordinator", thread, workers });
  };

  const emitGroup = (group: ThreadGroup) => {
    const key = `g:${group.id}`;
    if (used.has(key)) return;
    used.add(key);
    const threads = group.threadIds.flatMap((id) => {
      const thread = allById.get(id);
      return thread ? [thread] : [];
    });
    for (const thread of threads) used.add(thread.id);
    nodes.push({ kind: "group", group, threads });
  };

  for (const thread of visible) {
    if (used.has(thread.id)) continue;
    if (coordinatorIds.has(thread.id)) {
      emitCoordinator(thread.id);
      continue;
    }
    if (thread.parentThreadId && coordinatorIds.has(thread.parentThreadId)) {
      if (allById.has(thread.parentThreadId)) {
        emitCoordinator(thread.parentThreadId);
        continue;
      }
      used.add(thread.id);
      nodes.push({ kind: "orphaned", thread });
      continue;
    }
    if (thread.parentThreadId && !allById.has(thread.parentThreadId)) {
      used.add(thread.id);
      nodes.push({ kind: "orphaned", thread });
      continue;
    }
    const group = thread.groupId ? fanoutById.get(thread.groupId) : undefined;
    if (group) {
      emitGroup(group);
      continue;
    }
    used.add(thread.id);
    nodes.push({ kind: "thread", thread });
  }

  return nodes;
}

export function summarizeStatuses(statuses: readonly FleetStatus[]): string {
  const counts: Record<FleetStatus, number> = {
    waiting: 0,
    working: 0,
    done: 0,
    failed: 0,
    idle: 0,
  };
  for (const status of statuses) counts[status] += 1;
  return BOARD_STATUS_ORDER.filter((status) => counts[status] > 0)
    .map((status) => `${counts[status]} ${status}`)
    .join(", ");
}

export function workerCountLabel(total: number, waiting: number): string {
  const workers = `${total} ${total === 1 ? "worker" : "workers"}`;
  if (waiting <= 0) return workers;
  return `${workers}, ${waiting} waiting`;
}

export function promptPreview(prompt: string, max = 48): string {
  const text = prompt.trim().replace(/\s+/g, " ");
  if (!text) return "Untitled group";
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

export function fleetRoleLabel(
  row: Pick<FleetRow, "role" | "parentThreadId" | "groupId">,
  parentTitle?: string,
): string {
  if (row.role === "coordinator") return "Coordinator";
  if (row.role === "worker" && row.parentThreadId)
    return parentTitle ? `Worker of ${parentTitle}` : "Orphaned worker";
  if (row.role === "worker" || row.groupId) return "Fan-out";
  return "Solo";
}

export function formatRelativeActivity(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 604_800) return `${Math.floor(seconds / 86_400)}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function lastAssistantText(text: string | undefined, max = 180): string {
  const trimmed = text?.trim() ?? "";
  if (!trimmed) return "No final message yet.";
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}
