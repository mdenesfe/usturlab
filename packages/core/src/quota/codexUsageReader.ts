import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { UsageWindow } from './quotaTracker.js';

/**
 * Codex writes rate-limit snapshots into its session rollout files under
 * $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl. Reading the newest file is
 * a free, offline way to show 5h/weekly usage — no network, no extra quota.
 * Best-effort: any format drift returns [].
 */
export function readCodexUsage(codexHome: string): UsageWindow[] {
  try {
    const newest = newestJsonl(join(codexHome, 'sessions'), 4);
    if (!newest) return [];
    const lines = readFileSync(newest, 'utf8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0 && i >= lines.length - 300; i--) {
      const line = lines[i]!;
      if (!line.includes('rate_limit')) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const rl = deepFind(parsed, 'rate_limits', 6);
      if (rl) {
        const windows = toWindows(rl);
        if (windows.length > 0) return windows;
      }
    }
  } catch {
    // fall through
  }
  return [];
}

function newestJsonl(dir: string, depth: number): string | undefined {
  if (depth < 0) return undefined;
  let best: { path: string; mtime: number } | undefined;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      const nested = newestJsonl(full, depth - 1);
      if (nested) {
        const nestedMtime = statSync(nested).mtimeMs;
        if (!best || nestedMtime > best.mtime) best = { path: nested, mtime: nestedMtime };
      }
    } else if (entry.endsWith('.jsonl')) {
      if (!best || st.mtimeMs > best.mtime) best = { path: full, mtime: st.mtimeMs };
    }
  }
  return best?.path;
}

function deepFind(obj: unknown, key: string, depth: number): Record<string, unknown> | undefined {
  if (depth < 0 || obj === null || typeof obj !== 'object') return undefined;
  const record = obj as Record<string, unknown>;
  const direct = record[key];
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
    return direct as Record<string, unknown>;
  }
  for (const value of Object.values(record)) {
    const found = deepFind(value, key, depth - 1);
    if (found) return found;
  }
  return undefined;
}

function toWindows(rl: Record<string, unknown>): UsageWindow[] {
  const windows: UsageWindow[] = [];
  for (const [field, fallbackLabel] of [
    ['primary', '5h window'],
    ['secondary', 'weekly'],
  ] as const) {
    const w = rl[field];
    if (!w || typeof w !== 'object') continue;
    const win = w as Record<string, unknown>;
    const pct = win.used_percent;
    if (typeof pct !== 'number') continue;

    // Verified shapes: 300 (5h, paid plans) and 43200 (monthly, free plan).
    let label: string = fallbackLabel;
    if (typeof win.window_minutes === 'number') {
      const hours = Math.round(win.window_minutes / 60);
      if (hours >= 24 * 25) label = 'monthly';
      else if (hours >= 24 * 6) label = 'weekly';
      else label = `${hours}h window`;
    }
    let resetAt: number | undefined;
    if (typeof win.resets_in_seconds === 'number') resetAt = Date.now() + win.resets_in_seconds * 1000;
    else if (typeof win.resets_at === 'number') resetAt = win.resets_at * 1000;
    else if (typeof win.resets_at === 'string') {
      const t = Date.parse(win.resets_at);
      if (!Number.isNaN(t)) resetAt = t;
    }
    windows.push({ utilizationPct: Math.min(100, Math.round(pct)), resetAt, label });
  }
  return windows;
}
