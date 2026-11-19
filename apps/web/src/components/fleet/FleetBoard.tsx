import type { FleetRow } from "@wooky/contracts";
import { memo, useState } from "react";
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
  selectFleetRows,
} from "./helpers.ts";

export function FleetBoard() {
  const model = useStore((state) => state.model);
  const rows = selectFleetRows(model);
  const projects = model.projects;
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const groups = groupFleetRows(filterFleetRows(rows, query, (id) => projects[id]?.name ?? ""));
  const flat = groups.flatMap((group) => group.rows);
  const index = Math.min(active, Math.max(0, flat.length - 1));
  const activeId = flat[index]?.threadId;

  return (
    <section className="fleet-board" aria-label="Agent board">
      <header className="fleet-board-head">
        <h1 className="fleet-board-title">Agent board</h1>
        <label className="search-field fleet-board-filter">
          <IconSearch />
          <input
            role="combobox"
            aria-expanded="true"
            aria-controls="fleet-board-list"
            aria-activedescendant={activeId ? `fleet-board-${activeId}` : undefined}
            value={query}
            placeholder="Filter agents"
            aria-label="Filter agents"
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
                    row={row}
                    projectName={projects[row.projectId]?.name ?? ""}
                    parentTitle={
                      row.parentThreadId
                        ? (model.threads[row.parentThreadId]?.title ?? undefined)
                        : undefined
                    }
                    parentMissing={Boolean(
                      row.parentThreadId && !model.threads[row.parentThreadId],
                    )}
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
  row,
  projectName,
  parentTitle,
  parentMissing,
  active,
  onHighlight,
}: {
  row: FleetRow;
  projectName: string;
  parentTitle?: string;
  parentMissing: boolean;
  active: boolean;
  onHighlight: () => void;
}) {
  const role = parentMissing
    ? "Orphaned worker"
    : fleetRoleLabel(row, parentTitle !== undefined ? parentTitle || "Untitled thread" : undefined);
  return (
    <li
      id={`fleet-board-${row.threadId}`}
      role="option"
      aria-selected={active}
      aria-label={`${row.title || "Untitled thread"}, ${BOARD_STATUS_LABEL[row.status]}`}
      className={[
        "fleet-board-row",
        active ? "active" : null,
        row.status === "waiting" ? "waiting" : null,
      ]
        .filter(Boolean)
        .join(" ")}
      onPointerMove={onHighlight}
      onClick={() => openFleetThread(row.threadId)}
    >
      <span className="fleet-board-status">
        <FleetStatusMark status={row.status} />
      </span>
      <span
        className={`provider-badge provider-${row.provider}`}
        title={providerLabels[row.provider]}
      >
        {row.provider.slice(0, 2).toUpperCase()}
      </span>
      <span className="fleet-board-copy">
        <span className="fleet-board-title-row">
          <span className="thread-title">{row.title || "Untitled thread"}</span>
          <span className="thread-time">{formatRelativeActivity(row.lastActivityAt)}</span>
        </span>
        <span className="fleet-board-meta">
          <span>{row.model}</span>
          <span aria-hidden="true">·</span>
          <span>{projectName || "Unknown project"}</span>
          <span aria-hidden="true">·</span>
          <span>{role}</span>
        </span>
      </span>
      {row.diffStat ? (
        <Counts additions={row.diffStat.additions} deletions={row.diffStat.deletions} />
      ) : null}
    </li>
  );
});
