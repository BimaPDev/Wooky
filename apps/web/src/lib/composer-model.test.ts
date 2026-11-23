import type { ProviderStatus } from "@wooky/contracts";
import { describe, expect, it } from "vitest";
import {
  chipModelName,
  defaultEffortFor,
  effortLabel,
  effortsFor,
  favoriteRows,
  fullModelName,
  modelHasFlag,
  MAX_FAVORITE_MODELS,
  toggleFavoriteModel,
  pickerProviders,
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

  it("returns empty for a missing model id instead of masking it as Default", () => {
    expect(chipModelName(undefined, "")).toBe("");
    expect(chipModelName(claude, "")).toBe("");
    expect(chipModelName(undefined, "   ")).toBe("");
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

const status = (
  kind: ProviderStatus["kind"],
  fields: Partial<ProviderStatus> = {},
): ProviderStatus => ({
  kind,
  label: kind,
  installed: true,
  authenticated: true,
  version: null,
  problem: null,
  models: [{ id: "m", label: "M" }],
  ...fields,
});

const kinds = (list: ProviderStatus[]) => list.map((entry) => entry.kind);

describe("pickerProviders", () => {
  const none = new Set<ProviderStatus["kind"]>();

  it("keeps only providers that are installed, not signed out, enabled and listing models", () => {
    const list = [
      status("claude"),
      status("codex", { installed: false, problem: "Codex CLI was not found on PATH" }),
      status("cursor", { authenticated: false }),
      status("opencode", { authenticated: null }),
      status("acp", { models: [] }),
    ];
    expect(
      kinds(pickerProviders(list, none, null, { showDemo: false, current: "claude" })),
    ).toEqual(["claude", "opencode"]);
    expect(
      kinds(
        pickerProviders(list, new Set(["opencode"]), null, { showDemo: false, current: "claude" }),
      ),
    ).toEqual(["claude"]);
  });

  it("hides Demo unless it is asked for or nothing else is usable", () => {
    const list = [status("claude"), status("demo")];
    expect(
      kinds(pickerProviders(list, none, null, { showDemo: false, current: "claude" })),
    ).toEqual(["claude"]);
    expect(kinds(pickerProviders(list, none, null, { showDemo: true, current: "claude" }))).toEqual(
      ["claude", "demo"],
    );
    expect(
      kinds(
        pickerProviders([status("claude", { authenticated: false }), status("demo")], none, null, {
          showDemo: false,
          current: "claude",
        }),
      ),
    ).toEqual(["claude", "demo"]);
  });

  it("never hides the provider the thread is on", () => {
    const list = [status("claude"), status("codex", { installed: false })];
    expect(kinds(pickerProviders(list, none, null, { showDemo: false, current: "codex" }))).toEqual(
      ["claude", "codex"],
    );
  });
});

describe("fullModelName", () => {
  it("prefixes Claude's own models and leaves the rest", () => {
    expect(fullModelName("claude", "Opus 5.5", "claude-opus-5-5")).toBe("Claude Opus 5.5");
    expect(fullModelName("claude", "Claude Fable 5.2", "fable")).toBe("Claude Fable 5.2");
    expect(fullModelName("claude", "Default (recommended)", "default")).toBe(
      "Default (recommended)",
    );
    expect(fullModelName("codex", "GPT-5.5 Codex", "gpt")).toBe("GPT-5.5 Codex");
  });
});

describe("modelHasFlag", () => {
  const withFlags: Pick<ProviderStatus, "models"> = {
    models: [
      { id: "default", label: "Default", resolvedModel: "claude-opus-5-5" },
      { id: "claude-opus-5-5", label: "Opus", fastMode: true, ultracode: true },
      { id: "haiku", label: "Haiku" },
    ],
  };
  it("reads the model's own flag or the one its alias maps to", () => {
    expect(modelHasFlag(withFlags, "default", "fastMode")).toBe(true);
    expect(modelHasFlag(withFlags, "claude-opus-5-5", "ultracode")).toBe(true);
    expect(modelHasFlag(withFlags, "haiku", "fastMode")).toBe(false);
    expect(modelHasFlag(undefined, "default", "fastMode")).toBe(false);
  });
});

describe("favourites", () => {
  const a = { provider: "claude", model: "claude-opus-5-5" } as const;
  const b = { provider: "cursor", model: "opus-5.5" } as const;

  it("adds and removes one model without touching the others", () => {
    expect(toggleFavoriteModel([], a)).toEqual([a]);
    expect(toggleFavoriteModel([a], b)).toEqual([a, b]);
    expect(toggleFavoriteModel([a, b], a)).toEqual([b]);
  });

  it("takes no more than the limit", () => {
    const full = Array.from({ length: MAX_FAVORITE_MODELS }, (_, index) => ({
      provider: "claude" as const,
      model: `m${index}`,
    }));
    expect(toggleFavoriteModel(full, a)).toEqual(full);
    expect(toggleFavoriteModel(full, full[0] ?? a)).toHaveLength(MAX_FAVORITE_MODELS - 1);
  });

  it("lists favourites across providers with their own labels, skipping unusable providers", () => {
    const fromClaude = status("claude", { models: [{ id: "claude-opus-5-5", label: "Opus 5.5" }] });
    const fromCursor = status("cursor", {
      models: [{ id: "opus-5.5", label: "Opus 5.5 (thinking)" }],
    });
    const rows = favoriteRows(
      [a, b, { provider: "codex", model: "x" }],
      [fromClaude, fromCursor],
      null,
    );
    expect(rows.map((row) => [row.provider, row.label])).toEqual([
      ["claude", "Claude Opus 5.5"],
      ["cursor", "Opus 5.5 (thinking)"],
    ]);
  });
});
