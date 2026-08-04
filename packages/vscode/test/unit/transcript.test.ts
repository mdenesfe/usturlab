import { describe, expect, it } from 'vitest';
import {
  applyHostMessage,
  assistantText,
  compactLog,
  reduceTranscript,
  type TranscriptItem,
} from '../../src/panel/transcript.js';
import type { HostToWebview } from '../../src/panel/protocol.js';

const target = (account: string) => ({ provider: 'claude' as const, account });

function assistant(items: TranscriptItem[], index = -1) {
  const assistants = items.filter((i) => i.kind === 'assistant');
  const item = index === -1 ? assistants[assistants.length - 1] : assistants[index];
  return item as Extract<TranscriptItem, { kind: 'assistant' }>;
}

describe('transcript reducer', () => {
  it('builds a happy-path turn: echo → routing → deltas → done', () => {
    const log: HostToWebview[] = [
      { kind: 'userEcho', text: 'hello' },
      { kind: 'routing', messageId: 'm1', target: target('a'), ruleId: 'r1', reason: 'rule' },
      { kind: 'delta', messageId: 'm1', text: 'hi ' },
      { kind: 'delta', messageId: 'm1', text: 'there' },
      { kind: 'done', messageId: 'm1', costUsd: 0.01, durationMs: 1200 },
    ];
    const items = reduceTranscript(log);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ kind: 'user', text: 'hello' });
    const a = assistant(items);
    expect(assistantText(a)).toBe('hi there');
    expect(a.segments).toHaveLength(1);
    expect(a.target).toEqual(target('a'));
    expect(a.done).toBe(true);
    expect(a.durationMs).toBe(1200);
  });

  it('interleaves tool activity with text as an ordered timeline', () => {
    const log: HostToWebview[] = [
      { kind: 'delta', messageId: 'm1', text: 'let me check ' },
      { kind: 'toolUse', messageId: 'm1', name: 'Bash', detail: 'git diff' },
      { kind: 'toolUse', messageId: 'm1', name: 'Read' },
      { kind: 'delta', messageId: 'm1', text: 'found it' },
      { kind: 'toolUse', messageId: 'm1', name: 'Bash' },
      { kind: 'done', messageId: 'm1' },
    ];
    const a = assistant(reduceTranscript(log));
    expect(a.segments.map((s) => s.kind)).toEqual(['text', 'tools', 'text', 'tools']);
    const firstGroup = a.segments[1];
    if (firstGroup?.kind !== 'tools') throw new Error('expected tools segment');
    expect(firstGroup.steps).toEqual([
      { name: 'Bash', detail: 'git diff' },
      { name: 'Read', detail: undefined },
    ]);
    expect(assistantText(a)).toBe('let me check found it');
  });

  it('failover opens a new bubble; later deltas and done land on it', () => {
    const log: HostToWebview[] = [
      { kind: 'userEcho', text: 'q' },
      { kind: 'routing', messageId: 'm1', target: target('a'), reason: 'default' },
      { kind: 'delta', messageId: 'm1', text: 'partial from a' },
      { kind: 'failover', messageId: 'm1', from: target('a'), to: target('b'), reason: 'limit' },
      { kind: 'delta', messageId: 'm1', text: 'answer from b' },
      { kind: 'done', messageId: 'm1' },
    ];
    const items = reduceTranscript(log);
    expect(items.map((i) => i.kind)).toEqual(['user', 'assistant', 'failover', 'assistant']);

    const first = assistant(items, 0);
    const second = assistant(items, 1);
    expect(assistantText(first)).toBe('partial from a');
    // The abandoned attempt is finished, not still writing — nothing will ever
    // add to it again, and the banner underneath says why it stopped.
    expect(first.done).toBe(true);
    expect(assistantText(second)).toBe('answer from b');
    expect(second.target).toEqual(target('b'));
    expect(second.done).toBe(true);
  });

  it('renders notices, downgrades and errors as standalone rows', () => {
    const items = reduceTranscript([
      { kind: 'notice', text: 'opened accounts' },
      { kind: 'downgraded', messageId: 'm1', from: 'gpt-5.4', to: 'CLI default' },
      { kind: 'error', messageId: 'm1', message: 'boom' },
    ]);
    expect(items.map((i) => i.kind)).toEqual(['notice', 'notice', 'error']);
    expect(items[1]).toMatchObject({ text: expect.stringContaining('gpt-5.4') });
  });

  it('interleaved conversations keep deltas on their own messageId', () => {
    const items = reduceTranscript([
      { kind: 'delta', messageId: 'm1', text: 'one' },
      { kind: 'delta', messageId: 'm2', text: 'two' },
      { kind: 'delta', messageId: 'm1', text: ' more' },
      { kind: 'done', messageId: 'm2' },
    ]);
    expect(assistantText(assistant(items, 0))).toBe('one more');
    expect(assistantText(assistant(items, 1))).toBe('two');
    expect(assistant(items, 1).done).toBe(true);
    expect(assistant(items, 0).done).toBe(false);
  });

  it('agents whose lifetimes overlap share one segment — that is the fan-out', () => {
    const a = assistant(
      reduceTranscript([
        { kind: 'agentStart', messageId: 'm1', id: 'a1', label: 'read a', agentKind: 'Explore' },
        { kind: 'agentStart', messageId: 'm1', id: 'a2', label: 'read b', agentKind: 'Explore' },
        { kind: 'agentStart', messageId: 'm1', id: 'a3', label: 'read c' },
      ]),
    );
    expect(a.segments).toHaveLength(1);
    const segment = a.segments[0];
    if (segment?.kind !== 'agents') throw new Error('expected agents segment');
    expect(segment.lanes.map((l) => l.id)).toEqual(['a1', 'a2', 'a3']);
    expect(segment.lanes.every((l) => l.status === 'running')).toBe(true);
  });

  it('an agent started after the last one finished is a new segment, not a lane', () => {
    const a = assistant(
      reduceTranscript([
        { kind: 'agentStart', messageId: 'm1', id: 'a1', label: 'first' },
        { kind: 'agentEnd', messageId: 'm1', id: 'a1', status: 'completed' },
        { kind: 'agentStart', messageId: 'm1', id: 'a2', label: 'second' },
      ]),
    );
    expect(a.segments.map((s) => s.kind)).toEqual(['agents', 'agents']);
  });

  it('a subagent’s tool calls go to its lane, never the main timeline', () => {
    const a = assistant(
      reduceTranscript([
        { kind: 'toolUse', messageId: 'm1', name: 'Read', detail: 'main.ts' },
        { kind: 'agentStart', messageId: 'm1', id: 'a1', label: 'one' },
        { kind: 'agentStart', messageId: 'm1', id: 'a2', label: 'two' },
        { kind: 'toolUse', messageId: 'm1', name: 'Bash', detail: 'ls', agentId: 'a2' },
        { kind: 'toolUse', messageId: 'm1', name: 'Grep', detail: 'x', agentId: 'a1' },
        { kind: 'toolUse', messageId: 'm1', name: 'Read', detail: 'b.ts', agentId: 'a2' },
      ]),
    );
    expect(a.segments.map((s) => s.kind)).toEqual(['tools', 'agents']);
    const tools = a.segments[0];
    const agents = a.segments[1];
    if (tools?.kind !== 'tools' || agents?.kind !== 'agents') throw new Error('bad segments');
    // The main group keeps only what the main thread did.
    expect(tools.steps.map((s) => s.name)).toEqual(['Read']);
    expect(agents.lanes[0]!.steps.map((s) => s.name)).toEqual(['Grep']);
    expect(agents.lanes[1]!.steps.map((s) => s.name)).toEqual(['Bash', 'Read']);
  });

  it('an unknown agent id falls back to the timeline instead of vanishing', () => {
    const a = assistant(
      reduceTranscript([{ kind: 'toolUse', messageId: 'm1', name: 'Bash', agentId: 'ghost' }]),
    );
    expect(a.segments.map((s) => s.kind)).toEqual(['tools']);
  });

  it('progress updates a lane in place and keeps what the update left out', () => {
    const a = assistant(
      reduceTranscript([
        { kind: 'agentStart', messageId: 'm1', id: 'a1', label: 'work' },
        { kind: 'agentProgress', messageId: 'm1', id: 'a1', activity: 'searching', lastTool: 'Bash', tokens: 900 },
        { kind: 'agentProgress', messageId: 'm1', id: 'a1', activity: 'reading', toolUses: 2 },
      ]),
    );
    const segment = a.segments[0];
    if (segment?.kind !== 'agents') throw new Error('expected agents segment');
    expect(segment.lanes[0]).toMatchObject({
      status: 'running',
      activity: 'reading',
      lastTool: 'Bash',
      tokens: 900,
      toolUses: 2,
    });
  });

  it('ending a lane records the verdict and drops the live activity', () => {
    const a = assistant(
      reduceTranscript([
        { kind: 'agentStart', messageId: 'm1', id: 'a1', label: 'work' },
        { kind: 'agentProgress', messageId: 'm1', id: 'a1', activity: 'searching' },
        {
          kind: 'agentEnd',
          messageId: 'm1',
          id: 'a1',
          status: 'completed',
          summary: 'found it',
          durationMs: 4200,
        },
      ]),
    );
    const segment = a.segments[0];
    if (segment?.kind !== 'agents') throw new Error('expected agents segment');
    expect(segment.lanes[0]).toMatchObject({
      status: 'completed',
      summary: 'found it',
      durationMs: 4200,
    });
    expect(segment.lanes[0]!.activity).toBeUndefined();
  });

  it('an agent outlives the turn that spawned it, and reports back later', () => {
    // Claude launches agents asynchronously and answers again while they work,
    // so a finished turn says nothing about whether its agents are done.
    const items = reduceTranscript([
      { kind: 'agentStart', messageId: 'm1', id: 'a1', label: 'one' },
      { kind: 'agentStart', messageId: 'm1', id: 'a2', label: 'two' },
      { kind: 'delta', messageId: 'm1', text: 'both are running in the background' },
      { kind: 'done', messageId: 'm1' },
      { kind: 'agentEnd', messageId: 'm2', id: 'a1', status: 'completed', summary: 'a done' },
    ]);
    const a = assistant(items, 0);
    const segment = a.segments.find((s) => s.kind === 'agents');
    if (segment?.kind !== 'agents') throw new Error('expected agents segment');
    // The end arrived under a different message id and still found its lane.
    expect(segment.lanes.map((l) => l.status)).toEqual(['completed', 'running']);
    expect(segment.lanes[0]!.summary).toBe('a done');
  });

  it('an error ends the turn too — no bubble left thinking for ever', () => {
    const items = reduceTranscript([
      { kind: 'routing', messageId: 'm1', target: target('a'), reason: 'default' },
      { kind: 'error', messageId: 'm1', message: 'All 2 account(s) failed.' },
    ]);
    expect(items.map((i) => i.kind)).toEqual(['assistant', 'error']);
    expect(assistant(items).done).toBe(true);
    // It failed, it was not cancelled — the error row already says what happened.
    expect(assistant(items).stopped).toBeUndefined();
  });

  it('a stopped run ends the turn instead of streaming for ever', () => {
    // Nothing else ever marks a cancelled turn finished: it never reaches a
    // result, so without this the answer keeps a cursor blinking after it.
    const items = reduceTranscript([
      { kind: 'userEcho', text: 'go' },
      { kind: 'delta', messageId: 'm1', text: 'half an ans' },
      { kind: 'stopped', messageId: 'm1', reason: 'stopped by you' },
    ]);
    const a = assistant(items);
    expect(a.done).toBe(true);
    expect(a.stopped).toBe(true);
    expect(a.stoppedReason).toBe('stopped by you');
    expect(assistantText(a)).toBe('half an ans');
  });

  it('stopping before the model even answered still says so', () => {
    const items = reduceTranscript([
      { kind: 'userEcho', text: 'go' },
      { kind: 'stopped', messageId: 'm1', reason: 'stopped by you' },
    ]);
    expect(items.map((i) => i.kind)).toEqual(['user', 'notice']);
    expect(items[1]).toMatchObject({ text: 'stopped by you' });
  });

  it('a stopped turn takes its agents down with it', () => {
    const items = reduceTranscript([
      { kind: 'agentStart', messageId: 'm1', id: 'a1', label: 'one' },
      { kind: 'stopped', messageId: 'm1' },
    ]);
    const a = assistant(items);
    // The lane keeps the last thing the provider said, and the view reads it
    // as cut short because the conversation is no longer running.
    expect(a.done).toBe(true);
    expect(a.stopped).toBe(true);
    const segment = a.segments[0];
    if (segment?.kind !== 'agents') throw new Error('expected agents segment');
    expect(segment.lanes[0]!.status).toBe('running');
  });

  it('applyHostMessage does not mutate previous items', () => {
    const before = reduceTranscript([{ kind: 'delta', messageId: 'm1', text: 'a' }]);
    const snapshot = JSON.parse(JSON.stringify(before));
    applyHostMessage(before, { kind: 'delta', messageId: 'm1', text: 'b' });
    expect(before).toEqual(snapshot);
  });
});

