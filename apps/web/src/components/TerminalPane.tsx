import { useEffect, useState, type KeyboardEvent } from "react";
import type { RpcResult, TerminalInfo } from "@wooky/contracts";
import { toggleTerminal } from "../state/actions.ts";
import { backend } from "../state/backend.ts";
import { useStore } from "../state/store.ts";
import { subscribeTerminalSession } from "../state/terminal.ts";
import { IconClose, IconPlus } from "./Icons.tsx";
import { Tooltip } from "./Tooltip.tsx";
import { XtermSession } from "./terminal/XtermSession.tsx";

/** Ending comes from `terminal.open`. Older servers omit it; those shells want LF. */
export function terminalLine(text: string, lineEnding: "\n" | "\r\n" = "\n"): string {
  return `${text}${lineEnding}`;
}

type Tab = {
  sessionId: string;
  title: string;
  pty: boolean;
  lineEnding: "\n" | "\r\n";
  cwd: string | undefined;
  projectId: string | null;
  scriptId: string | null;
  ended: boolean;
};

function lineEndingOf(value: string | undefined): "\n" | "\r\n" {
  return value === "\r\n" ? "\r\n" : "\n";
}

function tabFromInfo(info: TerminalInfo, lineEnding?: "\n" | "\r\n"): Tab {
  return {
    sessionId: info.sessionId,
    title: info.title || info.shell,
    pty: info.pty,
    lineEnding: lineEnding ?? "\n",
    cwd: info.cwd,
    projectId: info.projectId,
    scriptId: info.scriptId,
    ended: info.exited,
  };
}

function tabFromOpen(result: RpcResult<"terminal.open">): Tab {
  return {
    sessionId: result.sessionId,
    title: result.title || result.shell,
    pty: result.pty ?? false,
    lineEnding: lineEndingOf(result.lineEnding),
    cwd: result.cwd,
    projectId: result.projectId ?? null,
    scriptId: result.scriptId ?? null,
    ended: result.exited ?? false,
  };
}

function openCwd(): { cwd: string | null; projectId: string | undefined } {
  const state = useStore.getState();
  const thread = state.selectedThreadId ? state.model.threads[state.selectedThreadId] : undefined;
  const project = thread ? state.model.projects[thread.projectId] : undefined;
  return {
    cwd: thread?.worktree?.path ?? project?.root ?? null,
    projectId: thread?.projectId ?? project?.id,
  };
}

async function openSession(): Promise<Tab> {
  const { cwd, projectId } = openCwd();
  const result = await backend().call("terminal.open", {
    ...(cwd ? { cwd } : {}),
    ...(projectId ? { projectId } : {}),
  });
  return tabFromOpen(result);
}

