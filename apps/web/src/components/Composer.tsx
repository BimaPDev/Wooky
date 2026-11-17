import type { InteractionMode } from "@age/contracts";
import { useId, useRef, useState } from "react";
import { insertMentionPath, type SlashCommandId } from "../lib/composer-trigger.ts";
import { configureThread, interruptTurn, openDialog, startTurn } from "../state/actions.ts";
import { useStore } from "../state/store.ts";
import { ComposerMenuPanel, useComposerMenu } from "./ComposerMenu.tsx";
import { IconAlert, IconChevron, IconMic, IconPlus, IconSend, IconStop } from "./Icons.tsx";
import { modelLabel, runtimeLabel } from "./labels.ts";
import { ModelPickerButton, PermissionsPickerButton } from "./ModelPicker.tsx";
import { QueuedPrompts } from "./QueuedPrompts.tsx";

export function Composer({ threadId }: { threadId: string }) {
  const thread = useStore((state) => state.model.threads[threadId]);
  const providers = useStore((state) => state.providers);
  const followUp = useStore((state) => state.deviceSettings?.followUp ?? "queue");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [caret, setCaret] = useState(0);
  const [menuIndex, setMenuIndex] = useState(0);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const listId = useId();

  const { trigger, menuOpen, slashItems, mentionItems, searchUnavailable } = useComposerMenu(
    threadId,
    draft,
    caret,
  );

  if (!thread) return null;
  const running = thread.status === "running";
  const waiting = thread.status === "waiting";
  const busy = running || waiting;
  const queueSend = running && followUp === "queue";
  const fullAccess = thread.runtimeMode === "full";
  const mode: InteractionMode = thread.interactionMode ?? "default";
  const provider = providers.find((entry) => entry.kind === thread.provider);
  const planModeSupported = provider?.capabilities?.planMode === true;

  const send = async () => {
    const prompt = draft.trim();
    if (!prompt || sending) return;
    if (busy && !queueSend) return;
    setSending(true);
    const ack = await startTurn(threadId, prompt, queueSend ? "queue" : undefined);
    setSending(false);
    if (ack) {
      setDraft("");
      setCaret(0);
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
      const nextCaret = start + 1;
      el.setSelectionRange(nextCaret, nextCaret);
      setCaret(nextCaret);
      fitHeight(el);
    });
  };

  const applySlash = (command: SlashCommandId) => {
    setDraft("");
    setCaret(0);
    switch (command) {
      case "plan":
        void configureThread(threadId, { interactionMode: "plan" });
        break;
      case "default":
        void configureThread(threadId, { interactionMode: "default" });
        break;
      case "model":
        setModelPickerOpen(true);
        break;
      case "new":
        openDialog({ kind: "newThread", projectId: thread.projectId });
        break;
    }
  };

  const menuItems = trigger?.kind === "slash" ? slashItems : mentionItems;

  const acceptMenu = () => {
    if (!trigger || menuItems.length === 0) return;
    const choice = menuItems[Math.min(menuIndex, menuItems.length - 1)];
    if (!choice) return;
    if (trigger.kind === "slash") {
      applySlash(choice.id as SlashCommandId);
      return;
    }
    const next = insertMentionPath(draft, trigger, choice.id);
    setDraft(next.text);
    setCaret(next.caret);
    requestAnimationFrame(() => {
      const el = area.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
    });
  };

  const syncCaret = (el: HTMLTextAreaElement) => {
    setCaret(el.selectionStart ?? 0);
  };

  const setMode = (interactionMode: InteractionMode) => {
    if (!planModeSupported && interactionMode === "plan") return;
    void configureThread(threadId, { interactionMode });
  };

  return (
    <div className="composer-col">
      <QueuedPrompts threadId={threadId} />
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          if (running) void interruptTurn(threadId);
          else void send();
        }}
      >
        {menuOpen && trigger ? (
          <ComposerMenuPanel
            trigger={trigger}
            slashItems={slashItems}
            mentionItems={mentionItems}
            searchUnavailable={searchUnavailable}
            activeIndex={Math.min(menuIndex, Math.max(0, menuItems.length - 1))}
            listId={listId}
            onPick={(id) => {
              if (trigger.kind === "slash") applySlash(id as SlashCommandId);
              else {
                const next = insertMentionPath(draft, trigger, id);
                setDraft(next.text);
                setCaret(next.caret);
              }
            }}
          />
        ) : null}
        <div className="composer-box">
          <textarea
            ref={area}
            rows={2}
            value={draft}
            aria-label="Message"
            aria-controls={menuOpen ? listId : undefined}
            aria-expanded={menuOpen}
            placeholder={
              running
                ? followUp === "queue"
                  ? "Queue a follow-up while the agent works"
                  : "The agent is working"
                : waiting
                  ? "Waiting for you"
                  : "Ask anything, @tag files/folders, or use / to show available commands"
            }
            onChange={(event) => {
              setDraft(event.target.value);
              syncCaret(event.currentTarget);
              setMenuIndex(0);
              fitHeight(event.currentTarget);
            }}
            onSelect={(event) => syncCaret(event.currentTarget)}
            onKeyDown={(event) => {
              if (
                menuOpen &&
                menuItems.length > 0 &&
                (event.key === "ArrowDown" ||
                  event.key === "ArrowUp" ||
                  event.key === "Tab" ||
                  (event.key === "Enter" && !event.shiftKey))
              ) {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setMenuIndex((value) => (value + 1) % menuItems.length);
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setMenuIndex((value) => (value - 1 + menuItems.length) % menuItems.length);
                  return;
                }
                if (event.key === "Enter" || event.key === "Tab") {
                  event.preventDefault();
                  acceptMenu();
                  return;
                }
              }
              if (event.key === "Escape" && menuOpen) {
                event.preventDefault();
                setMenuIndex(0);
                return;
              }
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                if (menuOpen) return;
                event.preventDefault();
                if (queueSend || !busy) void send();
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
              <PlanModeControl mode={mode} supported={planModeSupported} onMode={setMode} />
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
              <ModelPickerOpen
                thread={thread}
                providers={providers}
                forceOpen={modelPickerOpen}
                onOpenChange={setModelPickerOpen}
              />
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
              {running ? (
                <button type="submit" className="send-button stop" aria-label="Stop the agent">
                  <IconStop />
                </button>
              ) : (
                <button
                  type="submit"
                  className="send-button"
                  aria-label={queueSend ? "Queue message" : "Send"}
                  disabled={!draft.trim() || sending || (busy && !queueSend)}
                >
                  <IconSend />
                </button>
              )}
            </div>
          </div>
        </div>
      </form>
    </div>
  );
}

