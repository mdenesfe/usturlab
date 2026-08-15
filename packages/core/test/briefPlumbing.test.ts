import { describe, expect, it } from 'vitest';
import { AdapterRegistry } from '../src/adapters/adapter.js';
import { FakeAdapter } from '../src/adapters/fake.js';
import { Orchestrator, type OrchestratorDeps } from '../src/orchestrator/orchestrator.js';
import { QuotaTracker } from '../src/quota/quotaTracker.js';
import { SessionStore } from '../src/session/sessionStore.js';
import type { RulesFile } from '../src/rules/schema.js';
import type { AccountProfile, RunEvent, TaskRequest } from '../src/types.js';

/**
 * The seam between the host, which knows the workspace, and the adapter,
 * which talks to the CLI. Everything else in the intelligence layer is
 * worthless if the brief does not survive this trip.
 */

const accounts: AccountProfile[] = [
  { id: 'claude-a', provider: 'claude', label: 'a', authMode: 'oauth-token', hasSecret: true, priority: 1 },
];

const rules: RulesFile = {
  version: 1,
  rules: [],
  defaultChain: [{ provider: 'claude', account: 'a' }],
};

function setup(fake: FakeAdapter, extra: Partial<OrchestratorDeps> = {}) {
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
    ...extra,
  });
  return { orchestrator, sessions };
}

const task = (over: Partial<TaskRequest> = {}): TaskRequest => ({
  conversationId: 'conv1',
  prompt: 'rename this variable',
  cwd: '/tmp',
  permissionMode: 'edits',
  ...over,
});

async function drain(gen: AsyncGenerator<RunEvent>): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