export function TerminalPane() {
  const status = useStore((state) => state.status);

  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(true);

  // sync: existing server sessions on connect/reconnect; open one when the list is empty
  useEffect(() => {
    if (status !== "open") return;
    let cancelled = false;
    const sync = async () => {
      setStarting(true);
      setError(null);
      let listed: TerminalInfo[] = [];
      try {
        const result = await backend().call("terminal.list", {});
        if (Array.isArray(result)) listed = result.filter((session) => !session.exited);
      } catch {
        listed = [];
      }
      if (cancelled) return;
      if (listed.length > 0) {
        const next = listed.map((info) => tabFromInfo(info));
        setTabs(next);
        setActiveId((current) =>
          next.some((tab) => tab.sessionId === current) ? current : (next[0]?.sessionId ?? null),
        );
        setStarting(false);
        return;
      }
      try {
        const opened = await openSession();
        if (cancelled) return;
        setTabs([opened]);
        setActiveId(opened.sessionId);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not start the shell.");
      } finally {
        if (!cancelled) setStarting(false);
      }
    };
    void sync();
    return () => {
      cancelled = true;
    };
  }, [status]);

  // sync: a script run elsewhere asks this pane to show its session
  useEffect(() => {
    return subscribeTerminalSession((info) => {
      const opened = tabFromInfo(info);
      setTabs((current) =>
        current.some((tab) => tab.sessionId === info.sessionId)
          ? current
          : [
              ...current.filter(
                (tab) =>
                  !(
                    tab.scriptId &&
                    tab.scriptId === info.scriptId &&
                    tab.projectId === info.projectId
                  ),
              ),
              opened,
            ],
      );
      setActiveId(info.sessionId);
      setError(null);
    });
  }, []);

  const addTab = async () => {
    try {
      const opened = await openSession();
      setTabs((current) => [...current, opened]);
      setActiveId(opened.sessionId);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the shell.");
    }
  };

  const markEnded = (sessionId: string) => {
    setTabs((current) =>
      current.map((tab) => (tab.sessionId === sessionId ? { ...tab, ended: true } : tab)),
    );
  };

  const restartTab = async (tab: Tab) => {
    try {
      const result = await backend().call("terminal.open", {
        ...(tab.cwd ? { cwd: tab.cwd } : {}),
        ...(tab.projectId ? { projectId: tab.projectId } : {}),
        ...(tab.scriptId ? { scriptId: tab.scriptId } : {}),
      });
      const opened = { ...tabFromOpen(result), title: tab.title };
      setTabs((current) =>
        current.map((item) => (item.sessionId === tab.sessionId ? opened : item)),
      );
      setActiveId(opened.sessionId);
      setError(null);
      try {
        await backend().call("terminal.close", { sessionId: tab.sessionId });
      } catch {
        // already gone
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the shell.");
    }
  };

  const closeTab = async (sessionId: string) => {
    const remaining = tabs.filter((tab) => tab.sessionId !== sessionId);
    setTabs(remaining);
    if (activeId === sessionId) setActiveId(remaining[0]?.sessionId ?? null);
    setRenamingId((current) => (current === sessionId ? null : current));
    try {
      await backend().call("terminal.close", { sessionId });
    } catch {
      // already gone
    }
    if (remaining.length === 0) void addTab();
  };

  const renameTab = (sessionId: string, title: string) => {
    const next = title.trim();
    if (next) {
      setTabs((current) =>
        current.map((tab) => (tab.sessionId === sessionId ? { ...tab, title: next } : tab)),
      );
    }
    setRenamingId(null);
  };

  const onRenameKey = (sessionId: string, event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      renameTab(sessionId, event.currentTarget.value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setRenamingId(null);
    }
  };

  return (
    <section className="terminal-pane" aria-label="Terminal">
      <header className="terminal-head">
        <div className="terminal-tabs" role="tablist" aria-label="Terminal sessions">
          {tabs.map((tab) => {
            const selected = tab.sessionId === activeId;
            const tabClass = ["terminal-tab", selected ? "active" : "", tab.ended ? "ended" : ""]
              .filter(Boolean)
              .join(" ");
            return (
              <div
                key={tab.sessionId}
                role="tab"
                tabIndex={0}
                className={tabClass}
                aria-selected={selected}
                onClick={() => setActiveId(tab.sessionId)}
                onDoubleClick={() => setRenamingId(tab.sessionId)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setActiveId(tab.sessionId);
                  }
                }}
              >
                {renamingId === tab.sessionId ? (
                  <input
                    className="terminal-tab-rename"
                    defaultValue={tab.title}
                    aria-label="Rename terminal"
                    autoFocus
                    onBlur={(event) => renameTab(tab.sessionId, event.currentTarget.value)}
                    onKeyDown={(event) => onRenameKey(tab.sessionId, event)}
                    onClick={(event) => event.stopPropagation()}
                  />
                ) : (
                  <span className="terminal-tab-title">{tab.title}</span>
                )}
                {!tab.pty ? (
                  <Tooltip label="Real terminal unavailable (node-pty failed to load). Colours, resizing and interactive programs may not work.">
                    <span className="terminal-pipe-mode">pipe mode</span>
                  </Tooltip>
                ) : null}
                {tab.ended ? (
                  <button
                    type="button"
                    className="terminal-tab-restart"
                    aria-label={`Restart ${tab.title}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      void restartTab(tab);
                    }}
                  >
                    Restart
                  </button>
                ) : null}
                <button
                  type="button"
                  className="icon-button terminal-tab-close"
                  aria-label={`Close ${tab.title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    void closeTab(tab.sessionId);
                  }}
                >
                  <IconClose />
                </button>
              </div>
            );
          })}
          <Tooltip label="New terminal">
            <button
              type="button"
              className="icon-button"
              aria-label="New terminal"
              onClick={() => void addTab()}
            >
              <IconPlus />
            </button>
          </Tooltip>
        </div>
        <div className="terminal-head-actions">
          <Tooltip label="Close">
            <button
              type="button"
              className="icon-button"
              aria-label="Close terminal"
              onClick={toggleTerminal}
            >
              <IconClose />
            </button>
          </Tooltip>
        </div>
      </header>
      <div className="terminal-xterm">
        {starting ? <div className="terminal-status">Starting shell…</div> : null}
        {error ? (
          <div className="terminal-status terminal-error" role="alert">
            {error}
          </div>
        ) : null}
        {tabs.map((tab) => (
          <XtermSession
            key={tab.sessionId}
            sessionId={tab.sessionId}
            active={tab.sessionId === activeId && !starting}
            pty={tab.pty}
            lineEnding={tab.lineEnding}
            onEnded={() => markEnded(tab.sessionId)}
          />
        ))}
      </div>
    </section>
  );
}
