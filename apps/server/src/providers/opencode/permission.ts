import type { RuntimeMode } from "@age/contracts";

export type OpenCodePermissionAction = "ask" | "allow";

/**
 * Rules appended via OPENCODE_PERMISSION. OpenCode 1.19.6 evaluates with
 * findLast, so these beat the build agent's earlier `*` allow rule.
 */
export function openCodePermission(
  mode: RuntimeMode,
): Record<"edit" | "bash" | "webfetch", OpenCodePermissionAction> {
  if (mode === "full") {
    return { edit: "allow", bash: "allow", webfetch: "allow" };
  }
  if (mode === "auto-edits") {
    return { edit: "allow", bash: "ask", webfetch: "ask" };
  }
  return { edit: "ask", bash: "ask", webfetch: "ask" };
}
