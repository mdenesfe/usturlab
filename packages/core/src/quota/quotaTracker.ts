import type { LimitScope, ProviderId } from '../types.js';

export interface QuotaState {
  cooldowns: Record<string, { resetAt: number; scope?: LimitScope }>;
}

export interface QuotaPersistence {
  load(): QuotaState | undefined;
  save(state: QuotaState): void;
}

export interface UsageWindow {
  utilizationPct: number;
  resetAt?: number;
  label: string;
}

export interface AccountQuotaSnapshot {
  accountId: string;
  available: boolean;
  resetAt?: number;
  scope?: LimitScope;
  usage?: UsageWindow[];
}

const HOUR = 60 * 60 * 1000;

/** Fallback cooldown when the limit message carried no reset time. */
function defaultResetAt(provider: ProviderId | undefined, now: number): number {
  switch (provider) {
    case 'gemini': {
      // Daily quota; docs describe reset at 07:00 UTC.
      const reset = new Date(now);
      reset.setUTCHours(7, 0, 0, 0);
      if (reset.getTime() <= now) reset.setUTCDate(reset.getUTCDate() + 1);
      return reset.getTime();
    }
    case 'copilot':
      return now + 24 * HOUR;
    case 'openrouter': {
      // Free-tier request allowance is counted per UTC day.
      const reset = new Date(now);
      reset.setUTCHours(0, 0, 0, 0);
      reset.setUTCDate(reset.getUTCDate() + 1);
      return reset.getTime();
    }
    case 'claude':
    case 'codex':
    default:
      return now + HOUR;
  }
}

export class QuotaTracker {
  private cooldowns = new Map<string, { resetAt: number; scope?: LimitScope }>();
  private usage = new Map<string, UsageWindow[]>();
  private listeners = new Set<() => void>();

  constructor(
    private persistence?: QuotaPersistence,
    private now: () => number = () => Date.now(),
  ) {
    const state = persistence?.load();
    if (state) {
      for (const [id, cd] of Object.entries(state.cooldowns)) {
        this.cooldowns.set(id, cd);
      }
    }
  }

  markLimitHit(
    accountId: string,
    info: { resetAt?: number; scope?: LimitScope; provider?: ProviderId },
  ): void {
    const resetAt = info.resetAt ?? defaultResetAt(info.provider, this.now());
    this.cooldowns.set(accountId, { resetAt, scope: info.scope });
    this.persist();
    this.emit();
  }

  clear(accountId: string): void {
    if (this.cooldowns.delete(accountId)) {
      this.persist();
      this.emit();
    }
  }

  availability(accountId: string): { available: boolean; resetAt?: number } {
    const cd = this.cooldowns.get(accountId);
    if (!cd) return { available: true };
    if (cd.resetAt <= this.now()) {
      this.cooldowns.delete(accountId);
      this.persist();
      return { available: true };
    }
    return { available: false, resetAt: cd.resetAt };
  }

  /** Poller input: proactive usage windows (e.g. Claude 5h window utilization). */
  setUsage(accountId: string, windows: UsageWindow[]): void {
    this.usage.set(accountId, windows);
    this.emit();
  }

  snapshot(accountIds: string[]): AccountQuotaSnapshot[] {
    return accountIds.map((id) => {
      const avail = this.availability(id);
      const cd = this.cooldowns.get(id);
      return {
        accountId: id,
        available: avail.available,
        resetAt: avail.resetAt,
        scope: cd?.scope,
        usage: this.usage.get(id),
      };
    });
  }

  onDidChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private persist(): void {
    if (!this.persistence) return;
    const cooldowns: QuotaState['cooldowns'] = {};
    for (const [id, cd] of this.cooldowns) cooldowns[id] = cd;
    this.persistence.save({ cooldowns });
  }

  private emit(): void {
    for (const cb of this.listeners) cb();
  }
}
