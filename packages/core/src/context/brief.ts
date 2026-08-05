import type { ProviderId } from '../types.js';

/**
 * The task brief: everything the model should have known before it started.
 *
 * A weak model holding the open file and the diff beats a strong one guessing.
 * The router already decides *who* runs; this decides *what they know*.
 *
 * Two rules keep it honest:
 *  - Never repeat what a CLI already reads by itself. Claude loads CLAUDE.md,
 *    Codex loads AGENTS.md; sending those again wastes the window and teaches
 *    the model that the brief is filler.
 *  - Stay inside a budget. Sections are added by descending value and the
 *    first one that does not fit is dropped, not truncated mid-sentence.
 */

export interface EditorContext {
  /** Path of the file in the foreground, workspace-relative. */
  activeFile?: string;
  languageId?: string;
  /** Text the user had selected when they sent the message. */
  selection?: string;
  /** 1-based line range of that selection. */
  selectionRange?: { start: number; end: number };
  /** Other files open in the editor, workspace-relative. */
  openFiles?: string[];
}

export interface RepoContext {
  branch?: string;
  /** Paths with uncommitted changes, workspace-relative. */
  changedFiles?: string[];
  /** `git diff` when it is small enough to be worth sending. */
  diff?: string;
}

/** Convention files, already read by the host. */
export interface ConventionSource {
  /** Workspace-relative path it came from. */
  path: string;
  text: string;
}

export interface ThreadContextSummary {
  /** Files this conversation has already touched. */
  touchedFiles?: string[];
  /** What went wrong earlier in this thread, so it is not repeated. */
  lastFailure?: string;
}

export interface BriefInput {
  provider: ProviderId;
  editor?: EditorContext;
  repo?: RepoContext;
  conventions?: ConventionSource[];
  thread?: ThreadContextSummary;
  /** Durable rules the user has confirmed — see the learned-instruction loop. */
  preferences?: string[];
  /** How to approach this particular request — see `shapeTask`. */
  shaping?: string[];
  /** Total character budget for the whole brief. */
  budget?: number;
}

export const DEFAULT_BRIEF_BUDGET = 6000;

/**
 * Convention files each CLI loads on its own. Anything listed here is dropped
 * from that provider's brief — it is already in its context.
 */
const NATIVE_CONVENTIONS: Record<ProviderId, string[]> = {
  claude: ['CLAUDE.md', 'AGENTS.md'],
  codex: ['AGENTS.md'],
  // Gemini reads AGENTS.md only because we seed its profile to; a profile
  // written before that migration will not, so keep supplying it.
  gemini: [],
  copilot: [],
  // Reads nothing from disk — it only ever sees the text it is handed.
  openrouter: [],
};

function fileNameOf(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] ?? path;
}

/** True when this provider loads that convention file by itself. */
export function readsNatively(provider: ProviderId, path: string): boolean {
  return NATIVE_CONVENTIONS[provider].includes(fileNameOf(path));
}

interface Section {
  title: string;
  body: string;
}

function clipLines(text: string, maxLines: number): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join('\n') + `\n… +${lines.length - maxLines} more lines`;
}

function listSection(title: string, items: string[] | undefined, max = 12): Section | undefined {
  if (!items || items.length === 0) return undefined;
  const shown = items.slice(0, max);
  const extra = items.length > max ? `\n… +${items.length - max} more` : '';
  return { title, body: shown.map((i) => `- ${i}`).join('\n') + extra };
}

/**
 * Builds the brief. Ordering is the design: how to approach the task decides
 * whether the run needs a second attempt at all, so it leads and survives every
 * budget; the editor state is what the user is looking at right now and is
 * useless a minute later, so it comes next; repo conventions are stable and can
 * be dropped when the budget is tight because they are usually also on disk
 * where the model can read them.
 */
export function buildBrief(input: BriefInput): string {
  const budget = input.budget ?? DEFAULT_BRIEF_BUDGET;
  const sections: Array<Section | undefined> = [];

  const shaping = (input.shaping ?? []).filter((line) => line.trim());
  if (shaping.length > 0) {
    sections.push({
      title: 'How to approach this one',
      body: shaping.map((line) => `- ${line}`).join('\n'),
    });
  }

  const editor = input.editor;
  if (editor?.activeFile) {
    const range = editor.selectionRange
      ? `:${editor.selectionRange.start}-${editor.selectionRange.end}`
      : '';
    const lines = [`Open in the editor: ${editor.activeFile}${range}`];
    if (editor.languageId) lines.push(`Language: ${editor.languageId}`);
    if (editor.selection?.trim()) {
      lines.push('Selected text:', '```', clipLines(editor.selection.trim(), 40), '```');
    }
    sections.push({ title: 'Where the user is', body: lines.join('\n') });
  }

  sections.push(listSection('Other open files', input.editor?.openFiles, 8));

  const repo = input.repo;
  if (repo?.branch || repo?.changedFiles?.length) {
    const lines: string[] = [];
    if (repo.branch) lines.push(`Branch: ${repo.branch}`);
    if (repo.changedFiles?.length) {
      lines.push('Uncommitted changes:');
      lines.push(...repo.changedFiles.slice(0, 20).map((f) => `- ${f}`));
      if (repo.changedFiles.length > 20) lines.push(`… +${repo.changedFiles.length - 20} more`);
    }
    sections.push({ title: 'Repository state', body: lines.join('\n') });
  }

  if (repo?.diff?.trim()) {
    sections.push({
      title: 'Current diff',
      body: '```diff\n' + clipLines(repo.diff.trim(), 120) + '\n```',
    });
  }

  const thread = input.thread;
  if (thread?.touchedFiles?.length || thread?.lastFailure) {
    const lines: string[] = [];
    if (thread.touchedFiles?.length) {
      lines.push(`Already touched in this conversation: ${thread.touchedFiles.join(', ')}`);
    }
    if (thread.lastFailure) lines.push(`An earlier attempt failed with: ${thread.lastFailure}`);
    sections.push({ title: 'This conversation so far', body: lines.join('\n') });
  }

  sections.push(listSection('The user works this way', input.preferences, 20));

  // Conventions last: they are the largest and the most likely to already be
  // in the model's context or reachable on disk.
  for (const convention of input.conventions ?? []) {
    if (readsNatively(input.provider, convention.path)) continue;
    if (!convention.text.trim()) continue;
    sections.push({
      title: `Project conventions (${convention.path})`,
      body: clipLines(convention.text.trim(), 120),
    });
  }

  const parts: string[] = [];
  let spent = 0;
  for (const section of sections) {
    if (!section) continue;
    const rendered = `## ${section.title}\n${section.body}`;
    if (spent + rendered.length > budget) continue;
    spent += rendered.length + 2;
    parts.push(rendered);
  }

  if (parts.length === 0) return '';
  const subject = shaping.length > 0 ? 'the workspace and this task' : 'the workspace';
  return (
    `The following is context about ${subject}, provided automatically. ` +
    'Use it; do not restate it back to the user.\n\n' +
    parts.join('\n\n')
  );
}

/** Prepends the brief to a prompt, or returns the prompt unchanged. */
export function withBrief(prompt: string, brief: string): string {
  if (!brief.trim()) return prompt;
  return `${brief}\n\n---\n\n${prompt}`;
}
