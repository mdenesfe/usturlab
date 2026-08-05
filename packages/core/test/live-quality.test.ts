import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAdapter } from '../src/adapters/claude.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { describeChecks, discoverChecks, selectChecks } from '../src/verify/checks.js';
import { shapeTask } from '../src/context/taskShape.js';
import { isClean, reviewPrompt } from '../src/review/secondOpinion.js';
import { parsePlan, planPrompt } from '../src/review/planExecute.js';
import type { ProviderAdapter } from '../src/adapters/adapter.js';
import type { ProviderId, ResolvedAccount } from '../src/types.js';

/**
 * The quality layer against reality: does check discovery find this repo's
 * real commands, does a second model actually catch a planted bug, and does a
 * real planner produce something specific enough to hand off?
 */

const LIVE = process.env.USTURLAB_LIVE === '1';
const PROFILES = join(homedir(), '.usturlab', 'profiles');
const REPO = join(import.meta.dirname, '..', '..', '..');

const account = (provider: ProviderId, id: string): ResolvedAccount => ({
  id,
  provider,
  label: 'personal',
  authMode: 'managed-home',
  homeDir: join(PROFILES, id),
  hasSecret: false,
  priority: 1,
});

async function ask(
  adapter: ProviderAdapter,
  acct: ResolvedAccount,
  prompt: string,
): Promise<{ text: string; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 170_000);
  let text = '';
  let error: string | undefined;
  try {
    for await (const ev of adapter.run(
      { prompt, cwd: REPO, permissionMode: 'safe' },
      acct,
      controller.signal,
    )) {
      if (ev.type === 'result') text += ev.text;
      if (ev.type === 'error') error = ev.message;
      if (ev.type === 'limit') error = `usage limit: ${ev.raw.slice(0, 120)}`;
    }
  } catch (e) {
    error = (e as Error).message;
  }
  clearTimeout(timer);
  return { text, error };
}

describe('check discovery against this repo', () => {
  it('finds the commands this repo really declares', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
      packageManager?: string;
    };
    const commands = discoverChecks({
      scripts: pkg.scripts,
      packageManager: pkg.packageManager,
    });
    // Whatever this repo declares, every discovered command must be one of them.
    for (const command of commands) {
      const script = command.source.replace('package.json scripts.', '');
      expect(pkg.scripts?.[script], `${script} is not a real script`).toBeDefined();
    }
    expect(commands.length, 'no checks discovered for a repo that has scripts').toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log('discovered:', commands.map((c) => c.argv.join(' ')).join(' | '));
  });

  it('never proposes a command the repo did not declare', () => {
    const commands = discoverChecks({ scripts: { dev: 'vite', start: 'node .' } });
    expect(commands).toEqual([]);
    expect(selectChecks(commands, { wroteCode: true, complexity: 'hard' })).toEqual([]);
  });

  it('tells a model to run the command this repo actually has', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
      packageManager?: string;
    };
    const available = discoverChecks({ scripts: pkg.scripts, packageManager: pkg.packageManager });
    const selected = selectChecks(available, {
      kind: 'refactor',
      complexity: 'hard',
      wroteCode: true,
    });
    const lines = shapeTask({
      prompt: 'split the router into two modules',
      classification: { kind: 'refactor', complexity: 'hard', writesCode: true },
      check: describeChecks(selected),
      permissionMode: 'edits',
    });
    const verify = lines.find((l) => l.id === 'verify-with-check');
    expect(verify, 'no verification line for a repo that declares checks').toBeDefined();
    for (const command of selected) {
      const script = command.source.replace('package.json scripts.', '');
      expect(verify!.text).toContain(script);
    }
  });
});

describe.skipIf(!LIVE)('live: a second model catches what the first missed', () => {
  // A real defect: the guard reads like it handles empty input but divides by
  // zero for an empty array, and mutates the caller's array while sorting.
  const BUGGY = `
export function median(values: number[]): number {
  const sorted = values.sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
`;

  it('codex reviewing claude finds the planted defects', async () => {
    const prompt = reviewPrompt({
      task: 'Write a median() helper that is safe for any number array.',
      answer: `Here is the helper:\n\`\`\`ts${BUGGY}\`\`\`\nIt handles all cases.`,
      authorProvider: 'claude',
    });
    const review = await ask(new CodexAdapter(), account('codex', 'codex-personal'), prompt);
    // eslint-disable-next-line no-console
    console.log('\n[review by codex]\n' + review.text.trim());
    expect(review.error).toBeUndefined();
    expect(isClean(review.text), 'reviewer waved through broken code').toBe(false);
    // It must find at least the empty-array case or the caller-array mutation.
    expect(review.text).toMatch(/empty|length\s*===?\s*0|zero|NaN|mutat|in[- ]?place|sort/i);
  }, 190_000);

  it('a correct answer is allowed to pass', async () => {
    const prompt = reviewPrompt({
      task: 'Write a function that returns the sum of two numbers.',
      answer: 'export function add(a: number, b: number): number {\n  return a + b;\n}',
      authorProvider: 'claude',
    });
    const review = await ask(new CodexAdapter(), account('codex', 'codex-personal'), prompt);
    // eslint-disable-next-line no-console
    console.log('\n[review of correct code]\n' + review.text.trim());
    expect(review.error).toBeUndefined();
    expect(isClean(review.text), 'reviewer invented problems in correct code').toBe(true);
  }, 190_000);
});

describe.skipIf(!LIVE)('live: a real plan is specific enough to hand off', () => {
  it('claude produces a step list naming real files', async () => {
    const plan = await ask(
      new ClaudeAdapter(),
      account('claude', 'claude-personal'),
      planPrompt(
        'In packages/core, make the sticky-conversation bonus configurable instead of a constant.',
      ),
    );
    // eslint-disable-next-line no-console
    console.log('\n[plan by claude]\n' + plan.text.trim().slice(0, 1200));
    expect(plan.error).toBeUndefined();
    const parsed = parsePlan(plan.text);
    expect(parsed.executable, `plan rejected: ${parsed.reason}`).toBe(true);
    expect(parsed.steps.some((s) => s.files.some((f) => f.includes('.ts')))).toBe(true);
  }, 190_000);
});
