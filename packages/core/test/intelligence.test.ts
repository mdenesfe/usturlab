import { describe, expect, it } from 'vitest';
import { buildBrief, readsNatively, withBrief } from '../src/context/brief.js';
import { briefLinesFor, buildProviderBrief } from '../src/context/providerBrief.js';
import {
  discoverChecks,
  repairPrompt,
  selectChecks,
  summarize,
  trimOutput,
} from '../src/verify/checks.js';
import { isClean, pickReviewer, reviewPrompt } from '../src/review/secondOpinion.js';
import { executePrompt, executorTier, parsePlan, pickExecutor } from '../src/review/planExecute.js';
import {
  correctionSimilarity,
  disqualifiedLines,
  judgeLine,
  suggestRules,
  trialFor,
} from '../src/router/instructionLearning.js';
import type { TaskMetric } from '../src/quota/metricsSchema.js';
import type { Target } from '../src/types.js';

describe('task brief', () => {
  it('leads with what the user is looking at', () => {
    const brief = buildBrief({
      provider: 'gemini',
      editor: {
        activeFile: 'src/router/autoRoute.ts',
        languageId: 'typescript',
        selection: 'const sticky = 12;',
        selectionRange: { start: 160, end: 161 },
      },
    });
    expect(brief).toContain('src/router/autoRoute.ts:160-161');
    expect(brief).toContain('const sticky = 12;');
    expect(brief.indexOf('Where the user is')).toBeGreaterThan(-1);
  });

  it('never repeats a convention file the CLI already reads', () => {
    const conventions = [{ path: 'CLAUDE.md', text: 'house rules' }];
    expect(readsNatively('claude', 'CLAUDE.md')).toBe(true);
    expect(readsNatively('gemini', 'CLAUDE.md')).toBe(false);
    expect(buildBrief({ provider: 'claude', conventions })).not.toContain('house rules');
    expect(buildBrief({ provider: 'gemini', conventions })).toContain('house rules');
  });

  it('still gives Claude the things it cannot know', () => {
    const brief = buildBrief({
      provider: 'claude',
      editor: { activeFile: 'src/a.ts' },
      repo: { branch: 'main', changedFiles: ['src/a.ts'] },
      conventions: [{ path: 'CLAUDE.md', text: 'house rules' }],
    });
    expect(brief).toContain('src/a.ts');
    expect(brief).toContain('main');
    expect(brief).not.toContain('house rules');
  });

  it('drops whole sections rather than truncating mid-sentence', () => {
    const brief = buildBrief({
      provider: 'gemini',
      editor: { activeFile: 'a.ts' },
      conventions: [{ path: 'AGENTS.md', text: 'x'.repeat(5000) }],
      budget: 300,
    });
    expect(brief).toContain('a.ts');
    expect(brief).not.toContain('AGENTS.md');
  });

  it('is empty when there is nothing worth saying', () => {
    expect(buildBrief({ provider: 'claude' })).toBe('');
    expect(withBrief('do the thing', '')).toBe('do the thing');
  });

  it('carries what this thread already did', () => {
    const brief = buildBrief({
      provider: 'codex',
      thread: { touchedFiles: ['src/a.ts'], lastFailure: 'typecheck failed' },
    });
    expect(brief).toContain('src/a.ts');
    expect(brief).toContain('typecheck failed');
  });
});

describe('provider brief', () => {
  it('gives the thinner CLIs the instructions Claude does not need', () => {
    const claude = briefLinesFor({ provider: 'claude', permissionMode: 'edits' });
    const gemini = briefLinesFor({ provider: 'gemini', permissionMode: 'edits' });
    expect(gemini.length).toBeGreaterThan(claude.length);
    expect(gemini.some((l) => l.id === 'gemini-read-first')).toBe(true);
    expect(claude.some((l) => l.id.startsWith('gemini-'))).toBe(false);
  });

  it('states the permission mode as a hard constraint', () => {
    expect(buildProviderBrief({ provider: 'codex', permissionMode: 'safe' })).toContain('plan mode');
    expect(buildProviderBrief({ provider: 'codex', permissionMode: 'full' })).toContain('run commands');
  });

  it('appends the user own accepted rules', () => {
    const brief = buildProviderBrief({
      provider: 'claude',
      permissionMode: 'edits',
      preferences: ['Always answer in Turkish.'],
    });
    expect(brief).toContain('Always answer in Turkish.');
  });

  it('drops a line the evidence disqualified', () => {
    const lines = briefLinesFor({
      provider: 'gemini',
      permissionMode: 'edits',
      disabledLineIds: ['gemini-no-preamble'],
    });
    expect(lines.some((l) => l.id === 'gemini-no-preamble')).toBe(false);
  });
});

