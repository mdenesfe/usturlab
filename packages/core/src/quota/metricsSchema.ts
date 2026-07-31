import type { ProviderId } from '../types.js';

/**
 * What actually happened on a run. These records are the only memory the
 * router has: they calibrate capability per provider, estimate how much of a
 * quota window a task burns, and expose both in the analytics tab.
 */
export interface TaskMetric {
  id: string;
  timestamp: number;
  conversationId: string;

  // Routing decision
  provider: ProviderId;
  account: string;
  model?: string;
  ruleId?: string;
  routingReason?: string;
  /** Task shape as classified before the run. */
  kind?: string;
  complexity?: string;

  // Cost of the run
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  durationMs?: number;
  /** Percentage points of the account's tightest window consumed by this run. */
  burnPct?: number;

  status: 'success' | 'error' | 'failover';
  errorMessage?: string;

  failedFrom?: { provider: ProviderId; account: string; model?: string };
  failoverReason?: string;

  // ── outcome signals (the feedback loop) ─────────────────
  /** The user interjected mid-run — the answer was going the wrong way. */
  steered?: boolean;
  /** The user re-asked something very similar right after this turn. */
  retried?: boolean;
  /** This turn escalated to a heavier tier because the work got harder. */
  escalated?: boolean;
}

export interface MetricsFile {
  metrics: TaskMetric[];
  version: 1;
}

function groupBy(metrics: TaskMetric[], key: (m: TaskMetric) => string): Record<string, TaskMetric[]> {
  const grouped: Record<string, TaskMetric[]> = {};
  for (const m of metrics) {
    const k = key(m);
    (grouped[k] ??= []).push(m);
  }
  return grouped;
}

export const groupMetricsByAccount = (metrics: TaskMetric[]) =>
  groupBy(metrics, (m) => `${m.provider}:${m.account}`);

export const groupMetricsByModel = (metrics: TaskMetric[]) =>
  groupBy(metrics, (m) => m.model ?? `${m.provider} default`);

export const groupMetricsByRule = (metrics: TaskMetric[]) =>
  groupBy(metrics, (m) => m.ruleId ?? 'auto');

export const groupMetricsByKind = (metrics: TaskMetric[]) => groupBy(metrics, (m) => m.kind ?? 'unknown');

export const groupMetricsByDate = (metrics: TaskMetric[]) =>
  groupBy(metrics, (m) => new Date(m.timestamp).toISOString().slice(0, 10));

export interface MetricStats {
  total: number;
  successful: number;
  failed: number;
  successRate: number;
  /** Share of runs the user had to interrupt, retry or escalate. */
  frictionRate: number;
  totalCost: number;
  totalTokens: number;
  avgDurationMs: number;
  medianDurationMs: number;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

export function calculateStats(metrics: TaskMetric[]): MetricStats {
  const successful = metrics.filter((m) => m.status === 'success');
  const failed = metrics.filter((m) => m.status !== 'success');
  const friction = metrics.filter((m) => m.steered || m.retried || m.escalated || m.status !== 'success');
  const durations = successful.map((m) => m.durationMs ?? 0).filter((d) => d > 0);

  return {
    total: metrics.length,
    successful: successful.length,
    failed: failed.length,
    successRate: metrics.length > 0 ? (successful.length / metrics.length) * 100 : 0,
    frictionRate: metrics.length > 0 ? (friction.length / metrics.length) * 100 : 0,
    totalCost: metrics.reduce((sum, m) => sum + (m.costUsd ?? 0), 0),
    totalTokens: metrics.reduce((sum, m) => sum + (m.inputTokens ?? 0) + (m.outputTokens ?? 0), 0),
    avgDurationMs:
      durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0,
    medianDurationMs: median(durations),
  };
}
