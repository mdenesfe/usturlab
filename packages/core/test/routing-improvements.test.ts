import { describe, expect, it } from 'vitest';
import { classifyTask, isContinuation } from '../src/router/classify.js';
import { autoRoute } from '../src/router/autoRoute.js';
import { calibrateAffinity } from '../src/router/learning.js';
import { route } from '../src/router/router.js';
import { isUnknownModel } from '../src/adapters/limits.js';
import { AdapterRegistry } from '../src/adapters/adapter.js';
import { FakeAdapter } from '../src/adapters/fake.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { QuotaTracker } from '../src/quota/quotaTracker.js';
import { SessionStore } from '../src/session/sessionStore.js';
import { parseRulesFile } from '../src/rules/schema.js';
import type { RulesFile } from '../src/rules/schema.js';
import type { TaskMetric } from '../src/quota/metricsSchema.js';
import type { AccountProfile, RunEvent, TaskRequest } from '../src/types.js';

const task = (prompt: string, over: Partial<TaskRequest> = {}): TaskRequest => ({
  conversationId: 'c1',
  prompt,
  cwd: '/tmp',
  permissionMode: 'edits',
  ...over,
});

const claudeOnly: AccountProfile[] = [
  { id: 'claude-personal', provider: 'claude', label: 'personal', authMode: 'managed-home', hasSecret: false, priority: 1 },
];

const emptyRules: RulesFile = { version: 1, rules: [], defaultChain: [] };

// ── the classifier speaks Turkish ────────────────────────────

describe('Turkish prompts are weighed, not waved through', () => {
  it('reads a repo-wide migration as hard multi-step work', () => {
    const c = classifyTask(task('auth modülünü tüm kod tabanında yeni API’ye taşı, sonra da testleri güncelle'));
    expect(c.kind).toBe('agentic');
    expect(c.complexity).toBe('hard');
    expect(c.signals).toContain('multi-step');
  });

  it('sees a hard topic even when the word starts with a Turkish letter', () => {
    // \b is ASCII-only: a pattern anchored with it can never match "ölçeklen".
    expect(classifyTask(task('bu servisin ölçeklenebilirliğini artır')).signals).toContain('hard topic');
    expect(classifyTask(task('çalışmıyor, neden çöküyor bakar mısın')).kind).toBe('debug');
  });

  it('matches a stem through its suffixes', () => {
    // "güvenlik" has to be found inside "güvenliğini" — the language glues.
    expect(classifyTask(task('ödeme akışının güvenliğini denetle')).signals).toContain('hard topic');
    expect(classifyTask(task('yarış durumunu çöz')).signals).toContain('hard topic');
  });

  it('still reads mechanical work as trivial', () => {
    const c = classifyTask(task('yazım hatasını düzelt'));
    expect(c.complexity).toBe('trivial');
    expect(c.signals).toContain('mechanical');
  });

  it('takes stacked Turkish confirmations as one continuation', () => {
    for (const p of ['evet yap', 'tamam devam et', 'peki hadi', 'olur, yapalım']) {
      expect(isContinuation(p)).toBe(true);
    }
    expect(isContinuation('evet ama önce parser’ı düzelt')).toBe(false);
  });
});

// ── the thread's weight comes back down ──────────────────────

describe('thread weight follows recent turns, not an all-time peak', () => {
  const trivial = () => classifyTask(task('rename this variable'));

  it('drops back to a light model once the thread is doing light work again', () => {
    const auto = autoRoute(trivial(), claudeOnly, new QuotaTracker(), {
      conversation: { recentComplexity: ['trivial', 'trivial'], turnCount: 8 },
    });
    expect(auto.tier).toBe('light');
    expect(auto.chain[0]?.model).toBe('haiku');
  });

  it('lifts a light turn by at most one rank, however hard the last one was', () => {
    const auto = autoRoute(trivial(), claudeOnly, new QuotaTracker(), {
      conversation: { recentComplexity: ['hard'], turnCount: 2 },
    });
    // Not opus: a typo fix after a hard turn is not hard work.
    expect(auto.tier).toBe('standard');
    expect(auto.chain[0]?.model).toBe('sonnet');
  });

  it('gives a bare confirmation the weight of the turn it answers', () => {
    const r = route(task('evet yap'), emptyRules, claudeOnly, new QuotaTracker(), {
      mode: 'auto',
      conversation: { recentComplexity: ['hard'], turnCount: 3 },
    });
    expect(r.decision.chain[0]?.model).toBe('opus');
  });

  it('forgets a hard turn that has scrolled out of the window', () => {
    const auto = autoRoute(trivial(), claudeOnly, new QuotaTracker(), {
      // Only the two most recent turns count; the hard one is older than that.
      conversation: { recentComplexity: ['trivial', 'trivial', 'hard'], turnCount: 9 },
    });
    expect(auto.tier).toBe('light');
  });
});

