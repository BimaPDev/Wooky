import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
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
    expect(listed[0]).toMatchObject(proposal);
    expect(listed[0]).toMatchObject({ overwrites: false });

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
        frontmatter: {
          summary: `Proposal ${i}`,
          kind: "note",
          source: { threadId: `thread_${i % 10}` },
        },
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

const proposeFrom = (
  inbox: ReturnType<typeof setup>["inbox"],
  target: string,
  threadId: string,
  summary = "Proposal",
  body = "Body",
) =>
  inbox.propose(target, {
    frontmatter: { summary, kind: "note", source: { threadId, agent: "claude" } },
    body,
  });

describe("M1: approve is conditional on the target it was proposed against", () => {
  it("records baseUpdatedAt, null for a new target and the current stamp for an existing one", () => {
    const { store, inbox } = setup();
    const fresh = proposeFrom(inbox, "brain://global/a.md", "t1");
    expect(fresh.baseUpdatedAt).toBeNull();
    const written = store.write("brain://global/b.md", {
      frontmatter: { summary: "Existing", kind: "note" },
      body: "old",
    });
    const over = proposeFrom(inbox, "brain://global/b.md", "t1");
    expect(over.baseUpdatedAt).toBe(written.updatedAt);
  });

  it("conflicts when the target changed after the proposal, and keeps the proposal", () => {
    const { store, inbox } = setup();
    store.write("brain://global/b.md", {
      frontmatter: { summary: "Existing", kind: "note" },
      body: "old",
    });
    const proposal = proposeFrom(inbox, "brain://global/b.md", "t1", "Agent version");
    store.write("brain://global/b.md", {
      frontmatter: { summary: "User edit", kind: "note" },
      body: "newer",
    });
    expect(codeOf(() => inbox.approve(proposal.id))).toBe("conflict");
    expect(store.read("brain://global/b.md", 0).frontmatter.summary).toBe("User edit");
    expect(inbox.list()).toHaveLength(1);
  });

  it("conflicts when the target appeared after the proposal", () => {
    const { store, inbox } = setup();
    const proposal = proposeFrom(inbox, "brain://global/c.md", "t1");
    store.write("brain://global/c.md", {
      frontmatter: { summary: "Appeared", kind: "note" },
      body: "x",
    });
    expect(codeOf(() => inbox.approve(proposal.id))).toBe("conflict");
    expect(store.read("brain://global/c.md", 0).frontmatter.summary).toBe("Appeared");
  });

  it("conflicts on the second approval of two proposals for one target", () => {
    const { store, inbox } = setup();
    const first = proposeFrom(inbox, "brain://global/d.md", "t1", "From t1");
    const second = proposeFrom(inbox, "brain://global/d.md", "t2", "From t2");
    inbox.approve(first.id);
    expect(codeOf(() => inbox.approve(second.id))).toBe("conflict");
    expect(store.read("brain://global/d.md", 0).frontmatter.summary).toBe("From t1");
  });

  it("marks proposals that would overwrite an existing memory, with its summary", () => {
    const { store, inbox } = setup();
    store.write("brain://global/e.md", {
      frontmatter: { summary: "Current summary", kind: "note" },
      body: "x",
    });
    proposeFrom(inbox, "brain://global/e.md", "t1");
    proposeFrom(inbox, "brain://global/f.md", "t1");
    const byTarget = Object.fromEntries(inbox.list().map((item) => [item.targetUri, item]));
    expect(byTarget["brain://global/e.md"]).toMatchObject({
      overwrites: true,
      existingSummary: "Current summary",
    });
    expect(byTarget["brain://global/f.md"]).toMatchObject({ overwrites: false });
    expect(byTarget["brain://global/f.md"]?.existingSummary).toBeUndefined();
  });
});

