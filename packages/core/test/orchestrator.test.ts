import { describe, expect, it } from 'vitest';
import { AdapterRegistry } from '../src/adapters/adapter.js';
import { FakeAdapter } from '../src/adapters/fake.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { QuotaTracker } from '../src/quota/quotaTracker.js';
import { SessionStore } from '../src/session/sessionStore.js';
import type { RulesFile } from '../src/rules/schema.js';
import type { AccountProfile, RunEvent, TaskRequest } from '../src/types.js';

const accounts: AccountProfile[] = [
  { id: 'claude-a', provider: 'claude', label: 'a', authMode: 'oauth-token', hasSecret: true, priority: 1 },
  { id: 'claude-b', provider: 'claude', label: 'b', authMode: 'oauth-token', hasSecret: true, priority: 2 },
];

const rules: RulesFile = {
  version: 1,
  rules: [],
  defaultChain: [
    { provider: 'claude', account: 'a' },
    { provider: 'claude', account: 'b' },
  ],
};

function setup(fake: FakeAdapter, quota = new QuotaTracker()) {
  const registry = new AdapterRegistry();
  registry.register(fake);
  const sessions = new SessionStore();
  const orchestrator = new Orchestrator({
    adapters: registry,
    quota,
    sessions,
    getRules: () => rules,
    getAccounts: () => accounts,
    resolveAccount: async (t) => accounts.find((a) => a.provider === t.provider && a.label === t.account),
  });
  return { orchestrator, quota, sessions };
}

const task: TaskRequest = {
  conversationId: 'conv1',
  prompt: 'do the thing',
  cwd: '/tmp',
  permissionMode: 'safe',
};

async function collect(gen: AsyncGenerator<RunEvent>): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

describe('orchestrator failover', () => {
  it('fails over to the next target on limit and records cooldown', async () => {
    const fake = new FakeAdapter('claude');
    fake.script('claude-a', [
      { type: 'text-delta', text: 'partial...' },
      { type: 'limit', scope: 'session', resetAt: Date.now() + 3600_000, raw: 'usage limit reached' },
    ]);
    fake.script('claude-b', [
      { type: 'text-delta', text: 'answer' },
      { type: 'result', text: 'answer' },
    ]);
    const { orchestrator, quota } = setup(fake);

    const events = await collect(orchestrator.run(task, new AbortController().signal));
    const kinds = events.map((e) => e.type);
    expect(kinds).toEqual([
      'routing',
      'attempt',
      'text-delta',
      'failover',
      'attempt',
      'text-delta',
      'result',
    ]);

    const failover = events.find((e) => e.type === 'failover') as Extract<RunEvent, { type: 'failover' }>;
    expect(failover.from.account).toBe('a');
    expect(failover.to.account).toBe('b');
    expect(quota.availability('claude-a').available).toBe(false);
    expect(quota.availability('claude-b').available).toBe(true);
  });

  it('re-sends the full original prompt to the next target', async () => {
    const fake = new FakeAdapter('claude');
    fake.script('claude-a', [{ type: 'limit', scope: 'unknown', raw: 'limit' }]);
    fake.script('claude-b', [{ type: 'result', text: 'ok' }]);
    const { orchestrator } = setup(fake);

    await collect(orchestrator.run(task, new AbortController().signal));
    expect(fake.runs).toHaveLength(2);
    expect(fake.runs[1]!.prompt).toContain('do the thing');
  });

  it('emits chain-exhausted when every target is limited', async () => {
    const fake = new FakeAdapter('claude');
    fake.script('claude-a', [{ type: 'limit', scope: 'unknown', raw: 'limit' }]);
    fake.script('claude-b', [{ type: 'limit', scope: 'unknown', raw: 'limit' }]);
    const { orchestrator } = setup(fake);

    const events = await collect(orchestrator.run(task, new AbortController().signal));
    expect(events.at(-1)?.type).toBe('chain-exhausted');
    const exhausted = events.at(-1) as Extract<RunEvent, { type: 'chain-exhausted' }>;
    expect(exhausted.tried.map((t) => t.account)).toEqual(['a', 'b']);
    // The final target's limit surfaces so the UI can show a reset time.
    expect(events.some((e) => e.type === 'limit')).toBe(true);
  });

  it('skips targets already on cooldown at routing time', async () => {
    const fake = new FakeAdapter('claude');
    fake.script('claude-b', [{ type: 'result', text: 'from b' }]);
    const quota = new QuotaTracker();
    quota.markLimitHit('claude-a', { resetAt: Date.now() + 3600_000 });
    const { orchestrator } = setup(fake, quota);

    const events = await collect(orchestrator.run(task, new AbortController().signal));
    const attempts = events.filter((e) => e.type === 'attempt') as Extract<RunEvent, { type: 'attempt' }>[];
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.target.account).toBe('b');
  });

  it('retries the same target once on a retryable error', async () => {
    const fake = new FakeAdapter('claude');
    fake.script('claude-a', [{ type: 'error', message: 'network blip', retryable: true }]);
    fake.script('claude-a', [{ type: 'result', text: 'recovered' }]);
    const { orchestrator } = setup(fake);

    const events = await collect(orchestrator.run(task, new AbortController().signal));
    const attempts = events.filter((e) => e.type === 'attempt') as Extract<RunEvent, { type: 'attempt' }>[];
    expect(attempts.map((a) => a.attempt)).toEqual([1, 2]);
    expect(events.at(-1)?.type).toBe('result');
  });

  it('advances the chain on a non-retryable error', async () => {
    const fake = new FakeAdapter('claude');
    fake.script('claude-a', [{ type: 'error', message: 'CLI not found', retryable: false }]);
    fake.script('claude-b', [{ type: 'result', text: 'from b' }]);
    const { orchestrator } = setup(fake);

    const events = await collect(orchestrator.run(task, new AbortController().signal));
    expect(events.some((e) => e.type === 'failover')).toBe(true);
    expect(events.at(-1)?.type).toBe('result');
  });

  it('stores turns and native session ids on success', async () => {
    const fake = new FakeAdapter('claude');
    fake.script('claude-a', [
      { type: 'session', sessionId: 'sid-123' },
      { type: 'result', text: 'hi there' },
    ]);
    const { orchestrator, sessions } = setup(fake);

    await collect(orchestrator.run(task, new AbortController().signal));
    expect(sessions.getHistory('conv1')).toHaveLength(2);
    expect(
      sessions.getNativeSession('conv1', { provider: 'claude', account: 'a' }, '/tmp'),
    ).toBe('sid-123');
  });
});