function PlanModeControl({
  mode,
  supported,
  onMode,
}: {
  mode: InteractionMode;
  supported: boolean;
  onMode: (mode: InteractionMode) => void;
}) {
  const title = supported
    ? "Switch between default and plan mode"
    : "This provider does not support plan mode";
  return (
    <div className="plan-mode-control" title={supported ? undefined : title}>
      <button
        type="button"
        className={mode === "default" ? "composer-chip active" : "composer-chip"}
        disabled={!supported && mode !== "default"}
        aria-pressed={mode === "default"}
        onClick={() => onMode("default")}
      >
        Default
      </button>
      <button
        type="button"
        className={mode === "plan" ? "composer-chip active" : "composer-chip"}
        disabled={!supported}
        aria-pressed={mode === "plan"}
        title={supported ? title : title}
        onClick={() => onMode("plan")}
      >
        Plan
      </button>
    </div>
  );
}

function ModelPickerOpen({
  thread,
  providers,
  forceOpen,
  onOpenChange,
}: {
  thread: Parameters<typeof ModelPickerButton>[0]["thread"];
  providers: Parameters<typeof modelLabel>[0];
  forceOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <ModelPickerButton
      thread={thread}
      className="composer-chip"
      placement="above"
      open={forceOpen}
      onOpenChange={onOpenChange}
    >
      <span className={`provider-mark provider-${thread.provider}`} aria-hidden="true" />
      <span className="composer-model-label">
        {modelLabel(providers, thread.provider, thread.model)}
      </span>
      <IconChevron />
    </ModelPickerButton>
  );
}

function fitHeight(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
}
