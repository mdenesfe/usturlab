import type { UsageWindow } from './quotaTracker.js';

/**
 * GitHub AI Credits usage for PAT-authenticated Copilot accounts.
 * Requires a fine-grained token with "Plan: read". Best-effort.
 */
export async function fetchCopilotCredits(
  token: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<UsageWindow[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'usturlab',
  };
  try {
    const userRes = await fetchImpl('https://api.github.com/user', { headers });
    if (!userRes.ok) return [];
    const user = (await userRes.json()) as { login?: string };
    if (!user.login) return [];

    const now = new Date();
    const url =
      `https://api.github.com/users/${user.login}/settings/billing/ai_credit/usage` +
      `?year=${now.getUTCFullYear()}&month=${now.getUTCMonth() + 1}`;
    const res = await fetchImpl(url, { headers });
    if (!res.ok) return [];
    const data = (await res.json()) as Record<string, unknown>;

    const used = numeric(data, 'total_credits_used', 'credits_used', 'used');
    const included = numeric(data, 'total_credits_included', 'credits_included', 'included');
    if (used === undefined || !included) return [];

    const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    return [
      {
        utilizationPct: Math.min(100, Math.round((used / included) * 100)),
        resetAt: reset.getTime(),
        label: 'AI credits',
      },
    ];
  } catch {
    return [];
  }
}

function numeric(data: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const v = data[key];
    if (typeof v === 'number') return v;
  }
  return undefined;
}
