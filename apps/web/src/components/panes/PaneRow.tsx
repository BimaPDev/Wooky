import {
  Fragment,
  memo,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { closePaneThread, focusPaneThread, setPaneWeights } from "../../state/actions.ts";
import { useStore } from "../../state/store.ts";
import { Composer } from "../Composer.tsx";
import { IconClose } from "../Icons.tsx";
import { modelLabel, providerLabels } from "../labels.ts";
import { ThreadView } from "../ThreadView.tsx";
import {
  PANE_NUDGE_LARGE_PX,
  PANE_NUDGE_PX,
  resizeWeights,
  splitLayout,
  type PaneLayout,
} from "./layout.ts";

/** The main area's split: 2 to 4 panes side by side, or nothing when the layout is not a split. */
export function PaneDock() {
  const panes = useStore((state) => state.panes);
  const threads = useStore((state) => state.model.threads);
  const layout = useMemo(() => splitLayout(panes, (id) => Boolean(threads[id])), [panes, threads]);
  if (!layout) return null;
  return <PaneRow layout={layout} />;
}

interface DragSession {
  index: number;
  origin: number;
  start: number[];
  available: number;
  latest: number[];
}

function PaneRow({ layout }: { layout: PaneLayout }) {
  const rowRef = useRef<HTMLDivElement>(null);
  const drag = useRef<DragSession | null>(null);
  // Widths while a divider is dragged. They reach the store once, on release.
  const [live, setLive] = useState<number[] | null>(null);
  const titles = useStore(
    useShallow((state) => layout.threadIds.map((id) => state.model.threads[id]?.title ?? "")),
  );
  const shown = live ?? layout.weights;
  const count = layout.threadIds.length;

  // Dividers are 1px each. The panes share what is left.
  const availableWidth = () => {
    const row = rowRef.current;
    return row ? row.getBoundingClientRect().width - (count - 1) : 0;
  };

  const startDrag = (event: PointerEvent<HTMLDivElement>, index: number) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      index,
      origin: event.clientX,
      start: layout.weights,
      available: availableWidth(),
      latest: layout.weights,
    };
  };

  const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
    const session = drag.current;
    if (!session) return;
    session.latest = resizeWeights(
      session.start,
      session.index,
      event.clientX - session.origin,
      session.available,
    );
    setLive(session.latest);
  };

  const endDrag = () => {
    const session = drag.current;
    drag.current = null;
    if (!session) return;
    setPaneWeights(session.latest);
    setLive(null);
  };

  const onDividerKey = (event: KeyboardEvent<HTMLDivElement>, index: number) => {
    const step = event.shiftKey ? PANE_NUDGE_LARGE_PX : PANE_NUDGE_PX;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const delta = event.key === "ArrowLeft" ? -step : step;
    setPaneWeights(resizeWeights(layout.weights, index, delta, availableWidth()));
  };

  return (
    <div className="pane-dock">
      <div className="pane-switcher" role="group" aria-label="Show pane">
        {layout.threadIds.map((id, i) => (
          <button
            key={id}
            type="button"
            className="pane-switch"
            aria-pressed={i === layout.focused}
            onClick={() => focusPaneThread(id)}
          >
            {titles[i] || "Untitled thread"}
          </button>
        ))}
      </div>
      <div className="pane-row" ref={rowRef}>
        {layout.threadIds.map((id, i) => (
          <Fragment key={id}>
            <div
              className={i === layout.focused ? "pane-slot focused" : "pane-slot"}
              style={{ flexGrow: shown[i] }}
            >
              <PaneView threadId={id} focused={i === layout.focused} />
            </div>
            {i < count - 1 ? (
              <div
                role="separator"
                tabIndex={0}
                aria-orientation="vertical"
                aria-label={`Resize between ${titles[i] || "pane"} and ${titles[i + 1] || "pane"}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round((shown[i] ?? 0) * 100)}
                className="pane-divider"
                onPointerDown={(event) => startDrag(event, i)}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onKeyDown={(event) => onDividerKey(event, i)}
              />
            ) : null}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

/** One pane: a slim header, then the thread's own view and composer. Memoised so a resize does not re-render threads. */
const PaneView = memo(function PaneView({
  threadId,
  focused,
}: {
  threadId: string;
  focused: boolean;
}) {
  const thread = useStore((state) => state.model.threads[threadId]);
  const providers = useStore((state) => state.providers);
  if (!thread) return null;
  const title = thread.title || "Untitled thread";
  return (
    <section
      className={focused ? "pane focused" : "pane"}
      aria-label={`Pane: ${title}`}
      onFocus={() => focusPaneThread(threadId)}
      onPointerDown={() => focusPaneThread(threadId)}
    >
      <header className="pane-head">
        <span className="pane-title" title={title}>
          {title}
        </span>
        <span className="pane-model">
          {providerLabels[thread.provider]} · {modelLabel(providers, thread.provider, thread.model)}
        </span>
        <button
          type="button"
          className="icon-button"
          aria-label={`Close pane: ${title}`}
          title="Close pane"
          onClick={() => closePaneThread(threadId)}
        >
          <IconClose />
        </button>
      </header>
      <ThreadView threadId={threadId} />
      <Composer threadId={threadId} />
    </section>
  );
});
