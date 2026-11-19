import { useEffect, useState } from "react";
import { dismissNotice, openDialog, setPaletteOpen } from "../state/actions.ts";
import { isElectronShell, isMacDesktopShell } from "../lib/shell.ts";
import { useStore, type Theme } from "../state/store.ts";
import { ChangesPanel } from "./ChangesPanel.tsx";
import { Composer } from "./Composer.tsx";
import { Dialogs } from "./Dialogs.tsx";
import { Palette } from "./Palette.tsx";
import { projectMonogramIconDataUrl } from "./ProjectMonogram.tsx";
import { Settings } from "./Settings.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { TerminalPane } from "./TerminalPane.tsx";
import { ThreadView } from "./ThreadView.tsx";
import { TopBar } from "./TopBar.tsx";
import { Wallpaper } from "./Wallpaper.tsx";

export function App() {
  const theme = useStore((state) => state.theme);
  const preview = useStore((state) => state.previewAppearance);
  const [systemMode, setSystemMode] = useState<Theme>(() =>
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark",
  );
  const threadId = useStore((state) => state.selectedThreadId);
  const thread = useStore((state) =>
    state.selectedThreadId ? state.model.threads[state.selectedThreadId] : undefined,
  );
  const project = useStore((state) =>
    thread ? state.model.projects[thread.projectId] : undefined,
  );
  const notice = useStore((state) => state.notice);
  const hasProjects = useStore((state) => Object.keys(state.model.projects).length !== 0);
  const settingsOpen = useStore((state) => state.settingsOpen);
  const sidebarOpen = useStore((state) => state.sidebarOpen);
  const changesOpen = useStore((state) => state.changes.open);
  const terminalOpen = useStore((state) => state.terminalOpen);
  const macDesktop = isMacDesktopShell();
  const desktopShell = isElectronShell();

  const forcedTheme = preview ? preview.appearance : theme;
  const effectiveMode: Theme = forcedTheme ?? systemMode;

  // sync: OS prefers-color-scheme media query keeps effective mode current in system mode
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = (event: MediaQueryListEvent) =>
      setSystemMode(event.matches ? "light" : "dark");
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  // sync: document root attribute and dark class drive the CSS theme tokens + WCO vars
  useEffect(() => {
    if (forcedTheme) document.documentElement.dataset.theme = forcedTheme;
    else delete document.documentElement.dataset.theme;
    document.documentElement.classList.toggle("dark", effectiveMode === "dark");
    document.documentElement.classList.toggle("wco", desktopShell);
    document.documentElement.classList.toggle("desktop-darwin", macDesktop);
  }, [forcedTheme, effectiveMode, desktopShell, macDesktop]);

  // sync: window title + favicon monogram for the open project/thread
  useEffect(() => {
    const projectTitle = project?.name?.trim() ?? "";
    const threadTitle = thread?.title?.trim() ?? "";
    const title =
      threadTitle === ""
        ? "Wooky"
        : projectTitle === ""
          ? `${threadTitle} - Wooky`
          : `${projectTitle} / ${threadTitle} - Wooky`;
    if (document.title !== title) document.title = title;

    const href = projectTitle ? projectMonogramIconDataUrl(projectTitle) : null;
    let link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
    if (!href) {
      if (link?.dataset.wookyMonogram === "1") link.remove();
      return;
    }
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      link.dataset.wookyMonogram = "1";
      document.head.append(link);
    }
    link.type = "image/png";
    link.href = href;
  }, [project?.name, thread?.title]);

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

  const bodyClass = changesOpen && threadId ? "workspace-body split" : "workspace-body";
  const shellClass = [
    "shell",
    sidebarOpen ? null : "sidebar-hidden",
    desktopShell ? "desktop-shell" : null,
    macDesktop ? "desktop-darwin" : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <Wallpaper mode={effectiveMode} />
      <div className={shellClass}>
        {sidebarOpen ? <Sidebar macDesktop={macDesktop} /> : null}
        <div className="workspace">
          <TopBar macDesktop={macDesktop} />
          <div className={terminalOpen ? "workspace-stack with-terminal" : "workspace-stack"}>
            <div className={bodyClass}>
              <main className="main">
                {threadId ? (
                  <>
                    <ThreadView key={threadId} threadId={threadId} />
                    <Composer key={`composer-${threadId}`} threadId={threadId} />
                  </>
                ) : hasProjects ? (
                  <p className="empty-state">Pick a thread or start a new one.</p>
                ) : (
                  <div className="empty-state-hero">
                    <p className="empty-state-heading">No projects yet</p>
                    <p className="empty-state-copy">
                      Add a project folder to browse threads and start work.
                    </p>
                    <button
                      type="button"
                      className="button primary"
                      onClick={() => openDialog({ kind: "addProject" })}
                    >
                      Add a project folder
                    </button>
                  </div>
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
            </div>
            {terminalOpen ? (
              <aside className="terminal-dock" aria-label="Terminal">
                <TerminalPane />
              </aside>
            ) : null}
          </div>
        </div>
      </div>
      {settingsOpen ? <Settings /> : null}
      <Palette />
      <Dialogs />
    </>
  );
}