describe('verification', () => {
  it('only ever runs what the repo itself declares', () => {
    const commands = discoverChecks({
      scripts: { typecheck: 'tsc', test: 'vitest run', dev: 'vite' },
      packageManager: 'pnpm@9.0.0',
    });
    expect(commands.map((c) => c.kind)).toEqual(['typecheck', 'test']);
    expect(commands[0]!.argv).toEqual(['pnpm', 'run', 'typecheck']);
    expect(commands[0]!.source).toBe('package.json scripts.typecheck');
  });

  it('finds nothing when the repo declares nothing', () => {
    expect(discoverChecks({})).toEqual([]);
    expect(discoverChecks({ scripts: { dev: 'vite', start: 'node .' } })).toEqual([]);
  });

  it('falls back to Makefile targets', () => {
    const commands = discoverChecks({ makeTargets: ['build', 'test', 'clean'] });
    expect(commands.map((c) => c.argv.join(' '))).toContain('make test');
  });

  it('does not run the suite for a typo fix, but does for a refactor', () => {
    const available = discoverChecks({ scripts: { typecheck: 'tsc', test: 'vitest' } });
    const trivial = selectChecks(available, { kind: 'edit', complexity: 'trivial', wroteCode: true });
    const refactor = selectChecks(available, { kind: 'refactor', complexity: 'hard', wroteCode: true });
    expect(trivial.map((c) => c.kind)).toEqual(['typecheck']);
    expect(refactor.map((c) => c.kind)).toEqual(['typecheck', 'test']);
  });

  it('verifies nothing when nothing was written', () => {
    const available = discoverChecks({ scripts: { test: 'vitest' } });
    expect(selectChecks(available, { kind: 'explain', complexity: 'hard', wroteCode: false })).toEqual([]);
  });

  it('keeps the end of a long failure — that is where the error is', () => {
    const output = 'noise\n'.repeat(2000) + 'ERROR: the actual problem';
    expect(trimOutput(output)).toContain('ERROR: the actual problem');
    expect(trimOutput(output)).toContain('earlier output omitted');
  });

  it('asks for the cause to be fixed, not the check to be silenced', () => {
    const report = summarize([{ kind: 'test', ok: false, output: 'expected 1 got 2' }]);
    expect(report.ok).toBe(false);
    const prompt = repairPrompt(report, ['src/a.ts']);
    expect(prompt).toContain('expected 1 got 2');
    expect(prompt).toContain('src/a.ts');
    expect(prompt).toMatch(/do not weaken or skip the check/i);
  });

  it('treats a timed-out check as no verdict', () => {
    const report = summarize([{ kind: 'test', ok: true, skipped: 'timed out' }]);
    expect(report.ok).toBe(true);
  });
});

describe('second opinion', () => {
  const author: Target = { provider: 'claude', account: 'personal' };
  const candidates: Target[] = [
    { provider: 'claude', account: 'personal' },
    { provider: 'codex', account: 'personal' },
    { provider: 'claude', account: 'work' },
  ];
  const roomy = { 'claude:personal': 80, 'codex:personal': 80, 'claude:work': 80 };
  const hard = { kind: 'edit', complexity: 'hard', writesCode: true, signals: [] } as never;
  const easy = { kind: 'edit', complexity: 'trivial', writesCode: true, signals: [] } as never;

  it('prefers a different provider — a different model sees different mistakes', () => {
    const choice = pickReviewer({ author, candidates, classification: hard, headroom: roomy });
    expect(choice?.target.provider).toBe('codex');
  });

  it('falls back to another account of the same provider', () => {
    const choice = pickReviewer({
      author,
      candidates: [author, { provider: 'claude', account: 'work' }],
      classification: hard,
      headroom: roomy,
    });
    expect(choice?.target.account).toBe('work');
  });

  it('does not spend a second account on easy work', () => {
    expect(pickReviewer({ author, candidates, classification: easy, headroom: roomy })).toBeUndefined();
    expect(
      pickReviewer({ author, candidates, classification: easy, headroom: roomy, policy: 'always' }),
    ).toBeDefined();
  });

  it('skips the review when no reviewer can afford it', () => {
    const drained = { 'claude:personal': 80, 'codex:personal': 12, 'claude:work': 8 };
    expect(
      pickReviewer({ author, candidates, classification: hard, headroom: drained }),
    ).toBeUndefined();
  });

  it('never reviews with the account that did the work', () => {
    const choice = pickReviewer({
      author,
      candidates: [author],
      classification: hard,
      headroom: roomy,
      policy: 'always',
    });
    expect(choice).toBeUndefined();
  });

  it('asks the reviewer to refute, and allows finding nothing', () => {
    const prompt = reviewPrompt({
      task: 'add logout',
      answer: 'done',
      diff: '+ logout()',
      authorProvider: 'claude',
    });
    expect(prompt).toMatch(/adversarial/i);
    expect(prompt).toContain('LGTM');
    expect(prompt).toContain('+ logout()');
    expect(isClean('LGTM')).toBe(true);
    expect(isClean('  lgtm  ')).toBe(true);
    expect(isClean('Looks fine but the null check is missing')).toBe(false);
  });
});

