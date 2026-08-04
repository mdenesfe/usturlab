import { describe, expect, it } from 'vitest';
import {
  calibrateAffinity,
  isCleanRun,
  isRetry,
  measurePerformance,
  promptSimilarity,
  sampleConfidence,
} from '../src/router/learning.js';
import { affordability, estimateBurn, observedBurn } from '../src/router/burn.js';
import { classifyTask, isContinuation } from '../src/router/classify.js';
import { autoRoute } from '../src/router/autoRoute.js';
import { route } from '../src/router/router.js';
import { calculateStats } from '../src/quota/metricsSchema.js';
import type { TaskMetric } from '../src/quota/metricsSchema.js';
import { QuotaTracker } from '../src/quota/quotaTracker.js';
import type { RulesFile } from '../src/rules/schema.js';
import type { AccountProfile, ProviderId, TaskRequest } from '../src/types.js';

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

let seq = 0;
const metric = (over: Partial<TaskMetric> = {}): TaskMetric => ({
  id: `m${seq++}`,
  timestamp: 1_700_000_000_000 + seq,
  conversationId: 'c1',
  provider: 'claude' as ProviderId,
  account: 'personal',
  status: 'success',
  ...over,
});

const runs = (n: number, over: Partial<TaskMetric> = {}): TaskMetric[] =>
  Array.from({ length: n }, () => metric(over));

describe('outcome measurement', () => {
  it('only counts a run as clean when the user did not have to fight it', () => {
    expect(isCleanRun(metric())).toBe(true);
    expect(isCleanRun(metric({ steered: true }))).toBe(false);
    expect(isCleanRun(metric({ retried: true }))).toBe(false);
    expect(isCleanRun(metric({ escalated: true }))).toBe(false);
    expect(isCleanRun(metric({ status: 'failover' }))).toBe(false);
  });

  it('counts friction separately from outright failure', () => {
    const stats = calculateStats([
      metric(),
      metric({ steered: true }),
      metric({ status: 'error' }),
      metric(),
    ]);
    expect(stats.successRate).toBe(75);
    expect(stats.frictionRate).toBe(50);
  });

  it('measures per-kind performance and grows confidence with evidence', () => {
    const metrics = [...runs(4, { kind: 'edit' }), ...runs(2, { kind: 'edit', steered: true })];
    const perf = measurePerformance(metrics, 'claude', 'edit');
    expect(perf.runs).toBe(6);
    expect(perf.cleanRate).toBeCloseTo(4 / 6);
    expect(sampleConfidence(0)).toBe(0);
    expect(sampleConfidence(8)).toBeCloseTo(0.5);
    expect(sampleConfidence(200)).toBeGreaterThan(0.95);
  });
});

describe('retry detection', () => {
  const soon = 30_000;

  it('reads a plain rejection as a retry', () => {
    for (const p of ['no', 'try again', "that's wrong", 'hayır', 'olmadı', 'tekrar dene', 'yanlış']) {
      expect(isRetry('add a logout button to the header', p, soon)).toBe(true);
    }
  });

  it('reads a near-identical re-ask as a retry', () => {
    expect(
      isRetry(
        'add a logout button to the header component',
        'add the logout button to the header component please',
        soon,
      ),
    ).toBe(true);
  });

  it('does not mistake the next task for a retry', () => {
    expect(isRetry('add a logout button to the header', 'now write the release notes', soon)).toBe(
      false,
    );
  });

  it('ignores a re-ask that comes much later', () => {
    expect(isRetry('add a logout button', 'add a logout button', 60 * 60 * 1000)).toBe(false);
  });

  it('scores overlap ignoring filler words', () => {
    expect(promptSimilarity('fix the parser bug', 'fix a parser bug')).toBeGreaterThan(0.8);
    expect(promptSimilarity('fix the parser', 'deploy to production')).toBe(0);
  });
});

