import type { ProviderKind, ProviderLimits, Turn } from "@age/contracts";
import { useEffect, useRef, useState } from "react";
import { backend } from "../state/backend.ts";
import { closeSettings } from "../state/actions.ts";
import { useStore } from "../state/store.ts";
import { IconCheck, IconChevron, IconClose, IconRefresh } from "./Icons.tsx";
import { Modal } from "./Modal.tsx";

type Metric = "cost" | "tokens" | "limits";
type WindowDays = 1 | 7 | 30 | 90;
type Breakdown = "model" | "time";

const WINDOW_OPTIONS: { days: WindowDays; label: string }[] = [
  { days: 1, label: "Past 24h" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
];

const METRIC_OPTIONS: { value: Metric; label: string }[] = [
  { value: "cost", label: "Cost" },
  { value: "tokens", label: "Tokens" },
  { value: "limits", label: "Limits" },
];

const PROVIDER_META: Record<ProviderKind, { label: string; color: string }> = {
  codex: { label: "Codex", color: "var(--text)" },
  claude: { label: "Claude Code", color: "var(--usage-claude)" },
  cursor: { label: "Cursor", color: "var(--usage-cursor)" },
  demo: { label: "Demo", color: "var(--accent)" },
};

const PROVIDER_ORDER: ProviderKind[] = ["codex", "claude", "cursor", "demo"];

const TYPE_COLORS = {
  input: "color-mix(in srgb, var(--text) 60%, var(--bg-0))",
  cacheRead: "color-mix(in srgb, var(--text) 30%, var(--bg-0))",
  output: "var(--text)",
  other: "color-mix(in srgb, var(--text) 44%, var(--bg-0))",
};

type PeriodBucket = {
  key: string;
  label: string;
  costByProvider: Map<ProviderKind, number>;
  tokensByProvider: Map<ProviderKind, number>;
  costTotal: number;
  tokensTotal: number;
};

type ProviderRow = {
  name: ProviderKind;
  cost: number;
  tokens: number;
  sessions: number;
};

type ModelRow = {
  name: string;
  provider: ProviderKind;
  cost: number;
  tokens: number;
};

type LimitsLoad =
  | { state: "loading" }
  | { state: "ready"; rows: ProviderLimits[] }
  | { state: "error"; message: string };

export function UsageDashboard() {
  const turns = useStore((state) => state.model.turns);
  const [windowDays, setWindowDays] = useState<WindowDays>(1);
  const [metric, setMetric] = useState<Metric>("cost");
  const [breakdown, setBreakdown] = useState<Breakdown>("model");
  // Refresh re-renders, and stats are rebuilt against the current clock each render.
  const [, setTick] = useState(0);
  const [limitsReq, setLimitsReq] = useState({ nonce: 0, refresh: false });
  const [limitsLoad, setLimitsLoad] = useState<{ key: string; value: LimitsLoad } | null>(null);
  const [hiddenProviders, setHiddenProviders] = useState<ReadonlySet<ProviderKind>>(
    () => new Set(),
  );
  const limitsKey = `${metric}:${limitsReq.nonce}:${limitsReq.refresh ? "1" : "0"}`;

  const stats = buildUsageStats(turns, windowDays, hiddenProviders);

  // sync: server usage.limits when the Limits tab is open
  useEffect(() => {
    if (metric !== "limits") return;
    let cancelled = false;
    backend()
      .call("usage.limits", limitsReq.refresh ? { refresh: true } : {})
      .then(
        (rows) => !cancelled && setLimitsLoad({ key: limitsKey, value: { state: "ready", rows } }),
        (error: unknown) =>
          !cancelled &&
          setLimitsLoad({
            key: limitsKey,
            value: {
              state: "error",
              message: error instanceof Error ? error.message : "Could not load plan limits.",
            },
          }),
      );
    return () => {
      cancelled = true;
    };
  }, [metric, limitsReq, limitsKey]);

  const limitsCurrent: LimitsLoad =
    limitsLoad && limitsLoad.key === limitsKey ? limitsLoad.value : { state: "loading" };

  // T3 AppRouteModal: large floating panel over a dimmed app, not a full-screen page.
  return (
    <Modal label="Usage" onClose={closeSettings} className="modal app-route-modal">
      <div className="usage-shell">
        <header className="usage-topbar">
          <div className="usage-breadcrumb">
            <span className="usage-crumb">Usage</span>
            <span className="crumb-sep" aria-hidden="true">
              /
            </span>
            <span className="usage-crumb muted">This workspace</span>
            <span className="crumb-sep" aria-hidden="true">
              /
            </span>
            <UsageProviderFilter hiddenProviders={hiddenProviders} onChange={setHiddenProviders} />
          </div>
          <div className="usage-topbar-actions">
            {metric !== "limits" ? (
              <Segmented
                ariaLabel="Time range"
                value={String(windowDays)}
                options={WINDOW_OPTIONS.map((option) => ({
                  value: String(option.days),
                  label: option.label,
                }))}
                onChange={(value) => setWindowDays(Number(value) as WindowDays)}
              />
            ) : null}
            <Segmented
              ariaLabel="Metric"
              value={metric}
              options={METRIC_OPTIONS.map((option) => ({
                value: option.value,
                label: option.label,
              }))}
              onChange={(value) => setMetric(value as Metric)}
            />
            <button
              type="button"
              className="icon-button"
              aria-label="Refresh"
              title="Refresh"
              onClick={() => {
                setTick((n) => n + 1);
                if (metric === "limits") {
                  setLimitsReq((prev) => ({ nonce: prev.nonce + 1, refresh: true }));
                }
              }}
            >
              <IconRefresh />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Close usage"
              title="Close (Esc)"
              onClick={closeSettings}
            >
              <IconClose />
            </button>
          </div>
        </header>

        <div className="usage-scroll">
          <div className="usage-page">
            {metric === "limits" ? (
              <UsageLimitsPanel load={limitsCurrent} hiddenProviders={hiddenProviders} />
            ) : (
              <UsageOverview
                stats={stats}
                metric={metric}
                breakdown={breakdown}
                onBreakdown={setBreakdown}
              />
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

function UsageLimitsPanel({
  load,
  hiddenProviders,
}: {
  load: LimitsLoad;
  hiddenProviders: ReadonlySet<ProviderKind>;
}) {
  if (load.state === "loading") {
    return <p className="usage-empty muted">Loading plan limits…</p>;
  }
  if (load.state === "error") {
    return <p className="usage-empty muted">{load.message}</p>;
  }

  const rows = PROVIDER_ORDER.filter((provider) => !hiddenProviders.has(provider)).flatMap(
    (provider) => {
      const row = load.rows.find((entry) => entry.provider === provider);
      return row ? [row] : [];
    },
  );

  if (rows.length === 0) {
    return <p className="usage-empty muted">No providers to show.</p>;
  }

  return (
    <div className="usage-limits">
      {rows.map((row) => (
        <ProviderLimitsCard key={row.provider} row={row} />
      ))}
    </div>
  );
}

function ProviderLimitsCard({ row }: { row: ProviderLimits }) {
  const meta = PROVIDER_META[row.provider];
  return (
    <section className="usage-limits-card">
      <header className="usage-limits-card-head">
        <span className="usage-provider-title">
          <span className="usage-dot" style={{ background: meta.color }} aria-hidden="true" />
          <span className={`provider-mark provider-${row.provider}`} aria-hidden="true" />
          <span>{meta.label}</span>
          {row.plan ? <span className="muted usage-limits-plan">{row.plan}</span> : null}
        </span>
      </header>
      {!row.available ? (
        <p className="muted usage-limits-problem">{row.problem ?? "Plan limits unavailable."}</p>
      ) : row.windows.length === 0 ? (
        <p className="muted usage-limits-problem">No active limit windows.</p>
      ) : (
        <ul className="usage-limits-windows">
          {row.windows.map((window) => {
            const percent = window.usedPercent;
            const fill = percent === null ? 0 : Math.max(0, Math.min(100, percent));
            const tone =
              percent !== null && percent >= 95
                ? "critical"
                : percent !== null && percent >= 80
                  ? "warn"
                  : "ok";
            return (
              <li key={window.id} className="usage-limits-row">
                <div className="usage-limits-row-head">
                  <span>{window.label}</span>
                  <span className="tabular">
                    {percent === null ? "—" : `${Math.round(percent)}%`}
                  </span>
                </div>
                <div className="usage-limits-meter" aria-hidden="true">
                  <span
                    className={`usage-limits-fill tone-${tone}`}
                    style={{ width: `${fill}%` }}
                  />
                </div>
                <p className="muted usage-limits-reset">{formatResetsAt(window.resetsAt)}</p>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function formatResetsAt(resetsAt: string | null, nowMs: number = Date.now()): string {
  if (!resetsAt) return "Reset time unknown";
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at)) return "Reset time unknown";
  const deltaMs = at - nowMs;
  if (deltaMs <= 0) return "Resets soon";
  if (deltaMs < 24 * 60 * 60 * 1000) {
    const totalMins = Math.round(deltaMs / 60_000);
    const hours = Math.floor(totalMins / 60);
    const mins = totalMins % 60;
    if (hours <= 0) return `Resets in ${mins}m`;
    return `Resets in ${hours}h ${mins}m`;
  }
  const date = new Date(at);
  const weekday = date.toLocaleDateString(undefined, { weekday: "short" });
  const time = date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `Resets ${weekday} ${time}`;
}

function UsageOverview({
  stats,
  metric,
  breakdown,
  onBreakdown,
}: {
  stats: ReturnType<typeof buildUsageStats>;
  metric: "cost" | "tokens";
  breakdown: Breakdown;
  onBreakdown: (value: Breakdown) => void;
}) {
  const heroValue = metric === "cost" ? formatUsd(stats.cost) : formatTokens(stats.tokens);
  const peakModel = stats.models.reduce(
    (peak, model) => Math.max(peak, metric === "cost" ? model.cost : model.tokens),
    0,
  );

  return (
    <div className="usage-overview">
      <section className="usage-hero-grid">
        <div className="usage-hero-left">
          <div className="usage-hero-figure">
            <p className="usage-total">{heroValue}</p>
            <p className="muted">
              {formatCount(stats.sessions)} {stats.sessions === 1 ? "session" : "sessions"}
              {metric === "cost" ? " · API estimate" : ""}
            </p>
          </div>
          {stats.providers.length === 0 ? (
            <p className="muted">No activity in this window.</p>
          ) : (
            stats.providers.map((provider) => {
              const share =
                metric === "cost"
                  ? stats.cost > 0
                    ? provider.cost / stats.cost
                    : 0
                  : stats.tokens > 0
                    ? provider.tokens / stats.tokens
                    : 0;
              return (
                <div key={provider.name} className="usage-provider-row">
                  <div className="usage-provider-head">
                    <span className="usage-provider-title">
                      <span
                        className="usage-dot"
                        style={{ background: PROVIDER_META[provider.name].color }}
                        aria-hidden="true"
                      />
                      <span
                        className={`provider-mark provider-${provider.name}`}
                        aria-hidden="true"
                      />
                      <span>{PROVIDER_META[provider.name].label}</span>
                      <span className="muted usage-provider-sessions">
                        {formatCount(provider.sessions)}{" "}
                        {provider.sessions === 1 ? "session" : "sessions"}
                      </span>
                    </span>
                    <strong className="tabular">
                      {metric === "cost" ? formatUsd(provider.cost) : formatTokens(provider.tokens)}
                    </strong>
                  </div>
                  <p className="muted usage-provider-meta">
                    {metric === "cost"
                      ? `${formatPercent(share)} of cost · ${formatTokens(provider.tokens)} tokens`
                      : `${formatPercent(share)} of tokens · ${formatUsd(provider.cost)}`}
                  </p>
                </div>
              );
            })
          )}
        </div>
        <div className="usage-hero-chart">
          <h2>
            {stats.resolution === "hour" ? "Hourly" : "Daily"}{" "}
            {metric === "cost" ? "cost" : "processed tokens"}
          </h2>
          <UsageChart
            periods={stats.periods}
            providers={stats.providers.map((p) => p.name)}
            metric={metric}
          />
        </div>
      </section>

      <section className="usage-totals-block">
        <h2>Totals</h2>
        <dl className="usage-totals-grid">
          <UsageStat label="Processed tokens" value={formatTokens(stats.tokens)} />
          <UsageStat label="Cached input" value={formatTokens(stats.cached)} />
          <UsageStat label="Uncached input" value={formatTokens(stats.uncached)} />
          <UsageStat label="Output" value={formatTokens(stats.output)} />
          <UsageStat label="Cache savings" value={formatUsd(0)} />
        </dl>
      </section>

      {stats.tokens > 0 || stats.cost > 0 ? (
        <section className="usage-share-section">
          {metric === "tokens" ? (
            <ShareBar
              label="Tokens by type"
              segments={[
                { label: "Input", value: stats.uncached, color: TYPE_COLORS.input },
                { label: "Cache read", value: stats.cached, color: TYPE_COLORS.cacheRead },
                { label: "Output", value: stats.output, color: TYPE_COLORS.output },
              ]}
              format={formatTokens}
            />
          ) : (
            <ShareBar
              label="Cost by type"
              segments={[{ label: "Other", value: stats.cost, color: TYPE_COLORS.other }]}
              format={formatUsd}
            />
          )}
        </section>
      ) : null}

      <section className="usage-breakdown">
        <div className="usage-breakdown-head">
          <h2>Breakdown</h2>
          <Segmented
            ariaLabel="Usage breakdown"
            value={breakdown}
            options={[
              { value: "model", label: "Model" },
              { value: "time", label: stats.resolution === "hour" ? "Hour" : "Day" },
            ]}
            onChange={(value) => onBreakdown(value as Breakdown)}
          />
        </div>

        {breakdown === "model" ? (
          <table className="usage-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Model</th>
                <th className="num">Cost</th>
                <th className="num">Share</th>
                <th className="num">Tokens</th>
              </tr>
            </thead>
            <tbody>
              {stats.models.length === 0 ? (
                <tr>
                  <td colSpan={5} className="muted">
                    No activity in this window.
                  </td>
                </tr>
              ) : (
                stats.models.map((model, index) => {
                  const value = metric === "cost" ? model.cost : model.tokens;
                  const share =
                    metric === "cost"
                      ? stats.cost > 0
                        ? model.cost / stats.cost
                        : 0
                      : stats.tokens > 0
                        ? model.tokens / stats.tokens
                        : 0;
                  const bar =
                    peakModel > 0 && value > 0 ? Math.max(2, (value / peakModel) * 100) : 0;
                  return (
                    <tr key={`${model.provider}:${model.name}`}>
                      <td className="muted">{index + 1}</td>
                      <td>
                        <div className="usage-model-cell">
                          <span className="usage-model-name">
                            <span
                              className={`provider-mark provider-${model.provider}`}
                              aria-hidden="true"
                            />
                            <span className="mono">{model.name}</span>
                          </span>
                          {bar > 0 ? (
                            <span
                              className="usage-model-bar"
                              style={{
                                width: `${bar}%`,
                                background: PROVIDER_META[model.provider].color,
                              }}
                              aria-hidden="true"
                            />
                          ) : null}
                        </div>
                      </td>
                      <td className="num tabular">{formatUsd(model.cost)}</td>
                      <td className="num tabular muted">{formatPercent(share)}</td>
                      <td className="num tabular muted">{formatTokens(model.tokens)}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        ) : (
          <table className="usage-table">
            <thead>
              <tr>
                <th>{stats.resolution === "hour" ? "Hour" : "Day"}</th>
                <th className="num">{metric === "cost" ? "Cost" : "Tokens"}</th>
                {stats.providers.map((provider) => (
                  <th key={provider.name} className="num">
                    {PROVIDER_META[provider.name].label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {stats.periods.toReversed().map((period) => {
                const total = metric === "cost" ? period.costTotal : period.tokensTotal;
                const byProvider =
                  metric === "cost" ? period.costByProvider : period.tokensByProvider;
                return (
                  <tr key={period.key}>
                    <td>{period.label}</td>
                    <td className="num tabular">
                      {metric === "cost" ? formatUsd(total) : formatTokens(total)}
                    </td>
                    {stats.providers.map((provider) => (
                      <td key={provider.name} className="num tabular muted">
                        {metric === "cost"
                          ? formatUsd(byProvider.get(provider.name) ?? 0)
                          : formatTokens(byProvider.get(provider.name) ?? 0)}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function UsageChart({
  periods,
  providers,
  metric,
}: {
  periods: PeriodBucket[];
  providers: ProviderKind[];
  metric: "cost" | "tokens";
}) {
  const width = 960;
  const height = 220;
  const top = 8;
  const valueOf = (period: PeriodBucket, provider: ProviderKind) =>
    (metric === "cost" ? period.costByProvider : period.tokensByProvider).get(provider) ?? 0;
  const peak = periods.reduce(
    (max, period) => Math.max(max, ...providers.map((provider) => valueOf(period, provider))),
    0,
  );
  const scale = niceScale(peak);
  const stepX = periods.length < 2 ? 0 : width / (periods.length - 1);
  const y = (value: number) =>
    scale.max === 0 ? height : height - (value / scale.max) * (height - top);

  const paths = providers
    .map((provider) => {
      const points = periods.map((period, index) => ({
        x: index * stepX,
        y: y(valueOf(period, provider)),
      }));
      const line = polyline(points);
      const area = line === "" ? "" : `${line} L${width},${height} L0,${height} Z`;
      const total = periods.reduce((sum, period) => sum + valueOf(period, provider), 0);
      return { provider, line, area, total };
    })
    .toSorted((a, b) => b.total - a.total);

  const labelIndexes =
    periods.length <= 3
      ? periods.map((_, i) => i)
      : [0, Math.floor((periods.length - 1) / 2), periods.length - 1];

  return (
    <div className="usage-chart">
      <div className="usage-chart-plot">
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
          {scale.ticks.map((tick) => (
            <line
              key={tick}
              x1={0}
              x2={width}
              y1={y(tick)}
              y2={y(tick)}
              className="usage-chart-grid"
            />
          ))}
          {paths.map((path) => (
            <g key={path.provider}>
              {path.area ? (
                <path d={path.area} fill={PROVIDER_META[path.provider].color} opacity={0.12} />
              ) : null}
              {path.line ? (
                <path
                  d={path.line}
                  fill="none"
                  stroke={PROVIDER_META[path.provider].color}
                  strokeWidth={2}
                  vectorEffect="non-scaling-stroke"
                />
              ) : null}
            </g>
          ))}
        </svg>
        <div className="usage-chart-y">
          {scale.ticks.toReversed().map((tick) => (
            <span key={tick}>{metric === "cost" ? formatUsd(tick) : formatTokens(tick)}</span>
          ))}
        </div>
      </div>
      <div className="usage-chart-x">
        {labelIndexes.map((index) => (
          <span key={periods[index]?.key ?? index}>{periods[index]?.label ?? ""}</span>
        ))}
      </div>
    </div>
  );
}

function ShareBar({
  label,
  segments,
  format,
}: {
  label: string;
  segments: { label: string; value: number; color: string }[];
  format: (value: number) => string;
}) {
  const visible = segments.filter((segment) => segment.value > 0);
  const total = visible.reduce((sum, segment) => sum + segment.value, 0);
  if (total <= 0) return null;
  return (
    <div className="usage-share">
      <h2>{label}</h2>
      <div className="usage-share-bar" aria-hidden="true">
        {visible.map((segment) => (
          <div
            key={segment.label}
            className="usage-share-seg"
            style={{ flexGrow: segment.value, background: segment.color }}
            title={`${segment.label} · ${format(segment.value)}`}
          />
        ))}
      </div>
      <ul className="usage-share-legend">
        {visible.map((segment) => (
          <li key={segment.label}>
            <span className="usage-share-swatch" style={{ background: segment.color }} />
            <span className="muted">{segment.label}</span>
            <span className="tabular">{format(segment.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function UsageStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="usage-stat">
      <dt className="muted">{label}</dt>
      <dd className="tabular">{value}</dd>
    </div>
  );
}

function Segmented({
  ariaLabel,
  value,
  options,
  onChange,
}: {
  ariaLabel: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="segmented" role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={value === option.value ? "segmented-item active" : "segmented-item"}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function UsageProviderFilter({
  hiddenProviders,
  onChange,
}: {
  hiddenProviders: ReadonlySet<ProviderKind>;
  onChange: (next: ReadonlySet<ProviderKind>) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const visible = PROVIDER_ORDER.filter((provider) => !hiddenProviders.has(provider));
  const label =
    visible.length === PROVIDER_ORDER.length
      ? "All providers"
      : visible.length === 0
        ? "No providers"
        : visible.length === 1 && visible[0]
          ? PROVIDER_META[visible[0]].label
          : `${visible.length} providers`;

  // sync: close the provider filter when clicking outside
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    return () => window.removeEventListener("pointerdown", onPointer);
  }, [open]);

  const setHidden = (next: readonly ProviderKind[]) => onChange(new Set(next));

  return (
    <div className="usage-filter" ref={root}>
      <button
        type="button"
        className="usage-filter-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="usage-crumb muted">{label}</span>
        <IconChevron open={open} />
      </button>
      {open ? (
        <div className="usage-filter-menu" role="menu" aria-label="Providers">
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={hiddenProviders.size === 0}
            className="usage-filter-item"
            onClick={() => setHidden(hiddenProviders.size === 0 ? PROVIDER_ORDER : [])}
          >
            <span className="usage-filter-check" aria-hidden="true">
              {hiddenProviders.size === 0 ? <IconCheck /> : null}
            </span>
            All providers
          </button>
          <div className="usage-filter-sep" />
          {PROVIDER_ORDER.map((provider) => {
            const checked = !hiddenProviders.has(provider);
            return (
              <button
                key={provider}
                type="button"
                role="menuitemcheckbox"
                aria-checked={checked}
                className="usage-filter-item"
                onClick={() =>
                  setHidden(
                    PROVIDER_ORDER.filter((entry) =>
                      entry === provider ? checked : hiddenProviders.has(entry),
                    ),
                  )
                }
              >
                <span className="usage-filter-check" aria-hidden="true">
                  {checked ? <IconCheck /> : null}
                </span>
                <span className={`provider-mark provider-${provider}`} aria-hidden="true" />
                {PROVIDER_META[provider].label}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function buildUsageStats(
  turns: Record<string, Turn[]>,
  windowDays: WindowDays,
  hiddenProviders: ReadonlySet<ProviderKind>,
) {
  const now = Date.now();
  const since = now - windowDays * 24 * 60 * 60 * 1000;
  const resolution: "hour" | "day" = windowDays === 1 ? "hour" : "day";
  const periodKeys = enumeratePeriods(since, now, resolution);
  const periodMap = new Map<string, PeriodBucket>(
    periodKeys.map((key) => [
      key,
      {
        key,
        label: formatPeriodLabel(key, resolution),
        costByProvider: new Map(),
        tokensByProvider: new Map(),
        costTotal: 0,
        tokensTotal: 0,
      },
    ]),
  );

  let sessions = 0;
  let cost = 0;
  let input = 0;
  let output = 0;
  let cached = 0;
  const byProvider = new Map<ProviderKind, ProviderRow>();
  const byModel = new Map<string, ModelRow>();

  for (const list of Object.values(turns)) {
    for (const turn of list) {
      if (hiddenProviders.has(turn.provider)) continue;
      const at = Date.parse(turn.endedAt ?? turn.startedAt);
      if (!Number.isFinite(at) || at < since) continue;
      sessions += 1;
      const usage = turn.usage;
      const turnCost = usage?.costUsd ?? 0;
      const turnIn = usage?.inputTokens ?? 0;
      const turnOut = usage?.outputTokens ?? 0;
      const turnCached = usage?.cachedInputTokens ?? 0;
      const tokens = turnIn + turnOut;
      cost += turnCost;
      input += turnIn;
      output += turnOut;
      cached += turnCached;

      const provider = byProvider.get(turn.provider) ?? {
        name: turn.provider,
        cost: 0,
        tokens: 0,
        sessions: 0,
      };
      provider.cost += turnCost;
      provider.tokens += tokens;
      provider.sessions += 1;
      byProvider.set(turn.provider, provider);

      const modelKey = `${turn.provider}:${turn.model}`;
      const model = byModel.get(modelKey) ?? {
        name: turn.model,
        provider: turn.provider,
        cost: 0,
        tokens: 0,
      };
      model.cost += turnCost;
      model.tokens += tokens;
      byModel.set(modelKey, model);

      const period = periodMap.get(periodKeyFor(at, resolution));
      if (period) {
        period.costByProvider.set(
          turn.provider,
          (period.costByProvider.get(turn.provider) ?? 0) + turnCost,
        );
        period.tokensByProvider.set(
          turn.provider,
          (period.tokensByProvider.get(turn.provider) ?? 0) + tokens,
        );
        period.costTotal += turnCost;
        period.tokensTotal += tokens;
      }
    }
  }

  return {
    sessions,
    cost,
    tokens: input + output,
    input,
    output,
    cached,
    uncached: Math.max(0, input - cached),
    providers: PROVIDER_ORDER.flatMap((name) => {
      const row = byProvider.get(name);
      return row ? [row] : [];
    }),
    models: [...byModel.values()].toSorted((a, b) => b.cost - a.cost || b.tokens - a.tokens),
    periods: periodKeys.flatMap((key) => {
      const period = periodMap.get(key);
      return period ? [period] : [];
    }),
    resolution,
  };
}

function enumeratePeriods(since: number, until: number, resolution: "hour" | "day"): string[] {
  const keys: string[] = [];
  const start = new Date(since);
  if (resolution === "hour") {
    start.setMinutes(0, 0, 0);
    for (let t = start.getTime(); t <= until; t += 60 * 60 * 1000) {
      keys.push(periodKeyFor(t, "hour"));
    }
  } else {
    start.setHours(0, 0, 0, 0);
    for (let t = start.getTime(); t <= until; t += 24 * 60 * 60 * 1000) {
      keys.push(periodKeyFor(t, "day"));
    }
  }
  return keys;
}

function periodKeyFor(ms: number, resolution: "hour" | "day"): string {
  const date = new Date(ms);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  if (resolution === "day") return `${y}-${m}-${d}`;
  const h = String(date.getHours()).padStart(2, "0");
  return `${y}-${m}-${d}T${h}`;
}

function formatPeriodLabel(key: string, resolution: "hour" | "day"): string {
  if (resolution === "hour") {
    const hour = Number(key.slice(11, 13));
    const suffix = hour >= 12 ? "PM" : "AM";
    const hour12 = hour % 12 === 0 ? 12 : hour % 12;
    return `${hour12} ${suffix}`;
  }
  const date = new Date(`${key}T12:00:00`);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function polyline(points: { x: number; y: number }[]): string {
  if (points.length === 0) return "";
  const [first] = points;
  if (points.length === 1 && first) return `M${first.x},${first.y}`;
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)},${point.y.toFixed(2)}`)
    .join(" ");
}

function niceScale(peak: number): { max: number; ticks: number[] } {
  if (peak <= 0) return { max: 1, ticks: [0, 1] };
  const rawStep = peak / 3;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const step = (normalized > 5 ? 10 : normalized > 2 ? 5 : normalized > 1 ? 2 : 1) * magnitude;
  const max = Math.ceil(peak / step) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= max + step * 1e-6; value += step) ticks.push(value);
  return { max, ticks };
}

function formatUsd(n: number): string {
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 10) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(2)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${trimNum(n / 1_000_000)}M`;
  if (n >= 1_000) return `${trimNum(n / 1_000)}k`;
  return String(Math.round(n));
}

function formatCount(n: number): string {
  return new Intl.NumberFormat().format(n);
}

function formatPercent(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function trimNum(n: number): string {
  return n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2);
}
