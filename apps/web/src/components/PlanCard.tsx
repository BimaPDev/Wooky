import type { TimelineItem } from "@age/contracts";
import { latestPlan } from "@age/domain";
import { memo, useState } from "react";
import { configureThread, startTurn } from "../state/actions.ts";
import { useStore } from "../state/store.ts";
import { Markdown } from "./Markdown.tsx";

type Item = Extract<TimelineItem, { kind: "plan" }>;

const statusCopy = {
  proposed: "Proposed",
  accepted: "Accepted",
  superseded: "Superseded",
} as const;

export const PlanCard = memo(function PlanCard({
  item,
  threadId,
}: {
  item: Item;
  threadId: string;
}) {
  const [busy, setBusy] = useState(false);
  const isLatest = useStore((state) => latestPlan(state.model, threadId)?.id === item.id);
  const collapsed = item.status === "superseded";
  const [open, setOpen] = useState(!collapsed);

  if (collapsed && !open) {
    return (
      <button
        type="button"
        className="plan-summary"
        aria-expanded={false}
        onClick={() => setOpen(true)}
      >
        {statusCopy[item.status]} plan
      </button>
    );
  }

  const implement = async () => {
    if (busy) return;
    setBusy(true);
    await configureThread(threadId, { interactionMode: "default" });
    const ack = await startTurn(threadId, "Implement the plan.");
    setBusy(false);
    if (!ack) setBusy(false);
  };

  return (
    <section
      className={item.status === "proposed" ? "plan-card proposed" : "plan-card"}
      aria-label={`Plan (${statusCopy[item.status]})`}
    >
      <header className="plan-head">
        <span className="plan-status">{statusCopy[item.status]}</span>
        {collapsed ? (
          <button type="button" className="ghost-button small" onClick={() => setOpen(false)}>
            Collapse
          </button>
        ) : null}
      </header>
      <Markdown text={item.markdown} />
      {isLatest && item.status === "proposed" ? (
        <div className="plan-actions">
          <button
            type="button"
            className="button primary"
            disabled={busy}
            onClick={() => void implement()}
          >
            Implement
          </button>
        </div>
      ) : null}
    </section>
  );
});
