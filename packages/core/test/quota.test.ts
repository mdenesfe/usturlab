import { describe, expect, it } from 'vitest';
import { QuotaTracker, type QuotaState } from '../src/quota/quotaTracker.js';

describe('QuotaTracker', () => {
  it('uses the parsed reset time when provided', () => {
    let now = 1000;
    const q = new QuotaTracker(undefined, () => now);
    q.markLimitHit('acct', { resetAt: 5000 });
    expect(q.availability('acct')).toEqual({ available: false, resetAt: 5000 });
    now = 5001;
    expect(q.availability('acct').available).toBe(true);
  });

  it('applies provider default cooldowns when no reset time parsed', () => {
    const base = Date.parse('2026-07-31T12:00:00Z');
    const q = new QuotaTracker(undefined, () => base);
    q.markLimitHit('claude-x', { provider: 'claude' });
    expect(q.availability('claude-x').resetAt).toBe(base + 3600_000);

    q.markLimitHit('gemini-x', { provider: 'gemini' });
    const geminiReset = new Date(q.availability('gemini-x').resetAt!);
    expect(geminiReset.getUTCHours()).toBe(7);
    expect(geminiReset.getTime()).toBeGreaterThan(base);
  });

  it('persists and restores cooldowns', () => {
    let stored: QuotaState | undefined;
    const persistence = {
      load: () => stored,
      save: (s: QuotaState) => {
        stored = s;
      },
    };
    const q1 = new QuotaTracker(persistence, () => 0);
    q1.markLimitHit('acct', { resetAt: 9999 });

    const q2 = new QuotaTracker(persistence, () => 0);
    expect(q2.availability('acct').available).toBe(false);

    const q3 = new QuotaTracker(persistence, () => 10_000);
    expect(q3.availability('acct').available).toBe(true);
  });

  it('notifies listeners and supports unsubscribe', () => {
    const q = new QuotaTracker();
    let calls = 0;
    const off = q.onDidChange(() => calls++);
    q.markLimitHit('a', { resetAt: Date.now() + 1000 });
    expect(calls).toBe(1);
    off();
    q.markLimitHit('b', { resetAt: Date.now() + 1000 });
    expect(calls).toBe(1);
  });

  it('exposes usage windows in snapshots', () => {
    const q = new QuotaTracker();
    q.setUsage('a', [{ utilizationPct: 72, label: '5h window' }]);
    const snap = q.snapshot(['a', 'b']);
    expect(snap[0]?.usage?.[0]?.utilizationPct).toBe(72);
    expect(snap[1]?.usage).toBeUndefined();
  });
});
