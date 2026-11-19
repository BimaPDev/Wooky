import type { ModelTarget, ReadModel, Turn, TurnFailure } from "@age/contracts";
import { DEFAULT_MODEL_RANKING, pickFallback } from "@age/domain";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { failoverThread } from "../../state/actions.ts";
import { useStore } from "../../state/store.ts";
import { isAvailable } from "../labels.ts";
import { useMinuteClock } from "./clock.ts";
import {
  cooldownFor,
  limitedUntilLabel,
  sameTarget,
  switchTargets,
  targetLabel,
  targetOf,
} from "./format.ts";

/** Offered on a failed last turn that was not switched automatically. */
export function SwitchAndRetry({ turn }: { turn: Turn }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  // sync: document pointer events close the menu
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };

  const pick = (target: ModelTarget) => {
    const failure: TurnFailure = {
      kind: "other",
      message: (turn.error ?? "The turn failed.").slice(0, 2000),
    };
    close(false);
    setBusy(true);
    void failoverThread(turn.threadId, target, failure, turn.prompt).finally(() => setBusy(false));
  };

  return (
    <div className="retry-root" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen(!open)}
      >
        Switch and retry
      </button>
      {open ? <RetryMenu turn={turn} onPick={pick} onClose={close} /> : null}
    </div>
  );
}

const EMPTY: Readonly<Record<string, never>> = {};

function RetryMenu({
  turn,
  onPick,
  onClose,
}: {
  turn: Turn;
  onPick: (target: ModelTarget) => void;
  onClose: (restoreFocus: boolean) => void;
}) {
  const thread = useStore((state) => state.model.threads[turn.threadId]);
  const providers = useStore((state) => state.providers);
  const disabledList = useStore((state) => state.deviceSettings?.disabledProviders);
  const chain = useStore((state) => state.deviceSettings?.failover.chain);
  const cooldowns = useStore((state) => state.model.cooldowns ?? EMPTY);
  const nowMs = useMinuteClock();
  const menu = useRef<HTMLDivElement>(null);

  // sync: move focus into the menu when it opens
  useEffect(() => {
    menu.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
  }, []);

  if (!thread) return null;
  const current = targetOf(thread);
  const ranking = chain && chain.length > 0 ? chain : DEFAULT_MODEL_RANKING;
  const disabled = new Set(disabledList ?? []);
  const targets = switchTargets(ranking, providers, disabled, current);
  const readModel: ReadModel = { seq: 0, projects: {}, threads: {}, turns: {}, cooldowns };
  const suggested = pickFallback({
    readModel,
    thread,
    chain: ranking,
    now: new Date(nowMs).toISOString(),
    available: (target) =>
      targets.some((entry) => sameTarget(entry, target)) &&
      providers.some((entry) => entry.kind === target.provider && isAvailable(entry, disabled)),
    failure: { kind: "other", message: turn.error ?? "" },
    maxSwitchesPerPrompt: Number.MAX_SAFE_INTEGER,
  });
  const ordered = suggested
    ? [suggested, ...targets.filter((target) => !sameTarget(target, suggested))]
    : targets;

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose(true);
      return;
    }
    const items = [...(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const move = (index: number) => {
      event.preventDefault();
      items[(index + items.length) % items.length]?.focus();
    };
    if (event.key === "ArrowDown") move(at + 1);
    else if (event.key === "ArrowUp") move(at - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(items.length - 1);
    else if (event.key === "Tab") onClose(false);
  };

  return (
    <div
      className="retry-menu"
      role="menu"
      aria-label="Switch to"
      ref={menu}
      tabIndex={-1}
      onKeyDown={onKey}
    >
      {ordered.length === 0 ? (
        <p className="retry-empty">No other models are available.</p>
      ) : (
        ordered.map((target) => {
          const cooldown = cooldownFor(cooldowns, target, nowMs);
          return (
            <button
              key={`${target.provider}/${target.model}`}
              type="button"
              role="menuitem"
              className="retry-item"
              onClick={() => onPick(target)}
            >
              <span className={`provider-mark provider-${target.provider}`} aria-hidden="true" />
              <span className="retry-item-copy">
                <span className="retry-item-title">{targetLabel(providers, target)}</span>
                {cooldown ? (
                  <span className="retry-item-note">
                    {limitedUntilLabel(cooldown.until, nowMs)}
                  </span>
                ) : null}
              </span>
              {suggested && sameTarget(target, suggested) ? (
                <span className="retry-item-tag">Suggested</span>
              ) : null}
            </button>
          );
        })
      )}
    </div>
  );
}
