import { describe, expect, it } from "vitest";
import {
  composerMenuIdentity,
  composerMenuVisible,
  composerTrigger,
  filterSlashCommands,
  insertMentionPath,
  slashPlanModeAllowed,
  type ComposerTrigger,
} from "./composer-trigger.ts";

describe("composerTrigger", () => {
  it("detects @mention at the caret", () => {
    expect(composerTrigger("see @src/foo", 12)?.kind).toBe("mention");
    expect(composerTrigger("see @src/foo", 12)).toMatchObject({
      query: "src/foo",
      replaceStart: 4,
    });
  });

  it("ignores @mention after whitespace in the query", () => {
    expect(composerTrigger("see @src foo", 11)).toBeNull();
  });

  it("detects leading slash commands", () => {
    expect(composerTrigger("/mod", 4)).toMatchObject({
      kind: "slash",
      query: "mod",
      replaceStart: 0,
    });
  });

  it("ignores slash commands not at the start", () => {
    expect(composerTrigger("try /plan", 9)).toBeNull();
  });

  it("prefers mention over slash when both could apply", () => {
    expect(composerTrigger("@x", 2)?.kind).toBe("mention");
  });
});

describe("filterSlashCommands", () => {
  it("filters by id prefix", () => {
    expect(filterSlashCommands("mo").map((c) => c.id)).toEqual(["model"]);
  });
});

describe("insertMentionPath", () => {
  it("replaces the trigger span with a tagged path", () => {
    const trigger: ComposerTrigger = {
      kind: "mention",
      query: "src",
      replaceStart: 4,
      replaceEnd: 8,
    };
    expect(insertMentionPath("see @src", trigger, "src/app.ts")).toEqual({
      text: "see @src/app.ts ",
      caret: 16,
    });
  });
});

describe("composerMenuIdentity", () => {
  it("changes when the mention query changes", () => {
    const a = composerTrigger("@ab", 3);
    const b = composerTrigger("@abc", 4);
    expect(a?.kind).toBe("mention");
    expect(b?.kind).toBe("mention");
    if (a?.kind !== "mention" || b?.kind !== "mention") return;
    expect(composerMenuIdentity(a)).not.toBe(composerMenuIdentity(b));
  });
});

describe("composerMenuVisible", () => {
  it("hides the menu while the dismissed identity matches", () => {
    const slash = composerTrigger("/plan", 5);
    expect(slash?.kind).toBe("slash");
    if (slash?.kind !== "slash") return;
    const id = composerMenuIdentity(slash);
    expect(composerMenuVisible(slash, id)).toBe(false);
  });

  it("shows the menu again after the query changes", () => {
    const slash = composerTrigger("/plan", 5);
    expect(slash?.kind).toBe("slash");
    if (slash?.kind !== "slash") return;
    const dismissed = composerMenuIdentity(slash);
    const narrowed = composerTrigger("/pl", 3);
    expect(narrowed?.kind).toBe("slash");
    if (narrowed?.kind !== "slash") return;
    expect(composerMenuVisible(narrowed, dismissed)).toBe(true);
  });
});

describe("slashPlanModeAllowed", () => {
  it("blocks /plan when the provider lacks plan mode", () => {
    expect(slashPlanModeAllowed(false)).toEqual({
      allowed: false,
      reason: "This provider does not support plan mode",
    });
  });

  it("allows /plan when plan mode is supported", () => {
    expect(slashPlanModeAllowed(true)).toEqual({ allowed: true });
  });
});
