/**
 * Verify what the model claimed.
 *
 * A confident wrong answer is the most expensive failure mode there is — it
 * costs the user the run *and* the time spent trusting it. Cheap reality
 * checks after a run turn that into one extra round trip instead.
 *
 * Two rules are non-negotiable:
 *  - Commands are never invented. Only what the repository itself declares
 *    (package.json scripts, a Makefile target) is ever run.
 *  - Nothing runs in plan mode. If the model was not allowed to change the
 *    workspace, there is nothing to verify and nothing may be executed.
 */

export type CheckKind = 'files-changed' | 'typecheck' | 'test' | 'build' | 'lint';

export interface VerifyCommand {
  kind: CheckKind;
  /** Argv as declared by the repo, e.g. ['npm', 'run', 'typecheck']. */
  argv: string[];
  /** Where the declaration came from, shown to the user. */
  source: string;
}

export interface CheckResult {
  kind: CheckKind;
  ok: boolean;
  /** Command output, already trimmed to something worth reading. */
  output?: string;
  /** Why the check did not run at all. */
  skipped?: string;
}

export interface VerifyReport {
  results: CheckResult[];
  /** True when every check that ran passed. */
  ok: boolean;
  /** The failures, formatted for feeding back to the model. */
  failureText?: string;
}

/** Script names we recognize, in the order we would rather run them. */
const SCRIPT_PREFERENCE: Array<{ kind: CheckKind; names: string[] }> = [
  { kind: 'typecheck', names: ['typecheck', 'type-check', 'tsc', 'check-types'] },
  { kind: 'test', names: ['test', 'tests', 'test:unit'] },
  { kind: 'build', names: ['build', 'compile'] },
  { kind: 'lint', names: ['lint'] },
];

export interface RepoManifest {
  /** Parsed package.json "scripts", if the repo has one. */
  scripts?: Record<string, string>;
  /** Package manager the repo pins, e.g. 'pnpm' from packageManager. */
  packageManager?: string;
  /** Make targets, when a Makefile declares them. */
  makeTargets?: string[];
}

/**
 * Which checks this repository actually offers. Discovery is pure so it can be
 * tested without a filesystem; the host reads the files and passes them in.
 */
export function discoverChecks(manifest: RepoManifest): VerifyCommand[] {
  const commands: VerifyCommand[] = [];
  const scripts = manifest.scripts ?? {};
  const runner = manifest.packageManager?.split('@')[0] || 'npm';

  for (const { kind, names } of SCRIPT_PREFERENCE) {
    const name = names.find((n) => typeof scripts[n] === 'string');
    if (!name) continue;
    commands.push({
      kind,
      argv: runner === 'npm' ? ['npm', 'run', '--silent', name] : [runner, 'run', name],
      source: `package.json scripts.${name}`,
    });
  }

  if (commands.length === 0) {
    for (const { kind, names } of SCRIPT_PREFERENCE) {
      const target = names.find((n) => manifest.makeTargets?.includes(n));
      if (!target) continue;
      commands.push({ kind, argv: ['make', target], source: `Makefile ${target}` });
    }
  }

  return commands;
}

/**
 * Which of the discovered checks are worth running for this task.
 *
 * A typo fix does not deserve the whole test suite; a refactor does. The
 * classification the router already produced decides.
 */
export function selectChecks(
  available: VerifyCommand[],
  opts: { kind?: string; complexity?: string; wroteCode: boolean },
): VerifyCommand[] {
  if (!opts.wroteCode) return [];
  const heavy = opts.complexity === 'hard' || opts.complexity === 'moderate';
  const testShaped = opts.kind === 'test' || opts.kind === 'debug' || opts.kind === 'refactor';

  const wanted: CheckKind[] = ['typecheck'];
  if (heavy || testShaped) wanted.push('test');
  if (!available.some((c) => c.kind === 'typecheck')) wanted.push('build');

  return available.filter((c) => wanted.includes(c.kind));
}

/**
 * The same checks written out as something a model can run.
 *
 * Telling it up front exactly what will be run against it afterwards is the
 * cheapest way to close the loop without a second round trip — and it is the
 * same list, so a run that passes its own check passes ours.
 */
export function describeChecks(commands: VerifyCommand[]): string | undefined {
  // `--silent` is there to keep our own capture readable; in a prompt it is noise.
  const rendered = commands.map((c) => c.argv.filter((a) => a !== '--silent').join(' '));
  if (rendered.length === 0) return undefined;
  return rendered.join(' && ');
}

const MAX_OUTPUT_CHARS = 3000;

/** Keeps the end of the output — that is where the failure is reported. */
export function trimOutput(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_OUTPUT_CHARS) return trimmed;
  return '[…earlier output omitted]\n' + trimmed.slice(-MAX_OUTPUT_CHARS);
}

export function summarize(results: CheckResult[]): VerifyReport {
  const ran = results.filter((r) => !r.skipped);
  const failures = ran.filter((r) => !r.ok);
  const report: VerifyReport = { results, ok: failures.length === 0 };
  if (failures.length > 0) {
    report.failureText = failures
      .map((f) => `### ${f.kind} failed\n${f.output ?? '(no output captured)'}`)
      .join('\n\n');
  }
  return report;
}

/** The follow-up prompt that asks the model to fix what verification caught. */
export function repairPrompt(report: VerifyReport, changedFiles: string[]): string {
  return (
    'Your change did not pass this project\'s own checks. This is the real output:\n\n' +
    `${report.failureText}\n\n` +
    (changedFiles.length > 0 ? `Files you changed: ${changedFiles.join(', ')}\n\n` : '') +
    'Fix the cause, not the symptom. Do not revert unrelated work, do not weaken or skip the ' +
    'check to make it pass, and re-run the check yourself to confirm. Editing, deleting or ' +
    'skipping a test, or stubbing the code it exercises, is not a fix — a green check bought ' +
    'that way hides the very bug it was there to catch. If the failure is pre-existing and ' +
    'unrelated to your change, say so plainly instead of fixing it.'
  );
}

/** One-line summary for the transcript. */
export function describeReport(report: VerifyReport): string {
  const ran = report.results.filter((r) => !r.skipped);
  if (ran.length === 0) return 'nothing to verify';
  const names = ran.map((r) => `${r.kind} ${r.ok ? 'passed' : 'failed'}`);
  return names.join(' · ');
}
