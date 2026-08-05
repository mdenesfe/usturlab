/**
 * Notice when a conversation has stopped being worth continuing.
 *
 * A model that has already failed twice is now reading its own failed attempts
 * every turn, and they compete for its attention with the actual task. The fix
 * is not a better follow-up message — it is a new conversation carrying what
 * the failures taught, which costs one paste and usually beats another round.
 *
 * Length alone is never the trigger. A long thread deep in one problem is
 * exactly where the accumulated context earns its place; what is worth flagging
 * is a thread going in circles, so every signal here is evidence of circling.
 */

export interface ThreadSignals {
  /** Runs in this conversation so far. */
  turnCount: number;
  /** Runs the user had to interrupt or talk back to mid-flight. */
  corrections: number;
  /** Times the project's own checks were still failing after a repair attempt. */
  failedVerifications: number;
}

export interface ThreadVerdict {
  crowded: boolean;
  /** What was observed, in the user's terms. */
  reason?: string;
  /** What to do about it. */
  advice?: string;
}

const HEALTHY: ThreadVerdict = { crowded: false };

const ADVICE =
  'A new chat with what you learned usually beats another follow-up here — the failed attempts ' +
  'stay in this one and compete for the model\'s attention.';

export function assessThread(signals: ThreadSignals): ThreadVerdict {
  if (signals.failedVerifications >= 2) {
    return {
      crowded: true,
      reason: 'the checks have failed twice in this chat without getting green',
      advice: ADVICE,
    };
  }
  if (signals.corrections >= 2) {
    return {
      crowded: true,
      reason: 'you have had to correct this chat twice',
      advice: ADVICE,
    };
  }
  // One correction is normal. One correction twenty turns deep is a thread that
  // has been carrying its own noise for a while.
  if (signals.turnCount >= 20 && signals.corrections >= 1) {
    return {
      crowded: true,
      reason: `${signals.turnCount} turns in, and still being steered`,
      advice: ADVICE,
    };
  }
  return HEALTHY;
}
