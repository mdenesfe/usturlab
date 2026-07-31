import { describe, expect, it } from 'vitest';
import { AdapterRegistry } from '../src/adapters/adapter.js';
import { FakeAdapter } from '../src/adapters/fake.js';
import { isTransientFailure } from '../src/adapters/limits.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { QuotaTracker } from '../src/quota/quotaTracker.js';
import { SessionStore, handoffPrompt } from '../src/session/sessionStore.js';
import { measurePerformance } from '../src/router/learning.js';
import type { TaskMetric } from '../src/quota/metricsSchema.js';
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

function setup(fake: FakeAdapter) {
  const registry = new AdapterRegistry();
  registry.register(fake);
  const sessions = new SessionStore();
  const orchestrator = new Orchestrator({
    adapters: registry,
    quota: new QuotaTracker(),
    sessions,
    getRules: () => rules,
    getAccounts: () => accounts,
    resolveAccount: async (t) => accounts.find((a) => a.provider === t.provider && a.label === t.account),
    retryBackoffMs: [0, 0],
  });
  return { orchestrator, sessions };
}

const task: TaskRequest = {
  conversationId: 'conv1',
  prompt: 'devam et',
  cwd: '/tmp',
  permissionMode: 'safe',
};

async function collect(gen: AsyncGenerator<RunEvent>): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

/** The exact message the Claude CLI emits when its stream is cut. */
const DROPPED = 'API Error: Connection closed mid-response. The response above may be incomplete.';

describe('transient failure classification', () => {
  it('recognizes a dropped stream as worth retrying', () => {
    expect(isTransientFailure(DROPPED)).toBe(true);
    for (const m of [
      'socket hang up',
      'fetch failed',
      'Error: read ECONNRESET',
      '503 Service Unavailable',
      'upstream overloaded_error',
      'request timed out',
    ]) {
      expect(isTransientFailure(m)).toBe(true);
    }
  });

  it('does not treat a real refusal or bad request as retryable', () => {
    for (const m of [
      'model not supported',
      'claude reported an error',
      'agent refused the request',
      'invalid api key',
    ]) {
      expect(isTransientFailure(m)).toBe(false);
    }
  });
});

describe('interrupted runs', () => {
  it('retries the same account on a dropped stream instead of burning the next one', async () => {
    const fake = new FakeAdapter('claude');
    fake.script('claude-a', [
      { type: 'text-delta', text: 'Tamam, Phase 2 için ' },
      { type: 'error', message: DROPPED, retryable: true },
    ]);
    fake.script('claude-a', [{ type: 'result', text: 'finished on the retry' }]);
    const { orchestrator } = setup(fake);
    const events = await collect(orchestrator.run(task, new AbortController().signal));

    expect(events.filter((e) => e.type === 'attempt')).toHaveLength(2);
    expect(events.some((e) => e.type === 'failover')).toBe(false);
    expect(fake.runs.map((r) => r.accountId)).toEqual(['claude-a', 'claude-a']);
    expect(events.at(-1)).toMatchObject({ type: 'result', text: 'finished on the retry' });
  });

  it('gives up on the account after the retry budget and fails over', async () => {
    const fake = new FakeAdapter('claude');
    for (let i = 0; i < 3; i++) {
      fake.script('claude-a', [{ type: 'error', message: DROPPED, retryable: true }]);
    }
    fake.script('claude-b', [{ type: 'result', text: 'answer from b' }]);
    const { orchestrator } = setup(fake);
    const events = await collect(orchestrator.run(task, new AbortController().signal));

    expect(fake.runs.filter((r) => r.accountId === 'claude-a')).toHaveLength(3);
    expect(events.some((e) => e.type === 'failover')).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'result', text: 'answer from b' });
  });

  it('hands the cut-off text to the account that takes over', async () => {
    const fake = new FakeAdapter('claude');
    fake.script('claude-a', [
      { type: 'text-delta', text: 'Tamam, Phase 2: RulesBuilder yazıyorum. İlk MatchConditionEditor:' },
      { type: 'error', message: 'claude reported an error', retryable: false },
    ]);
    fake.script('claude-b', [{ type: 'result', text: 'continued' }]);
    const { orchestrator } = setup(fake);
    await collect(orchestrator.run(task, new AbortController().signal));

    const handoff = fake.runs.find((r) => r.accountId === 'claude-b')!.prompt;
    expect(handoff).toContain('MatchConditionEditor');
    expect(handoff).toContain('cut off mid-answer');
    expect(handoff).toContain('Do not ask where to resume');
    expect(handoff).toContain('devam et');
  });

  it('does not re-embed the text when the same session is resumed', async () => {
    const fake = new FakeAdapter('claude');
    fake.script('claude-a', [
      { type: 'session', sessionId: 'sess-1' },
      { type: 'text-delta', text: 'half an answer' },
      { type: 'error', message: DROPPED, retryable: true },
    ]);
    fake.script('claude-a', [{ type: 'result', text: 'done' }]);
    const { orchestrator } = setup(fake);
    await collect(orchestrator.run(task, new AbortController().signal));

    const second = fake.runs[1]!;
    expect(second.resumeSessionId).toBe('sess-1');
    expect(second.prompt).toContain('cut off by a connection error');
    expect(second.prompt).not.toContain('half an answer');
  });

  it('leaves a normal first attempt untouched', async () => {
    const fake = new FakeAdapter('claude');
    fake.script('claude-a', [{ type: 'result', text: 'ok' }]);
    const { orchestrator } = setup(fake);
    await collect(orchestrator.run(task, new AbortController().signal));
    expect(fake.runs[0]!.prompt).toBe('devam et');
  });
});

describe('handoff prompt', () => {
  it('keeps the tail when the partial answer is long', () => {
    const partial = 'x'.repeat(9000) + 'THE-LAST-THING';
    const out = handoffPrompt('carry on', partial, 'claude:a');
    expect(out).toContain('THE-LAST-THING');
    expect(out).toContain('truncated');
    expect(out.length).toBeLessThan(partial.length + 1500);
  });

  it('passes the prompt through when nothing was produced', () => {
    expect(handoffPrompt('carry on', '   ', 'claude:a')).toBe('carry on');
  });
});

describe('capability measurement ignores infrastructure', () => {
  it('does not punish an account for a dropped connection', () => {
    const base: Omit<TaskMetric, 'id' | 'status'> = {
      timestamp: 1,
      conversationId: 'c',
      provider: 'claude',
      account: 'a',
      kind: 'edit',
    };
    const metrics: TaskMetric[] = [
      { ...base, id: '1', status: 'success' },
      { ...base, id: '2', status: 'success' },
      { ...base, id: '3', status: 'success' },
      { ...base, id: '4', status: 'failover', transient: true },
      { ...base, id: '5', status: 'failover', transient: true },
    ];
    const perf = measurePerformance(metrics, 'claude', 'edit');
    expect(perf.runs).toBe(3);
    expect(perf.cleanRate).toBe(1);
  });

  it('still counts a genuine failure against it', () => {
    const base: Omit<TaskMetric, 'id' | 'status'> = {
      timestamp: 1,
      conversationId: 'c',
      provider: 'claude',
      account: 'a',
      kind: 'edit',
    };
    const perf = measurePerformance(
      [
        { ...base, id: '1', status: 'success' },
        { ...base, id: '2', status: 'error' },
      ],
      'claude',
      'edit',
    );
    expect(perf.runs).toBe(2);
    expect(perf.cleanRate).toBe(0.5);
  });
});
