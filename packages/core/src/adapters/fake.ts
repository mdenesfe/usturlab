import type { LoginFlow, ProviderAdapter, RunRequest } from './adapter.js';
import type { AdapterEvent, ProviderId, ResolvedAccount } from '../types.js';

/**
 * Scripted adapter for tests and the debug mode: plays back queued event
 * scripts per account id, one script per run() call.
 */
export class FakeAdapter implements ProviderAdapter {
  readonly displayName = 'Fake';
  readonly models = [{ id: 'fake-1', label: 'Fake 1' }];
  readonly supportsNativeResume = true;

  private scripts = new Map<string, AdapterEvent[][]>();
  readonly runs: Array<{
    accountId: string;
    prompt: string;
    coldPrompt?: string;
    model?: string;
    effort?: string;
    resumeSessionId?: string;
    systemBrief?: string;
    restateBrief?: boolean;
  }> = [];

  constructor(readonly id: ProviderId = 'claude') {}

  script(accountId: string, events: AdapterEvent[]): void {
    const queue = this.scripts.get(accountId) ?? [];
    queue.push(events);
    this.scripts.set(accountId, queue);
  }

  buildEnv(_account: ResolvedAccount, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return { ...base };
  }

  async *run(
    req: RunRequest,
    account: ResolvedAccount,
    _signal: AbortSignal,
  ): AsyncGenerator<AdapterEvent> {
    this.runs.push({
      accountId: account.id,
      prompt: req.prompt,
      coldPrompt: req.coldPrompt,
      model: req.model,
      effort: req.effort,
      resumeSessionId: req.resumeSessionId,
      systemBrief: req.systemBrief,
      restateBrief: req.restateBrief,
    });
    const queue = this.scripts.get(account.id);
    const events = queue?.shift();
    if (!events) {
      yield { type: 'result', text: `fake:${account.id}: no script queued` };
      return;
    }
    for (const ev of events) {
      yield ev;
    }
  }

  interactiveCommand(_account: ResolvedAccount) {
    return { command: ['echo', 'fake adapter'], env: {} };
  }

  loginFlow(_profileDir: string): LoginFlow {
    return {
      terminalCommand: ['echo', 'fake login'],
      env: {},
      watch: { kind: 'poll', check: async () => true },
      instructions: 'Fake login.',
      verify: async () => true,
    };
  }
}
