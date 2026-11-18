import type {
  ProviderKind,
  ProviderLimits,
  UsageHistoryResult,
  UsageHistorySource,
  UsageWindowDays,
} from "@age/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { RpcCallError } from "../rpc/client.ts";
import { visibleCostSegments } from "../lib/usage-cost-by-type.ts";
import {
  USAGE_SERIES_ORDER,
  collectTurnRows,
  turnProvidersFromSources,
  usesImportedHistory,
  type UsageSeriesId,
} from "../lib/usage-merge.ts";
import { buildUsageDashboardStats, type UsageDashboardStats } from "../lib/usage-stats.ts";
import { backend } from "../state/backend.ts";
import { closeSettings } from "../state/actions.ts";
import { useStore } from "../state/store.ts";
import { IconCheck, IconChevron, IconClose, IconInfo, IconRefresh } from "./Icons.tsx";
import { Modal } from "./Modal.tsx";

type Metric = "cost" | "tokens" | "limits";
type Breakdown = "model" | "time";

const WINDOW_OPTIONS: { days: UsageWindowDays; label: string }[] = [
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

const LIMITS_PROVIDERS: ProviderKind[] = ["codex", "claude", "cursor", "demo"];

const SERIES_META: Record<
  UsageSeriesId,
  { label: string; color: string; markClass?: ProviderKind }
> = {
  codex: { label: "Codex", color: "var(--text)", markClass: "codex" },
  claude: { label: "Claude Code", color: "var(--usage-claude)", markClass: "claude" },
  cursor: { label: "Cursor", color: "var(--usage-cursor)", markClass: "cursor" },
  opencode: { label: "OpenCode", color: "var(--text)" },
  demo: { label: "Demo", color: "var(--accent)", markClass: "demo" },
};

const TYPE_COLORS = {
  input: "color-mix(in srgb, var(--text) 60%, var(--bg-0))",
  cacheRead: "color-mix(in srgb, var(--text) 30%, var(--bg-0))",
  cacheWrite: "color-mix(in srgb, var(--text) 45%, var(--bg-0))",
  output: "var(--text)",
  other: "color-mix(in srgb, var(--text) 44%, var(--bg-0))",
};

type LimitsLoad =
  | { state: "loading" }
  | { state: "ready"; rows: ProviderLimits[] }
  | { state: "error"; message: string };

type HistoryLoad =
  | { state: "loading" }
  | { state: "ready"; data: UsageHistoryResult | null; fallbackNote?: string }
  | { state: "error"; message: string };

const EMPTY_HISTORY_SOURCES: UsageHistorySource[] = [];

const EMPTY_STATS: UsageDashboardStats = {
  sessions: 0,
  cost: 0,
  tokens: 0,
  inputTokens: 0,
  uncachedInput: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  cacheSavings: 0,
  costByType: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, other: 0 },
  unpricedRecords: 0,
  providers: [],
  models: [],
  periods: [],
  resolution: "day",
};

