import { ATTACHMENT_MAX_BYTES, type InteractionMode } from "@wooky/contracts";
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
  formatBytes,
  promptWithAttachments,
  readyAttachments,
  type ComposerAttachment,
} from "../lib/attachments.ts";
import {
  configureThread,
  discardAttachment,
  interruptTurn,
  openNewThread,
  startTurn,
  uploadAttachment,
} from "../state/actions.ts";
import { useStore } from "../state/store.ts";
import { ComposerMenuPanel, useComposerMenu } from "./ComposerMenu.tsx";
import { IconClose, IconMic, IconPaperclip, IconSend, IconStop } from "./Icons.tsx";
import { Tooltip } from "./Tooltip.tsx";
import {
  ModelChip,
  RuntimeIndicator,
  type PickerPatch,
  type PickerTarget,
} from "./ModelPicker.tsx";
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
}: ComposerFormProps) {
  const providers = useStore((state) => state.providers);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [caret, setCaret] = useState(0);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuDismissedFor, setMenuDismissedFor] = useState<string | null>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dropped = useRef(new Set<string>());
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

  const uploading = attachments.some((item) => item.status === "uploading");
  const saved = readyAttachments(attachments);
  const canSend = (draft.trim() !== "" || saved.length > 0) && !uploading;

  const attach = (files: readonly File[]) => {
    for (const file of files) {
      const key = crypto.randomUUID();
      const name = file.name || "pasted";
      if (file.size > ATTACHMENT_MAX_BYTES) {
        const limit = formatBytes(ATTACHMENT_MAX_BYTES);
        setAttachments((items) => [
          ...items,
          { key, name, status: "failed", error: `Larger than ${limit}` },
        ]);
        continue;
      }
      setAttachments((items) => [...items, { key, name, status: "uploading" }]);
      uploadAttachment(file).then(
        (attachment) => {
          if (dropped.current.delete(key)) {
            discardAttachment(attachment.id);
            return;
          }
          setAttachments((items) =>
            items.map((item) =>
              item.key === key ? { key, name, status: "ready", attachment } : item,
            ),
          );
        },
        (error: unknown) =>
          setAttachments((items) =>
            items.map((item) =>
              item.key === key
                ? {
                    key,
                    name,
                    status: "failed",
                    error: error instanceof Error ? error.message : "Upload failed",
                  }
                : item,
            ),
          ),
      );
    }
  };

  const detach = (item: ComposerAttachment) => {
    if (item.status === "ready") discardAttachment(item.attachment.id);
    if (item.status === "uploading") dropped.current.add(item.key);
    setAttachments((items) => items.filter((entry) => entry.key !== item.key));
    area.current?.focus();
  };

  const send = async () => {
    if (!canSend || sending) return;
    if (busy && !queueSend) return;
    const prompt = promptWithAttachments(draft, saved);
    setSending(true);
    const taken = await onSend(prompt, queueSend ? "queue" : undefined);
    setSending(false);
    if (taken) {
      setAttachments([]);
      setDraft("");
      setCaret(0);
      setMenuDismissedFor(null);
      if (area.current) area.current.style.height = "";
    }
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
        data-chat-composer-form=""
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
        <div
          className="composer-box"
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes("Files")) event.preventDefault();
          }}
          onDrop={(event) => {
            if (event.dataTransfer.files.length === 0) return;
            event.preventDefault();
            attach([...event.dataTransfer.files]);
          }}
        >
          {attachments.length > 0 ? (
            <ul className="composer-attachments" aria-label="Attachments">
              {attachments.map((item) => (
                <li key={item.key} className="attachment-chip" data-status={item.status}>
                  <span className="attachment-chip-name" title={item.name}>
                    {item.name}
                  </span>
                  <span className="attachment-chip-meta">
                    {item.status === "uploading"
                      ? "Uploading"
                      : item.status === "failed"
                        ? item.error
                        : formatBytes(item.attachment.size)}
                  </span>
                  <Tooltip label="Remove">
                    <button
                      type="button"
                      className="attachment-chip-remove"
                      aria-label={`Remove ${item.name}`}
                      onClick={() => detach(item)}
                    >
                      <IconClose />
                    </button>
                  </Tooltip>
                </li>
              ))}
            </ul>
          ) : null}
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
            onPaste={(event) => {
              const files = [...event.clipboardData.files];
              if (files.length === 0) return;
              event.preventDefault();
              attach(files);
            }}
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
              <Tooltip label="Attach files">
                <button
                  type="button"
                  className="composer-icon-btn"
                  aria-label="Attach files"
                  onClick={() => fileInput.current?.click()}
                >
                  <IconPaperclip />
                </button>
              </Tooltip>
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                tabIndex={-1}
                onChange={(event) => {
                  attach([...(event.currentTarget.files ?? [])]);
                  event.currentTarget.value = "";
                }}
              />
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
              <Tooltip label="Voice input is not available yet">
                <button
                  type="button"
                  className="composer-icon-btn"
                  aria-label="Voice input"
                  disabled
                >
                  <IconMic />
                </button>
              </Tooltip>
              {running ? (
                <Tooltip label="Stop the agent">
                  <button type="submit" className="send-button stop" aria-label="Stop the agent">
                    <IconStop />
                  </button>
                </Tooltip>
              ) : (
                <Tooltip label={queueSend ? "Queue message" : "Send"}>
                  <button
                    type="submit"
                    className="send-button"
                    aria-label={queueSend ? "Queue message" : "Send"}
                    disabled={!canSend || sending || (busy && !queueSend)}
                  >
                    <IconSend />
                  </button>
                </Tooltip>
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

function fitHeight(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
}
