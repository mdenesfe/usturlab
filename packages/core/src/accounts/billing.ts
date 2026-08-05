import type { AuthMode } from '../types.js';

/**
 * Whether a dollar figure from this account is money.
 *
 * Claude Code reports `total_cost_usd` on every run regardless of how the run
 * was paid for, and it is always the API list price of the tokens. On an API
 * key that is the bill. On a subscription — which is what this whole extension
 * exists to orchestrate — nothing was charged for the run at all: the number is
 * what it *would* have cost, which is worth showing and dishonest to show
 * unlabelled.
 *
 * The judgement is on how the CLI was authenticated, not on what the provider
 * says afterwards, because that is the thing usturlab set up itself and can be
 * sure of.
 */
export function isMetered(account: { authMode: AuthMode }): boolean {
  return account.authMode === 'api-key';
}

/** How to write a cost that came from this kind of account. */
export function formatCost(costUsd: number | undefined, metered: boolean | undefined): string {
  if (costUsd === undefined) return '—';
  // Sub-cent runs are the common case on cheap models; two decimals would round
  // every one of them to nothing and make the column look broken.
  const amount = costUsd < 0.01 && costUsd > 0 ? costUsd.toFixed(3) : costUsd.toFixed(2);
  return metered ? `$${amount}` : `~$${amount}`;
}
