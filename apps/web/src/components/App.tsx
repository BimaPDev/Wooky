import { useEffect, useState, type ReactNode } from "react";
import { dismissNotice, setPaletteOpen } from "../state/actions.ts";
import { useAnywhereHistory } from "../state/anywhere-history.ts";
import { titleWithBadge, useWaitingCount } from "../state/notifications.ts";
import { isElectronShell, isMacDesktopShell } from "../lib/shell.ts";
import { isDraftView, useStore, type Theme } from "../state/store.ts";
import { syncRootThemeClass } from "../state/theme.ts";
import { EnvironmentBanner } from "./anywhere/EnvironmentSwitcher.tsx";
import { ChangesPanel } from "./ChangesPanel.tsx";
import { Composer } from "./Composer.tsx";
import { CompareView } from "./fleet/CompareView.tsx";
import { AnywhereHistoryRoot } from "./anywhere/AnywhereHistoryRoot.tsx";
import { PhoneDrawer } from "./anywhere/phone/phone.tsx";
import { ComposerGate } from "./anywhere/replicas/MovedBanners.tsx";
import { ReplicaThreadView } from "./anywhere/replicas/ReplicaThreadView.tsx";
import { CoordinatorStrip } from "./fleet/CoordinatorStrip.tsx";
import { FanoutDialog } from "./fleet/FanoutDialog.tsx";
import { FleetBoard } from "./fleet/FleetBoard.tsx";
import { JumpSwitcher } from "./fleet/JumpSwitcher.tsx";
import { NewThreadView } from "./NewThreadView.tsx";
import { Dialogs } from "./Dialogs.tsx";
import { PaneDock } from "./panes/PaneRow.tsx";
import { splitLayout } from "./panes/layout.ts";
import { usePaneShortcuts } from "./panes/shortcuts.ts";
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
  const draftView = useStore(isDraftView);
  const settingsOpen = useStore((state) => state.settingsOpen);
  const sidebarOpen = useStore((state) => state.sidebarOpen);
  const changesOpen = useStore((state) => state.changes.open);
  const terminalOpen = useStore((state) => state.terminalOpen);
  const splitActive = useStore(
    (state) => splitLayout(state.panes, (id) => Boolean(state.model.threads[id])) !== null,
  );
  const fleetBoardOpen = useStore((state) => state.fleetBoardOpen);
  const compareGroupId = useStore((state) => state.compareGroupId);
  const replicaView = useAnywhereHistory((state) => state.replicaView !== null);
  const waiting = useWaitingCount();
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
    syncRootThemeClass(forcedTheme, effectiveMode);
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
    const badged = titleWithBadge(title, waiting);
    if (document.title !== badged) document.title = badged;

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
  }, [project?.name, thread?.title, waiting]);

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

  usePaneShortcuts();

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
      <Wallpaper />
      <div className={shellClass}>
        {sidebarOpen ? <Sidebar macDesktop={macDesktop} /> : null}
        <PhoneDrawer />
        <div className="workspace">
          <TopBar macDesktop={macDesktop} />
          <EnvironmentBanner />
          <div className={terminalOpen ? "workspace-stack with-terminal" : "workspace-stack"}>
            <div className={bodyClass}>
              <main className="main">
                {mainView({
                  fleetBoardOpen,
                  compareGroupId,
                  splitActive,
                  threadId,
                  draftView,
                  replicaView,
                })}
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
      <AnywhereHistoryRoot />
      <JumpSwitcher />
      <FanoutDialog />
      <Dialogs />
    </>
  );
}

function mainView({
  fleetBoardOpen,
  compareGroupId,
  splitActive,
  threadId,
  draftView,
  replicaView,
}: {
  fleetBoardOpen: boolean;
  compareGroupId: string | null;
  splitActive: boolean;
  threadId: string | null;
  draftView: boolean;
  replicaView: boolean;
}): ReactNode {
  if (fleetBoardOpen) return <FleetBoard />;
  if (compareGroupId) return <CompareView groupId={compareGroupId} />;
  if (replicaView) {
    return (
      <Conversation>
        <ReplicaThreadView />
      </Conversation>
    );
  }
  if (draftView) {
    return (
      <Conversation>
        <NewThreadView />
      </Conversation>
    );
  }
  if (splitActive) return <PaneDock />;
  if (threadId) {
    return (
      <Conversation>
        <CoordinatorStrip threadId={threadId} />
        <ThreadView key={threadId} threadId={threadId} />
        <ComposerGate threadId={threadId}>
          <Composer key={`composer-${threadId}`} threadId={threadId} />
        </ComposerGate>
      </Conversation>
    );
  }
  return <p className="empty-state">Pick a thread or start a new one.</p>;
}

function Conversation({ children }: { children: ReactNode }) {
  return (
    <div className="conversation" data-workspace-area="conversation">
      {children}
    </div>
  );
}
