import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GeminiAdapter } from '../src/adapters/gemini.js';
import type { ResolvedAccount } from '../src/types.js';

describe('gemini account wiring', () => {
  const adapter = new GeminiAdapter();
  const account = (over: Partial<ResolvedAccount>): ResolvedAccount => ({
    id: 'g', provider: 'gemini', label: 'main', authMode: 'managed-home',
    hasSecret: false, priority: 1, ...over,
  });

  it('isolates an api-key account and selects the api-key auth type', () => {
    const home = mkdtempSync(join(tmpdir(), 'usturlab-gem-'));
    const env = adapter.buildEnv(account({ authMode: 'api-key', secret: 'AIza-test', homeDir: home }), {
      GEMINI_API_KEY: 'stale-leak', HOME: '/real/home',
    });
    expect(env.GEMINI_API_KEY).toBe('AIza-test');
    expect(env.HOME).toBe(home);
    expect(env.GEMINI_CLI_TRUST_WORKSPACE).toBe('true');
    const settings = JSON.parse(readFileSync(join(home, '.gemini', 'settings.json'), 'utf8'));
    expect(settings.selectedAuthType).toBe('gemini-api-key');
    expect(settings.security.auth.selectedType).toBe('gemini-api-key');
    expect(settings.contextFileName).toContain('AGENTS.md');
  });

  it('keeps oauth profiles on the google login type', () => {
    const home = mkdtempSync(join(tmpdir(), 'usturlab-gem-'));
    adapter.buildEnv(account({ homeDir: home }), {});
    const settings = JSON.parse(readFileSync(join(home, '.gemini', 'settings.json'), 'utf8'));
    expect(settings.selectedAuthType).toBe('oauth-personal');
  });
});
