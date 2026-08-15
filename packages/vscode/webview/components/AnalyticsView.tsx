import { useState } from 'preact/hooks';
import type { TaskMetric } from '../../../core/src/quota/metricsSchema.js';
import {
  calculateStats,
  groupMetricsByAccount,
  groupMetricsByKind,
  median,
} from '../../../core/src/quota/metricsSchema.js';
import { isCleanRun, sampleConfidence } from '../../../core/src/router/learning.js';
import { formatCost } from '../../../core/src/accounts/billing.js';
import type { AccountStatusDto } from '../../src/panel/protocol.js';
import { vscode } from '../vscodeApi.js';
import { BRAND_COLOR, BrandMark } from './brandIcons.js';
import { IconAnalytics } from './icons.js';

type Range = '7d' | '30d' | 'all';

const RANGES: Array<{ key: Range; label: string }> = [
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: 'all', label: 'all time' },
];

/** 24816 → 24.8k. These are five-figure numbers now that cache reads count. */
function tokens(n: number | undefined): string {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function fmtDuration(ms: number | undefined): string {
  if (!ms) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}m` : `${(ms / 1000).toFixed(1)}s`;
}

/** Three bands, coloured the way the quota bars are: green is the good end. */
function rateClass(pct: number): string {
  if (pct >= 85) return 'good';
  if (pct >= 60) return 'ok';
  return 'bad';
}

interface Flag {
  label: string;
  title?: string;
  tone?: string;
}

/**
 * What was unusual about this run, worst first. A row has room for three; the
 * rest are counted rather than dropped, so nothing goes silently missing.
 */
function runFlags(m: TaskMetric): Flag[] {
  const flags: Flag[] = [];
  if (m.status === 'failover') flags.push({ label: 'failover', title: m.failoverReason, tone: 'warn' });
  if (m.status === 'error') {
    flags.push({ label: m.transient ? 'dropped' : 'error', title: m.errorMessage, tone: 'warn' });
  }
  if (m.steered) flags.push({ label: 'steered', title: 'You interjected mid-run' });
  if (m.retried) flags.push({ label: 'retried', title: 'You re-asked right after this turn' });
  if (m.escalated) flags.push({ label: 'escalated', title: 'Router moved to a heavier model' });
  if (m.verified) {
    flags.push({
      label: m.verified,
      title: 'Reality checks after the run',
      tone: `verify-${m.verified}`,
    });
  }
  if (m.reviewedBy) flags.push({ label: 'reviewed', title: `Reviewed by ${m.reviewedBy}` });
  return flags;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * What auto routing learned. Clean-rate per account is the signal that moves
 * capability; confidence says how much of it the router is willing to act on
 * yet, so a lucky first run does not become a verdict.
 */
function LearnedSection({ metrics }: { metrics: TaskMetric[] }) {
  const groups = Object.entries(groupMetricsByAccount(metrics)).sort(
    (a, b) => b[1].length - a[1].length,
  );
  if (groups.length === 0) return null;

  return (
    <div class="detail-section wide">
      <div class="detail-section-title">
        What the router learned <span class="section-note">clean runs move where work goes</span>
      </div>
      <div class="learn-rows">
        {groups.map(([key, runs]) => {
          const provider = key.split(':')[0]!;
          const cleanRate = (runs.filter(isCleanRun).length / runs.length) * 100;
          const confidence = sampleConfidence(runs.length) * 100;
          const burns = runs.map((m) => m.burnPct).filter((b): b is number => typeof b === 'number');
          return (
            <div key={key} class="learn-row">
              <span class="learn-mark">
                <BrandMark provider={provider} size={13} />
              </span>
              <span class="learn-name" style={{ color: BRAND_COLOR[provider] }} title={key}>
                {key}
              </span>
              <span class="learn-runs">{runs.length} runs</span>
              <span class="learn-bar">
                <span
                  class={`learn-fill ${rateClass(cleanRate)}`}
                  style={{ width: `${cleanRate}%` }}
                />
              </span>
              <span
                class="learn-pct"
                title="Runs that finished without you steering, retrying, or the router escalating"
              >
                {Math.round(cleanRate)}% clean
              </span>
              <span class="learn-sub" title="How far the router trusts this evidence yet">
                {Math.round(confidence)}% conf
              </span>
              <span class="learn-sub" title="Median share of a quota window one run consumes">
                {burns.length ? `~${median(burns).toFixed(1)}%/run` : 'burn n/a'}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** One run: where it went, what it read and wrote, and what was odd about it. */
function MetricRow({ m }: { m: TaskMetric }) {
  const flags = runFlags(m);
  const shown = flags.slice(0, 3);
  const rest = flags.slice(3);
  return (
    <div class={`metric-row status-${m.status}`}>
      <div class="metric-time">{fmtTime(m.timestamp)}</div>
      <div class="metric-model" title={m.ruleId ? `rule: ${m.ruleId}` : m.routingReason}>
        {m.model || `${m.provider} default`}
      </div>
      <div class="metric-kind">{m.kind ? `${m.complexity ?? ''} ${m.kind}`.trim() : '—'}</div>
      <div
        class="metric-tokens"
        title={
          m.cachedInputTokens
            ? `${m.cachedInputTokens.toLocaleString()} of the input came from cache`
            : undefined
        }
      >
        {tokens(m.inputTokens)}→{tokens(m.outputTokens)}
      </div>
      <div class="metric-cost">{formatCost(m.costUsd, m.metered)}</div>
      <div class="metric-duration">{fmtDuration(m.durationMs)}</div>
      <div class="metric-burn" title="Share of this account's tightest quota window">
        {typeof m.burnPct === 'number' ? `${m.burnPct.toFixed(1)}%` : '—'}
      </div>
      <div class="metric-flags">
        {shown.map((f) => (
          <span key={f.label} class={`metric-flag ${f.tone ?? ''}`} title={f.title}>
            {f.label}
          </span>
        ))}
        {rest.length > 0 && (
          <span class="metric-flag" title={rest.map((f) => f.label).join(', ')}>
            +{rest.length}
          </span>
        )}
      </div>
    </div>
  );
}

/** Which kind of work goes well where — the thing a rule is usually written from. */
function KindSection({ metrics }: { metrics: TaskMetric[] }) {
  const groups = Object.entries(groupMetricsByKind(metrics))
    .filter(([kind]) => kind !== 'unknown')
    .sort((a, b) => b[1].length - a[1].length);
  if (groups.length === 0) return null;

  return (
    <div class="detail-section wide">
      <div class="detail-section-title">
        By kind of work <span class="section-note">as classified before the run</span>
      </div>
      <div class="learn-rows">
        {groups.map(([kind, runs]) => {
          const stats = calculateStats(runs);
          const clean = 100 - stats.frictionRate;
          const best = Object.entries(groupMetricsByAccount(runs))
            .map(([key, list]) => ({
              key,
              rate: list.filter(isCleanRun).length / list.length,
              n: list.length,
            }))
            .sort((a, b) => b.rate - a.rate || b.n - a.n)[0];
          return (
            <div key={kind} class="learn-row">
              <span class="learn-mark" />
              <span class="learn-name">{kind}</span>
              <span class="learn-runs">{runs.length} runs</span>
              <span class="learn-bar">
                <span class={`learn-fill ${rateClass(clean)}`} style={{ width: `${clean}%` }} />
              </span>
              <span class="learn-pct">{Math.round(clean)}% clean</span>
              <span class="learn-sub">{fmtDuration(stats.medianDurationMs)} median</span>
              <span class="learn-sub" title="Cleanest account on this kind of work">
                {best ? `best: ${best.key}` : ''}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function AnalyticsView({
  metrics,
  accounts,
}: {
  metrics: TaskMetric[];
  accounts: AccountStatusDto[];
}) {
  const [range, setRange] = useState<Range>('7d');

  const filtered = metrics.filter((m) => {
    if (range === 'all') return true;
    const days = range === '7d' ? 7 : 30;
    return m.timestamp >= Date.now() - days * 24 * 60 * 60 * 1000;
  });

  const stats = calculateStats(filtered);
  const grouped = groupMetricsByAccount(filtered);
  const steered = filtered.filter((m) => m.steered).length;
  const escalated = filtered.filter((m) => m.escalated).length;
  const failovers = filtered.filter((m) => m.status === 'failover').length;
  const known = new Set(accounts.map((a) => `${a.provider}:${a.label}`));
  const clean = 100 - stats.frictionRate;

  return (
    <div class="analytics-page">
      <div class="analytics-header">
        <div class="accounts-title">
          <IconAnalytics size={15} />
          <span>Analytics</span>
          <span class="accounts-count">{filtered.length}</span>
        </div>
        <div class="analytics-controls">
          <div class="range-seg" role="group" aria-label="Time range">
            {RANGES.map((r) => (
              <button
                key={r.key}
                class={`seg-btn ${range === r.key ? 'active' : ''}`}
                onClick={() => setRange(r.key)}
              >
                {r.label}
              </button>
            ))}
          </div>
          {metrics.length > 0 && (
            <button
              class="ghost-btn danger"
              title="Forget every recorded run — auto routing loses what it calibrated on"
              onClick={() => vscode.postMessage({ kind: 'clearAnalytics' })}
            >
              Clear history
            </button>
          )}
        </div>
      </div>

      <div class="analytics-body">
        <div class="usage-grid stat-grid">
          <div class="usage-card">
            <div class="usage-card-label">Clean runs</div>
            <div class={`usage-card-pct ${filtered.length ? rateClass(clean) : ''}`}>
              {filtered.length ? Math.round(clean) : '—'}
              {filtered.length > 0 && <span class="pct-sign">%</span>}
            </div>
            <div class="usage-bar big">
              <div
                class={`usage-fill ${rateClass(clean)}`}
                style={{ width: `${filtered.length ? clean : 0}%` }}
              />
            </div>
            <div class="usage-card-reset">
              {steered} steered · {escalated} escalated · {failovers} failed over
            </div>
          </div>

          <div class="usage-card">
            <div class="usage-card-label">Tasks</div>
            <div class="usage-card-pct">{stats.total}</div>
            <div class="usage-card-reset">
              {Math.round(stats.successRate)}% finished · {tokens(stats.totalTokens)} tokens read and
              written
            </div>
          </div>

          <div class="usage-card">
            <div class="usage-card-label">Median run</div>
            <div class="usage-card-pct">{fmtDuration(stats.medianDurationMs)}</div>
            <div class="usage-card-reset">{fmtDuration(stats.avgDurationMs)} average</div>
          </div>

          {/* Context served from the provider's cache instead of read again.
              It falls when threads get moved between accounts, so it is the
              closest thing to a score for the routing itself. */}
          <div class="usage-card">
            <div class="usage-card-label">Context reused</div>
            <div class="usage-card-pct">
              {stats.cacheReported ? Math.round(stats.cacheHitRate) : '—'}
              {stats.cacheReported && <span class="pct-sign">%</span>}
            </div>
            <div class="usage-bar big">
              <div
                class={`usage-fill ${rateClass(stats.cacheHitRate)}`}
                style={{ width: `${stats.cacheReported ? stats.cacheHitRate : 0}%` }}
              />
            </div>
            <div class="usage-card-reset">
              {!stats.cacheReported
                ? 'no provider in this period reported cache figures'
                : stats.cacheRuns < stats.total
                  ? `read from cache instead of sent again · ${stats.cacheRuns} of ${stats.total} runs report it`
                  : 'read from cache instead of sent again'}
            </div>
          </div>

          <div class="usage-card">
            <div class="usage-card-label">
              {stats.billedCost > 0 ? 'Billed' : 'Would have cost'}
            </div>
            <div class="usage-card-pct">
              {stats.costReported
                ? `${stats.billedCost > 0 ? '$' : '~$'}${(stats.billedCost > 0
                    ? stats.billedCost
                    : stats.equivalentCost
                  ).toFixed(2)}`
                : '—'}
            </div>
            <div class="usage-card-reset">
              {!stats.costReported
                ? 'no provider in this period reported a cost'
                : stats.billedCost > 0
                  ? `charged to API-key accounts · ~$${stats.equivalentCost.toFixed(2)} more ran on subscriptions`
                  : 'list price of work your subscriptions covered — nobody was charged'}
            </div>
          </div>
        </div>

        {filtered.length === 0 ? (
          <div class="accounts-empty analytics-empty">
            <IconAnalytics size={26} />
            <div class="accounts-empty-title">Nothing recorded in this range</div>
            <div class="accounts-empty-line">
              Every task lands here — which account took it, how long it ran, how much of a quota
              window it burned, and whether you had to steer it. Auto routing calibrates itself on
              exactly this record.
            </div>
          </div>
        ) : (
          <>
            <LearnedSection metrics={filtered} />
            <KindSection metrics={filtered} />

            <div class="detail-section wide">
              <div class="detail-section-title">
                Recent runs <span class="section-note">newest first, per account</span>
              </div>
              {Object.entries(grouped)
                .sort((a, b) => b[1].length - a[1].length)
                .map(([key, items]) => {
                  const provider = key.split(':')[0]!;
                  const itemStats = calculateStats(items);
                  return (
                    <div key={key} class="provider-group">
                      <div class="group-header">
                        <div class="group-title">
                          <span
                            class="brand-badge small"
                            style={{
                              background: `color-mix(in srgb, ${BRAND_COLOR[provider]} 14%, transparent)`,
                            }}
                          >
                            <BrandMark provider={provider} size={13} />
                          </span>
                          <span style={{ color: BRAND_COLOR[provider] }}>{key}</span>
                          {!known.has(key) && (
                            <span class="group-gone" title="No connected account answers to this name">
                              removed
                            </span>
                          )}
                        </div>
                        <div class="group-stats">
                          <span>{itemStats.total} runs</span>
                          <span>{Math.round(100 - itemStats.frictionRate)}% clean</span>
                          {itemStats.cacheReported && (
                            <span title="Context this account read from cache instead of again">
                              {Math.round(itemStats.cacheHitRate)}% reused
                            </span>
                          )}
                          <span>{fmtDuration(itemStats.medianDurationMs)}</span>
                          <span>
                            {itemStats.costReported
                              ? formatCost(
                                  itemStats.billedCost + itemStats.equivalentCost,
                                  itemStats.billedCost > 0,
                                )
                              : '—'}
                          </span>
                        </div>
                      </div>
                      <div class="metric-rows">
                        {items
                          .slice(-8)
                          .reverse()
                          .map((m) => (
                            <MetricRow key={m.id} m={m} />
                          ))}
                      </div>
                    </div>
                  );
                })}
            </div>

            <p class="analytics-note">
              A run is <strong>clean</strong> when it finished without you interrupting, without a
              retry, and without the router having to escalate. Clean-rate feeds straight back into
              which account auto mode picks — weighted by confidence, which grows as runs accumulate.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
