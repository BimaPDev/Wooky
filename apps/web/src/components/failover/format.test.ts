import type { ProviderStatus } from "@age/contracts";
import { describe, expect, it } from "vitest";
import {
  activeCooldowns,
  clockLabel,
  cooldownFor,
  cooldownRowText,
  failureText,
  limitedUntilLabel,
  moveItem,
  noticeText,
  relativeLabel,
  removeItem,
  switchTargets,
} from "./format.ts";

const fmt = { locale: "en-US", timeZone: "UTC" };
const now = Date.parse("2026-05-01T12:00:00Z");
const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();

const providers: ProviderStatus[] = [
  {
    kind: "claude",
    label: "Claude Code",
    installed: true,
    authenticated: true,
    version: null,
    problem: null,
    models: [{ id: "opus", label: "Opus" }],
  },
  {
    kind: "codex",
    label: "Codex",
    installed: true,
    authenticated: true,
    version: null,
    problem: null,
    models: [
      { id: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
      { id: "gpt-6-luna", label: "GPT-6 Luna" },
    ],
  },
  {
    kind: "cursor",
    label: "Cursor",
    installed: false,
    authenticated: null,
    version: null,
    problem: "missing",
    models: [{ id: "auto", label: "Auto" }],
  },
];

describe("time labels", () => {
  it("shows the time for today and the weekday for another day", () => {
    expect(clockLabel(at(180), now, fmt)).toBe("3:00 PM");
    expect(clockLabel(at(60 * 24 + 180), now, fmt)).toBe("Sat 3:00 PM");
  });

  it("describes the time left", () => {
    expect(relativeLabel(at(-1), now)).toBe("now");
    expect(relativeLabel(at(0.2), now)).toBe("in 1 min");
    expect(relativeLabel(at(42), now)).toBe("in 42 min");
    expect(relativeLabel(at(120), now)).toBe("in 2 h");
    expect(relativeLabel(at(125), now)).toBe("in 2 h 5 min");
    expect(relativeLabel(at(60 * 48), now)).toBe("in 2 days");
  });

  it("labels a limit", () => {
    expect(limitedUntilLabel(at(180), now, fmt)).toBe("Limited until 3:00 PM");
  });
});

describe("cooldowns", () => {
  const cooldowns = {
    claude: { until: at(60), reason: "quota" as const },
    "codex/gpt-6.1-sol": { until: at(30), reason: "rate_limit" as const },
    "codex/gpt-6-luna": { until: at(-5), reason: "rate_limit" as const },
  };

  it("finds a provider-wide or model cooldown and ignores expired ones", () => {
    expect(cooldownFor(cooldowns, { provider: "claude", model: "opus" }, now)?.reason).toBe(
      "quota",
    );
    expect(cooldownFor(cooldowns, { provider: "codex", model: "gpt-6.1-sol" }, now)?.until).toBe(
      at(30),
    );
    expect(cooldownFor(cooldowns, { provider: "codex", model: "gpt-6-luna" }, now)).toBeNull();
  });

  it("lists active cooldowns soonest first with readable labels", () => {
    const rows = activeCooldowns(cooldowns, providers, now);
    expect(rows.map((row) => cooldownRowText(row, now, fmt))).toEqual([
      "Codex · GPT-6.1 Sol — limited until 12:30 PM",
      "Claude — limited until 1:00 PM",
    ]);
  });
});

describe("notices", () => {
  const from = { provider: "claude" as const, model: "opus" };
  const to = { provider: "codex" as const, model: "gpt-6.1-sol" };

  it("formats the switch notice with the reset time", () => {
    const origin = {
      kind: "failover" as const,
      from,
      to,
      failure: { kind: "quota" as const, resetAt: at(180), message: "x" },
      switches: 1,
    };
    expect(noticeText(origin, providers, now, fmt)).toBe(
      "Claude hit its usage limit (resets 3:00 PM). Switched to Codex · GPT-6.1 Sol and retried.",
    );
  });

  it("omits the reset time when the failure has none", () => {
    const origin = {
      kind: "failover" as const,
      from,
      to: { provider: "codex" as const, model: "gpt-6-luna" },
      failure: { kind: "rate_limit" as const, message: "x" },
      switches: 1,
    };
    expect(noticeText(origin, providers, now)).toBe(
      "Claude hit its rate limit. Switched to Codex · GPT-6 Luna and retried.",
    );
  });

  it("formats the restore notice", () => {
    expect(noticeText({ kind: "restore", from: to, to: from }, providers, now)).toBe(
      "Limit reset. Switched back to Claude · Opus.",
    );
  });
});

describe("failure text", () => {
  it("names the provider and the reset time", () => {
    expect(failureText("claude", { kind: "quota", resetAt: at(180), message: "x" }, now, fmt)).toBe(
      "Claude hit its usage limit (resets 3:00 PM).",
    );
    expect(failureText("codex", { kind: "overloaded", message: "x" }, now, fmt)).toBe(
      "Codex is overloaded.",
    );
  });
});

describe("switch targets", () => {
  it("lists ranked targets first, then the rest, skipping unusable providers and the current model", () => {
    const targets = switchTargets(
      [
        { provider: "cursor", model: "auto" },
        { provider: "codex", model: "gpt-6-luna" },
        { provider: "claude", model: "opus" },
      ],
      providers,
      new Set(),
      { provider: "claude", model: "opus" },
    );
    expect(targets).toEqual([
      { provider: "codex", model: "gpt-6-luna" },
      { provider: "codex", model: "gpt-6.1-sol" },
    ]);
  });

  it("skips disabled providers", () => {
    const targets = switchTargets([], providers, new Set(["codex"] as const), {
      provider: "codex",
      model: "gpt-6.1-sol",
    });
    expect(targets).toEqual([{ provider: "claude", model: "opus" }]);
  });
});

describe("list editing", () => {
  it("moves a row and stops at the ends", () => {
    expect(moveItem([1, 2, 3], 1, -1)).toEqual([2, 1, 3]);
    expect(moveItem([1, 2, 3], 1, 1)).toEqual([1, 3, 2]);
    const list = [1, 2, 3];
    expect(moveItem(list, 0, -1)).toBe(list);
    expect(moveItem(list, 2, 1)).toBe(list);
  });

  it("removes a row", () => {
    expect(removeItem([1, 2, 3], 1)).toEqual([1, 3]);
  });
});
