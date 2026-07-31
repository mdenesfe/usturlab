import type { Target } from '../types.js';
import type { Tier } from '../router/autoRoute.js';

/**
 * Plan with the expensive model, execute with the cheap one.
 *
 * Authoring a plan for hard work is genuinely hard. Carrying out a plan that
 * already names the files and the steps is not — and that asymmetry is the
 * whole efficiency argument for owning several subscriptions. Spend Opus once
 * on the thinking; let Haiku or Codex do the typing.
 *
 * The split only pays off when the plan is specific enough to follow, so the
 * planner is asked for a checkable list and the handoff is refused when what
 * came back is prose.
 */

export interface PlanStep {
  text: string;
  /** Files the step names, when it names any. */
  files: string[];
}

export interface ParsedPlan {
  steps: PlanStep[];
  /** Whether this is concrete enough to hand to a cheaper model. */
  executable: boolean;
  reason: string;
}

const STEP_RE = /^\s*(?:[-*]|\d+[.)])\s+(.*\S)\s*$/;
// Paths, roughly: a/b/c.ts, src/x, package.json — anything with a separator or
// a file extension is treated as naming a real thing.
const PATH_RE = /\b[\w.@-]+(?:\/[\w.@-]+)+(?:\.\w+)?\b|\b[\w-]+\.\w{1,5}\b/g;

const MIN_STEPS = 2;

/** Asks for a plan in the shape the executor can actually follow. */
export function planPrompt(task: string): string {
  return (
    `${task}\n\n---\n\n` +
    'Do not make the change yet. First investigate the codebase enough to be specific, then ' +
    'reply with a numbered plan where each step names the exact file it touches and what ' +
    'changes in it. Keep it to the steps that are actually needed. End with how the result ' +
    'should be verified. No prose around the list.'
  );
}

export function parsePlan(text: string): ParsedPlan {
  const steps: PlanStep[] = [];
  for (const line of text.split('\n')) {
    const match = STEP_RE.exec(line);
    if (!match?.[1]) continue;
    const body = match[1];
    // A markdown bullet list inside a code fence is not a plan step, but the
    // cost of including one is low compared to missing real steps.
    steps.push({ text: body, files: [...new Set(body.match(PATH_RE) ?? [])] });
  }

  if (steps.length < MIN_STEPS) {
    return { steps, executable: false, reason: 'the plan is not a step list' };
  }
  const withFiles = steps.filter((s) => s.files.length > 0).length;
  if (withFiles < Math.ceil(steps.length / 2)) {
    return { steps, executable: false, reason: 'the plan does not name the files it touches' };
  }
  return { steps, executable: true, reason: `${steps.length} steps naming concrete files` };
}

/** The prompt the cheaper executor receives. */
export function executePrompt(task: string, plan: ParsedPlan, plannedBy: string): string {
  const list = plan.steps.map((s, i) => `${i + 1}. ${s.text}`).join('\n');
  return (
    `A stronger model (${plannedBy}) investigated this codebase and produced the plan below. ` +
    `Carry it out exactly.\n\n` +
    `## Original request\n${task}\n\n` +
    `## The plan\n${list}\n\n` +
    'Follow the steps in order. Read each file before you change it. Do not redesign the ' +
    'approach — if a step turns out to be wrong or impossible, stop and say which step and why ' +
    'instead of improvising a different solution. Verify the result the way the plan says.'
  );
}

/** One tier down: what the executor should run on. */
export function executorTier(plannerTier: Tier): Tier {
  return plannerTier === 'heavy' ? 'standard' : 'light';
}

/**
 * Picks who executes. Staying on the planner's own account keeps the session
 * and costs nothing extra in context, so it is only worth moving when the
 * saving is real — a genuinely cheaper account with room to work.
 */
export function pickExecutor(
  planner: Target,
  candidates: Target[],
  headroom: Record<string, number>,
): Target | undefined {
  const plannerKey = `${planner.provider}:${planner.account}`;
  return candidates.find((c) => {
    const candidateKey = `${c.provider}:${c.account}`;
    if (candidateKey === plannerKey) return false;
    return (headroom[candidateKey] ?? 0) >= 40;
  });
}
