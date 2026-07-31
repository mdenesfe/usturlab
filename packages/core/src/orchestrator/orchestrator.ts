import type { AdapterRegistry } from '../adapters/adapter.js';
import type { QuotaTracker } from '../quota/quotaTracker.js';
import { SessionStore, embedHistory } from '../session/sessionStore.js';
import { route } from '../router/router.js';
import { expandSlashCommand, matchSlashCommand, type SlashCommand } from '../commands/slashCommands.js';
import type { RulesFile } from '../rules/schema.js';
import type {
  AccountProfile,
  AdapterEvent,
  ResolvedAccount,
  RunEvent,
  Target,
  TaskRequest,
} from '../types.js';
import { formatTarget } from '../types.js';

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
}

export class Orchestrator {
  constructor(private deps: OrchestratorDeps) {}

  async *run(task: TaskRequest, signal: AbortSignal): AsyncGenerator<RunEvent> {
    const { adapters, quota, sessions } = this.deps;
    const { decision, cleanedPrompt } = route(
      task,
      this.deps.getRules(),
      this.deps.getAccounts(),
      quota,
    );
    yield { type: 'routing', decision };

    if (decision.chain.length === 0) {
      yield { type: 'chain-exhausted', tried: [] };
      return;
    }

    const tried: Target[] = [];
    const history = sessions.getHistory(task.conversationId);
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
      let retried = false;

      target: while (true) {
        attempt++;
        yield { type: 'attempt', target, attempt };

        const nativeSid = adapter.supportsNativeResume
          ? sessions.getNativeSession(task.conversationId, target, task.cwd)
          : undefined;
        const basePrompt =
          slash && slash.cmd.kind === 'prompt' && !(target.provider === 'claude' && slash.cmd.claudeNative)
            ? expandSlashCommand(slash.cmd, slash.args)
            : cleanedPrompt;
        const prompt =
          adapter.supportsNativeResume && (nativeSid || history.length === 0)
            ? basePrompt
            : embedHistory(history, basePrompt);

        let limitEvent: (AdapterEvent & { type: 'limit' }) | undefined;
        let errorEvent: (AdapterEvent & { type: 'error' }) | undefined;

        for await (const ev of adapter.run(
          {
            prompt,
            cwd: task.cwd,
            model: target.model,
            resumeSessionId: nativeSid,
            permissionMode: task.permissionMode,
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
            sessions.appendTurn(task.conversationId, { role: 'user', text: cleanedPrompt });
            sessions.appendTurn(task.conversationId, { role: 'assistant', text: ev.text });
            yield ev;
            return;
          } else {
            yield ev;
          }
        }

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
          if (errorEvent.retryable && !retried) {
            retried = true;
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
