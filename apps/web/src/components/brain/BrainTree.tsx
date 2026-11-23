import {
  brainScopeKey,
  formatBrainUri,
  type BrainKind,
  type BrainScope,
  type BrainSearchHit,
  type BrainTreeNode,
  type Project,
} from "@wooky/contracts";
import { useMemo, useRef, type KeyboardEvent, type RefObject } from "react";
import { brainKindLabel } from "../../brain/validation.ts";
import { IconChevron, IconClose, IconFolder, IconRefresh, IconSearch } from "../Icons.tsx";
import { ProjectMonogram } from "../ProjectMonogram.tsx";
import { BrainKindIcon, IconPin } from "./BrainIcons.tsx";

export interface VisibleTreeItem {
  node: BrainTreeNode;
  depth: number;
  parentUri: string | null;
}

function nodeIsPinned(node: BrainTreeNode, pinnedUris: Readonly<Record<string, boolean>>): boolean {
  if (Object.hasOwn(pinnedUris, node.uri)) return pinnedUris[node.uri] === true;
  return (node as BrainTreeNode & { pinned?: boolean }).pinned === true;
}

function flattenTree(
  nodes: readonly BrainTreeNode[],
  depth: number,
  parentUri: string | null,
  expandedUris: ReadonlySet<string>,
  nodesByDir: Readonly<Record<string, BrainTreeNode[]>>,
): VisibleTreeItem[] {
  const out: VisibleTreeItem[] = [];
  const sorted = [...nodes].toSorted((a, b) => {
    if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const node of sorted) {
    out.push({ node, depth, parentUri });
    if (node.type === "folder" && expandedUris.has(node.uri)) {
      const children = nodesByDir[node.uri] ?? [];
      out.push(...flattenTree(children, depth + 1, node.uri, expandedUris, nodesByDir));
    }
  }
  return out;
}

export interface BrainTreeProps {
  activeScope: BrainScope;
  projects: readonly Project[];
  projectHasBrain: Readonly<Record<string, boolean>>;
  onSelectScope: (scope: BrainScope) => void;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  onSearchSubmit: () => void;
  searchAllScopes: boolean;
  onToggleSearchAllScopes: () => void;
  includeArchived: boolean;
  onToggleIncludeArchived: () => void;
  searchResults: readonly BrainSearchHit[] | null;
  searchLoading: boolean;
  searchError: string | null;
  onRetrySearch: () => void;
  nodesByDir: Readonly<Record<string, BrainTreeNode[]>>;
  loadingDirs: Readonly<Record<string, boolean>>;
  errorByDir: Readonly<Record<string, string | null>>;
  expandedUris: ReadonlySet<string>;
  selectedUri: string | null;
  pinnedUris: Readonly<Record<string, boolean>>;
  reindexing: boolean;
  onReindex: () => void;
  onRefreshRoot: () => void;
  onToggleFolder: (node: BrainTreeNode) => void;
  onExpandFolder: (node: BrainTreeNode) => void;
  onCollapseFolder: (uri: string) => void;
  onSelectNode: (node: BrainTreeNode) => void;
  onSelectSearchHit: (hit: BrainSearchHit) => void;
  treeScrollRef?: RefObject<HTMLDivElement | null>;
}

export function BrainTree({
  activeScope,
  projects,
  projectHasBrain,
  onSelectScope,
  searchQuery,
  onSearchQueryChange,
  onSearchSubmit,
  searchAllScopes,
  onToggleSearchAllScopes,
  includeArchived,
  onToggleIncludeArchived,
  searchResults,
  searchLoading,
  searchError,
  onRetrySearch,
  nodesByDir,
  loadingDirs,
  errorByDir,
  expandedUris,
  selectedUri,
  pinnedUris,
  reindexing,
  onReindex,
  onRefreshRoot,
  onToggleFolder,
  onExpandFolder,
  onCollapseFolder,
  onSelectNode,
  onSelectSearchHit,
  treeScrollRef,
}: BrainTreeProps) {
  const rootUri = formatBrainUri(activeScope);
  const rootNodes = useMemo(() => nodesByDir[rootUri] ?? [], [nodesByDir, rootUri]);
  const rootLoading =
    loadingDirs[rootUri] === true ||
    (nodesByDir[rootUri] === undefined && errorByDir[rootUri] === undefined);
  const rootError = errorByDir[rootUri] ?? null;
  const isSearching = searchQuery.trim().length > 0;
  const activeKey = brainScopeKey(activeScope);

  const visibleItems = useMemo(
    () => flattenTree(rootNodes, 0, null, expandedUris, nodesByDir),
    [rootNodes, expandedUris, nodesByDir],
  );

  const itemRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const projectNameById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );

  const focusUri = (uri: string) => {
    itemRefs.current.get(uri)?.focus();
  };

  const handleTreeKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const item = visibleItems[index];
    if (!item) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const next = visibleItems[index + 1];
      if (next) focusUri(next.node.uri);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      const prev = visibleItems[index - 1];
      if (prev) focusUri(prev.node.uri);
    } else if (event.key === "Home") {
      event.preventDefault();
      const first = visibleItems[0];
      if (first) focusUri(first.node.uri);
    } else if (event.key === "End") {
      event.preventDefault();
      const last = visibleItems.at(-1);
      if (last) focusUri(last.node.uri);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      if (item.node.type === "folder") {
        if (!expandedUris.has(item.node.uri)) {
          onExpandFolder(item.node);
        } else {
          const next = visibleItems[index + 1];
          if (next && next.parentUri === item.node.uri) focusUri(next.node.uri);
        }
      }
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (item.node.type === "folder" && expandedUris.has(item.node.uri)) {
        onCollapseFolder(item.node.uri);
      } else if (item.parentUri) {
        focusUri(item.parentUri);
      }
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (item.node.type === "folder") onToggleFolder(item.node);
      else onSelectNode(item.node);
    }
  };

  const scopeLabel = (scope: BrainScope) =>
    scope.kind === "global" ? "Global" : (projectNameById.get(scope.projectId) ?? scope.projectId);

  const activeFocusUri =
    selectedUri && visibleItems.some((item) => item.node.uri === selectedUri)
      ? selectedUri
      : visibleItems[0]?.node.uri;

  return (
    <div className="brain-nav-col">
      <div className="brain-scopes" role="group" aria-label="Brain scopes">
        <button
          type="button"
          className={activeKey === "global" ? "brain-scope-btn active" : "brain-scope-btn"}
          aria-pressed={activeKey === "global"}
          onClick={() => onSelectScope({ kind: "global" })}
        >
          <span>Global</span>
        </button>
        {projects.map((project) => {
          const scope: BrainScope = { kind: "project", projectId: project.id };
          const key = brainScopeKey(scope);
          const hasBrain = projectHasBrain[project.id] === true;
          return (
            <button
              key={project.id}
              type="button"
              className={activeKey === key ? "brain-scope-btn active" : "brain-scope-btn"}
              aria-pressed={activeKey === key}
              title={hasBrain ? `${project.name} (has brain)` : `${project.name} (no brain yet)`}
              onClick={() => onSelectScope(scope)}
            >
              <ProjectMonogram name={project.name} />
              <span className="brain-scope-name">{project.name}</span>
              {hasBrain ? (
                <span
                  className="brain-scope-dot"
                  aria-label="Has brain"
                  title="Project has brain memories"
                />
              ) : null}
            </button>
          );
        })}
      </div>

      <form
        className="brain-search-bar"
        onSubmit={(event) => {
          event.preventDefault();
          onSearchSubmit();
        }}
      >
        <label className="search-field brain-search-input">
          <IconSearch />
          <input
            value={searchQuery}
            placeholder="Search memories"
            aria-label="Search memories"
            onChange={(event) => onSearchQueryChange(event.target.value)}
          />
          {searchQuery ? (
            <button
              type="button"
              className="icon-button brain-search-clear"
              aria-label="Clear search"
              onClick={() => onSearchQueryChange("")}
            >
              <IconClose />
            </button>
          ) : null}
        </label>
        <div className="brain-filter-row">
          <label className="brain-filter-toggle">
            <input type="checkbox" checked={searchAllScopes} onChange={onToggleSearchAllScopes} />
            <span>All scopes</span>
          </label>
          <label className="brain-filter-toggle">
            <input type="checkbox" checked={includeArchived} onChange={onToggleIncludeArchived} />
            <span>Archived</span>
          </label>
          <button
            type="button"
            className="icon-button brain-reindex-btn"
            aria-label="Reindex search"
            title="Reindex search"
            disabled={reindexing}
            onClick={onReindex}
          >
            <IconRefresh />
          </button>
        </div>
      </form>

      <div ref={treeScrollRef} className="brain-tree-scroll">
        {isSearching ? (
          <div className="brain-search-results" aria-label="Search results">
            {searchLoading ? <p className="brain-status-msg">Searching…</p> : null}
            {!searchLoading && searchError ? (
              <div className="brain-error-box" role="alert">
                <p>{searchError}</p>
                <button type="button" className="button" onClick={onRetrySearch}>
                  Retry
                </button>
              </div>
            ) : null}
            {!searchLoading && !searchError && searchResults && searchResults.length === 0 ? (
              <p className="brain-status-msg">No matching memories.</p>
            ) : null}
            {!searchLoading && !searchError && searchResults && searchResults.length > 0 ? (
              <ul className="brain-hit-list" role="listbox" aria-label="Matching memories">
                {searchResults.map((hit) => (
                  <li key={hit.uri}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={selectedUri === hit.uri}
                      className={[
                        "brain-hit-row",
                        selectedUri === hit.uri ? "active" : null,
                        hit.status === "archived" ? "brain-node-archived" : null,
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      onClick={() => onSelectSearchHit(hit)}
                    >
                      <span className="brain-hit-head">
                        <BrainKindIcon kind={hit.kind} />
                        <span className="brain-hit-summary">{hit.summary}</span>
                      </span>
                      <span className="brain-hit-meta">
                        <span className="brain-scope-pill">{scopeLabel(hit.scope)}</span>
                        <span className="mono brain-hit-path">{hit.path}</span>
                        {hit.trust === "repo" ? (
                          <span className="brain-trust-badge">from this repo</span>
                        ) : null}
                        {hit.status === "archived" ? (
                          <span className="brain-archived-badge">archived</span>
                        ) : null}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : (
          <>
            {rootLoading && visibleItems.length === 0 ? (
              <p className="brain-status-msg">Loading memories…</p>
            ) : null}
            {!rootLoading && rootError ? (
              <div className="brain-error-box" role="alert">
                <p>{rootError}</p>
                <button type="button" className="button" onClick={onRefreshRoot}>
                  Retry
                </button>
              </div>
            ) : null}
            {!rootLoading && !rootError && visibleItems.length === 0 ? (
              <div className="brain-empty-tree">
                <p className="brain-status-msg">
                  {activeScope.kind === "global"
                    ? "No global memories yet."
                    : "This project has no brain memories yet."}
                </p>
              </div>
            ) : null}
            {visibleItems.length > 0 ? (
              <div className="brain-tree" role="tree" aria-label="Brain memories">
                {visibleItems.map((item, index) => {
                  const { node, depth } = item;
                  const isFolder = node.type === "folder";
                  const expanded = isFolder && expandedUris.has(node.uri);
                  const isSelected = selectedUri === node.uri;
                  const isPinned = !isFolder && nodeIsPinned(node, pinnedUris);
                  const isArchived = !isFolder && node.status === "archived";
                  const folderLoading = isFolder && loadingDirs[node.uri] === true;
                  const folderError = isFolder ? errorByDir[node.uri] : null;
                  const kind: BrainKind = node.kind ?? "note";

                  return (
                    <div key={node.uri} className="brain-tree-entry">
                      <button
                        ref={(el) => {
                          if (el) itemRefs.current.set(node.uri, el);
                          else itemRefs.current.delete(node.uri);
                        }}
                        type="button"
                        role="treeitem"
                        aria-level={depth + 1}
                        aria-expanded={isFolder ? expanded : undefined}
                        aria-selected={isSelected}
                        tabIndex={node.uri === activeFocusUri ? 0 : -1}
                        style={{ paddingLeft: `${8 + depth * 16}px` }}
                        className={[
                          "brain-tree-row",
                          isSelected ? "active" : null,
                          isArchived ? "brain-node-archived" : null,
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        onKeyDown={(event) => handleTreeKeyDown(event, index)}
                        onClick={() => {
                          if (isFolder) onToggleFolder(node);
                          else onSelectNode(node);
                        }}
                      >
                        {isFolder ? (
                          <span className="brain-tree-chevron">
                            <IconChevron open={expanded} />
                          </span>
                        ) : (
                          <span className="brain-tree-chevron-spacer" aria-hidden="true" />
                        )}
                        <span
                          className="brain-tree-icon"
                          title={isFolder ? "Folder" : brainKindLabel(kind)}
                        >
                          {isFolder ? <IconFolder /> : <BrainKindIcon kind={kind} />}
                        </span>
                        <span className="brain-tree-copy">
                          <span className="brain-tree-title-row">
                            <span className="brain-tree-name">{node.name}</span>
                            {isPinned ? (
                              <span className="brain-pin-mark" title="Pinned" aria-label="Pinned">
                                <IconPin filled />
                              </span>
                            ) : null}
                            {isArchived ? (
                              <span className="brain-archived-badge">archived</span>
                            ) : null}
                            {isFolder && node.count !== undefined ? (
                              <span className="brain-folder-count">
                                {node.count}
                                {node.capped ? "+" : ""}
                              </span>
                            ) : null}
                            {isFolder && node.capped ? (
                              <span
                                className="brain-capped-badge"
                                title="Count stopped at scan budget"
                              >
                                capped
                              </span>
                            ) : null}
                          </span>
                          {!isFolder && node.summary ? (
                            <span className="brain-tree-summary">{node.summary}</span>
                          ) : null}
                        </span>
                      </button>
                      {folderLoading ? (
                        <p
                          className="brain-tree-submsg"
                          style={{ paddingLeft: `${28 + depth * 16}px` }}
                        >
                          Loading…
                        </p>
                      ) : null}
                      {folderError ? (
                        <p
                          className="brain-tree-suberr"
                          role="alert"
                          style={{ paddingLeft: `${28 + depth * 16}px` }}
                        >
                          {folderError}
                        </p>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
