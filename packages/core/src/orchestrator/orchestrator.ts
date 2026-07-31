import type { AdapterRegistry } from '../adapters/adapter.js';
import type { QuotaTracker } from '../quota/quotaTracker.js';
import {
  SessionStore,
  embedHistory,
  handoffPrompt,
  resumeInterruptedPrompt,
} from '../session/sessionStore.js';
import { route } from '../router/router.js';
import type { ConversationContext } from '../router/autoRoute.js';
import type { TaskMetric } from '../quota/metricsSchema.js';
import { expandSlashCommand, matchSlashCommand, type SlashCommand } from '../commands/slashCommands.js';
import type { LiveRunHandle } from '../adapters/adapter.js';
import type { RulesFile } from '../rules/schema.js';
import type {
  AccountProfile,
  AdapterEvent,
  ResolvedAccount,
  RunEvent,
  Target,
  TaskRequest,
} from '../types.js';
import { formatTarget, targetKey } from '../types.js';

/** Transient failures get a second and third chance on the same account. */
const RETRY_BACKOFF_MS = [1_000, 4_000];

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export interface OrchestratorDeps {
  adapters: AdapterRegistry;
  quota: QuotaTracker;
  sessions: SessionStore;
  getRules: () => RulesFile;
  getAccounts: () => AccountProfile[];
  /** Injects secrets from the host secret store. */
  resolveAccount: (target: Target) => Promise<ResolvedAccount | undefined>;
  /** User-defined slash commands (.usturlab/commands.json). */
  getCustomCommands?: () => SlashCommand[];
  /** 'auto' lets the router classify and choose; 'manual' follows the chain as written. */
  getRoutingMode?: () => 'auto' | 'manual';
  /** Past runs — calibrate capability and estimate burn. */
  getMetrics?: () => TaskMetric[];
  /** Where this conversation has run so far. */
  getConversationContext?: (conversationId: string) => ConversationContext | undefined;
  /** Plan heavy code-writing work before it edits. */
  getAutoPlan?: () => boolean;
  /** Backoff between same-account retries; one entry per retry. */
  retryBackoffMs?: number[];
}

export class Orchestrator {
  constructor(private deps: OrchestratorDeps) {}

