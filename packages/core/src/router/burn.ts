import type { ProviderId, Target } from '../types.js';
import type { TaskMetric } from '../quota/metricsSchema.js';
import { median } from '../quota/metricsSchema.js';
import type { Complexity } from './classify.js';
import type { Tier } from './autoRoute.js';

/**
 * How much of an account's window a task is likely to eat.
 *
 * Knowing an account is "40% free" is useless without knowing whether the job
 * costs 2% or 30% of that window. Measured history is used when it exists;
 * otherwise a conservative prior keeps the router from walking an account off
 * a cliff.
 */

/** Prior: percentage points of a window consumed by one run, before evidence. */
const PRIOR_BURN: Record<Tier, number> = {
  light: 1.5,
  standard: 4,
  heavy: 9,
};

/** Agentic work runs long and multiplies whatever tier it uses. */
const KIND_MULTIPLIER: Record<string, number> = {
  agentic: 2.5,
  refactor: 1.5,
  debug: 1.3,
  test: 1.2,
  review: 1.1,
};

export const TIER_BY_COMPLEXITY_BURN: Record<Complexity, Tier> = {
  trivial: 'light',
  simple: 'light',
  moderate: 'standard',
  hard: 'heavy',
};

export interface BurnEstimate {
  /** Percentage points of the tightest window this run is expected to use. */
  pct: number;
  /** True when the number comes from this account's own history. */
  measured: boolean;
  samples: number;
}

/**
 * Estimated burn for running `target` on a task of this shape. Measured burn
 * from comparable past runs wins; the prior is scaled by tier and kind.
 */
export function estimateBurn(
  target: Target,
  complexity: Complexity,
  kind: string,
  metrics: TaskMetric[],
): BurnEstimate {
  const comparable = metrics.filter(
    (m) =>
      m.provider === target.provider &&
      m.account === target.account &&
      m.complexity === complexity &&
      typeof m.burnPct === 'number' &&
      m.burnPct > 0,
  );
  if (comparable.length >= 3) {
    return {
      pct: median(comparable.map((m) => m.burnPct!)),
      measured: true,
      samples: comparable.length,
    };
  }

  const tier = TIER_BY_COMPLEXITY_BURN[complexity];
  const pct = PRIOR_BURN[tier] * (KIND_MULTIPLIER[kind] ?? 1);
  return { pct, measured: false, samples: comparable.length };
}

/**
 * Burn actually observed for a finished run, as a share of the window that
 * moved. Returns undefined when usage data is not available for the account
 * (Gemini, or a first run) — callers keep the prior in that case.
 */
export function observedBurn(
  usageBefore: number | undefined,
  usageAfter: number | undefined,
): number | undefined {
  if (usageBefore === undefined || usageAfter === undefined) return undefined;
  const delta = usageAfter - usageBefore;
  // Windows roll over; only forward movement is a real burn.
  return delta > 0 && delta < 100 ? delta : undefined;
}

/**
 * Penalty applied to a candidate whose estimated burn would exhaust it.
 * 1 = comfortable, → 0 as the run threatens to empty the account.
 */
export function affordability(headroom: number, burn: BurnEstimate): number {
  if (headroom <= 0) return 0;
  const remainingAfter = headroom - burn.pct;
  if (remainingAfter <= 0) return 0.15; // would finish the window
  if (remainingAfter < 10) return 0.5; // would leave it nearly empty
  if (remainingAfter < 25) return 0.85;
  return 1;
}

export const BURN_PRIORS = PRIOR_BURN;
export const BURN_KIND_MULTIPLIERS: Record<string, number> = KIND_MULTIPLIER;

/** Per-provider capability ordering used when reporting burn in the UI. */
export function describeBurn(provider: ProviderId, burn: BurnEstimate): string {
  const source = burn.measured ? `measured over ${burn.samples} runs` : 'estimated';
  return `${provider}: ~${burn.pct.toFixed(1)}% of window (${source})`;
}