describe('log compaction (stored-conversation hydration)', () => {
  const failoverLog: HostToWebview[] = [
    { kind: 'userEcho', text: 'q' },
    { kind: 'routing', messageId: 'm1', target: target('a'), reason: 'default' },
    { kind: 'delta', messageId: 'm1', text: 'a1 ' },
    { kind: 'delta', messageId: 'm1', text: 'a2' },
    { kind: 'toolUse', messageId: 'm1', name: 'Bash' },
    { kind: 'delta', messageId: 'm1', text: 'a3 ' },
    { kind: 'failover', messageId: 'm1', from: target('a'), to: target('b'), reason: 'limit' },
    { kind: 'delta', messageId: 'm1', text: 'b1 ' },
    { kind: 'delta', messageId: 'm1', text: 'b2' },
    { kind: 'done', messageId: 'm1' },
  ];

  it('merges consecutive deltas but never across tool or failover boundaries', () => {
    const compact = compactLog(failoverLog);
    const deltas = compact.filter((m) => m.kind === 'delta');
    expect(deltas.map((d) => (d as { text: string }).text)).toEqual(['a1 a2', 'a3 ', 'b1 b2']);
  });

  it('replaying a compacted log reproduces the exact transcript (timeline included)', () => {
    expect(reduceTranscript(compactLog(failoverLog))).toEqual(reduceTranscript(failoverLog));
  });

  it('a reopened conversation gets its fan-out back, lanes and all', () => {
    // What a stored conversation actually holds: the lanes and their verdicts,
    // but none of the live progress ticks.
    const log: HostToWebview[] = [
      { kind: 'userEcho', text: 'look at both' },
      { kind: 'agentStart', messageId: 'm1', id: 'a1', label: 'read a', agentKind: 'Explore' },
      { kind: 'agentStart', messageId: 'm1', id: 'a2', label: 'read b', agentKind: 'Explore' },
      { kind: 'toolUse', messageId: 'm1', name: 'Read', detail: 'a.txt', agentId: 'a1' },
      { kind: 'toolUse', messageId: 'm1', name: 'Read', detail: 'b.txt', agentId: 'a2' },
      { kind: 'agentEnd', messageId: 'm1', id: 'a1', status: 'completed', summary: 'alpha', durationMs: 900 },
      { kind: 'agentEnd', messageId: 'm1', id: 'a2', status: 'completed', summary: 'gamma', durationMs: 1300 },
      { kind: 'delta', messageId: 'm1', text: 'both read' },
      { kind: 'done', messageId: 'm1' },
    ];
    expect(reduceTranscript(compactLog(log))).toEqual(reduceTranscript(log));

    const item = reduceTranscript(log).find((i) => i.kind === 'assistant');
    if (item?.kind !== 'assistant') throw new Error('expected assistant');
    const segment = item.segments.find((s) => s.kind === 'agents');
    if (segment?.kind !== 'agents') throw new Error('expected agents segment');
    expect(segment.lanes).toHaveLength(2);
    expect(segment.lanes.map((l) => l.summary)).toEqual(['alpha', 'gamma']);
    expect(segment.lanes.flatMap((l) => l.steps.map((s) => s.detail))).toEqual(['a.txt', 'b.txt']);
  });

  it('does not merge deltas of different messages', () => {
    const log: HostToWebview[] = [
      { kind: 'delta', messageId: 'm1', text: 'x' },
      { kind: 'delta', messageId: 'm2', text: 'y' },
    ];
    expect(compactLog(log)).toHaveLength(2);
  });

  it('does not mutate the source log', () => {
    const log: HostToWebview[] = [
      { kind: 'delta', messageId: 'm1', text: 'x' },
      { kind: 'delta', messageId: 'm1', text: 'y' },
    ];
    compactLog(log);
    expect(log[0]).toMatchObject({ text: 'x' });
  });
});
