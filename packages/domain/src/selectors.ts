import type { ReadModel, Thread, Turn } from "@age/contracts";

export function threadsForProject(model: ReadModel, projectId: string): Thread[] {
  return Object.values(model.threads)
    .filter((thread) => thread.projectId === projectId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function activeTurn(model: ReadModel, threadId: string): Turn | null {
  const last = model.turns[threadId]?.at(-1);
  return last?.status === "running" ? last : null;
}

export function pendingApprovals(model: ReadModel, threadId: string) {
  const turn = activeTurn(model, threadId);
  if (!turn) return [];
  return turn.items.filter((item) => item.kind === "approval" && item.decision === null);
}

/** Plain-text transcript used to hand a thread off to a different provider. */
export function handoffTranscript(model: ReadModel, threadId: string, maxChars = 24_000): string {
  const parts: string[] = [];
  for (const turn of model.turns[threadId] ?? []) {
    parts.push(`User: ${turn.prompt}`);
    for (const item of turn.items) {
      if (item.kind === "message" && item.role === "assistant")
        parts.push(`Assistant: ${item.text}`);
      if (item.kind === "tool" && item.files?.length) parts.push(`(${item.title})`);
    }
  }
  const text = parts.join("\n\n");
  return text.length > maxChars ? text.slice(text.length - maxChars) : text;
}
