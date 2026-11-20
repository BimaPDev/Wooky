import type { ProjectPrompt, WorkspaceEntry } from "@wooky/contracts";
import { useEffect, useRef, useState } from "react";
import { RpcCallError } from "../rpc/client.ts";
import { mentionMenuFooter } from "../lib/composer-mention-menu.ts";
import {
  composerTrigger,
  filterSlashCommands,
  type ComposerTrigger,
} from "../lib/composer-trigger.ts";
import { backend } from "../state/backend.ts";
import { draftProjectId, useStore } from "../state/store.ts";

/** Stable empty list: a selector returning a fresh [] re-renders forever (React #185). */
const NO_PROMPTS: readonly ProjectPrompt[] = [];

export const PROMPT_PICK_PREFIX = "prompt:";

export function promptPickId(id: string): string {
  return `${PROMPT_PICK_PREFIX}${id}`;
}

export function promptIdFromPick(id: string): string | null {
  return id.startsWith(PROMPT_PICK_PREFIX) ? id.slice(PROMPT_PICK_PREFIX.length) : null;
}

export function filterPromptPresets(prompts: readonly ProjectPrompt[], query: string) {
  const needle = query.toLowerCase();
  return prompts.filter(
    (prompt) =>
      prompt.name.toLowerCase().includes(needle) || prompt.id.toLowerCase().includes(needle),
  );
}

export function insertPromptText(
  text: string,
  trigger: ComposerTrigger,
  promptText: string,
): { text: string; caret: number } {
  const next = text.slice(0, trigger.replaceStart) + promptText + text.slice(trigger.replaceEnd);
  return { text: next, caret: trigger.replaceStart + promptText.length };
}

/** `threadId` null is the draft screen: there is no workspace to search, so only / commands apply. */
export function useComposerMenu(threadId: string | null, text: string, caret: number) {
  const found = composerTrigger(text, caret);
  const trigger = threadId === null && found?.kind === "mention" ? null : found;
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [entriesQuery, setEntriesQuery] = useState<string | null>(null);
  const [searchUnavailable, setSearchUnavailable] = useState(false);
  const [unavailableFor, setUnavailableFor] = useState<string | null>(null);
  const request = useRef(0);
  const mentionQuery = trigger?.kind === "mention" ? trigger.query : null;
  const visibleEntries = mentionQuery === entriesQuery ? entries : [];

  // sync: debounced fs.searchEntries RPC for @mentions
  useEffect(() => {
    if (mentionQuery === null || threadId === null) {
      request.current += 1;
      return;
    }
    const id = ++request.current;
    const timer = setTimeout(() => {
      try {
        void backend()
          .call("fs.searchEntries", { threadId, query: mentionQuery, limit: 50 })
          .then((result) => {
            if (id !== request.current) return;
            setEntriesQuery(mentionQuery);
            setUnavailableFor(null);
            setSearchUnavailable(false);
            setEntries(result);
          })
          .catch((error) => {
            if (id !== request.current) return;
            setEntriesQuery(mentionQuery);
            setEntries([]);
            const unavailable = error instanceof RpcCallError && error.code === "unavailable";
            setSearchUnavailable(unavailable);
            setUnavailableFor(unavailable ? mentionQuery : null);
          });
      } catch (error) {
        if (id !== request.current) return;
        setEntriesQuery(mentionQuery);
        setEntries([]);
        const unavailable = error instanceof RpcCallError && error.code === "unavailable";
        setSearchUnavailable(unavailable);
        setUnavailableFor(unavailable ? mentionQuery : null);
      }
    }, 80);
    return () => clearTimeout(timer);
  }, [threadId, mentionQuery]);

  const prompts = useStore((state) => {
    const thread = threadId ? state.model.threads[threadId] : undefined;
    const projectId = thread?.projectId ?? draftProjectId(state);
    return (
      (projectId ? state.model.projects[projectId]?.settings.prompts : undefined) ?? NO_PROMPTS
    );
  });

  const slashItems =
    trigger?.kind === "slash"
      ? filterSlashCommands(trigger.query).map((cmd) => ({
          id: cmd.id,
          label: `/${cmd.id}`,
          detail: cmd.label,
        }))
      : [];

  const promptItems =
    trigger?.kind === "slash"
      ? filterPromptPresets(prompts, trigger.query).map((prompt) => ({
          id: promptPickId(prompt.id),
          label: prompt.name,
          detail: "Prompt",
          section: "prompts" as const,
          text: prompt.text,
        }))
      : [];

  const mentionItems =
    trigger?.kind === "mention"
      ? visibleEntries.map((entry) => ({
          id: entry.path,
          label: entry.path,
          detail: entry.kind === "dir" ? "folder" : "file",
        }))
      : [];

  const mentionSearchUnavailable =
    trigger?.kind === "mention" && unavailableFor === mentionQuery && searchUnavailable;

  return {
    trigger,
    menuOpen:
      trigger !== null &&
      (trigger.kind === "slash" ? slashItems.length + promptItems.length > 0 : true),
    slashItems: [...slashItems, ...promptItems],
    promptItems,
    mentionItems,
    mentionQuery,
    entriesQuery,
    searchUnavailable: mentionSearchUnavailable,
  };
}

export function ComposerMenuPanel({
  trigger,
  slashItems,
  mentionItems,
  mentionQuery,
  entriesQuery,
  searchUnavailable,
  activeIndex,
  listId,
  onPick,
}: {
  trigger: ComposerTrigger;
  slashItems: { id: string; label: string; detail?: string; section?: "prompts" }[];
  mentionItems: { id: string; label: string; detail?: string; section?: "prompts" }[];
  mentionQuery: string | null;
  entriesQuery: string | null;
  searchUnavailable: boolean;
  activeIndex: number;
  listId: string;
  onPick: (id: string) => void;
}) {
  const items = trigger.kind === "slash" ? slashItems : mentionItems;
  const footer =
    trigger.kind === "mention"
      ? mentionMenuFooter(mentionQuery, entriesQuery, items.length, searchUnavailable)
      : "none";

  return (
    <div className="composer-menu-wrap">
      {trigger.kind === "mention" && searchUnavailable ? (
        <p className="composer-menu-note">File search unavailable</p>
      ) : null}
      {footer === "searching" ? <p className="composer-menu-note muted">Searching…</p> : null}
      {footer === "no-matches" ? <p className="composer-menu-note muted">No matches</p> : null}
      {items.length > 0 ? (
        <ul
          className="composer-menu"
          role="listbox"
          aria-label={trigger.kind === "slash" ? "Commands" : "Files"}
          id={listId}
        >
          {items.map((item, itemIndex) => {
            const heading =
              trigger.kind === "slash" &&
              item.section === "prompts" &&
              items[itemIndex - 1]?.section !== "prompts";
            return (
              <li key={item.id}>
                {heading ? (
                  <p className="composer-menu-heading" role="presentation">
                    Prompts
                  </p>
                ) : null}
                <button
                  type="button"
                  role="option"
                  aria-selected={itemIndex === activeIndex}
                  className={
                    itemIndex === activeIndex ? "composer-menu-item active" : "composer-menu-item"
                  }
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onPick(item.id)}
                >
                  <span className={item.section === "prompts" ? undefined : "mono"}>
                    {item.label}
                  </span>
                  {item.detail ? <span className="muted">{item.detail}</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
