import type { ThreadStatus } from "@wooky/contracts";

/** "Send now" is only valid while the thread is not busy with a turn. */
export function canPromoteQueuedPrompt(status: ThreadStatus): boolean {
  return status === "idle";
}
