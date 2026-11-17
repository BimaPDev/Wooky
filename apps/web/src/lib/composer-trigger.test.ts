import { describe, expect, it } from "vitest";
import {
  composerTrigger,
  filterSlashCommands,
  insertMentionPath,
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
