import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { runAcp } from '../src/adapters/acp.js';
import { detectGeminiLimit } from '../src/adapters/limits.js';
import type { LiveRunHandle, RunRequest } from '../src/adapters/adapter.js';
import type { AdapterEvent, PermissionMode } from '../src/types.js';

/**
 * The ACP path (Gemini + Copilot) verified against a fake agent that speaks
 * the real protocol — so the logic is covered without a live account.
 */
const AGENT = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));

function run(
  prompt: string,
  opts: {
    handle?: LiveRunHandle;
    permissionMode?: PermissionMode;
    resumeSessionId?: string;
    askPermission?: boolean;
  } = {},
) {
  const req: RunRequest = {
    prompt,
    cwd: process.cwd(),
    permissionMode: opts.permissionMode ?? 'edits',
    handle: opts.handle,
    resumeSessionId: opts.resumeSessionId,
    askPermission: opts.askPermission,
  };
  return runAcp({
    command: process.execPath,
    args: [AGENT],
    env: process.env,
    req,
    signal: new AbortController().signal,
    detectLimit: detectGeminiLimit,
  });
}

async function collect(gen: AsyncGenerator<AdapterEvent>): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

describe('ACP adapter', () => {
  it('opens a session, streams text and completes', async () => {
    const events = await collect(run('hello'));
    expect(events[0]).toMatchObject({ type: 'session' });
    expect(events.filter((e) => e.type === 'text-delta')).not.toHaveLength(0);
    const result = events.at(-1) as Extract<AdapterEvent, { type: 'result' }>;
    expect(result.type).toBe('result');
    expect(result.text).toContain('done');
  });

  it('carries token usage off the prompt response when the agent reports it', async () => {
    const events = await collect(run('USAGE please'));
    const result = events.at(-1) as Extract<AdapterEvent, { type: 'result' }>;
    expect(result.usage).toEqual({
      inputTokens: 9_200,
      outputTokens: 300,
      cachedInputTokens: 8_000,
    });
  });

  it('reports no usage for an agent that sends none', async () => {
    const events = await collect(run('hello'));
    const result = events.at(-1) as Extract<AdapterEvent, { type: 'result' }>;
    expect(result.usage).toBeUndefined();
  });

  it('surfaces tool calls with their detail', async () => {
    const events = await collect(run('TOOL please'));
    const tool = events.find((e) => e.type === 'tool-use') as Extract<
      AdapterEvent,
      { type: 'tool-use' }
    >;
    expect(tool).toMatchObject({ name: 'Shell', detail: 'ls -la' });
  });

  it('answers permission requests from the mode, silently, when not asking', async () => {
    const granted = await collect(run('PERMISSION check', { permissionMode: 'edits' }));
    expect((granted.at(-1) as { text: string }).text).toContain('PERMISSION-GRANTED');

    const denied = await collect(run('PERMISSION check', { permissionMode: 'safe' }));
    expect((denied.at(-1) as { text: string }).text).toContain('PERMISSION-DENIED');

    // Nobody was interrupted: the mode decided, so no question was raised.
    for (const events of [granted, denied]) {
      expect(events.some((e) => e.type === 'permission')).toBe(false);
    }
  });

  it('raises the question instead when asking is on, and obeys the answer', async () => {
    const handle: LiveRunHandle = {};
    const events: AdapterEvent[] = [];
    for await (const ev of run('PERMISSION check', {
      permissionMode: 'edits',
      askPermission: true,
      handle,
    })) {
      events.push(ev);
      if (ev.type === 'permission') {
        expect(ev.request.kind).toBe('command');
        handle.respondPermission?.(ev.request.id, { outcome: 'deny' });
      }
    }
    expect(events.some((e) => e.type === 'permission')).toBe(true);
    expect(events.some((e) => e.type === 'permission-resolved')).toBe(true);
    // Denied even though the mode alone would have allowed it.
    expect((events.at(-1) as { text: string }).text).toContain('PERMISSION-DENIED');
  });

  it('delivers a mid-run message and answers it as its own turn', async () => {
    const handle: LiveRunHandle = {};
    const events: AdapterEvent[] = [];
    let injected = false;
    for await (const ev of run('SLOW essay', { handle })) {
      events.push(ev);
      if (!injected && ev.type === 'text-delta' && handle.inject) {
        injected = handle.inject('INJECTED follow-up');
      }
    }
    expect(injected).toBe(true);
    expect(handle.injectMode).toBe('turn');

    const results = events.filter((e) => e.type === 'result') as Array<{ text: string }>;
    expect(results).toHaveLength(2);
    // First turn keeps its partial output, the injected turn carries the answer.
    expect(results[0]!.text).toContain('one');
    expect(results[1]!.text).toContain('INJECTED-OK');
    // Protocol noise never reaches the transcript.
    expect(results.map((r) => r.text).join()).not.toContain('Operation cancelled');
  });

  it('resumes a known session and falls back to a fresh one otherwise', async () => {
    const resumed = await collect(run('hello', { resumeSessionId: 'fake-session-1' }));
    expect(resumed[0]).toMatchObject({ type: 'session', sessionId: 'fake-session-1' });

    const fresh = await collect(run('hello', { resumeSessionId: 'nope-not-a-session' }));
    expect((fresh[0] as { sessionId: string }).sessionId).toMatch(/^fake-session-/);
    expect(fresh.at(-1)).toMatchObject({ type: 'result' });
  });

  it('maps a quota failure to a limit event so failover can react', async () => {
    const events = await collect(run('LIMIT now'));
    expect(events.at(-1)).toMatchObject({ type: 'limit' });
  });

  it('reports a missing CLI as an error instead of hanging', async () => {
    const events = await collect(
      runAcp({
        command: '/nonexistent/usturlab-acp-agent',
        args: [],
        env: process.env,
        req: { prompt: 'hi', cwd: process.cwd(), permissionMode: 'safe' },
        signal: new AbortController().signal,
        detectLimit: detectGeminiLimit,
      }),
    );
    expect(events.at(-1)).toMatchObject({ type: 'error' });
    expect((events.at(-1) as { message: string }).message).toMatch(/not found/i);
  });
});
