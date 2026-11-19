import type { ProviderStatus, Turn } from "@age/contracts";
import { describe, expect, it } from "vitest";
import {
  activeCooldowns,
  clockLabel,
  cooldownFor,
  cooldownRowText,
  failoverNoticeFor,
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

const turn = (fields: Partial<Turn> & Pick<Turn, "id">): Turn => ({
  threadId: "t",
  prompt: "do it",
  provider: "claude",
  model: "opus",
  status: "completed",
  items: [],
  startedAt: at(0),
  endedAt: at(1),
  checkpointBefore: null,
  checkpointAfter: null,
  changedFiles: [],
  usage: null,
  error: null,
  ...fields,
});

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
  it("formats the switch notice with the reset time", () => {
    const text = noticeText(
      {
        kind: "failedOver",
        from: { provider: "claude", model: "opus" },
        to: { provider: "codex", model: "gpt-6.1-sol" },
        reason: "quota",
        resetAt: at(180),
      },
      providers,
      now,
      fmt,
    );
    expect(text).toBe(
      "Claude hit its usage limit (resets 3:00 PM). Switched to Codex · GPT-6.1 Sol and retried.",
    );
  });

  it("falls back to generic copy when the reason is unknown", () => {
    const text = noticeText(
      {
        kind: "failedOver",
        from: { provider: "claude", model: "opus" },
        to: { provider: "codex", model: "gpt-6-luna" },
        reason: null,
        resetAt: null,
      },
      providers,
      now,
    );
    expect(text).toBe("Claude hit a limit. Switched to Codex · GPT-6 Luna and retried.");
  });

  it("formats the restore notice", () => {
    expect(
      noticeText({ kind: "restored", to: { provider: "claude", model: "opus" } }, providers, now),
    ).toBe("Limit reset. Switched back to Claude · Opus.");
  });

  const failed = turn({ id: "a", status: "failed" });
  const retry = turn({ id: "b", provider: "codex", model: "gpt-6.1-sol", startedAt: at(2) });
  const next = turn({ id: "c", prompt: "next" });

  it("detects a retry on another target after a failed turn", () => {
    expect(failoverNoticeFor(undefined, failed, retry)).toEqual({
      kind: "failedOver",
      from: { provider: "claude", model: "opus" },
      to: { provider: "codex", model: "gpt-6.1-sol" },
      reason: null,
      resetAt: null,
    });
  });

  it("takes the reason and reset time from the failed turn", () => {
    const withFailure = turn({
      id: "a",
      status: "failed",
      failure: { kind: "quota", resetAt: at(180), message: "limit" },
    });
    expect(failoverNoticeFor(undefined, withFailure, retry)).toMatchObject({
      reason: "quota",
      resetAt: at(180),
    });
  });

  it("ignores turns that are not a retry", () => {
    expect(failoverNoticeFor(undefined, turn({ id: "x" }), retry)).toBeNull();
    expect(failoverNoticeFor(undefined, undefined, failed)).toBeNull();
    expect(
      failoverNoticeFor(undefined, failed, turn({ id: "same", status: "completed" })),
    ).toBeNull();
  });

  it("detects a return to the first model after a retry", () => {
    expect(failoverNoticeFor(failed, retry, next)).toEqual({
      kind: "restored",
      to: { provider: "claude", model: "opus" },
    });
    expect(
      failoverNoticeFor(
        failed,
        retry,
        turn({ id: "d", prompt: "next", provider: "codex", model: "gpt-6-luna" }),
      ),
    ).toBeNull();
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
