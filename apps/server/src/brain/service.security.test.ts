import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RpcMethods, type ReadModel } from "@wooky/contracts";
import { ServiceError } from "../errors.ts";
import { createAgentTokenService } from "../fleet/agent-token.ts";
import { createBrainService } from "./service.ts";
import { createBrainStore } from "./store.ts";

const dirs: string[] = [];
function dir(label: string): string {
  const path = mkdtempSync(join(tmpdir(), `wooky-brain-sec-${label}-`));
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
  const rootA = dir("proj-a");
  mkdirSync(join(rootA, ".git"));
  const model = {
    projects: { projA: { id: "projA", root: rootA } },
    threads: {
      t1: { id: "t1", projectId: "projA", provider: "claude" },
      t2: { id: "t2", projectId: "projA", provider: "codex" },
    },
  } as unknown as ReadModel;
  let tick = Date.UTC(2026, 0, 1);
  const clock = () => new Date((tick += 1000)).toISOString();
  const tokens = createAgentTokenService();
  const brainStore = createBrainStore({
    home,
    resolveProjectRoot: (id) => model.projects[id]?.root ?? null,
    clock,
  });
  const service = createBrainService({
    home,
    brainStore,
    eventStore: { model },
    tokens,
    clock,
  });
  return {
    home,
    rootA,
    model,
    brainStore,
    service,
    t1: tokens.issue("t1"),
    t2: tokens.issue("t2"),
  };
}

const note = (summary: string, extra: Record<string, unknown> = {}) => ({
  summary,
  kind: "note" as const,
  ...extra,
});

describe("H1: propose downgrades a global write to the inbox", () => {
  it("queues a tokenless global write that asks to propose, and never lands in global", () => {
    const { service, brainStore } = setup();
    const result = service.write({
      uri: "brain://global/prefs/x.md",
      frontmatter: note("From a host that stripped the token"),
      body: "b",
      propose: true,
    });
    expect(result).toMatchObject({ queued: true, created: false });
    expect(codeOf(() => brainStore.read("brain://global/prefs/x.md", 0))).toBe("not_found");
    const [pending] = service.inboxList({});
    expect(pending?.targetUri).toBe("brain://global/prefs/x.md");
    // Approving it later must not make it look user-authored.
    expect(pending?.frontmatter.source?.agent).toBeTruthy();
  });

  it("still writes a tokenless global write directly when it does not ask to propose", () => {
    const { service, brainStore } = setup();
    const result = service.write({
      uri: "brain://global/prefs/y.md",
      frontmatter: note("User write"),
      body: "b",
    });
    expect(result).toMatchObject({ queued: false, created: true });
    expect(brainStore.read("brain://global/prefs/y.md", 0).frontmatter.summary).toBe("User write");
  });

  it("does not change project writes", () => {
    const { service } = setup();
    const result = service.write({
      uri: "brain://project/projA/a.md",
      frontmatter: note("Project note"),
      body: "b",
      propose: true,
    });
    expect(result).toMatchObject({ queued: false, created: true });
  });
});

