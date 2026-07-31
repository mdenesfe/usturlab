import { useState } from 'preact/hooks';
import type { TaskMetric } from '../../../core/src/quota/metricsSchema.js';
import {
  calculateStats,
  groupMetricsByAccount,
  groupMetricsByKind,
  median,
} from '../../../core/src/quota/metricsSchema.js';
import { isCleanRun, sampleConfidence } from '../../../core/src/router/learning.js';
import type { AccountStatusDto } from '../../src/panel/protocol.js';
import { vscode } from '../vscodeApi.js';
import { BRAND_COLOR, BrandMark } from './brandIcons.js';

type Range = '7d' | '30d' | 'all';

function fmtDuration(ms: number): string {
  if (!ms) return '—';
  return ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}m` : `${(ms / 1000).toFixed(1)}s`;
}

function rateClass(pct: number): string {
  if (pct >= 85) return 'good';
  if (pct >= 60) return 'ok';
  return 'bad';
}

/**
 * What auto routing learned: clean-rate per account is the signal that moves
 * capability, and confidence says how much of it the router is willing to act on.
 */
function LearnedSection({ metrics }: { metrics: TaskMetric[] }) {
  const groups = Object.entries(groupMetricsByAccount(metrics)).sort(
    (a, b) => b[1].length - a[1].length,
  );
  if (groups.length === 0) return null;

  return (
    <div class="analytics-section">
      <h2>What the router learned</h2>
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
              <span class="learn-name" style={{ color: BRAND_COLOR[provider] }}>
                {key}
              </span>
              <span class="learn-runs">{runs.length} runs</span>
              <span class="learn-bar">
                <span class={`learn-fill ${rateClass(cleanRate)}`} style={{ width: `${cleanRate}%` }} />
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

function KindSection({ metrics }: { metrics: TaskMetric[] }) {
  const groups = Object.entries(groupMetricsByKind(metrics))
    .filter(([kind]) => kind !== 'unknown')
    .sort((a, b) => b[1].length - a[1].length);
  if (groups.length === 0) return null;

  return (
    <div class="analytics-section">
      <h2>By kind of work</h2>
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
              <span class="learn-sub">{best ? `best: ${best.key}` : ''}</span>
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
  const [filter, setFilter] = useState<Range>('7d');

  const filtered = metrics.filter((m) => {
    if (filter === 'all') return true;
    const days = filter === '7d' ? 7 : 30;
    return m.timestamp >= Date.now() - days * 24 * 60 * 60 * 1000;
  });

  const stats = calculateStats(filtered);
  const grouped = groupMetricsByAccount(filtered);
  const steered = filtered.filter((m) => m.steered).length;
  const escalated = filtered.filter((m) => m.escalated).length;
  const failovers = filtered.filter((m) => m.status === 'failover').length;
  const known = new Set(accounts.map((a) => `${a.provider}:${a.label}`));

  return (
    <div class="analytics-page">
      <div class="analytics-header">
        <h1>Analytics</h1>
        <div class="analytics-controls">
          <select
            class="filter-select"
            value={filter}
            onChange={(e) => setFilter((e.target as HTMLSelectElement).value as Range)}
          >
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="all">All time</option>
          </select>
          {metrics.length > 0 && (
            <button class="clear-btn" onClick={() => vscode.postMessage({ kind: 'clearAnalytics' })}>
              Clear history
            </button>
          )}
        </div>
      </div>

      <div class="analytics-summary">
        <div class="stat-card">
          <div class="stat-label">Clean runs</div>
          <div class={`stat-value ${rateClass(100 - stats.frictionRate)}`}>
            {filtered.length ? `${Math.round(100 - stats.frictionRate)}%` : '—'}
          </div>
          <div class="stat-foot">
            {steered} steered · {escalated} escalated · {failovers} failed over
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Tasks</div>
          <div class="stat-value">{stats.total}</div>
          <div class="stat-foot">{Math.round(stats.successRate)}% completed</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Median run</div>
          <div class="stat-value">{fmtDuration(stats.medianDurationMs)}</div>
          <div class="stat-foot">{fmtDuration(stats.avgDurationMs)} average</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">API-equivalent</div>
          <div class="stat-value">${stats.totalCost.toFixed(2)}</div>
          <div class="stat-foot">
            {stats.totalTokens > 0
              ? `${(stats.totalTokens / 1000).toFixed(0)}k tokens · covered by subscriptions`
              : 'covered by subscriptions'}
          </div>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div class="analytics-empty">
          <p>
            No runs in this range yet. Every task is recorded here — which account handled it, how
            long it took, how much of a quota window it burned, and whether you had to steer it.
            Auto routing calibrates itself on exactly this record.
          </p>
        </div>
      ) : (
        <div class="analytics-breakdown">
          <LearnedSection metrics={filtered} />
          <KindSection metrics={filtered} />

          <div class="analytics-section">
            <h2>Recent runs</h2>
            {Object.entries(grouped)
              .sort((a, b) => b[1].length - a[1].length)
              .map(([key, items]) => {
                const provider = key.split(':')[0]!;
                const itemStats = calculateStats(items);
                return (
                  <div key={key} class="provider-group">
                    <div class="group-header">
                      <div class="group-title">
                        <BrandMark provider={provider} size={13} />
                        <span style={{ color: BRAND_COLOR[provider] }}>{key}</span>
                        {!known.has(key) && <span class="group-gone">removed</span>}
                      </div>
                      <div class="group-stats">
                        <span>{itemStats.total} runs</span>
                        <span>{Math.round(100 - itemStats.frictionRate)}% clean</span>
                        <span>{fmtDuration(itemStats.medianDurationMs)}</span>
                      </div>
                    </div>
                    <div class="metric-rows">
                      {items
                        .slice(-8)
                        .reverse()
                        .map((m) => (
                          <div key={m.id} class={`metric-row status-${m.status}`}>
                            <div class="metric-time">
                              {new Date(m.timestamp).toLocaleTimeString([], {
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </div>
                            <div class="metric-model">{m.model || `${m.provider} default`}</div>
                            <div class="metric-kind">
                              {m.kind ? `${m.complexity ?? ''} ${m.kind}`.trim() : '—'}
                            </div>
                            <div class="metric-duration">
                              {m.durationMs ? fmtDuration(m.durationMs) : '—'}
                            </div>
                            <div class="metric-burn">
                              {typeof m.burnPct === 'number' ? `${m.burnPct.toFixed(1)}%` : '—'}
                            </div>
                            <div class="metric-flags">
                              {m.steered && <span class="metric-flag" title="You interjected mid-run">steered</span>}
                              {m.escalated && (
                                <span class="metric-flag" title="Router moved to a heavier model">
                                  escalated
                                </span>
                              )}
                              {m.status === 'failover' && (
                                <span class="metric-flag" title={m.failoverReason}>
                                  failover
                                </span>
                              )}
                            </div>
                          </div>
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
        </div>
      )}
    </div>
  );
}
