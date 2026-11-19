import type { WorkspaceEntry } from "@age/contracts";
import { useEffect, useRef, useState } from "react";
import { RpcCallError } from "../rpc/client.ts";
import { mentionMenuFooter } from "../lib/composer-mention-menu.ts";
import {
  composerTrigger,
  filterSlashCommands,
  type ComposerTrigger,
} from "../lib/composer-trigger.ts";
import { backend } from "../state/backend.ts";

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

  const slashItems =
    trigger?.kind === "slash"
      ? filterSlashCommands(trigger.query).map((cmd) => ({
          id: cmd.id,
          label: `/${cmd.id}`,
          detail: cmd.label,
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
    menuOpen: trigger !== null && (trigger.kind === "slash" ? slashItems.length > 0 : true),
    slashItems,
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
  slashItems: { id: string; label: string; detail?: string }[];
  mentionItems: { id: string; label: string; detail?: string }[];
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
          {items.map((item, itemIndex) => (
            <li key={item.id}>
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
                <span className="mono">{item.label}</span>
                {item.detail ? <span className="muted">{item.detail}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
