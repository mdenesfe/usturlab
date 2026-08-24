import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildChildEnv, terminalEnvOverrides } from '../src/accounts/env.js';
import { readCodexUsage } from '../src/quota/codexUsageReader.js';
import { fetchClaudeUsage } from '../src/quota/claudeUsagePoller.js';
import { parseMcpFile, syncMcpToProfile } from '../src/mcp/mcpSync.js';
import { spawnLines } from '../src/adapters/spawn.js';
import { parseCommandsFile, matchSlashCommand, expandSlashCommand } from '../src/commands/slashCommands.js';
import type { AccountProfile, ResolvedAccount } from '../src/types.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'usturlab-test-'));

const account = (over: Partial<ResolvedAccount> = {}): ResolvedAccount => ({
  id: 'a1',
  provider: 'claude',
  label: 'personal',
  authMode: 'oauth-token',
  hasSecret: true,
  priority: 1,
  secret: 'tok',
  ...over,
});

describe('env isolation', () => {
  it('scrubs hijacking vars and injects the right auth per provider', () => {
    const base = {
      ANTHROPIC_API_KEY: 'leak',
      OPENAI_API_KEY: 'leak',
      GEMINI_API_KEY: 'leak',
      GH_TOKEN: 'leak',
      PATH: '/usr/bin',
    };

    const claude = buildChildEnv(account(), base);
    expect(claude.ANTHROPIC_API_KEY).toBeUndefined();
    expect(claude.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok');
    expect(claude.PATH).toBe('/usr/bin');

    const codex = buildChildEnv(
      account({ provider: 'codex', authMode: 'managed-home', homeDir: '/p/codex' }),
      base,
    );
    expect(codex.OPENAI_API_KEY).toBeUndefined();
    expect(codex.CODEX_HOME).toBe('/p/codex');

    const gemini = buildChildEnv(
      account({ provider: 'gemini', authMode: 'managed-home', homeDir: '/p/gem' }),
      base,
    );
    expect(gemini.GEMINI_API_KEY).toBeUndefined();
    expect(gemini.HOME).toBe('/p/gem');
    expect(gemini.USERPROFILE).toBe('/p/gem');

    const copilot = buildChildEnv(
      account({ provider: 'copilot', authMode: 'managed-home', homeDir: '/p/cop' }),
      base,
    );
    expect(copilot.GH_TOKEN).toBeUndefined();
    expect(copilot.COPILOT_HOME).toBe('/p/cop');
  });

  it('api-key accounts get their key and keep it isolated per provider', () => {
    const env = buildChildEnv(account({ authMode: 'api-key', secret: 'sk-x' }), {});
    expect(env.ANTHROPIC_API_KEY).toBe('sk-x');
  });

  it('terminal overrides null out scrubbed vars so the shell cannot leak them', () => {
    const overrides = terminalEnvOverrides(account());
    expect(overrides.ANTHROPIC_API_KEY).toBeNull();
    expect(overrides.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok');
  });
});

describe('codex usage reader', () => {
  it('reads the newest rollout snapshot and labels windows', () => {
    const home = tmp();
    const day = join(home, 'sessions', '2026', '08', '01');
    mkdirSync(day, { recursive: true });
    writeFileSync(
      join(day, 'rollout-a.jsonl'),
      [
        JSON.stringify({ type: 'other' }),
        JSON.stringify({
          payload: {
            rate_limits: {
              primary: { used_percent: 12.4, window_minutes: 300, resets_at: 1788112674 },
              secondary: { used_percent: 40, window_minutes: 10080, resets_at: 1788212674 },
            },
          },
        }),
      ].join('\n'),
    );
    const windows = readCodexUsage(home);
    expect(windows).toHaveLength(2);
    expect(windows[0]).toMatchObject({ utilizationPct: 12, label: '5h window' });
    expect(windows[1]).toMatchObject({ utilizationPct: 40, label: 'weekly' });
    expect(windows[0]!.resetAt).toBe(1788112674 * 1000);
  });

  it('labels the free-plan 30-day window as monthly', () => {
    const home = tmp();
    const day = join(home, 'sessions', '2026', '08', '01');
    mkdirSync(day, { recursive: true });
    writeFileSync(
      join(day, 'r.jsonl'),
      JSON.stringify({ rate_limits: { primary: { used_percent: 4, window_minutes: 43200 } } }),
    );
    expect(readCodexUsage(home)[0]).toMatchObject({ utilizationPct: 4, label: 'monthly' });
  });

  it('returns nothing for a missing or snapshot-free profile', () => {
    expect(readCodexUsage(join(tmp(), 'nope'))).toEqual([]);
    const home = tmp();
    mkdirSync(join(home, 'sessions'), { recursive: true });
    writeFileSync(join(home, 'sessions', 'x.jsonl'), 'not json\n{"type":"turn"}');
    expect(readCodexUsage(home)).toEqual([]);
  });
});

describe('claude usage poller', () => {
  const fakeFetch = (body: unknown, ok = true) =>
    (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;

  it('parses the documented window shape', async () => {
    const windows = await fetchClaudeUsage('tok', {
      fetchImpl: fakeFetch({
        five_hour: { utilization: 72, resets_at: '2026-08-01T18:30:00Z' },
        seven_day: { utilization: 19, resets_at: '2026-08-07T01:00:00Z' },
      }),
    });
    expect(windows).toHaveLength(2);
    expect(windows[0]).toMatchObject({ utilizationPct: 72, label: '5h window' });
    expect(windows[0]!.resetAt).toBe(Date.parse('2026-08-01T18:30:00Z'));
  });

  it('falls back to a generic limits[] array', async () => {
    const windows = await fetchClaudeUsage('tok', {
      fetchImpl: fakeFetch({ limits: [{ kind: 'five_hour', percent: 5, resets_at: 1788112674 }] }),
    });
    expect(windows[0]).toMatchObject({ utilizationPct: 5, label: 'five hour' });
  });

  it('never throws on error responses or junk', async () => {
    expect(await fetchClaudeUsage('tok', { fetchImpl: fakeFetch({}, false) })).toEqual([]);
    expect(await fetchClaudeUsage('tok', { fetchImpl: fakeFetch({ nope: 1 }) })).toEqual([]);
  });
});

describe('mcp sync', () => {
  const servers = { ctx7: { command: 'npx', args: ['-y', 'pkg'], env: { A: '1' } } };

  it('parses server definitions and rejects malformed files', () => {
    const ok = parseMcpFile(JSON.stringify({ servers }));
    expect(ok.ok && Object.keys(ok.servers)).toEqual(['ctx7']);
    expect(parseMcpFile('{').ok).toBe(false);
    expect(parseMcpFile('{"servers": []}').ok).toBe(false);
  });

  it('writes each provider its native config shape', () => {
    const claudeHome = tmp();
    const profile = (over: Partial<AccountProfile>): AccountProfile => ({
      id: 'x',
      provider: 'claude',
      label: 'l',
      authMode: 'managed-home',
      hasSecret: false,
      priority: 1,
      ...over,
    });

    expect(syncMcpToProfile(profile({ homeDir: claudeHome }), servers)).toBeUndefined();
    const claudeCfg = JSON.parse(readFileSync(join(claudeHome, '.claude.json'), 'utf8'));
    expect(claudeCfg.mcpServers.ctx7).toMatchObject({ type: 'stdio', command: 'npx' });

    const geminiHome = tmp();
    syncMcpToProfile(profile({ provider: 'gemini', homeDir: geminiHome }), servers);
    const geminiCfg = JSON.parse(
      readFileSync(join(geminiHome, '.gemini', 'settings.json'), 'utf8'),
    );
    expect(geminiCfg.mcpServers.ctx7.command).toBe('npx');

    const codexHome = tmp();
    syncMcpToProfile(profile({ provider: 'codex', homeDir: codexHome }), servers);
    const toml = readFileSync(join(codexHome, 'config.toml'), 'utf8');
    expect(toml).toContain('[mcp_servers.ctx7]');
    expect(toml).toContain('usturlab-mcp-begin');
  });

  it('re-syncing replaces the managed codex block instead of appending', () => {
    const home = tmp();
    const p: AccountProfile = {
      id: 'x',
      provider: 'codex',
      label: 'l',
      authMode: 'managed-home',
      homeDir: home,
      hasSecret: false,
      priority: 1,
    };
    writeFileSync(join(home, 'config.toml'), 'model = "x"\n');
    syncMcpToProfile(p, servers);
    syncMcpToProfile(p, servers);
    const toml = readFileSync(join(home, 'config.toml'), 'utf8');
    expect(toml.match(/usturlab-mcp-begin/g)).toHaveLength(1);
    expect(toml).toContain('model = "x"');
  });

  it('preserves unrelated keys in JSON configs', () => {
    const home = tmp();
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ userID: 'keep-me' }));
    syncMcpToProfile(
      { id: 'x', provider: 'claude', label: 'l', authMode: 'managed-home', homeDir: home, hasSecret: false, priority: 1 },
      servers,
    );
    const cfg = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
    expect(cfg.userID).toBe('keep-me');
    expect(cfg.mcpServers.ctx7).toBeDefined();
  });
});