// ── measured latency counts on light work ────────────────────

const metric = (over: Partial<TaskMetric>): TaskMetric => ({
  id: Math.random().toString(36).slice(2),
  timestamp: 1,
  conversationId: 'c1',
  provider: 'claude',
  account: 'personal',
  status: 'success',
  ...over,
});

describe('speed is part of doing light work well', () => {
  const twoProviders: AccountProfile[] = [
    { id: 'claude-personal', provider: 'claude', label: 'personal', authMode: 'managed-home', hasSecret: false, priority: 1 },
    { id: 'codex-personal', provider: 'codex', label: 'personal', authMode: 'managed-home', hasSecret: false, priority: 1 },
  ];

  /** Same clean record for both providers; only the timings differ. */
  const history = (claudeMs: number, codexMs: number): TaskMetric[] => [
    ...Array.from({ length: 4 }, () =>
      metric({ provider: 'claude', kind: 'refactor', tier: 'light', durationMs: claudeMs }),
    ),
    ...Array.from({ length: 4 }, () =>
      metric({ provider: 'codex', account: 'personal', kind: 'refactor', tier: 'light', durationMs: codexMs }),
    ),
  ];

  it('prefers the account measurably faster at this weight class', () => {
    const cls = classifyTask(task('rename this variable'));
    const quota = new QuotaTracker();
    const claudeFast = autoRoute(cls, twoProviders, quota, { metrics: history(4_000, 40_000) });
    const codexFast = autoRoute(cls, twoProviders, quota, { metrics: history(40_000, 4_000) });

    // Swapping only the timings swaps the winner — nothing else moved.
    expect(claudeFast.chain[0]?.provider).toBe('claude');
    expect(codexFast.chain[0]?.provider).toBe('codex');
  });

  it('leaves heavy work to capability alone', () => {
    const cls = classifyTask(
      task('redesign the concurrency architecture and migrate every caller across the codebase'),
    );
    const quota = new QuotaTracker();
    const slowClaude = autoRoute(cls, twoProviders, quota, { metrics: history(40_000, 4_000) });
    // On hard work the faster account does not get to win on speed.
    expect(slowClaude.tier).toBe('heavy');
    expect(slowClaude.chain[0]?.provider).toBe('claude');
  });
});

// ── capability is measured per weight class ──────────────────

describe('a cheap model’s failures stay off the expensive one’s record', () => {
  const rough = (tier: TaskMetric['tier']) =>
    Array.from({ length: 5 }, () => metric({ kind: 'edit', tier, retried: true }));
  const clean = (tier: TaskMetric['tier']) =>
    Array.from({ length: 5 }, () => metric({ kind: 'edit', tier }));

  it('does not let light-tier retries drag down the heavy tier', () => {
    const metrics = [...rough('light'), ...clean('heavy')];
    const tiered = calibrateAffinity(0.9, metrics, 'claude', 'edit', 'heavy').affinity;
    const blind = calibrateAffinity(0.9, metrics, 'claude', 'edit').affinity;

    expect(tiered).toBeGreaterThan(blind);
    // Evidence for the heavy tier is clean, so it is not punished at all.
    expect(tiered).toBeGreaterThanOrEqual(0.9);
  });

  it('still punishes the tier that actually did badly', () => {
    const metrics = [...rough('light'), ...clean('heavy')];
    expect(calibrateAffinity(0.9, metrics, 'claude', 'edit', 'light').affinity).toBeLessThan(0.9);
  });

  it('falls back to untiered history when a tier has none of its own', () => {
    // Runs recorded before tiers were tracked still count, at lower confidence.
    const legacy = Array.from({ length: 6 }, () => metric({ kind: 'edit', retried: true }));
    expect(calibrateAffinity(0.9, legacy, 'claude', 'edit', 'heavy').affinity).toBeLessThan(0.9);
  });
});

// ── a retired model id does not cost an account ──────────────