describe('plan then execute', () => {
  const goodPlan = `
1. In src/router/autoRoute.ts, extract the sticky bonus into a constant
2. In src/router/learning.ts, exclude transient runs from the sample
3. Add a case to packages/core/test/learning.test.ts covering both
`;

  it('accepts a plan that names its files', () => {
    const plan = parsePlan(goodPlan);
    expect(plan.executable).toBe(true);
    expect(plan.steps).toHaveLength(3);
    expect(plan.steps[0]!.files).toContain('src/router/autoRoute.ts');
  });

  it('refuses to hand off prose', () => {
    const plan = parsePlan('I will refactor the router and then clean up the tests.');
    expect(plan.executable).toBe(false);
    expect(plan.reason).toContain('step list');
  });

  it('refuses a list too vague to follow', () => {
    const plan = parsePlan('1. Refactor the router\n2. Clean up\n3. Improve things');
    expect(plan.executable).toBe(false);
    expect(plan.reason).toContain('files');
  });

  it('tells the executor to stop rather than improvise', () => {
    const prompt = executePrompt('make it faster', parsePlan(goodPlan), 'claude:personal/opus');
    expect(prompt).toContain('claude:personal/opus');
    expect(prompt).toContain('src/router/autoRoute.ts');
    expect(prompt).toMatch(/do not redesign/i);
    expect(prompt).toMatch(/stop and say which step/i);
  });

  it('executes one tier below the planner', () => {
    expect(executorTier('heavy')).toBe('standard');
    expect(executorTier('standard')).toBe('light');
  });

  it('only moves the work to an account with real room', () => {
    const planner: Target = { provider: 'claude', account: 'personal' };
    const candidates: Target[] = [planner, { provider: 'codex', account: 'personal' }];
    expect(pickExecutor(planner, candidates, { 'codex:personal': 70 })?.provider).toBe('codex');
    expect(pickExecutor(planner, candidates, { 'codex:personal': 20 })).toBeUndefined();
    expect(pickExecutor(planner, [planner], { 'claude:personal': 90 })).toBeUndefined();
  });
});

describe('learning the instructions', () => {
  const correction = (text: string, at: number, provider = 'claude') => ({
    text,
    timestamp: at,
    provider,
  });

  it('proposes a rule only once the same correction recurs', () => {
    const once = suggestRules([correction('always write the tests first', 1)]);
    expect(once).toHaveLength(0);

    const twice = suggestRules([
      correction('always write the tests first', 1),
      correction('please always write the tests first before the code', 2),
    ]);
    expect(twice).toHaveLength(1);
    expect(twice[0]!.support).toBe(2);
  });

  it('keeps the fullest phrasing of a cluster', () => {
    const rules = suggestRules([
      correction('answer in turkish', 1),
      correction('answer in turkish please, always turkish', 2),
    ]);
    expect(rules[0]!.text).toBe('answer in turkish please, always turkish');
  });

  it('ignores corrections about one specific file', () => {
    const rules = suggestRules([
      correction('fix the bug in autoRoute.ts instead', 1),
      correction('the bug is in autoRoute.ts not there', 2),
    ]);
    expect(rules).toHaveLength(0);
  });

  it('ignores corrections too short to generalize', () => {
    expect(suggestRules([correction('no', 1), correction('no', 2)])).toHaveLength(0);
  });

  it('scores overlap between differently worded corrections', () => {
    expect(
      correctionSimilarity('always run the tests after editing', 'run the tests after you edit'),
    ).toBeGreaterThan(0.4);
    expect(correctionSimilarity('answer in turkish', 'deploy to production')).toBe(0);
  });

  it('drops a brief line that measurably hurts', () => {
    const metric = (id: number, lines: string[], clean: boolean): TaskMetric => ({
      id: String(id),
      timestamp: id,
      conversationId: 'c',
      provider: 'gemini',
      account: 'personal',
      status: clean ? 'success' : 'error',
      briefLineIds: lines,
    });
    const metrics: TaskMetric[] = [
      ...Array.from({ length: 10 }, (_, i) => metric(i, ['bad-line'], false)),
      ...Array.from({ length: 10 }, (_, i) => metric(100 + i, ['other'], true)),
    ];
    expect(judgeLine(trialFor('bad-line', metrics)).harmful).toBe(true);
    expect(disqualifiedLines(['bad-line', 'other'], metrics)).toEqual(['bad-line']);
  });

  it('says nothing until both arms have enough runs', () => {
    const verdict = judgeLine({
      id: 'x',
      withLine: { runs: 3, clean: 0 },
      withoutLine: { runs: 40, clean: 40 },
    });
    expect(verdict.conclusive).toBe(false);
    expect(verdict.harmful).toBe(false);
  });
});
