import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DeviceSettings, ModelTarget } from "@wooky/contracts";
import type { ProviderRegistry } from "../providers/registry.ts";
import type { CompleteFn } from "./extract.ts";

/**
 * Wooky has no model of its own and no one-shot call, so the extractor borrows an agent CLI the
 * user already signed in to: one throwaway turn, in an empty folder, with every approval denied
 * and no session resumed. The reply is the last assistant message.
 */

/** Used when the user picked none: Claude's small model, if Claude is installed and on. */
const DEFAULT_MODEL: ModelTarget = { provider: "claude", model: "haiku" };

export function extractionModel(settings: DeviceSettings): ModelTarget | null {
  const chosen = settings.brain.extractModel ?? DEFAULT_MODEL;
  return settings.disabledProviders.includes(chosen.provider) ? null : chosen;
}

export function createProviderComplete(deps: {
  providers: Pick<ProviderRegistry, "get">;
  settings: () => DeviceSettings;
  /** WOOKY_HOME. The turn runs in `<home>/brain/extract-cwd`, an empty folder. */
  home: string;
}): CompleteFn {
  return async (prompt, { signal }) => {
    const target = extractionModel(deps.settings());
    if (target === null) throw new Error("No model is available for brain extraction");
    const adapter = deps.providers.get(target.provider);
    if (adapter === null) throw new Error(`Provider ${target.provider} is not installed`);
    const cwd = join(deps.home, "brain", "extract-cwd");
    mkdirSync(cwd, { recursive: true });
    const id = randomUUID();
    const messages = new Map<string, string>();
    let last: string | null = null;
    let done: { status: string; error: string | null } | null = null;
    for await (const event of adapter.runTurn({
      threadId: `brain-extract-${id}`,
      turnId: `brain-extract-${id}`,
      cwd,
      prompt,
      model: target.model,
      runtimeMode: "approve",
      resumeSessionId: null,
      resumeAt: null,
      interactionMode: "default",
      handoffContext: null,
      signal,
      requestApproval: async () => "deny",
      requestUserInput: async () => null,
    })) {
      if (
        event.type === "item" &&
        event.item.kind === "message" &&
        event.item.role === "assistant"
      ) {
        messages.set(event.item.id, event.item.text);
        last = event.item.id;
      } else if (event.type === "delta" && messages.has(event.itemId)) {
        messages.set(event.itemId, `${messages.get(event.itemId) ?? ""}${event.text}`);
      } else if (event.type === "done") {
        done = { status: event.status, error: event.error };
      }
    }
    if (done?.status !== "completed") {
      throw new Error(`Extraction turn ${done?.status ?? "ended without a result"}`);
    }
    const text = last === null ? "" : (messages.get(last) ?? "");
    if (text.trim() === "") throw new Error("Extraction turn returned no text");
    return text;
  };
}