describe('custom slash commands', () => {
  it('parses valid entries and drops malformed ones', () => {
    const parsed = parseCommandsFile(
      JSON.stringify({
        commands: [
          { name: 'standup', template: 'Summarize {args}' },
          { name: 'Bad Name', template: 'x' },
          { name: 'no-template' },
          'nonsense',
        ],
      }),
    );
    expect(parsed.ok && parsed.commands.map((c) => c.name)).toEqual(['standup']);
  });

  it('custom commands win over built-ins and expand their args', () => {
    const custom = parseCommandsFile(
      JSON.stringify({ commands: [{ name: 'review', template: 'CUSTOM {args}' }] }),
    );
    if (!custom.ok) throw new Error('parse failed');
    const match = matchSlashCommand('/review the parser', custom.commands);
    expect(match?.cmd.template).toBe('CUSTOM {args}');
    expect(expandSlashCommand(match!.cmd, match!.args)).toBe('CUSTOM the parser');
  });

  it('built-in claude-native commands keep their passthrough flag', () => {
    expect(matchSlashCommand('/review')?.cmd.claudeNative).toBe(true);
    expect(matchSlashCommand('/commit')?.cmd.claudeNative).toBeUndefined();
    expect(matchSlashCommand('not a command')).toBeUndefined();
  });
});

