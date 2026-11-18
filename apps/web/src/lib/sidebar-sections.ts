import type { Thread } from "@age/contracts";

export function isWorkingStatus(status: Thread["status"]): boolean {
  return status === "running" || status === "waiting";
}

export function isSettledStatus(status: Thread["status"]): boolean {
  return status === "idle";
}

export function partitionSidebarThreads(threads: Thread[]): {
  working: Thread[];
  settled: Thread[];
  listed: Thread[];
} {
  const working: Thread[] = [];
  const settled: Thread[] = [];
  const listed: Thread[] = [];
  for (const thread of threads) {
    if (isWorkingStatus(thread.status)) working.push(thread);
    else if (isSettledStatus(thread.status)) settled.push(thread);
    else listed.push(thread);
  }
  return { working, settled, listed };
}