describe("M1: approve with edits is one atomic step", () => {
  it("writes the edited memory as active and deletes the proposal", () => {
    const { store, inbox } = setup();
    const proposal = proposeFrom(inbox, "brain://global/g.md", "t1", "Agent summary", "agent body");
    const result = inbox.approve(proposal.id, {
      frontmatter: { summary: "Edited summary", kind: "lesson", tags: ["x"], pinned: true },
      body: "edited body",
    });
    expect(result).toMatchObject({ id: proposal.id, created: true });
    const entry = store.read("brain://global/g.md", 2);
    expect(entry.frontmatter).toMatchObject({
      summary: "Edited summary",
      kind: "lesson",
      status: "active",
      pinned: true,
      source: { threadId: "t1" },
    });
    expect(entry.body).toBe("edited body\n");
    expect(inbox.list()).toEqual([]);
  });

  it("validates the edits and leaves the proposal and the target untouched on failure", () => {
    const { store, inbox } = setup();
    const proposal = proposeFrom(inbox, "brain://global/h.md", "t1");
    const secret = ["ghp_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join("");
    expect(
      codeOf(() =>
        inbox.approve(proposal.id, {
          frontmatter: { summary: "ok", kind: "note" },
          body: `token ${secret}`,
        }),
      ),
    ).toBe("bad_request");
    expect(
      codeOf(() =>
        inbox.approve(proposal.id, {
          frontmatter: { summary: "ok", kind: "note", surprise: 1 },
          body: "x",
        }),
      ),
    ).toBe("bad_request");
    expect(codeOf(() => store.read("brain://global/h.md", 0))).toBe("not_found");
    expect(inbox.list()).toHaveLength(1);
  });

  it("applies the same expectedUpdatedAt condition to edits", () => {
    const { store, inbox } = setup();
    const proposal = proposeFrom(inbox, "brain://global/i.md", "t1");
    store.write("brain://global/i.md", {
      frontmatter: { summary: "Appeared", kind: "note" },
      body: "x",
    });
    expect(
      codeOf(() =>
        inbox.approve(proposal.id, {
          frontmatter: { summary: "Edited", kind: "note" },
          body: "y",
        }),
      ),
    ).toBe("conflict");
    expect(store.read("brain://global/i.md", 0).frontmatter.summary).toBe("Appeared");
    expect(inbox.list()).toHaveLength(1);
  });
});

describe("M3: per-thread cap and replacement", () => {
  it("caps one thread at 20 pending proposals and leaves room for another thread", () => {
    const { inbox } = setup();
    for (let i = 0; i < 20; i += 1) proposeFrom(inbox, `brain://global/s/s${i}.md`, "t1");
    expect(codeOf(() => proposeFrom(inbox, "brain://global/s/s20.md", "t1"))).toBe("conflict");
    expect(() => proposeFrom(inbox, "brain://global/s/other.md", "t2")).not.toThrow();
    expect(inbox.list()).toHaveLength(21);
  });

  it("replaces a thread's earlier proposal for the same target instead of adding one", () => {
    const { inbox } = setup();
    for (let i = 0; i < 25; i += 1) {
      proposeFrom(inbox, "brain://global/same.md", "t1", `Version ${i}`);
    }
    const pending = inbox.list();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.frontmatter.summary).toBe("Version 24");
  });

  it("strips pinned from a proposal", () => {
    const { inbox } = setup();
    const proposal = inbox.propose("brain://global/pin.md", {
      frontmatter: { summary: "Pin me", kind: "note", pinned: true },
      body: "x",
    });
    expect(proposal.frontmatter.pinned).toBeUndefined();
  });
});

describe("L4: approve never applies twice", () => {
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "returns the first result and does not re-apply when the unlink fails",
    () => {
      const { home, store, inbox } = setup();
      const proposal = proposeFrom(inbox, "brain://global/j.md", "t1", "Agent", "agent body");
      const inboxDir = join(home, "brain", "inbox");
      chmodSync(inboxDir, 0o500);
      try {
        const first = inbox.approve(proposal.id);
        expect(first).toMatchObject({ id: proposal.id, created: true });
        // The user edits the memory, then approves again by mistake.
        chmodSync(inboxDir, 0o700);
        store.write("brain://global/j.md", {
          frontmatter: { summary: "User rewrite", kind: "note" },
          body: "mine",
        });
        chmodSync(inboxDir, 0o500);
        expect(() => inbox.approve(proposal.id)).not.toThrow();
        expect(store.read("brain://global/j.md", 2).body).toBe("mine\n");
        expect(inbox.list()).toEqual([]);
      } finally {
        chmodSync(inboxDir, 0o700);
      }
    },
  );
});
