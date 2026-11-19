import type { ModelTarget, ProviderCooldown, ProviderKind, ProviderStatus } from "@wooky/contracts";
import { DEFAULT_MODEL_RANKING } from "@wooky/domain";
import { useState } from "react";
import { IconClose, IconPlus } from "../Icons.tsx";
import {
  cooldownFor,
  limitedUntilLabel,
  moveItem,
  removeItem,
  sameTarget,
  targetLabel,
} from "./format.ts";
import { ProviderMark } from "../ProviderMark.tsx";

const MAX_CHAIN = 12;

function Arrow({ down }: { down?: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={down ? { transform: "rotate(180deg)" } : undefined}
    >
      <path d="M4 10l4-4 4 4" />
    </svg>
  );
}

function TargetRow({
  target,
  index,
  providers,
  cooldown,
  nowMs,
  last,
  disabled,
  onChange,
  chain,
}: {
  target: ModelTarget;
  index: number;
  providers: ProviderStatus[];
  cooldown: ProviderCooldown | null;
  nowMs: number;
  last: boolean;
  disabled: boolean;
  chain: readonly ModelTarget[];
  onChange: (next: readonly ModelTarget[]) => void;
}) {
  const label = targetLabel(providers, target);
  // aria-disabled, not disabled, so focus stays on the button while a row moves to an end.
  const move = (delta: -1 | 1) => {
    if (disabled) return;
    const next = moveItem(chain, index, delta);
    if (next !== chain) onChange(next);
  };
  return (
    <li className="failover-row">
      <span className="failover-rank" aria-hidden="true">
        {index + 1}
      </span>
      <ProviderMark kind={target.provider} />
      <span className="failover-row-copy">
        <span className="failover-row-title">{label}</span>
        {cooldown ? (
          <span className="failover-row-note">{limitedUntilLabel(cooldown.until, nowMs)}</span>
        ) : null}
      </span>
      <span className="failover-row-actions">
        <button
          type="button"
          className="icon-button"
          aria-label={`Move ${label} up`}
          title="Move up"
          aria-disabled={disabled || index === 0}
          onClick={() => move(-1)}
        >
          <Arrow />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={`Move ${label} down`}
          title="Move down"
          aria-disabled={disabled || last}
          onClick={() => move(1)}
        >
          <Arrow down />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={`Remove ${label}`}
          title="Remove"
          disabled={disabled}
          onClick={() => onChange(removeItem(chain, index))}
        >
          <IconClose />
        </button>
      </span>
    </li>
  );
}

export function ChainEditor({
  chain,
  providers,
  cooldowns,
  nowMs,
  disabled,
  onChange,
}: {
  chain: readonly ModelTarget[];
  providers: ProviderStatus[];
  cooldowns: Readonly<Record<string, ProviderCooldown>>;
  nowMs: number;
  disabled: boolean;
  onChange: (next: readonly ModelTarget[]) => void;
}) {
  const [chosenProvider, setProvider] = useState<ProviderKind | null>(null);
  const [chosenModel, setModel] = useState<string | null>(null);

  const pickable = providers.filter((entry) => entry.models.length > 0);
  const provider = pickable.find((entry) => entry.kind === chosenProvider) ?? pickable[0] ?? null;
  const options = (provider?.models ?? []).filter(
    (model) =>
      !chain.some((t) => provider && sameTarget(t, { provider: provider.kind, model: model.id })),
  );
  const model = options.find((entry) => entry.id === chosenModel) ?? options[0] ?? null;
  const full = chain.length >= MAX_CHAIN;

  if (chain.length === 0) {
    return (
      <div className="failover-block">
        <div className="failover-block-head">
          <p className="setting-title">Using the default ranking</p>
          <button
            type="button"
            className="ghost-button"
            disabled={disabled}
            onClick={() => onChange([...DEFAULT_MODEL_RANKING])}
          >
            Customize
          </button>
        </div>
        <ol className="failover-list readonly" aria-label="Default fallback ranking">
          {DEFAULT_MODEL_RANKING.map((target, index) => (
            <li key={`${target.provider}/${target.model}`} className="failover-row">
              <span className="failover-rank" aria-hidden="true">
                {index + 1}
              </span>
              <ProviderMark kind={target.provider} />
              <span className="failover-row-copy">
                <span className="failover-row-title">{targetLabel(providers, target)}</span>
              </span>
            </li>
          ))}
        </ol>
      </div>
    );
  }

  return (
    <div className="failover-block">
      <div className="failover-block-head">
        <p className="setting-title">Fallback order</p>
        <button
          type="button"
          className="ghost-button"
          disabled={disabled}
          onClick={() => onChange([])}
        >
          Use default ranking
        </button>
      </div>
      <ol className="failover-list" aria-label="Fallback order">
        {chain.map((target, index) => (
          <TargetRow
            key={`${target.provider}/${target.model}`}
            target={target}
            index={index}
            providers={providers}
            cooldown={cooldownFor(cooldowns, target, nowMs)}
            nowMs={nowMs}
            last={index === chain.length - 1}
            disabled={disabled}
            chain={chain}
            onChange={onChange}
          />
        ))}
      </ol>
      <div className="failover-add" role="group" aria-label="Add model">
        <select
          className="settings-select"
          aria-label="Provider"
          value={provider?.kind ?? ""}
          disabled={disabled || pickable.length === 0}
          onChange={(event) => {
            setProvider(event.target.value as ProviderKind);
            setModel(null);
          }}
        >
          {pickable.map((entry) => (
            <option key={entry.kind} value={entry.kind}>
              {entry.label}
            </option>
          ))}
        </select>
        <select
          className="settings-select"
          aria-label="Model"
          value={model?.id ?? ""}
          disabled={disabled || options.length === 0}
          onChange={(event) => setModel(event.target.value)}
        >
          {options.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="ghost-button"
          disabled={disabled || full || !provider || !model}
          title={full ? `A list holds at most ${MAX_CHAIN} models` : undefined}
          onClick={() => {
            if (provider && model)
              onChange([...chain, { provider: provider.kind, model: model.id }]);
          }}
        >
          <IconPlus />
          Add model
        </button>
      </div>
    </div>
  );
}
