import { describe, expect, it } from 'vitest';
import { parseMention, matchesRule } from '../src/router/matcher.js';
import { route } from '../src/router/router.js';
import { QuotaTracker } from '../src/quota/quotaTracker.js';
import type { RulesFile, Rule } from '../src/rules/schema.js';
import type { AccountProfile, TaskRequest } from '../src/types.js';

const accounts: AccountProfile[] = [
  { id: 'claude-personal', provider: 'claude', label: 'personal', authMode: 'oauth-token', hasSecret: true, priority: 1 },
  { id: 'claude-work', provider: 'claude', label: 'work', authMode: 'oauth-token', hasSecret: true, priority: 2 },
  { id: 'codex-work', provider: 'codex', label: 'work', authMode: 'managed-home', homeDir: '/tmp/x', hasSecret: false, priority: 3 },
];

const task = (overrides: Partial<TaskRequest> = {}): TaskRequest => ({
  conversationId: 'c1',
  prompt: 'hello world',
  cwd: '/tmp',
  permissionMode: 'safe',
  ...overrides,
});

const rules = (overrides: Partial<RulesFile> = {}): RulesFile => ({
  version: 1,
  rules: [],
  defaultChain: [
    { provider: 'claude', account: 'personal', model: 'sonnet' },
    { provider: 'codex', account: 'work' },
  ],
  ...overrides,
});

describe('parseMention', () => {
  it('parses provider-only mention and strips it', () => {
    const r = parseMention('fix this @codex please');
    expect(r.mention).toEqual({ provider: 'codex', account: undefined, model: undefined });
    expect(r.cleaned).toBe('fix this please');
  });

  it('parses provider:account/model', () => {
    const r = parseMention('@claude:work/opus refactor the parser');
    expect(r.mention).toEqual({ provider: 'claude', account: 'work', model: 'opus' });
    expect(r.cleaned).toBe('refactor the parser');
  });

  it('ignores emails and mid-word @', () => {
    const r = parseMention('mail me at foo@claude.dev');
    expect(r.mention).toBeUndefined();
  });
});

describe('matchesRule', () => {
  const rule = (match: Rule['match']): Rule => ({ id: 'r', match, target: [{ provider: 'codex', account: 'work' }] });

  it('ORs values within a field', () => {
    const r = rule({ keywords: ['test', 'spec'] });
    expect(matchesRule(r, task({ prompt: 'write a spec for login' }))).toBe(true);
    expect(matchesRule(r, task({ prompt: 'refactor auth' }))).toBe(false);
  });

  it('ANDs across fields', () => {
    const r = rule({ keywords: ['test'], languages: ['typescript'] });
    expect(matchesRule(r, task({ prompt: 'add a test', languageId: 'typescript' }))).toBe(true);
    expect(matchesRule(r, task({ prompt: 'add a test', languageId: 'python' }))).toBe(false);
    expect(matchesRule(r, task({ prompt: 'add a test' }))).toBe(false);
  });

  it('matches globs against the active file', () => {
    const r = rule({ globs: ['**/*.test.*'] });
    expect(matchesRule(r, task({ activeFile: 'src/foo/bar.test.ts' }))).toBe(true);
    expect(matchesRule(r, task({ activeFile: 'src/foo/bar.ts' }))).toBe(false);
    expect(matchesRule(r, task({}))).toBe(false);
  });

  it('honors maxPromptChars', () => {
    const r = rule({ maxPromptChars: 10 });
    expect(matchesRule(r, task({ prompt: 'short' }))).toBe(true);
    expect(matchesRule(r, task({ prompt: 'a much longer prompt than ten chars' }))).toBe(false);
  });

  it('matches tags case-insensitively', () => {
    const r = rule({ tags: ['Tests'] });
    expect(matchesRule(r, task({ tags: ['tests'] }))).toBe(true);
    expect(matchesRule(r, task({ tags: ['docs'] }))).toBe(false);
  });
});

describe('route', () => {
  it('uses first matching rule and appends default chain as fallback', () => {
    const quota = new QuotaTracker();
    const r = route(
      task({ prompt: 'write a unit test for the parser' }),
      rules({
        rules: [
          { id: 'tests', match: { keywords: ['test'] }, target: [{ provider: 'codex', account: 'work' }] },
          { id: 'never', match: { keywords: ['test'] }, target: [{ provider: 'claude', account: 'work' }] },
        ],
      }),
      accounts,
      quota,
    );
    expect(r.decision.ruleId).toBe('tests');
    expect(r.decision.chain.map((t) => `${t.provider}:${t.account}`)).toEqual([
      'codex:work',
      'claude:personal',
    ]);
  });

  it('mention bypasses rules', () => {
    const quota = new QuotaTracker();
    const r = route(
      task({ prompt: '@claude:work write a test' }),
      rules({
        rules: [{ id: 'tests', match: { keywords: ['test'] }, target: [{ provider: 'codex', account: 'work' }] }],
      }),
      accounts,
      quota,
    );
    expect(r.decision.ruleId).toBeUndefined();
    expect(r.decision.chain[0]).toEqual({ provider: 'claude', account: 'work', model: undefined });
    expect(r.cleanedPrompt).toBe('write a test');
  });

  it('provider-only mention expands to accounts by priority before the fallback chain', () => {
    const quota = new QuotaTracker();
    const r = route(task({ prompt: '@claude hi' }), rules({ defaultChain: [] }), accounts, quota);
    expect(r.decision.chain.map((t) => `${t.provider}:${t.account}`)).toEqual([
      'claude:personal',
      'claude:work',
      'codex:work',
    ]);
  });

  it('skips accounts on cooldown and records the reason', () => {
    const quota = new QuotaTracker();
    quota.markLimitHit('claude-personal', { resetAt: Date.now() + 60_000 });
    const r = route(task(), rules(), accounts, quota, { mode: 'manual' });
    expect(r.decision.chain.map((t) => `${t.provider}:${t.account}`)).toEqual(['codex:work']);
    expect(r.decision.skipped.some((s) => s.reason.includes('cooldown'))).toBe(true);
  });

  it('skips unknown accounts', () => {
    const quota = new QuotaTracker();
    const r = route(
      task(),
      rules({ defaultChain: [{ provider: 'gemini', account: 'nope' }, { provider: 'codex', account: 'work' }] }),
      accounts,
      quota,
      { mode: 'manual' },
    );
    expect(r.decision.chain).toHaveLength(1);
    expect(r.decision.skipped[0]?.reason).toContain('no account');
  });

  it('falls back to priority order when no defaultChain configured', () => {
    const quota = new QuotaTracker();
    const r = route(task(), rules({ defaultChain: [] }), accounts, quota, { mode: 'manual' });
    expect(r.decision.chain.map((t) => `${t.provider}:${t.account}`)).toEqual([
      'claude:personal',
      'claude:work',
      'codex:work',
    ]);
  });
});
