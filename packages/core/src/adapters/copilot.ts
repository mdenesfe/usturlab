import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LoginFlow, ProviderAdapter, RunRequest } from './adapter.js';
import { spawnLines } from './spawn.js';
import { detectCopilotLimit } from './limits.js';
import { buildChildEnv } from '../accounts/env.js';
import type { AdapterEvent, PermissionMode, ResolvedAccount } from '../types.js';

const PERMISSION_ARGS: Record<PermissionMode, string[]> = {
  safe: [],
  edits: ['--allow-all-tools'],
  full: ['--allow-all'],
};

export class CopilotAdapter implements ProviderAdapter {
  readonly id = 'copilot' as const;
  readonly displayName = 'Copilot CLI';
  // Programmatic mode is plain text; sessions continue via history embedding.
  readonly supportsNativeResume = false;
  readonly models = [
    { id: 'claude-sonnet-4.6', label: 'Claude Sonnet 4.6' },
    { id: 'gpt-5.4', label: 'GPT-5.4' },
    { id: 'claude-haiku-4.5', label: 'Claude Haiku 4.5' },
  ];

  constructor(private cliPath = 'copilot') {}

  buildEnv(account: ResolvedAccount, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return buildChildEnv(account, base);
  }

  async *run(
    req: RunRequest,
    account: ResolvedAccount,
    signal: AbortSignal,
  ): AsyncGenerator<AdapterEvent> {
    const args = ['-p', req.prompt, '-s', '--no-ask-user', ...PERMISSION_ARGS[req.permissionMode]];
    if (req.model) args.push(`--model=${req.model}`);

    const env = this.buildEnv(account, process.env);
    const lines: string[] = [];
    let stderrTail = '';

    for await (const ev of spawnLines(this.cliPath, args, { cwd: req.cwd, env, signal })) {
      if (ev.kind === 'spawn-error') {
        yield { type: 'error', message: ev.message, retryable: false };
        return;
      }
      if (ev.kind === 'exit') {
        const text = lines.join('\n');
        const haystack = `${text}\n${stderrTail}`;
        const limit = detectCopilotLimit(haystack);
        if (limit) {
          yield { type: 'limit', ...limit };
        } else if (ev.code !== 0) {
          yield {
            type: 'error',
            message: stderrTail.trim() || `copilot exited with code ${ev.code}`,
            retryable: false,
          };
        } else {
          yield { type: 'result', text };
        }
        return;
      }
      if (ev.stream === 'stderr') {
        stderrTail = (stderrTail + '\n' + ev.line).slice(-4096);
        continue;
      }
      lines.push(ev.line);
      yield { type: 'text-delta', text: ev.line + '\n' };
    }
  }

  interactiveCommand(account: ResolvedAccount, model?: string) {
    const command = [this.cliPath];
    if (model) command.push(`--model=${model}`);
    return { command, env: this.buildEnv(account, process.env) };
  }

  loginFlow(profileDir: string): LoginFlow {
    // config.json is JSONC; loggedInUsers fills in the moment the device flow
    // completes — a precise auto-detect signal.
    const isLoggedIn = async (): Promise<boolean> => {
      try {
        const file = join(profileDir, 'config.json');
        if (!existsSync(file)) return false;
        const raw = readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '');
        const parsed = JSON.parse(raw) as { loggedInUsers?: unknown[] };
        return Array.isArray(parsed.loggedInUsers) && parsed.loggedInUsers.length > 0;
      } catch {
        return false;
      }
    };
    return {
      terminalCommand: [this.cliPath, 'login'],
      env: { COPILOT_HOME: profileDir },
      watch: { kind: 'poll', check: isLoggedIn, intervalMs: 2000 },
      instructions:
        'The terminal runs "copilot login": it shows a device code — enter it on the GitHub page ' +
        'that opens, with the account you want to add. usturlab detects the completed login automatically.',
      verify: isLoggedIn,
    };
  }
}
