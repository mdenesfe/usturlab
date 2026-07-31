import {
  fetchClaudeUsage,
  fetchCopilotCredits,
  readCodexUsage,
  type QuotaTracker,
} from '@usrouter/core';
import type { AccountStore } from './storage/accountStore.js';

/**
 * Per-source minimum intervals after a SUCCESSFUL fetch; failures retry after
 * a short backoff so one hiccup doesn't freeze the display for minutes.
 * The Claude endpoint is undocumented and rate-limits hard — keep it >= 180s.
 */
const SUCCESS_INTERVAL_MS: Record<string, number> = {
  claude: 180_000,
  copilot: 60_000,
  codex: 5_000,
};
const FAILURE_BACKOFF_MS = 20_000;

const lastAttempt = new Map<string, { at: number; ok: boolean }>();

/**
 * Refreshes usage windows for every account that has a data source:
 * - claude (subscription token): oauth usage endpoint (5h/weekly utilization)
 * - codex (managed profile): offline read of session rollout rate_limits
 * - copilot (PAT): GitHub AI-credits REST endpoint
 * Results land in the QuotaTracker, which fans out to all open surfaces.
 */
export async function refreshUsage(
  accounts: AccountStore,
  quota: QuotaTracker,
  log?: (line: string) => void,
): Promise<void> {
  const now = Date.now();
  await Promise.all(
    accounts.all().map(async (account) => {
      const interval = SUCCESS_INTERVAL_MS[account.provider];
      if (interval === undefined) return;
      const prev = lastAttempt.get(account.id);
      if (prev && now - prev.at < (prev.ok ? interval : FAILURE_BACKOFF_MS)) return;
      lastAttempt.set(account.id, { at: now, ok: false });

      try {
        let windows: Awaited<ReturnType<typeof fetchClaudeUsage>> = [];
        if (account.provider === 'claude' && account.authMode === 'oauth-token' && account.hasSecret) {
          const secret = await accounts.getSecret(account.id);
          if (secret) {
            windows = await fetchClaudeUsage(secret, {
              debug: (info) => log?.(`[usage] ${account.provider}:${account.label} → ${info}`),
            });
          }
        } else if (account.provider === 'codex' && account.homeDir) {
          windows = readCodexUsage(account.homeDir);
        } else if (account.provider === 'copilot' && account.authMode === 'api-key' && account.hasSecret) {
          const secret = await accounts.getSecret(account.id);
          if (secret) windows = await fetchCopilotCredits(secret);
        } else {
          return;
        }

        if (windows.length > 0) {
          lastAttempt.set(account.id, { at: now, ok: true });
          quota.setUsage(account.id, windows);
          log?.(
            `[usage] ${account.provider}:${account.label} → ${windows
              .map((w) => `${w.utilizationPct}% ${w.label}`)
              .join(', ')}`,
          );
        } else {
          log?.(`[usage] ${account.provider}:${account.label} → no data (will retry)`);
        }
      } catch (e) {
        log?.(`[usage] ${account.provider}:${account.label} → error: ${(e as Error).message}`);
      }
    }),
  );
}
