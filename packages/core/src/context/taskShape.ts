import type { PermissionMode } from '../types.js';
import { isContinuation } from '../router/classify.js';
import type { Classification } from '../router/classify.js';

/**
 * Frame the task, not the words.
 *
 * The single thing that most reliably separates a run you have to watch from
 * one you can walk away from is whether the model was given a check it can run
 * itself. Everything else here is the same idea applied earlier: the handful of
 * details a careful colleague would have asked for before starting — where the
 * work lives, what "done" means, what is out of scope.
 *
 * Three rules keep this from becoming the bloat it is meant to prevent:
 *  - Only speak to a gap that is actually present. A request that already names
 *    its files gets no line about naming files.
 *  - Never rewrite the user's words. Their prompt is their intent; this adds
 *    around it and can always be read separately from what they typed.
 *  - Stay under a hard cap. Instructions that are ignored are worse than
 *    instructions that were never sent, and a long preamble is how you get
 *    there.
 *
 * The ids are deliberately not fed to the brief-line A/B loop: these lines
 * appear only when their gap does, so "runs with the line" and "runs without
 * it" are different populations of task and the comparison would measure task
 * difficulty rather than the line.
 */

export interface ShapedLine {
  /** Stable key, so a line can be named in a test and shown in the UI. */
  id: string;
  text: string;
}

export interface TaskShapeInput {
  prompt: string;
  classification: Pick<Classification, 'kind' | 'complexity' | 'writesCode'>;
  /** The check this repo declares, rendered as a command, e.g. `pnpm run test`. */
  check?: string;
  /** The file the editor has in the foreground, when there is one. */
  activeFile?: string;
  permissionMode: PermissionMode;
  /** Lines to leave out — the user turned them off. */
  disabledLineIds?: string[];
}

/** Anything with a path separator or a file extension counts as naming a place. */
const PATH_RE = /\b[\w.@-]+(?:\/[\w.@-]+)+(?:\.\w+)?\b|\b[\w-]+\.\w{1,5}\b/;

/**
 * A pasted failure: a fence, a typed error, a stack frame, a file:line. The
 * words "bug" and "fails" deliberately do not count — they are what made this a
 * debug task in the first place, and treating them as evidence would mean the
 * rule never fires on the reports that most need it.
 */
const EVIDENCE_RE =
  /```|\b\w*error:|\btraceback\b|\bstack ?trace\b|\bpanic:|\bsegfault\b|[\w./-]+\.\w{1,5}:\d+|:\d+:\d+|\bat \w[\w.$<>]*\(/i;

/** "make it better" — a direction with no destination. */
const VAGUE_GOAL_RE =
  /\b(better|nicer|cleaner|faster|improve|optimi[sz]e|tidy|polish|daha iyi|iyile[şs]tir|güzelleştir|hızlandır|temizle)\b/i;

/** A number, a unit or a comparison — evidence the vague goal has a target after all. */
const CRITERION_RE = /\b\d+\s*(ms|s|kb|mb|%|x)\b|\bunder \d|\bat most\b|\bfewer than\b|\bp9[59]\b/i;

const MAX_LINES = 3;

function has(re: RegExp, text: string): boolean {
  return re.test(text);
}

/**
 * The lines worth adding to this particular request, most valuable first.
 *
 * Candidates are generated in priority order and the cap truncates the tail, so
 * adding a rule below never displaces the verification handle above it.
 */
export function shapeTask(input: TaskShapeInput): ShapedLine[] {
  const { classification: task, prompt } = input;
  // Framing is for work that changes code. A question does not need a scope
  // fence, and an explanation has nothing to verify.
  if (!task.writesCode) return [];
  // Plan mode changes nothing, so every line here would be about work that is
  // not going to happen; the provider brief already states the mode.
  if (input.permissionMode === 'safe') return [];

  const candidates: Array<ShapedLine | undefined> = [];

  // 1. The check. Anything else here is worth less than this.
  if (input.check) {
    candidates.push({
      id: 'verify-with-check',
      text:
        `When the change is done, run \`${input.check}\` yourself and keep working until it ` +
        'passes. Show what it printed rather than telling me it worked.',
    });
  } else {
    candidates.push({
      id: 'verify-no-check',
      text:
        'This project declares no test or build script, so say exactly how you checked the ' +
        'change — what you ran, or what you read to be sure — instead of asserting it works.',
    });
  }

  // 2. A bug report with no failure in it. Reproducing first is what turns a
  //    guess into a fix.
  if (task.kind === 'debug' && !has(EVIDENCE_RE, prompt)) {
    candidates.push({
      id: 'repro-first',
      text:
        'Reproduce the failure before changing anything — a failing test, or the command and ' +
        'its real output. Then fix the cause rather than the symptom.',
    });
  }

  // 3. "Make it better" with nothing to measure against. Without a target the
  //    model picks its own, and it is usually "more abstraction".
  if (has(VAGUE_GOAL_RE, prompt) && !has(CRITERION_RE, prompt)) {
    candidates.push({
      id: 'criteria-first',
      text:
        'State in one line which specific property you are improving and how you would know it ' +
        'improved, then change only what serves that. Do not rewrite code that already works.',
    });
  }

  // 4. Nothing anchors the work — not the prompt, not the open editor.
  if (!has(PATH_RE, prompt) && !input.activeFile) {
    candidates.push({
      id: 'name-scope',
      text:
        'Nothing here names a file. Find the right place in the codebase first and say which ' +
        'files you are going to change before you change them.',
    });
  }

  // 5. Multi-file work is where a model quietly invents a second house style.
  if (task.kind === 'refactor' || task.kind === 'agentic') {
    candidates.push({
      id: 'follow-pattern',
      text:
        'Follow the pattern this codebase already uses instead of introducing a new one, and ' +
        'name the file you took it from.',
    });
  }

  // 6. On big work, an unasked-for improvement is a review the user did not agree to.
  if (task.complexity === 'hard' || task.kind === 'agentic') {
    candidates.push({
      id: 'scope-fence',
      text:
        'Do what was asked and no more. If you notice other problems, list them at the end ' +
        'instead of fixing them in the same change.',
    });
  }

  const disabled = new Set(input.disabledLineIds ?? []);
  const lines = candidates.filter(
    (line): line is ShapedLine => !!line && !disabled.has(line.id),
  );
  // A one-line change does not deserve a preamble; it still deserves the check.
  // Neither does "go ahead" — the gap rules would be reading two words of
  // approval rather than the request they belong to, which was framed already.
  const cap = task.complexity === 'trivial' || isContinuation(prompt) ? 1 : MAX_LINES;
  return lines.slice(0, cap);
}

/** Every id `shapeTask` can produce, for settings and tests. */
export const SHAPE_LINE_IDS = [
  'verify-with-check',
  'verify-no-check',
  'repro-first',
  'criteria-first',
  'name-scope',
  'follow-pattern',
  'scope-fence',
] as const;
