import { minimatch } from 'minimatch';
import type { Rule } from '../rules/schema.js';
import type { ProviderId, TaskRequest } from '../types.js';

export interface Mention {
  provider: ProviderId;
  account?: string;
  model?: string;
}

const MENTION_RE = /(^|\s)@(claude|codex|gemini|copilot)(?::([\w.-]+))?(?:\/([\w.:-]+))?(?=\s|$)/;

/** `@codex`, `@claude:work`, `@gemini:main/gemini-2.5-pro` — strips the mention from the prompt. */
export function parseMention(prompt: string): { mention?: Mention; cleaned: string } {
  const m = MENTION_RE.exec(prompt);
  if (!m) return { cleaned: prompt };
  const mention: Mention = {
    provider: m[2] as ProviderId,
    account: m[3],
    model: m[4],
  };
  const cleaned = (prompt.slice(0, m.index) + ' ' + prompt.slice(m.index + m[0].length))
    .replace(/\s+/g, ' ')
    .trim();
  return { mention, cleaned };
}

/** Fields present are AND-ed; values within a field are OR-ed. */
export function matchesRule(rule: Rule, task: TaskRequest): boolean {
  const { match } = rule;
  const prompt = task.prompt.toLowerCase();

  if (match.keywords && !match.keywords.some((k) => prompt.includes(k.toLowerCase()))) {
    return false;
  }
  if (match.globs) {
    if (!task.activeFile) return false;
    if (!match.globs.some((g) => minimatch(task.activeFile!, g, { dot: true, nocase: true }))) {
      return false;
    }
  }
  if (match.languages) {
    if (!task.languageId) return false;
    if (!match.languages.some((l) => l.toLowerCase() === task.languageId!.toLowerCase())) {
      return false;
    }
  }
  if (match.tags) {
    const tags = (task.tags ?? []).map((t) => t.toLowerCase());
    if (!match.tags.some((t) => tags.includes(t.toLowerCase()))) return false;
  }
  if (match.maxPromptChars !== undefined && task.prompt.length > match.maxPromptChars) {
    return false;
  }
  return true;
}
