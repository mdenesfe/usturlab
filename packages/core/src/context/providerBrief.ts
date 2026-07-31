import type { PermissionMode, ProviderId } from '../types.js';

/**
 * Per-provider system brief.
 *
 * Claude Code ships with a long, carefully tuned system prompt; the other CLIs
 * are thinner. Sending all four the same words does not level them — what
 * levels them is telling each one the thing *it* does not do by default.
 *
 * Every line here is compensation for an observed gap, not general advice, and
 * every line is A/B-able: `BRIEF_LINES` is keyed so the learning loop can
 * measure whether a line actually improves the clean-run rate and drop it if
 * it does not.
 */

export interface BriefLine {
  /** Stable key — the unit the learning loop measures. */
  id: string;
  text: string;
}

/** Applies to every provider: the house style of this extension. */
const UNIVERSAL: BriefLine[] = [
  {
    id: 'assume-over-ask',
    text:
      'If a detail is ambiguous but a careful colleague would pick the obvious reading, pick it, ' +
      'state the assumption in one line, and continue. Only stop and ask when proceeding either ' +
      'way would be unsafe or would waste the work if wrong.',
  },
  {
    id: 'report-honestly',
    text:
      'Report what actually happened. If a command failed, show its output. If you skipped part ' +
      'of the task, say so and why. Never describe work as done that you did not verify.',
  },
  {
    id: 'match-surroundings',
    text:
      'Match the conventions of the code you are editing — its naming, comment density and idiom — ' +
      'rather than importing a different house style.',
  },
];

/**
 * What each CLI does not reliably do on its own. Claude Code already does all
 * of these, so its list is the shortest — that is the point.
 */
const PER_PROVIDER: Record<ProviderId, BriefLine[]> = {
  claude: [],
  codex: [
    {
      id: 'codex-read-first',
      text: 'Read a file before you edit it. Do not patch from memory of what it probably contains.',
    },
    {
      id: 'codex-verify',
      text:
        "After changing code, run the project's own check (its test or build script) and report the " +
        'real result.',
    },
  ],
  gemini: [
    {
      id: 'gemini-read-first',
      text: 'Read a file before you edit it. Do not patch from memory of what it probably contains.',
    },
    {
      id: 'gemini-full-answer',
      text:
        'Finish the whole request before replying. Do not stop after the first step to ask whether ' +
        'to continue.',
    },
    {
      id: 'gemini-no-preamble',
      text: 'Skip preamble and restatement of the question — start with the work.',
    },
  ],
  copilot: [
    {
      id: 'copilot-read-first',
      text: 'Read a file before you edit it. Do not patch from memory of what it probably contains.',
    },
    {
      id: 'copilot-full-answer',
      text:
        'Finish the whole request before replying. Do not stop after the first step to ask whether ' +
        'to continue.',
    },
  ],
};

/** Permission mode is a hard constraint; every provider is told the same one. */
const PERMISSION_LINES: Record<PermissionMode, BriefLine> = {
  safe: {
    id: 'mode-safe',
    text:
      'You are in plan mode: investigate and propose, but do not modify files or run commands that ' +
      'change state. End with the plan you would carry out.',
  },
  edits: {
    id: 'mode-edits',
    text:
      'You may edit files in this workspace. Do not run destructive commands, push, or touch ' +
      'anything outside it without saying so first.',
  },
  full: {
    id: 'mode-full',
    text: 'You may edit files and run commands. Still confirm before anything irreversible or outward-facing.',
  },
};

export interface ProviderBriefOptions {
  provider: ProviderId;
  permissionMode: PermissionMode;
  /** Durable rules learned from the user's own corrections. */
  preferences?: string[];
  /** Line ids the learning loop has disqualified. */
  disabledLineIds?: string[];
}

/** The lines that would go into this brief, before rendering. */
export function briefLinesFor(options: ProviderBriefOptions): BriefLine[] {
  const disabled = new Set(options.disabledLineIds ?? []);
  const lines = [
    ...UNIVERSAL,
    ...PER_PROVIDER[options.provider],
    PERMISSION_LINES[options.permissionMode],
  ].filter((line) => !disabled.has(line.id));

  for (const [i, preference] of (options.preferences ?? []).entries()) {
    if (preference.trim()) lines.push({ id: `pref-${i}`, text: preference.trim() });
  }
  return lines;
}

export function buildProviderBrief(options: ProviderBriefOptions): string {
  const lines = briefLinesFor(options);
  if (lines.length === 0) return '';
  return lines.map((line) => `- ${line.text}`).join('\n');
}

export const UNIVERSAL_BRIEF_LINES = UNIVERSAL;
export const PROVIDER_BRIEF_LINES = PER_PROVIDER;
export const PERMISSION_BRIEF_LINES = PERMISSION_LINES;
