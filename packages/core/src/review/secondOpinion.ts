import type { ProviderId, Target } from '../types.js';
import { isReviewOnly } from '../types.js';
import type { Classification } from '../router/classify.js';
import type { BurnEstimate } from '../router/burn.js';

/**
 * The one thing this project can do that no single CLI can: hold four
 * subscriptions at once and let them check each other.
 *
 * A model reviewing its own work is the weakest kind of review — it shares
 * every blind spot that produced the mistake. A *different* model, from a
 * different lab, looking only at the diff, does not.
 *
 * A review used to be expensive, so it was gated three ways: hard work only, a
 * provider that is actually different, and enough headroom that the review does
 * not cost the user their next task.
 *
 * A free reviewer removes the third gate entirely. Nothing is being rationed,
 * so headroom is not consulted and the subscriptions are left for the work that
 * needs tools. The remaining gates are the user's own setting (`policy`) and
 * the requirement that the reviewer be a different model from the author —
 * which a free open-weight model satisfies by construction.
 */

export interface ReviewerChoice {
  target: Target;
  reason: string;
}

export interface PickReviewerOptions {
  /** Who produced the work. */
  author: Target;
  /** Everything the router considered, in its own preference order. */
  candidates: Target[];
  classification: Classification;
  /** Headroom per account key (`provider:account`), 0..100. */
  headroom: Record<string, number>;
  burn?: BurnEstimate;
  /** 'never' | 'hard' (default) | 'always'. */
  policy?: 'never' | 'hard' | 'always';
}

const MIN_HEADROOM_FOR_REVIEW = 35;

function key(target: Target): string {
  return `${target.provider}:${target.account}`;
}

/**
 * Picks who should second-guess the author, or nobody.
 *
 * Preference order is deliberate: a different *provider* first (different
 * training, different failure modes), a different account of the same provider
 * only as a fallback — that at least gives a fresh context window.
 */
export function pickReviewer(options: PickReviewerOptions): ReviewerChoice | undefined {
  const policy = options.policy ?? 'hard';
  if (policy === 'never') return undefined;
  if (policy === 'hard' && options.classification.complexity !== 'hard') return undefined;

  const affordable = (target: Target): boolean => {
    const left = options.headroom[key(target)] ?? 0;
    return left >= MIN_HEADROOM_FOR_REVIEW && left - (options.burn?.pct ?? 0) > 10;
  };

  // A reviewer that costs nothing is checked first: it is always a different
  // lab from the author, and choosing it means the paid accounts keep every
  // point of headroom for work that actually needs them.
  const free = options.candidates.find(
    (c) => isReviewOnly(c.provider) && key(c) !== key(options.author),
  );
  if (free) {
    return {
      target: free,
      reason: `reviewed by ${free.provider} — a free open-weight model, none of your quota`,
    };
  }

  const differentProvider = options.candidates.find(
    (c) => c.provider !== options.author.provider && affordable(c),
  );
  if (differentProvider) {
    return {
      target: differentProvider,
      reason: `reviewed by ${differentProvider.provider} — a different model sees different mistakes`,
    };
  }

  const differentAccount = options.candidates.find(
    (c) => key(c) !== key(options.author) && affordable(c),
  );
  if (differentAccount) {
    return {
      target: differentAccount,
      reason: `reviewed by ${key(differentAccount)} — a fresh context on the same provider`,
    };
  }

  return undefined;
}

export interface ReviewRequest {
  /** What the user originally asked for. */
  task: string;
  /** What the author produced. */
  answer: string;
  /** The diff the author actually left behind, when there is one. */
  diff?: string;
  authorProvider: ProviderId;
}

/**
 * The reviewer is told to find what is *wrong*, and told that finding nothing
 * is a valid answer. Reviewers asked to "review" produce filler; reviewers
 * asked to refute produce findings.
 */
export function reviewPrompt(request: ReviewRequest): string {
  const parts = [
    `Another model (${request.authorProvider}) just did this task. Your job is to find what is ` +
      `wrong with its work before the user relies on it. Be adversarial and specific.`,
    '',
    `## The task\n${request.task}`,
    '',
    `## What it produced\n${request.answer}`,
  ];
  if (request.diff?.trim()) {
    parts.push('', '## The actual diff it left behind\n```diff\n' + request.diff.trim() + '\n```');
  }
  parts.push(
    '',
    'Check specifically for: a claim the diff does not support, an edge case that breaks, ' +
      'something it said it did but did not, a change that breaks callers elsewhere, and ' +
      'anything the task asked for that is missing.',
    '',
    'Reply with the concrete problems only, most serious first, each with the file and why it ' +
      'breaks. If the work is genuinely correct and complete, reply with exactly: LGTM. ' +
      'Do not pad, do not restate the task, do not invent problems to look thorough.',
  );
  return parts.join('\n');
}

/** True when the reviewer found nothing worth acting on. */
export function isClean(review: string): boolean {
  return /^\s*lgtm\b/i.test(review.trim());
}

/** Asks the author to act on the review — or to push back on it. */
export function revisionPrompt(review: string): string {
  return (
    'A second model reviewed your work and raised these points:\n\n' +
    `${review.trim()}\n\n` +
    'Address each one: fix what is genuinely wrong, and where the reviewer is mistaken say so ' +
    'in one line with the reason rather than changing correct code. Then state what you changed.'
  );
}
