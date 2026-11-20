import type { TimelineItem, Turn } from "@wooky/contracts";
import { memo, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { formatDuration, summarizeTurn } from "../lib/summary.ts";
import { openChanges, revertTurn } from "../state/actions.ts";
import { useStore } from "../state/store.ts";
import { IconChevron, IconUndo } from "./Icons.tsx";
import { ContinuedFromMarker } from "./anywhere/replicas/MovedBanners.tsx";
import { FailoverNoticeRow } from "./failover/FailoverNotice.tsx";
import { FallbackBanner } from "./failover/FallbackBanner.tsx";
import { failureText } from "./failover/format.ts";
import { SwitchAndRetry } from "./failover/SwitchAndRetry.tsx";
import { Markdown } from "./Markdown.tsx";
import { TimelineEntry } from "./Timeline.tsx";

export function ThreadView({
  threadId,
  peerTurns,
}: {
  threadId: string;
  /** A peer device's turns for a read-only view. The thread is not in the local read model. */
  peerTurns?: readonly Turn[];
}) {
  const localTurnIds = useStore(
    useShallow((state) => (state.model.turns[threadId] ?? []).map((turn) => turn.id)),
  );
  const turnIds = peerTurns ? peerTurns.map((turn) => turn.id) : localTurnIds;
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // sync: DOM size changes keep the view pinned to the bottom while the user is there
  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner) return;
    el.scrollTop = el.scrollHeight;
    const onScroll = () => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    };
    const observer = new ResizeObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(inner);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer.disconnect();
      el.removeEventListener("scroll", onScroll);
    };
  }, []);

  return (
    <div className="thread-scroll messages-timeline-scroll" ref={scroller}>
      {peerTurns ? null : <FallbackBanner threadId={threadId} />}
      <div className="thread-content" ref={content}>
        {peerTurns ? null : <ContinuedFromMarker threadId={threadId} />}
        {turnIds.length === 0 ? (
          <p className="empty-state">
            {peerTurns ? "No conversation yet." : "Send a message to start this thread."}
          </p>
        ) : null}
        {turnIds.map((turnId, index) => (
          <TurnView
            key={turnId}
            threadId={threadId}
            turnId={turnId}
            peerTurn={peerTurns?.[index]}
            isLast={index === turnIds.length - 1}
          />
        ))}
      </div>
    </div>
  );
}

const TurnView = memo(function TurnView({
  threadId,
  turnId,
  peerTurn,
  isLast,
}: {
  threadId: string;
  turnId: string;
  peerTurn?: Turn;
  isLast: boolean;
}) {
  const localTurn = useStore((state) => state.model.turns[threadId]?.find((t) => t.id === turnId));
  const turn = peerTurn ?? localTurn;
  const readOnly = peerTurn !== undefined;
  if (!turn) return null;
  return (
    <article className="turn" aria-label={`Turn: ${turn.prompt.slice(0, 60)}`}>
      {turn.origin ? <FailoverNoticeRow origin={turn.origin} /> : null}
      {turn.origin?.kind === "failover" ? null : (
        <div className="prompt" data-user-message-bubble="">
          {turn.prompt}
        </div>
      )}
      {turn.status === "running" ? (
        <LiveTurn turn={turn} readOnly={readOnly} />
      ) : (
        <FinishedTurn
          turn={turn}
          canRevert={turn.checkpointBefore !== null}
          isLast={isLast}
          readOnly={readOnly}
        />
      )}
    </article>
  );
});

function visible(item: TimelineItem) {
  return !(item.kind === "message" && item.role === "user");
}

function LiveTurn({ turn, readOnly }: { turn: Turn; readOnly: boolean }) {
  const items = turn.items.filter(visible);
  return (
    <div className="turn-body">
      <div className="live-status" aria-live="polite">
        <span className="working" aria-hidden="true" />
        <span className="live-step">{currentStep(turn.items)}</span>
        <Elapsed since={turn.startedAt} />
      </div>
      <div className="trail">
        {items.map((item) => (
          <TimelineEntry key={item.id} item={item} threadId={turn.threadId} readOnly={readOnly} />
        ))}
      </div>
    </div>
  );
}

export function currentStep(items: readonly TimelineItem[]): string {
  if (items.some((item) => item.kind === "approval" && item.decision === null))
    return "Waiting for your approval";
  if (items.some((item) => item.kind === "question" && item.answers === null && !item.dismissed))
    return "Waiting for your answer";
  const last = items.at(-1);
  if (!last) return "Starting";
  if (last.kind === "tool") return last.status === "running" ? last.title : "Thinking";
  if (last.kind === "message") return "Writing";
  if (last.kind === "reasoning") return "Thinking";
  return "Working";
}

function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now());
  // sync: wall clock, ticking once a second for the elapsed label
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <span className="elapsed">{formatDuration(now - Date.parse(since))}</span>;
}

function FinishedTurn({
  turn,
  canRevert,
  isLast,
  readOnly,
}: {
  turn: Turn;
  canRevert: boolean;
  isLast: boolean;
  readOnly: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const summary = summarizeTurn(turn);
  const answer = turn.items.findLast(
    (item) => item.kind === "message" && item.role === "assistant",
  );
  const steps = turn.items.filter((item) => visible(item) && item !== answer);
  const running = useStore((state) => state.model.threads[turn.threadId]?.status === "running");

  return (
    <div className="turn-body">
      <div className="turn-meta">
        {steps.length > 0 ? (
          <button
            type="button"
            className="summary-button"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            <IconChevron open={expanded} />
            {summary.text}
          </button>
        ) : (
          <span className="summary-text">{summary.text}</span>
        )}
        {readOnly ? null : (
          <button
            type="button"
            className="turn-action"
            disabled={!canRevert || running}
            title={canRevert ? "Revert files to before this turn" : "No checkpoint for this turn"}
            onClick={() => revertTurn(turn.threadId, turn.id)}
          >
            <IconUndo />
            Revert to before this turn
          </button>
        )}
      </div>
      {expanded ? (
        <div className="trail settled">
          {steps.map((item) => (
            <TimelineEntry key={item.id} item={item} threadId={turn.threadId} readOnly={readOnly} />
          ))}
        </div>
      ) : null}
      {summary.changedFiles.length > 0 && !readOnly ? (
        <div className="file-chips" aria-label="Changed files">
          {summary.changedFiles.map((path) => (
            <button
              type="button"
              key={path}
              className="file-chip"
              title={`Show changes in ${path}`}
              onClick={() => openChanges(turn.id, path)}
            >
              {path}
            </button>
          ))}
        </div>
      ) : null}
      {answer && answer.kind === "message" ? <Markdown text={answer.text} /> : null}
      {turn.status === "failed" ? (
        <p className="turn-error" role="alert" title={turn.failure?.message || undefined}>
          {turn.failure
            ? failureText(turn.provider, turn.failure, Date.parse(turn.endedAt ?? turn.startedAt))
            : (turn.error ?? "The turn failed.")}
        </p>
      ) : null}
      {turn.status === "failed" && turn.failure && isLast && !running && !readOnly ? (
        <SwitchAndRetry turn={turn} failure={turn.failure} />
      ) : null}
      {turn.status === "interrupted" ? (
        <p className="turn-notice">
          {turn.error ?? (isLast ? "Stopped." : "This turn was stopped.")}
        </p>
      ) : null}
    </div>
  );
}
