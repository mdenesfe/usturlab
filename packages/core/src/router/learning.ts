import type { ProviderId, Tier } from '../types.js';
import type { TaskMetric } from '../quota/metricsSchema.js';
import { median } from '../quota/metricsSchema.js';

/**
 * The feedback loop: turn what actually happened into how the router judges
 * each provider. A static table is only a prior — real outcomes on this
 * user's own work move it, gently at first and firmly once there is enough
 * evidence.
 */

/** A run counts as clean when it finished and the user did not have to fight it. */
export function isCleanRun(m: TaskMetric): boolean {
  return m.status === 'success' && !m.steered && !m.retried && !m.escalated;
}

/** A re-ask is only a retry if it lands while the last answer is still the subject. */
const RETRY_WINDOW_MS = 5 * 60 * 1000;

// Word boundary is spelled out because \b does not see Turkish letters.
/** Plain rejections — the answer was wrong and the user is saying so. */
const REDO_RE =
  /^(no+|nope|wrong|try again|redo|again|that'?s? (wrong|not right|not what)|not what i (wanted|asked)|hay[ıi]r|olmad[ıi]|yanl[ıi][şs]|tekrar (dene|yap)|yeniden (dene|yap)|d[üu]zelt|bu de[ğg]il)(?![\p{L}\p{N}])/iu;

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'is', 'it', 'this', 'that', 'for', 'on', 'with',
  've', 'bir', 'bu', 'şu', 'için', 'ile', 'da', 'de', 'mi', 'ki',
]);

function significantWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}_]+/u)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
  );
}

/** Jaccard overlap of significant words — cheap and language-agnostic. */
export function promptSimilarity(a: string, b: string): number {
  const wa = significantWords(a);
  const wb = significantWords(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / (wa.size + wb.size - shared);
}

/**
 * True when `next` is the user asking for the same thing again — either an
 * outright rejection or a near-identical prompt right after the last answer.
 * That marks the previous run as friction even though it "succeeded".
 */
export function isRetry(previous: string, next: string, gapMs: number): boolean {
  if (gapMs < 0 || gapMs > RETRY_WINDOW_MS) return false;
  if (REDO_RE.test(next.trim())) return true;
  return promptSimilarity(previous, next) >= 0.6;
}

export interface ProviderPerformance {
  provider: ProviderId;
  kind?: string;
  tier?: Tier;
  runs: number;
  cleanRate: number;
  medianDurationMs: number;
  /** 0..1 — how much this evidence should be trusted. */
  confidence: number;
}

/** Confidence grows with sample size and saturates around 20 runs. */
export function sampleConfidence(runs: number): number {
  return runs <= 0 ? 0 : Math.min(1, runs / (runs + 8));
}

export function measurePerformance(
  metrics: TaskMetric[],
  provider: ProviderId,
  kind?: string,
  tier?: Tier,
): ProviderPerformance {
  // A dropped connection is not a verdict on the account — it would otherwise
  // punish whichever provider happened to be running when the network blipped.
  const relevant = metrics.filter(
    (m) =>
      m.provider === provider &&
      !m.transient &&
      (kind === undefined || m.kind === kind) &&
      // Runs recorded before tiers were tracked carry no tier and are simply
      // not evidence about one; they still count in the untiered probes.
      (tier === undefined || m.tier === tier),
  );
  const clean = relevant.filter(isCleanRun);
  return {
    provider,
    kind,
    tier,
    runs: relevant.length,
    cleanRate: relevant.length > 0 ? clean.length / relevant.length : 0,
    medianDurationMs: median(clean.map((m) => m.durationMs ?? 0).filter((d) => d > 0)),
    confidence: sampleConfidence(relevant.length),
  };
}

/**
 * Blends the static affinity with observed performance.
 *
 * The observed clean-rate is compared against a neutral baseline (0.8): doing
 * better pulls the score up, worse pulls it down, and the pull is scaled by
 * how much evidence exists.
 *
 * Evidence is keyed by tier as well as kind, because a provider is not one
 * model. Measuring only per-provider meant a string of scrappy runs on the
 * cheap model dragged down the score that decides whether the *expensive* one
 * gets the hard work — and vice versa. Probes run most-specific first, and each
 * fallback is a weaker claim about the model actually being considered, so it
 * is trusted proportionally less.
 */
export function calibrateAffinity(
  staticAffinity: number,
  metrics: TaskMetric[],
  provider: ProviderId,
  kind: string,
  tier?: Tier,
): { affinity: number; performance: ProviderPerformance } {
  const probes: Array<{ perf: ProviderPerformance; weight: number }> = [];
  if (tier) {
    probes.push({ perf: measurePerformance(metrics, provider, kind, tier), weight: 1 });
    probes.push({ perf: measurePerformance(metrics, provider, undefined, tier), weight: 0.5 });
  }
  probes.push({ perf: measurePerformance(metrics, provider, kind), weight: tier ? 0.5 : 1 });
  probes.push({ perf: measurePerformance(metrics, provider), weight: tier ? 0.25 : 0.5 });

  const MIN_RUNS = 3;
  const chosen = probes.find((p) => p.perf.runs >= MIN_RUNS);
  const fallback = probes[0]!.perf;
  const evidence = chosen
    ? { ...chosen.perf, confidence: chosen.perf.confidence * chosen.weight }
    : { ...fallback, confidence: 0 };

  if (evidence.confidence <= 0) return { affinity: staticAffinity, performance: fallback };

  const BASELINE = 0.8;
  const delta = evidence.cleanRate - BASELINE;
  // Cap the correction so one bad streak cannot disqualify a provider.
  const adjusted = staticAffinity * (1 + evidence.confidence * delta * 0.5);
  return {
    affinity: Math.max(0.35, Math.min(1, adjusted)),
    // Report the evidence actually used, so callers reading medianDurationMs
    // get the timings of the runs the score was built from.
    performance: chosen ? chosen.perf : fallback,
  };
}
