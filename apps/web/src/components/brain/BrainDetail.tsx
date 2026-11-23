import {
  BRAIN_BODY_MAX_BYTES,
  BRAIN_SUMMARY_MAX,
  brainScopeKey,
  formatBrainUri,
  type BrainEntry,
  type BrainKind,
  type BrainScope,
  type BrainStatus,
  type BrainTier,
  type MemoryFrontmatterInput,
  type Project,
} from "@wooky/contracts";
import { useState, type RefObject } from "react";
import {
  BRAIN_KINDS,
  brainKindLabel,
  formatBrainTime,
  utf8ByteLength,
  validateBrainMemoryPath,
  validateBrainTags,
  validateMemoryDraft,
} from "../../brain/validation.ts";
import { IconChevronLeft, IconEdit, IconTrash } from "../Icons.tsx";
import { Markdown } from "../Markdown.tsx";
import { BrainKindIcon, IconArchive, IconPin } from "./BrainIcons.tsx";

export interface BrainConflictState {
  uri: string;
  message: string;
  latest: BrainEntry | null;
  missing: boolean;
  readError: string | null;
}

export interface BrainDetailProps {
  mode: "view" | "edit" | "create";
  activeScope: BrainScope;
  projects: readonly Project[];
  entry: BrainEntry | null;
  selectedIsMemory: boolean;
  tier: BrainTier;
  loading: boolean;
  error: string | null;
  busy: boolean;
  actionError: string | null;
  existingCreateUri: string | null;
  conflict: BrainConflictState | null;
  onBackToList: () => void;
  onChangeTier: (tier: BrainTier) => void;
  onStartEdit: () => void;
  onCancelForm: () => void;
  onTogglePin: () => void;
  onArchive: () => void;
  onUnarchive: () => void;
  onRemove: () => Promise<boolean>;
  onSaveEdit: (input: { frontmatter: MemoryFrontmatterInput; body: string }) => void;
  onCreate: (input: {
    scope: BrainScope;
    path: string;
    frontmatter: MemoryFrontmatterInput;
    body: string;
  }) => void;
  onOpenExistingFromCreate: () => void;
  onClearCreateExists: () => void;
  onResolveConflictReload: () => void;
  onResolveConflictOverwrite: (input: {
    frontmatter: MemoryFrontmatterInput;
    body: string;
  }) => void;
  onResolveConflictRecreate: (input: { frontmatter: MemoryFrontmatterInput; body: string }) => void;
  onRetryConflictRead: () => void;
  onDismissConflict: () => void;
  editButtonRef?: RefObject<HTMLButtonElement | null>;
}

