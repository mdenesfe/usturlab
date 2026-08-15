import type { ProviderId } from '../types.js';
import { clipToTokens, estimateTokens, formatTokens } from './tokens.js';

/**
 * The task brief: everything the model should have known before it started.
 *
 * A weak model holding the open file and the diff beats a strong one guessing.
 * The router already decides *who* runs; this decides *what they know*.
 *
 * Three rules keep it honest:
 *  - Never repeat what a CLI already reads by itself. Claude loads CLAUDE.md,
 *    Codex loads AGENTS.md; sending those again wastes the window and teaches
 *    the model that the brief is filler.
 *  - Stay inside a budget. Sections are added by descending value and the
 *    first one that does not fit is dropped, not truncated mid-sentence.
 *  - Never say the same thing twice to the same session. A resumed session
 *    still holds every earlier turn, so re-sending an unchanged section does
 *    not inform it — it buries it under a stale copy of itself. `briefDelta`
 *    sends what moved and names what stopped applying.
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
  /** Total token budget for the whole brief. */
  budget?: number;
}

/** Token budget for the whole brief. */
export const DEFAULT_BRIEF_BUDGET = 1_500;

/**
 * Past this, the diff stops being context and becomes the conversation. The
 * model has the working tree on disk and a `git diff` of its own — handing it
 * the file list and letting it read what it needs is both cheaper and more
 * accurate than sending a wall it will skim.
 */
const DIFF_TOKEN_BUDGET = 700;

/**
 * A section of the brief. The id is what makes a delta possible: it is stable
 * across turns, so an unchanged section can be recognized and left unsaid.
 */
export interface BriefSection {
  id: string;
  title: string;
  body: string;
}

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

function clipLines(text: string, maxLines: number): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join('\n') + `\n… +${lines.length - maxLines} more lines`;
}

function listSection(
  id: string,
  title: string,
  items: string[] | undefined,
  max = 12,
): BriefSection | undefined {
  if (!items || items.length === 0) return undefined;
  const shown = items.slice(0, max);
  const extra = items.length > max ? `\n… +${items.length - max} more` : '';
  return { id, title, body: shown.map((i) => `- ${i}`).join('\n') + extra };
}

/** Per-file `+added −removed` tallies, parsed out of a unified diff. */
function diffFileStats(diff: string): Array<{ path: string; added: number; removed: number }> {
  const files: Array<{ path: string; added: number; removed: number }> = [];
  let current: { path: string; added: number; removed: number } | undefined;
  for (const line of diff.split('\n')) {
    const header = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
    if (header) {
      const path = header[1]!.trim();
      current = path === '/dev/null' ? undefined : { path, added: 0, removed: 0 };
      if (current) files.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) current.added++;
    else if (line.startsWith('-')) current.removed++;
  }
  return files;
}

/**
 * The diff section, or — when the diff is too big to be worth its window — the
 * map that replaces it. Just-in-time retrieval: hand over the identifiers and
 * let the model pull what it actually needs.
 */
function diffSection(diff: string, budget: number): BriefSection {
  const trimmed = diff.trim();
  const tokens = estimateTokens(trimmed);
  if (tokens <= budget) {
    return { id: 'diff', title: 'Current diff', body: '```diff\n' + clipLines(trimmed, 120) + '\n```' };
  }
  const files = diffFileStats(trimmed);
  if (files.length === 0) {
    return {
      id: 'diff',
      title: 'Current diff',
      body: '```diff\n' + clipToTokens(trimmed, budget) + '\n```',
    };
  }
  const lines = files
    .slice(0, 40)
    .map((f) => `- ${f.path} (+${f.added} −${f.removed})`)
    .join('\n');
  const extra = files.length > 40 ? `\n… +${files.length - 40} more files` : '';
  return {
    id: 'diff',
    title: 'Uncommitted work',
    body:
      `The working tree has ${files.length} changed file${files.length === 1 ? '' : 's'} — about ` +
      `${formatTokens(tokens)} tokens of diff, too much to send. Read the ones you need with ` +
      '`git diff -- <path>`:\n' +
      lines +
      extra,
  };
}

/**
 * Builds the brief's sections, in the order they earn their place.
 *
 * Ordering is the design: how to approach the task decides whether the run
 * needs a second attempt at all, so it leads and survives every budget; the
 * editor state is what the user is looking at right now and is useless a minute
 * later, so it comes next; repo conventions are stable and can be dropped when
 * the budget is tight because they are usually also on disk where the model can
 * read them.
 */
