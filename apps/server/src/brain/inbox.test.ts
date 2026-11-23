import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BRAIN_BODY_MAX_BYTES, BRAIN_INBOX_MAX } from "@wooky/contracts";
import { ServiceError } from "../errors.ts";
import { createBrainInbox } from "./inbox.ts";
import { createBrainStore } from "./store.ts";

const dirs: string[] = [];
function dir(label: string): string {
  const path = mkdtempSync(join(tmpdir(), `wooky-brain-inbox-${label}-`));
  dirs.push(path);
  return path;
}

afterEach(() => {
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof ServiceError) return error.code;
    throw error;
  }
  return "none";
}

function setup() {
  const home = dir("home");
  let tick = Date.UTC(2026, 0, 1);
  let seq = 0;
  const clock = () => new Date((tick += 1000)).toISOString();
  const store = createBrainStore({
    home,
    resolveProjectRoot: () => null,
    clock,
  });
  const inbox = createBrainInbox({
    home,
    store,
    clock,
    newId: () => `prop_${++seq}`,
  });
  return { home, store, inbox };
}

describe("brain inbox", () => {
  it("lists empty without creating the inbox directory", () => {
    const { home, inbox } = setup();
    expect(inbox.list()).toEqual([]);
    expect(existsSync(join(home, "brain", "inbox"))).toBe(false);
  });

  it("proposes, lists, approves to global as active, and deletes the proposal", () => {
    const { home, store, inbox } = setup();
    const proposal = inbox.propose("brain://global/lessons/pnpm.md", {
      frontmatter: {
        summary: "Always use pnpm",
        kind: "lesson",
        tags: ["tooling"],
        status: "active",
        source: { threadId: "t1", agent: "claude", at: "2026-01-01T00:00:00.000Z" },
      },
      body: "Use pnpm instead of npm.",
    });

    expect(proposal.id).toBe("prop_1");
    expect(proposal.targetUri).toBe("brain://global/lessons/pnpm.md");
    expect(proposal.frontmatter.status).toBe("proposed");
    expect(existsSync(join(home, "brain", "inbox", "prop_1.json"))).toBe(true);
    expect(codeOf(() => store.read("brain://global/lessons/pnpm.md", 2))).toBe("not_found");

    const listed = inbox.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual(proposal);

    const approved = inbox.approve(proposal.id);
    expect(approved).toMatchObject({
      id: "prop_1",
      uri: "brain://global/lessons/pnpm.md",
      created: true,
    });
    expect(inbox.list()).toEqual([]);
    expect(existsSync(join(home, "brain", "inbox", "prop_1.json"))).toBe(false);

    const entry = store.read("brain://global/lessons/pnpm.md", 2);
    expect(entry.frontmatter).toMatchObject({
      summary: "Always use pnpm",
      kind: "lesson",
      tags: ["tooling"],
      status: "active",
      source: { threadId: "t1", agent: "claude", at: "2026-01-01T00:00:00.000Z" },
    });
    expect(entry.body).toBe("Use pnpm instead of npm.\n");
  });

  it("rejects a proposal, deletes the file, and returns not_found for missing ids", () => {
    const { store, inbox } = setup();
    const proposal = inbox.propose("brain://global/notes/skip.md", {
      frontmatter: { summary: "Skip this", kind: "note" },
      body: "Not needed.",
    });
    expect(inbox.reject(proposal.id)).toEqual({ id: proposal.id, ok: true });
    expect(inbox.list()).toEqual([]);
    expect(codeOf(() => store.read("brain://global/notes/skip.md", 0))).toBe("not_found");
    expect(codeOf(() => inbox.reject(proposal.id))).toBe("not_found");
    expect(codeOf(() => inbox.approve("prop_missing"))).toBe("not_found");
  });

  it("caps the inbox at 200 proposals and returns conflict when full", () => {
    const { inbox } = setup();
    for (let i = 0; i < BRAIN_INBOX_MAX; i += 1) {
      inbox.propose(`brain://global/notes/m${i}.md`, {
        frontmatter: { summary: `Proposal ${i}`, kind: "note" },
        body: `Body ${i}`,
      });
    }
    expect(inbox.list()).toHaveLength(BRAIN_INBOX_MAX);
    expect(
      codeOf(() =>
        inbox.propose("brain://global/notes/overflow.md", {
          frontmatter: { summary: "Overflow", kind: "note" },
          body: "Too many",
        }),
      ),
    ).toBe("conflict");

    inbox.reject("prop_1");
    const next = inbox.propose("brain://global/notes/after-reject.md", {
      frontmatter: { summary: "Room again", kind: "note" },
      body: "Fits now",
    });
    expect(next.targetUri).toBe("brain://global/notes/after-reject.md");
  });

  it("reuses store path, size, frontmatter and secret validation", () => {
    const { inbox } = setup();
    const secret = ["ghp_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join("");

    expect(
      codeOf(() =>
        inbox.propose("brain://project/p1/a.md", {
          frontmatter: { summary: "Wrong scope", kind: "note" },
          body: "",
        }),
      ),
    ).toBe("bad_request");

    expect(
      codeOf(() =>
        inbox.propose("brain://global/folder-only", {
          frontmatter: { summary: "Not a memory", kind: "note" },
          body: "",
        }),
      ),
    ).toBe("bad_request");

    expect(
      codeOf(() =>
        inbox.propose("brain://global/../escape.md", {
          frontmatter: { summary: "Traversal", kind: "note" },
          body: "",
        }),
      ),
    ).toBe("bad_request");

    expect(
      codeOf(() =>
        inbox.propose("brain://global/big.md", {
          frontmatter: { summary: "Too big", kind: "note" },
          body: "x".repeat(BRAIN_BODY_MAX_BYTES + 10),
        }),
      ),
    ).toBe("bad_request");

    let secretError = "";
    try {
      inbox.propose("brain://global/secret.md", {
        frontmatter: { summary: "Leaked", kind: "note" },
        body: `token ${secret}`,
      });
    } catch (error) {
      secretError = (error as Error).message;
    }
    expect(secretError).toMatch(/credential/);
    expect(secretError).not.toContain(secret);

    expect(codeOf(() => inbox.approve("../global/secret"))).toBe("bad_request");
    expect(codeOf(() => inbox.reject("../global/secret"))).toBe("bad_request");
    expect(inbox.list()).toEqual([]);
  });
});