export function UsageDashboard() {
  const turns = useStore((state) => state.model.turns);
  const [windowDays, setWindowDays] = useState<UsageWindowDays>(30);
  const [metric, setMetric] = useState<Metric>("cost");
  const [breakdown, setBreakdown] = useState<Breakdown>("model");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [limitsReq, setLimitsReq] = useState({ nonce: 0, refresh: false });
  const [historyReq, setHistoryReq] = useState({ nonce: 0, refresh: false });
  const [limitsLoad, setLimitsLoad] = useState<{ key: string; value: LimitsLoad } | null>(null);
  const [historyLoad, setHistoryLoad] = useState<{ key: string; value: HistoryLoad } | null>(null);
  const [hiddenSeries, setHiddenSeries] = useState<ReadonlySet<UsageSeriesId>>(() => new Set());
  const [timeZone] = useState(() => {
    const format = Intl.DateTimeFormat();
    return format.resolvedOptions().timeZone;
  });

  const limitsKey = `${metric}:${limitsReq.nonce}:${limitsReq.refresh ? "1" : "0"}`;
  const historyKey = `${metric}:${windowDays}:${timeZone}:${historyReq.nonce}:${historyReq.refresh ? "1" : "0"}`;

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

  // sync: server usage.history for cost and token tabs
  useEffect(() => {
    if (metric === "limits") return;
    let cancelled = false;
    backend()
      .call("usage.history", {
        windowDays,
        timeZone,
        awaitRefresh: historyReq.refresh,
      })
      .then(
        (data) =>
          !cancelled && setHistoryLoad({ key: historyKey, value: { state: "ready", data } }),
        (error: unknown) => {
          if (cancelled) return;
          if (error instanceof RpcCallError && error.code === "unavailable") {
            setHistoryLoad({
              key: historyKey,
              value: {
                state: "ready",
                data: null,
                fallbackNote:
                  "Local history is unavailable on this server. Showing Wooky turns only.",
              },
            });
            return;
          }
          setHistoryLoad({
            key: historyKey,
            value: {
              state: "error",
              message: error instanceof Error ? error.message : "Could not load usage history.",
            },
          });
        },
      );
    return () => {
      cancelled = true;
    };
  }, [metric, windowDays, timeZone, historyReq, historyKey]);

  const limitsCurrent: LimitsLoad =
    limitsLoad && limitsLoad.key === limitsKey ? limitsLoad.value : { state: "loading" };

  const historyCurrent =
    historyLoad && historyLoad.key === historyKey
      ? historyLoad.value
      : metric === "limits"
        ? null
        : ({ state: "loading" } satisfies HistoryLoad);

  const historyData =
    historyCurrent?.state === "ready"
      ? historyCurrent.data
      : historyCurrent?.state === "loading"
        ? undefined
        : null;
  const fallbackNote = historyCurrent?.state === "ready" ? historyCurrent.fallbackNote : undefined;
  const historySources = historyData?.sources ?? EMPTY_HISTORY_SOURCES;
  const turnProviders = useMemo(() => turnProvidersFromSources(historySources), [historySources]);
  const turnRows = useMemo(() => collectTurnRows(turns, turnProviders), [turns, turnProviders]);

  const stats = useMemo(() => {
    if (metric === "limits") return EMPTY_STATS;
    if (historyCurrent?.state === "loading" && historyData === undefined) return EMPTY_STATS;
    return buildUsageDashboardStats({
      buckets: historyData?.buckets ?? [],
      sources: historySources,
      turnRows,
      windowDays,
      timeZone,
      nowMs,
      hiddenSeries,
    });
  }, [
    metric,
    historyCurrent?.state,
    historyData,
    historySources,
    turnRows,
    windowDays,
    timeZone,
    nowMs,
    hiddenSeries,
  ]);

  const scanning =
    metric !== "limits" &&
    (historyCurrent?.state === "loading" || historySources.some((source) => source.refreshing));
  const importedFooter = historySources.some((source) => usesImportedHistory(source.status));
  const dimsOverview = scanning && stats.providers.length > 0;

  return (
    <Modal label="Usage" onClose={closeSettings} className="modal app-route-modal">
      <div className="usage-shell">
        <header className="usage-topbar">
          <div className="usage-breadcrumb">
            <span className="usage-crumb">Usage</span>
            <span className="crumb-sep" aria-hidden="true">
              /
            </span>
            <span className="usage-crumb muted">This machine</span>
            <span className="crumb-sep" aria-hidden="true">
              /
            </span>
            <UsageSeriesFilter hiddenSeries={hiddenSeries} onChange={setHiddenSeries} />
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
                onChange={(value) => setWindowDays(Number(value) as UsageWindowDays)}
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
                setNowMs(Date.now());
                if (metric === "limits") {
                  setLimitsReq((prev) => ({ nonce: prev.nonce + 1, refresh: true }));
                } else {
                  setHistoryReq((prev) => ({ nonce: prev.nonce + 1, refresh: true }));
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
              <UsageLimitsPanel
                load={limitsCurrent}
                hiddenProviders={hiddenFromSeries(hiddenSeries)}
              />
            ) : (
              <>
                {scanning ? <UsageScanningBanner /> : null}
                {historyCurrent?.state === "error" ? (
                  <p className="usage-note muted">{historyCurrent.message}</p>
                ) : null}
                <UsageOverview
                  stats={stats}
                  metric={metric}
                  breakdown={breakdown}
                  onBreakdown={setBreakdown}
                  dimmed={dimsOverview}
                  pricing={historyData?.pricing ?? null}
                  unpricedRecords={stats.unpricedRecords}
                  fallbackNote={fallbackNote}
                />
                {importedFooter ? (
                  <UsageImportFooter
                    sources={historySources}
                    pricing={historyData?.pricing ?? null}
                  />
                ) : null}
                {!scanning && stats.providers.length === 0 ? (
                  <p className="usage-empty muted">No usage found for this window.</p>
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

function hiddenFromSeries(hidden: ReadonlySet<UsageSeriesId>): ReadonlySet<ProviderKind> {
  const out = new Set<ProviderKind>();
  for (const id of hidden) {
    if (id !== "opencode") out.add(id);
  }
  return out;
}

function UsageScanningBanner() {
  return (
    <div className="usage-scanning" role="status">
      <p>Scanning your agent history…</p>
      <div className="usage-scan-track" aria-hidden="true">
        <span className="usage-scan-fill" />
      </div>
    </div>
  );
}

function UsageImportFooter({
  sources,
  pricing,
}: {
  sources: readonly UsageHistorySource[];
  pricing: UsageHistoryResult["pricing"] | null;
}) {
  const lines = sourceStatusLines(sources);
  const pricingNote =
    pricing?.status === "stale"
      ? "Pricing data may be out of date."
      : pricing?.status === "unavailable"
        ? "Pricing data unavailable. Costs may show as zero."
        : null;
  if (lines.length === 0 && !pricingNote) return null;
  return (
    <footer className="usage-import-footer muted">
      <p>Imported from local history</p>
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
      {pricingNote ? <p>{pricingNote}</p> : null}
    </footer>
  );
}

function sourceStatusLines(sources: readonly UsageHistorySource[]): string[] {
  return sources.flatMap((source) => {
    if (source.status === "partial") {
      const detail = source.note ? `, ${source.note}` : "";
      return [`${SERIES_META[source.origin].label}: partial${detail}`];
    }
    if (source.status === "failed") {
      return [`${SERIES_META[source.origin].label}: import failed`];
    }
    return [];
  });
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

  const rows = LIMITS_PROVIDERS.filter((provider) => !hiddenProviders.has(provider)).flatMap(
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
  const meta = SERIES_META[row.provider];
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
  dimmed,
  pricing,
  unpricedRecords,
  fallbackNote,
}: {
  stats: UsageDashboardStats;
  metric: "cost" | "tokens";
  breakdown: Breakdown;
  onBreakdown: (value: Breakdown) => void;
  dimmed: boolean;
  pricing: UsageHistoryResult["pricing"] | null;
  unpricedRecords: number;
  fallbackNote?: string;
}) {
  const heroValue = metric === "cost" ? formatUsd(stats.cost) : formatTokens(stats.tokens);
  const peakModel = stats.models.reduce(
    (peak, model) => Math.max(peak, metric === "cost" ? model.cost : model.tokens),
    0,
  );
  const costSegments = visibleCostSegments(stats.costByType).map((segment) => ({
    label: segment.label,
    value: segment.value,
    color: TYPE_COLORS[segment.key],
  }));

  return (
    <div className={dimmed ? "usage-overview usage-dimmed" : "usage-overview"}>
      <section className="usage-hero-grid">
        <div className="usage-hero-left">
          <div className="usage-hero-figure">
            <p className="usage-total">{heroValue}</p>
            <p className="muted usage-hero-caption">
              {formatCount(stats.sessions)} {stats.sessions === 1 ? "session" : "sessions"}
              {metric === "cost" ? (
                <>
                  {" · "}
                  <span className="usage-api-estimate">API estimate</span>
                  <UsageEstimatePopover />
                </>
              ) : null}
            </p>
            {unpricedRecords > 0 ? (
              <p className="usage-note muted">{formatCount(unpricedRecords)} records unpriced</p>
            ) : null}
            {fallbackNote ? <p className="usage-note muted">{fallbackNote}</p> : null}
            {pricing?.status === "stale" ? (
              <p className="usage-note muted">API price table may be stale.</p>
            ) : null}
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
              const meta = SERIES_META[provider.id];
              return (
                <div key={provider.id} className="usage-provider-row">
                  <div className="usage-provider-head">
                    <span className="usage-provider-title">
                      <span
                        className="usage-dot"
                        style={{ background: meta.color }}
                        aria-hidden="true"
                      />
                      {meta.markClass ? (
                        <span
                          className={`provider-mark provider-${meta.markClass}`}
                          aria-hidden="true"
                        />
                      ) : null}
                      <span>{meta.label}</span>
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
            series={stats.providers.map((p) => p.id)}
            metric={metric}
          />
        </div>
      </section>

      <section className="usage-totals-block">
        <h2>Totals</h2>
        <dl className="usage-totals-grid">
          <UsageStat label="Processed tokens" value={formatTokens(stats.tokens)} />
          <UsageStat label="Cached input" value={formatTokens(stats.cacheRead)} />
          <UsageStat label="Uncached input" value={formatTokens(stats.uncachedInput)} />
          <UsageStat label="Output" value={formatTokens(stats.output)} />
          <UsageStat label="Cache savings" value={formatUsd(stats.cacheSavings)} />
        </dl>
      </section>

      {stats.tokens > 0 || stats.cost > 0 ? (
        <section className="usage-share-section">
          {metric === "tokens" ? (
            <ShareBar
              label="Tokens by type"
              segments={[
                { label: "Input", value: stats.uncachedInput, color: TYPE_COLORS.input },
                { label: "Cache read", value: stats.cacheRead, color: TYPE_COLORS.cacheRead },
                { label: "Cache write", value: stats.cacheWrite, color: TYPE_COLORS.cacheWrite },
                { label: "Output", value: stats.output, color: TYPE_COLORS.output },
              ]}
              format={formatTokens}
            />
          ) : (
            <ShareBar label="Cost by type" segments={costSegments} format={formatUsd} />
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
                  const meta = SERIES_META[model.series];
                  return (
                    <tr key={`${model.series}:${model.name}`}>
                      <td className="muted">{index + 1}</td>
                      <td>
                        <div className="usage-model-cell">
                          <span className="usage-model-name">
                            {meta.markClass ? (
                              <span
                                className={`provider-mark provider-${meta.markClass}`}
                                aria-hidden="true"
                              />
                            ) : (
                              <span
                                className="usage-dot"
                                style={{ background: meta.color }}
                                aria-hidden="true"
                              />
                            )}
                            <span className="mono">{model.name}</span>
                          </span>
                          {bar > 0 ? (
                            <span
                              className="usage-model-bar"
                              style={{
                                width: `${bar}%`,
                                background: meta.color,
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
                  <th key={provider.id} className="num">
                    {SERIES_META[provider.id].label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {stats.periods.toReversed().map((period) => {
                const total = metric === "cost" ? period.costTotal : period.tokensTotal;
                const bySeries = metric === "cost" ? period.costBySeries : period.tokensBySeries;
                return (
                  <tr key={period.key}>
                    <td>{period.label}</td>
                    <td className="num tabular">
                      {metric === "cost" ? formatUsd(total) : formatTokens(total)}
                    </td>
                    {stats.providers.map((provider) => (
                      <td key={provider.id} className="num tabular muted">
                        {metric === "cost"
                          ? formatUsd(bySeries.get(provider.id) ?? 0)
                          : formatTokens(bySeries.get(provider.id) ?? 0)}
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

function UsageEstimatePopover() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);

  // sync: close the API estimate popover when clicking outside
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    return () => window.removeEventListener("pointerdown", onPointer);
  }, [open]);

  return (
    <span className="usage-info-anchor" ref={root}>
      <button
        type="button"
        className="usage-info-button"
        aria-label="About API estimate"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <IconInfo />
      </button>
      {open ? (
        <span className="usage-info-popover" role="tooltip">
          Estimated cost at published API prices. This is not a subscription bill.
        </span>
      ) : null}
    </span>
  );
}

function UsageChart({
  periods,
  series,
  metric,
}: {
  periods: UsageDashboardStats["periods"];
  series: UsageSeriesId[];
  metric: "cost" | "tokens";
}) {
  const width = 960;
  const height = 220;
  const top = 8;
  const valueOf = (period: UsageDashboardStats["periods"][number], id: UsageSeriesId) =>
    (metric === "cost" ? period.costBySeries : period.tokensBySeries).get(id) ?? 0;
  const peak = periods.reduce(
    (max, period) => Math.max(max, ...series.map((id) => valueOf(period, id))),
    0,
  );
  const scale = niceScale(peak);
  const stepX = periods.length < 2 ? 0 : width / (periods.length - 1);
  const y = (value: number) =>
    scale.max === 0 ? height : height - (value / scale.max) * (height - top);

  const paths = series
    .map((id) => {
      const points = periods.map((period, index) => ({
        x: index * stepX,
        y: y(valueOf(period, id)),
      }));
      const line = polyline(points);
      const area = line === "" ? "" : `${line} L${width},${height} L0,${height} Z`;
      const total = periods.reduce((sum, period) => sum + valueOf(period, id), 0);
      return { id, line, area, total };
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
            <g key={path.id}>
              {path.area ? (
                <path d={path.area} fill={SERIES_META[path.id].color} opacity={0.12} />
              ) : null}
              {path.line ? (
                <path
                  d={path.line}
                  fill="none"
                  stroke={SERIES_META[path.id].color}
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

function UsageSeriesFilter({
  hiddenSeries,
  onChange,
}: {
  hiddenSeries: ReadonlySet<UsageSeriesId>;
  onChange: (next: ReadonlySet<UsageSeriesId>) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const visible = USAGE_SERIES_ORDER.filter((series) => !hiddenSeries.has(series));
  const label =
    visible.length === USAGE_SERIES_ORDER.length
      ? "All providers"
      : visible.length === 0
        ? "No providers"
        : visible.length === 1 && visible[0]
          ? SERIES_META[visible[0]].label
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

  const setHidden = (next: readonly UsageSeriesId[]) => onChange(new Set(next));

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
            aria-checked={hiddenSeries.size === 0}
            className="usage-filter-item"
            onClick={() => setHidden(hiddenSeries.size === 0 ? USAGE_SERIES_ORDER : [])}
          >
            <span className="usage-filter-check" aria-hidden="true">
              {hiddenSeries.size === 0 ? <IconCheck /> : null}
            </span>
            All providers
          </button>
          <div className="usage-filter-sep" />
          {USAGE_SERIES_ORDER.map((series) => {
            const checked = !hiddenSeries.has(series);
            const meta = SERIES_META[series];
            return (
              <button
                key={series}
                type="button"
                role="menuitemcheckbox"
                aria-checked={checked}
                className="usage-filter-item"
                onClick={() =>
                  setHidden(
                    USAGE_SERIES_ORDER.filter((entry) =>
                      entry === series ? checked : hiddenSeries.has(entry),
                    ),
                  )
                }
              >
                <span className="usage-filter-check" aria-hidden="true">
                  {checked ? <IconCheck /> : null}
                </span>
                {meta.markClass ? (
                  <span className={`provider-mark provider-${meta.markClass}`} aria-hidden="true" />
                ) : (
                  <span
                    className="usage-dot"
                    style={{ background: meta.color }}
                    aria-hidden="true"
                  />
                )}
                {meta.label}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
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
