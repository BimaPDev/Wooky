import type { FleetRow } from "@age/contracts";
import { fleetRows } from "@age/domain";
import { memo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Counts } from "../DiffView.tsx";
import { IconSearch } from "../Icons.tsx";
import { providerLabels } from "../labels.ts";
import { openFleetThread } from "../../state/actions.ts";
import { useStore } from "../../state/store.ts";
import { FleetStatusMark } from "./FleetStatusMark.tsx";
import {
  BOARD_STATUS_LABEL,
  filterFleetRows,
  fleetRoleLabel,
  formatRelativeActivity,
  groupFleetRows,
} from "./helpers.ts";

export function FleetBoard() {
  const model = useStore((state) => state.model);
  const rows = fleetRows(model);
  const projects = model.projects;
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const groups = groupFleetRows(filterFleetRows(rows, query, (id) => projects[id]?.name ?? ""));
  const flat = groups.flatMap((group) => group.rows);
  const index = Math.min(active, Math.max(0, flat.length - 1));

  return (
    <section className="fleet-board" aria-label="Agent board">
      <header className="fleet-board-head">
        <h1 className="fleet-board-title">Agent board</h1>
        <label className="search-field fleet-board-filter">
          <IconSearch />
          <input
            value={query}
            placeholder="Filter agents"
            aria-label="Filter agents"
            aria-controls="fleet-board-list"
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((index + 1) % Math.max(1, flat.length));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((index - 1 + flat.length) % Math.max(1, flat.length));
              } else if (event.key === "Enter") {
                event.preventDefault();
                const row = flat[index];
                if (row) openFleetThread(row.threadId);
              }
            }}
          />
        </label>
      </header>
      <div className="fleet-board-scroll" id="fleet-board-list" role="listbox" aria-label="Agents">
        {groups.length === 0 ? <p className="empty-state">No matching agents.</p> : null}
        {groups.map((group) => (
          <section key={group.status} className="fleet-board-group" aria-label={group.label}>
            <h2 className="fleet-board-group-title">
              {group.label}
              <span className="fleet-board-group-count">{group.rows.length}</span>
            </h2>
            <ul className="fleet-board-list">
              {group.rows.map((row) => {
                const flatIndex = flat.findIndex((item) => item.threadId === row.threadId);
                return (
                  <FleetBoardRow
                    key={row.threadId}
                    threadId={row.threadId}
                    active={flatIndex === index}
                    onHighlight={() => flatIndex !== index && setActive(flatIndex)}
                  />
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </section>
  );
}

const FleetBoardRow = memo(function FleetBoardRow({
  threadId,
  active,
  onHighlight,
}: {
  threadId: string;
  active: boolean;
  onHighlight: () => void;
}) {
  const snapshot = useStore(
    useShallow((state) => {
      const row = fleetRows(state.model).find((item) => item.threadId === threadId);
      if (!row) return null;
      const parent = row.parentThreadId ? state.model.threads[row.parentThreadId] : undefined;
      return {
        title: row.title,
        projectName: state.model.projects[row.projectId]?.name ?? "",
        provider: row.provider,
        model: row.model,
        role: row.role,
        parentThreadId: row.parentThreadId,
        groupId: row.groupId,
        parentTitle: parent?.title,
        status: row.status,
        lastActivityAt: row.lastActivityAt,
        additions: row.diffStat?.additions,
        deletions: row.diffStat?.deletions,
      };
    }),
  );
  if (!snapshot) return null;
  const row: Pick<FleetRow, "role" | "parentThreadId" | "groupId"> = snapshot;

  return (
    <li>
      <button
        type="button"
        role="option"
        aria-selected={active}
        aria-label={`${snapshot.title || "Untitled thread"}, ${BOARD_STATUS_LABEL[snapshot.status]}`}
        className={[
          "fleet-board-row",
          active ? "active" : null,
          snapshot.status === "waiting" ? "waiting" : null,
        ]
          .filter(Boolean)
          .join(" ")}
        onPointerMove={onHighlight}
        onClick={() => openFleetThread(threadId)}
      >
        <span className="fleet-board-status">
          <FleetStatusMark status={snapshot.status} />
        </span>
        <span
          className={`provider-badge provider-${snapshot.provider}`}
          title={providerLabels[snapshot.provider]}
        >
          {snapshot.provider.slice(0, 2).toUpperCase()}
        </span>
        <span className="fleet-board-copy">
          <span className="fleet-board-title-row">
            <span className="thread-title">{snapshot.title || "Untitled thread"}</span>
            <span className="thread-time">{formatRelativeActivity(snapshot.lastActivityAt)}</span>
          </span>
          <span className="fleet-board-meta">
            <span>{snapshot.model}</span>
            <span aria-hidden="true">·</span>
            <span>{snapshot.projectName || "Unknown project"}</span>
            <span aria-hidden="true">·</span>
            <span>{fleetRoleLabel(row, snapshot.parentTitle)}</span>
          </span>
        </span>
        {snapshot.additions !== undefined && snapshot.deletions !== undefined ? (
          <Counts additions={snapshot.additions} deletions={snapshot.deletions} />
        ) : null}
      </button>
    </li>
  );
});
