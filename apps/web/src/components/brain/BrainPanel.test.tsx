/**
 * @vitest-environment happy-dom
 */
import type { BrainEntry, BrainSearchHit, BrainTreeNode } from "@wooky/contracts";
import { emptyReadModel } from "@wooky/domain";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrainClient, BrainInboxProposal } from "../../brain/client.ts";
import { RpcCallError } from "../../rpc/client.ts";
import { useStore } from "../../state/store.ts";
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
      body: "Body",
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
});
