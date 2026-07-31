import { existsSync } from 'node:fs';
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
    return {
      terminalCommand: [this.cliPath],
      env: { COPILOT_HOME: profileDir },
      // config.json can exist before auth completes, so no reliable file signal.
      watch: { kind: 'manual-confirm' },
      instructions:
        'Copilot CLI will start with an isolated profile. Run /login inside it and complete the ' +
        'GitHub device flow with the account you want to add, then exit.',
      verify: async () => existsSync(join(profileDir, 'config.json')),
    };
  }
}
