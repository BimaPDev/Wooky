import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileInbox, INBOX_MAX_PROPOSALS } from "./extract-inbox.ts";

const dirs: string[] = [];
const home = () => {
  const path = mkdtempSync(join(tmpdir(), "wooky-inbox-"));
  dirs.push(path);
  return path;
};
afterEach(() => {
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

const memory = (summary = "Prefer small commits") => ({
  frontmatter: { summary, kind: "preference" as const, status: "proposed" as const },
  body: "Body",
});

describe("file inbox", () => {
  it("stores a proposal at its target path and lists its summary", () => {
    const base = home();
    const inbox = createFileInbox({ home: base, clock: () => "2026-11-23T10:00:00.000Z" });
    inbox.submit("brain://global/preferences/commits.md", memory());
    const raw = readFileSync(join(base, "brain", "inbox", "preferences", "commits.md"), "utf8");
    expect(raw).toContain('status: "proposed"');
    expect(raw).toContain('updatedAt: "2026-11-23T10:00:00.000Z"');
    expect(inbox.summaries()).toEqual(["Prefer small commits"]);
    expect(existsSync(join(base, "brain", "global"))).toBe(false);
  });

  it("refuses an overwrite, a project URI, a non-proposed status and a secret", () => {
    const inbox = createFileInbox({ home: home() });
    inbox.submit("brain://global/a.md", memory());
    expect(() => inbox.submit("brain://global/a.md", memory("Other"))).toThrow(/already waiting/);
    expect(() => inbox.submit("brain://project/p1/a.md", memory())).toThrow(/brain:\/\/global/);
    expect(() =>
      inbox.submit("brain://global/b.md", {
        ...memory(),
        frontmatter: { ...memory().frontmatter, status: "active" },
      }),
    ).toThrow(/proposed/);
    const token = ["ghp_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join("");
    expect(() => inbox.submit("brain://global/c.md", { ...memory(), body: token })).toThrow(
      /credential/,
    );
  });

  it("is capped", () => {
    const inbox = createFileInbox({ home: home() });
    for (let n = 0; n < INBOX_MAX_PROPOSALS; n += 1) {
      inbox.submit(`brain://global/n/p${n}.md`, memory(`Proposal ${n}`));
    }
    expect(() => inbox.submit("brain://global/n/extra.md", memory())).toThrow(/full/);
  });

  it("will not write through a symbolic link", () => {
    const base = home();
    const outside = home();
    mkdirSync(join(base, "brain"));
    try {
      symlinkSync(outside, join(base, "brain", "inbox"), "dir");
    } catch {
      return;
    }
    const inbox = createFileInbox({ home: base });
    expect(() => inbox.submit("brain://global/a.md", memory())).toThrow(/symbolic link/);
    expect(existsSync(join(outside, "a.md"))).toBe(false);
  });
});
