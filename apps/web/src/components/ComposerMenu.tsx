import type { WorkspaceEntry } from "@age/contracts";
import { useEffect, useRef, useState } from "react";
import { RpcCallError } from "../rpc/client.ts";
import {
  composerTrigger,
  filterSlashCommands,
  type ComposerTrigger,
} from "../lib/composer-trigger.ts";
import { backend } from "../state/backend.ts";

export function useComposerMenu(threadId: string, text: string, caret: number) {
  const trigger = composerTrigger(text, caret);
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [entriesQuery, setEntriesQuery] = useState<string | null>(null);
  const [searchUnavailable, setSearchUnavailable] = useState(false);
  const [unavailableFor, setUnavailableFor] = useState<string | null>(null);
  const request = useRef(0);
  const mentionQuery = trigger?.kind === "mention" ? trigger.query : null;
  const visibleEntries = mentionQuery === entriesQuery ? entries : [];

  // sync: debounced fs.searchEntries RPC for @mentions
  useEffect(() => {
    if (mentionQuery === null) {
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

  return {
    trigger,
    menuOpen: trigger !== null && (trigger.kind === "slash" ? slashItems.length > 0 : true),
    slashItems,
    mentionItems,
    searchUnavailable:
      trigger?.kind === "mention" && unavailableFor === mentionQuery && searchUnavailable,
  };
}

export function ComposerMenuPanel({
  trigger,
  slashItems,
  mentionItems,
  searchUnavailable,
  activeIndex,
  listId,
  onPick,
}: {
  trigger: ComposerTrigger;
  slashItems: { id: string; label: string; detail?: string }[];
  mentionItems: { id: string; label: string; detail?: string }[];
  searchUnavailable: boolean;
  activeIndex: number;
  listId: string;
  onPick: (id: string) => void;
}) {
  const items = trigger.kind === "slash" ? slashItems : mentionItems;

  return (
    <div className="composer-menu-wrap">
      {trigger.kind === "mention" && searchUnavailable ? (
        <p className="composer-menu-note">File search unavailable</p>
      ) : null}
      {items.length === 0 && trigger.kind === "mention" && !searchUnavailable ? (
        <p className="composer-menu-note muted">No matches</p>
      ) : null}
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
