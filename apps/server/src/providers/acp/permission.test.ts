import { describe, expect, it } from "vitest";
import { parsePermission, permissionResult, selectOption, shouldAsk } from "./permission.ts";

const options = [
  { optionId: "allow", kind: "allow_once", name: "Allow once" },
  { optionId: "always", kind: "allow_always", name: "Always" },
  { optionId: "deny", kind: "reject_once", name: "Reject" },
];

describe("ACP permissions", () => {
  it("asks in approve mode and skips edits in auto-edits", () => {
    expect(shouldAsk({ runtimeMode: "approve", interactionMode: "default", tool: "read" })).toBe(
      true,
    );
    expect(shouldAsk({ runtimeMode: "auto-edits", interactionMode: "default", tool: "edit" })).toBe(
      false,
    );
    expect(
      shouldAsk({ runtimeMode: "auto-edits", interactionMode: "default", tool: "command" }),
    ).toBe(true);
    expect(shouldAsk({ runtimeMode: "full", interactionMode: "default", tool: "command" })).toBe(
      false,
    );
    expect(shouldAsk({ runtimeMode: "full", interactionMode: "plan", tool: "edit" })).toBe(true);
  });

  it("maps allow and deny onto the agent's options", () => {
    expect(selectOption("allow", options)).toBe("allow");
    expect(selectOption("deny", options)).toBe("deny");
    expect(permissionResult("cancel", options)).toEqual({ outcome: { outcome: "cancelled" } });
    expect(permissionResult("allow", [{ optionId: "only", kind: "reject_once" }])).toEqual({
      outcome: { outcome: "cancelled" },
    });
  });

  it("reads a v1 tool call and a v2 command subject", () => {
    const tool = parsePermission(
      {
        title: "Run tests",
        options,
        toolCall: { toolCallId: "call_1", title: "pnpm test", kind: "execute" },
      },
      4,
    );
    expect(tool?.request).toMatchObject({
      requestId: "call_1",
      tool: "command",
      title: "Run tests",
    });
    const command = parsePermission(
      {
        title: "Run this script?",
        description: "scripts/setup.sh",
        options,
        subject: { type: "command", command: "scripts/setup.sh", cwd: "/repo" },
      },
      5,
    );
    expect(command?.request).toMatchObject({ tool: "command", detail: "scripts/setup.sh" });
  });
});