describe('affinity calibration', () => {
  it('leaves the prior untouched without enough evidence', () => {
    const { affinity } = calibrateAffinity(0.9, runs(2, { kind: 'edit' }), 'claude', 'edit');
    expect(affinity).toBe(0.9);
  });

  it('raises a provider that keeps producing clean runs', () => {
    const { affinity } = calibrateAffinity(0.8, runs(20, { kind: 'edit' }), 'claude', 'edit');
    expect(affinity).toBeGreaterThan(0.8);
  });

  it('lowers a provider the user constantly has to steer', () => {
    const metrics = runs(20, { kind: 'edit', provider: 'gemini', steered: true });
    const { affinity } = calibrateAffinity(0.8, metrics, 'gemini', 'edit');
    expect(affinity).toBeLessThan(0.8);
    expect(affinity).toBeGreaterThanOrEqual(0.35);
  });

  it('falls back to the provider record at half weight until a kind has history', () => {
    const overall = runs(20, { kind: 'debug', steered: true });
    const weak = calibrateAffinity(0.8, overall, 'claude', 'edit').affinity;
    const strong = calibrateAffinity(0.8, runs(20, { kind: 'edit', steered: true }), 'claude', 'edit')
      .affinity;
    expect(weak).toBeLessThan(0.8);
    expect(weak).toBeGreaterThan(strong);
  });

  it('changes which account auto routing prefers', () => {
    const quota = new QuotaTracker();
    const badClaude = runs(20, { kind: 'edit', provider: 'claude', account: 'personal', steered: true });
    const goodCodex = runs(20, { kind: 'edit', provider: 'codex', account: 'personal' });
    const cold = autoRoute(classifyTask(task('add a logout button')), accounts, quota);
    const learned = autoRoute(classifyTask(task('add a logout button')), accounts, quota, {
      metrics: [...badClaude, ...goodCodex],
    });
    expect(cold.chain[0]?.provider).toBe('claude');
    expect(learned.chain[0]?.provider).toBe('codex');
  });
});

describe('burn estimation', () => {
  it('uses a conservative prior scaled by tier and kind', () => {
    const target = { provider: 'claude' as ProviderId, account: 'personal' };
    const light = estimateBurn(target, 'trivial', 'edit', []);
    const heavy = estimateBurn(target, 'hard', 'edit', []);
    const agentic = estimateBurn(target, 'hard', 'agentic', []);
    expect(light.measured).toBe(false);
    expect(heavy.pct).toBeGreaterThan(light.pct);
    expect(agentic.pct).toBeGreaterThan(heavy.pct);
  });

  it('switches to measured burn once comparable runs exist', () => {
    const target = { provider: 'claude' as ProviderId, account: 'personal' };
    const metrics = runs(3, { complexity: 'hard', burnPct: 2 });
    const est = estimateBurn(target, 'hard', 'edit', metrics);
    expect(est.measured).toBe(true);
    expect(est.samples).toBe(3);
    expect(est.pct).toBe(2);
  });

  it('only reads forward movement of a usage window as burn', () => {
    expect(observedBurn(10, 14)).toBe(4);
    expect(observedBurn(90, 3)).toBeUndefined(); // window rolled over
    expect(observedBurn(undefined, 20)).toBeUndefined();
  });

  it('penalizes a run that would empty the account', () => {
    const cheap = { pct: 2, measured: false, samples: 0 };
    const expensive = { pct: 30, measured: false, samples: 0 };
    expect(affordability(80, cheap)).toBe(1);
    expect(affordability(20, expensive)).toBe(0.15);
    expect(affordability(35, expensive)).toBe(0.5);
    expect(affordability(0, cheap)).toBe(0);
  });

  it('avoids an account that cannot afford the run it is being given', () => {
    const quota = new QuotaTracker();
    // Claude has more room than codex on paper, but not enough for an agentic run.
    quota.setUsage('claude-personal', [{ utilizationPct: 82, label: '5h window' }]);
    quota.setUsage('codex-personal', [{ utilizationPct: 30, label: '5h window' }]);
    const result = autoRoute(
      classifyTask(
        task('Migrate the auth module across the entire codebase and then update all the tests'),
      ),
      accounts,
      quota,
    );
    expect(result.chain[0]?.provider).toBe('codex');
    expect(result.burn?.pct).toBeGreaterThan(10);
  });
});

