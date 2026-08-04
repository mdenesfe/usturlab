import { useEffect, useRef, useState } from 'preact/hooks';
import type { ToolStep } from '../../src/panel/transcript.js';

/**
 * The pieces both the main timeline and the agent lanes draw. A subagent's
 * activity has to look exactly like the main thread's, or the panel reads as
 * two different products.
 */

export function LiveDots() {
  return (
    <span class="live-dots">
      <i />
      <i />
      <i />
    </span>
  );
}

// Deliberately basic glyphs: a webview cannot rely on any icon font.
export const ACTION_GLYPH: Record<string, string> = {
  read: '◇',
  write: '✚',
  edit: '✎',
  search: '⌕',
  run: '❯',
  fetch: '↓',
  task: '⚑',
  other: '·',
};

export const ACTION_LABEL: Record<string, string> = {
  read: 'read',
  write: 'wrote',
  edit: 'edited',
  search: 'searched',
  run: 'ran',
  fetch: 'fetched',
  task: 'agent',
  other: '',
};

export function fileName(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * Open while the work is live, closed once it is done — but the moment the
 * user clicks, it is theirs and we stop steering it.
 */
export function useAutoOpen(live: boolean) {
  const [open, setOpen] = useState(live);
  const touched = useRef(false);
  useEffect(() => {
    if (!touched.current) setOpen(live);
  }, [live]);
  return {
    open,
    onSummaryClick: (event: Event) => {
      // The `open` prop stays authoritative, so the native toggle must not race it.
      event.preventDefault();
      touched.current = true;
      setOpen((value) => !value);
    },
  };
}

/** "Bash ×36 · Read ×5 · Agent" style summary of a tool group. */
export function summarizeSteps(steps: ToolStep[]): string {
  const counts = new Map<string, number>();
  for (const step of steps) counts.set(step.name, (counts.get(step.name) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([name, n]) => (n > 1 ? `${name} ×${n}` : name))
    .join(' · ');
}

/**
 * Files the steps touched, newest last — the mini preview a collapsed row
 * shows so you can see what happened without opening anything.
 */
export function touchedFiles(steps: ToolStep[]): string[] {
  const seen: string[] = [];
  for (const step of steps) {
    if (!step.path) continue;
    const name = fileName(step.path);
    if (!seen.includes(name)) seen.push(name);
  }
  return seen;
}

/** One row: what was done, to which file, expandable to the content itself. */
export function ToolStepRow({ step }: { step: ToolStep }) {
  const action = step.action ?? 'other';
  const head = (
    <>
      <span class={`tool-step-action ${action}`} title={ACTION_LABEL[action] || undefined}>
        {ACTION_GLYPH[action] ?? '·'}
      </span>
      <span class="tool-step-name">{step.name}</span>
      <span class="tool-step-detail">{step.detail}</span>
    </>
  );
  if (!step.preview) {
    return <div class="tool-step">{head}</div>;
  }
  return (
    <details class="tool-step expandable">
      <summary class="tool-step-summary">{head}</summary>
      <pre class={`tool-step-preview ${action}`}>
        {action === 'edit'
          ? step.preview.split('\n').map((line, i) => (
              <div
                key={i}
                class={`diff-line ${line.startsWith('-') ? 'del' : line.startsWith('+') ? 'add' : ''}`}
              >
                {line || ' '}
              </div>
            ))
          : step.preview}
      </pre>
    </details>
  );
}
