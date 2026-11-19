import { classifyGenericText, isInterruptText, type TurnFailure } from "../failure.ts";
import { isAuthFailure } from "./probe.ts";

const INTERRUPT_EXIT_CODES = new Set([130, 143]);

export function classifyCursorFailure(input: {
  errorText?: string;
  stderr?: string;
  exitCode?: number | null;
  now?: Date;
}): TurnFailure | null {
  if (
    input.exitCode !== undefined &&
    input.exitCode !== null &&
    INTERRUPT_EXIT_CODES.has(input.exitCode)
  ) {
    return null;
  }

  const parts = [input.errorText, input.stderr].filter((part): part is string => {
    return typeof part === "string" && part.trim() !== "";
  });
  const text = parts.join("\n").trim();
  if (text === "") return null;
  if (isInterruptText(text)) return null;

  if (isAuthFailure(text)) {
    return { kind: "auth", message: text };
  }

  return classifyGenericText(text, input.now);
}