describe('a rejected model falls back to the CLI default', () => {
  const accounts: AccountProfile[] = [
    { id: 'claude-a', provider: 'claude', label: 'a', authMode: 'oauth-token', hasSecret: true, priority: 1 },
    { id: 'claude-b', provider: 'claude', label: 'b', authMode: 'oauth-token', hasSecret: true, priority: 2 },
  ];
  const pinned: RulesFile = {
    version: 1,
    rules: [],
    defaultChain: [
      { provider: 'claude', account: 'a', model: 'opus-retired' },
      { provider: 'claude', account: 'b' },
    ],
  };

  it('recognizes the CLI saying it does not know that model', () => {
    expect(isUnknownModel('error: unknown model "opus-retired"')).toBe(true);
    expect(isUnknownModel('model gemini-2.5-pro is no longer available')).toBe(true);
    expect(isUnknownModel('connection reset by peer')).toBe(false);
  });

  it('retries the same account without the model instead of failing over', async () => {
    const fake = new FakeAdapter('claude');
    fake.script('claude-a', [
      { type: 'error', message: 'unknown model: opus-retired', retryable: false },
    ]);
    fake.script('claude-a', [{ type: 'result', text: 'done' }]);

    const registry = new AdapterRegistry();
    registry.register(fake);
    const orchestrator = new Orchestrator({
      adapters: registry,
      quota: new QuotaTracker(),
      sessions: new SessionStore(),
      getRules: () => pinned,
      getAccounts: () => accounts,
      resolveAccount: async (t) => accounts.find((a) => a.provider === t.provider && a.label === t.account),
      retryBackoffMs: [0, 0],
      getRoutingMode: () => 'manual',
    });

    const events: RunEvent[] = [];
    for await (const ev of orchestrator.run(task('do the thing'), new AbortController().signal)) {
      events.push(ev);
    }

    expect(fake.runs.map((r) => r.model)).toEqual(['opus-retired', undefined]);
    // The second account was never touched — the first one finished the job.
    expect(fake.runs.every((r) => r.accountId === 'claude-a')).toBe(true);
    expect(events.some((e) => e.type === 'model-downgraded')).toBe(true);
    expect(events.some((e) => e.type === 'failover')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'result', text: 'done' });
  });

  it('does not announce a dropped connection that never happened', async () => {
    const fake = new FakeAdapter('claude');
    fake.script('claude-a', [{ type: 'error', message: 'invalid model', retryable: false }]);
    fake.script('claude-a', [{ type: 'result', text: 'done' }]);

    const registry = new AdapterRegistry();
    registry.register(fake);
    const orchestrator = new Orchestrator({
      adapters: registry,
      quota: new QuotaTracker(),
      sessions: new SessionStore(),
      getRules: () => pinned,
      getAccounts: () => accounts,
      resolveAccount: async (t) => accounts.find((a) => a.provider === t.provider && a.label === t.account),
      getRoutingMode: () => 'manual',
    });

    const attempts: number[] = [];
    for await (const ev of orchestrator.run(task('do the thing'), new AbortController().signal)) {
      if (ev.type === 'attempt') attempts.push(ev.attempt);
    }
    // Both runs are attempt 1: the model changed, the attempt did not.
    expect(attempts).toEqual([1, 1]);
  });
});

// ── a rule can say never ─────────────────────────────────────

describe('rules can bar a provider outright', () => {
  const accounts: AccountProfile[] = [
    { id: 'claude-personal', provider: 'claude', label: 'personal', authMode: 'managed-home', hasSecret: false, priority: 1 },
    { id: 'gemini-personal', provider: 'gemini', label: 'personal', authMode: 'managed-home', hasSecret: false, priority: 2 },
  ];
  const banned: RulesFile = {
    version: 1,
    rules: [
      {
        id: 'no-gemini-for-security',
        match: { keywords: ['security', 'güvenlik'] },
        target: [],
        exclude: [{ provider: 'gemini' }],
      },
    ],
    defaultChain: [],
  };

  it('keeps the barred provider out of the whole chain, failover tail included', () => {
    const r = route(task('review the security of this auth flow'), banned, accounts, new QuotaTracker());
    expect(r.decision.chain.some((t) => t.provider === 'gemini')).toBe(false);
    expect(r.decision.skipped.some((s) => s.reason.includes('no-gemini-for-security'))).toBe(true);
  });

  it('leaves other work alone', () => {
    const r = route(task('rename this variable'), banned, accounts, new QuotaTracker());
    expect(r.decision.chain.some((t) => t.provider === 'gemini')).toBe(true);
  });

  it('does not hijack routing just by matching', () => {
    // A rule with no target says only where NOT to go; the router still sizes
    // the task itself rather than treating this as "the rule that decided".
    const r = route(task('review the security of this auth flow'), banned, accounts, new QuotaTracker());
    expect(r.decision.classification).toBeDefined();
    expect(r.decision.ruleId).toBeUndefined();
  });

  it('yields to an explicit mention — overriding your own rule is allowed', () => {
    const r = route(
      task('@gemini review the security of this auth flow'),
      banned,
      accounts,
      new QuotaTracker(),
    );
    expect(r.decision.chain[0]?.provider).toBe('gemini');
  });

  it('accepts an exclude-only rule in the rules file', () => {
    const parsed = parseRulesFile(
      JSON.stringify({
        version: 1,
        rules: [{ id: 'x', match: { keywords: ['a'] }, exclude: [{ provider: 'gemini' }] }],
      }),
    );
    expect(parsed.ok).toBe(true);
  });

  it('rejects a rule that says neither where to go nor where not to', () => {
    const parsed = parseRulesFile(
      JSON.stringify({ version: 1, rules: [{ id: 'x', match: { keywords: ['a'] } }] }),
    );
    expect(parsed.ok).toBe(false);
  });
});
