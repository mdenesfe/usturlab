import { describe, expect, it } from 'vitest';
import { claudeUsage } from '../src/adapters/claude.js';
import { codexUsage } from '../src/adapters/codex.js';
import { formatCost, isMetered } from '../src/accounts/billing.js';
import { calculateStats } from '../src/quota/metricsSchema.js';
import type { TaskMetric } from '../src/quota/metricsSchema.js';

/**
 * What a run cost and what it read. Both numbers were wrong in ways that read
 * as plausible: tokens off by four orders of magnitude, and dollars that were
 * never charged to anyone. The payloads below are real CLI output, captured
 * from `claude -p --output-format json` and `codex exec --json`.
 */

describe('token accounting', () => {
  it('counts what Claude actually read, not what it was charged twice for', () => {
    // A real turn: two fresh input tokens against 18,726 read from cache.
    const usage = claudeUsage({
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 6088,
        cache_read_input_tokens: 18726,
        output_tokens: 4,
      },
    });
    expect(usage.inputTokens).toBe(24_816);
    expect(usage.outputTokens).toBe(4);
    expect(usage.cachedInputTokens).toBe(18_726);
  });

  it('reports nothing rather than zero when Claude says nothing', () => {
    expect(claudeUsage({})).toEqual({});
  });

  it('leaves Codex input alone — it already counts the cache', () => {
    const usage = codexUsage({
      input_tokens: 12_961,
      cached_input_tokens: 12_032,
      output_tokens: 5,
      reasoning_output_tokens: 0,
    });
    expect(usage.inputTokens).toBe(12_961);
    expect(usage.cachedInputTokens).toBe(12_032);
    expect(usage.outputTokens).toBe(5);
  });

  it('counts reasoning tokens as the output they are billed as', () => {
    const usage = codexUsage({ input_tokens: 100, output_tokens: 5, reasoning_output_tokens: 900 });
    expect(usage.outputTokens).toBe(905);
  });

  it('survives a provider that reports no usage at all', () => {
    expect(codexUsage(undefined)).toEqual({});
  });
});

describe('what a dollar figure means', () => {
  it('is money only when the account pays per token', () => {
    expect(isMetered({ authMode: 'api-key' })).toBe(true);
    expect(isMetered({ authMode: 'managed-home' })).toBe(false);
    expect(isMetered({ authMode: 'oauth-token' })).toBe(false);
  });

  it('marks an unbilled figure as an approximation, and silence as silence', () => {
    expect(formatCost(0.42, true)).toBe('$0.42');
    expect(formatCost(0.42, false)).toBe('~$0.42');
    expect(formatCost(undefined, true)).toBe('—');
  });

  it('does not round a sub-cent run down to nothing', () => {
    expect(formatCost(0.004, false)).toBe('~$0.004');
    expect(formatCost(0, false)).toBe('~$0.00');
  });
});

describe('cost aggregation', () => {
  const metric = (over: Partial<TaskMetric>): TaskMetric => ({
    id: 'm',
    timestamp: 1,
    conversationId: 'c',
    provider: 'claude',
    account: 'personal',
    status: 'success',
    ...over,
  });

  it('never adds a bill to a hypothetical', () => {
    const stats = calculateStats([
      metric({ costUsd: 1, metered: true }),
      metric({ costUsd: 0.5, metered: false }),
      metric({ costUsd: 0.25, metered: false }),
    ]);
    expect(stats.billedCost).toBe(1);
    expect(stats.equivalentCost).toBe(0.75);
  });

  it('tells "reported zero" apart from "reported nothing"', () => {
    expect(calculateStats([metric({ provider: 'gemini' })]).costReported).toBe(false);
    expect(calculateStats([metric({ costUsd: 0, metered: false })]).costReported).toBe(true);
  });

  it('counts the tokens a run really used', () => {
    const stats = calculateStats([metric({ inputTokens: 24_816, outputTokens: 4 })]);
    expect(stats.totalTokens).toBe(24_820);
  });
});
