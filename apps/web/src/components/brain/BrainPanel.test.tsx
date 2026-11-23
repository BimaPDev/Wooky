/**
 * @vitest-environment happy-dom
 */
import type { BrainEntry, BrainSearchHit, BrainTreeNode } from "@wooky/contracts";
import { emptyReadModel } from "@wooky/domain";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  brainErrorMessage,
  createBrainClient,
  type BrainClient,
  type BrainInboxProposal,
  type BrainTransport,
} from "../../brain/client.ts";
import { RpcCallError } from "../../rpc/client.ts";
import { setBackend } from "../../state/backend.ts";
import { bindTransport, switchEnvironment } from "../../state/environments.ts";
import { useStore } from "../../state/store.ts";
import { App } from "../App.tsx";
import { Sidebar } from "../Sidebar.tsx";
import { installFixtureBackend } from "../anywhere/testing.ts";
import { BrainPanel } from "./BrainPanel.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function makeFakeClient(overrides: Partial<BrainClient> = {}): BrainClient {
  return {
    list: vi.fn<BrainClient["list"]>(async () => []),
    read: vi.fn<BrainClient["read"]>(async ({ uri, tier }) => ({
      uri,
      scope: { kind: "global" },
      path: "note.md",
      type: "memory",
      trust: "user",
      tier,
      frontmatter: {
        summary: "Default summary",
        kind: "note",
        tags: [],
        status: "active",
        updatedAt: "2026-11-23T00:00:00.000Z",
      },
      body: tier === 0 ? "" : "Body",
    })),
    search: vi.fn<BrainClient["search"]>(async () => []),
    write: vi.fn<BrainClient["write"]>(async ({ uri }) => ({
      uri,
      updatedAt: "2026-11-23T01:00:00.000Z",
      created: false,
    })),
    archive: vi.fn<BrainClient["archive"]>(async ({ uri }) => ({
      uri,
      updatedAt: "2026-11-23T01:00:00.000Z",
      created: false,
    })),
    remove: vi.fn<BrainClient["remove"]>(async () => undefined),
    reindex: vi.fn<BrainClient["reindex"]>(async () => ({ indexed: 1 })),
    listInbox: vi.fn<BrainClient["listInbox"]>(async () => []),
    approveInbox: vi.fn<BrainClient["approveInbox"]>(async () => undefined),
    rejectInbox: vi.fn<BrainClient["rejectInbox"]>(async () => undefined),
    ...overrides,
  };
}

function seedProjects() {
  const base = emptyReadModel();
  useStore.setState({
    model: {
      ...base,
      projects: {
        p1: {
          id: "p1",
          name: "orders-api",
          root: "/work/orders-api",
          createdAt: "2026-11-20T00:00:00.000Z",
          settings: { scripts: [], sharedPaths: [], prompts: [] },
        },
        p2: {
          id: "p2",
          name: "empty-site",
          root: "/work/empty-site",
          createdAt: "2026-11-20T00:00:00.000Z",
          settings: { scripts: [], sharedPaths: [], prompts: [] },
        },
      },
      threads: {
        t1: {
          id: "t1",
          projectId: "p1",
          title: "Fix pagination",
          provider: "claude",
          model: "claude-opus-5-5",
          runtimeMode: "approve",
          worktree: null,
          providerSessionId: null,
          ownerDeviceId: null,
          movedTo: null,
          movedFrom: null,
          pullRequest: null,
          queue: [],
          status: "idle",
          createdAt: "2026-11-20T00:00:00.000Z",
          updatedAt: "2026-11-20T00:00:00.000Z",
        },
      },
    } as never,
    status: "open",
    hasSnapshot: true,
  });
}

async function mountPanel(client: BrainClient, initialTab: "browse" | "inbox" = "browse") {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<BrainPanel client={client} initialTab={initialTab} searchDebounceMs={0} />);
  });
  await flush();
}

