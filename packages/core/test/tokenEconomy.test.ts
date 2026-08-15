import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdapterRegistry } from '../src/adapters/adapter.js';
import { FakeAdapter } from '../src/adapters/fake.js';
import { Orchestrator, type OrchestratorDeps } from '../src/orchestrator/orchestrator.js';
import { QuotaTracker } from '../src/quota/quotaTracker.js';
import { SessionStore } from '../src/session/sessionStore.js';
import { briefDelta, briefSections, type BriefSection } from '../src/context/brief.js';
import { estimateTokens } from '../src/context/tokens.js';
import { cacheFreshness, stickyBonus, CACHE_TTL_MS } from '../src/router/cacheAffinity.js';
import { autoRoute } from '../src/router/autoRoute.js';
import { classifyTask } from '../src/router/classify.js';
import { serversFor, parseMcpFile, syncMcpToProfile } from '../src/mcp/mcpSync.js';
import { acpUsage } from '../src/adapters/acp.js';
import { calculateStats, type TaskMetric } from '../src/quota/metricsSchema.js';
import type { RulesFile } from '../src/rules/schema.js';
import type { AccountProfile, RunEvent, TaskRequest } from '../src/types.js';

/**
 * What a turn costs the window it runs in.
 *
 * On a subscription nothing is billed, so the currency is the quota window —
 * and every one of these is a place the old code spent it without noticing:
 * a brief re-sent to a session that already had it, a conversation moved off a
 * warm cache for a point of headroom, a trivial edit reasoned at full depth.
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

const section = (id: string, body: string): BriefSection => ({ id, title: id, body });

describe('token estimate', () => {
  it('charges non-latin text more than latin text of the same length', () => {
    const english = 'the quick brown fox jumps over the lazy dog again';
    const turkish = 'çğıöşü çğıöşü çğıöşü çğıöşü çğıöşü çğıöşü çğıöşü';
    expect(turkish.length).toBeCloseTo(english.length, -1);
    expect(estimateTokens(turkish)).toBeGreaterThan(estimateTokens(english));
  });

  it('never returns zero for text that exists', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('x')).toBeGreaterThan(0);
  });
});

describe('brief delta', () => {
  it('says everything the first time', () => {
    const delta = briefDelta(undefined, [section('editor', 'src/a.ts'), section('repo', 'main')]);
    expect(delta.text).toContain('src/a.ts');
    expect(delta.text).toContain('main');
    expect(delta.changed).toEqual(['editor', 'repo']);
  });

  it('says nothing when nothing moved', () => {
    const sections = [section('editor', 'src/a.ts')];
    const first = briefDelta(undefined, sections);
    const second = briefDelta(first.state, sections);
    expect(second.text).toBe('');
    expect(second.changed).toEqual([]);
  });

  it('sends only the section that changed', () => {
    const first = briefDelta(undefined, [section('editor', 'src/a.ts'), section('repo', 'main')]);
    const second = briefDelta(first.state, [section('editor', 'src/b.ts'), section('repo', 'main')]);
    expect(second.text).toContain('src/b.ts');
    expect(second.text).not.toContain('main');
    expect(second.changed).toEqual(['editor']);
  });

  it('names what stopped applying instead of leaving it believed', () => {
    const first = briefDelta(undefined, [section('editor', 'src/a.ts')]);
    const second = briefDelta(first.state, []);
    expect(second.dropped).toEqual(['editor']);
    expect(second.text).toContain('No longer applies');
    expect(second.text).toContain('where the user is');
  });
});

describe('the brief on the wire', () => {
  it('tells a resumed session only what changed since last turn', async () => {
    const fake = new FakeAdapter('claude');
    for (let i = 0; i < 2; i++) {
      fake.script('claude-a', [
        { type: 'session', sessionId: 'sess-1' },
        { type: 'result', text: 'ok' },
      ]);
    }
    let file = 'src/a.ts';
    const { orchestrator } = setup(fake, {
      getBrief: () => [section('editor', `Open in the editor: ${file}`), section('repo', 'Branch: main')],
    });
    const signal = new AbortController().signal;

    await drain(orchestrator.run(task(), signal));
    expect(fake.runs[0]!.prompt).toContain('src/a.ts');
    expect(fake.runs[0]!.prompt).toContain('Branch: main');

    file = 'src/b.ts';
    await drain(orchestrator.run(task(), signal));
    expect(fake.runs[1]!.prompt).toContain('src/b.ts');
    // The branch has not moved, and the session still holds the first copy.
    expect(fake.runs[1]!.prompt).not.toContain('Branch: main');
  });

  it('carries a cold version of the message for a session that turns out to be gone', async () => {
    const fake = new FakeAdapter('claude');
    for (let i = 0; i < 2; i++) {
      fake.script('claude-a', [
        { type: 'session', sessionId: 'sess-1' },
        { type: 'result', text: 'answered' },
      ]);
    }
    const { orchestrator } = setup(fake, {
      getBrief: () => [section('repo', 'Branch: main')],
    });
    const signal = new AbortController().signal;

    await drain(orchestrator.run(task(), signal));
    // Nothing to fall back to on a fresh target: the prompt is already cold.
    expect(fake.runs[0]!.coldPrompt).toBeUndefined();

    await drain(orchestrator.run(task({ prompt: 'and now the other one' }), signal));
    const second = fake.runs[1]!;
    // The resumed message says nothing about the branch — the session has it.
    expect(second.prompt).not.toContain('Branch: main');
    // The cold one says everything, including the conversation it would miss.
    expect(second.coldPrompt).toContain('Branch: main');
    expect(second.coldPrompt).toContain('answered');
  });

  it('starts the brief over when the CLI answers in a different session', async () => {
    const fake = new FakeAdapter('claude');
    fake.script('claude-a', [
      { type: 'session', sessionId: 'sess-1' },
      { type: 'result', text: 'ok' },
    ]);
    // The CLI could not resume and quietly opened a new one.
    fake.script('claude-a', [
      { type: 'session', sessionId: 'sess-2' },
      { type: 'result', text: 'ok' },
    ]);
    fake.script('claude-a', [
      { type: 'session', sessionId: 'sess-2' },
      { type: 'result', text: 'ok' },
    ]);
    const { orchestrator } = setup(fake, {
      getBrief: () => [section('repo', 'Branch: main')],
    });
    const signal = new AbortController().signal;

    await drain(orchestrator.run(task(), signal));
    await drain(orchestrator.run(task(), signal));
    await drain(orchestrator.run(task(), signal));

    // Turn 3 follows a replaced session, so it may not build on turn 2.
    expect(fake.runs[2]!.prompt).toContain('Branch: main');
  });

  it('does not remember a brief the model never got to read', async () => {
    const fake = new FakeAdapter('claude');
    fake.script('claude-a', [
      { type: 'session', sessionId: 'sess-1' },
      { type: 'limit', raw: 'usage limit reached', scope: 'session' },
    ]);
    fake.script('claude-a', [
      { type: 'session', sessionId: 'sess-1' },
      { type: 'result', text: 'ok' },
    ]);
    const { orchestrator } = setup(fake, {
      getBrief: () => [section('repo', 'Branch: main')],
    });

    await drain(orchestrator.run(task(), new AbortController().signal));
    // The limited attempt never produced an answer, so the next run must not
    // assume that session read anything.
    const quota = new QuotaTracker();
    const registry = new AdapterRegistry();
    registry.register(fake);
    const second = new Orchestrator({
      adapters: registry,
      quota,
      sessions: new SessionStore(),
      getRules: () => rules,
      getAccounts: () => accounts,
      resolveAccount: async (t) => accounts.find((a) => a.provider === t.provider && a.label === t.account),
      getBrief: () => [section('repo', 'Branch: main')],
    });
    await drain(second.run(task(), new AbortController().signal));
    expect(fake.runs[1]!.prompt).toContain('Branch: main');
  });

  it('gives a failover target the whole brief, because it has heard none of it', async () => {
    const two: AccountProfile[] = [
      ...accounts,
      { id: 'claude-b', provider: 'claude', label: 'b', authMode: 'oauth-token', hasSecret: true, priority: 2 },
    ];
    const fake = new FakeAdapter('claude');
    fake.script('claude-a', [{ type: 'error', message: 'boom', retryable: false }]);
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
      getAccounts: () => two,
      resolveAccount: async (t) => two.find((a) => a.provider === t.provider && a.label === t.account),
      getBrief: () => [section('repo', 'Branch: main'), section('editor', 'src/a.ts')],
    });

    await drain(orchestrator.run(task(), new AbortController().signal));
    const second = fake.runs.find((r) => r.accountId === 'claude-b')!;
    expect(second.prompt).toContain('Branch: main');
    expect(second.prompt).toContain('src/a.ts');
  });
});

describe('a delta is only trusted so far', () => {
  const target = { provider: 'claude' as const, account: 'a' };
  const state = { editor: 'src/a.ts' };

  it('makes a session hear the whole brief again after enough deltas', () => {
    const sessions = new SessionStore();
    sessions.rememberTaskBrief('c', target, '/tmp', state, { sentFull: true });
    for (let i = 0; i < 8; i++) {
      expect(sessions.taskBriefState('c', target, '/tmp'), `delta ${i}`).toEqual(state);
      sessions.rememberTaskBrief('c', target, '/tmp', state, { sentFull: false });
    }
    // Eight deltas in, the assumption that it still remembers has expired.
    expect(sessions.taskBriefState('c', target, '/tmp')).toBeUndefined();
  });

  it('starts over when the context shrank, because that is compaction', () => {
    const sessions = new SessionStore();
    sessions.rememberTaskBrief('c', target, '/tmp', state, { sentFull: true, contextTokens: 40_000 });
    expect(sessions.taskBriefState('c', target, '/tmp')).toEqual(state);
    sessions.rememberTaskBrief('c', target, '/tmp', state, { sentFull: false, contextTokens: 12_000 });
    expect(sessions.taskBriefState('c', target, '/tmp')).toBeUndefined();
  });

  it('reads ordinary growth as nothing having happened', () => {
    const sessions = new SessionStore();
    sessions.rememberTaskBrief('c', target, '/tmp', state, { sentFull: true, contextTokens: 20_000 });
    sessions.rememberTaskBrief('c', target, '/tmp', state, { sentFull: false, contextTokens: 26_000 });
    expect(sessions.taskBriefState('c', target, '/tmp')).toEqual(state);
  });
});

describe('the diff stops being sent when it stops being context', () => {
  it('hands over the file list instead of a wall of diff', () => {
    const hunk = (path: string) =>
      `--- a/${path}\n+++ b/${path}\n@@ -1,4 +1,4 @@\n` +
      Array.from({ length: 200 }, (_, i) => `+line ${i} of ${path}`).join('\n');
    const diff = [hunk('src/a.ts'), hunk('src/b.ts')].join('\n');

    const sections = briefSections({ provider: 'claude', repo: { diff } });
    const body = sections.find((s) => s.id === 'diff')!.body;
    expect(body).toContain('src/a.ts (+200 −0)');
    expect(body).toContain('src/b.ts');
    expect(body).toContain('git diff');
    expect(body).not.toContain('line 100 of src/a.ts');
  });

  it('still sends a small diff verbatim', () => {
    const diff = '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;';
    const sections = briefSections({ provider: 'claude', repo: { diff } });
    expect(sections.find((s) => s.id === 'diff')!.body).toContain('+const a = 2;');
  });
});

describe('cache affinity', () => {
  it('is whole inside the ttl and gone well past it', () => {
    const ttl = CACHE_TTL_MS.claude;
    expect(cacheFreshness('claude', 0)).toBe(1);
    expect(cacheFreshness('claude', ttl - 1)).toBe(1);
    expect(cacheFreshness('claude', ttl * 1.5)).toBeCloseTo(0.5, 5);
    expect(cacheFreshness('claude', ttl * 3)).toBe(0);
  });

  it('never treats a stateless reviewer as warm', () => {
    expect(cacheFreshness('openrouter', 0)).toBe(0);
  });

  it('is worth less once the cache has expired', () => {
    const warm = stickyBonus({ provider: 'claude', turnCount: 4, elapsedMs: 1000 });
    const cold = stickyBonus({ provider: 'claude', turnCount: 4, elapsedMs: 60 * 60_000 });
    expect(warm.points).toBeGreaterThan(cold.points);
    expect(warm.warm).toBe(true);
    expect(cold.warm).toBe(false);
    // Never zero: the session itself survives even when the cache does not.
    expect(cold.points).toBeGreaterThan(0);
  });

  it('prices a move by the context that would be re-read, when it is measured', () => {
    const small = stickyBonus({ provider: 'claude', turnCount: 2, contextTokens: 2_000, elapsedMs: 0 });
    const large = stickyBonus({ provider: 'claude', turnCount: 2, contextTokens: 25_000, elapsedMs: 0 });
    expect(large.points).toBeGreaterThan(small.points);
    expect(large.moveTokens).toBe(25_000);
  });
});

describe('auto routing spends the window', () => {
  const two: AccountProfile[] = [
    { id: 'claude-a', provider: 'claude', label: 'a', authMode: 'managed-home', hasSecret: false, priority: 1 },
    { id: 'codex-a', provider: 'codex', label: 'a', authMode: 'managed-home', hasSecret: false, priority: 1 },
  ];

  it('sizes the thinking, not just the model', () => {
    const quota = new QuotaTracker();
    const light = autoRoute(classifyTask({ ...task(), prompt: 'fix typo in readme' }), two, quota);
    const heavy = autoRoute(
      classifyTask({
        ...task(),
        prompt: 'migrate the auth module to the new API across the codebase and update every test',
      }),
      two,
      quota,
    );
    expect(light.effort).toBe('minimal');
    expect(heavy.effort).toBe('high');
  });

  it('holds a thread with a warm cache and lets a cold one go', () => {
    const quota = new QuotaTracker();
    const classification = classifyTask({ ...task(), prompt: 'add a logout button' });
    const conversation = {
      lastTarget: { provider: 'codex' as const, account: 'a' },
      turnCount: 5,
      lastContextTokens: 30_000,
    };
    const now = 10_000_000;

    const warm = autoRoute(classification, two, quota, {
      conversation: { ...conversation, lastRunAt: now - 30_000 },
      now,
    });
    const cold = autoRoute(classification, two, quota, {
      conversation: { ...conversation, lastRunAt: now - 60 * 60_000 },
      now,
    });

    expect(warm.reason).toContain('cache warm');
    expect(cold.reason).toContain('cache cold');
    expect(warm.reason).toContain('moving would re-read');
  });
});

describe('mcp scope', () => {
  const servers = {
    everywhere: { command: 'a' },
    claudeOnly: { command: 'b', providers: ['claude' as const] },
  };

  it('gives an unscoped server to everyone', () => {
    expect(Object.keys(serversFor('gemini', servers))).toEqual(['everywhere']);
    expect(Object.keys(serversFor('claude', servers))).toEqual(['everywhere', 'claudeOnly']);
  });

  it('reads the scope out of the file, and ignores a name that is not a provider', () => {
    const parsed = parseMcpFile(
      JSON.stringify({ servers: { x: { command: 'c', providers: ['claude', 'nonsense'] } } }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.servers.x!.providers).toEqual(['claude']);
  });
});

describe('mcp profiles forget what was taken away', () => {
  const profile = (): AccountProfile & { homeDir: string } => ({
    id: 'claude-a',
    provider: 'claude',
    label: 'a',
    authMode: 'managed-home',
    hasSecret: false,
    priority: 1,
    homeDir: mkdtempSync(join(tmpdir(), 'usturlab-mcp-')),
  });
  const servers = (home: string): Record<string, unknown> =>
    (JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')) as { mcpServers: Record<string, unknown> })
      .mcpServers;

  it('removes a server that was deleted from mcp.json', () => {
    const account = profile();
    expect(syncMcpToProfile(account, { a: { command: 'a' }, b: { command: 'b' } })).toBeUndefined();
    expect(Object.keys(servers(account.homeDir))).toEqual(['a', 'b']);

    // `b` is gone from the file entirely — nothing in the current config names
    // it, so only the manifest knows it was ever written.
    expect(syncMcpToProfile(account, { a: { command: 'a' } })).toBeUndefined();
    expect(Object.keys(servers(account.homeDir))).toEqual(['a']);
  });

  it('removes a server that was scoped away from this provider', () => {
    const account = profile();
    syncMcpToProfile(account, { shared: { command: 'a' }, codexOnly: { command: 'b' } });
    expect(Object.keys(servers(account.homeDir))).toContain('codexOnly');

    syncMcpToProfile(account, {
      shared: { command: 'a' },
      codexOnly: { command: 'b', providers: ['codex'] },
    });
    expect(Object.keys(servers(account.homeDir))).toEqual(['shared']);
  });

  it('leaves a server the user added by hand alone', () => {
    const account = profile();
    writeFileSync(
      join(account.homeDir, '.claude.json'),
      JSON.stringify({ mcpServers: { mine: { type: 'stdio', command: 'mine' } } }),
    );
    syncMcpToProfile(account, { ours: { command: 'a' } });
    expect(Object.keys(servers(account.homeDir)).sort()).toEqual(['mine', 'ours']);
  });
});

describe('acp usage', () => {
  it('reads the shape the protocol actually sends', () => {
    // Exactly the fields Copilot's own bundle declares on PromptResponse.
    expect(
      acpUsage({
        inputTokens: 1_000,
        outputTokens: 250,
        cachedReadTokens: 4_000,
        cachedWriteTokens: 0,
        thoughtTokens: 0,
        totalTokens: 5_250,
      }),
    ).toEqual({ inputTokens: 5_000, outputTokens: 250, cachedInputTokens: 4_000 });
  });

  it('does not count the cache twice when it was already in the input', () => {
    // Same turn, the other convention: inputTokens already contains the cache,
    // and the totals are what give it away.
    expect(
      acpUsage({
        inputTokens: 5_000,
        outputTokens: 250,
        cachedReadTokens: 4_000,
        totalTokens: 5_250,
      }),
    ).toEqual({ inputTokens: 5_000, outputTokens: 250, cachedInputTokens: 4_000 });
  });

  it('says nothing when the agent reports nothing', () => {
    expect(acpUsage(undefined)).toBeUndefined();
    expect(acpUsage({})).toBeUndefined();
    expect(acpUsage({ stopReason: 'end_turn' })).toBeUndefined();
  });
});

describe('cache hit rate', () => {
  const metric = (over: Partial<TaskMetric>): TaskMetric => ({
    id: 'm',
    timestamp: 0,
    conversationId: 'c',
    provider: 'claude',
    account: 'a',
    status: 'success',
    ...over,
  });

  it('is the share of everything read that came from cache', () => {
    const stats = calculateStats([
      metric({ inputTokens: 1000, cachedInputTokens: 800 }),
      metric({ inputTokens: 1000, cachedInputTokens: 200 }),
    ]);
    expect(Math.round(stats.cacheHitRate)).toBe(50);
    expect(stats.cacheReported).toBe(true);
  });

  it('says nothing rather than 0% when no provider reported it', () => {
    const stats = calculateStats([metric({ inputTokens: 1000 })]);
    expect(stats.cacheReported).toBe(false);
    expect(stats.cacheHitRate).toBe(0);
  });
});