  async *run(
    task: TaskRequest,
    signal: AbortSignal,
    handle?: LiveRunHandle,
  ): AsyncGenerator<RunEvent> {
    const { adapters, quota, sessions } = this.deps;
    const { decision, cleanedPrompt } = route(
      task,
      this.deps.getRules(),
      this.deps.getAccounts(),
      quota,
      {
        mode: task.routingMode ?? this.deps.getRoutingMode?.() ?? 'auto',
        metrics: this.deps.getMetrics?.(),
        conversation: this.deps.getConversationContext?.(task.conversationId),
        autoPlan: this.deps.getAutoPlan?.() ?? true,
      },
    );
    yield { type: 'routing', decision };

    if (decision.chain.length === 0) {
      yield { type: 'chain-exhausted', tried: [] };
      return;
    }

    // The router may ask for heavy code-writing work to be planned first.
    const effectivePermission = decision.suggestPermission ?? task.permissionMode;

    const tried: Target[] = [];
    const history = sessions.getHistory(task.conversationId);
    // What a cut-off attempt already produced, so the next one continues it.
    let interrupted: { target: Target; partial: string } | undefined;
    // Slash prompts pass through raw to Claude (it runs its native command);
    // every other provider gets the equivalent plain-English template.
    const slash = matchSlashCommand(cleanedPrompt, this.deps.getCustomCommands?.() ?? []);

    for (let i = 0; i < decision.chain.length; i++) {
      if (signal.aborted) return;
      const target = decision.chain[i]!;
      const nextTarget = decision.chain[i + 1];

      const adapter = adapters.get(target.provider);
      if (!adapter) continue;
      const account = await this.deps.resolveAccount(target);
      if (!account) continue;
      if (!quota.availability(account.id).available) continue;

      tried.push(target);
      let attempt = 0;
      let retries = 0;

      target: while (true) {
        attempt++;
        yield { type: 'attempt', target, attempt };

        const nativeSid = adapter.supportsNativeResume
          ? sessions.getNativeSession(task.conversationId, target, task.cwd)
          : undefined;
        const slashPrompt =
          slash && slash.cmd.kind === 'prompt' && !(target.provider === 'claude' && slash.cmd.claudeNative)
            ? expandSlashCommand(slash.cmd, slash.args)
            : cleanedPrompt;
        // A cut-off attempt is handed over rather than thrown away. Resuming the
        // same native session already has the text, so it only needs the nudge.
        let basePrompt = slashPrompt;
        if (interrupted) {
          basePrompt =
            nativeSid && targetKey(interrupted.target) === targetKey(target)
              ? resumeInterruptedPrompt(slashPrompt)
              : handoffPrompt(slashPrompt, interrupted.partial, formatTarget(interrupted.target));
        }
        const prompt =
          adapter.supportsNativeResume && (nativeSid || history.length === 0)
            ? basePrompt
            : embedHistory(history, basePrompt);

        let limitEvent: (AdapterEvent & { type: 'limit' }) | undefined;
        let errorEvent: (AdapterEvent & { type: 'error' }) | undefined;
        let firstResultRecorded = false;
        let gotResult = false;
        let partial = '';

        for await (const ev of adapter.run(
          {
            prompt,
            cwd: task.cwd,
            model: target.model,
            resumeSessionId: nativeSid,
            permissionMode: effectivePermission,
            handle,
          },
          account,
          signal,
        )) {
          if (signal.aborted) return;
          if (ev.type === 'session') {
            sessions.setNativeSession(task.conversationId, target, task.cwd, ev.sessionId);
            yield ev;
          } else if (ev.type === 'limit') {
            limitEvent = ev;
            break;
          } else if (ev.type === 'error') {
            errorEvent = ev;
            break;
          } else if (ev.type === 'result') {
            // Injection-capable adapters may answer several turns per run;
            // keep consuming — the host tracks per-turn transcript state.
            gotResult = true;
            if (!firstResultRecorded) {
              firstResultRecorded = true;
              sessions.appendTurn(task.conversationId, { role: 'user', text: cleanedPrompt });
              sessions.appendTurn(task.conversationId, { role: 'assistant', text: ev.text });
            }
            yield ev;
          } else {
            if (ev.type === 'text-delta') partial += ev.text;
            yield ev;
          }
        }
        if (gotResult) {
          // A later injected turn may still hit a limit/error — surface it,
          // but the run already produced answers so no failover.
          if (limitEvent) {
            quota.markLimitHit(account.id, {
              resetAt: limitEvent.resetAt,
              scope: limitEvent.scope,
              provider: target.provider,
            });
            yield limitEvent;
          } else if (errorEvent) {
            yield errorEvent;
          }
          return;
        }

        // Whatever the attempt managed to say is the starting point for the next one.
        if (partial.trim()) interrupted = { target, partial };

        if (limitEvent) {
          quota.markLimitHit(account.id, {
            resetAt: limitEvent.resetAt,
            scope: limitEvent.scope,
            provider: target.provider,
          });
          if (nextTarget) {
            yield {
              type: 'failover',
              from: target,
              to: nextTarget,
              reason: `${formatTarget(target)} hit its usage limit`,
              resetAt: limitEvent.resetAt,
            };
          } else {
            yield limitEvent;
          }
          break target;
        }

        if (errorEvent) {
          // A dropped stream or an overloaded upstream says nothing about this
          // account — retry it here instead of spending another provider's quota.
          const backoff = this.deps.retryBackoffMs ?? RETRY_BACKOFF_MS;
          if (errorEvent.retryable && retries < backoff.length) {
            retries++;
            await delay(backoff[retries - 1] ?? 0, signal);
            if (signal.aborted) return;
            continue target;
          }
          if (nextTarget) {
            yield {
              type: 'failover',
              from: target,
              to: nextTarget,
              reason: errorEvent.message,
            };
          } else {
            yield errorEvent;
          }
          break target;
        }

        // Stream ended without result/limit/error (e.g. aborted child).
        break target;
      }
    }

    yield { type: 'chain-exhausted', tried };
  }
}
