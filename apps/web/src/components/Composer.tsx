import { useRef, useState } from "react";
import { interruptTurn, startTurn } from "../state/actions.ts";
import { useStore } from "../state/store.ts";
import { IconAlert, IconChevron, IconMic, IconPlus, IconSend, IconStop } from "./Icons.tsx";
import { modelLabel, runtimeLabel } from "./labels.ts";
import { ModelPickerButton, PermissionsPickerButton } from "./ModelPicker.tsx";

export function Composer({ threadId }: { threadId: string }) {
  const thread = useStore((state) => state.model.threads[threadId]);
  const providers = useStore((state) => state.providers);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);

  if (!thread) return null;
  const busy = thread.status === "running" || thread.status === "waiting";
  const fullAccess = thread.runtimeMode === "full";

  const send = async () => {
    const prompt = draft.trim();
    if (!prompt || busy || sending) return;
    setSending(true);
    const ack = await startTurn(threadId, prompt);
    setSending(false);
    if (ack) {
      setDraft("");
      if (area.current) area.current.style.height = "";
    }
  };

  const insertMention = () => {
    const el = area.current;
    if (!el) return;
    const start = el.selectionStart ?? draft.length;
    const end = el.selectionEnd ?? draft.length;
    const next = `${draft.slice(0, start)}@${draft.slice(end)}`;
    setDraft(next);
    requestAnimationFrame(() => {
      el.focus();
      const cursor = start + 1;
      el.setSelectionRange(cursor, cursor);
      fitHeight(el);
    });
  };

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy) void interruptTurn(threadId);
        else void send();
      }}
    >
      <div className="composer-box">
        <textarea
          ref={area}
          rows={2}
          value={draft}
          aria-label="Message"
          placeholder={
            busy
              ? "The agent is working"
              : "Ask anything, @tag files/folders, or use / to show available commands"
          }
          onChange={(event) => {
            setDraft(event.target.value);
            fitHeight(event.currentTarget);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div className="composer-toolbar">
          <div className="composer-toolbar-start">
            <button
              type="button"
              className="composer-icon-btn"
              aria-label="Add context"
              title="Tag a file or folder"
              onClick={insertMention}
            >
              <IconPlus />
            </button>
            <PermissionsPickerButton thread={thread} className="composer-chip" placement="above">
              {fullAccess ? (
                <span className="composer-mode-warn" aria-hidden="true">
                  <IconAlert />
                </span>
              ) : null}
              <span className={fullAccess ? "composer-mode-label warn" : "composer-mode-label"}>
                {runtimeLabel(thread.runtimeMode)}
              </span>
              <IconChevron />
            </PermissionsPickerButton>
            <ModelPickerButton thread={thread} className="composer-chip" placement="above">
              <span className={`provider-mark provider-${thread.provider}`} aria-hidden="true" />
              <span className="composer-model-label">
                {modelLabel(providers, thread.provider, thread.model)}
              </span>
              <IconChevron />
            </ModelPickerButton>
          </div>
          <div className="composer-toolbar-end">
            <button
              type="button"
              className="composer-icon-btn"
              aria-label="Voice input"
              title="Voice input is not available yet"
              disabled
            >
              <IconMic />
            </button>
            {busy ? (
              <button type="submit" className="send-button stop" aria-label="Stop the agent">
                <IconStop />
              </button>
            ) : (
              <button
                type="submit"
                className="send-button"
                aria-label="Send"
                disabled={!draft.trim() || sending}
              >
                <IconSend />
              </button>
            )}
          </div>
        </div>
      </div>
    </form>
  );
}

function fitHeight(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
}
