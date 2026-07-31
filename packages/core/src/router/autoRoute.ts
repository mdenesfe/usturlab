import type { AccountProfile, ProviderId, Target } from '../types.js';
import type { QuotaTracker } from '../quota/quotaTracker.js';
import type { Classification, Complexity, TaskKind } from './classify.js';

/**
 * Automatic model choice: match the task's weight to a model tier, then pick
 * the account that can afford it. Saving quota matters — but never at the
 * cost of doing the user's job badly, so on hard work capability outweighs
 * headroom, and on trivial work headroom outweighs capability.
 */

export type Tier = 'light' | 'standard' | 'heavy';

/** Model id per provider per tier; undefined means "let the CLI decide". */
const TIER_MODELS: Record<ProviderId, Record<Tier, string | undefined>> = {
  claude: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
  codex: { light: undefined, standard: undefined, heavy: undefined },
  gemini: { light: 'gemini-2.5-flash', standard: 'gemini-2.5-pro', heavy: 'gemini-2.5-pro' },
  copilot: {
    light: 'claude-haiku-4.5',
    standard: 'claude-sonnet-4.6',
    heavy: 'gpt-5.4',
  },
};

const TIER_BY_COMPLEXITY: Record<Complexity, Tier> = {
  trivial: 'light',
  simple: 'light',
  moderate: 'standard',
  hard: 'heavy',
};

/** Rough capability score per provider for a kind of work (0..1). */
const KIND_AFFINITY: Record<TaskKind, Partial<Record<ProviderId, number>>> = {
  question: { claude: 0.9, codex: 0.85, gemini: 0.85, copilot: 0.8 },
  explain: { claude: 0.95, codex: 0.85, gemini: 0.85, copilot: 0.8 },
  edit: { claude: 0.95, codex: 0.95, gemini: 0.8, copilot: 0.85 },
  debug: { claude: 0.95, codex: 0.9, gemini: 0.8, copilot: 0.8 },
  test: { claude: 0.9, codex: 0.95, gemini: 0.8, copilot: 0.85 },
  review: { claude: 0.95, codex: 0.85, gemini: 0.8, copilot: 0.8 },
  refactor: { claude: 0.95, codex: 0.9, gemini: 0.8, copilot: 0.8 },
  docs: { claude: 0.9, codex: 0.85, gemini: 0.9, copilot: 0.8 },
  agentic: { claude: 0.95, codex: 0.95, gemini: 0.75, copilot: 0.8 },
};

export interface AutoRouteResult {
  chain: Target[];
  reason: string;
}

interface Candidate {
  target: Target;
  score: number;
  headroom: number;
  affinity: number;
  account: AccountProfile;
}

/**
 * Headroom (0..100) for an account: 100 = untouched, 0 = exhausted.
 * Unknown usage is treated as comfortably free but slightly below a
 * measured-empty account, so measured accounts win ties honestly.
 */
export function accountHeadroom(accountId: string, quota: QuotaTracker): number {
  const snapshot = quota.snapshot([accountId])[0];
  if (!snapshot?.available) return 0;
  const windows = snapshot.usage ?? [];
  if (windows.length === 0) return 75;
  const worst = Math.max(...windows.map((w) => w.utilizationPct));
  return Math.max(0, 100 - worst);
}

export function autoRoute(
  classification: Classification,
  accounts: AccountProfile[],
  quota: QuotaTracker,
): AutoRouteResult {
  const tier = TIER_BY_COMPLEXITY[classification.complexity];
  const affinities = KIND_AFFINITY[classification.kind] ?? {};

  // Hard work: capability first. Trivial work: protect the good quota.
  const headroomWeight =
    classification.complexity === 'hard'
      ? 0.15
      : classification.complexity === 'moderate'
        ? 0.45
        : 0.8;
  const capabilityWeight = 1 - headroomWeight;

  const candidates: Candidate[] = [];
  for (const account of accounts) {
    if (account.disabled) continue;
    const headroom = accountHeadroom(account.id, quota);
    if (headroom <= 0) continue; // cooled down — router skips it anyway
    const affinity = affinities[account.provider] ?? 0.75;
    // Nearly-exhausted accounts get a steep penalty so they are kept in
    // reserve unless nothing else can do the job.
    const reserve = headroom < 15 ? 0.5 : headroom < 30 ? 0.8 : 1;
    // Cube the affinity so real capability gaps outweigh small quota gaps —
    // doing the user's job well beats saving a few percent of a window.
    const capability = affinity ** 3 * 100;
    const score =
      (capabilityWeight * capability + headroomWeight * headroom) * reserve -
      account.priority * 0.5;
    candidates.push({
      target: {
        provider: account.provider,
        account: account.label,
        model: TIER_MODELS[account.provider][tier],
      },
      score,
      headroom,
      affinity,
      account,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  const reason = best
    ? `auto · ${classification.complexity} ${classification.kind} → ${tier} model` +
      (best.headroom < 100 ? ` · ${Math.round(best.headroom)}% quota left` : '')
    : 'auto · no account available';

  return { chain: candidates.map((c) => c.target), reason };
}

export const AUTO_TIER_MODELS = TIER_MODELS;
