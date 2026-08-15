import type { ProviderId } from '../types.js';

/**
 * What it costs to move a conversation, and how long the reason to stay lasts.
 *
 * Every CLI here caches the conversation prefix on the provider's side, and
 * every one of those caches has a short life. Two consequences the router used
 * to miss in opposite directions:
 *
 *  - Staying is worth *more* than a constant. Moving a long thread means the
 *    new account re-reads everything from cold, at full price, and the old
 *    account's cache is thrown away.
 *  - Staying is worth *less* than a constant, once the cache is gone. Twenty
 *    minutes after the last turn there is nothing warm left to protect, and a
 *    bonus that still behaves as if there were will pin a conversation to an
 *    account that no longer deserves it.
 *
 * So the bonus for staying is two parts: re-ingestion, which grows with the
 * conversation, and cache warmth, which decays with the clock.
 */

/**
 * How long a provider's prompt cache survives idle.
 *
 * Only Anthropic's number is documented; the rest are assumed to match it
 * because none of these providers publishes one for their consumer plans. That
 * is a weaker claim than the code being right, so it is worth saying what
 * happens when the assumption is wrong: freshness only ever *reduces* the bonus
 * for staying put, and the bonus never falls below the re-ingestion cost, which
 * is measured. Guessing the TTL too short makes the router slightly quicker to
 * move a conversation; guessing it too long makes it slightly slower. Neither
 * loses work, and both are bounded by numbers that are real.
 */
export const CACHE_TTL_MS: Record<ProviderId, number> = {
  // Documented: Anthropic's default prompt-cache TTL is 5 minutes.
  claude: 5 * 60_000,
  // Assumed — OpenAI does not publish a retention window for Codex sessions.
  codex: 5 * 60_000,
  // Assumed — Gemini's implicit caching has no published idle window.
  gemini: 5 * 60_000,
  // Assumed — Copilot publishes nothing about prefix caching at all.
  copilot: 5 * 60_000,
  // Stateless HTTP, reviews only — nothing is ever warm.
  openrouter: 0,
};

/** Points the incumbent gets purely for having a warm cache. */
const CACHE_BONUS = 12;

/** Ceiling on the re-ingestion half, so a huge thread can still be left. */
const REINGEST_CAP = 18;

/** Tokens of context worth one point of re-ingestion cost. */
const TOKENS_PER_POINT = 1_500;

/** Per-turn prior when no run on this target has reported its context size. */
const TURN_PRIOR_POINTS = 2;
const TURN_PRIOR_CAP = 6;

/**
 * 1 while the cache is certainly alive, fading to 0 across a second TTL rather
 * than falling off a cliff — the TTL is a documented default, not a timestamp
 * we can read, so a hard edge would be false precision.
 */
export function cacheFreshness(provider: ProviderId, elapsedMs: number | undefined): number {
  const ttl = CACHE_TTL_MS[provider];
  if (ttl <= 0) return 0;
  // No clock reading at all: assume the common case, a reply typed straight back.
  if (elapsedMs === undefined) return 1;
  if (elapsedMs <= ttl) return 1;
  if (elapsedMs >= ttl * 2) return 0;
  return 1 - (elapsedMs - ttl) / ttl;
}

/**
 * Points for the context a move would have to re-read. Measured from the last
 * run's cache reads when there is one — that number *is* the size of what the
 * far end would rebuild — and from the turn count when there is not.
 */
export function reingestionCost(contextTokens: number | undefined, turnCount: number): number {
  if (contextTokens && contextTokens > 0) {
    return Math.min(REINGEST_CAP, contextTokens / TOKENS_PER_POINT);
  }
  return Math.min(turnCount, TURN_PRIOR_CAP) * TURN_PRIOR_POINTS;
}

export interface StickyInput {
  provider: ProviderId;
  turnCount: number;
  /** Tokens the last run on this target read from cache, when it reported them. */
  contextTokens?: number;
  /** Milliseconds since that run finished. */
  elapsedMs?: number;
}

export interface StickyBonus {
  /** Score points for staying where the conversation already is. */
  points: number;
  /** True when the provider's cache is still expected to be alive. */
  warm: boolean;
  /** Context a move would make the next account re-read, when measured. */
  moveTokens?: number;
}

/** What staying on this target is worth, right now. */
export function stickyBonus(input: StickyInput): StickyBonus {
  const freshness = cacheFreshness(input.provider, input.elapsedMs);
  const reingest = reingestionCost(input.contextTokens, input.turnCount);
  return {
    points: reingest + CACHE_BONUS * freshness,
    warm: freshness > 0.5,
    moveTokens: input.contextTokens && input.contextTokens > 0 ? input.contextTokens : undefined,
  };
}

export const CACHE_AFFINITY_CONSTANTS = {
  CACHE_BONUS,
  REINGEST_CAP,
  TOKENS_PER_POINT,
  TURN_PRIOR_POINTS,
  TURN_PRIOR_CAP,
};
