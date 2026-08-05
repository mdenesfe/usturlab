import { useState } from 'preact/hooks';
import type { TaskMetric } from '../../../core/src/quota/metricsSchema.js';
import { calculateStats, groupMetricsByAccount } from '../../../core/src/quota/metricsSchema.js';
import type { AccountStatusDto } from '../../src/panel/protocol.js';
import { formatCost } from '../../../core/src/accounts/billing.js';
import { vscode } from '../vscodeApi.js';

/** 24816 → 24.8k. These are five-figure numbers now that cache reads count. */
function tokens(n: number | undefined): string {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function AnalyticsView({ metrics, accounts }: { metrics: TaskMetric[]; accounts: AccountStatusDto[] }) {
  const [filter, setFilter] = useState<'7d' | '30d' | 'all'>('7d');

  const filtered = metrics.filter((m) => {
    if (filter === 'all') return true;
    const days = filter === '7d' ? 7 : 30;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return m.timestamp >= cutoff;
  });

  const stats = calculateStats(filtered);
  const grouped = groupMetricsByAccount(filtered);

  return (
    <div class="analytics-page">
      <div class="analytics-header">
        <h1>Analytics</h1>
        <div class="analytics-controls">
          <select
            class="filter-select"
            value={filter}
            onChange={(e) => setFilter((e.target as HTMLSelectElement).value as '7d' | '30d' | 'all')}
          >
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="all">All time</option>
          </select>
          {filtered.length > 0 && (
            <button class="clear-btn" onClick={() => vscode.postMessage({ kind: 'clearAnalytics' })}>
              Clear all
            </button>
          )}
        </div>
      </div>

      <div class="analytics-summary">
        <div class="stat-card">
          <div class="stat-label">Total</div>
          <div class="stat-value">{stats.total}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Success</div>
          <div class="stat-value">{stats.successRate.toFixed(0)}%</div>
        </div>
        {stats.billedCost > 0 && (
          <div class="stat-card" title="Charged to your API-key accounts">
            <div class="stat-label">Billed</div>
            <div class="stat-value">${stats.billedCost.toFixed(2)}</div>
          </div>
        )}
        {(stats.equivalentCost > 0 || stats.billedCost === 0) && (
          <div
            class="stat-card"
            title={
              stats.costReported
                ? 'What the subscription runs would have cost on the API — nobody was charged for them. Only providers that report a cost are counted.'
                : 'No provider in this period reported a cost'
            }
          >
            <div class="stat-label">Would have cost</div>
            <div class="stat-value">
              {stats.costReported ? `~$${stats.equivalentCost.toFixed(2)}` : '—'}
            </div>
          </div>
        )}
        <div class="stat-card">
          <div class="stat-label">Avg Time</div>
          <div class="stat-value">{Math.round(stats.avgDurationMs)}ms</div>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div class="analytics-empty">
          No tasks in this period
        </div>
      ) : (
        <div class="analytics-breakdown">
          <h2>Tasks by account</h2>
          {Object.entries(grouped).map(([key, items]) => {
            const itemStats = calculateStats(items);
            return (
              <div key={key} class="provider-group">
                <div class="group-header">
                  <div class="group-title">{key}</div>
                  <div class="group-stats">
                    <span>{itemStats.total}</span>
                    <span>
                      {itemStats.costReported
                        ? formatCost(
                            itemStats.billedCost + itemStats.equivalentCost,
                            itemStats.billedCost > 0,
                          )
                        : '—'}
                    </span>
                    <span>{itemStats.successRate.toFixed(0)}%</span>
                  </div>
                </div>
                <div class="metric-rows">
                  {items.slice(-8).map((m) => (
                    <div key={m.id} class={`metric-row status-${m.status}`}>
                      <div class="metric-time">{new Date(m.timestamp).toLocaleTimeString()}</div>
                      <div class="metric-model">{m.model || 'default'}</div>
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
                      <div class="metric-duration">{m.durationMs || 0}ms</div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
