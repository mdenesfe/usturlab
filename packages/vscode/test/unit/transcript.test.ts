import { describe, expect, it } from 'vitest';
import {
  applyHostMessage,
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
      { kind: 'done', messageId: 'm1', costUsd: 0.01 },
    ];
    const items = reduceTranscript(log);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ kind: 'user', text: 'hello' });
    const a = assistant(items);
    expect(a.text).toBe('hi there');
    expect(a.target).toEqual(target('a'));
    expect(a.ruleId).toBe('r1');
    expect(a.done).toBe(true);
    expect(a.costUsd).toBe(0.01);
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
    const kinds = items.map((i) => i.kind);
    expect(kinds).toEqual(['user', 'assistant', 'failover', 'assistant']);

    const first = assistant(items, 0);
    const second = assistant(items, 1);
    expect(first.text).toBe('partial from a');
    expect(first.done).toBe(false);
    expect(second.text).toBe('answer from b');
    expect(second.target).toEqual(target('b'));
    expect(second.done).toBe(true);
  });

  it('collects tool chips with details and retries', () => {
    let items: TranscriptItem[] = [];
    items = applyHostMessage(items, { kind: 'toolUse', messageId: 'm1', name: 'shell', detail: 'git diff' });
    items = applyHostMessage(items, { kind: 'toolUse', messageId: 'm1', name: 'retry #2' });
    expect(assistant(items).tools).toEqual(['shell: git diff', 'retry #2']);
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
    expect(assistant(items, 0).text).toBe('one more');
    expect(assistant(items, 1).text).toBe('two');
    expect(assistant(items, 1).done).toBe(true);
    expect(assistant(items, 0).done).toBe(false);
  });
});

describe('log compaction (stored-conversation hydration)', () => {
  const failoverLog: HostToWebview[] = [
    { kind: 'userEcho', text: 'q' },
    { kind: 'routing', messageId: 'm1', target: target('a'), reason: 'default' },
    { kind: 'delta', messageId: 'm1', text: 'a1 ' },
    { kind: 'delta', messageId: 'm1', text: 'a2' },
    { kind: 'failover', messageId: 'm1', from: target('a'), to: target('b'), reason: 'limit' },
    { kind: 'delta', messageId: 'm1', text: 'b1 ' },
    { kind: 'delta', messageId: 'm1', text: 'b2' },
    { kind: 'done', messageId: 'm1' },
  ];

  it('merges consecutive deltas but never across a failover boundary', () => {
    const compact = compactLog(failoverLog);
    const deltas = compact.filter((m) => m.kind === 'delta');
    expect(deltas).toHaveLength(2);
    expect(deltas[0]).toMatchObject({ text: 'a1 a2' });
    expect(deltas[1]).toMatchObject({ text: 'b1 b2' });
  });

  it('replaying a compacted log reproduces the exact transcript', () => {
    expect(reduceTranscript(compactLog(failoverLog))).toEqual(reduceTranscript(failoverLog));
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
