import type { UsageWindow } from './quotaTracker.js';

/**
 * Undocumented endpoint used by Claude Code's own /usage view. Requires the
 * subscription OAuth token, the oauth beta header and a claude-code User-Agent
 * (without it requests land in an aggressively rate-limited bucket).
 * Poll at >= 180s. Best-effort: any schema drift returns [].
 */
export async function fetchClaudeUsage(
  oauthToken: string,
  opts: { userAgentVersion?: string; fetchImpl?: typeof fetch; debug?: (info: string) => void } = {},
): Promise<UsageWindow[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        Authorization: `Bearer ${oauthToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        // The endpoint buckets by UA; stale versions get rate-limited hard.
        'User-Agent': `claude-code/${opts.userAgentVersion ?? '2.1.216'}`,
      },
    });
    if (!res.ok) {
      opts.debug?.(`usage endpoint HTTP ${res.status}`);
      return [];
    }
    const data = (await res.json()) as Record<string, unknown>;
    const windows: UsageWindow[] = [];
    // Verified schema (2026-07): five_hour/seven_day objects with
    // utilization on a 0..100 scale and an ISO resets_at string.
    for (const [key, label] of [
      ['five_hour', '5h window'],
      ['seven_day', 'weekly'],
    ] as const) {
      const w = data[key];
      if (w && typeof w === 'object') {
        const util = (w as Record<string, unknown>).utilization;
        const resets = (w as Record<string, unknown>).resets_at;
        if (typeof util === 'number') {
          windows.push({
            utilizationPct: Math.round(util),
            resetAt: parseResetsAt(resets),
            label,
          });
        }
      }
    }
    if (windows.length > 0) return windows;

    // Fallback: the response also carries a generic limits[] array
    // ({kind, percent, resets_at, is_active}) — survive a key rename.
    const limits = data.limits;
    if (Array.isArray(limits)) {
      for (const entry of limits.slice(0, 4)) {
        if (entry === null || typeof entry !== 'object') continue;
        const e = entry as Record<string, unknown>;
        if (typeof e.percent !== 'number') continue;
        const kind = typeof e.kind === 'string' ? e.kind : 'window';
        windows.push({
          utilizationPct: Math.round(e.percent),
          resetAt: parseResetsAt(e.resets_at),
          label: kind.replace(/_/g, ' '),
        });
      }
    }
    return windows;
  } catch {
    return [];
  }
}

function parseResetsAt(value: unknown): number | undefined {
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isNaN(t) ? undefined : t;
  }
  if (typeof value === 'number') return value > 10_000_000_000 ? value : value * 1000;
  return undefined;
}

export const CLAUDE_USAGE_MIN_INTERVAL_MS = 180_000;
