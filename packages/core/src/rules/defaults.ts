import type { AccountProfile, Target } from '../types.js';
import { isReviewOnly } from '../types.js';

/** Priority-ordered chain over all enabled accounts, used when the rules file has no defaultChain. */
export function builtinDefaultChain(accounts: AccountProfile[]): Target[] {
  return accounts
    .filter((a) => !a.disabled && !isReviewOnly(a.provider))
    .sort((a, b) => a.priority - b.priority)
    .map((a) => ({ provider: a.provider, account: a.label }));
}
