import type { TimelineItem } from "@age/contracts";
import { memo, useEffect, useState } from "react";
import { respondApproval } from "../state/actions.ts";
import { useStore } from "../state/store.ts";
import { DiffLines } from "./DiffView.tsx";
import { IconChevron, IconFailed, ToolIcon } from "./Icons.tsx";
import { shortcut } from "./labels.ts";
import { Markdown } from "./Markdown.tsx";

type Item<K extends TimelineItem["kind"]> = Extract<TimelineItem, { kind: K }>;

/** One step of a turn. Memoised on item identity, so only the changing item re-renders. */
export const TimelineEntry = memo(function TimelineEntry({
  item,
  threadId,
}: {
  item: TimelineItem;
  threadId: string;
}) {
  switch (item.kind) {
    case "tool":
      return <ToolRow item={item} />;
    case "reasoning":
      return <Reasoning item={item} />;
    case "message":
      return <Markdown text={item.text} />;
    case "approval":
      return <ApprovalCard item={item} threadId={threadId} />;
    case "error":
      return (
        <p className="item-error" role="alert">
          {item.message}
        </p>
      );
    case "notice":
      return <p className="item-notice">{item.text}</p>;
  }
});

const statusLabel = { running: "Running", done: "Done", failed: "Failed" } as const;

function ToolRow({ item }: { item: Item<"tool"> }) {
  const [open, setOpen] = useState(false);
  const expandable = Boolean(item.output);
  const body = (
    <>
      <span className="tool-icon">
        <ToolIcon kind={item.tool} />
      </span>
      <span className={item.tool === "command" ? "tool-title mono" : "tool-title"}>
        {item.title}
      </span>
      <span className={`tool-status tool-${item.status}`} aria-label={statusLabel[item.status]}>
        {item.status === "running" ? <span className="working" aria-hidden="true" /> : null}
        {item.status === "failed" ? <IconFailed /> : null}
      </span>
      {expandable ? <IconChevron open={open} /> : null}
    </>
  );
  return (
    <div className={`tool-row tool-row-${item.status}`}>
      {expandable ? (
        <button
          type="button"
          className="tool-line"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {body}
        </button>
      ) : (
        <div className="tool-line">{body}</div>
      )}
      {open && item.output ? <pre className="tool-output">{item.output}</pre> : null}
    </div>
  );
}

function Reasoning({ item }: { item: Item<"reasoning"> }) {
  const [open, setOpen] = useState(false);
  const firstLine = item.text.split("\n")[0] ?? "";
  return (
    <div className="reasoning">
      <button
        type="button"
        className="reasoning-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <IconChevron open={open} />
        <span className="reasoning-preview">{open ? "Reasoning" : firstLine}</span>
      </button>
      {open ? <div className="reasoning-text">{item.text}</div> : null}
    </div>
  );
}

function ApprovalCard({ item, threadId }: { item: Item<"approval">; threadId: string }) {
  const pending = item.decision === null;
  const isFirstPending = useStore((state) => {
    if (!pending || state.selectedThreadId !== threadId) return false;
    const turn = state.model.turns[threadId]?.at(-1);
    return turn?.items.find((i) => i.kind === "approval" && i.decision === null)?.id === item.id;
  });
  const [sent, setSent] = useState(false);
  const decide = (decision: "allow" | "deny") => {
    if (sent) return;
    setSent(true);
    void respondApproval(threadId, item.requestId, decision).then((ack) => {
      if (!ack) setSent(false);
    });
  };

  // sync: window keyboard shortcuts answer the first pending approval
  useEffect(() => {
    if (!isFirstPending) return;
    const onKey = (event: KeyboardEvent) => {
      const state = useStore.getState();
      if (event.defaultPrevented || state.dialog || state.paletteOpen) return;
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        decide("allow");
      } else if (event.key === "Escape") {
        event.preventDefault();
        decide("deny");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <section
      className={pending ? "approval pending" : "approval decided"}
      aria-label={`Approval: ${item.title}`}
    >
      {pending ? <p className="approval-eyebrow">Approval needed</p> : null}
      <div className="approval-head">
        <ToolIcon kind={item.tool} />
        <span className="approval-title">{item.title}</span>
        {!pending ? (
          <span className="approval-decision">
            {item.decision === "allow" ? "Allowed" : "Denied"}
          </span>
        ) : null}
      </div>
      {item.detail ? <p className="approval-detail mono">{item.detail}</p> : null}
      {item.diff && pending ? (
        <div className="approval-diff">
          <DiffLines patch={item.diff} />
        </div>
      ) : null}
      {pending ? (
        <div className="approval-actions">
          <button type="button" className="button" disabled={sent} onClick={() => decide("deny")}>
            Deny <kbd>Esc</kbd>
          </button>
          <button
            type="button"
            className="button primary"
            disabled={sent}
            onClick={() => decide("allow")}
          >
            Approve <kbd>{shortcut("↵")}</kbd>
          </button>
        </div>
      ) : null}
    </section>
  );
}
