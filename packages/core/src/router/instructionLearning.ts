import type { TaskMetric } from '../quota/metricsSchema.js';
import { isCleanRun } from './learning.js';

/**
 * Learn what to tell the models, not just which one to pick.
 *
 * Every message the user types into a running task is a correction — the model
 * was going somewhere they did not want. Those corrections are already
 * recorded as `steered`, but the words were thrown away. The words are the
 * valuable part: repeated often enough, a correction is not feedback about one
 * run, it is a standing rule about how this user works.
 *
 * Nothing is promoted automatically. A suggestion is offered; the user accepts
 * it, and only then does it enter the brief every provider receives.
 */

export interface Correction {
  /** What the user said mid-run. */
  text: string;
  timestamp: number;
  provider: string;
  /** Task shape the correction happened on. */
  kind?: string;
}

export interface SuggestedRule {
  /** The rule as it would be written into the brief. */
  text: string;
  /** How many separate corrections support it. */
  support: number;
  /** The corrections it was drawn from, newest first. */
  evidence: Correction[];
  /** Set when the corrections all came from one provider. */
  provider?: string;
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'is', 'it', 'this', 'that', 'for', 'on', 'with',
  'you', 'your', 'not', 'no', 'do', 'dont', 'please', 'just', 'be', 'me', 'my', 'i',
  've', 'bir', 'bu', 'şu', 'için', 'ile', 'da', 'de', 'mi', 'ki', 'ama', 'çok', 'daha', 'olsun',
  'yap', 'yapma', 'lütfen', 'sen', 'ben',
]);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

/** Overlap of significant words — the same cheap measure retry detection uses. */
export function correctionSimilarity(a: string, b: string): number {
  const wa = new Set(words(a));
  const wb = new Set(words(b));
  if (wa.size === 0 || wb.size === 0) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / (wa.size + wb.size - shared);
}

/** Corrections too short or too situational to generalize from. */
function isGeneralizable(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 12 || trimmed.length > 400) return false;
  // A correction that names a specific file or symbol is about this task, not
  // about how the user works.
  if (/\b[\w-]+\.(ts|tsx|js|py|go|rs|md|json|css)\b/i.test(trimmed)) return false;
  return words(trimmed).length >= 2;
}

const SIMILARITY_THRESHOLD = 0.45;
const DEFAULT_MIN_SUPPORT = 2;

/**
 * Groups corrections that say the same thing and proposes the recurring ones
 * as rules. The longest phrasing in a cluster is kept — the user spelled it
 * out most fully the time they were most annoyed, and that phrasing usually
 * carries the reason.
 */
export function suggestRules(
  corrections: Correction[],
  minSupport = DEFAULT_MIN_SUPPORT,
): SuggestedRule[] {
  const usable = corrections.filter((c) => isGeneralizable(c.text));
  const clusters: Correction[][] = [];

  for (const correction of usable) {
    const cluster = clusters.find((c) =>
      c.some((existing) => correctionSimilarity(existing.text, correction.text) >= SIMILARITY_THRESHOLD),
    );
    if (cluster) cluster.push(correction);
    else clusters.push([correction]);
  }

  return clusters
    .filter((c) => c.length >= minSupport)
    .map((cluster) => {
      const sorted = [...cluster].sort((a, b) => b.timestamp - a.timestamp);
      const best = [...cluster].sort((a, b) => b.text.trim().length - a.text.trim().length)[0]!;
      const providers = new Set(cluster.map((c) => c.provider));
      return {
        text: best.text.trim(),
        support: cluster.length,
        evidence: sorted,
        provider: providers.size === 1 ? [...providers][0] : undefined,
      };
    })
    .sort((a, b) => b.support - a.support);
}

export interface LineTrial {
  /** Brief line id under test. */
  id: string;
  withLine: { runs: number; clean: number };
  withoutLine: { runs: number; clean: number };
}

export interface LineVerdict {
  id: string;
  /** Clean-rate difference, positive when the line helps. */
  delta: number;
  /** Enough evidence on both sides to say anything at all. */
  conclusive: boolean;
  /** True when the line measurably hurts and should be dropped. */
  harmful: boolean;
}

const MIN_RUNS_PER_ARM = 8;
const HARMFUL_MARGIN = 0.1;

/**
 * A brief line has to earn its place. Runs are tagged with the line ids they
 * carried, so a line's clean-rate can be compared against runs without it —
 * and one that measurably hurts is dropped rather than defended.
 */
export function judgeLine(trial: LineTrial): LineVerdict {
  const rate = (arm: { runs: number; clean: number }) => (arm.runs > 0 ? arm.clean / arm.runs : 0);
  const conclusive =
    trial.withLine.runs >= MIN_RUNS_PER_ARM && trial.withoutLine.runs >= MIN_RUNS_PER_ARM;
  const delta = rate(trial.withLine) - rate(trial.withoutLine);
  return {
    id: trial.id,
    delta,
    conclusive,
    harmful: conclusive && delta < -HARMFUL_MARGIN,
  };
}

/** Builds the trial for one line from recorded runs. */
export function trialFor(id: string, metrics: TaskMetric[]): LineTrial {
  const withLine = metrics.filter((m) => m.briefLineIds?.includes(id));
  const withoutLine = metrics.filter((m) => m.briefLineIds && !m.briefLineIds.includes(id));
  return {
    id,
    withLine: { runs: withLine.length, clean: withLine.filter(isCleanRun).length },
    withoutLine: { runs: withoutLine.length, clean: withoutLine.filter(isCleanRun).length },
  };
}

/** Line ids the evidence says to stop sending. */
export function disqualifiedLines(ids: string[], metrics: TaskMetric[]): string[] {
  return ids.filter((id) => judgeLine(trialFor(id, metrics)).harmful);
}
