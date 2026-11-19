import type { InteractionMode } from "@age/contracts";
import { useId, useRef, useState, type ReactNode } from "react";
import {
  composerMenuDismissalForDraft,
  composerMenuIdentity,
  composerMenuVisible,
  composerTrigger,
  insertMentionPath,
  PLAN_MODE_UNAVAILABLE,
  slashPlanModeAllowed,
  type SlashCommandId,
} from "../lib/composer-trigger.ts";
import {
  configureThread,
  interruptTurn,
  openFanoutDialog,
  openNewThread,
  startTurn,
} from "../state/actions.ts";
import { useStore } from "../state/store.ts";
import { ComposerMenuPanel, useComposerMenu } from "./ComposerMenu.tsx";
import { IconMic, IconPaperclip, IconSend, IconStop } from "./Icons.tsx";
import {
  ModelChip,
  RuntimeIndicator,
  type PickerPatch,
  type PickerTarget,
} from "./ModelPicker.tsx";
import { moveFocus, PopoverChip, usePopoverClose } from "./Popover.tsx";
import { QueuedPrompts } from "./QueuedPrompts.tsx";

export function Composer({ threadId }: { threadId: string }) {
  const thread = useStore((state) => state.model.threads[threadId]);
  const followUp = useStore((state) => state.deviceSettings?.followUp ?? "queue");
  if (!thread) return null;
  const target: PickerTarget = {
    provider: thread.provider,
    model: thread.model,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode ?? "default",
    effort: thread.effort,
    fastMode: thread.fastMode,
    ultracode: thread.ultracode,
  };
  return (
    <ComposerForm
      threadId={threadId}
      target={target}
      status={thread.status === "running" || thread.status === "waiting" ? thread.status : "idle"}
      followUp={followUp}
      failoverThread={thread}
      queue={<QueuedPrompts threadId={threadId} />}
      onChange={(patch) => {
        const { isolate: _isolate, ...rest } = patch;
        void configureThread(threadId, rest);
      }}
      onSend={async (prompt, whenBusy) => Boolean(await startTurn(threadId, prompt, whenBusy))}
      onStop={() => void interruptTurn(threadId)}
      onNewThread={() => openNewThread(thread.projectId)}
      onFanout={(getPrompt) =>
        openFanoutDialog({
          projectId: thread.projectId,
          runtimeMode: thread.runtimeMode,
          getPrompt,
        })
      }
    />
  );
}

export interface ComposerFormProps {
  /** null on the draft screen, where there is no workspace to tag files from. */
  threadId: string | null;
  target: PickerTarget;
  status: "idle" | "running" | "waiting";
  followUp: string;
  failoverThread?: Parameters<typeof ModelChip>[0]["failoverThread"];
  queue?: ReactNode;
  className?: string;
  autoFocus?: boolean;
  onChange: (patch: PickerPatch) => void;
  /** Resolves true when the prompt was taken, so the box can clear. */
  onSend: (prompt: string, whenBusy?: "queue") => Promise<boolean>;
  onStop?: () => void;
  onNewThread: () => void;
  onFanout: (getPrompt: () => string) => void;
}