describe('conversation memory', () => {
  it('recognizes a bare confirmation as a continuation', () => {
    for (const p of ['yes', 'ok', 'go ahead', 'devam et', 'evet', 'yap', 'tamam']) {
      expect(isContinuation(p)).toBe(true);
    }
    expect(isContinuation('yes, but first rewrite the parser')).toBe(false);
  });

  it('keeps a follow-up on the thread weight instead of dropping to a light model', () => {
    const quota = new QuotaTracker();
    const r = route(task('evet yap'), emptyRules, accounts, quota, {
      mode: 'auto',
      conversation: { recentComplexity: ['hard'], turnCount: 3 },
    });
    expect(r.decision.chain[0]?.model).toBe('opus');
  });

  it('stays on the same account across turns of one conversation', () => {
    const quota = new QuotaTracker();
    // Without stickiness a light task would move to the fresher account.
    quota.setUsage('claude-personal', [{ utilizationPct: 45, label: '5h window' }]);
    const cold = autoRoute(classifyTask(task('rename this variable')), accounts, quota);
    const sticky = autoRoute(classifyTask(task('rename this variable')), accounts, quota, {
      conversation: {
        lastTarget: { provider: 'claude', account: 'personal' },
        recentComplexity: ['trivial'],
        turnCount: 2,
      },
    });
    expect(cold.chain[0]?.provider).toBe('codex');
    expect(sticky.chain[0]?.provider).toBe('claude');
    expect(sticky.reason).toContain('same thread');
  });

  it('escalates mid-thread when the work suddenly gets harder', () => {
    const quota = new QuotaTracker();
    const r = route(
      task('now redesign the whole concurrency architecture across the codebase and migrate every test'),
      emptyRules,
      accounts,
      quota,
      { mode: 'auto', conversation: { recentComplexity: ['simple'], turnCount: 4 } },
    );
    expect(r.decision.escalated).toEqual({ from: 'light', to: 'heavy' });
    expect(r.decision.chain[0]?.model).toBe('opus');
    expect(r.decision.reason).toContain('escalated');
  });

  it('plans heavy code-writing work before it edits, and leaves light work alone', () => {
    const quota = new QuotaTracker();
    const heavy = route(
      task('Rewrite the entire persistence layer and migrate all the tests', {
        permissionMode: 'full',
      }),
      emptyRules,
      accounts,
      quota,
      { mode: 'auto', autoPlan: true },
    );
    expect(heavy.decision.suggestPermission).toBe('safe');

    const light = route(task('fix a typo in the readme', { permissionMode: 'full' }), emptyRules, accounts, quota, {
      mode: 'auto',
      autoPlan: true,
    });
    expect(light.decision.suggestPermission).toBeUndefined();
  });

  it('does not override a permission mode the user already restricted', () => {
    const quota = new QuotaTracker();
    const r = route(
      task('Rewrite the entire persistence layer and migrate all the tests', { permissionMode: 'safe' }),
      emptyRules,
      accounts,
      quota,
      { mode: 'auto', autoPlan: true },
    );
    expect(r.decision.suggestPermission).toBeUndefined();
  });

  it('respects the setting being off', () => {
    const quota = new QuotaTracker();
    const r = route(
      task('Rewrite the entire persistence layer and migrate all the tests', { permissionMode: 'full' }),
      emptyRules,
      accounts,
      quota,
      { mode: 'auto', autoPlan: false },
    );
    expect(r.decision.suggestPermission).toBeUndefined();
  });
});
