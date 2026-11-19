import type { ProviderStatus } from "@age/contracts";
import { describe, expect, it } from "vitest";
import {
  chipModelName,
  defaultEffortFor,
  effortLabel,
  effortsFor,
  shortModelName,
  shownEffort,
} from "./composer-model.ts";

const claude: Pick<ProviderStatus, "models"> = {
  models: [
    {
      id: "default",
      label: "Default (recommended)",
      resolvedModel: "claude-opus-5-5",
      efforts: ["low", "medium", "high", "max"],
    },
    { id: "sonnet", label: "Sonnet", efforts: ["low", "medium", "high"] },
    { id: "haiku", label: "Haiku" },
    { id: "claude-opus-5-5", label: "Opus 5.5", efforts: ["low", "medium", "high", "max"] },
  ],
};
const bare: Pick<ProviderStatus, "models"> = { models: [{ id: "default", label: "Default" }] };

describe("shortModelName", () => {
  it("joins version digits and drops the vendor prefix and date stamp", () => {
    expect(shortModelName("claude-opus-5-5")).toBe("Opus 5.5");
    expect(shortModelName("claude-sonnet-5-5-20260101")).toBe("Sonnet 5.5");
    expect(shortModelName("opus")).toBe("Opus");
    expect(shortModelName("opus[1m]")).toBe("Opus 1M");
    expect(shortModelName("gpt-5.5-codex")).toBe("GPT 5.5 Codex");
    expect(shortModelName("anthropic/claude-opus-4-8")).toBe("Opus 4.8");
  });
});

describe("chipModelName", () => {
  it("shows the model an alias maps to when the status says so", () => {
    expect(chipModelName(claude, "default")).toBe("Opus 5.5");
  });

  it("shows Default when it maps to nothing the status can name", () => {
    expect(chipModelName(bare, "default")).toBe("Default");
    expect(chipModelName(undefined, "default")).toBe("Default");
  });

  it("names plain aliases and explicit ids", () => {
    expect(chipModelName(claude, "sonnet")).toBe("Sonnet");
    expect(chipModelName(claude, "claude-opus-5-5")).toBe("Opus 5.5");
  });

  it("prefers a short provider label over the raw id", () => {
    const codex = { models: [{ id: "gpt-5.5-codex", label: "GPT-5.5 Codex" }] };
    expect(chipModelName(codex, "gpt-5.5-codex")).toBe("GPT-5.5 Codex");
  });
});

describe("effort", () => {
  it("lists the levels the model, or the model its alias maps to, accepts", () => {
    expect(effortsFor(claude, "sonnet")).toEqual(["low", "medium", "high"]);
    expect(effortsFor(claude, "default")).toEqual(["low", "medium", "high", "max"]);
    expect(effortsFor(claude, "haiku")).toEqual([]);
  });

  it("defaults to medium for Opus 5.5 only", () => {
    expect(defaultEffortFor(claude, "default")).toBe("medium");
    expect(defaultEffortFor(claude, "claude-opus-5-5")).toBe("medium");
    expect(defaultEffortFor(claude, "sonnet")).toBeUndefined();
    expect(defaultEffortFor(claude, "haiku")).toBeUndefined();
  });

  it("shows the pick only when the model accepts it", () => {
    expect(shownEffort(claude, "default", "max")).toBe("max");
    expect(shownEffort(claude, "default", undefined)).toBe("medium");
    expect(shownEffort(claude, "sonnet", "max")).toBeUndefined();
    expect(shownEffort(claude, "haiku", "high")).toBeUndefined();
  });

  it("labels the levels", () => {
    expect(effortLabel("xhigh")).toBe("Extra high");
    expect(effortLabel("medium")).toBe("Medium");
  });
});
