import type { ProjectScript } from "@wooky/contracts";
import { useEffect, useRef, useState } from "react";
import { saveTerminalOpen } from "../../lib/shell.ts";
import { backend } from "../../state/backend.ts";
import { requestTerminalSession, subscribeTerminal } from "../../state/terminal.ts";
import { draftProjectId, useStore } from "../../state/store.ts";
import { Tooltip } from "../Tooltip.tsx";
import { ScriptIcon } from "./icons.tsx";
import { detectPreviewPort, previewTemplate, resolvePreviewUrl } from "./preview-port.ts";
import { openExternalUrl } from "../terminal/links.ts";

export function ScriptsBar() {
  const project = useStore((state) => {
    const thread = state.selectedThreadId ? state.model.threads[state.selectedThreadId] : undefined;
    if (thread) return state.model.projects[thread.projectId];
    const draftId = draftProjectId(state);
    return draftId ? state.model.projects[draftId] : undefined;
  });
  const threadId = useStore((state) => state.selectedThreadId);
  const scripts = project?.settings.scripts ?? [];
  const scriptCount = scripts.length;
  const projectId = project?.id;
  const [live, setLive] = useState<Record<string, string>>({});
  const [ports, setPorts] = useState<Record<string, number>>({});
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [hiddenCount, setHiddenCount] = useState(0);
  const barRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);

  // sync: live script sessions from terminal.list
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    void backend()
      .call("terminal.list", {})
      .then((listed) => {
        if (cancelled) return;
        const next: Record<string, string> = {};
        for (const session of listed) {
          if (!session.exited && session.projectId === projectId && session.scriptId) {
            next[session.scriptId] = session.sessionId;
          }
        }
        setLive(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // sync: terminal output for ${PORT} and session exit
  useEffect(() => {
    if (!projectId) return;
    return subscribeTerminal((message) => {
      const scriptId = Object.entries(live).find(
        ([, sessionId]) => sessionId === message.sessionId,
      )?.[0];
      if (message.kind === "data" && message.data) {
        const port = detectPreviewPort(message.data);
        if (port !== null) {
          setPorts((current) =>
            current[message.sessionId] === port
              ? current
              : { ...current, [message.sessionId]: port },
          );
        }
      }
      if ((message.kind === "exit" || message.kind === "error") && scriptId) {
        setLive((current) => {
          if (current[scriptId] !== message.sessionId) return current;
          const { [scriptId]: _gone, ...rest } = current;
          return rest;
        });
      }
    });
  }, [projectId, live]);

  // sync: hide overflowing script chips on a narrow top bar
  useEffect(() => {
    if (scriptCount === 0) return;
    const bar = barRef.current;
    const measure = measureRef.current;
    if (!bar || !measure || typeof ResizeObserver === "undefined") return;
    const fit = () => {
      const chips = [...measure.querySelectorAll<HTMLElement>("[data-script-chip]")];
      const budget = bar.clientWidth;
      let used = 0;
      let hidden = 0;
      for (const chip of chips) {
        used += chip.offsetWidth + 4;
        if (used > budget) hidden += 1;
      }
      setHiddenCount(hidden);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(bar);
    observer.observe(measure);
    return () => observer.disconnect();
  }, [scriptCount]);

  if (!project || scripts.length === 0) return null;

  const visible = hiddenCount > 0 ? scripts.slice(0, scripts.length - hiddenCount) : scripts;
  const overflow = hiddenCount > 0 ? scripts.slice(scripts.length - hiddenCount) : [];

  const run = async (script: ProjectScript) => {
    try {
      const info = await backend().call("scripts.run", {
        projectId: project.id,
        scriptId: script.id,
        ...(threadId ? { threadId } : {}),
      });
      setLive((current) => ({ ...current, [script.id]: info.sessionId }));
      useStore.setState({ terminalOpen: true });
      saveTerminalOpen(true);
      requestTerminalSession(info);
    } catch (error) {
      useStore.setState({
        notice: error instanceof Error ? error.message : "Could not run the script.",
      });
    }
  };

  const preview = (script: ProjectScript) => {
    const sessionId = live[script.id];
    const template = previewTemplate(script.previewUrl, project.settings.defaultPreviewUrl);
    if (!template) return;
    const url = resolvePreviewUrl(template, sessionId ? (ports[sessionId] ?? null) : null);
    if (url) openExternalUrl(url, { localOnly: true });
  };

  const renderChip = (script: ProjectScript) => {
    const sessionId = live[script.id];
    const running = Boolean(sessionId);
    const template = previewTemplate(script.previewUrl, project.settings.defaultPreviewUrl);
    const url = template
      ? resolvePreviewUrl(template, sessionId ? (ports[sessionId] ?? null) : null)
      : null;
    const previewReady = Boolean(template && url);
    const waitingPort = Boolean(template?.includes("${PORT}") && !url);

    return (
      <span key={script.id} className="script-chip" data-script-chip="">
        <Tooltip label={script.command}>
          <button type="button" className="script-run" onClick={() => void run(script)}>
            <ScriptIcon name={script.icon} />
            <span>{script.name}</span>
            {running ? <span className="script-dot" aria-label="Running" /> : null}
          </button>
        </Tooltip>
        {template ? (
          <Tooltip label={waitingPort ? "Waiting for the server to print its URL" : "Open preview"}>
            <button
              type="button"
              className="script-preview"
              disabled={!previewReady}
              aria-label={waitingPort ? "Waiting for the server to print its URL" : "Open preview"}
              onClick={() => preview(script)}
            >
              Preview
            </button>
          </Tooltip>
        ) : null}
      </span>
    );
  };

  return (
    <div className="scripts-bar-wrap">
      <div ref={measureRef} className="scripts-bar measure" aria-hidden="true">
        {scripts.map(renderChip)}
      </div>
      <div ref={barRef} className="scripts-bar" role="toolbar" aria-label="Project scripts">
        {visible.map(renderChip)}
        {overflow.length > 0 ? (
          <div className="popover-anchor">
            <button
              type="button"
              className="script-overflow"
              aria-label="More scripts"
              aria-expanded={overflowOpen}
              onClick={() => setOverflowOpen((open) => !open)}
            >
              …
            </button>
            {overflowOpen ? (
              <div className="popover below end scripts-overflow-menu" role="menu">
                {overflow.map((script) => (
                  <div key={script.id} role="none">
                    {renderChip(script)}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
