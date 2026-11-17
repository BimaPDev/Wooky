import { useEffect } from "react";
import { dismissNotice, setPaletteOpen } from "../state/actions.ts";
import { useStore } from "../state/store.ts";
import { ChangesPanel } from "./ChangesPanel.tsx";
import { Composer } from "./Composer.tsx";
import { Dialogs } from "./Dialogs.tsx";
import { Palette } from "./Palette.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { ThreadView } from "./ThreadView.tsx";
import { TopBar } from "./TopBar.tsx";

export function App() {
  const theme = useStore((state) => state.theme);
  const threadId = useStore((state) => state.selectedThreadId);
  const changesOpen = useStore((state) => state.changes.open);
  const notice = useStore((state) => state.notice);
  const hasProjects = useStore((state) => Object.keys(state.model.projects).length > 0);

  // sync: document root attribute drives the CSS theme tokens
  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  }, [theme]);

  // sync: global keyboard shortcut for the command palette
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(!useStore.getState().paletteOpen);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className={changesOpen && threadId ? "shell with-panel" : "shell"}>
      <Sidebar />
      <main className="main">
        <TopBar />
        {threadId ? (
          <>
            <ThreadView key={threadId} threadId={threadId} />
            <Composer key={`composer-${threadId}`} threadId={threadId} />
          </>
        ) : (
          <p className="empty-state">
            {hasProjects
              ? "Pick a thread or start a new one."
              : "Add a project folder to get started."}
          </p>
        )}
        {notice ? (
          <div className="notice-bar" role="alert">
            <span>{notice}</span>
            <button type="button" className="link-button" onClick={dismissNotice}>
              Dismiss
            </button>
          </div>
        ) : null}
      </main>
      {changesOpen && threadId ? <ChangesPanel threadId={threadId} /> : null}
      <Palette />
      <Dialogs />
    </div>
  );
}
