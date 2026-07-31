import type { TaskRequest } from '../types.js';

/**
 * Understand the request before routing it: what kind of work is this, and
 * how heavy is it? Deliberately transparent heuristics — the user can read
 * every signal in the routing badge and override it with a rule or a mention.
 */

export type TaskKind =
  | 'question'
  | 'explain'
  | 'edit'
  | 'debug'
  | 'test'
  | 'review'
  | 'refactor'
  | 'docs'
  | 'agentic';

export type Complexity = 'trivial' | 'simple' | 'moderate' | 'hard';

export interface Classification {
  kind: TaskKind;
  complexity: Complexity;
  /** Human-readable reasons, shown in the UI so routing is never a black box. */
  signals: string[];
  /** True when the task edits/creates code rather than only answering. */
  writesCode: boolean;
}

const KIND_PATTERNS: Array<{ kind: TaskKind; writes: boolean; re: RegExp }> = [
  { kind: 'test', writes: true, re: /\b(test|tests|spec|unit test|coverage|vitest|jest|pytest)\b/i },
  { kind: 'review', writes: false, re: /\b(review|audit|security|vulnerab|code smell|critique)\b/i },
  { kind: 'debug', writes: true, re: /\b(debug|bug|error|crash|fails?|failing|broken|stack trace|exception|traceback)\b/i },
  { kind: 'refactor', writes: true, re: /\b(refactor|clean ?up|simplify|restructure|rename|extract|migrate|modernize)\b/i },
  { kind: 'docs', writes: true, re: /\b(document|docs|readme|changelog|comment|jsdoc|docstring)\b/i },
  { kind: 'explain', writes: false, re: /\b(explain|how does|what does|why does|walk me through|understand|anlat|açıkla|nedir)\b/i },
  { kind: 'edit', writes: true, re: /\b(add|implement|create|write|build|fix|change|update|support|optimi[sz]e|improve|speed up|port|convert|ekle|yaz|düzelt|uygula|iyile[şs]tir)\b/i },
];

const AGENTIC_RE =
  /\b(and then|after that|step by step|for (each|every) file|across the (repo|codebase)|entire (repo|codebase|project)|all (the )?(files|tests|packages)|end.to.end|migrate .* to|set up|scaffold)\b/i;

const HARD_RE =
  /\b(architect|design|redesign|optimi[sz]e|performance|concurren|race condition|memory leak|security|protocol|algorithm|complex|tricky|deadlock|scal(e|ing)|refactor .* (whole|entire)|root cause)\b/i;

const TRIVIAL_RE =
  /\b(typo|rename|format|prettier|lint|one.?liner|bump|version|import|semicolon|whitespace)\b/i;

const QUESTION_RE = /^(what|who|when|where|which|why|how|is|are|can|does|do|should|could)\b|\?\s*$/i;

export function classifyTask(task: TaskRequest): Classification {
  const prompt = task.prompt.trim();
  const lower = prompt.toLowerCase();
  const signals: string[] = [];

  // ── kind ──────────────────────────────────────────────
  let kind: TaskKind = 'question';
  let writesCode = false;
  for (const entry of KIND_PATTERNS) {
    if (entry.re.test(lower)) {
      kind = entry.kind;
      writesCode = entry.writes;
      signals.push(entry.kind);
      break;
    }
  }
  if (kind === 'question' && QUESTION_RE.test(prompt)) signals.push('question');

  const multiStep = AGENTIC_RE.test(lower);
  if (multiStep) {
    kind = 'agentic';
    writesCode = true;
    signals.push('multi-step');
  }

  // ── complexity ────────────────────────────────────────
  let score = 0;
  const words = prompt.split(/\s+/).length;
  if (words > 120) {
    score += 2;
    signals.push('long prompt');
  } else if (words > 40) {
    score += 1;
  } else if (words <= 8) {
    score -= 1;
    signals.push('short prompt');
  }

  if (HARD_RE.test(lower)) {
    score += 2;
    signals.push('hard topic');
  }
  if (TRIVIAL_RE.test(lower)) {
    score -= 2;
    signals.push('mechanical');
  }
  if (multiStep) score += 2;
  if (writesCode) score += 1;
  if (/```/.test(prompt)) {
    score += 1;
    signals.push('code block');
  }
  // Numbered or bulleted requirement lists mean several deliverables.
  const bulletCount = (prompt.match(/^\s*(?:[-*•]|\d+[.)])\s+/gm) ?? []).length;
  if (bulletCount >= 3) {
    score += 1;
    signals.push(`${bulletCount} requirements`);
  }
  if ((task.tags?.length ?? 0) > 0) signals.push(...task.tags!.map((t) => `#${t}`));
  if (kind === 'review' || kind === 'debug') score += 1;
  if (kind === 'explain' || kind === 'question') score -= 1;

  const complexity: Complexity =
    score <= -1 ? 'trivial' : score === 0 ? 'simple' : score <= 2 ? 'moderate' : 'hard';

  return { kind, complexity, signals: [...new Set(signals)].slice(0, 6), writesCode };
}
