import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { ClaudeAdapter } from '../src/adapters/claude.js';
import type { AdapterEvent, ResolvedAccount } from '../src/types.js';

/**
 * Subagent reporting, verified against a session a real `claude` actually
 * produced (recorded from 2.1.216 with two Explore agents launched in one
 * turn). Guessing the shape of this stream is exactly how the panel ends up
 * lying about what the model did.
 */
const CLI = fileURLToPath(new URL('./fixtures/fake-claude-cli.mjs', import.meta.url));
const STREAM = fileURLToPath(new URL('./fixtures/claude-parallel-agents.ndjson', import.meta.url));
/** The same CLI launching its agents asynchronously — a different shape entirely. */
const ASYNC_STREAM = fileURLToPath(new URL('./fixtures/claude-async-agents.ndjson', import.meta.url));

const ACCOUNT: ResolvedAccount = {
  id: 'claude-test',
  provider: 'claude',
  label: 'test',
  authMode: 'managed-home',
  hasSecret: false,
  priority: 0,
};

async function replay(stream = STREAM): Promise<AdapterEvent[]> {
  process.env.FAKE_CLAUDE_STREAM = stream;
  const adapter = new ClaudeAdapter(CLI);
  const events: AdapterEvent[] = [];
  for await (const ev of adapter.run(
    { prompt: 'go', cwd: process.cwd(), permissionMode: 'safe' },
    ACCOUNT,
    new AbortController().signal,
  )) {
    events.push(ev);
  }
  return events;
}

describe('claude adapter — subagents', () => {
  it('opens a lane per agent, with the model\'s own description and kind', async () => {
    const starts = (await replay()).filter((e) => e.type === 'agent-start');
    expect(starts).toHaveLength(2);
    expect(starts[0]).toMatchObject({
      label: 'Report contents of a.txt',
      agentKind: 'Explore',
      background: false,
    });
    expect(starts[1]).toMatchObject({ label: 'Report contents of b.txt', agentKind: 'Explore' });
    // Distinct ids, or every later event lands on the wrong lane.
    expect(starts[0]!.id).not.toBe(starts[1]!.id);
    expect(starts[0]!.prompt).toContain('a.txt');
  });

  it('spawning an agent does not also post a tool row for it', async () => {
    const tools = (await replay()).filter((e) => e.type === 'tool-use');
    expect(tools.map((t) => t.name)).not.toContain('Agent');
  });

  it('attributes each subagent tool call to the agent that made it', async () => {
    const events = await replay();
    const starts = events.filter((e) => e.type === 'agent-start');
    const tools = events.filter((e) => e.type === 'tool-use');
    const ids = new Set(starts.map((s) => s.id));

    // Nothing in this recording runs on the main thread, so every tool call
    // must carry an agent id — unattributed work is the bug this guards.
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.agentId, `${tool.name} lost its agent`).toBeDefined();
      expect(ids.has(tool.agentId!)).toBe(true);
    }
    const perAgent = new Map<string, string[]>();
    for (const tool of tools) {
      perAgent.set(tool.agentId!, [...(perAgent.get(tool.agentId!) ?? []), tool.name]);
    }
    expect(perAgent.size).toBe(2);
    for (const names of perAgent.values()) expect(names).toEqual(['Bash', 'Read']);
  });

  it('reports live progress while an agent works', async () => {
    const progress = (await replay()).filter((e) => e.type === 'agent-progress');
    expect(progress.length).toBeGreaterThan(0);
    const first = progress[0]!;
    expect(first.activity).toBeTruthy();
    expect(first.lastTool).toBe('Bash');
    expect(first.toolUses).toBeGreaterThan(0);
    expect(first.tokens).toBeGreaterThan(0);
  });

  it('ends every lane once, with its verdict, summary and totals', async () => {
    const events = await replay();
    const starts = events.filter((e) => e.type === 'agent-start');
    const ends = events.filter((e) => e.type === 'agent-end');

    expect(ends).toHaveLength(2);
    expect(new Set(ends.map((e) => e.id))).toEqual(new Set(starts.map((s) => s.id)));
    for (const end of ends) {
      expect(end.status).toBe('completed');
      expect(end.summary).toBeTruthy();
      expect(end.durationMs).toBeGreaterThan(0);
      expect(end.tokens).toBeGreaterThan(0);
    }
    // Every lane is opened before anything is said about it.
    const order = events.filter(
      (e) => e.type === 'agent-start' || e.type === 'agent-progress' || e.type === 'agent-end',
    );
    const opened = new Set<string>();
    for (const ev of order) {
      if (ev.type === 'agent-start') opened.add(ev.id);
      else expect(opened.has(ev.id)).toBe(true);
    }
  });

  it('still produces the turn\'s own answer', async () => {
    const result = (await replay()).find((e) => e.type === 'result');
    expect(result?.text).toBeTruthy();
  });
});

/**
 * Claude often launches agents asynchronously: the parent's tool_result comes
 * back immediately saying `async_launched`, and the agent reports for real much
 * later, sometimes several turns on. Reading that acknowledgement as an ending
 * closes the lane while the agent is still working — and because the lanes then
 * never overlap, the fan-out stops looking parallel at all.
 */
describe('claude adapter — asynchronously launched agents', () => {
  it('does not end a lane on the launch acknowledgement', async () => {
    const events = await replay(ASYNC_STREAM);
    const starts = events.filter((e) => e.type === 'agent-start');
    expect(starts).toHaveLength(3);

    // Every lane is still open when the next one is spawned: that overlap is
    // the only evidence the panel has that the agents ran side by side.
    const openAtSpawn: number[] = [];
    let open = 0;
    for (const ev of events) {
      if (ev.type === 'agent-start') openAtSpawn.push(++open);
      if (ev.type === 'agent-end') open--;
    }
    expect(openAtSpawn).toEqual([1, 2, 3]);
  });

  it('ends each lane on its real completion, with what it reported', async () => {
    const events = await replay(ASYNC_STREAM);
    const ends = events.filter((e) => e.type === 'agent-end');
    expect(ends).toHaveLength(3);
    for (const end of ends) {
      expect(end.status).toBe('completed');
      expect(end.summary).toBeTruthy();
      // The launch acknowledgement is the one thing that must never be the summary.
      expect(end.summary).not.toContain('async_launched');
      expect(end.summary).not.toContain('launched successfully');
    }
  });

  it('splits the subagents’ work from the main thread’s own', async () => {
    const events = await replay(ASYNC_STREAM);
    const ids = new Set(events.filter((e) => e.type === 'agent-start').map((e) => e.id));
    const tools = events.filter((e) => e.type === 'tool-use');

    const owned = tools.filter((t) => t.agentId);
    const main = tools.filter((t) => !t.agentId);
    // Here the parent kept working while its agents did — both are real, and
    // each has to land in its own place rather than one pile.
    expect(owned.length).toBeGreaterThan(0);
    expect(main.length).toBeGreaterThan(0);
    for (const tool of owned) expect(ids.has(tool.agentId!)).toBe(true);
    expect(new Set(owned.map((t) => t.agentId)).size).toBe(3);
    expect(main.map((t) => t.name)).not.toContain('Agent');
  });
});