describe('brief plumbing', () => {
  it('puts the workspace brief in the prompt and the standing brief in its own channel', async () => {
    const fake = new FakeAdapter('claude');
    fake.script('claude-a', [{ type: 'result', text: 'ok' }]);
    const { orchestrator } = setup(fake, {
      getBrief: () => [
        { id: 'editor', title: 'Where the user is', body: 'Open in the editor: src/a.ts' },
      ],
      getProviderBrief: () => ({ text: '- Read a file before you edit it.', lineIds: ['read-first'] }),
    });

    await drain(orchestrator.run(task(), new AbortController().signal));

    const run = fake.runs[0]!;
    expect(run.prompt).toContain('Open in the editor: src/a.ts');
    expect(run.prompt).toContain('rename this variable');
    // Standing instructions must NOT be duplicated into the message.
    expect(run.prompt).not.toContain('Read a file before you edit it');
    expect(run.systemBrief).toBe('- Read a file before you edit it.');
  });

  it('builds the brief for the run that will happen, not the one requested', async () => {
    const fake = new FakeAdapter('claude');
    fake.script('claude-a', [{ type: 'result', text: 'ok' }]);
    const seen: string[] = [];
    const { orchestrator } = setup(fake, {
      getBrief: (t) => {
        seen.push(t.permissionMode);
        return [];
      },
    });

    // A heavy edit the router downgrades to planning: the brief must be told
    // it is planning, or it would frame work that is not allowed to happen.
    await drain(
      orchestrator.run(
        task({
          prompt:
            'redesign the whole authentication architecture across the codebase and migrate every caller',
        }),
        new AbortController().signal,
      ),
    );
    expect(seen).toEqual(['safe']);
  });

  it('announces the brief lines a run carried, so outcomes can be attributed', async () => {
    const fake = new FakeAdapter('claude');
    fake.script('claude-a', [{ type: 'result', text: 'ok' }]);
    const { orchestrator } = setup(fake, {
      getProviderBrief: () => ({ text: '- one\n- two', lineIds: ['a', 'b'] }),
    });

    const events = await drain(orchestrator.run(task(), new AbortController().signal));
    const brief = events.find((e) => e.type === 'brief');
    expect(brief).toMatchObject({ lineIds: ['a', 'b'] });
  });

  it('restates the brief to a resumed session only when it changed', async () => {
    const fake = new FakeAdapter('claude');
    let text = '- one';
    for (let i = 0; i < 3; i++) fake.script('claude-a', [
      { type: 'session', sessionId: 'sess-1' },
      { type: 'result', text: 'ok' },
    ]);
    const { orchestrator } = setup(fake, {
      getProviderBrief: () => ({ text, lineIds: ['a'] }),
    });
    const signal = new AbortController().signal;

    await drain(orchestrator.run(task(), signal));
    expect(fake.runs[0]!.restateBrief, 'a new session must hear it').toBe(true);

    await drain(orchestrator.run(task(), signal));
    expect(fake.runs[1]!.restateBrief, 'unchanged brief must not be repeated').toBe(false);

    text = '- one\n- two';
    await drain(orchestrator.run(task(), signal));
    expect(fake.runs[2]!.restateBrief, 'a changed brief must be restated').toBe(true);
  });

  it('sends nothing when the host supplies nothing', async () => {
    const fake = new FakeAdapter('claude');
    fake.script('claude-a', [{ type: 'result', text: 'ok' }]);
    const { orchestrator } = setup(fake);

    const events = await drain(orchestrator.run(task(), new AbortController().signal));
    expect(fake.runs[0]!.prompt).toBe('rename this variable');
    expect(fake.runs[0]!.systemBrief).toBeUndefined();
    expect(events.some((e) => e.type === 'brief')).toBe(false);
  });

  it('keeps the brief on the failover target too', async () => {
    const twoAccounts: AccountProfile[] = [
      ...accounts,
      { id: 'claude-b', provider: 'claude', label: 'b', authMode: 'oauth-token', hasSecret: true, priority: 2 },
    ];
    const fake = new FakeAdapter('claude');
    fake.script('claude-a', [{ type: 'error', message: 'model not supported', retryable: false }]);
    fake.script('claude-b', [{ type: 'result', text: 'ok' }]);
    const registry = new AdapterRegistry();
    registry.register(fake);
    const orchestrator = new Orchestrator({
      adapters: registry,
      quota: new QuotaTracker(),
      sessions: new SessionStore(),
      getRules: () => ({
        version: 1,
        rules: [],
        defaultChain: [
          { provider: 'claude', account: 'a' },
          { provider: 'claude', account: 'b' },
        ],
      }),
      getAccounts: () => twoAccounts,
      resolveAccount: async (t) => twoAccounts.find((a) => a.provider === t.provider && a.label === t.account),
      getProviderBrief: () => ({ text: '- always', lineIds: ['x'] }),
      getBrief: () => [{ id: 'repo', title: 'Repository state', body: 'Branch: main' }],
    });

    await drain(orchestrator.run(task(), new AbortController().signal));
    const second = fake.runs.find((r) => r.accountId === 'claude-b')!;
    expect(second.systemBrief).toBe('- always');
    expect(second.prompt).toContain('Branch: main');
  });

  it('gives each provider its own brief', async () => {
    const claude = new FakeAdapter('claude');
    const codex = new FakeAdapter('codex');
    claude.script('claude-a', [{ type: 'error', message: 'nope', retryable: false }]);
    codex.script('codex-a', [{ type: 'result', text: 'ok' }]);
    const registry = new AdapterRegistry();
    registry.register(claude);
    registry.register(codex);
    const both: AccountProfile[] = [
      ...accounts,
      { id: 'codex-a', provider: 'codex', label: 'a', authMode: 'managed-home', hasSecret: false, priority: 2 },
    ];
    const orchestrator = new Orchestrator({
      adapters: registry,
      quota: new QuotaTracker(),
      sessions: new SessionStore(),
      getRules: () => ({
        version: 1,
        rules: [],
        defaultChain: [
          { provider: 'claude', account: 'a' },
          { provider: 'codex', account: 'a' },
        ],
      }),
      getAccounts: () => both,
      resolveAccount: async (t) => both.find((a) => a.provider === t.provider && a.label === t.account),
      getProviderBrief: (provider) => ({ text: `brief for ${provider}`, lineIds: [provider] }),
    });

    await drain(orchestrator.run(task(), new AbortController().signal));
    expect(claude.runs[0]!.systemBrief).toBe('brief for claude');
    expect(codex.runs[0]!.systemBrief).toBe('brief for codex');
  });
});
