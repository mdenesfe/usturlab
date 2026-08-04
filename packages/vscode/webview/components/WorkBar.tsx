import { useEffect, useState } from 'preact/hooks';
import type { TranscriptItem } from '../../src/panel/transcript.js';
import { LiveDots, fileName, formatDuration } from './steps.js';

/**
 * What is happening right now, pinned above the composer.
 *
 * The transcript already shows the work, but it scrolls — and the moment you
 * scroll up to read something the run becomes invisible. This is the one line
 * that never moves: how long it has been going, and what it is doing.
 */

interface Work {
  state: 'thinking' | 'writing' | 'working' | 'agents' | 'blocked';
  detail?: string;
  agents?: number;
}

function describeWork(items: TranscriptItem[]): Work {
  // A pending question outranks everything: nothing is running until it is answered.
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind === 'permission' && !item.answered) {
      return { state: 'blocked', detail: item.request.title };
    }
    if (item?.kind === 'assistant') break;
  }

  const assistant = [...items].reverse().find((item) => item.kind === 'assistant');
  if (!assistant || assistant.kind !== 'assistant') return { state: 'thinking' };

  const running = assistant.segments
    .flatMap((segment) => (segment.kind === 'agents' ? segment.lanes : []))
    .filter((lane) => lane.status === 'running');
  if (running.length > 0) {
    return {
      state: 'agents',
      agents: running.length,
      detail:
        running.length === 1
          ? (running[0]!.activity ?? running[0]!.label)
          : running.map((lane) => lane.label).join(' · '),
    };
  }

  const last = assistant.segments[assistant.segments.length - 1];
  if (last?.kind === 'tools') {
    const step = last.steps[last.steps.length - 1];
    if (step) {
      return { state: 'working', detail: step.path ? fileName(step.path) : (step.detail ?? step.name) };
    }
  }
  if (last?.kind === 'text') return { state: 'writing' };
  return { state: 'thinking' };
}

const STATE_LABEL: Record<Work['state'], string> = {
  thinking: 'thinking',
  writing: 'writing',
  working: 'working',
  agents: 'agents',
  blocked: 'waiting for you',
};

export function WorkBar({ items, startedAt }: { items: TranscriptItem[]; startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const work = describeWork(items);
  const blocked = work.state === 'blocked';

  return (
    // The transcript is a log, so this is the one place a screen reader is told
    // what is going on — state changes only, never the streamed text.
    <div class={`workbar ${blocked ? 'blocked' : ''}`} role="status">
      <span class="workbar-state">
        {work.state === 'agents' && work.agents
          ? `${work.agents} agent${work.agents === 1 ? '' : 's'}`
          : STATE_LABEL[work.state]}
      </span>
      {!blocked && <LiveDots />}
      {work.detail && (
        <span class="workbar-detail" title={work.detail}>
          {work.detail}
        </span>
      )}
      <span class="workbar-time">{formatDuration(Math.max(0, now - startedAt))}</span>
      <span class="workbar-hint">Esc stops</span>
    </div>
  );
}
