import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { TurnInput } from "../types.ts";

/**
 * Fast mode and ultracode are session settings in the SDK, not options of their own. They go in
 * the `settings` overlay, and only when the user turned them on, so an untouched thread leaves the
 * CLI's own configuration alone.
 */
export function sessionSettings(
  input: Pick<TurnInput, "fastMode" | "ultracode">,
): Pick<Options, "settings"> {
  const overlay = {
    ...(input.fastMode ? { fastMode: true } : {}),
    ...(input.ultracode ? { ultracode: true } : {}),
  };
  return Object.keys(overlay).length > 0 ? { settings: overlay } : {};
}
