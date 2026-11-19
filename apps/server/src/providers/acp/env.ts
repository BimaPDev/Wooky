import { fleetChildEnv } from "../agent-env.ts";

/**
 * Merge process env, then each settings layer (later wins). A thread id also
 * applies the fleet overlay (WOOKY_THREAD_ID and the wooky shim on PATH).
 * Callers must not log the result: settings env is local-only.
 */
export function childEnv(
  threadId: string | null,
  layers: Array<Record<string, string> | undefined>,
): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const layer of layers) {
    if (!layer) continue;
    for (const [key, value] of Object.entries(layer)) {
      if (typeof value === "string") base[key] = value;
    }
  }
  if (threadId === null) return base;
  return fleetChildEnv(threadId, base);
}
