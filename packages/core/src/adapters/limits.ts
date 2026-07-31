import type { LimitInfo } from '../types.js';

/**
 * All limit-message fingerprints live here so upstream copy changes only ever
 * require touching this file. Detection is passive (parse what the CLI said);
 * a miss degrades to a generic error, never a crash.
 */

const CLAUDE_PIPE_EPOCH = /Claude AI usage limit reached\|(\d{5,})/i;

/**
 * Infrastructure failures — a dropped stream, an overloaded upstream, a socket
 * reset. These say nothing about the account or the model, so the right answer
 * is to try the same account again rather than spend another provider's quota.
 */
const TRANSIENT = [
  /connection closed mid-?response/i,
  /connection (error|reset|closed)/i,
  /socket hang ?up/i,
  /premature close/i,
  /stream (disconnected|ended unexpectedly|closed)/i,
  /fetch failed/i,
  /network (error|timeout)/i,
  /\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENETUNREACH|EAI_AGAIN)\b/,
  /\boverloaded(_error)?\b/i,
  /\b(429|500|502|503|504)\b.*\b(error|gateway|unavailable|timeout)\b/i,
  /(bad gateway|service unavailable|gateway timeout|internal server error)/i,
  /request timed out/i,
];

/** True when an error is worth retrying on the same account. */
export function isTransientFailure(text: string): boolean {
  if (!text) return false;
  return TRANSIENT.some((re) => re.test(text));
}

export function detectClaudeLimit(text: string): LimitInfo | undefined {
  const pipe = CLAUDE_PIPE_EPOCH.exec(text);
  if (pipe) {
    const epoch = Number(pipe[1]);
    // Epoch may be seconds or milliseconds.
    const resetAt = epoch > 10_000_000_000 ? epoch : epoch * 1000;
    return { resetAt, scope: 'session', raw: text };
  }
  if (/usage limit reached/i.test(text) || /you'?ve (hit|reached) your usage limit/i.test(text)) {
    return { scope: 'unknown', raw: text };
  }
  return undefined;
}

export function detectCodexLimit(text: string, now: () => number = () => Date.now()): LimitInfo | undefined {
  if (!/usage[ _]limit/i.test(text) && !/usage_limit_reached/i.test(text)) return undefined;
  const info: LimitInfo = { scope: 'unknown', raw: text };
  // "... try again at 5:30 PM." — best-effort; next occurrence of that wall-clock time.
  const at = /try again at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text);
  if (at) {
    let hours = Number(at[1]);
    const minutes = at[2] ? Number(at[2]) : 0;
    const meridiem = at[3]?.toLowerCase();
    if (meridiem === 'pm' && hours < 12) hours += 12;
    if (meridiem === 'am' && hours === 12) hours = 0;
    const d = new Date(now());
    d.setHours(hours, minutes, 0, 0);
    if (d.getTime() <= now()) d.setDate(d.getDate() + 1);
    info.resetAt = d.getTime();
  }
  return info;
}

export function detectGeminiLimit(text: string): LimitInfo | undefined {
  if (
    /RESOURCE_EXHAUSTED/i.test(text) ||
    /status(?: code)?[: ]+429/i.test(text) ||
    /"code"\s*:\s*429/.test(text) ||
    /daily .*quota/i.test(text) ||
    /quota (limit|exceeded)/i.test(text)
  ) {
    const scope = /daily/i.test(text) ? 'daily' : 'unknown';
    return { scope, raw: text };
  }
  return undefined;
}

export function detectCopilotLimit(text: string): LimitInfo | undefined {
  if (/quota_exceeded/i.test(text) || /no quota/i.test(text) || /status(?: code)?[: ]+402/i.test(text)) {
    return { scope: 'credits', raw: text };
  }
  return undefined;
}
