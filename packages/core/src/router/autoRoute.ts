import type { AccountProfile, PermissionMode, ProviderId, Target, Tier } from '../types.js';
import { isReviewOnly } from '../types.js';
import type { QuotaTracker } from '../quota/quotaTracker.js';
import type { TaskMetric } from '../quota/metricsSchema.js';
import type { Classification, Complexity, TaskKind } from './classify.js';
import { calibrateAffinity } from './learning.js';
import { affordability, estimateBurn, type BurnEstimate } from './burn.js';

/**
 * Automatic model choice: match the task's weight to a model tier, then pick
 * the account that can afford it. Saving quota matters — but never at the
 * cost of doing the user's job badly, so on hard work capability outweighs
 * headroom, and on trivial work headroom outweighs capability.
 *
 * Three things keep this honest: the capability table is calibrated by real
 * outcomes, the quota check accounts for what the run will *cost* rather than
 * only what is left, and a conversation stays where it started unless the
 * work genuinely got heavier.
 */

export type { Tier } from '../types.js';

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
  // Never routed to (review-only), so the tier never gets read; the adapter
  // picks a free model for itself.
  openrouter: { light: undefined, standard: undefined, heavy: undefined },
};

const TIER_BY_COMPLEXITY: Record<Complexity, Tier> = {
  trivial: 'light',
  simple: 'light',
  moderate: 'standard',
  hard: 'heavy',
};

const TIER_RANK: Record<Tier, number> = { light: 0, standard: 1, heavy: 2 };

/** Score bonus for keeping a conversation where it already is. */
const STICKY_BASE = 12;

/** Points a measurably faster account is worth on light work. */
const SPEED_BONUS = 8;

/** Prior capability per provider per kind of work (0..1), calibrated by use. */
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

/** How many past turns still carry weight when sizing this one. */
const RECENT_TURNS = 2;

const TIER_ORDER: Tier[] = ['light', 'standard', 'heavy'];

/** What the router knows about the conversation this message belongs to. */
export interface ConversationContext {
  /** Where the previous turns of this conversation ran. */
  lastTarget?: Target;
  /** Complexity of the last few turns, newest first. */
  recentComplexity?: Complexity[];
  turnCount: number;
}

/** The heavier of two tiers. */
function heavier(a: Tier, b: Tier): Tier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

export interface AutoRouteResult {
  chain: Target[];
  reason: string;
  /** Set when the conversation moved to a heavier tier mid-thread. */
  escalated?: { from: Tier; to: Tier };
  /** The router wants this turn reviewed before it writes code. */
  suggestPermission?: PermissionMode;
  burn?: BurnEstimate;
  /** Weight class chosen for this turn — recorded with the run. */
  tier: Tier;
}

interface Candidate {
  target: Target;
  score: number;
  headroom: number;
  burn: BurnEstimate;
  account: AccountProfile;
  /** Measured median of this account's clean runs, 0 when unmeasured. */
  medianDurationMs: number;
  /** How many runs that median came from. */
  runs: number;
}