describe("M2: agents cannot pin, and agent provenance is detectable", () => {
  it("strips pinned from an agent's project write", () => {
    const { service, brainStore, t1 } = setup();
    service.write({
      agentToken: t1,
      uri: "brain://project/projA/p.md",
      frontmatter: note("Pinned by agent", { pinned: true }),
      body: "b",
    });
    expect(brainStore.read("brain://project/projA/p.md", 0).frontmatter.pinned).toBeUndefined();
  });

  it("strips pinned from a proposal and from the approved memory", () => {
    const { service, brainStore, t1 } = setup();
    service.write({
      agentToken: t1,
      uri: "brain://global/prefs/p.md",
      frontmatter: note("Pinned by agent", { pinned: true }),
      body: "b",
    });
    const [pending] = service.inboxList({});
    expect(pending?.frontmatter.pinned).toBeUndefined();
    service.inboxApprove({ id: pending?.id ?? "" });
    const entry = brainStore.read("brain://global/prefs/p.md", 0);
    expect(entry.frontmatter.pinned).toBeUndefined();
    expect(entry.frontmatter.source?.threadId).toBe("t1");
  });

  it("lets the user pin while approving with edits", () => {
    const { service, brainStore, t1 } = setup();
    service.write({
      agentToken: t1,
      uri: "brain://global/prefs/q.md",
      frontmatter: note("Agent text"),
      body: "b",
    });
    const [pending] = service.inboxList({});
    service.inboxApprove({
      id: pending?.id ?? "",
      edits: { frontmatter: note("User text", { pinned: true }), body: "edited" },
    });
    const entry = brainStore.read("brain://global/prefs/q.md", 2);
    expect(entry.frontmatter.pinned).toBe(true);
    expect(entry.body).toBe("edited\n");
    // Provenance survives an edit that does not name a source.
    expect(entry.frontmatter.source?.threadId).toBe("t1");
  });
});

describe("M3: one thread cannot fill the inbox", () => {
  it("caps a thread at 20 pending proposals while another thread still gets in", () => {
    const { service, t1, t2 } = setup();
    for (let i = 0; i < 20; i += 1) {
      service.write({
        agentToken: t1,
        uri: `brain://global/spam/s${i}.md`,
        frontmatter: note(`spam ${i}`),
        body: "x",
      });
    }
    expect(
      codeOf(() =>
        service.write({
          agentToken: t1,
          uri: "brain://global/spam/s20.md",
          frontmatter: note("one too many"),
          body: "x",
        }),
      ),
    ).toBe("conflict");
    const other = service.write({
      agentToken: t2,
      uri: "brain://global/legit.md",
      frontmatter: note("legit"),
      body: "x",
    });
    expect(other.queued).toBe(true);
    expect(service.inboxList({})).toHaveLength(21);
  });

  it("replaces the same thread's earlier proposal for the same target", () => {
    const { service, t1, t2 } = setup();
    const write = (token: string, summary: string) =>
      service.write({
        agentToken: token,
        uri: "brain://global/prefs/same.md",
        frontmatter: note(summary),
        body: summary,
      });
    write(t1, "first");
    write(t1, "second");
    write(t2, "other thread");
    const pending = service.inboxList({});
    expect(pending.map((p) => p.frontmatter.summary).sort()).toEqual(["other thread", "second"]);
  });
});

describe("create-only writes", () => {
  it("returns conflict for expectedUpdatedAt null when the file exists, and creates it otherwise", () => {
    const { service } = setup();
    const uri = "brain://global/prefs/once.md";
    expect(
      service.write({ uri, frontmatter: note("v1"), body: "b", expectedUpdatedAt: null }),
    ).toMatchObject({ created: true });
    expect(
      codeOf(() =>
        service.write({ uri, frontmatter: note("v2"), body: "b", expectedUpdatedAt: null }),
      ),
    ).toBe("conflict");
    // undefined stays unconditional
    expect(service.write({ uri, frontmatter: note("v3"), body: "b" })).toMatchObject({
      created: false,
    });
  });

  it("is accepted by the RPC schema", () => {
    const parsed = RpcMethods["brain.write"].params.safeParse({
      uri: "brain://global/a.md",
      frontmatter: { summary: "s", kind: "note" },
      body: "",
      expectedUpdatedAt: null,
      propose: true,
    });
    expect(parsed.success).toBe(true);
    const data = parsed.success ? parsed.data : null;
    expect(data?.expectedUpdatedAt).toBeNull();
    expect(data?.propose).toBe(true);
  });
});

describe("L3: errors carry no absolute paths", () => {
  it("does not name the project folder when it is missing", () => {
    const { service, rootA } = setup();
    rmSync(rootA, { recursive: true, force: true });
    let message = "";
    try {
      service.list({ uri: "brain://project/projA/" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe("");
    expect(message).not.toContain(rootA);
    expect(message).not.toContain(tmpdir());
  });
});