export function briefSections(input: BriefInput): BriefSection[] {
  const budget = input.budget ?? DEFAULT_BRIEF_BUDGET;
  const candidates: Array<BriefSection | undefined> = [];

  const shaping = (input.shaping ?? []).filter((line) => line.trim());
  if (shaping.length > 0) {
    candidates.push({
      id: 'shaping',
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
    candidates.push({ id: 'editor', title: 'Where the user is', body: lines.join('\n') });
  }

  candidates.push(listSection('open-files', 'Other open files', input.editor?.openFiles, 8));

  const repo = input.repo;
  if (repo?.branch || repo?.changedFiles?.length) {
    const lines: string[] = [];
    if (repo.branch) lines.push(`Branch: ${repo.branch}`);
    if (repo.changedFiles?.length) {
      lines.push('Uncommitted changes:');
      lines.push(...repo.changedFiles.slice(0, 20).map((f) => `- ${f}`));
      if (repo.changedFiles.length > 20) lines.push(`… +${repo.changedFiles.length - 20} more`);
    }
    candidates.push({ id: 'repo', title: 'Repository state', body: lines.join('\n') });
  }

  if (repo?.diff?.trim()) {
    candidates.push(diffSection(repo.diff, Math.min(DIFF_TOKEN_BUDGET, budget)));
  }

  const thread = input.thread;
  if (thread?.touchedFiles?.length || thread?.lastFailure) {
    const lines: string[] = [];
    if (thread.touchedFiles?.length) {
      lines.push(`Already touched in this conversation: ${thread.touchedFiles.join(', ')}`);
    }
    if (thread.lastFailure) lines.push(`An earlier attempt failed with: ${thread.lastFailure}`);
    candidates.push({ id: 'thread', title: 'This conversation so far', body: lines.join('\n') });
  }

  candidates.push(listSection('preferences', 'The user works this way', input.preferences, 20));

  // Conventions last: they are the largest and the most likely to already be
  // in the model's context or reachable on disk.
  for (const convention of input.conventions ?? []) {
    if (readsNatively(input.provider, convention.path)) continue;
    if (!convention.text.trim()) continue;
    candidates.push({
      id: `convention:${convention.path}`,
      title: `Project conventions (${convention.path})`,
      body: clipLines(convention.text.trim(), 120),
    });
  }

  const sections: BriefSection[] = [];
  let spent = 0;
  for (const section of candidates) {
    if (!section) continue;
    const cost = estimateTokens(`## ${section.title}\n${section.body}`) + 1;
    if (spent + cost > budget) continue;
    spent += cost;
    sections.push(section);
  }
  return sections;
}

function render(sections: BriefSection[]): string {
  return sections.map((s) => `## ${s.title}\n${s.body}`).join('\n\n');
}

/** The whole brief, for a model that has not been told any of it yet. */
export function renderBrief(sections: BriefSection[]): string {
  if (sections.length === 0) return '';
  const subject = sections.some((s) => s.id === 'shaping') ? 'the workspace and this task' : 'the workspace';
  return (
    `The following is context about ${subject}, provided automatically. ` +
    'Use it; do not restate it back to the user.\n\n' +
    render(sections)
  );
}

/** Builds and renders the brief in one step. */
export function buildBrief(input: BriefInput): string {
  return renderBrief(briefSections(input));
}

/**
 * What a session has already been told, keyed by section id. Bodies are kept
 * verbatim rather than hashed: they are small, and comparing them is the whole
 * job.
 */
export type BriefState = Record<string, string>;

export interface BriefDelta {
  /** What to actually send. Empty when the session is already up to date. */
  text: string;
  /** What the session will know once this is sent. */
  state: BriefState;
  /** Sections sent this turn — for logging and tests. */
  changed: string[];
  /** Sections that used to apply and no longer do. */
  dropped: string[];
}

/**
 * The brief a session has not heard yet.
 *
 * With no prior state this is the full brief. Otherwise it is the sections that
 * changed, plus one line naming the ones that stopped applying — silence would
 * leave the model believing a selection the user moved away from three turns
 * ago, which is the more expensive half of the bug.
 */
export function briefDelta(previous: BriefState | undefined, sections: BriefSection[]): BriefDelta {
  const state: BriefState = {};
  for (const s of sections) state[s.id] = s.body;

  if (!previous) {
    return {
      text: renderBrief(sections),
      state,
      changed: sections.map((s) => s.id),
      dropped: [],
    };
  }

  const changed = sections.filter((s) => previous[s.id] !== s.body);
  const dropped = Object.keys(previous).filter((id) => !(id in state));
  if (changed.length === 0 && dropped.length === 0) {
    return { text: '', state, changed: [], dropped: [] };
  }

  const parts: string[] = [
    'What changed in the workspace since your last message. Everything else still stands.',
  ];
  if (changed.length > 0) parts.push(render(changed));
  if (dropped.length > 0) {
    const titles = dropped.map((id) => droppedTitle(id, previous)).join(', ');
    parts.push(`## No longer applies\n${titles}`);
  }
  return { text: parts.join('\n\n'), state, changed: changed.map((s) => s.id), dropped };
}

/** A readable name for a section that is gone, without having kept its title. */
function droppedTitle(id: string, previous: BriefState): string {
  if (id.startsWith('convention:')) return `project conventions (${id.slice('convention:'.length)})`;
  const names: Record<string, string> = {
    shaping: 'how to approach this one',
    editor: 'where the user is',
    'open-files': 'other open files',
    repo: 'repository state',
    diff: 'the uncommitted diff',
    thread: 'this conversation so far',
    preferences: 'the user works this way',
  };
  return names[id] ?? (previous[id] ? id : id);
}

/** Prepends the brief to a prompt, or returns the prompt unchanged. */
export function withBrief(prompt: string, brief: string): string {
  if (!brief.trim()) return prompt;
  return `${brief}\n\n---\n\n${prompt}`;
}
