import type { Effort, ProviderId, Tier } from '../types.js';

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
  /**
   * Weight class the model belonged to. Capability is measured per tier, so a
   * scrappy run on the cheap model is not held against the expensive one.
   */
  tier?: Tier;
  /**
   * How hard the model was asked to think. Recorded beside the tier it came
   * from so the learning loop can tell a weak run at minimum effort from a weak
   * run at maximum, which are different problems.
   */
  effort?: Effort;
  ruleId?: string;
  routingReason?: string;
  /** Task shape as classified before the run. */
  kind?: string;
  complexity?: string;

  // Cost of the run
  /** Everything the model read, cache included — see `Usage`. */
  inputTokens?: number;
  outputTokens?: number;
  /** The part of `inputTokens` served from cache. */
  cachedInputTokens?: number;
  costUsd?: number;
  /**
   * Whether `costUsd` was actually charged. False for subscription accounts,
   * where it is the API list price of tokens nobody was billed for.
   */
  metered?: boolean;
  durationMs?: number;
  /** Percentage points of the account's tightest window consumed by this run. */
  burnPct?: number;

  status: 'success' | 'error' | 'failover';
  errorMessage?: string;
  /**
   * The failure was infrastructure (dropped stream, overloaded upstream), not
   * the account's doing — excluded from capability measurement.
   */
  transient?: boolean;

  failedFrom?: { provider: ProviderId; account: string; model?: string };
  failoverReason?: string;

  // ── outcome signals (the feedback loop) ─────────────────
  /** The user interjected mid-run — the answer was going the wrong way. */
  steered?: boolean;
  /** The user re-asked something very similar right after this turn. */
  retried?: boolean;
  /** This turn escalated to a heavier tier because the work got harder. */
  escalated?: boolean;

  // ── what the run was told, so instructions can be A/B tested ──
  /** Brief line ids this run carried. */
  briefLineIds?: string[];
  /** Reality checks that ran afterwards, and whether they passed. */
  verified?: 'passed' | 'repaired' | 'failed';
  /** A different provider reviewed this run's output. */
  reviewedBy?: string;
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
  /** Money actually charged — API-key accounts only. */
  billedCost: number;
  /** List price of what subscription accounts ran for free. */
  equivalentCost: number;
  totalTokens: number;
  /**
   * Share of everything read that came from the provider's cache, 0..100.
   *
   * The one number that says whether the conversations are being kept where
   * their context already is. It falls when threads are moved between accounts,
   * when the brief churns, and when the gap between turns outlives the cache.
   */
  cacheHitRate: number;
  /** True when any run reported cache figures, so 0% can be told from silence. */
  cacheReported: boolean;
  /**
   * How many runs the rate was computed from. Usage is optional in ACP and not
   * every agent fills it in, so a workspace leaning on those has a rate that
   * describes part of its work — and the panel has to say which part rather
   * than presenting it as the whole.
   */
  cacheRuns: number;
  /** True when at least one run reported a cost, so 0 can be told from silence. */
  costReported: boolean;
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

  const withCost = metrics.filter((m) => m.costUsd !== undefined);
  const sumCost = (of: (m: TaskMetric) => boolean): number =>
    withCost.filter(of).reduce((sum, m) => sum + (m.costUsd ?? 0), 0);

  // Only runs that reported both halves can answer this — an account that never
  // reports cache figures would otherwise read as a permanent 0% hit rate.
  const withCache = metrics.filter((m) => m.cachedInputTokens !== undefined && m.inputTokens);
  const cacheRead = withCache.reduce((sum, m) => sum + (m.cachedInputTokens ?? 0), 0);
  const cacheTotal = withCache.reduce((sum, m) => sum + (m.inputTokens ?? 0), 0);

  return {
    total: metrics.length,
    successful: successful.length,
    failed: failed.length,
    successRate: metrics.length > 0 ? (successful.length / metrics.length) * 100 : 0,
    frictionRate: metrics.length > 0 ? (friction.length / metrics.length) * 100 : 0,
    // Kept apart rather than summed: one is a bill and the other is a
    // hypothetical, and adding them produces a number that is neither.
    billedCost: sumCost((m) => m.metered === true),
    equivalentCost: sumCost((m) => m.metered !== true),
    totalTokens: metrics.reduce((sum, m) => sum + (m.inputTokens ?? 0) + (m.outputTokens ?? 0), 0),
    cacheHitRate: cacheTotal > 0 ? (cacheRead / cacheTotal) * 100 : 0,
    cacheReported: withCache.length > 0,
    cacheRuns: withCache.length,
    costReported: withCost.length > 0,
    avgDurationMs:
      durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0,
    medianDurationMs: median(durations),
  };
}
