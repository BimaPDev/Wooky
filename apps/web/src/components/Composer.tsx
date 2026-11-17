import { useRef, useState } from "react";
import { interruptTurn, startTurn } from "../state/actions.ts";
import { useStore } from "../state/store.ts";
import { IconSend, IconStop } from "./Icons.tsx";
import { modelLabel, providerLabels, runtimeLabel } from "./labels.ts";
import { ModelPickerButton } from "./ModelPicker.tsx";

export function Composer({ threadId }: { threadId: string }) {
  const thread = useStore((state) => state.model.threads[threadId]);
  const providers = useStore((state) => state.providers);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);

  if (!thread) return null;
  const busy = thread.status === "running" || thread.status === "waiting";

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
          rows={1}
          value={draft}
          aria-label="Message"
          placeholder={busy ? "The agent is working" : "Ask for a change"}
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
        <div className="composer-row">
          <ModelPickerButton thread={thread} className="chip subtle" placement="above">
            <span className={`provider-mark provider-${thread.provider}`} aria-hidden="true" />
            {providerLabels[thread.provider]} ·{" "}
            {modelLabel(providers, thread.provider, thread.model)} ·{" "}
            {runtimeLabel(thread.runtimeMode)}
          </ModelPickerButton>
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
    </form>
  );
}

function fitHeight(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
}
