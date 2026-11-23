import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { RpcResponse, WOOKY_WS_PATH, type RpcError } from "@wooky/contracts";
import { createAgentTokenService } from "../fleet/agent-token.ts";
import { createDemoAdapter } from "../providers/demo/adapter.ts";
import { startServer, type RunningServer } from "../server.ts";
import { tempDir } from "../testing.ts";

const cleanups: (() => Promise<void>)[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const fn of cleanups.splice(0)) await fn();
});

function expectOk<T = unknown>(res: RpcResponse, label?: string): T {
  if (!res.ok) throw new Error(label ?? `Expected ok, got ${res.error.code}: ${res.error.message}`);
  return res.result as T;
}

function expectErr(res: RpcResponse, label?: string): RpcError {
  if (res.ok) throw new Error(label ?? `Expected error, got ok: ${JSON.stringify(res.result)}`);
  return res.error;
}

async function connect(server: RunningServer) {
  const ws = new WebSocket(`${server.url.replace("http", "ws")}${WOOKY_WS_PATH}`);
  sockets.push(ws);
  const pending = new Map<number, (response: RpcResponse) => void>();
  ws.on("message", (data) => {
    const raw: unknown = JSON.parse(String(data));
    if (typeof raw === "object" && raw !== null && "push" in raw) return;
    const response = RpcResponse.parse(raw);
    pending.get(response.id)?.(response);
  });
  await new Promise((resolve, reject) => ws.once("open", resolve).once("error", reject));
  let nextId = 0;
  return {
    call(method: string, params: unknown = {}): Promise<RpcResponse> {
      const id = ++nextId;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
  };
}

async function boot() {
  const home = await tempDir("brain-rpc-home");
  const rootA = await tempDir("brain-rpc-proj-a");
  const rootB = await tempDir("brain-rpc-proj-b");
  await mkdir(join(rootA, ".git"));
  await mkdir(join(rootB, ".git"));
  const agentTokens = createAgentTokenService();
  const server = await startServer({
    home,
    port: 0,
    host: "127.0.0.1",
    adapters: [createDemoAdapter({ stepMs: 0 })],
    agentTokens,
  });
  cleanups.push(async () => {
    await server.close();
    await rm(home, { recursive: true, force: true });
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
  });
  const client = await connect(server);

  await client.call("dispatch", {
    commandId: randomUUID(),
    type: "project.add",
    root: rootA,
    name: "proj-a",
  });
  await client.call("dispatch", {
    commandId: randomUUID(),
    type: "project.add",
    root: rootB,
    name: "proj-b",
  });
  const snap = expectOk<{ projects: Record<string, { id: string; root: string }> }>(
    await client.call("snapshot"),
  );
  const projects = Object.values(snap.projects);
  const projectA = projects.find((p) => p.root === rootA)?.id ?? "";
  const projectB = projects.find((p) => p.root === rootB)?.id ?? "";

  await client.call("dispatch", {
    commandId: randomUUID(),
    type: "thread.create",
    projectId: projectA,
    provider: "demo",
    model: "demo",
    runtimeMode: "approve",
    isolate: false,
  });
  const snap2 = expectOk<{ threads: Record<string, { id: string; projectId: string }> }>(
    await client.call("snapshot"),
  );
  const threadA = Object.values(snap2.threads).find((t) => t.projectId === projectA)?.id ?? "";
  const tokenA = agentTokens.issue(threadA);

  return { server, client, home, rootA, rootB, projectA, projectB, threadA, tokenA };
}

describe("brain RPC round-trips and permissions", () => {
  it("supports full user round-trips across list, read, write, search, archive, remove, and reindex", async () => {
    const { client, projectA } = await boot();

    const gUri = "brain://global/prefs/pnpm.md";
    const pUri = `brain://project/${projectA}/decisions/db.md`;

    const gw = expectOk<{ uri: string; updatedAt: string; created: boolean; queued: boolean }>(
      await client.call("brain.write", {
        uri: gUri,
        frontmatter: { summary: "Use pnpm everywhere", kind: "preference", tags: ["tooling"] },
        body: "Prefer pnpm over npm.",
      }),
    );
    expect(gw).toMatchObject({ uri: gUri, created: true, queued: false });

    const gRead = expectOk(await client.call("brain.read", { uri: gUri, tier: 2 }));
    expect(gRead).toMatchObject({
      uri: gUri,
      trust: "user",
      tier: 2,
      frontmatter: { summary: "Use pnpm everywhere", kind: "preference", status: "active" },
      body: "Prefer pnpm over npm.\n",
    });

    const stale = expectErr(
      await client.call("brain.write", {
        uri: gUri,
        frontmatter: { summary: "Stale update", kind: "preference" },
        body: "nope",
        expectedUpdatedAt: "2020-01-01T00:00:00.000Z",
      }),
    );
    expect(stale.code).toBe("conflict");

    expectOk(
      await client.call("brain.write", {
        uri: gUri,
        frontmatter: { summary: "Use pnpm everywhere", kind: "preference", tags: ["tooling"] },
        body: "Prefer pnpm 10.",
        expectedUpdatedAt: gw.updatedAt,
      }),
    );

    expectOk(
      await client.call("brain.write", {
        uri: pUri,
        frontmatter: { summary: "Use SQLite for event store", kind: "decision", tags: ["db"] },
        body: "SQLite keeps everything local.",
      }),
    );

    const listed = expectOk(
      await client.call("brain.list", { uri: `brain://project/${projectA}/` }),
    );
    expect(listed).toEqual([
      expect.objectContaining({ name: "decisions", type: "folder", count: 1, trust: "repo" }),
    ]);

    const searched = expectOk(
      await client.call("brain.search", {
        query: "SQLite",
        scopes: [{ kind: "global" }, { kind: "project", projectId: projectA }],
      }),
    );
    expect(searched).toEqual([
      expect.objectContaining({ uri: pUri, trust: "repo", summary: "Use SQLite for event store" }),
    ]);

    const reindexed = expectOk(await client.call("brain.reindex", {}));
    expect(reindexed).toMatchObject({ scopes: 3 });

    expectOk(await client.call("brain.archive", { uri: pUri }));
    expect(
      expectOk(await client.call("brain.list", { uri: `brain://project/${projectA}/decisions` })),
    ).toEqual([]);

    expect(expectOk(await client.call("brain.remove", { uri: pUri }))).toEqual({ ok: true });
    expect(expectErr(await client.call("brain.read", { uri: pUri, tier: 0 })).code).toBe(
      "not_found",
    );
  });

  it("enforces agent-token scoping, stamps source, and routes global writes to the inbox", async () => {
    const { client, projectA, projectB, threadA, tokenA } = await boot();

    // Seed global + projectB memories as the user
    expectOk(
      await client.call("brain.write", {
        uri: "brain://global/shared.md",
        frontmatter: { summary: "Global shared rule", kind: "convention" },
        body: "Visible to all agents.",
      }),
    );
    expectOk(
      await client.call("brain.write", {
        uri: `brain://project/${projectB}/secret.md`,
        frontmatter: { summary: "Project B architecture", kind: "note" },
        body: "Confidential to project B.",
      }),
    );

    // Agent can read and list global and its own project
    expectOk(
      await client.call("brain.read", {
        uri: "brain://global/shared.md",
        tier: 2,
        agentToken: tokenA,
      }),
    );
    expectOk(
      await client.call("brain.list", {
        uri: `brain://project/${projectA}/`,
        agentToken: tokenA,
      }),
    );

    // Agent is forbidden from cross-project operations, global mutations, reindex, and inbox management
    for (const [method, params] of [
      ["brain.list", { uri: `brain://project/${projectB}/`, agentToken: tokenA }],
      ["brain.read", { uri: `brain://project/${projectB}/secret.md`, tier: 2, agentToken: tokenA }],
      [
        "brain.search",
        {
          query: "Confidential",
          scopes: [{ kind: "global" }, { kind: "project", projectId: projectB }],
          agentToken: tokenA,
        },
      ],
      [
        "brain.write",
        {
          uri: `brain://project/${projectB}/pwn.md`,
          frontmatter: { summary: "Cross-project write", kind: "note" },
          body: "nope",
          agentToken: tokenA,
        },
      ],
      ["brain.archive", { uri: `brain://project/${projectB}/secret.md`, agentToken: tokenA }],
      ["brain.remove", { uri: `brain://project/${projectB}/secret.md`, agentToken: tokenA }],
      ["brain.archive", { uri: "brain://global/shared.md", agentToken: tokenA }],
      ["brain.remove", { uri: "brain://global/shared.md", agentToken: tokenA }],
      ["brain.reindex", { agentToken: tokenA }],
      ["brain.inbox.list", { agentToken: tokenA }],
      ["brain.inbox.approve", { id: "prop_1", agentToken: tokenA }],
      ["brain.inbox.reject", { id: "prop_1", agentToken: tokenA }],
    ] as const) {
      const err = expectErr(await client.call(method, params), `${method} should be forbidden`);
      expect(err.code).toBe("forbidden");
    }

    // Invalid / forged agent token is forbidden
    const badTokenErr = expectErr(
      await client.call("brain.list", {
        uri: "brain://global/",
        agentToken: `${tokenA}tampered`,
      }),
    );
    expect(badTokenErr.code).toBe("forbidden");

    // Agent writes to its OWN project -> saved directly, forged source is overwritten
    const ownUri = `brain://project/${projectA}/notes/conventions.md`;
    const ownWrite = expectOk(
      await client.call("brain.write", {
        uri: ownUri,
        frontmatter: {
          summary: "Own project convention",
          kind: "convention",
          source: {
            threadId: "forged_thread",
            agent: "forged_agent",
            at: "2000-01-01T00:00:00.000Z",
          },
        },
        body: "Always write tests.",
        agentToken: tokenA,
      }),
    );
    expect(ownWrite).toMatchObject({ uri: ownUri, created: true, queued: false });

    const ownRead = expectOk<{
      frontmatter: { source?: { threadId?: string; agent?: string; at?: string } };
    }>(await client.call("brain.read", { uri: ownUri, tier: 2, agentToken: tokenA }));
    expect(ownRead.frontmatter.source?.threadId).toBe(threadA);
    expect(ownRead.frontmatter.source?.agent).toBe("demo");
    expect(ownRead.frontmatter.source?.at).not.toBe("2000-01-01T00:00:00.000Z");

    // Agent can search global + own project
    const ownSearch = expectOk<{ uri: string }[]>(
      await client.call("brain.search", {
        query: "convention",
        scopes: [{ kind: "global" }, { kind: "project", projectId: projectA }],
        agentToken: tokenA,
      }),
    );
    expect(ownSearch.map((hit) => hit.uri)).toContain(ownUri);

    // Agent can archive and remove in its OWN project
    expectOk(await client.call("brain.archive", { uri: ownUri, agentToken: tokenA }));
    expectOk(await client.call("brain.remove", { uri: ownUri, agentToken: tokenA }));

    // Agent writes to GLOBAL -> queued in inbox with status: proposed & stamped source
    const proposedUri = "brain://global/lessons/agent-tip.md";
    const globalProposal = expectOk<{ proposalId: string }>(
      await client.call("brain.write", {
        uri: proposedUri,
        frontmatter: {
          summary: "Tip proposed by agent",
          kind: "lesson",
          source: { threadId: "spoofed", agent: "spoofed" },
        },
        body: "Check boundaries before committing.",
        agentToken: tokenA,
      }),
    );
    expect(globalProposal).toMatchObject({
      uri: proposedUri,
      created: false,
      queued: true,
      message: expect.stringMatching(/approval/i),
    });
    const proposalId = globalProposal.proposalId;
    expect(proposalId).toBeTruthy();

    // Not yet saved to global
    expect(expectErr(await client.call("brain.read", { uri: proposedUri, tier: 2 })).code).toBe(
      "not_found",
    );

    // User lists inbox, sees stamped source and status: proposed
    const proposals = expectOk<
      {
        id: string;
        targetUri: string;
        frontmatter: { status: string; source?: { threadId?: string; agent?: string } };
      }[]
    >(await client.call("brain.inbox.list", {}));
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      id: proposalId,
      targetUri: proposedUri,
      frontmatter: {
        status: "proposed",
        source: { threadId: threadA, agent: "demo" },
      },
    });

    // User approves -> written to global as active and removed from inbox
    expectOk(await client.call("brain.inbox.approve", { id: proposalId }));
    const afterApprove = expectOk(await client.call("brain.read", { uri: proposedUri, tier: 2 }));
    expect(afterApprove).toMatchObject({
      uri: proposedUri,
      frontmatter: {
        summary: "Tip proposed by agent",
        status: "active",
        source: { threadId: threadA, agent: "demo" },
      },
    });
    expect(expectOk(await client.call("brain.inbox.list", {}))).toEqual([]);

    // User rejects a second proposal -> deleted and never saved to global
    const secondUri = "brain://global/lessons/rejected-tip.md";
    const secondProp = expectOk<{ proposalId: string }>(
      await client.call("brain.write", {
        uri: secondUri,
        frontmatter: { summary: "Reject me", kind: "lesson" },
        body: "Do not keep.",
        agentToken: tokenA,
      }),
    );
    expect(
      expectOk(await client.call("brain.inbox.reject", { id: secondProp.proposalId })),
    ).toEqual({ id: secondProp.proposalId, ok: true });
    expect(expectErr(await client.call("brain.read", { uri: secondUri, tier: 0 })).code).toBe(
      "not_found",
    );
  });

  it("create-only and propose work over RPC, and approve takes edits", async () => {
    const { client } = await boot();
    const uri = "brain://global/prefs/rpc-once.md";
    const fm = { summary: "Once", kind: "note" };

    expectOk(
      await client.call("brain.write", {
        uri,
        frontmatter: fm,
        body: "a",
        expectedUpdatedAt: null,
      }),
    );
    expect(
      expectErr(
        await client.call("brain.write", {
          uri,
          frontmatter: fm,
          body: "b",
          expectedUpdatedAt: null,
        }),
      ).code,
    ).toBe("conflict");

    const queued = expectOk<{ queued: boolean; proposalId: string }>(
      await client.call("brain.write", {
        uri,
        frontmatter: { summary: "Proposed over it", kind: "note" },
        body: "c",
        propose: true,
      }),
    );
    expect(queued.queued).toBe(true);
    const [item] = expectOk<{ id: string; overwrites: boolean; existingSummary?: string }[]>(
      await client.call("brain.inbox.list", {}),
    );
    expect(item).toMatchObject({
      id: queued.proposalId,
      overwrites: true,
      existingSummary: "Once",
    });

    // The target is unchanged since the proposal, so an edited approval lands.
    expectOk(
      await client.call("brain.inbox.approve", {
        id: queued.proposalId,
        edits: { frontmatter: { summary: "Edited", kind: "note" }, body: "edited" },
      }),
    );
    expect(
      expectOk<{ frontmatter: { summary: string } }>(
        await client.call("brain.read", { uri, tier: 0 }),
      ).frontmatter.summary,
    ).toBe("Edited");
    expect(expectOk(await client.call("brain.inbox.list", {}))).toEqual([]);
  });

  it("rejects secrets over RPC without echoing them, including in unrecognized keys", async () => {
    const { client } = await boot();
    const secret = ["ghp_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join("");
    const err = expectErr(
      await client.call("brain.write", {
        uri: "brain://global/notes/leak.md",
        frontmatter: { summary: "ok", kind: "note", [secret]: "value" },
        body: "clean",
      }),
    );
    expect(err.code).toBe("bad_request");
    expect(err.message).toMatch(/credential/);
    expect(err.message).not.toContain(secret);
  });

  it("returns not_found or forbidden for unknown and removed projects, never crashing", async () => {
    const { client, projectB, tokenA } = await boot();

    // Unknown project for user -> not_found
    for (const [method, params] of [
      ["brain.list", { uri: "brain://project/unknown_proj/" }],
      ["brain.read", { uri: "brain://project/unknown_proj/a.md", tier: 2 }],
      [
        "brain.write",
        {
          uri: "brain://project/unknown_proj/a.md",
          frontmatter: { summary: "x", kind: "note" },
          body: "y",
        },
      ],
      ["brain.archive", { uri: "brain://project/unknown_proj/a.md" }],
      ["brain.remove", { uri: "brain://project/unknown_proj/a.md" }],
      ["brain.reindex", { scope: { kind: "project", projectId: "unknown_proj" } }],
    ] as const) {
      const err = expectErr(
        await client.call(method, params),
        `${method} should fail for unknown project`,
      );
      expect(err.code).toBe("not_found");
    }

    // Unknown project for agent -> forbidden
    const agentUnknown = expectErr(
      await client.call("brain.read", {
        uri: "brain://project/unknown_proj/a.md",
        tier: 2,
        agentToken: tokenA,
      }),
    );
    expect(agentUnknown.code).toBe("forbidden");

    // Removed project -> resolveProjectRoot returns null -> not_found
    await client.call("dispatch", {
      commandId: randomUUID(),
      type: "project.remove",
      projectId: projectB,
    });
    const removedErr = expectErr(
      await client.call("brain.list", { uri: `brain://project/${projectB}/` }),
    );
    expect(removedErr.code).toBe("not_found");
  });
});
