import type { RulesFile } from '../rules/schema.js';
import { builtinDefaultChain } from '../rules/defaults.js';
import { matchesRule, parseMention } from './matcher.js';
import type { QuotaTracker } from '../quota/quotaTracker.js';
import type { AccountProfile, RoutingDecision, Target, TaskRequest } from '../types.js';
import { targetKey } from '../types.js';

export interface RouteResult {
  decision: RoutingDecision;
  /** Prompt with any @mention stripped. */
  cleanedPrompt: string;
}

export function resolveTargetAccount(
  target: Target,
  accounts: AccountProfile[],
): AccountProfile | undefined {
  return accounts.find(
    (a) => a.provider === target.provider && (a.label === target.account || a.id === target.account),
  );
}

export function route(
  task: TaskRequest,
  rules: RulesFile,
  accounts: AccountProfile[],
  quota: QuotaTracker,
): RouteResult {
  const { mention, cleaned } = parseMention(task.prompt);
  const defaultChain = rules.defaultChain.length > 0 ? rules.defaultChain : builtinDefaultChain(accounts);

  let raw: Target[];
  let ruleId: string | undefined;
  let reason: string;

  if (mention) {
    const mentionTargets: Target[] = [];
    if (mention.account) {
      mentionTargets.push({ provider: mention.provider, account: mention.account, model: mention.model });
    } else {
      const candidates = accounts
        .filter((a) => a.provider === mention.provider && !a.disabled)
        .sort((a, b) => a.priority - b.priority);
      for (const c of candidates) {
        mentionTargets.push({ provider: c.provider, account: c.label, model: mention.model });
      }
    }
    raw = [...mentionTargets, ...defaultChain];
    reason = `@${mention.provider}${mention.account ? ':' + mention.account : ''} mention`;
  } else {
    const matchTask = { ...task, prompt: cleaned };
    const rule = rules.rules.find((r) => matchesRule(r, matchTask));
    if (rule) {
      raw = [...rule.target, ...defaultChain];
      ruleId = rule.id;
      reason = rule.description ?? `rule: ${rule.id}`;
    } else {
      raw = defaultChain;
      reason = rules.defaultChain.length > 0 ? 'default chain' : 'priority order';
    }
  }

  const seen = new Set<string>();
  const chain: Target[] = [];
  const skipped: RoutingDecision['skipped'] = [];

  for (const target of raw) {
    const key = targetKey(target);
    if (seen.has(key)) continue;
    seen.add(key);

    const account = resolveTargetAccount(target, accounts);
    if (!account) {
      skipped.push({ target, reason: `no account "${target.account}" for ${target.provider}` });
      continue;
    }
    if (account.disabled) {
      skipped.push({ target, reason: 'account disabled' });
      continue;
    }
    const avail = quota.availability(account.id);
    if (!avail.available) {
      const until = avail.resetAt ? ` until ${new Date(avail.resetAt).toLocaleTimeString()}` : '';
      skipped.push({ target, reason: `on cooldown${until}` });
      continue;
    }
    chain.push(target);
  }

  return { decision: { chain, ruleId, reason, skipped }, cleanedPrompt: cleaned };
}
