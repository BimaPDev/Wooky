import { fleetRows } from "@age/domain";
import { useEffect, useMemo, useState } from "react";
import { BOARD_STATUS_LABEL, jumpItemsFromRows, rankJumpItems } from "./helpers.ts";
import { IconSearch } from "../Icons.tsx";
import { Modal } from "../Modal.tsx";
import { providerLabels } from "../labels.ts";
import { openFleetThread, setJumpOpen, setPaletteOpen } from "../../state/actions.ts";
import { useStore } from "../../state/store.ts";
import { FleetStatusMark } from "./FleetStatusMark.tsx";

export function JumpSwitcher() {
  const open = useStore((state) => state.jumpOpen);

  // sync: Cmd/Ctrl+J toggles jump, distinct from the Cmd/Ctrl+K palette
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat || event.altKey || event.shiftKey) return;
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "j") return;
      event.preventDefault();
      const next = !useStore.getState().jumpOpen;
      setPaletteOpen(false);
      setJumpOpen(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return open ? <JumpDialog /> : null;
}

function runJump(threadId: string) {
  setJumpOpen(false);
  openFleetThread(threadId);
}

function JumpDialog() {
  const model = useStore((state) => state.model);
  const items = useMemo(
    () => jumpItemsFromRows(fleetRows(model), (id) => model.projects[id]?.name ?? ""),
    [model],
  );
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const results = useMemo(() => rankJumpItems(items, query), [items, query]);
  const index = Math.min(active, Math.max(0, results.length - 1));

  return (
    <Modal label="Jump to thread" onClose={() => setJumpOpen(false)} className="modal palette">
      <label className="sr-only" htmlFor="fleet-jump-input">
        Jump to thread
      </label>
      <span className="fleet-jump-search">
        <IconSearch />
        <input
          id="fleet-jump-input"
          className="palette-input"
          role="combobox"
          aria-expanded="true"
          aria-controls="fleet-jump-list"
          aria-activedescendant={
            results[index] ? `fleet-jump-${results[index].threadId}` : undefined
          }
          aria-label="Search threads"
          placeholder="Jump to a thread"
          autoFocus
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((index + 1) % Math.max(1, results.length));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((index - 1 + results.length) % Math.max(1, results.length));
            } else if (event.key === "Enter") {
              event.preventDefault();
              const item = results[index];
              if (item) runJump(item.threadId);
            }
          }}
        />
      </span>
      <ul className="palette-list" id="fleet-jump-list" role="listbox" aria-label="Threads">
        {results.length === 0 ? <li className="palette-empty">Nothing matches.</li> : null}
        {results.map((item, i) => (
          <li
            key={item.threadId}
            id={`fleet-jump-${item.threadId}`}
            role="option"
            aria-selected={i === index}
            className={i === index ? "palette-item active" : "palette-item"}
            onPointerMove={() => i !== index && setActive(i)}
            onClick={() => runJump(item.threadId)}
          >
            <span className="fleet-jump-item">
              <FleetStatusMark status={item.status} />
              <span
                className={`provider-badge provider-${item.provider}`}
                title={providerLabels[item.provider]}
              >
                {item.provider.slice(0, 2).toUpperCase()}
              </span>
              <span className="fleet-jump-copy">
                <span>{item.title}</span>
                <span className="palette-hint">
                  {item.projectName} · {item.model} · {BOARD_STATUS_LABEL[item.status]}
                </span>
              </span>
            </span>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
