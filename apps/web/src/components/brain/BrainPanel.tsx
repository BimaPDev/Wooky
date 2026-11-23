import {
  formatBrainUri,
  type BrainEntry,
  type BrainScope,
  type BrainSearchHit,
  type BrainTier,
  type BrainTreeNode,
  type MemoryFrontmatterInput,
} from "@wooky/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  brainErrorMessage,
  createBrainClient,
  isBrainErrorCode,
  type BrainClient,
  type BrainInboxEditOverrides,
  type BrainInboxProposal,
} from "../../brain/client.ts";
import { parentFolderUri } from "../../brain/validation.ts";
import { useStore } from "../../state/store.ts";
import { IconPlus } from "../Icons.tsx";
import { BrainDetail, type BrainConflictState } from "./BrainDetail.tsx";
import { IconBrain, IconInbox } from "./BrainIcons.tsx";
import { BrainInbox } from "./BrainInbox.tsx";
import { BrainTree } from "./BrainTree.tsx";

export interface BrainPanelProps {
  client?: BrainClient;
  initialTab?: "browse" | "inbox";
  searchDebounceMs?: number;
}

export function BrainPanel({
  client: propClient,
  initialTab = "browse",
  searchDebounceMs = 150,
}: BrainPanelProps) {
  const client = useMemo(() => propClient ?? createBrainClient(), [propClient]);
  const projectsMap = useStore((state) => state.model.projects);
  const threadsMap = useStore((state) => state.model.threads);
  const projects = useMemo(
    () =>
      Object.values(projectsMap)
        .filter((project) => !project.scratch)
        .toSorted((a, b) => a.name.localeCompare(b.name)),
    [projectsMap],
  );

  const [tab, setTab] = useState<"browse" | "inbox">(initialTab);
  const [activeScope, setActiveScope] = useState<BrainScope>({ kind: "global" });
  const [projectHasBrain, setProjectHasBrain] = useState<Record<string, boolean>>({});
  const [includeArchived, setIncludeArchived] = useState(false);

  const [nodesByDir, setNodesByDir] = useState<Record<string, BrainTreeNode[]>>({});
  const [loadingDirs, setLoadingDirs] = useState<Record<string, boolean>>({});
  const [errorByDir, setErrorByDir] = useState<Record<string, string | null>>({});
  const [expandedUris, setExpandedUris] = useState<Set<string>>(() => new Set());
  const [pinnedUris, setPinnedUris] = useState<Record<string, boolean>>({});

  const [searchQuery, setSearchQuery] = useState("");
  const [searchAllScopes, setSearchAllScopes] = useState(false);
  const [searchResults, setSearchResults] = useState<BrainSearchHit[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [selectedUri, setSelectedUri] = useState<string | null>(null);
  const [selectedTier, setSelectedTier] = useState<BrainTier>(2);
  const [entry, setEntry] = useState<BrainEntry | null>(null);
  const [entryLoading, setEntryLoading] = useState(false);
  const [entryError, setEntryError] = useState<string | null>(null);
  const [mode, setMode] = useState<"view" | "edit" | "create">("view");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<BrainConflictState | null>(null);
  const [mobilePane, setMobilePane] = useState<"list" | "detail">("list");
  const [reindexing, setReindexing] = useState(false);

  const [inboxProposals, setInboxProposals] = useState<BrainInboxProposal[]>([]);
  const [inboxLoading, setInboxLoading] = useState(false);
  const [inboxError, setInboxError] = useState<string | null>(null);

  const readSeqRef = useRef(0);
  const searchSeqRef = useRef(0);

  const rootUri = formatBrainUri(activeScope);

  const loadDirectory = useCallback(
    async (dirUri: string, archived: boolean) => {
      setLoadingDirs((prev) => ({ ...prev, [dirUri]: true }));
      setErrorByDir((prev) => ({ ...prev, [dirUri]: null }));
      try {
        const nodes = await client.list({
          uri: dirUri,
          ...(archived ? { includeArchived: true } : {}),
        });
        setNodesByDir((prev) => ({ ...prev, [dirUri]: nodes }));
        setLoadingDirs((prev) => ({ ...prev, [dirUri]: false }));
      } catch (error) {
        setErrorByDir((prev) => ({
          ...prev,
          [dirUri]: brainErrorMessage(error, "Could not load folder."),
        }));
        setLoadingDirs((prev) => ({ ...prev, [dirUri]: false }));
      }
    },
    [client],
  );

  const loadInbox = useCallback(async () => {
    setInboxLoading(true);
    setInboxError(null);
    try {
      const proposals = await client.listInbox();
      setInboxProposals(proposals);
      useStore.setState({ brainInboxCount: proposals.length });
    } catch (error) {
      setInboxError(brainErrorMessage(error, "Could not load brain inbox."));
    } finally {
      setInboxLoading(false);
    }
  }, [client]);

  // sync: load root directory whenever the active scope or archived filter changes
  useEffect(() => {
    let cancelled = false;
    void client.list({ uri: rootUri, ...(includeArchived ? { includeArchived: true } : {}) }).then(
      (nodes) => {
        if (cancelled) return;
        setNodesByDir((prev) => ({ ...prev, [rootUri]: nodes }));
        setErrorByDir((prev) => ({ ...prev, [rootUri]: null }));
        setLoadingDirs((prev) => ({ ...prev, [rootUri]: false }));
      },
      (error) => {
        if (cancelled) return;
        setErrorByDir((prev) => ({
          ...prev,
          [rootUri]: brainErrorMessage(error, "Could not load folder."),
        }));
        setLoadingDirs((prev) => ({ ...prev, [rootUri]: false }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, rootUri, includeArchived]);

  // sync: probe which projects have a brain directory
  useEffect(() => {
    if (projects.length === 0) return;
    let cancelled = false;
    void Promise.allSettled(
      projects.map(async (project) => {
        const uri = formatBrainUri({ kind: "project", projectId: project.id });
        const nodes = await client.list({ uri, includeArchived: true });
        return { projectId: project.id, hasBrain: nodes.length > 0 };
      }),
    ).then((results) => {
      if (cancelled) return;
      const next: Record<string, boolean> = {};
      for (const result of results) {
        if (result.status === "fulfilled") next[result.value.projectId] = result.value.hasBrain;
      }
      setProjectHasBrain(next);
    });
    return () => {
      cancelled = true;
    };
  }, [client, projects]);

  // sync: load inbox proposals on mount so the tab badge and list stay fresh
  useEffect(() => {
    let cancelled = false;
    void client.listInbox().then(
      (proposals) => {
        if (cancelled) return;
        setInboxProposals(proposals);
        setInboxError(null);
        useStore.setState({ brainInboxCount: proposals.length });
      },
      (error) => {
        if (cancelled) return;
        setInboxError(brainErrorMessage(error, "Could not load brain inbox."));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client]);

  const runSearch = useCallback(
    async (query: string) => {
      const trimmed = query.trim();
      if (!trimmed) {
        setSearchResults(null);
        setSearchError(null);
        setSearchLoading(false);
        return;
      }
      const seq = ++searchSeqRef.current;
      setSearchLoading(true);
      setSearchError(null);
      const scopes: BrainScope[] = searchAllScopes
        ? [
            { kind: "global" },
            ...projects.map((p) => ({ kind: "project" as const, projectId: p.id })),
          ]
        : [activeScope];
      try {
        const hits = await client.search({
          query: trimmed,
          scopes,
          limit: 50,
          ...(includeArchived ? { includeArchived: true } : {}),
        });
        if (seq !== searchSeqRef.current) return;
        setSearchResults(hits);
      } catch (error) {
        if (seq !== searchSeqRef.current) return;
        setSearchError(brainErrorMessage(error, "Search failed."));
      } finally {
        if (seq === searchSeqRef.current) setSearchLoading(false);
      }
    },
    [client, searchAllScopes, projects, activeScope, includeArchived],
  );

  const handleSearchQueryChange = (nextQuery: string) => {
    setSearchQuery(nextQuery);
    if (!nextQuery.trim()) {
      searchSeqRef.current += 1;
      setSearchResults(null);
      setSearchError(null);
      setSearchLoading(false);
    }
  };

  // sync: run BM25 search when query or scope filter changes
  useEffect(() => {
    const trimmed = searchQuery.trim();
    if (!trimmed) return;
    const timer = setTimeout(
      () => {
        void runSearch(trimmed);
      },
      Math.max(0, searchDebounceMs),
    );
    return () => clearTimeout(timer);
  }, [searchQuery, searchDebounceMs, runSearch]);

  const readEntry = useCallback(
    async (uri: string, tier: BrainTier, isMemory: boolean) => {
      const seq = ++readSeqRef.current;
      setEntryLoading(true);
      setEntryError(null);
      setActionError(null);
      setConflict(null);
      const readUri = isMemory && tier === 1 ? (parentFolderUri(uri) ?? uri) : uri;
      try {
        const loaded = await client.read({ uri: readUri, tier });
        if (seq !== readSeqRef.current) return;
        setEntry(loaded);
        if (loaded.type === "memory") {
          setPinnedUris((prev) => ({
            ...prev,
            [loaded.uri]: loaded.frontmatter.pinned === true,
          }));
        }
      } catch (error) {
        if (seq !== readSeqRef.current) return;
        setEntry(null);
        setEntryError(brainErrorMessage(error, "Could not read memory."));
      } finally {
        if (seq === readSeqRef.current) setEntryLoading(false);
      }
    },
    [client],
  );

  const openNode = (uri: string, isMemory: boolean, initialTier: BrainTier) => {
    if (uri !== selectedUri) setEntry(null);
    setSelectedUri(uri);
    setSelectedTier(initialTier);
    setMode("view");
    setMobilePane("detail");
    void readEntry(uri, initialTier, isMemory);
  };

  const refreshParentOf = async (uri: string) => {
    const parent = parentFolderUri(uri);
    if (parent) await loadDirectory(parent, includeArchived);
    if (parent !== rootUri) await loadDirectory(rootUri, includeArchived);
  };

  const handleToggleFolder = (node: BrainTreeNode) => {
    setExpandedUris((prev) => {
      const next = new Set(prev);
      if (next.has(node.uri)) {
        next.delete(node.uri);
      } else {
        next.add(node.uri);
        if (!nodesByDir[node.uri]) void loadDirectory(node.uri, includeArchived);
      }
      return next;
    });
    openNode(node.uri, false, 1);
  };

  const handleExpandFolder = (node: BrainTreeNode) => {
    setExpandedUris((prev) => {
      if (prev.has(node.uri)) return prev;
      const next = new Set(prev);
      next.add(node.uri);
      return next;
    });
    if (!nodesByDir[node.uri]) void loadDirectory(node.uri, includeArchived);
  };

  const handleCollapseFolder = (uri: string) => {
    setExpandedUris((prev) => {
      if (!prev.has(uri)) return prev;
      const next = new Set(prev);
      next.delete(uri);
      return next;
    });
  };

  const handleSelectScope = (scope: BrainScope) => {
    setActiveScope(scope);
    setSelectedUri(null);
    setEntry(null);
    setEntryError(null);
    setActionError(null);
    setConflict(null);
    setMode("view");
  };

  const handleSelectSearchHit = (hit: BrainSearchHit) => {
    setActiveScope(hit.scope);
    openNode(hit.uri, true, 2);
  };

  const handleChangeTier = (nextTier: BrainTier) => {
    if (!selectedUri) return;
    const isMemory = selectedUri.endsWith(".md");
    setSelectedTier(nextTier);
    void readEntry(selectedUri, nextTier, isMemory);
  };

  const writeAndHandleConflict = async (
    uri: string,
    input: { frontmatter: MemoryFrontmatterInput; body: string },
    expectedUpdatedAt?: string,
  ) => {
    setBusy(true);
    setActionError(null);
    setConflict(null);
    try {
      await client.write({
        uri,
        frontmatter: input.frontmatter,
        body: input.body,
        ...(expectedUpdatedAt !== undefined ? { expectedUpdatedAt } : {}),
      });
      setMode("view");
      setSelectedUri(uri);
      setSelectedTier(2);
      setPinnedUris((prev) => ({ ...prev, [uri]: input.frontmatter.pinned === true }));
      await readEntry(uri, 2, true);
      await refreshParentOf(uri);
    } catch (error) {
      if (isBrainErrorCode(error, "conflict")) {
        const message = brainErrorMessage(
          error,
          "This memory changed since you opened it. Reload or overwrite.",
        );
        try {
          const latest = await client.read({ uri, tier: 2 });
          setConflict({ message, latest, missing: false });
        } catch (readErr) {
          setConflict({
            message,
            latest: null,
            missing: isBrainErrorCode(readErr, "not_found"),
          });
        }
      } else {
        setActionError(brainErrorMessage(error, "Could not save memory."));
      }
    } finally {
      setBusy(false);
    }
  };

  const handleCreate = async (input: {
    scope: BrainScope;
    path: string;
    frontmatter: MemoryFrontmatterInput;
    body: string;
  }) => {
    const uri = formatBrainUri(input.scope, input.path);
    setBusy(true);
    setActionError(null);
    try {
      await client.write({
        uri,
        frontmatter: input.frontmatter,
        body: input.body,
      });
      if (input.scope.kind === "project") {
        const { projectId } = input.scope;
        setProjectHasBrain((prev) => ({ ...prev, [projectId]: true }));
      }
      setActiveScope(input.scope);
      setMode("view");
      setSelectedUri(uri);
      setSelectedTier(2);
      setPinnedUris((prev) => ({ ...prev, [uri]: input.frontmatter.pinned === true }));
      await readEntry(uri, 2, true);
      await loadDirectory(formatBrainUri(input.scope), includeArchived);
      const parent = parentFolderUri(uri);
      if (parent && parent !== formatBrainUri(input.scope)) {
        await loadDirectory(parent, includeArchived);
      }
    } catch (error) {
      setActionError(brainErrorMessage(error, "Could not create memory."));
    } finally {
      setBusy(false);
    }
  };

  const handleTogglePin = async () => {
    if (!entry || entry.type !== "memory") return;
    const { updatedAt, ...rest } = entry.frontmatter;
    await writeAndHandleConflict(
      entry.uri,
      {
        frontmatter: { ...rest, pinned: !entry.frontmatter.pinned },
        body: entry.body,
      },
      updatedAt,
    );
  };

  const handleArchive = async () => {
    if (!entry || entry.type !== "memory") return;
    setBusy(true);
    setActionError(null);
    try {
      await client.archive({ uri: entry.uri });
      await readEntry(entry.uri, selectedTier, true);
      await refreshParentOf(entry.uri);
    } catch (error) {
      setActionError(brainErrorMessage(error, "Could not archive memory."));
    } finally {
      setBusy(false);
    }
  };

  const handleUnarchive = async () => {
    if (!entry || entry.type !== "memory") return;
    const { updatedAt, ...rest } = entry.frontmatter;
    await writeAndHandleConflict(
      entry.uri,
      {
        frontmatter: { ...rest, status: "active" },
        body: entry.body,
      },
      updatedAt,
    );
  };

  const handleRemove = async (): Promise<boolean> => {
    if (!entry || entry.type !== "memory") return false;
    const uri = entry.uri;
    setBusy(true);
    setActionError(null);
    try {
      await client.remove({ uri });
      setEntry(null);
      setSelectedUri(null);
      setMode("view");
      setMobilePane("list");
      await refreshParentOf(uri);
      if (entry.scope.kind === "project") {
        const { projectId } = entry.scope;
        const remaining = await client.list({
          uri: formatBrainUri(entry.scope),
          includeArchived: true,
        });
        setProjectHasBrain((prev) => ({
          ...prev,
          [projectId]: remaining.length > 0,
        }));
      }
      return true;
    } catch (error) {
      setActionError(brainErrorMessage(error, "Could not remove memory."));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const handleReindex = async () => {
    setReindexing(true);
    setActionError(null);
    try {
      await client.reindex();
      if (searchQuery.trim()) await runSearch(searchQuery);
      await loadDirectory(rootUri, includeArchived);
    } catch (error) {
      setActionError(brainErrorMessage(error, "Reindex failed."));
    } finally {
      setReindexing(false);
    }
  };

  const handleApproveInbox = async (
    id: string,
    edits?: BrainInboxEditOverrides,
  ): Promise<string | null> => {
    try {
      await client.approveInbox(id, edits);
      setInboxProposals((prev) => {
        const next = prev.filter((item) => item.id !== id);
        useStore.setState({ brainInboxCount: next.length });
        return next;
      });
      await loadDirectory(formatBrainUri({ kind: "global" }), includeArchived);
      return null;
    } catch (error) {
      return brainErrorMessage(error, "Could not approve proposal.");
    }
  };

  const handleRejectInbox = async (id: string): Promise<string | null> => {
    try {
      await client.rejectInbox(id);
      setInboxProposals((prev) => {
        const next = prev.filter((item) => item.id !== id);
        useStore.setState({ brainInboxCount: next.length });
        return next;
      });
      return null;
    } catch (error) {
      return brainErrorMessage(error, "Could not reject proposal.");
    }
  };

  return (
    <section className="brain-panel" aria-label="Brain">
      <header className="brain-head">
        <div className="brain-head-left">
          <IconBrain />
          <h1 className="brain-title">Brain</h1>
          <div className="brain-tabs" role="tablist" aria-label="Brain views">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "browse"}
              className={tab === "browse" ? "brain-tab active" : "brain-tab"}
              onClick={() => setTab("browse")}
            >
              Memories
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "inbox"}
              className={tab === "inbox" ? "brain-tab active" : "brain-tab"}
              onClick={() => {
                setTab("inbox");
                void loadInbox();
              }}
            >
              <IconInbox />
              <span>Inbox</span>
              {inboxProposals.length > 0 ? (
                <span className="brain-count-badge">{inboxProposals.length}</span>
              ) : null}
            </button>
          </div>
        </div>
        {tab === "browse" ? (
          <button
            type="button"
            className="button primary"
            onClick={() => {
              setMode("create");
              setActionError(null);
              setConflict(null);
              setMobilePane("detail");
            }}
          >
            <IconPlus />
            <span>New memory</span>
          </button>
        ) : null}
      </header>

      {tab === "inbox" ? (
        <BrainInbox
          proposals={inboxProposals}
          loading={inboxLoading}
          error={inboxError}
          threads={threadsMap}
          onRetry={() => void loadInbox()}
          onApprove={handleApproveInbox}
          onReject={handleRejectInbox}
        />
      ) : (
        <div className={`brain-workspace mobile-${mobilePane}`}>
          <BrainTree
            activeScope={activeScope}
            projects={projects}
            projectHasBrain={projectHasBrain}
            onSelectScope={handleSelectScope}
            searchQuery={searchQuery}
            onSearchQueryChange={handleSearchQueryChange}
            onSearchSubmit={() => void runSearch(searchQuery)}
            searchAllScopes={searchAllScopes}
            onToggleSearchAllScopes={() => setSearchAllScopes((prev) => !prev)}
            includeArchived={includeArchived}
            onToggleIncludeArchived={() => setIncludeArchived((prev) => !prev)}
            searchResults={searchResults}
            searchLoading={searchLoading}
            searchError={searchError}
            onRetrySearch={() => void runSearch(searchQuery)}
            nodesByDir={nodesByDir}
            loadingDirs={loadingDirs}
            errorByDir={errorByDir}
            expandedUris={expandedUris}
            selectedUri={selectedUri}
            pinnedUris={pinnedUris}
            reindexing={reindexing}
            onReindex={() => void handleReindex()}
            onRefreshRoot={() => void loadDirectory(rootUri, includeArchived)}
            onToggleFolder={handleToggleFolder}
            onExpandFolder={handleExpandFolder}
            onCollapseFolder={handleCollapseFolder}
            onSelectNode={(node) => openNode(node.uri, true, 2)}
            onSelectSearchHit={handleSelectSearchHit}
          />
          <BrainDetail
            mode={mode}
            activeScope={activeScope}
            projects={projects}
            entry={entry}
            selectedIsMemory={selectedUri?.endsWith(".md") ?? false}
            tier={selectedTier}
            loading={entryLoading}
            error={entryError}
            busy={busy}
            actionError={actionError}
            conflict={conflict}
            onBackToList={() => setMobilePane("list")}
            onChangeTier={handleChangeTier}
            onStartEdit={() => {
              setMode("edit");
              setActionError(null);
              setConflict(null);
            }}
            onCancelForm={() => {
              setMode("view");
              setActionError(null);
              setConflict(null);
              if (!entry) setMobilePane("list");
            }}
            onTogglePin={() => void handleTogglePin()}
            onArchive={() => void handleArchive()}
            onUnarchive={() => void handleUnarchive()}
            onRemove={handleRemove}
            onSaveEdit={(input) => {
              if (!entry) return;
              void writeAndHandleConflict(entry.uri, input, entry.frontmatter.updatedAt);
            }}
            onCreate={(input) => void handleCreate(input)}
            onResolveConflictReload={() => {
              const latest = conflict?.latest;
              if (!latest) return;
              setEntry(latest);
              setPinnedUris((prev) => ({
                ...prev,
                [latest.uri]: latest.frontmatter.pinned === true,
              }));
              setConflict(null);
              setMode("view");
            }}
            onResolveConflictOverwrite={(input) => {
              if (!entry || !conflict) return;
              void writeAndHandleConflict(entry.uri, input, conflict.latest?.frontmatter.updatedAt);
            }}
            onDismissConflict={() => setConflict(null)}
          />
        </div>
      )}
    </section>
  );
}
