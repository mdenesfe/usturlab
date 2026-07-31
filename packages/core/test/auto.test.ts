import { describe, expect, it } from 'vitest';
import { classifyTask } from '../src/router/classify.js';
import { autoRoute, accountHeadroom } from '../src/router/autoRoute.js';
import { route } from '../src/router/router.js';
import { QuotaTracker } from '../src/quota/quotaTracker.js';
import type { RulesFile } from '../src/rules/schema.js';
import type { AccountProfile, TaskRequest } from '../src/types.js';

const task = (prompt: string, over: Partial<TaskRequest> = {}): TaskRequest => ({
  conversationId: 'c1',
  prompt,
  cwd: '/tmp',
  permissionMode: 'safe',
  ...over,
});

const accounts: AccountProfile[] = [
  { id: 'claude-personal', provider: 'claude', label: 'personal', authMode: 'managed-home', hasSecret: false, priority: 1 },
  { id: 'codex-personal', provider: 'codex', label: 'personal', authMode: 'managed-home', hasSecret: false, priority: 2 },
];

const emptyRules: RulesFile = { version: 1, rules: [], defaultChain: [] };

describe('task classification', () => {
  it('reads trivial mechanical work as light', () => {
    const c = classifyTask(task('fix typo in readme'));
    expect(c.complexity).toBe('trivial');
    expect(c.signals).toContain('mechanical');
  });

  it('reads a plain question as light and non-writing', () => {
    const c = classifyTask(task('what does this repo do?'));
    expect(['trivial', 'simple']).toContain(c.complexity);
    expect(c.writesCode).toBe(false);
  });

  it('recognizes multi-step agentic work as hard', () => {
    const c = classifyTask(
      task('Migrate the auth module to the new API across the entire codebase and then update all the tests'),
    );
    expect(c.kind).toBe('agentic');
    expect(c.complexity).toBe('hard');
    expect(c.signals).toContain('multi-step');
  });

  it('flags architectural/perf work as hard', () => {
    expect(classifyTask(task('optimize the render loop, there is a race condition')).complexity).toBe(
      'hard',
    );
  });

  it('detects the kind of work', () => {
    expect(classifyTask(task('write unit tests for the parser')).kind).toBe('test');
    expect(classifyTask(task('review my changes for security issues')).kind).toBe('review');
    expect(classifyTask(task('debug this crash: TypeError x')).kind).toBe('debug');
    expect(classifyTask(task('explain how routing works')).kind).toBe('explain');
    expect(classifyTask(task('add a logout button')).kind).toBe('edit');
  });
});

describe('auto routing', () => {
  it('picks a light model for trivial work and a heavy one for hard work', () => {
    const quota = new QuotaTracker();
    const light = autoRoute(classifyTask(task('fix typo')), accounts, quota);
    expect(light.chain[0]?.provider).toBe('claude');
    expect(light.chain[0]?.model).toBe('haiku');

    const heavy = autoRoute(
      classifyTask(
        task('Redesign the concurrency model across the entire codebase and then migrate all tests'),
      ),
      accounts,
      quota,
    );
    expect(heavy.chain[0]?.model).toBe('opus');
    expect(heavy.reason).toContain('hard');
  });

  it('keeps a nearly-exhausted account in reserve for easy work', () => {
    const quota = new QuotaTracker();
    quota.setUsage('claude-personal', [{ utilizationPct: 95, label: '5h window' }]);
    const result = autoRoute(classifyTask(task('fix typo')), accounts, quota);
    expect(result.chain[0]?.provider).toBe('codex');
    expect(result.chain.some((t) => t.provider === 'claude')).toBe(true);
  });

  it('still uses the capable account for hard work even when quota is tight', () => {
    const quota = new QuotaTracker();
    quota.setUsage('claude-personal', [{ utilizationPct: 60, label: '5h window' }]);
    const result = autoRoute(
      classifyTask(
        task('Do a deep security review of the whole authentication architecture for race conditions'),
      ),
      accounts,
      quota,
    );
    expect(result.chain[0]?.provider).toBe('claude');
    expect(result.chain[0]?.model).toBe('opus');
  });

  it('never offers an account that is on cooldown', () => {
    const quota = new QuotaTracker();
    quota.markLimitHit('claude-personal', { resetAt: Date.now() + 3600_000 });
    expect(accountHeadroom('claude-personal', quota)).toBe(0);
    const result = autoRoute(classifyTask(task('add a button')), accounts, quota);
    expect(result.chain.every((t) => t.provider !== 'claude')).toBe(true);
  });

  it('reports headroom from the worst window', () => {
    const quota = new QuotaTracker();
    quota.setUsage('codex-personal', [
      { utilizationPct: 10, label: '5h window' },
      { utilizationPct: 80, label: 'weekly' },
    ]);
    expect(accountHeadroom('codex-personal', quota)).toBe(20);
  });
});

describe('router modes', () => {
  it('auto mode classifies and picks a model when no rule matches', () => {
    const quota = new QuotaTracker();
    const r = route(task('fix typo in the readme'), emptyRules, accounts, quota, { mode: 'auto' });
    expect(r.decision.reason).toContain('auto');
    expect(r.decision.classification?.complexity).toBe('trivial');
    expect(r.decision.chain[0]?.model).toBe('haiku');
  });

  it('manual mode follows priority order without classifying', () => {
    const quota = new QuotaTracker();
    const r = route(task('fix typo in the readme'), emptyRules, accounts, quota, { mode: 'manual' });
    expect(r.decision.classification).toBeUndefined();
    expect(r.decision.chain[0]).toMatchObject({ provider: 'claude', account: 'personal' });
    expect(r.decision.chain[0]?.model).toBeUndefined();
  });

  it('user rules beat auto routing', () => {
    const quota = new QuotaTracker();
    const rules: RulesFile = {
      version: 1,
      rules: [
        {
          id: 'tests-to-codex',
          match: { keywords: ['test'] },
          target: [{ provider: 'codex', account: 'personal' }],
        },
      ],
      defaultChain: [],
    };
    const r = route(task('write a test for the parser'), rules, accounts, quota, { mode: 'auto' });
    expect(r.decision.ruleId).toBe('tests-to-codex');
    expect(r.decision.chain[0]?.provider).toBe('codex');
  });

  it('an explicit @mention beats everything', () => {
    const quota = new QuotaTracker();
    const r = route(task('@codex:personal fix typo'), emptyRules, accounts, quota, { mode: 'auto' });
    expect(r.decision.chain[0]?.provider).toBe('codex');
    expect(r.cleanedPrompt).toBe('fix typo');
  });
});
