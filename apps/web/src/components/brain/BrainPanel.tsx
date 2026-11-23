import {
  formatBrainUri,
  type BrainEntry,
  type BrainInboxItem,
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
  type BrainInboxApproveEdits,
} from "../../brain/client.ts";
import { ancestorFolderUris, parentFolderUri } from "../../brain/validation.ts";
import { useStore } from "../../state/store.ts";
import { isPhone } from "../anywhere/phone/phone.tsx";
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
  const [createExistsUri, setCreateExistsUri] = useState<{
    uri: string;
    scope: BrainScope;
  } | null>(null);
  const [conflict, setConflict] = useState<BrainConflictState | null>(null);
  const [mobilePane, setMobilePane] = useState<"list" | "detail">("list");
  const [reindexing, setReindexing] = useState(false);

  const [inboxProposals, setInboxProposals] = useState<BrainInboxItem[]>([]);
  const [inboxLoading, setInboxLoading] = useState(false);
  const [inboxError, setInboxError] = useState<string | null>(null);

  const readSeqRef = useRef(0);
  const searchSeqRef = useRef(0);
  const navTokenRef = useRef(0);
  const nodesByDirRef = useRef(nodesByDir);
  const expandedUrisRef = useRef(expandedUris);
  const includeArchivedRef = useRef(includeArchived);
  const inboxProposalsRef = useRef(inboxProposals);
  const pendingFocusRef = useRef<"edit" | "tree" | "new" | null>(null);
  const newMemoryBtnRef = useRef<HTMLButtonElement | null>(null);
  const treeScrollRef = useRef<HTMLDivElement | null>(null);
  const editButtonRef = useRef<HTMLButtonElement | null>(null);

  const activeProjectRemoved =
    activeScope.kind === "project" &&
    !projects.some((project) => project.id === activeScope.projectId);
  const effectiveScope: BrainScope = useMemo(
    () => (activeProjectRemoved ? { kind: "global" } : activeScope),
    [activeProjectRemoved, activeScope],
  );
  const effectiveSelectedUri = activeProjectRemoved ? null : selectedUri;
  const effectiveEntry = activeProjectRemoved ? null : entry;
  const effectiveMode = activeProjectRemoved && mode === "edit" ? "view" : mode;

  const rootUri = formatBrainUri(effectiveScope);
  const rootUriRef = useRef(rootUri);
  const scopeArchivedRef = useRef<Record<string, boolean>>({});

  // sync: keep imperative refs aligned with committed state for async write/refresh handlers
  useEffect(() => {
    nodesByDirRef.current = nodesByDir;
    expandedUrisRef.current = expandedUris;
    includeArchivedRef.current = includeArchived;
    inboxProposalsRef.current = inboxProposals;
    rootUriRef.current = rootUri;
    scopeArchivedRef.current[rootUri] = includeArchived;
  }, [nodesByDir, expandedUris, includeArchived, inboxProposals, rootUri]);

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
      inboxProposalsRef.current = proposals;
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
        inboxProposalsRef.current = proposals;
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

  // sync: move DOM focus to the next control after form save, cancel, or memory removal
  useEffect(() => {
    if (effectiveMode !== "view" || busy) return;
    const target = pendingFocusRef.current;
    if (!target) return;
    pendingFocusRef.current = null;
    if (target === "edit" && editButtonRef.current) {
      editButtonRef.current.focus();
      return;
    }
    if (target === "tree") {
      const row =
        treeScrollRef.current?.querySelector<HTMLButtonElement>('.brain-tree-row[tabindex="0"]') ??
        treeScrollRef.current?.querySelector<HTMLButtonElement>(".brain-tree-row");
      if (row) {
        row.focus();
        return;
      }
    }
    newMemoryBtnRef.current?.focus();
  }, [effectiveMode, busy]);

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
        : [effectiveScope];
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
    [client, searchAllScopes, projects, effectiveScope, includeArchived],
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

  const bumpNav = () => {
    navTokenRef.current += 1;
    setBusy(false);
    setCreateExistsUri(null);
  };

  const openNode = (uri: string, isMemory: boolean, initialTier: BrainTier) => {
    bumpNav();
    if (uri !== selectedUri) setEntry(null);
    setSelectedUri(uri);
    setSelectedTier(initialTier);
    setMode("view");
    setMobilePane("detail");
    void readEntry(uri, initialTier, isMemory);
  };

  const refreshAncestorsOf = useCallback(
    async (uri: string) => {
      const ancestors = ancestorFolderUris(uri);
      if (ancestors.length === 0) return;
      const targets = ancestors.filter(
        (dirUri) =>
          Object.hasOwn(nodesByDirRef.current, dirUri) ||
          expandedUrisRef.current.has(dirUri) ||
          dirUri === rootUriRef.current,
      );
      const nextNodes = { ...nodesByDirRef.current };
      for (const dirUri of ancestors) delete nextNodes[dirUri];
      nodesByDirRef.current = nextNodes;
      setNodesByDir(nextNodes);
      await Promise.all(targets.map((dirUri) => loadDirectory(dirUri, includeArchivedRef.current)));
    },
    [loadDirectory],
  );

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
    if (isPhone()) return;
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
    bumpNav();
    readSeqRef.current += 1;
    const nextRoot = formatBrainUri(scope);
    const archived = includeArchivedRef.current;
    if (
      Object.hasOwn(scopeArchivedRef.current, nextRoot) &&
      scopeArchivedRef.current[nextRoot] !== archived
    ) {
      const nextNodes: Record<string, BrainTreeNode[]> = {};
      for (const [k, v] of Object.entries(nodesByDirRef.current)) {
        if (!k.startsWith(nextRoot)) nextNodes[k] = v;
      }
      nodesByDirRef.current = nextNodes;
      setNodesByDir(nextNodes);
      for (const dirUri of expandedUrisRef.current) {
        if (dirUri.startsWith(nextRoot) && dirUri !== nextRoot) {
          void loadDirectory(dirUri, archived);
        }
      }
    }
    scopeArchivedRef.current[nextRoot] = archived;
    setActiveScope(scope);
    setSelectedUri(null);
    setEntry(null);
    setEntryError(null);
    setActionError(null);
    setConflict(null);
    setMode("view");
  };

  const handleToggleIncludeArchived = () => {
    const nextArchived = !includeArchived;
    setIncludeArchived(nextArchived);
    scopeArchivedRef.current[rootUri] = nextArchived;
    const nextNodes: Record<string, BrainTreeNode[]> = {};
    for (const [k, v] of Object.entries(nodesByDirRef.current)) {
      if (!k.startsWith(rootUri)) nextNodes[k] = v;
    }
    nodesByDirRef.current = nextNodes;
    setNodesByDir(nextNodes);
    setErrorByDir((prev) => {
      const next: Record<string, string | null> = {};
      for (const [k, v] of Object.entries(prev)) {
        if (!k.startsWith(rootUri)) next[k] = v;
      }
      return next;
    });
    for (const dirUri of expandedUrisRef.current) {
      if (dirUri.startsWith(rootUri) && dirUri !== rootUri) {
        void loadDirectory(dirUri, nextArchived);
      }
    }
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
    sourceTier: BrainTier = 2,
    navToken = navTokenRef.current,
  ) => {
    if (sourceTier < 2) {
      setActionError("Load full memory (L2) before updating.");
      return;
    }
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
      setPinnedUris((prev) => ({ ...prev, [uri]: input.frontmatter.pinned === true }));
      await refreshAncestorsOf(uri);
      if (navToken !== navTokenRef.current) return;
      pendingFocusRef.current = "edit";
      setMode("view");
      setSelectedUri(uri);
      setSelectedTier(2);
      await readEntry(uri, 2, true);
    } catch (error) {
      if (navToken !== navTokenRef.current) return;
      if (isBrainErrorCode(error, "conflict")) {
        const message = brainErrorMessage(
          error,
          "This memory changed since you opened it. Reload or overwrite.",
        );
        try {
          const latest = await client.read({ uri, tier: 2 });
          if (navToken !== navTokenRef.current) return;
          setConflict({ uri, message, latest, missing: false, readError: null });
        } catch (readErr) {
          if (navToken !== navTokenRef.current) return;
          const missing = isBrainErrorCode(readErr, "not_found");
          setConflict({
            uri,
            message,
            latest: null,
            missing,
            readError: missing
              ? null
              : brainErrorMessage(readErr, "Could not load the latest version."),
          });
        }
      } else {
        setActionError(brainErrorMessage(error, "Could not save memory."));
      }
    } finally {
      if (navToken === navTokenRef.current) setBusy(false);
    }
  };

  const handleRetryConflictRead = async () => {
    if (!conflict) return;
    const navToken = navTokenRef.current;
    setBusy(true);
    try {
      const latest = await client.read({ uri: conflict.uri, tier: 2 });
      if (navToken !== navTokenRef.current) return;
      setConflict({
        uri: conflict.uri,
        message: conflict.message,
        latest,
        missing: false,
        readError: null,
      });
    } catch (readErr) {
      if (navToken !== navTokenRef.current) return;
      const missing = isBrainErrorCode(readErr, "not_found");
      setConflict({
        uri: conflict.uri,
        message: conflict.message,
        latest: null,
        missing,
        readError: missing
          ? null
          : brainErrorMessage(readErr, "Could not load the latest version."),
      });
    } finally {
      if (navToken === navTokenRef.current) setBusy(false);
    }
  };

  const handleRecreateFromConflict = async (
    uri: string,
    input: { frontmatter: MemoryFrontmatterInput; body: string },
  ) => {
    const navToken = navTokenRef.current;
    setBusy(true);
    setActionError(null);
    try {
      await client.write({
        uri,
        frontmatter: input.frontmatter,
        body: input.body,
        expectedUpdatedAt: null,
      });
      setPinnedUris((prev) => ({ ...prev, [uri]: input.frontmatter.pinned === true }));
      await refreshAncestorsOf(uri);
      if (navToken !== navTokenRef.current) return;
      pendingFocusRef.current = "edit";
      setConflict(null);
      setMode("view");
      setSelectedUri(uri);
      setSelectedTier(2);
      await readEntry(uri, 2, true);
    } catch (error) {
      if (navToken !== navTokenRef.current) return;
      if (isBrainErrorCode(error, "conflict")) {
        const message =
          "This memory now exists on disk. Reload or overwrite with the latest version.";
        try {
          const latest = await client.read({ uri, tier: 2 });
          if (navToken !== navTokenRef.current) return;
          setConflict({ uri, message, latest, missing: false, readError: null });
        } catch (readErr) {
          if (navToken !== navTokenRef.current) return;
          setConflict({
            uri,
            message,
            latest: null,
            missing: false,
            readError: brainErrorMessage(readErr, "Could not load the latest version."),
          });
        }
      } else {
        setActionError(brainErrorMessage(error, "Could not recreate memory."));
      }
    } finally {
      if (navToken === navTokenRef.current) setBusy(false);
    }
  };

  const resolveTier2Memory = async (current: BrainEntry): Promise<BrainEntry | null> => {
    if (current.type !== "memory") return null;
    if (current.tier >= 2) return current;
    const loaded = await client.read({ uri: current.uri, tier: 2 });
    if (loaded.type !== "memory" || loaded.tier < 2) {
      throw new Error("Load full memory (L2) before editing or updating.");
    }
    return loaded;
  };

  const handleCreate = async (input: {
    scope: BrainScope;
    path: string;
    frontmatter: MemoryFrontmatterInput;
    body: string;
  }) => {
    const navToken = navTokenRef.current;
    const uri = formatBrainUri(input.scope, input.path);
    setBusy(true);
    setActionError(null);
    setCreateExistsUri(null);
    try {
      await client.write({
        uri,
        frontmatter: input.frontmatter,
        body: input.body,
        expectedUpdatedAt: null,
      });
      if (input.scope.kind === "project") {
        const { projectId } = input.scope;
        setProjectHasBrain((prev) => ({ ...prev, [projectId]: true }));
      }
      setPinnedUris((prev) => ({ ...prev, [uri]: input.frontmatter.pinned === true }));
      await refreshAncestorsOf(uri);
      if (navToken !== navTokenRef.current) return;
      pendingFocusRef.current = "edit";
      setActiveScope(input.scope);
      setMode("view");
      setSelectedUri(uri);
      setSelectedTier(2);
      await readEntry(uri, 2, true);
    } catch (error) {
      if (navToken !== navTokenRef.current) return;
      if (isBrainErrorCode(error, "conflict")) {
        setCreateExistsUri({ uri, scope: input.scope });
        setActionError("That memory already exists; open it and edit it instead");
      } else {
        setActionError(brainErrorMessage(error, "Could not create memory."));
      }
    } finally {
      if (navToken === navTokenRef.current) setBusy(false);
    }
  };

  const handleStartEdit = async () => {
    if (!entry || entry.type !== "memory") return;
    const navToken = navTokenRef.current;
    setActionError(null);
    setConflict(null);
    if (entry.tier < 2) {
      setBusy(true);
      try {
        const loaded = await resolveTier2Memory(entry);
        if (navToken !== navTokenRef.current || !loaded) return;
        setEntry(loaded);
        setSelectedTier(2);
      } catch (error) {
        if (navToken !== navTokenRef.current) return;
        setActionError(brainErrorMessage(error, "Could not load full memory for editing."));
        return;
      } finally {
        if (navToken === navTokenRef.current) setBusy(false);
      }
    }
    if (navToken !== navTokenRef.current) return;
    setMode("edit");
  };

  const handleTogglePin = async () => {
    if (!entry || entry.type !== "memory") return;
    const navToken = navTokenRef.current;
    let target = entry;
    if (target.tier < 2) {
      setBusy(true);
      setActionError(null);
      try {
        const loaded = await resolveTier2Memory(target);
        if (navToken !== navTokenRef.current || !loaded) return;
        target = loaded;
        setEntry(loaded);
      } catch (error) {
        if (navToken !== navTokenRef.current) return;
        setActionError(brainErrorMessage(error, "Could not load full memory before pinning."));
        setBusy(false);
        return;
      }
    }
    const { updatedAt, ...rest } = target.frontmatter;
    await writeAndHandleConflict(
      target.uri,
      {
        frontmatter: { ...rest, pinned: !target.frontmatter.pinned },
        body: target.body,
      },
      updatedAt,
      target.tier,
      navToken,
    );
  };

  const handleArchive = async () => {
    if (!entry || entry.type !== "memory") return;
    const navToken = navTokenRef.current;
    const uri = entry.uri;
    const tier = selectedTier;
    setBusy(true);
    setActionError(null);
    try {
      await client.archive({ uri });
      await refreshAncestorsOf(uri);
      if (navToken !== navTokenRef.current) return;
      await readEntry(uri, tier, true);
    } catch (error) {
      if (navToken !== navTokenRef.current) return;
      setActionError(brainErrorMessage(error, "Could not archive memory."));
    } finally {
      if (navToken === navTokenRef.current) setBusy(false);
    }
  };

  const handleUnarchive = async () => {
    if (!entry || entry.type !== "memory") return;
    const navToken = navTokenRef.current;
    let target = entry;
    if (target.tier < 2) {
      setBusy(true);
      setActionError(null);
      try {
        const loaded = await resolveTier2Memory(target);
        if (navToken !== navTokenRef.current || !loaded) return;
        target = loaded;
        setEntry(loaded);
      } catch (error) {
        if (navToken !== navTokenRef.current) return;
        setActionError(brainErrorMessage(error, "Could not load full memory before restoring."));
        setBusy(false);
        return;
      }
    }
    const { updatedAt, ...rest } = target.frontmatter;
    await writeAndHandleConflict(
      target.uri,
      {
        frontmatter: { ...rest, status: "active" },
        body: target.body,
      },
      updatedAt,
      target.tier,
      navToken,
    );
  };

  const handleRemove = async (): Promise<boolean> => {
    if (!entry || entry.type !== "memory") return false;
    const navToken = navTokenRef.current;
    const uri = entry.uri;
    const scope = entry.scope;
    setBusy(true);
    setActionError(null);
    try {
      await client.remove({ uri });
      await refreshAncestorsOf(uri);
      if (scope.kind === "project") {
        const { projectId } = scope;
        const remaining = await client.list({
          uri: formatBrainUri(scope),
          includeArchived: true,
        });
        setProjectHasBrain((prev) => ({
          ...prev,
          [projectId]: remaining.length > 0,
        }));
      }
      if (navToken !== navTokenRef.current) return false;
      pendingFocusRef.current = "tree";
      setEntry(null);
      setSelectedUri(null);
      setMode("view");
      setMobilePane("list");
      return true;
    } catch (error) {
      if (navToken !== navTokenRef.current) return false;
      setActionError(brainErrorMessage(error, "Could not remove memory."));
      return false;
    } finally {
      if (navToken === navTokenRef.current) setBusy(false);
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
    edits?: BrainInboxApproveEdits,
  ): Promise<string | null> => {
    const proposalUri =
      inboxProposalsRef.current.find((item) => item.id === id)?.targetUri ??
      formatBrainUri({ kind: "global" });
    try {
      await client.approveInbox(id, edits);
      const next = inboxProposalsRef.current.filter((item) => item.id !== id);
      inboxProposalsRef.current = next;
      setInboxProposals(next);
      useStore.setState({ brainInboxCount: next.length });
      await refreshAncestorsOf(proposalUri);
      return null;
    } catch (error) {
      if (isBrainErrorCode(error, "conflict")) void loadInbox();
      return brainErrorMessage(error, "Could not approve proposal.");
    }
  };

  const handleRejectInbox = async (id: string): Promise<string | null> => {
    try {
      await client.rejectInbox(id);
      const next = inboxProposalsRef.current.filter((item) => item.id !== id);
      inboxProposalsRef.current = next;
      setInboxProposals(next);
      useStore.setState({ brainInboxCount: next.length });
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
            ref={newMemoryBtnRef}
            type="button"
            className="button primary"
            onClick={() => {
              bumpNav();
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
            activeScope={effectiveScope}
            projects={projects}
            projectHasBrain={projectHasBrain}
            onSelectScope={handleSelectScope}
            searchQuery={searchQuery}
            onSearchQueryChange={handleSearchQueryChange}
            onSearchSubmit={() => void runSearch(searchQuery)}
            searchAllScopes={searchAllScopes}
            onToggleSearchAllScopes={() => setSearchAllScopes((prev) => !prev)}
            includeArchived={includeArchived}
            onToggleIncludeArchived={handleToggleIncludeArchived}
            searchResults={searchResults}
            searchLoading={searchLoading}
            searchError={searchError}
            onRetrySearch={() => void runSearch(searchQuery)}
            nodesByDir={nodesByDir}
            loadingDirs={loadingDirs}
            errorByDir={errorByDir}
            expandedUris={expandedUris}
            selectedUri={effectiveSelectedUri}
            pinnedUris={pinnedUris}
            reindexing={reindexing}
            onReindex={() => void handleReindex()}
            onRefreshRoot={() => void loadDirectory(rootUri, includeArchived)}
            onToggleFolder={handleToggleFolder}
            onExpandFolder={handleExpandFolder}
            onCollapseFolder={handleCollapseFolder}
            onSelectNode={(node) => openNode(node.uri, true, 2)}
            onSelectSearchHit={handleSelectSearchHit}
            treeScrollRef={treeScrollRef}
          />
          <BrainDetail
            mode={effectiveMode}
            activeScope={effectiveScope}
            projects={projects}
            entry={effectiveEntry}
            selectedIsMemory={effectiveSelectedUri?.endsWith(".md") ?? false}
            tier={selectedTier}
            loading={entryLoading}
            error={entryError}
            busy={busy}
            actionError={actionError}
            existingCreateUri={createExistsUri?.uri ?? null}
            conflict={conflict}
            onBackToList={() => setMobilePane("list")}
            onChangeTier={handleChangeTier}
            onStartEdit={() => void handleStartEdit()}
            onCancelForm={() => {
              bumpNav();
              pendingFocusRef.current = effectiveEntry ? "edit" : "tree";
              setMode("view");
              setActionError(null);
              setConflict(null);
              if (!effectiveEntry) setMobilePane("list");
            }}
            editButtonRef={editButtonRef}
            onTogglePin={() => void handleTogglePin()}
            onArchive={() => void handleArchive()}
            onUnarchive={() => void handleUnarchive()}
            onRemove={handleRemove}
            onSaveEdit={(input) => {
              if (!entry) return;
              void writeAndHandleConflict(
                entry.uri,
                input,
                entry.frontmatter.updatedAt,
                entry.tier,
              );
            }}
            onCreate={(input) => void handleCreate(input)}
            onOpenExistingFromCreate={() => {
              if (!createExistsUri) return;
              const target = createExistsUri;
              setCreateExistsUri(null);
              setActiveScope(target.scope);
              openNode(target.uri, true, 2);
            }}
            onClearCreateExists={() => {
              if (createExistsUri) {
                setCreateExistsUri(null);
                setActionError(null);
              }
            }}
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
              if (!entry || !conflict?.latest) return;
              void writeAndHandleConflict(
                entry.uri,
                input,
                conflict.latest.frontmatter.updatedAt,
                conflict.latest.tier,
              );
            }}
            onResolveConflictRecreate={(input) => {
              if (!entry || !conflict?.missing) return;
              void handleRecreateFromConflict(entry.uri, input);
            }}
            onRetryConflictRead={() => void handleRetryConflictRead()}
            onDismissConflict={() => setConflict(null)}
          />
        </div>
      )}
    </section>
  );
}