/** The composer: text, attach, model chip, mic and send, with the runtime mode in a line below. */
export function ComposerForm({
  threadId,
  target,
  status,
  followUp,
  failoverThread,
  queue,
  className,
  autoFocus,
  onChange,
  onSend,
  onStop,
  onNewThread,
  onFanout,
}: ComposerFormProps) {
  const providers = useStore((state) => state.providers);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [caret, setCaret] = useState(0);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuDismissedFor, setMenuDismissedFor] = useState<string | null>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const listId = useId();

  const {
    trigger,
    menuOpen,
    slashItems,
    mentionItems,
    mentionQuery,
    entriesQuery,
    searchUnavailable,
  } = useComposerMenu(threadId, draft, caret);

  const running = status === "running";
  const waiting = status === "waiting";
  const busy = running || waiting;
  const queueSend = running && followUp === "queue";
  const mode: InteractionMode = target.interactionMode;
  const planModeSupported =
    providers.find((entry) => entry.kind === target.provider)?.capabilities?.planMode === true;

  const send = async () => {
    const prompt = draft.trim();
    if (!prompt || sending) return;
    if (busy && !queueSend) return;
    setSending(true);
    const taken = await onSend(prompt, queueSend ? "queue" : undefined);
    setSending(false);
    if (taken) {
      setDraft("");
      setCaret(0);
      setMenuDismissedFor(null);
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
    setMenuDismissedFor(null);
    requestAnimationFrame(() => {
      el.focus();
      const nextCaret = start + 1;
      el.setSelectionRange(nextCaret, nextCaret);
      setCaret(nextCaret);
      fitHeight(el);
    });
  };

  const setMode = (interactionMode: InteractionMode) => {
    if (interactionMode === "plan" && !planModeSupported) {
      useStore.setState({ notice: PLAN_MODE_UNAVAILABLE });
      return;
    }
    onChange({ interactionMode });
  };

  const applySlash = (command: SlashCommandId) => {
    setDraft("");
    setCaret(0);
    setMenuDismissedFor(null);
    switch (command) {
      case "plan": {
        const allowed = slashPlanModeAllowed(planModeSupported);
        if (!allowed.allowed) {
          useStore.setState({ notice: allowed.reason });
          return;
        }
        onChange({ interactionMode: "plan" });
        break;
      }
      case "default":
        onChange({ interactionMode: "default" });
        break;
      case "model":
        setModelPickerOpen(true);
        break;
      case "new":
        onNewThread();
        break;
    }
  };

  const menuItems = trigger?.kind === "slash" ? slashItems : mentionItems;
  const menuDismissed = composerMenuDismissalForDraft(menuDismissedFor, draft);
  const panelOpen = menuOpen && trigger !== null && composerMenuVisible(trigger, menuDismissed);

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
    setMenuDismissedFor(null);
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

  const placeholder = running
    ? followUp === "queue"
      ? "Queue a follow-up while the agent works"
      : "The agent is working"
    : waiting
      ? "Waiting for you"
      : threadId
        ? "Ask anything. @ files, / commands"
        : "Ask anything. / commands";

  return (
    <div
      className={className ? `composer-col ${className}` : "composer-col"}
      data-slot="composer-host"
    >
      {queue}
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          if (running) onStop?.();
          else void send();
        }}
      >
        {panelOpen && trigger ? (
          <ComposerMenuPanel
            trigger={trigger}
            slashItems={slashItems}
            mentionItems={mentionItems}
            mentionQuery={mentionQuery}
            entriesQuery={entriesQuery}
            searchUnavailable={searchUnavailable}
            activeIndex={Math.min(menuIndex, Math.max(0, menuItems.length - 1))}
            listId={listId}
            onPick={(id) => {
              if (trigger.kind === "slash") applySlash(id as SlashCommandId);
              else {
                const next = insertMentionPath(draft, trigger, id);
                setDraft(next.text);
                setCaret(next.caret);
                setMenuDismissedFor(null);
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
            aria-controls={panelOpen ? listId : undefined}
            aria-expanded={panelOpen}
            placeholder={placeholder}
            autoFocus={autoFocus}
            onChange={(event) => {
              const el = event.currentTarget;
              const nextCaret = el.selectionStart ?? 0;
              setDraft(el.value);
              syncCaret(el);
              setMenuIndex(0);
              if (!composerTrigger(el.value, nextCaret)) setMenuDismissedFor(null);
              fitHeight(el);
            }}
            onSelect={(event) => syncCaret(event.currentTarget)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) {
                return;
              }
              if (event.key === "Tab" && event.shiftKey) {
                event.preventDefault();
                if (!busy) setMode(mode === "plan" ? "default" : "plan");
                return;
              }
              if (
                panelOpen &&
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
              if (event.key === "Escape" && panelOpen && trigger) {
                event.preventDefault();
                setMenuDismissedFor(composerMenuIdentity(trigger));
                setMenuIndex(0);
                return;
              }
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                if (panelOpen) return;
                event.preventDefault();
                if (queueSend || !busy) void send();
              }
            }}
          />
          <div className="composer-toolbar">
            <div className="composer-toolbar-start">
              <PopoverChip
                className="composer-icon-btn"
                label="Add"
                ariaLabel="Add context"
                title="Add context"
                size="small"
                panel={
                  <AddMenu
                    canTag={threadId !== null}
                    canFanout={draft.trim() !== ""}
                    onTag={insertMention}
                    onFanout={() => onFanout(() => (area.current?.value ?? "").trim())}
                  />
                }
              >
                <IconPaperclip />
              </PopoverChip>
            </div>
            <div className="composer-toolbar-end">
              <ModelChip
                target={target}
                onChange={onChange}
                locked={busy}
                planSupported={planModeSupported}
                {...(failoverThread ? { failoverThread } : {})}
                open={modelPickerOpen}
                onOpenChange={setModelPickerOpen}
              />
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
      <div className="composer-foot">
        <RuntimeIndicator
          runtimeMode={target.runtimeMode}
          interactionMode={mode}
          locked={busy}
          onChange={onChange}
        />
      </div>
    </div>
  );
}

function AddMenu({
  canTag,
  canFanout,
  onTag,
  onFanout,
}: {
  canTag: boolean;
  canFanout: boolean;
  onTag: () => void;
  onFanout: () => void;
}) {
  const close = usePopoverClose();
  return (
    <div className="runtime-menu" role="menu" aria-label="Add context" onKeyDown={moveFocus}>
      <button
        type="button"
        role="menuitem"
        className="runtime-option"
        disabled={!canTag}
        autoFocus
        title={canTag ? undefined : "Files can be tagged once the thread starts"}
        onClick={() => {
          close();
          onTag();
        }}
      >
        <span className="runtime-option-copy">
          <span className="runtime-option-title">Tag a file or folder</span>
        </span>
      </button>
      <button
        type="button"
        role="menuitem"
        className="runtime-option"
        disabled={!canFanout}
        title={canFanout ? undefined : "Type a message first"}
        onClick={() => {
          close();
          onFanout();
        }}
      >
        <span className="runtime-option-copy">
          <span className="runtime-option-title">Run on several agents</span>
        </span>
      </button>
    </div>
  );
}

function fitHeight(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
}
