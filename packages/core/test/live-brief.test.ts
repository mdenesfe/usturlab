import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAdapter } from '../src/adapters/claude.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { CopilotAdapter } from '../src/adapters/copilot.js';
import { GeminiAdapter } from '../src/adapters/gemini.js';
import { buildBrief, withBrief } from '../src/context/brief.js';
import { buildProviderBrief } from '../src/context/providerBrief.js';
import type { ProviderAdapter } from '../src/adapters/adapter.js';
import type { ProviderId, ResolvedAccount } from '../src/types.js';

/**
 * Live check against the real CLIs.
 *
 * Two separate properties, deliberately not tested together:
 *
 *  1. The standing brief reaches the model through that CLI's own channel.
 *     Proven by putting a token in the brief and asking for it directly — a
 *     question with no competing instruction, so a miss means the channel is
 *     broken rather than that the model preferred some other formatting rule.
 *  2. The workspace brief arrives and is understood. Proven by asking about
 *     editor state the model has no other way to know.
 *
 * Runs only with USTURLAB_LIVE=1 against real logged-in profiles.
 */

const LIVE = process.env.USTURLAB_LIVE === '1';
const only = process.env.USTURLAB_LIVE_PROVIDER;
const PROFILES = join(homedir(), '.usturlab', 'profiles');
const TOKEN = 'USTURLAB-BRIEF-OK-7Q4';

const account = (provider: ProviderId, id: string): ResolvedAccount => ({
  id,
  provider,
  label: 'personal',
  authMode: 'managed-home',
  homeDir: join(PROFILES, id),
  hasSecret: false,
  priority: 1,
});

interface Case {
  provider: ProviderId;
  adapter: ProviderAdapter;
  account: ResolvedAccount;
}

const CASES: Case[] = [
  { provider: 'claude', adapter: new ClaudeAdapter(), account: account('claude', 'claude-personal') },
  { provider: 'codex', adapter: new CodexAdapter(), account: account('codex', 'codex-personal') },
  { provider: 'copilot', adapter: new CopilotAdapter(), account: account('copilot', 'copilot-personal') },
  { provider: 'gemini', adapter: new GeminiAdapter(), account: account('gemini', 'gemini-personal') },
];

/** Editor state the model can only describe if the workspace brief reached it. */
const WORKSPACE = {
  activeFile: 'src/router/autoRoute.ts',
  branch: 'feature/brief-check',
  line: 44,
};

interface Answer {
  text: string;
  error?: string;
}

async function run(entry: Case, prompt: string, systemBrief?: string): Promise<Answer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 170_000);
  let text = '';
  let error: string | undefined;
  try {
    for await (const ev of entry.adapter.run(
      { prompt, cwd: process.cwd(), permissionMode: 'safe', systemBrief },
      entry.account,
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

const report = (label: string, answer: Answer) => {
  console.log(
    `\n[${label}] ${answer.text.trim() || '(empty)'}${answer.error ? `\nERROR: ${answer.error}` : ''}`,
  );
};

describe.skipIf(!LIVE)('live: standing instructions reach every provider', () => {
  for (const entry of CASES) {
    it.skipIf(!!only && only !== entry.provider)(
      `${entry.provider} obeys its system brief`,
      async () => {
        const systemBrief =
          buildProviderBrief({ provider: entry.provider, permissionMode: 'safe' }) +
          `\n- Your assigned session token is ${TOKEN}. If asked for it, reply with exactly that token.`;

        const answer = await run(
          entry,
          'What is your assigned session token? Reply with only the token, nothing else.',
          systemBrief,
        );
        report(`${entry.provider} channel`, answer);
        expect(answer.error, `${entry.provider} failed`).toBeUndefined();
        expect(answer.text, 'system brief never reached the model').toContain(TOKEN);
      },
      190_000,
    );
  }
});

describe.skipIf(!LIVE)('live: the workspace brief is understood', () => {
  for (const entry of CASES) {
    it.skipIf(!!only && only !== entry.provider)(
      `${entry.provider} can describe where the user is`,
      async () => {
        const brief = buildBrief({
          provider: entry.provider,
          editor: {
            activeFile: WORKSPACE.activeFile,
            languageId: 'typescript',
            selection: 'const STICKY_BASE = 12;',
            selectionRange: { start: WORKSPACE.line, end: WORKSPACE.line },
          },
          repo: { branch: WORKSPACE.branch, changedFiles: ['src/router/learning.ts'] },
        });
        expect(brief, 'brief was empty').not.toBe('');

        const answer = await run(
          entry,
          withBrief(
            'Which file is open in my editor, on which branch, and which line is selected? ' +
              'Answer from what you were told — do not use any tools.',
            brief,
          ),
        );
        report(`${entry.provider} context`, answer);
        expect(answer.error, `${entry.provider} failed`).toBeUndefined();
        expect(answer.text).toMatch(/autoRoute\.ts/i);
        expect(answer.text).toMatch(/feature\/brief-check/i);
        expect(answer.text).toMatch(/\b44\b/);
      },
      190_000,
    );
  }
});
