import { useEffect, useEffectEvent, useRef, useState } from "react";
import { toggleTerminal } from "../state/actions.ts";
import { backend } from "../state/backend.ts";
import { useStore } from "../state/store.ts";
import { subscribeTerminal } from "../state/terminal.ts";
import { IconClose } from "./Icons.tsx";
import { Tooltip } from "./Tooltip.tsx";

/** Ending comes from `terminal.open`. Older servers omit it; those shells want LF. */
export function terminalLine(text: string, lineEnding: "\n" | "\r\n" = "\n"): string {
  return `${text}${lineEnding}`;
}

export function TerminalPane() {
  const thread = useStore((state) =>
    state.selectedThreadId ? state.model.threads[state.selectedThreadId] : undefined,
  );
  const project = useStore((state) =>
    thread ? state.model.projects[thread.projectId] : undefined,
  );
  const cwd = thread?.worktree?.path ?? project?.root ?? null;
  const [generation, setGeneration] = useState(0);

  // A new cwd or a restart remounts the session, which resets its state.
  return (
    <TerminalSession
      key={`${cwd ?? ""}:${generation}`}
      cwd={cwd}
      onRestart={() => setGeneration((value) => value + 1)}
    />
  );
}

function TerminalSession({ cwd, onRestart }: { cwd: string | null; onRestart: () => void }) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [output, setOutput] = useState("");
  const [line, setLine] = useState("");
  const [status, setStatus] = useState<"starting" | "ready" | "exited" | "error">("starting");
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLPreElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const sessionRef = useRef<string | null>(null);
  const lineEndingRef = useRef<"\n" | "\r\n">("\n");

  const writeTo = (id: string, text: string) =>
    backend()
      .call("terminal.write", { sessionId: id, data: terminalLine(text, lineEndingRef.current) })
      .then(
        () => setOutput((prev) => prev + `$ ${text}\n`),
        (err: unknown) => {
          setStatus("error");
          setError(err instanceof Error ? err.message : "Write failed.");
        },
      );

  const onReady = useEffectEvent((id: string, lineEnding: "\n" | "\r\n") => {
    sessionRef.current = id;
    lineEndingRef.current = lineEnding;
    setSessionId(id);
    setStatus("ready");
  });

  const onOpenFailed = useEffectEvent((err: unknown) => {
    setStatus("error");
    setError(err instanceof Error ? err.message : "Could not start the shell.");
  });

  // sync: open a server shell session for this cwd; close it on unmount
  useEffect(() => {
    let cancelled = false;
    const open = async () => {
      try {
        const result = await backend().call("terminal.open", cwd ? { cwd } : {});
        if (cancelled) {
          void backend().call("terminal.close", { sessionId: result.sessionId });
          return;
        }
        onReady(result.sessionId, result.lineEnding === "\r\n" ? "\r\n" : "\n");
      } catch (err) {
        if (!cancelled) onOpenFailed(err);
      }
    };
    void open();
    return () => {
      cancelled = true;
      const id = sessionRef.current;
      sessionRef.current = null;
      if (id) void backend().call("terminal.close", { sessionId: id });
    };
  }, [cwd]);

  // sync: append terminal chunks pushed over the websocket for this session
  useEffect(() => {
    return subscribeTerminal((message) => {
      if (!sessionRef.current || message.sessionId !== sessionRef.current) return;
      if (message.kind === "data" && message.data) {
        setOutput((prev) => prev + message.data);
      } else if (message.kind === "exit") {
        if (message.data) setOutput((prev) => prev + message.data);
        setStatus("exited");
        sessionRef.current = null;
        setSessionId(null);
      } else if (message.kind === "error") {
        setStatus("error");
        setError(message.data ?? "Shell error.");
        sessionRef.current = null;
        setSessionId(null);
      }
    });
  }, []);

  // sync: keep the output element's scroll pinned to the bottom as chunks arrive
  useEffect(() => {
    const node = scrollRef.current;
    if (!node || output.length === 0) return;
    node.scrollTop = node.scrollHeight;
  }, [output]);

  const writeLine = async (text: string) => {
    if (!sessionId || status !== "ready") return;
    await writeTo(sessionId, text);
  };

  const sendLine = async () => {
    if (!line) return;
    const text = line;
    setLine("");
    await writeLine(text);
  };

  const sendInterrupt = async () => {
    if (!sessionId || status !== "ready") return;
    try {
      await backend().call("terminal.write", { sessionId, data: "\u0003" });
    } catch {
      // ignore
    }
  };

  return (
    <section className="terminal-pane" aria-label="Terminal">
      <header className="terminal-head">
        <div className="terminal-tabs" role="tablist" aria-label="Side panel">
          <button type="button" role="tab" className="terminal-tab active" aria-selected={true}>
            Terminal
          </button>
        </div>
        <div className="terminal-head-actions">
          {status === "exited" || status === "error" ? (
            <button type="button" className="ghost-button" onClick={onRestart}>
              Restart
            </button>
          ) : null}
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
      <div
        className="terminal-scroll"
        onClick={() => inputRef.current?.focus()}
        onKeyDown={() => inputRef.current?.focus()}
        role="presentation"
      >
        <pre className="terminal-output" ref={scrollRef}>
          {status === "starting" ? <span className="terminal-muted">Starting shell…</span> : null}
          {error ? <span className="terminal-error">{error}</span> : null}
          {output}
        </pre>
        {status === "ready" ? (
          <form
            className="terminal-input-row"
            onSubmit={(event) => {
              event.preventDefault();
              void sendLine();
            }}
          >
            <span className="terminal-prompt" aria-hidden="true">
              $
            </span>
            <input
              ref={inputRef}
              className="terminal-input"
              value={line}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              aria-label="Terminal input"
              onChange={(event) => setLine(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "c" && event.ctrlKey) {
                  event.preventDefault();
                  void sendInterrupt();
                }
              }}
            />
          </form>
        ) : null}
      </div>
    </section>
  );
}
