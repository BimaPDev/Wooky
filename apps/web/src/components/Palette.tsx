import { useMemo, useState } from "react";
import { fuzzyFilter } from "../lib/fuzzy.ts";
import {
  configureThread,
  openDialog,
  openFleetBoard,
  openInSplit,
  pickProjectFolder,
  selectThread,
  setJumpOpen,
  setPaletteOpen,
  toggleChanges,
} from "../state/actions.ts";
import { NO_DISABLED_PROVIDERS, useStore } from "../state/store.ts";
import { toggleTheme } from "../state/theme.ts";
import { isAvailable, shortcut } from "./labels.ts";
import { Modal } from "./Modal.tsx";

interface PaletteAction {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

export function Palette() {
  const open = useStore((state) => state.paletteOpen);
  return open ? <PaletteDialog /> : null;
}

function PaletteDialog() {
  const projects = useStore((state) => state.model.projects);
  const threads = useStore((state) => state.model.threads);
  const providers = useStore((state) => state.providers);
  const disabledProviders = useStore(
    (state) => state.deviceSettings?.disabledProviders ?? NO_DISABLED_PROVIDERS,
  );
  const selected = useStore((state) => state.selectedThreadId);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const actions = useMemo<PaletteAction[]>(() => {
    const disabled = new Set(disabledProviders);
    const close = () => setPaletteOpen(false);
    const list: PaletteAction[] = [
      {
        id: "new-thread",
        label: "New thread",
        run: () => openDialog({ kind: "newThread", projectId: null }),
      },
      { id: "add-project", label: "Add project", run: () => void pickProjectFolder() },
      {
        id: "add-project-path",
        label: "Add project by path",
        hint: "Enter a path instead",
        run: () => openDialog({ kind: "addProject" }),
      },
      {
        id: "fleet-board",
        label: "Open agent board",
        hint: "Every agent",
        run: () => {
          close();
          openFleetBoard();
        },
      },
      {
        id: "jump",
        label: "Jump to thread",
        hint: shortcut("J"),
        run: () => {
          close();
          setJumpOpen(true);
        },
      },
    ];
    if (selected) {
      list.push({
        id: "open-split",
        label: "Open current thread in split",
        run: () => {
          close();
          useStore.setState({ fleetBoardOpen: false, compareGroupId: null });
          openInSplit(selected);
        },
      });
      list.push({
        id: "changes",
        label: "Toggle changes panel",
        run: () => {
          close();
          toggleChanges();
        },
      });
      const thread = threads[selected];
      for (const provider of providers) {
        if (!thread || provider.kind === thread.provider || !isAvailable(provider, disabled))
          continue;
        list.push({
          id: `switch-${provider.kind}`,
          label: `Switch provider to ${provider.label}`,
          hint: "Hands off the conversation",
          run: () => {
            close();
            void configureThread(selected, {
              provider: provider.kind,
              model: provider.models[0]?.id ?? "",
            });
          },
        });
      }
    }
    list.push({
      id: "theme",
      label: "Toggle theme",
      run: () => {
        close();
        toggleTheme();
      },
    });
    for (const thread of Object.values(threads).toSorted((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    )) {
      list.push({
        id: `thread-${thread.id}`,
        label: `Go to ${thread.title || "Untitled thread"}`,
        hint: projects[thread.projectId]?.name,
        run: () => {
          close();
          selectThread(thread.id);
        },
      });
    }
    return list;
  }, [projects, threads, providers, disabledProviders, selected]);

  const results = fuzzyFilter(actions, query, (action) => `${action.label} ${action.hint ?? ""}`);
  const index = Math.min(active, Math.max(0, results.length - 1));

  return (
    <Modal label="Command palette" onClose={() => setPaletteOpen(false)} className="modal palette">
      <input
        className="palette-input"
        role="combobox"
        aria-expanded="true"
        aria-controls="palette-list"
        aria-activedescendant={results[index] ? `palette-${results[index].id}` : undefined}
        aria-label="Search actions"
        placeholder="Type a command or thread"
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
            results[index]?.run();
          }
        }}
      />
      <ul className="palette-list" id="palette-list" role="listbox" aria-label="Actions">
        {results.length === 0 ? <li className="palette-empty">Nothing matches.</li> : null}
        {results.map((action, i) => (
          <li
            key={action.id}
            id={`palette-${action.id}`}
            role="option"
            aria-selected={i === index}
            className={i === index ? "palette-item active" : "palette-item"}
            onPointerMove={() => i !== index && setActive(i)}
            onClick={() => action.run()}
          >
            <span>{action.label}</span>
            {action.hint ? <span className="palette-hint">{action.hint}</span> : null}
          </li>
        ))}
      </ul>
    </Modal>
  );
}