describe('spawning a CLI that is a JavaScript file', () => {
  /**
   * A `.mjs` runs on its own only where a shebang and an exec bit both mean
   * something — so on Windows this is the difference between working and
   * `EFTYPE`, and it is why every fixture CLI in this suite can be spawned.
   */
  it('runs it through this Node instead of executing it', async () => {
    const dir = tmp();
    const script = join(dir, 'says-hello.mjs');
    writeFileSync(script, "process.stdout.write('hello ' + process.argv[2] + '\\n');");

    const lines: string[] = [];
    let exit: number | null | undefined;
    for await (const ev of spawnLines(script, ['world'], {
      cwd: dir,
      env: process.env,
      signal: new AbortController().signal,
    })) {
      if (ev.kind === 'line') lines.push(ev.line);
      if (ev.kind === 'exit') exit = ev.code;
      if (ev.kind === 'spawn-error') throw new Error(ev.message);
    }

    expect(lines).toEqual(['hello world']);
    expect(exit).toBe(0);
  });

  it('says which CLI is missing when there is no such binary', async () => {
    const messages: string[] = [];
    for await (const ev of spawnLines('usturlab-no-such-cli', [], {
      cwd: tmp(),
      env: process.env,
      signal: new AbortController().signal,
    })) {
      if (ev.kind === 'spawn-error') messages.push(ev.message);
    }

    expect(messages.join('\n')).toContain('usturlab-no-such-cli');
    expect(messages.join('\n')).toContain('on PATH');
  });

  it('lets Node report a script path that does not exist', async () => {
    const missing = join(tmp(), 'not-here.mjs');
    const output: string[] = [];
    let exit: number | null | undefined;
    for await (const ev of spawnLines(missing, [], {
      cwd: tmp(),
      env: process.env,
      signal: new AbortController().signal,
    })) {
      if (ev.kind === 'line') output.push(ev.line);
      if (ev.kind === 'exit') exit = ev.code;
    }

    // Node exists, so this is never a spawn error — it is Node telling us the
    // file it was handed is not there, and the path it names is the CLI's.
    expect(output.join('\n')).toContain('not-here.mjs');
    expect(exit).not.toBe(0);
  });
});
