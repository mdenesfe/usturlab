import type { RulesFile } from '../rules/schema.js';
import { builtinDefaultChain } from '../rules/defaults.js';
import { matchesRule, parseMention } from './matcher.js';
import { classifyTask, isContinuation, type Classification } from './classify.js';
import { autoRoute, type ConversationContext } from './autoRoute.js';
import type { TaskMetric } from '../quota/metricsSchema.js';
import type { QuotaTracker } from '../quota/quotaTracker.js';
import type { AccountProfile, RoutingDecision, Target, TaskRequest } from '../types.js';
import { targetKey } from '../types.js';

export interface RouteResult {
  decision: RoutingDecision;
  /** Prompt with any @mention stripped. */
  cleanedPrompt: string;
}

export interface RouteOptions {
  /** 'auto': classify the task and pick a model; 'manual': follow the default chain as written. */
  mode?: 'auto' | 'manual';
  /** Past runs, used to calibrate capability and estimate burn. */
  metrics?: TaskMetric[];
  /** Where this conversation has been running so far. */
  conversation?: ConversationContext;
  /** Plan heavy code-writing work before it edits. */
  autoPlan?: boolean;
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
  options: RouteOptions = {},
): RouteResult {
  const mode = options.mode ?? 'auto';
  const { mention, cleaned } = parseMention(task.prompt);
  const defaultChain =
    rules.defaultChain.length > 0 ? rules.defaultChain : builtinDefaultChain(accounts);

  let raw: Target[];
  let ruleId: string | undefined;
  let reason: string;
  let classification: Classification | undefined;
  let escalated: { from: string; to: string } | undefined;
  let suggestPermission: RoutingDecision['suggestPermission'];
  let estimatedBurnPct: number | undefined;

  if (mention) {
    const mentionTargets: Target[] = [];
    if (mention.account) {
      mentionTargets.push({
        provider: mention.provider,
        account: mention.account,
        model: mention.model,
      });
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
    // User rules stay primary — they always win over automatic choice.
    const rule = rules.rules.find((r) => matchesRule(r, matchTask));
    if (rule) {
      raw = [...rule.target, ...defaultChain];
      ruleId = rule.id;
      reason = rule.description ?? `rule: ${rule.id}`;
    } else if (mode === 'auto') {
      classification = classifyTask(matchTask);
      // A bare "yes, go ahead" carries the thread's weight, not its own.
      if (isContinuation(cleaned) && options.conversation?.peakComplexity) {
        classification = { ...classification, complexity: options.conversation.peakComplexity };
      }
      const auto = autoRoute(classification, accounts, quota, {
        metrics: options.metrics,
        conversation: options.conversation,
        autoPlan: options.autoPlan,
        currentPermission: task.permissionMode,
      });
      raw = [...auto.chain, ...defaultChain];
      reason = auto.reason;
      escalated = auto.escalated;
      suggestPermission = auto.suggestPermission;
      estimatedBurnPct = auto.burn?.pct;
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

  return {
    decision: {
      chain,
      ruleId,
      reason,
      skipped,
      classification,
      escalated,
      suggestPermission,
      estimatedBurnPct,
    },
    cleanedPrompt: cleaned,
  };
}