export interface AutoRouteOptions {
  metrics?: TaskMetric[];
  conversation?: ConversationContext;
  /** Switch heavy code-writing work to plan-first review. */
  autoPlan?: boolean;
  currentPermission?: PermissionMode;
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
  options: AutoRouteOptions = {},
): AutoRouteResult {
  const metrics = options.metrics ?? [];
  const conversation = options.conversation;

  // ── tier, with conversation memory ────────────────────
  const messageTier = TIER_BY_COMPLEXITY[classification.complexity];
  // A short follow-up inside a heavy thread ("yes, do it") must not drop the
  // conversation to a light model — but the thread's weight has to be able to
  // come back down too. An all-time peak never did: one hard turn pinned every
  // later turn to the heavy tier, so a typo fix thirty messages on still ran on
  // the most expensive model in the account. Only the last few turns count, and
  // they lift the tier by at most one rank.
  const recent = (conversation?.recentComplexity ?? []).slice(0, RECENT_TURNS);
  const recentTier = recent.length
    ? recent.map((c) => TIER_BY_COMPLEXITY[c]).reduce(heavier)
    : undefined;
  const oneRankUp = TIER_ORDER[Math.min(TIER_RANK[messageTier] + 1, TIER_ORDER.length - 1)]!;
  const tier: Tier =
    recentTier && TIER_RANK[recentTier] > TIER_RANK[messageTier]
      ? (TIER_RANK[recentTier] > TIER_RANK[oneRankUp] ? oneRankUp : recentTier)
      : messageTier;
  const escalated =
    recentTier && TIER_RANK[messageTier] > TIER_RANK[recentTier]
      ? { from: recentTier, to: messageTier }
      : undefined;

  // Hard work: capability first. Trivial work: protect the good quota.
  const headroomWeight = tier === 'heavy' ? 0.15 : tier === 'standard' ? 0.45 : 0.8;
  const capabilityWeight = 1 - headroomWeight;
  const affinities = KIND_AFFINITY[classification.kind] ?? {};

  const candidates: Candidate[] = [];
  for (const account of accounts) {
    if (account.disabled) continue;
    // A free reviewer has no quota to weigh and would win every scoring round
    // on headroom alone — it is never a candidate to do the work.
    if (isReviewOnly(account.provider)) continue;
    const headroom = accountHeadroom(account.id, quota);
    if (headroom <= 0) continue; // cooled down — router skips it anyway

    const target: Target = {
      provider: account.provider,
      account: account.label,
      model: TIER_MODELS[account.provider][tier],
    };
    const burn = estimateBurn(target, classification.complexity, classification.kind, metrics);

    const { affinity, performance } = calibrateAffinity(
      affinities[account.provider] ?? 0.75,
      metrics,
      account.provider,
      classification.kind,
      tier,
    );
    // Cube the affinity so real capability gaps outweigh small quota gaps —
    // doing the user's job well beats saving a few percent of a window.
    const capability = affinity ** 3 * 100;
    // Nearly-exhausted accounts are kept in reserve, and an account that
    // cannot afford this particular run is pushed down further.
    const reserve = headroom < 15 ? 0.5 : headroom < 30 ? 0.8 : 1;
    const afford = affordability(headroom, burn);
    // Staying in the same conversation is worth real points: it keeps the
    // native session and everything the model already knows. The longer the
    // thread, the more expensive moving is — but a reserve/afford penalty on a
    // draining account still outweighs it.
    const sameAsLast =
      conversation?.lastTarget?.provider === account.provider &&
      conversation?.lastTarget?.account === account.label;
    const sticky =
      sameAsLast && !escalated ? STICKY_BASE + Math.min(conversation!.turnCount, 6) * 3 : 0;

    const score =
      (capabilityWeight * capability + headroomWeight * headroom) * reserve * afford +
      sticky -
      account.priority * 0.5;

    candidates.push({
      target,
      score,
      headroom,
      burn,
      account,
      medianDurationMs: performance.medianDurationMs,
      runs: performance.runs,
    });
  }

  // On light work, how long the answer takes is part of doing the job well:
  // the same correct fix in 6s beats it in 40s, and the tier is chosen precisely
  // because capability is not the deciding factor here. Only measured medians
  // count — an account with no history neither gains nor loses.
  if (tier === 'light') {
    const timed = candidates.filter((c) => c.medianDurationMs > 0 && c.runs >= 3);
    if (timed.length > 1) {
      const fastest = Math.min(...timed.map((c) => c.medianDurationMs));
      for (const c of timed) c.score += SPEED_BONUS * (fastest / c.medianDurationMs);
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];

  // Heavy code-writing work gets planned before it edits, unless the user
  // already restricted the run themselves.
  const suggestPermission =
    options.autoPlan &&
    classification.writesCode &&
    tier === 'heavy' &&
    options.currentPermission &&
    options.currentPermission !== 'safe'
      ? ('safe' as PermissionMode)
      : undefined;

  const parts = [`auto · ${classification.complexity} ${classification.kind} → ${tier} model`];
  if (escalated) parts.push(`escalated ${escalated.from}→${escalated.to}`);
  else if (best && conversation?.lastTarget && conversation.turnCount > 0) parts.push('same thread');
  if (best) {
    parts.push(`~${best.burn.pct.toFixed(1)}% burn of ${Math.round(best.headroom)}% left`);
  }

  return {
    chain: candidates.map((c) => c.target),
    reason: best ? parts.join(' · ') : 'auto · no account available',
    escalated,
    suggestPermission,
    burn: best?.burn,
    tier,
  };
}

export const AUTO_TIER_MODELS = TIER_MODELS;
export const AUTO_TIER_BY_COMPLEXITY = TIER_BY_COMPLEXITY;
