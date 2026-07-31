import { useState } from 'preact/hooks';
import type { TaskMetric } from '../../../core/src/quota/metricsSchema.js';
import { calculateStats, groupMetricsByAccount } from '../../../core/src/quota/metricsSchema.js';
import type { AccountStatusDto } from '../../src/panel/protocol.js';
import { vscode } from '../vscodeApi.js';

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
        <div class="stat-card">
          <div class="stat-label">Cost</div>
          <div class="stat-value">${stats.totalCost.toFixed(2)}</div>
        </div>
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
                    <span>${itemStats.totalCost.toFixed(2)}</span>
                    <span>{itemStats.successRate.toFixed(0)}%</span>
                  </div>
                </div>
                <div class="metric-rows">
                  {items.slice(-8).map((m) => (
                    <div key={m.id} class={`metric-row status-${m.status}`}>
                      <div class="metric-time">{new Date(m.timestamp).toLocaleTimeString()}</div>
                      <div class="metric-model">{m.model || 'default'}</div>
                      <div class="metric-tokens">{m.inputTokens || 0}→{m.outputTokens || 0}</div>
                      <div class="metric-cost">${(m.costUsd ?? 0).toFixed(2)}</div>
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
