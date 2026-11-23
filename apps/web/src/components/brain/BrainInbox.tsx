import type { BrainKind, MemoryFrontmatterInput, Thread } from "@wooky/contracts";
import { useState } from "react";
import type { BrainInboxEditOverrides, BrainInboxProposal } from "../../brain/client.ts";
import {
  BRAIN_KINDS,
  brainKindLabel,
  formatBrainTime,
  validateBrainTags,
  validateGlobalTargetUri,
  validateMemoryDraft,
} from "../../brain/validation.ts";
import { selectThread } from "../../state/actions.ts";
import { IconCheck, IconClose, IconEdit } from "../Icons.tsx";
import { Markdown } from "../Markdown.tsx";
import { BrainKindIcon, IconPin } from "./BrainIcons.tsx";

export interface BrainInboxProps {
  proposals: readonly BrainInboxProposal[];
  loading: boolean;
  error: string | null;
  threads: Readonly<Record<string, Thread>>;
  onRetry: () => void;
  onApprove: (id: string, edits?: BrainInboxEditOverrides) => Promise<string | null>;
  onReject: (id: string) => Promise<string | null>;
}

export function BrainInbox({
  proposals,
  loading,
  error,
  threads,
  onRetry,
  onApprove,
  onReject,
}: BrainInboxProps) {
  if (loading && proposals.length === 0) {
    return (
      <div className="brain-inbox-scroll">
        <p className="brain-status-msg">Loading proposals…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="brain-inbox-scroll">
        <div className="brain-error-box" role="alert">
          <p>{error}</p>
          <button type="button" className="button" onClick={onRetry}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (proposals.length === 0) {
    return (
      <div className="brain-inbox-scroll">
        <div className="brain-inbox-empty">
          <p className="empty-state">No pending proposals.</p>
          <p className="brain-status-msg">
            Global memories proposed automatically after runs appear here for review.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="brain-inbox-scroll">
      <ul className="brain-inbox-list" aria-label="Pending proposals">
        {proposals.map((proposal) => (
          <InboxCard
            key={proposal.id}
            proposal={proposal}
            threads={threads}
            onApprove={onApprove}
            onReject={onReject}
          />
        ))}
      </ul>
    </div>
  );
}

function InboxCard({
  proposal,
  threads,
  onApprove,
  onReject,
}: {
  proposal: BrainInboxProposal;
  threads: Readonly<Record<string, Thread>>;
  onApprove: (id: string, edits?: BrainInboxEditOverrides) => Promise<string | null>;
  onReject: (id: string) => Promise<string | null>;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cardError, setCardError] = useState<string | null>(null);

  const [targetUri, setTargetUri] = useState(proposal.targetUri);
  const [summary, setSummary] = useState(proposal.summary);
  const [kind, setKind] = useState<BrainKind>(proposal.kind);
  const [tagsRaw, setTagsRaw] = useState(proposal.tags.join(", "));
  const [pinned, setPinned] = useState(proposal.pinned ?? false);
  const [body, setBody] = useState(proposal.body);

  const source = proposal.source;
  const thread = source?.threadId ? threads[source.threadId] : undefined;
  const when = source?.at ?? proposal.createdAt;

  const handleApproveDirect = async () => {
    setBusy(true);
    setCardError(null);
    const err = await onApprove(proposal.id);
    setBusy(false);
    if (err) setCardError(err);
  };

  const handleReject = async () => {
    setBusy(true);
    setCardError(null);
    const err = await onReject(proposal.id);
    setBusy(false);
    if (err) setCardError(err);
  };

  const handleApproveEdited = async () => {
    const uriErr = validateGlobalTargetUri(targetUri);
    if (uriErr) {
      setCardError(uriErr);
      return;
    }
    const draftErr = validateMemoryDraft({
      summary,
      kind,
      tagsRaw,
      body,
    });
    if (draftErr) {
      setCardError(draftErr);
      return;
    }
    const { tags } = validateBrainTags(tagsRaw);
    const frontmatter: MemoryFrontmatterInput = {
      summary: summary.trim(),
      kind,
      tags,
      status: "active",
      ...(pinned ? { pinned: true } : {}),
      ...(source ? { source } : {}),
    };
    setBusy(true);
    setCardError(null);
    const err = await onApprove(proposal.id, {
      targetUri: targetUri.trim(),
      frontmatter,
      body,
    });
    setBusy(false);
    if (err) setCardError(err);
  };

  return (
    <li className="brain-inbox-card">
      <div className="brain-inbox-head">
        <span className="brain-fm-kind">
          <BrainKindIcon kind={proposal.kind} />
          <span>{brainKindLabel(proposal.kind)}</span>
        </span>
        <span className="mono brain-inbox-uri">{proposal.targetUri}</span>
        {proposal.pinned ? (
          <span className="brain-pin-pill">
            <IconPin filled /> Pinned
          </span>
        ) : null}
      </div>

      <div className="brain-inbox-source">
        {source?.agent ? <span>Agent: {source.agent}</span> : null}
        {source?.threadId ? (
          thread ? (
            <button type="button" className="link-button" onClick={() => selectThread(thread.id)}>
              Thread: {thread.title || "Untitled thread"}
            </button>
          ) : (
            <span>Thread: {source.threadId}</span>
          )
        ) : null}
        {when ? <span title={when}>{formatBrainTime(when)}</span> : null}
      </div>

      {cardError ? (
        <div className="brain-error-box" role="alert">
          <p>{cardError}</p>
        </div>
      ) : null}

      {editing ? (
        <div className="brain-inbox-edit">
          <label className="field">
            <span>Target URI</span>
            <input
              className="mono"
              value={targetUri}
              onChange={(event) => {
                setTargetUri(event.target.value);
                setCardError(null);
              }}
            />
          </label>
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
              <span>Tags</span>
              <input
                className="mono"
                value={tagsRaw}
                onChange={(event) => setTagsRaw(event.target.value)}
              />
            </label>
          </div>
          <label className="field">
            <span>Summary</span>
            <input
              value={summary}
              onChange={(event) => {
                setSummary(event.target.value);
                setCardError(null);
              }}
            />
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={pinned}
              onChange={(event) => setPinned(event.target.checked)}
            />
            <span>Pin memory</span>
          </label>
          <label className="field">
            <span>Body</span>
            <textarea
              className="brain-body-textarea mono"
              rows={6}
              value={body}
              onChange={(event) => {
                setBody(event.target.value);
                setCardError(null);
              }}
            />
          </label>
          <div className="brain-inbox-actions">
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setCardError(null);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button primary"
              disabled={busy}
              onClick={() => void handleApproveEdited()}
            >
              <IconCheck />
              <span>{busy ? "Saving…" : "Approve with edits"}</span>
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="brain-fm-summary">{proposal.summary}</p>
          {proposal.tags.length > 0 ? (
            <div className="brain-tags">
              {proposal.tags.map((tag) => (
                <span key={tag} className="brain-tag">
                  {tag}
                </span>
              ))}
            </div>
          ) : null}
          {proposal.body.trim() ? (
            <div className="brain-inbox-body">
              <Markdown text={proposal.body} />
            </div>
          ) : null}
          <div className="brain-inbox-actions">
            <button
              type="button"
              className="button primary"
              disabled={busy}
              onClick={() => void handleApproveDirect()}
            >
              <IconCheck />
              <span>Approve</span>
            </button>
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => {
                setEditing(true);
                setCardError(null);
              }}
            >
              <IconEdit />
              <span>Edit</span>
            </button>
            <button
              type="button"
              className="button danger"
              disabled={busy}
              onClick={() => void handleReject()}
            >
              <IconClose />
              <span>Reject</span>
            </button>
          </div>
        </>
      )}
    </li>
  );
}
