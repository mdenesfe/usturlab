import {
  fetchClaudeUsage,
  fetchCopilotCredits,
  readCodexUsage,
  type QuotaTracker,
} from '@usrouter/core';
import type { AccountStore } from './storage/accountStore.js';

/** Per-source minimum fetch intervals; the Claude endpoint is undocumented and rate-limits hard. */
const MIN_INTERVAL_MS: Record<string, number> = {
  claude: 180_000,
  copilot: 60_000,
  codex: 10_000,
};

const lastFetch = new Map<string, number>();

/**
 * Refreshes usage windows for every account that has a data source:
 * - claude (subscription token): oauth usage endpoint (5h/weekly utilization)
 * - codex (managed profile): offline read of session rollout rate_limits
 * - copilot (PAT): GitHub AI-credits REST endpoint
 * Results land in the QuotaTracker, which fans out to all open surfaces.
 */
export async function refreshUsage(accounts: AccountStore, quota: QuotaTracker): Promise<void> {
  const now = Date.now();
  await Promise.all(
    accounts.all().map(async (account) => {
      const minInterval = MIN_INTERVAL_MS[account.provider];
      if (minInterval === undefined) return;
      const last = lastFetch.get(account.id) ?? 0;
      if (now - last < minInterval) return;
      lastFetch.set(account.id, now);

      try {
        if (account.provider === 'claude' && account.authMode === 'oauth-token' && account.hasSecret) {
          const secret = await accounts.getSecret(account.id);
          if (!secret) return;
          const windows = await fetchClaudeUsage(secret);
          if (windows.length > 0) quota.setUsage(account.id, windows);
        } else if (account.provider === 'codex' && account.homeDir) {
          const windows = readCodexUsage(account.homeDir);
          if (windows.length > 0) quota.setUsage(account.id, windows);
        } else if (account.provider === 'copilot' && account.authMode === 'api-key' && account.hasSecret) {
          const secret = await accounts.getSecret(account.id);
          if (!secret) return;
          const windows = await fetchCopilotCredits(secret);
          if (windows.length > 0) quota.setUsage(account.id, windows);
        }
      } catch {
        // usage display is best-effort; never surface fetch noise
      }
    }),
  );
}
