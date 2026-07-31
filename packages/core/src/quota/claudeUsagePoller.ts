import type { UsageWindow } from './quotaTracker.js';

/**
 * Undocumented endpoint used by Claude Code's own /usage view. Requires the
 * subscription OAuth token, the oauth beta header and a claude-code User-Agent
 * (without it requests land in an aggressively rate-limited bucket).
 * Poll at >= 180s. Best-effort: any schema drift returns [].
 */
export async function fetchClaudeUsage(
  oauthToken: string,
  opts: { userAgentVersion?: string; fetchImpl?: typeof fetch } = {},
): Promise<UsageWindow[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        Authorization: `Bearer ${oauthToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': `claude-code/${opts.userAgentVersion ?? '2.1.0'}`,
      },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as Record<string, unknown>;
    const windows: UsageWindow[] = [];
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
            // Some responses use 0..1, some 0..100.
            utilizationPct: util <= 1 ? Math.round(util * 100) : Math.round(util),
            resetAt: typeof resets === 'string' ? Date.parse(resets) : typeof resets === 'number' ? resets * 1000 : undefined,
            label,
          });
        }
      }
    }
    return windows;
  } catch {
    return [];
  }
}

export const CLAUDE_USAGE_MIN_INTERVAL_MS = 180_000;
