import { FLEET_LIMITS, type ProviderStatus } from "@wooky/contracts";
import { describe, expect, it } from "vitest";
import { fleetGuide, formatAgents, usableAgents } from "./guide.ts";

function status(
  overrides: Partial<ProviderStatus> & Pick<ProviderStatus, "kind" | "label">,
): ProviderStatus {
  return {
    installed: true,
    authenticated: true,
    version: "1",
    models: [{ id: "model-a", label: "Model A" }],
    problem: null,
    ...overrides,
  };
}

describe("usableAgents", () => {
  it("returns an empty list when nothing is usable", () => {
    expect(usableAgents([])).toEqual([]);
    expect(
      usableAgents([
        status({ kind: "demo", label: "Demo" }),
        status({ kind: "claude", label: "Claude", installed: false }),
        status({ kind: "codex", label: "Codex", authenticated: false }),
        status({ kind: "cursor", label: "Cursor", problem: "signed out" }),
        status({ kind: "opencode", label: "OpenCode", models: [] }),
      ]),
    ).toEqual([]);
  });

  it("excludes demo and disabled providers", () => {
    const listed = [
      status({ kind: "demo", label: "Demo" }),
      status({
        kind: "claude",
        label: "Claude",
        models: [
          { id: "sonnet", label: "Sonnet" },
          { id: "haiku", label: "haiku" },
        ],
      }),
      status({ kind: "codex", label: "Codex", models: [{ id: "gpt", label: "GPT" }] }),
      status({ kind: "cursor", label: "Cursor", authenticated: null }),
    ];
    expect(usableAgents(listed, ["codex"])).toEqual([
      {
        provider: "claude",
        label: "Claude",
        models: [
          { id: "sonnet", label: "Sonnet" },
          { id: "haiku", label: "haiku" },
        ],
      },
      {
        provider: "cursor",
        label: "Cursor",
        models: [{ id: "model-a", label: "Model A" }],
      },
    ]);
  });
});

describe("formatAgents", () => {
  it("explains when none are signed in and prints kind plus models", () => {
    expect(formatAgents([])).toBe(
      "No signed-in agents are available. Ask the user to sign one in.",
    );
    expect(
      formatAgents([
        {
          provider: "claude",
          label: "Claude",
          models: [
            { id: "sonnet", label: "Sonnet" },
            { id: "haiku", label: "haiku" },
          ],
        },
      ]),
    ).toBe(["--provider claude  (Claude)", "  sonnet  (Sonnet)", "  haiku"].join("\n"));
  });
});

describe("fleetGuide", () => {
  it("mentions the playbook commands, live agents, and limits", () => {
    const text = fleetGuide([
      {
        provider: "claude",
        label: "Claude",
        models: [{ id: "sonnet", label: "Sonnet" }],
      },
    ]);
    expect(text).toContain("age agents spawn");
    expect(text).toContain("age agents wait");
    expect(text).toContain("age agents result");
    expect(text).toContain("age agents guide");
    expect(text).toContain("age agents providers");
    expect(text).toContain("--provider claude  (Claude)");
    expect(text).toContain("sonnet  (Sonnet)");
    expect(text).toContain(String(FLEET_LIMITS.maxLiveWorkers));
    expect(text).toContain(String(FLEET_LIMITS.maxReportSummary));
    expect(text).toContain(String(FLEET_LIMITS.maxAgentsWaitMs / 1000));
    expect(text).toContain("Workers cannot spawn workers");
  });
});