export function BrainDetail({
  mode,
  activeScope,
  projects,
  entry,
  selectedIsMemory,
  tier,
  loading,
  error,
  busy,
  actionError,
  existingCreateUri,
  conflict,
  onBackToList,
  onChangeTier,
  onStartEdit,
  onCancelForm,
  onTogglePin,
  onArchive,
  onUnarchive,
  onRemove,
  onSaveEdit,
  onCreate,
  onOpenExistingFromCreate,
  onClearCreateExists,
  onResolveConflictReload,
  onResolveConflictOverwrite,
  onResolveConflictRecreate,
  onRetryConflictRead,
  onDismissConflict,
  editButtonRef,
}: BrainDetailProps) {
  const [confirmingUri, setConfirmingUri] = useState<string | null>(null);
  const confirmingRemove = mode === "view" && entry !== null && confirmingUri === entry.uri;

  if (mode === "create") {
    return (
      <div className="brain-detail-col">
        <MemoryForm
          key={`create:${brainScopeKey(activeScope)}`}
          isNew
          initialScope={activeScope}
          projects={projects}
          busy={busy}
          serverError={actionError}
          existingCreateUri={existingCreateUri}
          conflict={null}
          onBackToList={onBackToList}
          onCancel={onCancelForm}
          onSubmitCreate={onCreate}
          onOpenExistingFromCreate={onOpenExistingFromCreate}
          onClearCreateExists={onClearCreateExists}
        />
      </div>
    );
  }

  if (loading && !entry) {
    return (
      <div className="brain-detail-col">
        <div className="brain-detail-mobile-bar">
          <button type="button" className="ghost-button" onClick={onBackToList}>
            <IconChevronLeft />
            <span>Back</span>
          </button>
        </div>
        <p className="brain-status-msg">Loading memory…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="brain-detail-col">
        <div className="brain-detail-mobile-bar">
          <button type="button" className="ghost-button" onClick={onBackToList}>
            <IconChevronLeft />
            <span>Back</span>
          </button>
        </div>
        <div className="brain-error-box" role="alert">
          <p>{error}</p>
        </div>
      </div>
    );
  }

  if (!entry) {
    return (
      <div className="brain-detail-col brain-detail-empty">
        <p className="empty-state">Select a memory or folder to view it, or create a new one.</p>
      </div>
    );
  }

  if (mode === "edit") {
    if (entry.tier < 2) {
      return (
        <div className="brain-detail-col">
          <div className="brain-detail-mobile-bar">
            <button type="button" className="ghost-button" onClick={onBackToList}>
              <IconChevronLeft />
              <span>Back</span>
            </button>
          </div>
          <p className="brain-status-msg">Loading full memory…</p>
        </div>
      );
    }
    return (
      <div className="brain-detail-col">
        <MemoryForm
          key={`edit:${entry.uri}:${entry.frontmatter.updatedAt}`}
          isNew={false}
          entry={entry}
          initialScope={entry.scope}
          projects={projects}
          busy={busy}
          serverError={actionError}
          conflict={conflict}
          onBackToList={onBackToList}
          onCancel={onCancelForm}
          onSubmitEdit={onSaveEdit}
          onResolveConflictReload={onResolveConflictReload}
          onResolveConflictOverwrite={onResolveConflictOverwrite}
          onResolveConflictRecreate={onResolveConflictRecreate}
          onRetryConflictRead={onRetryConflictRead}
          onDismissConflict={onDismissConflict}
        />
      </div>
    );
  }

  const isMemory = entry.type === "memory";
  const fm = entry.frontmatter;
  const isArchived = fm.status === "archived";
  const isPinned = fm.pinned === true;
  const sourceParts = fm.source
    ? [
        fm.source.agent ? `agent: ${fm.source.agent}` : null,
        fm.source.threadId ? `thread: ${fm.source.threadId}` : null,
        fm.source.fleetRunId ? `fleet: ${fm.source.fleetRunId}` : null,
        fm.source.at ? formatBrainTime(fm.source.at) : null,
      ].filter(Boolean)
    : [];

  return (
    <div className="brain-detail-col">
      <header className="brain-detail-head">
        <div className="brain-detail-head-top">
          <button type="button" className="ghost-button brain-detail-back" onClick={onBackToList}>
            <IconChevronLeft />
            <span>Back</span>
          </button>
          <span className="mono brain-detail-uri" title={entry.uri}>
            {entry.uri}
          </span>
          {entry.trust === "repo" ? (
            <span className="brain-trust-badge">from this repo</span>
          ) : null}
        </div>
        <div className="brain-detail-actions">
          <div className="brain-tier-tabs" role="group" aria-label="Loading tier">
            {(selectedIsMemory || isMemory ? ([0, 1, 2] as const) : ([0, 1] as const)).map(
              (level) => (
                <button
                  key={level}
                  type="button"
                  className={tier === level ? "brain-tier-btn active" : "brain-tier-btn"}
                  aria-pressed={tier === level}
                  onClick={() => onChangeTier(level)}
                >
                  {`L${level}`}
                </button>
              ),
            )}
          </div>
          {isMemory ? (
            <div className="brain-memory-actions">
              <button
                ref={editButtonRef}
                type="button"
                className="button"
                disabled={busy || tier < 2}
                title={tier < 2 ? "Switch to L2 to edit" : undefined}
                onClick={onStartEdit}
              >
                <IconEdit />
                <span>Edit</span>
              </button>
              <button
                type="button"
                className={isPinned ? "button pressed" : "button"}
                aria-pressed={isPinned}
                disabled={busy || tier < 2}
                title={tier < 2 ? "Switch to L2 to pin or unpin" : undefined}
                onClick={onTogglePin}
              >
                <IconPin filled={isPinned} />
                <span>{isPinned ? "Unpin" : "Pin"}</span>
              </button>
              {isArchived ? (
                <button
                  type="button"
                  className="button"
                  disabled={busy || tier < 2}
                  title={tier < 2 ? "Switch to L2 to restore" : undefined}
                  onClick={onUnarchive}
                >
                  <IconArchive />
                  <span>Restore</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="button"
                  disabled={busy || tier < 2}
                  title={tier < 2 ? "Switch to L2 to archive" : undefined}
                  onClick={onArchive}
                >
                  <IconArchive />
                  <span>Archive</span>
                </button>
              )}
              <button
                type="button"
                className="button danger"
                disabled={busy}
                onClick={() => setConfirmingUri(entry.uri)}
              >
                <IconTrash />
                <span>Remove</span>
              </button>
            </div>
          ) : null}
        </div>
      </header>

      {actionError ? (
        <div className="brain-error-box" role="alert">
          <p>{actionError}</p>
        </div>
      ) : null}

      {conflict ? (
        <div className="brain-conflict-box brain-detail-conflict" role="alert">
          <p className="brain-conflict-title">Update conflict</p>
          <p>{conflict.message}</p>
          {conflict.missing ? (
            <p className="brain-conflict-meta">This memory was deleted on disk.</p>
          ) : conflict.readError ? (
            <p className="brain-conflict-meta">{conflict.readError}</p>
          ) : null}
          <div className="brain-conflict-actions">
            {conflict.latest ? (
              <button
                type="button"
                className="button primary"
                disabled={busy}
                onClick={onResolveConflictReload}
              >
                Reload
              </button>
            ) : !conflict.missing ? (
              <button
                type="button"
                className="button primary"
                disabled={busy}
                onClick={onRetryConflictRead}
              >
                Retry
              </button>
            ) : null}
            <button type="button" className="ghost-button" onClick={onDismissConflict}>
              Dismiss
            </button>
          </div>
        </div>
      ) : null}

      {confirmingRemove ? (
        <div className="brain-confirm-bar" role="alertdialog" aria-label="Confirm removal">
          <span>Remove this memory permanently?</span>
          <div className="brain-confirm-actions">
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => setConfirmingUri(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button danger"
              disabled={busy}
              onClick={() => {
                void onRemove().then((ok) => {
                  if (ok) setConfirmingUri(null);
                });
              }}
            >
              Confirm remove
            </button>
          </div>
        </div>
      ) : null}

      <div className="brain-detail-scroll">
        <div className="brain-frontmatter-card">
          <div className="brain-fm-summary-row">
            <span className="brain-fm-kind">
              <BrainKindIcon kind={fm.kind} />
              <span>{brainKindLabel(fm.kind)}</span>
            </span>
            <span className={`brain-status-pill status-${fm.status}`}>{fm.status}</span>
            {isPinned ? <span className="brain-pin-pill">Pinned</span> : null}
            <span className="brain-fm-updated" title={fm.updatedAt}>
              Updated {formatBrainTime(fm.updatedAt)}
            </span>
          </div>
          <p className="brain-fm-summary">{fm.summary}</p>
          {fm.tags.length > 0 ? (
            <div className="brain-tags" aria-label="Tags">
              {fm.tags.map((tag) => (
                <span key={tag} className="brain-tag">
                  {tag}
                </span>
              ))}
            </div>
          ) : null}
          {sourceParts.length > 0 ? (
            <p className="brain-fm-source">Source: {sourceParts.join(" · ")}</p>
          ) : null}
        </div>

        {tier === 0 ? (
          <p className="brain-tier-note">
            L0 shows the summary and frontmatter only. Switch to L2 to read the full Markdown body.
          </p>
        ) : (
          <div className="brain-body-card">
            {entry.type === "overview" ? (
              <p className="brain-tier-note">Folder overview (L1)</p>
            ) : null}
            {entry.body.trim() ? (
              <Markdown text={entry.body} />
            ) : (
              <p className="brain-status-msg">No body content.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function MemoryForm({
  isNew,
  entry,
  initialScope,
  projects,
  busy,
  serverError,
  existingCreateUri,
  conflict,
  onBackToList,
  onCancel,
  onSubmitCreate,
  onSubmitEdit,
  onOpenExistingFromCreate,
  onClearCreateExists,
  onResolveConflictReload,
  onResolveConflictOverwrite,
  onResolveConflictRecreate,
  onRetryConflictRead,
  onDismissConflict,
}: {
  isNew: boolean;
  entry?: BrainEntry;
  initialScope: BrainScope;
  projects: readonly Project[];
  busy: boolean;
  serverError: string | null;
  existingCreateUri?: string | null;
  conflict: BrainConflictState | null;
  onBackToList: () => void;
  onCancel: () => void;
  onSubmitCreate?: (input: {
    scope: BrainScope;
    path: string;
    frontmatter: MemoryFrontmatterInput;
    body: string;
  }) => void;
  onSubmitEdit?: (input: { frontmatter: MemoryFrontmatterInput; body: string }) => void;
  onOpenExistingFromCreate?: () => void;
  onClearCreateExists?: () => void;
  onResolveConflictReload?: () => void;
  onResolveConflictOverwrite?: (input: {
    frontmatter: MemoryFrontmatterInput;
    body: string;
  }) => void;
  onResolveConflictRecreate?: (input: {
    frontmatter: MemoryFrontmatterInput;
    body: string;
  }) => void;
  onRetryConflictRead?: () => void;
  onDismissConflict?: () => void;
}) {
  const [scopeKey, setScopeKey] = useState(() => brainScopeKey(initialScope));
  const [path, setPath] = useState("");
  const [summary, setSummary] = useState(entry?.frontmatter.summary ?? "");
  const [kind, setKind] = useState<BrainKind>(entry?.frontmatter.kind ?? "note");
  const [tagsRaw, setTagsRaw] = useState(entry?.frontmatter.tags.join(", ") ?? "");
  const [status, setStatus] = useState<BrainStatus>(entry?.frontmatter.status ?? "active");
  const [pinned, setPinned] = useState(entry?.frontmatter.pinned ?? false);
  const [body, setBody] = useState(entry?.body ?? "");
  const [validationError, setValidationError] = useState<string | null>(null);

  const resolvedScope: BrainScope =
    scopeKey === "global"
      ? { kind: "global" }
      : { kind: "project", projectId: scopeKey.replace(/^project:/, "") };

  const pathValidation = isNew && path.trim() ? validateBrainMemoryPath(path) : null;
  const bodyBytes = utf8ByteLength(body);

  const buildInput = (): { frontmatter: MemoryFrontmatterInput; body: string } | null => {
    const error = validateMemoryDraft({
      path,
      isNew,
      summary,
      kind,
      tagsRaw,
      body,
    });
    if (error) {
      setValidationError(error);
      return null;
    }
    setValidationError(null);
    const { tags } = validateBrainTags(tagsRaw);
    const frontmatter: MemoryFrontmatterInput = {
      summary: summary.trim(),
      kind,
      tags,
      status,
      ...(pinned ? { pinned: true } : {}),
      ...(entry?.frontmatter.source ? { source: entry.frontmatter.source } : {}),
    };
    return { frontmatter, body };
  };

  return (
    <form
      className="brain-form"
      onSubmit={(event) => {
        event.preventDefault();
        const built = buildInput();
        if (!built) return;
        if (isNew) {
          onSubmitCreate?.({
            scope: resolvedScope,
            path: path.trim(),
            frontmatter: built.frontmatter,
            body: built.body,
          });
        } else {
          onSubmitEdit?.(built);
        }
      }}
    >
      <header className="brain-detail-head">
        <div className="brain-detail-head-top">
          <button type="button" className="ghost-button brain-detail-back" onClick={onBackToList}>
            <IconChevronLeft />
            <span>Back</span>
          </button>
          <h2 className="brain-form-title">{isNew ? "New memory" : "Edit memory"}</h2>
          {!isNew && entry ? <span className="mono brain-detail-uri">{entry.uri}</span> : null}
        </div>
      </header>

      <div className="brain-detail-scroll">
        {conflict ? (
          <div className="brain-conflict-box" role="alert">
            <p className="brain-conflict-title">Update conflict</p>
            <p>{conflict.message}</p>
            {conflict.latest ? (
              <div className="brain-conflict-latest">
                <p className="brain-conflict-meta">
                  Latest version on disk ({formatBrainTime(conflict.latest.frontmatter.updatedAt)}):
                </p>
                <p className="brain-conflict-summary">{conflict.latest.frontmatter.summary}</p>
                <pre className="brain-conflict-body mono">{conflict.latest.body}</pre>
              </div>
            ) : conflict.missing ? (
              <p className="brain-conflict-meta">This memory was deleted on disk.</p>
            ) : (
              <p className="brain-conflict-meta">
                {conflict.readError ?? "Could not load the latest version from disk."}
              </p>
            )}
            <div className="brain-conflict-actions">
              {conflict.latest ? (
                <>
                  <button
                    type="button"
                    className="button"
                    disabled={busy}
                    onClick={onResolveConflictReload}
                  >
                    Reload latest
                  </button>
                  <button
                    type="button"
                    className="button primary"
                    disabled={busy}
                    onClick={() => {
                      const built = buildInput();
                      if (built) onResolveConflictOverwrite?.(built);
                    }}
                  >
                    Overwrite with my edits
                  </button>
                </>
              ) : conflict.missing ? (
                <button
                  type="button"
                  className="button primary"
                  disabled={busy}
                  onClick={() => {
                    const built = buildInput();
                    if (built) onResolveConflictRecreate?.(built);
                  }}
                >
                  Recreate with my edits
                </button>
              ) : (
                <button
                  type="button"
                  className="button primary"
                  disabled={busy}
                  onClick={onRetryConflictRead}
                >
                  Retry
                </button>
              )}
              <button type="button" className="ghost-button" onClick={onDismissConflict}>
                Keep editing
              </button>
            </div>
          </div>
        ) : null}

        {validationError || serverError ? (
          <div className="brain-error-box" role="alert">
            <p>{validationError ?? serverError}</p>
            {!validationError && existingCreateUri && onOpenExistingFromCreate ? (
              <button type="button" className="button" onClick={onOpenExistingFromCreate}>
                Open memory
              </button>
            ) : null}
          </div>
        ) : null}

        {isNew ? (
          <>
            <label className="field">
              <span>Scope</span>
              <select
                className="settings-select"
                value={scopeKey}
                onChange={(event) => {
                  setScopeKey(event.target.value);
                  onClearCreateExists?.();
                }}
              >
                <option value="global">Global (brain://global/)</option>
                {projects.map((project) => (
                  <option key={project.id} value={`project:${project.id}`}>
                    {project.name} (brain://project/{project.id}/)
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Path</span>
              <input
                className="mono"
                value={path}
                placeholder="conventions/tooling.md"
                spellCheck={false}
                autoComplete="off"
                aria-invalid={pathValidation !== null}
                onChange={(event) => {
                  setPath(event.target.value);
                  setValidationError(null);
                  onClearCreateExists?.();
                }}
              />
              <span className={pathValidation ? "brain-field-hint error" : "brain-field-hint"}>
                {pathValidation ??
                  `Target: ${formatBrainUri(resolvedScope, path.trim() || "<folder>/<name>.md")}`}
              </span>
            </label>
          </>
        ) : null}

        <div className="brain-form-grid">
          <label className="field">
            <span>Kind</span>
            <select
              className="settings-select"
              value={kind}
              onChange={(event) => setKind(event.target.value as BrainKind)}
            >
              {BRAIN_KINDS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Status</span>
            <select
              className="settings-select"
              value={status}
              onChange={(event) => setStatus(event.target.value as BrainStatus)}
            >
              <option value="active">Active</option>
              <option value="proposed">Proposed</option>
              <option value="archived">Archived</option>
            </select>
          </label>
        </div>

        <label className="field">
          <span>
            Summary (L0) · {summary.trim().length}/{BRAIN_SUMMARY_MAX}
          </span>
          <input
            value={summary}
            maxLength={BRAIN_SUMMARY_MAX}
            placeholder="One-line summary shown in listings and agent prompts"
            onChange={(event) => {
              setSummary(event.target.value);
              setValidationError(null);
            }}
          />
        </label>

        <label className="field">
          <span>Tags (comma or space separated)</span>
          <input
            className="mono"
            value={tagsRaw}
            placeholder="tooling, pnpm"
            spellCheck={false}
            onChange={(event) => {
              setTagsRaw(event.target.value);
              setValidationError(null);
            }}
          />
        </label>

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={pinned}
            onChange={(event) => setPinned(event.target.checked)}
          />
          <span>Pin this memory (always injected into turn prompts)</span>
        </label>

        <label className="field">
          <span>
            Body (Markdown) · {bodyBytes}/{BRAIN_BODY_MAX_BYTES} bytes
          </span>
          <textarea
            className="brain-body-textarea mono"
            rows={10}
            value={body}
            placeholder="Write details, examples, or reasoning in Markdown…"
            onChange={(event) => {
              setBody(event.target.value);
              setValidationError(null);
            }}
          />
        </label>

        <div className="brain-form-actions">
          <button type="button" className="button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={busy}>
            {busy ? "Saving…" : isNew ? "Create memory" : "Save changes"}
          </button>
        </div>
      </div>
    </form>
  );
}
