import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { backend } from "../../state/backend.ts";
import { useStore } from "../../state/store.ts";
import { subscribeTerminal } from "../../state/terminal.ts";
import { findHttpLinks, openExternalUrl, shouldOpenTerminalLink } from "./links.ts";
import { applyXtermTheme } from "./theme.ts";
import { xtermStyles } from "./xterm-styles.ts";

const RESIZE_DEBOUNCE_MS = 50;

export function XtermSession({
  sessionId,
  active,
  pty,
  lineEnding,
  onEnded,
}: {
  sessionId: string;
  active: boolean;
  pty: boolean;
  lineEnding: "\n" | "\r\n";
  onEnded?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const status = useStore((state) => state.status);

  // sync: xterm.js instance on this host node
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      cursorBlink: false,
      fontFamily: getComputedStyle(host).getPropertyValue("--font-mono").trim(),
      convertEol: !pty,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    applyXtermTheme(term, host);
    const links = term.registerLinkProvider({
      provideLinks(row, callback) {
        const line = term.buffer.active.getLine(row - 1)?.translateToString(true) ?? "";
        const found = findHttpLinks(line);
        callback(
          found.length === 0
            ? undefined
            : found.map((link) => ({
                text: link.text,
                range: {
                  start: { x: link.start + 1, y: row },
                  end: { x: link.end, y: row },
                },
                activate(event, text) {
                  if (shouldOpenTerminalLink(event)) openExternalUrl(text);
                },
              })),
        );
      },
    });
    termRef.current = term;
    fitRef.current = fit;
    const data = term.onData((chunk) => {
      const payload = !pty && chunk === "\r" ? lineEnding : chunk;
      void backend().call("terminal.write", { sessionId, data: payload });
    });
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      const copy =
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "c" &&
        !event.shiftKey &&
        !event.altKey;
      if (copy && term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection());
        return false;
      }
      return true;
    });
    return () => {
      data.dispose();
      links.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId, pty, lineEnding]);

  // sync: websocket terminal output into this xterm
  useEffect(() => {
    return subscribeTerminal((message) => {
      if (message.sessionId !== sessionId) return;
      const term = termRef.current;
      if (!term) return;
      if (message.kind === "replay") {
        term.reset();
        if (message.data) term.write(message.data);
        return;
      }
      if (message.kind === "data" && message.data) term.write(message.data);
      if (message.kind === "exit" || message.kind === "error") {
        const text =
          message.data ??
          (message.kind === "exit"
            ? `\r\n[process exited with code ${message.code ?? 0}]\r\n`
            : "");
        if (text) term.write(text);
        term.options.disableStdin = true;
        onEnded?.();
      }
    });
  }, [sessionId, onEnded]);

  // sync: reattach so the server replays scrollback after mount and reconnect
  useEffect(() => {
    if (status !== "open") return;
    void backend()
      .call("terminal.attach", { sessionId })
      .catch(() => {});
  }, [sessionId, status]);

  // sync: container size → fit addon → server pty size
  useEffect(() => {
    const host = hostRef.current;
    const term = termRef.current;
    if (!host || !term || !active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sendFit = () => {
      fitRef.current?.fit();
      void backend().call("terminal.resize", {
        sessionId,
        cols: term.cols,
        rows: term.rows,
      });
    };
    sendFit();
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(sendFit, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(host);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [sessionId, active]);

  // sync: app theme tokens onto the xterm theme
  useEffect(() => {
    const apply = () => {
      const host = hostRef.current;
      const term = termRef.current;
      if (!host || !term) return;
      applyXtermTheme(term, host);
    };
    apply();
    return useStore.subscribe((state, prev) => {
      if (
        state.theme === prev.theme &&
        state.activeAppearance === prev.activeAppearance &&
        state.previewAppearance === prev.previewAppearance
      ) {
        return;
      }
      apply();
    });
  }, []);

  return (
    <div
      ref={hostRef}
      className={xtermStyles ? "xterm-host xterm-host-ready" : "xterm-host"}
      hidden={!active}
    />
  );
}