describe("BrainPanel", () => {
  beforeEach(() => {
    useStore.setState(useStore.getInitialState(), true);
    seedProjects();
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    host?.remove();
    root = undefined;
    host = undefined;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("renders scopes, project brain indicators, lazy folders with capped marker, pinned and archived nodes, and supports keyboard navigation", async () => {
    const globalRoot: BrainTreeNode[] = [
      {
        uri: "brain://global/lessons",
        scope: { kind: "global" },
        path: "lessons",
        name: "lessons",
        type: "folder",
        trust: "user",
        count: 50,
        capped: true,
      },
      {
        uri: "brain://global/pinned.md",
        scope: { kind: "global" },
        path: "pinned.md",
        name: "pinned.md",
        type: "memory",
        trust: "user",
        summary: "Always use pnpm",
        kind: "preference",
        status: "active",
        updatedAt: "2026-11-23T00:00:00.000Z",
      } as BrainTreeNode,
      {
        uri: "brain://global/old.md",
        scope: { kind: "global" },
        path: "old.md",
        name: "old.md",
        type: "memory",
        trust: "user",
        summary: "Old rule",
        kind: "note",
        status: "archived",
        updatedAt: "2026-11-22T00:00:00.000Z",
      },
    ];
    const folderChildren: BrainTreeNode[] = [
      {
        uri: "brain://global/lessons/sqlite.md",
        scope: { kind: "global" },
        path: "lessons/sqlite.md",
        name: "sqlite.md",
        type: "memory",
        trust: "user",
        summary: "Busy timeout",
        kind: "gotcha",
        status: "active",
        updatedAt: "2026-11-23T00:00:00.000Z",
      },
    ];
    const p1Nodes: BrainTreeNode[] = [
      {
        uri: "brain://project/p1/repo.md",
        scope: { kind: "project", projectId: "p1" },
        path: "repo.md",
        name: "repo.md",
        type: "memory",
        trust: "repo",
        summary: "Repo rule",
        kind: "convention",
        status: "active",
      },
    ];

    const client = makeFakeClient({
      list: vi.fn<BrainClient["list"]>(async ({ uri }) => {
        if (uri === "brain://global/") return globalRoot;
        if (uri === "brain://global/lessons") return folderChildren;
        if (uri === "brain://project/p1/") return p1Nodes;
        return [];
      }),
      read: vi.fn<BrainClient["read"]>(async ({ uri, tier }) => {
        if (uri === "brain://global/pinned.md") {
          return {
            uri,
            scope: { kind: "global" },
            path: "pinned.md",
            type: "memory",
            trust: "user",
            tier,
            frontmatter: {
              summary: "Always use pnpm",
              kind: "preference",
              tags: ["tooling"],
              status: "active",
              pinned: true,
              updatedAt: "2026-11-23T00:00:00.000Z",
            },
            body: tier === 0 ? "" : "Use pnpm.",
          };
        }
        return {
          uri,
          scope: { kind: "global" },
          path: "lessons",
          type: "overview",
          trust: "user",
          tier,
          frontmatter: {
            summary: "1 memory",
            kind: "note",
            tags: ["auto"],
            status: "active",
            updatedAt: "2026-11-23T00:00:00.000Z",
          },
          body: "# Overview",
        };
      }),
    });

    await mountPanel(client);

    // Scope switcher shows which project has a brain
    const scopeButtons = [...(host?.querySelectorAll(".brain-scope-btn") ?? [])];
    expect(
      scopeButtons.map(
        (b) => b.querySelector(".brain-scope-name")?.textContent?.trim() ?? b.textContent?.trim(),
      ),
    ).toEqual(["Global", "empty-site", "orders-api"]);
    expect(scopeButtons[1]?.querySelector(".brain-scope-dot")).toBeNull();
    expect(scopeButtons[2]?.querySelector(".brain-scope-dot")).not.toBeNull();

    // Capped marker & archived dimming
    expect(host?.textContent).toContain("50+");
    expect(host?.textContent).toContain("capped");
    const archivedRow = [...(host?.querySelectorAll(".brain-tree-row") ?? [])].find((el) =>
      el.textContent?.includes("old.md"),
    );
    expect(archivedRow?.classList.contains("brain-node-archived")).toBe(true);

    // Clicking pinned.md reads it and adds pinned marker to the tree
    const pinnedRow = [
      ...(host?.querySelectorAll<HTMLButtonElement>(".brain-tree-row") ?? []),
    ].find((el) => el.textContent?.includes("pinned.md"));
    expect(pinnedRow).toBeDefined();
    await act(async () => {
      pinnedRow?.click();
    });
    await flush();
    expect(pinnedRow?.querySelector('[aria-label="Pinned"]')).not.toBeNull();

    // Keyboard navigation: ArrowRight expands lessons folder and loads children
    const folderRow = [
      ...(host?.querySelectorAll<HTMLButtonElement>(".brain-tree-row") ?? []),
    ].find((el) => el.textContent?.includes("lessons"));
    expect(folderRow).toBeDefined();
    await act(async () => {
      folderRow?.focus();
      folderRow?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    await flush();
    expect(host?.textContent).toContain("sqlite.md");

    // ArrowLeft collapses folder
    await act(async () => {
      folderRow?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    await flush();
    expect(host?.textContent).not.toContain("sqlite.md");
  });

  it("runs BM25 search and renders L0 hits with scope and path", async () => {
    const hits: BrainSearchHit[] = [
      {
        uri: "brain://project/p1/conventions/api.md",
        scope: { kind: "project", projectId: "p1" },
        path: "conventions/api.md",
        trust: "repo",
        summary: "Use cursor pagination",
        kind: "convention",
        tags: ["api"],
        status: "active",
        updatedAt: "2026-11-23T00:00:00.000Z",
        score: 4.2,
      },
    ];
    const client = makeFakeClient({
      search: vi.fn<BrainClient["search"]>(async () => hits),
      read: vi.fn<BrainClient["read"]>(async ({ uri, tier }) => ({
        uri,
        scope: { kind: "project", projectId: "p1" },
        path: "conventions/api.md",
        type: "memory",
        trust: "repo",
        tier,
        frontmatter: {
          summary: "Use cursor pagination",
          kind: "convention",
          tags: ["api"],
          status: "active",
          updatedAt: "2026-11-23T00:00:00.000Z",
        },
        body: "Always pass cursor.",
      })),
    });

    await mountPanel(client);
    const searchInput = host?.querySelector<HTMLInputElement>('[aria-label="Search memories"]');
    const searchForm = host?.querySelector<HTMLFormElement>(".brain-search-bar");
    expect(searchInput).not.toBeNull();
    await act(async () => {
      if (searchInput) setInputValue(searchInput, "cursor");
      searchForm?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(client.search).toHaveBeenCalledWith(expect.objectContaining({ query: "cursor" }));
    expect(host?.textContent).toContain("Use cursor pagination");
    expect(host?.textContent).toContain("orders-api");
    expect(host?.textContent).toContain("conventions/api.md");
    expect(host?.textContent).toContain("from this repo");

    // Clicking a hit opens it at L2
    const hitBtn = host?.querySelector<HTMLButtonElement>(".brain-hit-row");
    await act(async () => {
      hitBtn?.click();
    });
    await flush();
    expect(host?.textContent).toContain("Always pass cursor.");
  });

  it("renders repo-trusted memories safely without interpreting HTML or script tags", async () => {
    const repoNode: BrainTreeNode = {
      uri: "brain://project/p1/gotchas/xss.md",
      scope: { kind: "project", projectId: "p1" },
      path: "gotchas/xss.md",
      name: "xss.md",
      type: "memory",
      trust: "repo",
      summary: "Untrusted repo memory",
      kind: "gotcha",
      status: "active",
    };
    const maliciousBody =
      '<script>window.__xss=true</script>\n\n<img src="x" onerror="alert(1)" />\n\n[bad](javascript:alert(1))';
    const client = makeFakeClient({
      list: vi.fn<BrainClient["list"]>(async ({ uri }) =>
        uri === "brain://project/p1/" ? [repoNode] : [],
      ),
      read: vi.fn<BrainClient["read"]>(async ({ uri, tier }) => ({
        uri,
        scope: { kind: "project", projectId: "p1" },
        path: "gotchas/xss.md",
        type: "memory",
        trust: "repo",
        tier,
        frontmatter: {
          summary: "Untrusted repo memory",
          kind: "gotcha",
          tags: [],
          status: "active",
          updatedAt: "2026-11-23T00:00:00.000Z",
        },
        body: maliciousBody,
      })),
    });

    await mountPanel(client);
    const projectBtn = [
      ...(host?.querySelectorAll<HTMLButtonElement>(".brain-scope-btn") ?? []),
    ].find((b) => b.textContent?.includes("orders-api"));
    await act(async () => {
      projectBtn?.click();
    });
    await flush();

    const row = host?.querySelector<HTMLButtonElement>(".brain-tree-row");
    await act(async () => {
      row?.click();
    });
    await flush();

    expect(host?.querySelector(".brain-detail-col")?.textContent).toContain("from this repo");
    expect(host?.querySelector("script")).toBeNull();
    expect(host?.querySelector("img")).toBeNull();
    expect(host?.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(host?.querySelector(".brain-body-card")?.textContent).toContain("<script>");
  });

  it("handles edit conflicts with a reload/overwrite prompt and never silently overwrites", async () => {
    const initialEntry: BrainEntry = {
      uri: "brain://global/lessons/pnpm.md",
      scope: { kind: "global" },
      path: "lessons/pnpm.md",
      type: "memory",
      trust: "user",
      tier: 2,
      frontmatter: {
        summary: "Initial summary",
        kind: "lesson",
        tags: ["pnpm"],
        status: "active",
        updatedAt: "2026-11-23T00:00:00.000Z",
      },
      body: "Original body",
    };
    const newerEntry: BrainEntry = {
      ...initialEntry,
      frontmatter: {
        ...initialEntry.frontmatter,
        summary: "Server updated summary",
        updatedAt: "2026-11-23T00:05:00.000Z",
      },
      body: "Server updated body",
    };

    let readCount = 0;
    const write = vi
      .fn<BrainClient["write"]>()
      .mockRejectedValueOnce(
        new RpcCallError(
          "conflict",
          "brain://global/lessons/pnpm.md changed since 2026-11-23T00:00:00.000Z.",
        ),
      )
      .mockResolvedValueOnce({
        uri: initialEntry.uri,
        updatedAt: "2026-11-23T00:06:00.000Z",
        created: false,
      });

    const client = makeFakeClient({
      list: vi.fn<BrainClient["list"]>(async ({ uri }) =>
        uri === "brain://global/"
          ? [
              {
                uri: initialEntry.uri,
                scope: { kind: "global" },
                path: "lessons/pnpm.md",
                name: "pnpm.md",
                type: "memory",
                trust: "user",
                summary: initialEntry.frontmatter.summary,
                kind: "lesson",
                status: "active",
              },
            ]
          : [],
      ),
      read: vi.fn<BrainClient["read"]>(async () => {
        readCount += 1;
        return readCount === 1 ? initialEntry : newerEntry;
      }),
      write,
    });

    await mountPanel(client);
    const row = host?.querySelector<HTMLButtonElement>(".brain-tree-row");
    await act(async () => {
      row?.click();
    });
    await flush();

    const editBtn = [...(host?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
      (b) => b.textContent?.trim() === "Edit",
    );
    await act(async () => {
      editBtn?.click();
    });

    const bodyArea = host?.querySelector<HTMLTextAreaElement>(".brain-body-textarea");
    await act(async () => {
      if (bodyArea) setInputValue(bodyArea, "My edited body");
    });

    const saveBtn = host?.querySelector<HTMLButtonElement>('button[type="submit"]');
    await act(async () => {
      saveBtn?.click();
    });
    await flush();

    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0].expectedUpdatedAt).toBe("2026-11-23T00:00:00.000Z");
    expect(host?.querySelector(".brain-conflict-box")?.textContent).toContain("Update conflict");
    expect(host?.querySelector(".brain-conflict-box")?.textContent).toContain(
      "Server updated summary",
    );

    // Overwrite uses the newly fetched updatedAt
    const overwriteBtn = [...(host?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
      (b) => b.textContent?.trim() === "Overwrite with my edits",
    );
    await act(async () => {
      overwriteBtn?.click();
    });
    await flush();

    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1]?.[0].expectedUpdatedAt).toBe("2026-11-23T00:05:00.000Z");
    expect(write.mock.calls[1]?.[0].body).toBe("My edited body");
  });

  it("supports L0/L1/L2 tier switching, pin toggle, archive, and reload latest on conflict", async () => {
    const baseEntry: BrainEntry = {
      uri: "brain://global/lessons/pnpm.md",
      scope: { kind: "global" },
      path: "lessons/pnpm.md",
      type: "memory",
      trust: "user",
      tier: 2,
      frontmatter: {
        summary: "Use pnpm",
        kind: "lesson",
        tags: ["tooling"],
        status: "active",
        pinned: false,
        updatedAt: "2026-11-23T00:00:00.000Z",
      },
      body: "Full L2 markdown body",
    };

    let currentEntry = baseEntry;
    const read = vi.fn<BrainClient["read"]>(async ({ uri, tier }) => {
      if (uri === "brain://global/lessons") {
        return {
          uri,
          scope: { kind: "global" },
          path: "lessons",
          type: "overview",
          trust: "user",
          tier,
          frontmatter: {
            summary: "1 memory",
            kind: "note",
            tags: ["auto"],
            status: "active",
            updatedAt: "2026-11-23T00:00:00.000Z",
          },
          body: "Folder L1 overview body",
        };
      }
      return {
        ...currentEntry,
        tier,
        body: tier === 0 ? "" : currentEntry.body,
      };
    });

    const write = vi.fn<BrainClient["write"]>(async ({ uri, frontmatter, body }) => {
      const updatedAt = "2026-11-23T00:10:00.000Z";
      currentEntry = {
        ...currentEntry,
        frontmatter: {
          ...frontmatter,
          tags: frontmatter.tags ?? [],
          status: frontmatter.status ?? "active",
          updatedAt,
        },
        body,
      };
      return { uri, updatedAt, created: false };
    });

    const archive = vi.fn<BrainClient["archive"]>(async ({ uri }) => {
      const updatedAt = "2026-11-23T00:15:00.000Z";
      currentEntry = {
        ...currentEntry,
        frontmatter: { ...currentEntry.frontmatter, status: "archived", updatedAt },
      };
      return { uri, updatedAt, created: false };
    });

    const client = makeFakeClient({
      list: vi.fn<BrainClient["list"]>(async ({ uri }) =>
        uri === "brain://global/"
          ? [
              {
                uri: baseEntry.uri,
                scope: { kind: "global" },
                path: "lessons/pnpm.md",
                name: "pnpm.md",
                type: "memory",
                trust: "user",
                summary: baseEntry.frontmatter.summary,
                kind: "lesson",
                status: "active",
              },
            ]
          : [],
      ),
      read,
      write,
      archive,
    });

    await mountPanel(client);
    await act(async () => {
      host?.querySelector<HTMLButtonElement>(".brain-tree-row")?.click();
    });
    await flush();
    expect(host?.textContent).toContain("Full L2 markdown body");

    // Switch to L0
    const clickTier = async (label: string) => {
      const btn = [...(host?.querySelectorAll<HTMLButtonElement>(".brain-tier-btn") ?? [])].find(
        (b) => b.textContent === label,
      );
      await act(async () => {
        btn?.click();
      });
      await flush();
    };
    await clickTier("L0");
    expect(host?.textContent).toContain("L0 shows the summary and frontmatter only");

    // Switch to L1 (reads parent folder overview)
    await clickTier("L1");
    expect(read).toHaveBeenCalledWith({ uri: "brain://global/lessons", tier: 1 });
    expect(host?.textContent).toContain("Folder L1 overview body");

    // Back to L2, toggle Pin, then Archive
    await clickTier("L2");
    const pinBtn = [...(host?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
      (b) => b.textContent?.trim() === "Pin",
    );
    await act(async () => {
      pinBtn?.click();
    });
    await flush();
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        uri: baseEntry.uri,
        expectedUpdatedAt: "2026-11-23T00:00:00.000Z",
        frontmatter: expect.objectContaining({ pinned: true }),
      }),
    );

    const archiveBtn = [...(host?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
      (b) => b.textContent?.trim() === "Archive",
    );
    await act(async () => {
      archiveBtn?.click();
    });
    await flush();
    expect(archive).toHaveBeenCalledWith({ uri: baseEntry.uri });
    expect(host?.textContent).toContain("Restore");
  });

  it("validates create path and surfaces server secret/size errors cleanly", async () => {
    const client = makeFakeClient({
      read: vi.fn<BrainClient["read"]>(async ({ uri }) => {
        throw new RpcCallError("not_found", `No such memory: ${uri}`);
      }),
      write: vi.fn<BrainClient["write"]>(async () => {
        throw new RpcCallError("bad_request", "Secret detected: GitHub token on line 1.");
      }),
    });

    await mountPanel(client);
    const newBtn = [...(host?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((b) =>
      b.textContent?.includes("New memory"),
    );
    await act(async () => {
      newBtn?.click();
    });

    const pathInput = host?.querySelector<HTMLInputElement>(
      'input[placeholder="conventions/tooling.md"]',
    );
    const summaryInput = host?.querySelector<HTMLInputElement>(
      'input[placeholder="One-line summary shown in listings and agent prompts"]',
    );
    const bodyInput = host?.querySelector<HTMLTextAreaElement>(".brain-body-textarea");
    const submitBtn = host?.querySelector<HTMLButtonElement>('button[type="submit"]');

    // Invalid path is caught before RPC
    await act(async () => {
      if (pathInput) setInputValue(pathInput, "BadPath");
      if (summaryInput) setInputValue(summaryInput, "Valid summary");
    });
    await act(async () => {
      submitBtn?.click();
    });
    expect(client.write).not.toHaveBeenCalled();
    expect(host?.querySelector('[role="alert"]')?.textContent).toContain("lowercase");

    // Valid path + server secret error is surfaced
    await act(async () => {
      if (pathInput) setInputValue(pathInput, "lessons/secret.md");
      if (bodyInput) setInputValue(bodyInput, "ghp_123456789012345678901234567890123456");
    });
    await act(async () => {
      submitBtn?.click();
    });
    await flush();
    expect(client.write).toHaveBeenCalledTimes(1);
    expect(host?.querySelector('[role="alert"]')?.textContent).toContain("Secret detected");
  });

  it("supports remove confirmation, inbox approve, edit-before-approve, and reject", async () => {
    const proposals: BrainInboxProposal[] = [
      {
        id: "p-approve",
        targetUri: "brain://global/lessons/a.md",
        summary: "Proposal A",
        kind: "lesson",
        tags: ["one"],
        body: "Body A",
        source: { threadId: "t1", agent: "claude", at: "2026-11-23T00:00:00.000Z" },
      },
      {
        id: "p-reject",
        targetUri: "brain://global/lessons/b.md",
        summary: "Proposal B",
        kind: "note",
        tags: [],
        body: "Body B",
        source: { agent: "codex", at: "2026-11-23T00:00:00.000Z" },
      },
    ];
    const client = makeFakeClient({
      listInbox: vi.fn<BrainClient["listInbox"]>(async () => proposals),
      read: vi.fn<BrainClient["read"]>(async ({ uri }) => {
        throw new RpcCallError("not_found", `No such memory: ${uri}`);
      }),
    });

    await mountPanel(client, "inbox");
    expect(useStore.getState().brainInboxCount).toBe(2);
    expect(host?.textContent).toContain("Proposal A");
    expect(host?.textContent).toContain("Thread: Fix pagination");
    expect(host?.textContent).toContain("Agent: claude");

    // Edit-before-approve on Proposal A
    const editButtons = [...(host?.querySelectorAll<HTMLButtonElement>("button") ?? [])].filter(
      (b) => b.textContent?.trim() === "Edit",
    );
    await act(async () => {
      editButtons[0]?.click();
    });
    const summaryEdit = host?.querySelector<HTMLInputElement>(".brain-inbox-edit input:not(.mono)");
    await act(async () => {
      if (summaryEdit) setInputValue(summaryEdit, "Edited Proposal A");
    });
    const approveEdited = [...(host?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
      (b) => b.textContent?.includes("Approve with edits"),
    );
    await act(async () => {
      approveEdited?.click();
    });
    await flush();

    expect(client.approveInbox).toHaveBeenCalledWith(
      "p-approve",
      expect.objectContaining({
        targetUri: "brain://global/lessons/a.md",
        frontmatter: expect.objectContaining({ summary: "Edited Proposal A", status: "active" }),
      }),
    );
    expect(useStore.getState().brainInboxCount).toBe(1);

    // Reject Proposal B
    const rejectBtn = [...(host?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
      (b) => b.textContent?.trim() === "Reject",
    );
    await act(async () => {
      rejectBtn?.click();
    });
    await flush();
    expect(client.rejectInbox).toHaveBeenCalledWith("p-reject");
    expect(useStore.getState().brainInboxCount).toBe(0);
    expect(host?.textContent).toContain("No pending proposals");
  });

  it("requires confirmation before removing a memory and handles empty/error states", async () => {
    let failFirst = true;
    const client = makeFakeClient({
      list: vi.fn<BrainClient["list"]>(async ({ uri }) => {
        if (uri === "brain://global/" && failFirst) {
          failFirst = false;
          throw new RpcCallError("unavailable", "Brain storage unavailable.");
        }
        return uri === "brain://global/"
          ? [
              {
                uri: "brain://global/lessons/one.md",
                scope: { kind: "global" },
                path: "lessons/one.md",
                name: "one.md",
                type: "memory",
                trust: "user",
                summary: "One",
                kind: "lesson",
                status: "active",
              },
            ]
          : [];
      }),
    });

    await mountPanel(client);
    expect(host?.querySelector('[role="alert"]')?.textContent).toContain(
      "Brain storage unavailable.",
    );

    const retryBtn = [...(host?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
      (b) => b.textContent?.trim() === "Retry",
    );
    await act(async () => {
      retryBtn?.click();
    });
    await flush();

    const row = host?.querySelector<HTMLButtonElement>(".brain-tree-row");
    await act(async () => {
      row?.click();
    });
    await flush();

    const removeBtn = [...(host?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
      (b) => b.textContent?.trim() === "Remove",
    );
    await act(async () => {
      removeBtn?.click();
    });
    expect(client.remove).not.toHaveBeenCalled();
    expect(host?.querySelector('[role="alertdialog"]')?.textContent).toContain(
      "Remove this memory permanently?",
    );

    const confirmBtn = [...(host?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
      (b) => b.textContent?.trim() === "Confirm remove",
    );
    await act(async () => {
      confirmBtn?.click();
    });
    await flush();
    expect(client.remove).toHaveBeenCalledWith({ uri: "brain://global/lessons/one.md" });
  });

  it("H1: disables Edit/Pin/Archive at L0 and fetches L2 before writing or editing on tier mismatch", async () => {
    const uri = "brain://global/lessons/pnpm.md";
    let resolveDelayedL2: ((entry: BrainEntry) => void) | null = null;
    let delayedPending = false;
    const makeEntry = (tier: 0 | 2, status: "active" | "archived" = "archived"): BrainEntry => ({
      uri,
      scope: { kind: "global" },
      path: "lessons/pnpm.md",
      type: "memory",
      trust: "user",
      tier,
      frontmatter: {
        summary: "Use pnpm",
        kind: "lesson",
        tags: [],
        status,
        pinned: false,
        updatedAt: "2026-11-23T00:00:00.000Z",
      },
      body: tier === 0 ? "" : "PRECIOUS BODY",
    });

    const client = makeFakeClient({
      list: vi.fn<BrainClient["list"]>(async ({ uri: listUri }) =>
        listUri === "brain://global/"
          ? [
              {
                uri,
                scope: { kind: "global" },
                path: "lessons/pnpm.md",
                name: "pnpm.md",
                type: "memory",
                trust: "user",
                summary: "Use pnpm",
                kind: "lesson",
                status: "archived",
              },
            ]
          : [],
      ),
      read: vi.fn<BrainClient["read"]>(async ({ tier }) => {
        if (delayedPending && tier === 2) {
          delayedPending = false;
          return new Promise<BrainEntry>((resolve) => {
            resolveDelayedL2 = resolve;
          });
        }
        return makeEntry(tier === 0 ? 0 : 2);
      }),
    });

    await mountPanel(client);
    await act(async () => {
      host?.querySelector<HTMLButtonElement>(".brain-tree-row")?.click();
    });
    await flush();

    // Switch to L0
    const l0Btn = [...(host?.querySelectorAll<HTMLButtonElement>(".brain-tier-btn") ?? [])].find(
      (b) => b.textContent === "L0",
    );
    await act(async () => {
      l0Btn?.click();
    });
    await flush();

    const findBtn = (label: string) =>
      [...(host?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
        (b) => b.textContent?.trim() === label,
      );
    expect(findBtn("Edit")?.disabled).toBe(true);
    expect(findBtn("Pin")?.disabled).toBe(true);
    expect(findBtn("Restore")?.disabled).toBe(true);

    // Simulate race: user clicks L2 while its read is still pending, so selectedTier=2 while entry.tier=0
    delayedPending = true;
    const l2Btn = [...(host?.querySelectorAll<HTMLButtonElement>(".brain-tier-btn") ?? [])].find(
      (b) => b.textContent === "L2",
    );
    await act(async () => {
      l2Btn?.click();
    });

    // Clicking Pin before L2 read resolves must still fetch L2 and never write ""
    await act(async () => {
      findBtn("Pin")?.click();
    });
    await flush();
    expect(client.write).toHaveBeenCalledWith(
      expect.objectContaining({
        uri,
        body: "PRECIOUS BODY",
        frontmatter: expect.objectContaining({ pinned: true }),
      }),
    );

    // Clean up pending promise if any
    await act(async () => {
      resolveDelayedL2?.(makeEntry(2));
    });
    await flush();
  });

  it("H2: refuses to create when the target path already exists and offers a button to open it", async () => {
    const existingUri = "brain://global/lessons/pnpm.md";
    const client = makeFakeClient({
      read: vi.fn<BrainClient["read"]>(async ({ uri, tier }) => ({
        uri,
        scope: { kind: "global" },
        path: "lessons/pnpm.md",
        type: "memory",
        trust: "user",
        tier,
        frontmatter: {
          summary: "Existing summary",
          kind: "lesson",
          tags: [],
          status: "active",
          updatedAt: "2026-11-23T00:00:00.000Z",
        },
        body: tier === 0 ? "" : "Existing body",
      })),
    });

    await mountPanel(client);
    const newBtn = [...(host?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((b) =>
      b.textContent?.includes("New memory"),
    );
    await act(async () => {
      newBtn?.click();
    });

    const pathInput = host?.querySelector<HTMLInputElement>(
      'input[placeholder="conventions/tooling.md"]',
    );
    const summaryInput = host?.querySelector<HTMLInputElement>(
      'input[placeholder="One-line summary shown in listings and agent prompts"]',
    );
    await act(async () => {
      if (pathInput) setInputValue(pathInput, "lessons/pnpm.md");
      if (summaryInput) setInputValue(summaryInput, "Would overwrite");
    });
    await act(async () => {
      host?.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
    });
    await flush();

    expect(client.write).not.toHaveBeenCalled();
    const alert = host?.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("That memory already exists; open it and edit it instead");
    const openBtn = [...(alert?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((b) =>
      b.textContent?.includes("Open"),
    );
    expect(openBtn).toBeDefined();

    await act(async () => {
      openBtn?.click();
    });
    await flush();

    expect(client.read).toHaveBeenCalledWith({ uri: existingUri, tier: 2 });
    expect(host?.textContent).toContain("Existing body");
  });

  it("M1a: edit-before-approve checks existing target, asks confirmation, and passes expectedUpdatedAt via real client", async () => {
    const proposals: BrainInboxProposal[] = [
      {
        id: "p1",
        targetUri: "brain://global/lessons/pnpm.md",
        summary: "Agent summary",
        kind: "lesson",
        tags: ["pnpm"],
        body: "Agent body",
      },
    ];
    const calls: { method: string; params: unknown }[] = [];
    const transport: BrainTransport = {
      call: async (method, params) => {
        calls.push({ method, params });
        if (method === "brain.list") return [];
        if (method === "brain.inbox.list") return proposals;
        if (method === "brain.read") {
          return {
            uri: "brain://global/lessons/pnpm.md",
            scope: { kind: "global" },
            path: "lessons/pnpm.md",
            type: "memory",
            trust: "user",
            tier: 0,
            frontmatter: {
              summary: "Existing memory",
              kind: "lesson",
              tags: [],
              status: "active",
              updatedAt: "2026-11-23T00:05:00.000Z",
            },
            body: "",
          };
        }
        if (method === "brain.write") {
          return {
            uri: "brain://global/lessons/pnpm.md",
            updatedAt: "2026-11-23T00:06:00.000Z",
            created: false,
          };
        }
        if (method === "brain.inbox.reject") return { ok: true };
        return {};
      },
    };
    const client = createBrainClient(transport);

    await mountPanel(client, "inbox");
    const editBtn = [...(host?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
      (b) => b.textContent?.trim() === "Edit",
    );
    await act(async () => {
      editBtn?.click();
    });
    const summaryInput = host?.querySelector<HTMLInputElement>(
      ".brain-inbox-edit input:not(.mono)",
    );
    await act(async () => {
      if (summaryInput) setInputValue(summaryInput, "Human edited summary");
    });
    const approveWithEdits = [...(host?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
      (b) => b.textContent?.includes("Approve with edits"),
    );
    await act(async () => {
      approveWithEdits?.click();
    });
    await flush();

    // Must NOT have written yet; must ask to confirm overwrite
    expect(calls.some((c) => c.method === "brain.write")).toBe(false);
    expect(host?.textContent).toContain("already exists");
    const confirmOverwriteBtn = [
      ...(host?.querySelectorAll<HTMLButtonElement>("button") ?? []),
    ].find((b) => b.textContent?.includes("Overwrite and approve"));
    expect(confirmOverwriteBtn).toBeDefined();

    await act(async () => {
      confirmOverwriteBtn?.click();
    });
    await flush();

    const writeCall = calls.find((c) => c.method === "brain.write");
    expect(writeCall?.params).toEqual(
      expect.objectContaining({
        uri: "brain://global/lessons/pnpm.md",
        expectedUpdatedAt: "2026-11-23T00:05:00.000Z",
      }),
    );
    expect(calls.some((c) => c.method === "brain.inbox.reject")).toBe(true);
  });

  it("M1b: if reject fails after write succeeds, marks card saved, hides Approve, and tells user to reject manually", async () => {
    const proposals: BrainInboxProposal[] = [
      {
        id: "p-partial",
        targetUri: "brain://global/lessons/new.md",
        summary: "Agent summary",
        kind: "lesson",
        tags: [],
        body: "Agent body",
      },
    ];
    let rejectShouldFail = true;
    const transport: BrainTransport = {
      call: async (method) => {
        if (method === "brain.list") return [];
        if (method === "brain.inbox.list") return proposals;
        if (method === "brain.read") {
          throw new RpcCallError("not_found", "No such memory");
        }
        if (method === "brain.write") {
          return {
            uri: "brain://global/lessons/new.md",
            updatedAt: "2026-11-23T00:06:00.000Z",
            created: true,
          };
        }
        if (method === "brain.inbox.reject") {
          if (rejectShouldFail) throw new RpcCallError("internal", "boom");
          return { ok: true };
        }
        return {};
      },
    };
    const client = createBrainClient(transport);

    await mountPanel(client, "inbox");
    const editBtn = [...(host?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
      (b) => b.textContent?.trim() === "Edit",
    );
    await act(async () => {
      editBtn?.click();
    });
    const approveWithEdits = [...(host?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
      (b) => b.textContent?.includes("Approve with edits"),
    );
    await act(async () => {
      approveWithEdits?.click();
    });
    await flush();

    expect(host?.textContent).toContain(
      "Your memory was saved but the proposal is still in the inbox. Reject it manually.",
    );
    expect(host?.textContent).not.toContain("Could not approve");
    expect(host?.textContent).toContain("Saved");

    const cardButtons = [
      ...(host?.querySelectorAll<HTMLButtonElement>(".brain-inbox-card button") ?? []),
    ].map((b) => b.textContent?.trim());
    expect(cardButtons).not.toContain("Approve");
    expect(cardButtons).not.toContain("Edit");
    expect(cardButtons).toContain("Reject");

    // Manual reject finishes cleanup
    rejectShouldFail = false;
    const rejectBtn = [...(host?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
      (b) => b.textContent?.trim() === "Reject",
    );
    await act(async () => {
      rejectBtn?.click();
    });
    await flush();
    expect(host?.textContent).toContain("No pending proposals");
  });

  it("M2: hides Overwrite and shows Retry when conflict-time read fails, and guards Recreate against existing files", async () => {
    const uri = "brain://global/lessons/pnpm.md";
    const initialEntry: BrainEntry = {
      uri,
      scope: { kind: "global" },
      path: "lessons/pnpm.md",
      type: "memory",
      trust: "user",
      tier: 2,
      frontmatter: {
        summary: "Initial",
        kind: "lesson",
        tags: [],
        status: "active",
        updatedAt: "2026-11-23T00:00:00.000Z",
      },
      body: "Original",
    };
    const newerEntry: BrainEntry = {
      ...initialEntry,
      frontmatter: {
        ...initialEntry.frontmatter,
        summary: "Updated on disk",
        updatedAt: "2026-11-23T00:05:00.000Z",
      },
      body: "Disk body",
    };

    let readStep = 0;
    const write = vi
      .fn<BrainClient["write"]>()
      .mockRejectedValueOnce(new RpcCallError("conflict", "changed"))
      .mockResolvedValueOnce({ uri, updatedAt: "2026-11-23T00:06:00.000Z", created: false });

    const client = makeFakeClient({
      list: vi.fn<BrainClient["list"]>(async ({ uri: listUri }) =>
        listUri === "brain://global/"
          ? [
              {
                uri,
                scope: { kind: "global" },
                path: "lessons/pnpm.md",
                name: "pnpm.md",
                type: "memory",
                trust: "user",
                summary: "Initial",
                kind: "lesson",
                status: "active",
              },
            ]
          : [],
      ),
      read: vi.fn<BrainClient["read"]>(async () => {
        readStep += 1;
        if (readStep === 1) return initialEntry;
        if (readStep === 2) throw new RpcCallError("unavailable", "index busy");
        if (readStep === 3) throw new RpcCallError("not_found", "deleted");
        return newerEntry;
      }),
      write,
    });

    await mountPanel(client);
    await act(async () => {
      host?.querySelector<HTMLButtonElement>(".brain-tree-row")?.click();
    });
    await flush();

    const findBtn = (label: string) =>
      [...(host?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
        (b) => b.textContent?.trim() === label,
      );

    await act(async () => {
      findBtn("Edit")?.click();
    });
    await act(async () => {
      host?.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
    });
    await flush();

    // Conflict-time read failed: Overwrite and Recreate MUST be hidden, Retry MUST be shown
    expect(findBtn("Overwrite with my edits")).toBeUndefined();
    expect(findBtn("Recreate with my edits")).toBeUndefined();
    expect(host?.querySelector(".brain-conflict-box")?.textContent).toContain("index busy");
    const retryBtn = findBtn("Retry");
    expect(retryBtn).toBeDefined();

    // Retry returns not_found -> Recreate appears
    await act(async () => {
      retryBtn?.click();
    });
    await flush();
    const recreateBtn = findBtn("Recreate with my edits");
    expect(recreateBtn).toBeDefined();

    // If the file reappeared before Recreate runs, Recreate refuses unconditional write and surfaces newerEntry
    await act(async () => {
      recreateBtn?.click();
    });
    await flush();
    expect(write).toHaveBeenCalledTimes(1);
    expect(host?.querySelector(".brain-conflict-box")?.textContent).toContain("Updated on disk");

    // Now Overwrite sends the fetched expectedUpdatedAt, never undefined
    await act(async () => {
      findBtn("Overwrite with my edits")?.click();
    });
    await flush();
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1]?.[0].expectedUpdatedAt).toBe("2026-11-23T00:05:00.000Z");
  });

  it("M3: shows conflict banner with Reload in view mode when Pin/Unpin/Restore conflicts", async () => {
    const uri = "brain://global/lessons/pnpm.md";
    const initialEntry: BrainEntry = {
      uri,
      scope: { kind: "global" },
      path: "lessons/pnpm.md",
      type: "memory",
      trust: "user",
      tier: 2,
      frontmatter: {
        summary: "Initial",
        kind: "lesson",
        tags: [],
        status: "archived",
        pinned: false,
        updatedAt: "2026-11-23T00:00:00.000Z",
      },
      body: "Original body",
    };
    const newerEntry: BrainEntry = {
      ...initialEntry,
      frontmatter: {
        ...initialEntry.frontmatter,
        summary: "Updated on disk",
        status: "active",
        pinned: true,
        updatedAt: "2026-11-23T00:05:00.000Z",
      },
      body: "Newer body on disk",
    };

    let readCount = 0;
    const client = makeFakeClient({
      list: vi.fn<BrainClient["list"]>(async ({ uri: listUri }) =>
        listUri === "brain://global/"
          ? [
              {
                uri,
                scope: { kind: "global" },
                path: "lessons/pnpm.md",
                name: "pnpm.md",
                type: "memory",
                trust: "user",
                summary: "Initial",
                kind: "lesson",
                status: "archived",
              },
            ]
          : [],
      ),
      read: vi.fn<BrainClient["read"]>(async () => {
        readCount += 1;
        return readCount === 1 ? initialEntry : newerEntry;
      }),
      write: vi.fn<BrainClient["write"]>(async () => {
        throw new RpcCallError("conflict", "changed on disk");
      }),
    });

    await mountPanel(client);
    await act(async () => {
      host?.querySelector<HTMLButtonElement>(".brain-tree-row")?.click();
    });
    await flush();

    const findBtn = (label: string) =>
      [...(host?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
        (b) => b.textContent?.trim() === label,
      );

    // Conflict on Pin in view mode
    await act(async () => {
      findBtn("Pin")?.click();
    });
    await flush();

    const conflictBox = host?.querySelector('.brain-conflict-box[role="alert"]');
    expect(conflictBox).not.toBeNull();
    expect(conflictBox?.textContent).toContain("changed on disk");

    const reloadBtn = [...(conflictBox?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
      (b) => b.textContent?.trim() === "Reload",
    );
    expect(reloadBtn).toBeDefined();

    await act(async () => {
      reloadBtn?.click();
    });
    await flush();

    expect(host?.querySelector(".brain-conflict-box")).toBeNull();
    expect(host?.textContent).toContain("Updated on disk");
    expect(host?.textContent).toContain("Newer body on disk");
  });

  it("M4a: invalidates and re-fetches every cached or expanded ancestor folder after create, write, and remove", async () => {
    const aUri = "brain://global/a";
    const bUri = "brain://global/a/b";
    const cUri = "brain://global/a/b/c.md";
    const dUri = "brain://global/a/b/d.md";
    let removedC = false;
    let createdD = false;

    const list = vi.fn<BrainClient["list"]>(async ({ uri }) => {
      if (uri === "brain://global/") {
        return [
          {
            uri: aUri,
            scope: { kind: "global" },
            path: "a",
            name: "a",
            type: "folder",
            trust: "user",
            count: (removedC ? 0 : 1) + (createdD ? 1 : 0),
          },
        ];
      }
      if (uri === aUri) {
        return [
          {
            uri: bUri,
            scope: { kind: "global" },
            path: "a/b",
            name: "b",
            type: "folder",
            trust: "user",
            count: (removedC ? 0 : 1) + (createdD ? 1 : 0),
          },
        ];
      }
      if (uri === bUri) {
        const out: BrainTreeNode[] = [];
        if (!removedC) {
          out.push({
            uri: cUri,
            scope: { kind: "global" },
            path: "a/b/c.md",
            name: "c.md",
            type: "memory",
            trust: "user",
            summary: "C summary",
            kind: "note",
            status: "active",
          });
        }
        if (createdD) {
          out.push({
            uri: dUri,
            scope: { kind: "global" },
            path: "a/b/d.md",
            name: "d.md",
            type: "memory",
            trust: "user",
            summary: "D summary",
            kind: "note",
            status: "active",
          });
        }
        return out;
      }
      return [];
    });

    const client = makeFakeClient({
      list,
      read: vi.fn<BrainClient["read"]>(async ({ uri, tier }) => {
        if (uri === dUri && !createdD) {
          throw new RpcCallError("not_found", "missing");
        }
        return {
          uri,
          scope: { kind: "global" },
          path: uri.replace("brain://global/", ""),
          type: uri.endsWith(".md") ? "memory" : "overview",
          trust: "user",
          tier,
          frontmatter: {
            summary: "C summary",
            kind: "note",
            tags: [],
            status: "active",
            updatedAt: "2026-11-23T00:00:00.000Z",
          },
          body: tier === 0 ? "" : "Body C",
        };
      }),
      write: vi.fn<BrainClient["write"]>(async ({ uri }) => {
        if (uri === dUri) createdD = true;
        return { uri, updatedAt: "2026-11-23T00:02:00.000Z", created: uri === dUri };
      }),
      remove: vi.fn<BrainClient["remove"]>(async ({ uri }) => {
        if (uri === cUri) removedC = true;
      }),
    });

    await mountPanel(client);
    const findRow = (name: string) =>
      [...(host?.querySelectorAll<HTMLButtonElement>(".brain-tree-row") ?? [])].find((r) =>
        r.textContent?.includes(name),
      );

    // Expand folder a, then folder b
    await act(async () => {
      findRow("a")?.click();
    });
    await flush();
    await act(async () => {
      findRow("b")?.click();
    });
    await flush();
    expect(findRow("c.md")).toBeDefined();

    // Remove c.md -> all three ancestors (root, a, a/b) must be re-fetched
    await act(async () => {
      findRow("c.md")?.click();
    });
    await flush();
    list.mockClear();

    const findBtn = (label: string) =>
      [...(host?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
        (b) => b.textContent?.trim() === label,
      );
    await act(async () => {
      findBtn("Remove")?.click();
    });
    await act(async () => {
      findBtn("Confirm remove")?.click();
    });
    await flush();

    const refreshedAfterRemove = list.mock.calls.map((c) => c[0].uri);
    expect(refreshedAfterRemove).toContain("brain://global/");
    expect(refreshedAfterRemove).toContain(aUri);
    expect(refreshedAfterRemove).toContain(bUri);
    expect(host?.textContent).not.toContain("c.md");

    // Collapse a (so a and a/b remain cached while collapsed), then create d.md -> cached ancestors must be re-fetched
    await act(async () => {
      findRow("a")?.click();
    });
    await flush();
    list.mockClear();

    await act(async () => {
      [...(host?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
        .find((b) => b.textContent?.includes("New memory"))
        ?.click();
    });
    const pathInput = host?.querySelector<HTMLInputElement>(
      'input[placeholder="conventions/tooling.md"]',
    );
    const summaryInput = host?.querySelector<HTMLInputElement>(
      'input[placeholder="One-line summary shown in listings and agent prompts"]',
    );
    await act(async () => {
      if (pathInput) setInputValue(pathInput, "a/b/d.md");
      if (summaryInput) setInputValue(summaryInput, "D summary");
    });
    await act(async () => {
      host?.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
    });
    await flush();

    const refreshedAfterCreate = list.mock.calls.map((c) => c[0].uri);
    expect(refreshedAfterCreate).toContain("brain://global/");
    expect(refreshedAfterCreate).toContain(aUri);
    expect(refreshedAfterCreate).toContain(bUri);
  });

  it("M4b: toggling Archived clears cached scope listings and reloads expanded folders", async () => {
    const lessonsUri = "brain://global/lessons";
    const otherUri = "brain://global/other";
    const list = vi.fn<BrainClient["list"]>(async ({ uri, includeArchived }) => {
      if (uri === "brain://global/") {
        return [
          {
            uri: lessonsUri,
            scope: { kind: "global" },
            path: "lessons",
            name: "lessons",
            type: "folder",
            trust: "user",
            count: includeArchived ? 2 : 1,
          },
          {
            uri: otherUri,
            scope: { kind: "global" },
            path: "other",
            name: "other",
            type: "folder",
            trust: "user",
            count: includeArchived ? 2 : 1,
          },
        ];
      }
      if (uri === lessonsUri) {
        return [
          {
            uri: "brain://global/lessons/active.md",
            scope: { kind: "global" },
            path: "lessons/active.md",
            name: "active.md",
            type: "memory",
            trust: "user",
            summary: "Active",
            kind: "lesson",
            status: "active",
          },
          ...(includeArchived
            ? [
                {
                  uri: "brain://global/lessons/old.md",
                  scope: { kind: "global" },
                  path: "lessons/old.md",
                  name: "old.md",
                  type: "memory",
                  trust: "user",
                  summary: "Old",
                  kind: "lesson",
                  status: "archived",
                } satisfies BrainTreeNode,
              ]
            : []),
        ];
      }
      if (uri === otherUri) {
        return includeArchived
          ? [
              {
                uri: "brain://global/other/arch.md",
                scope: { kind: "global" },
                path: "other/arch.md",
                name: "arch.md",
                type: "memory",
                trust: "user",
                summary: "Archived other",
                kind: "note",
                status: "archived",
              },
            ]
          : [];
      }
      return [];
    });

    const client = makeFakeClient({ list });
    await mountPanel(client);
    const findRow = (name: string) =>
      [...(host?.querySelectorAll<HTMLButtonElement>(".brain-tree-row") ?? [])].find((r) =>
        r.textContent?.includes(name),
      );

    // Expand other, then collapse it (cached, not expanded). Expand lessons (expanded).
    await act(async () => {
      findRow("other")?.click();
    });
    await flush();
    await act(async () => {
      findRow("other")?.click();
    });
    await flush();
    await act(async () => {
      findRow("lessons")?.click();
    });
    await flush();
    expect(host?.textContent).not.toContain("old.md");

    list.mockClear();
    const archivedCheckbox = [
      ...(host?.querySelectorAll<HTMLLabelElement>(".brain-filter-toggle") ?? []),
    ]
      .find((el) => el.textContent?.includes("Archived"))
      ?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(archivedCheckbox).toBeDefined();

    await act(async () => {
      archivedCheckbox?.click();
    });
    await flush();

    // Expanded folder (lessons) and root reloaded with includeArchived: true; collapsed cached folder (other) cleared, not fetched yet
    expect(list).toHaveBeenCalledWith({ uri: "brain://global/", includeArchived: true });
    expect(list).toHaveBeenCalledWith({ uri: lessonsUri, includeArchived: true });
    expect(list.mock.calls.some((c) => c[0].uri === otherUri)).toBe(false);
    expect(host?.textContent).toContain("old.md");

    // Re-expanding `other` must fetch fresh archived contents because its cache was cleared
    await act(async () => {
      findRow("other")?.click();
    });
    await flush();
    expect(list).toHaveBeenCalledWith({ uri: otherUri, includeArchived: true });
    expect(host?.textContent).toContain("arch.md");
  });
});

describe("Sidebar Brain entry point", () => {
  beforeEach(() => {
    useStore.setState(useStore.getInitialState(), true);
    useStore.setState({ status: "open", hasSnapshot: true, brainInboxCount: 3 });
    installFixtureBackend();
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    host?.remove();
    root = undefined;
    host = undefined;
    document.body.innerHTML = "";
  });

  it("shows Brain nav item with pending proposal badge and opens Brain panel on click", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(<Sidebar />);
    });

    const brainBtn = host.querySelector<HTMLButtonElement>(".sidebar-brain-button");
    expect(brainBtn).not.toBeNull();
    expect(brainBtn?.textContent).toContain("Brain");
    expect(brainBtn?.querySelector(".sidebar-brain-badge")?.textContent).toBe("3");

    await act(async () => {
      brainBtn?.click();
    });
    expect(useStore.getState().brainOpen).toBe(true);
  });

  it("M5: resets BrainPanel state and reloads new environment brain when switching environments", async () => {
    let activeEnv = "local";
    bindTransport({
      reconnect: () => {
        useStore.setState({ status: "open" });
      },
      localUrl: () => "ws://local/ws",
    });
    setBackend({
      call: (async (method: string, params: unknown) => {
        const p = (params ?? {}) as Record<string, unknown>;
        if (method === "remote.connectInfo") {
          return { wsUrl: "ws://env-home/ws", token: "tok" };
        }
        if (method === "settings.get") {
          return {
            environments: [
              {
                id: "env-home",
                label: "Home",
                connection: { kind: "direct", url: "http://127.0.0.1:4317" },
                addedAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          };
        }
        if (method === "brain.list") {
          if (p.uri !== "brain://global/") return [];
          return activeEnv === "local"
            ? [
                {
                  uri: "brain://global/local-only.md",
                  scope: { kind: "global" },
                  path: "local-only.md",
                  name: "local-only.md",
                  type: "memory",
                  trust: "user",
                  summary: "Local secret note",
                  kind: "note",
                  status: "active",
                },
              ]
            : [
                {
                  uri: "brain://global/remote-only.md",
                  scope: { kind: "global" },
                  path: "remote-only.md",
                  name: "remote-only.md",
                  type: "memory",
                  trust: "user",
                  summary: "Remote note",
                  kind: "note",
                  status: "active",
                },
              ];
        }
        if (method === "brain.read") {
          return {
            uri: String(p.uri),
            scope: { kind: "global" },
            path: "local-only.md",
            type: "memory",
            trust: "user",
            tier: p.tier ?? 2,
            frontmatter: {
              summary: "Local secret note",
              kind: "note",
              tags: [],
              status: "active",
              updatedAt: "2026-11-23T00:00:00.000Z",
            },
            body: "Local body content",
          };
        }
        if (method === "brain.inbox.list") {
          return activeEnv === "local"
            ? []
            : [
                {
                  id: "r1",
                  targetUri: "brain://global/r.md",
                  summary: "R",
                  kind: "note",
                  tags: [],
                  body: "R",
                },
              ];
        }
        return undefined;
      }) as never,
    });

    useStore.setState({ status: "open", hasSnapshot: true, brainOpen: true });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(<App />);
    });
    await flush();

    // Open local-only.md in the local environment
    await act(async () => {
      host?.querySelector<HTMLButtonElement>(".brain-tree-row")?.click();
    });
    await flush();
    expect(host?.textContent).toContain("Local body content");

    // Switch to remote environment
    activeEnv = "env-home";
    await act(async () => {
      await switchEnvironment("env-home");
    });
    await flush();

    expect(host?.textContent).not.toContain("Local body content");
    expect(host?.textContent).not.toContain("local-only.md");
    expect(host?.textContent).toContain("remote-only.md");
    expect(useStore.getState().brainInboxCount).toBe(1);

    // Switch back to local for test isolation
    activeEnv = "local";
    await act(async () => {
      await switchEnvironment("local");
    });
    await flush();
  });
});

describe("BrainPanel navigation & lows & XSS", () => {
  beforeEach(() => {
    useStore.setState(useStore.getInitialState(), true);
    seedProjects();
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    host?.remove();
    root = undefined;
    host = undefined;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("M6: skips selection and mode updates when a write finishes after navigation, while still refreshing the tree", async () => {
    const aUri = "brain://global/lessons/a.md";
    const bUri = "brain://global/lessons/b.md";
    let resolveWrite!: (res: { uri: string; updatedAt: string; created: boolean }) => void;

    const list = vi.fn<BrainClient["list"]>(async ({ uri }) =>
      uri === "brain://global/"
        ? [
            {
              uri: aUri,
              scope: { kind: "global" },
              path: "lessons/a.md",
              name: "a.md",
              type: "memory",
              trust: "user",
              summary: "Summary A",
              kind: "lesson",
              status: "active",
            },
            {
              uri: bUri,
              scope: { kind: "global" },
              path: "lessons/b.md",
              name: "b.md",
              type: "memory",
              trust: "user",
              summary: "Summary B",
              kind: "lesson",
              status: "active",
            },
          ]
        : [],
    );

    const read = vi.fn<BrainClient["read"]>(async ({ uri, tier }) => ({
      uri,
      scope: { kind: "global" },
      path: uri.replace("brain://global/", ""),
      type: "memory",
      trust: "user",
      tier,
      frontmatter: {
        summary: uri === aUri ? "Summary A" : "Summary B",
        kind: "lesson",
        tags: [],
        status: "active",
        updatedAt: "2026-11-23T00:00:00.000Z",
      },
      body: tier === 0 ? "" : uri === aUri ? "Body A" : "Body B",
    }));

    const write = vi.fn<BrainClient["write"]>(
      () =>
        new Promise((resolve) => {
          resolveWrite = resolve;
        }),
    );

    const client = makeFakeClient({ list, read, write });
    await mountPanel(client);

    const findRow = (name: string) =>
      [...(host?.querySelectorAll<HTMLButtonElement>(".brain-tree-row") ?? [])].find((r) =>
        r.textContent?.includes(name),
      );

    // Open a.md and enter Edit mode
    await act(async () => {
      findRow("a.md")?.click();
    });
    await flush();
    await act(async () => {
      [...(host?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
        .find((b) => b.textContent?.trim() === "Edit")
        ?.click();
    });

    // Submit save (write stays pending)
    await act(async () => {
      host?.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
    });
    expect(write).toHaveBeenCalledTimes(1);

    // Navigate to b.md while write is still in flight
    await act(async () => {
      findRow("b.md")?.click();
    });
    await flush();
    expect(host?.textContent).toContain("Body B");

    list.mockClear();
    read.mockClear();

    // Now the in-flight write for a.md finishes
    await act(async () => {
      resolveWrite({ uri: aUri, updatedAt: "2026-11-23T00:01:00.000Z", created: false });
    });
    await flush();

    // Tree refresh MUST still run, but view MUST NOT hijack back to a.md
    expect(list).toHaveBeenCalledWith({ uri: "brain://global/" });
    expect(read).not.toHaveBeenCalledWith({ uri: aUri, tier: 2 });
    expect(host?.querySelector(".brain-detail-uri")?.textContent).toBe(bUri);
    expect(host?.textContent).toContain("Body B");
  });

  it("L1: refreshes brainInboxCount when the window regains focus", async () => {
    let inboxItems: BrainInboxProposal[] = [];
    bindTransport({
      reconnect: () => {
        useStore.setState({ status: "open" });
      },
      localUrl: () => "ws://local/ws",
    });
    setBackend({
      call: (async (method: string) => {
        if (method === "brain.inbox.list") return inboxItems;
        if (method === "brain.list") return [];
        return undefined;
      }) as never,
    });

    useStore.setState({ status: "open", hasSnapshot: true, brainOpen: false, brainInboxCount: 0 });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(<App />);
    });
    await flush();

    inboxItems = [
      {
        id: "focus-1",
        targetUri: "brain://global/lessons/focus.md",
        summary: "Focus proposal",
        kind: "lesson",
        tags: [],
        body: "Body",
      },
    ];
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await flush();
    expect(useStore.getState().brainInboxCount).toBe(1);
  });

  it("L2: falls back to Global when the active project is removed", async () => {
    const client = makeFakeClient({
      list: vi.fn<BrainClient["list"]>(async ({ uri }) => {
        if (uri === "brain://global/") {
          return [
            {
              uri: "brain://global/g.md",
              scope: { kind: "global" },
              path: "g.md",
              name: "g.md",
              type: "memory",
              trust: "user",
              summary: "Global item",
              kind: "note",
              status: "active",
            },
          ];
        }
        if (uri === "brain://project/p1/") {
          return [
            {
              uri: "brain://project/p1/p.md",
              scope: { kind: "project", projectId: "p1" },
              path: "p.md",
              name: "p.md",
              type: "memory",
              trust: "repo",
              summary: "Project item",
              kind: "note",
              status: "active",
            },
          ];
        }
        return [];
      }),
    });

    await mountPanel(client);
    const p1Btn = [...(host?.querySelectorAll<HTMLButtonElement>(".brain-scope-btn") ?? [])].find(
      (b) => b.textContent?.includes("orders-api"),
    );
    await act(async () => {
      p1Btn?.click();
    });
    await flush();
    expect(host?.textContent).toContain("p.md");

    // Remove p1 from store
    await act(async () => {
      const state = useStore.getState();
      const { p1: _removed, ...rest } = state.model.projects;
      useStore.setState({ model: { ...state.model, projects: rest } });
    });
    await flush();

    const globalBtn = [
      ...(host?.querySelectorAll<HTMLButtonElement>(".brain-scope-btn") ?? []),
    ].find((b) => b.textContent?.includes("Global"));
    expect(globalBtn?.getAttribute("aria-pressed")).toBe("true");
    expect(host?.textContent).toContain("g.md");
  });

  it("L3: on phone, tapping a folder expands it and stays on the list", async () => {
    const origMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn<typeof window.matchMedia>((query: string) => ({
      matches: query === "(max-width: 640px)",
      media: query,
      onchange: null,
      addListener: vi.fn<() => void>(),
      removeListener: vi.fn<() => void>(),
      addEventListener: vi.fn<() => void>(),
      removeEventListener: vi.fn<() => void>(),
      dispatchEvent: vi.fn<() => boolean>(() => true),
    }));

    try {
      const client = makeFakeClient({
        list: vi.fn<BrainClient["list"]>(async ({ uri }) => {
          if (uri === "brain://global/") {
            return [
              {
                uri: "brain://global/lessons",
                scope: { kind: "global" },
                path: "lessons",
                name: "lessons",
                type: "folder",
                trust: "user",
                count: 1,
              },
            ];
          }
          if (uri === "brain://global/lessons") {
            return [
              {
                uri: "brain://global/lessons/pnpm.md",
                scope: { kind: "global" },
                path: "lessons/pnpm.md",
                name: "pnpm.md",
                type: "memory",
                trust: "user",
                summary: "Use pnpm",
                kind: "lesson",
                status: "active",
              },
            ];
          }
          return [];
        }),
      });

      await mountPanel(client);
      const folderRow = host?.querySelector<HTMLButtonElement>(".brain-tree-row");
      await act(async () => {
        folderRow?.click();
      });
      await flush();

      expect(host?.textContent).toContain("pnpm.md");
      expect(host?.querySelector(".brain-workspace")?.classList.contains("mobile-list")).toBe(true);
    } finally {
      window.matchMedia = origMatchMedia;
    }
  });

  it("L4: moves focus sensibly after Save, Cancel, and Remove", async () => {
    const uri = "brain://global/lessons/focus.md";
    const client = makeFakeClient({
      list: vi.fn<BrainClient["list"]>(async ({ uri: listUri }) =>
        listUri === "brain://global/"
          ? [
              {
                uri,
                scope: { kind: "global" },
                path: "lessons/focus.md",
                name: "focus.md",
                type: "memory",
                trust: "user",
                summary: "Focus test",
                kind: "note",
                status: "active",
              },
            ]
          : [],
      ),
    });

    await mountPanel(client);
    await act(async () => {
      host?.querySelector<HTMLButtonElement>(".brain-tree-row")?.click();
    });
    await flush();

    const findBtn = (label: string) =>
      [...(host?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
        (b) => b.textContent?.trim() === label,
      );

    // Cancel edit -> focus moves to Edit button
    await act(async () => {
      findBtn("Edit")?.click();
    });
    await act(async () => {
      findBtn("Cancel")?.click();
    });
    await flush();
    expect(document.activeElement).toBe(findBtn("Edit"));

    // Save edit -> focus moves to Edit button
    await act(async () => {
      findBtn("Edit")?.click();
    });
    await act(async () => {
      host?.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
    });
    await flush();
    expect(document.activeElement).toBe(findBtn("Edit"));

    // Remove -> focus moves to tree row
    await act(async () => {
      findBtn("Remove")?.click();
    });
    await act(async () => {
      findBtn("Confirm remove")?.click();
    });
    await flush();
    expect(document.activeElement).toBe(host?.querySelector(".brain-tree-row"));
  });

  it("L5 & L6 & L7 & L8: pinned proposal warning, proposed status option, capped error length, and link host title", async () => {
    // L7: capped error length
    const longMsg = "X".repeat(500);
    const capped = brainErrorMessage(new Error(longMsg), "fallback");
    expect(capped.length).toBeLessThanOrEqual(240);
    expect(capped.endsWith("…")).toBe(true);

    // L5: pinned proposal warning
    const pinnedProposal: BrainInboxProposal = {
      id: "pin-prop",
      targetUri: "brain://global/lessons/pin.md",
      summary: "Pinned proposal",
      kind: "lesson",
      tags: [],
      body: "Always do this",
      pinned: true,
    };
    const proposedEntry: BrainEntry = {
      uri: "brain://global/lessons/prop.md",
      scope: { kind: "global" },
      path: "lessons/prop.md",
      type: "memory",
      trust: "user",
      tier: 2,
      frontmatter: {
        summary: "Proposed memory",
        kind: "note",
        tags: [],
        status: "proposed",
        updatedAt: "2026-11-23T00:00:00.000Z",
      },
      body: "[docs](https://example.com/guide)",
    };

    const client = makeFakeClient({
      listInbox: vi.fn<BrainClient["listInbox"]>(async () => [pinnedProposal]),
      list: vi.fn<BrainClient["list"]>(async ({ uri }) =>
        uri === "brain://global/"
          ? [
              {
                uri: proposedEntry.uri,
                scope: { kind: "global" },
                path: "lessons/prop.md",
                name: "prop.md",
                type: "memory",
                trust: "user",
                summary: "Proposed memory",
                kind: "note",
                status: "proposed",
              },
            ]
          : [],
      ),
      read: vi.fn<BrainClient["read"]>(async ({ tier }) => ({
        ...proposedEntry,
        tier,
        body: tier === 0 ? "" : proposedEntry.body,
      })),
    });

    await mountPanel(client, "inbox");
    expect(host?.textContent).toContain("injected into every turn prompt");

    // L6 & L8: switch to Memories, view link host on hover, and edit proposed status
    const memTab = [...(host?.querySelectorAll<HTMLButtonElement>(".brain-tab") ?? [])].find((b) =>
      b.textContent?.includes("Memories"),
    );
    await act(async () => {
      memTab?.click();
    });
    await flush();

    await act(async () => {
      host?.querySelector<HTMLButtonElement>(".brain-tree-row")?.click();
    });
    await flush();

    const anchor = host?.querySelector<HTMLAnchorElement>(".brain-body-card a");
    expect(anchor?.getAttribute("target")).toBe("_blank");
    expect(anchor?.getAttribute("rel")).toBe("noreferrer noopener");
    expect(anchor?.getAttribute("title")).toBe("example.com");

    const editBtn = [...(host?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
      (b) => b.textContent?.trim() === "Edit",
    );
    await act(async () => {
      editBtn?.click();
    });
    const selects = [
      ...(host?.querySelectorAll<HTMLSelectElement>("select.settings-select") ?? []),
    ];
    const statusSelect = selects.find((s) =>
      [...s.options].some((opt) => opt.value === "archived"),
    );
    expect(statusSelect?.value).toBe("proposed");
    expect([...(statusSelect?.options ?? [])].some((opt) => opt.value === "proposed")).toBe(true);
  });

  it("XSS: escapes scripts, SVG-looking text, data: links, and enforces target/rel across fields and inbox", async () => {
    const xssPayload = '<script>window.__xss=1</script><svg onload="alert(1)"><circle /></svg>';
    const bodyPayload = `${xssPayload}\n\n[bad](data:text/html,<script>alert(1)</script>)\n\n[ok](https://docs.example.org/path)`;
    const repoUri = `brain://project/p1/<img src=x onerror=alert(1)>.md`;

    const client = makeFakeClient({
      list: vi.fn<BrainClient["list"]>(async ({ uri }) =>
        uri === "brain://project/p1/"
          ? [
              {
                uri: repoUri,
                scope: { kind: "project", projectId: "p1" },
                path: "<img src=x onerror=alert(1)>.md",
                name: "<img src=x onerror=alert(1)>.md",
                type: "memory",
                trust: "repo",
                summary: xssPayload,
                kind: "gotcha",
                status: "active",
              },
            ]
          : [],
      ),
      read: vi.fn<BrainClient["read"]>(async ({ tier }) => ({
        uri: repoUri,
        scope: { kind: "project", projectId: "p1" },
        path: "<img src=x onerror=alert(1)>.md",
        type: "memory",
        trust: "repo",
        tier,
        frontmatter: {
          summary: xssPayload,
          kind: "gotcha",
          tags: [xssPayload],
          status: "active",
          source: { agent: xssPayload },
          updatedAt: "2026-11-23T00:00:00.000Z",
        },
        body: tier === 0 ? "" : bodyPayload,
      })),
      listInbox: vi.fn<BrainClient["listInbox"]>(async () => [
        {
          id: "xss-inbox",
          targetUri: `brain://global/<script>alert(1)</script>.md`,
          summary: xssPayload,
          kind: "gotcha",
          tags: [xssPayload],
          body: bodyPayload,
          source: { agent: xssPayload },
        },
      ]),
    });

    await mountPanel(client);
    const p1Btn = [...(host?.querySelectorAll<HTMLButtonElement>(".brain-scope-btn") ?? [])].find(
      (b) => b.textContent?.includes("orders-api"),
    );
    await act(async () => {
      p1Btn?.click();
    });
    await flush();
    await act(async () => {
      host?.querySelector<HTMLButtonElement>(".brain-tree-row")?.click();
    });
    await flush();

    // Check browse detail XSS safety
    expect(host?.querySelector("script")).toBeNull();
    expect(host?.querySelector(".brain-body-card svg")).toBeNull();
    expect(host?.querySelector(".brain-fm-summary svg")).toBeNull();
    expect(host?.querySelector(".brain-tags svg")).toBeNull();
    expect(host?.querySelector(".brain-fm-source svg")).toBeNull();
    expect(host?.querySelector(".brain-detail-uri svg")).toBeNull();
    expect(host?.querySelector('a[href^="data:"]')).toBeNull();
    const safeLink = host?.querySelector<HTMLAnchorElement>('.brain-body-card a[href^="https://"]');
    expect(safeLink?.getAttribute("target")).toBe("_blank");
    expect(safeLink?.getAttribute("rel")).toBe("noreferrer noopener");
    expect(host?.querySelector(".brain-fm-summary")?.textContent).toContain("<script>");
    expect(host?.querySelector(".brain-tag")?.textContent).toContain("<svg");
    expect(host?.querySelector(".brain-fm-source")?.textContent).toContain("<script>");
    expect(host?.querySelector(".brain-detail-uri")?.textContent).toContain("<img");

    // Check inbox XSS safety
    const inboxTab = [...(host?.querySelectorAll<HTMLButtonElement>(".brain-tab") ?? [])].find(
      (b) => b.textContent?.includes("Inbox"),
    );
    await act(async () => {
      inboxTab?.click();
    });
    await flush();

    expect(host?.querySelector("script")).toBeNull();
    expect(host?.querySelector(".brain-inbox-body svg")).toBeNull();
    expect(host?.querySelector('a[href^="data:"]')).toBeNull();
    const inboxLink = host?.querySelector<HTMLAnchorElement>(
      '.brain-inbox-body a[href^="https://"]',
    );
    expect(inboxLink?.getAttribute("target")).toBe("_blank");
    expect(inboxLink?.getAttribute("rel")).toBe("noreferrer noopener");
    expect(host?.querySelector(".brain-inbox-card .brain-fm-summary")?.textContent).toContain(
      "<script>",
    );
    expect(host?.querySelector(".brain-inbox-card .brain-tag")?.textContent).toContain("<svg");
    expect(host?.querySelector(".brain-inbox-source")?.textContent).toContain("<script>");
    expect(host?.querySelector(".brain-inbox-uri")?.textContent).toContain("<script>");
  });
});
