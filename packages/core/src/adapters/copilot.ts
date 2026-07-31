import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LoginFlow, ProviderAdapter, RunRequest } from './adapter.js';
import { runAcp } from './acp.js';
import { detectCopilotLimit } from './limits.js';
import { buildChildEnv } from '../accounts/env.js';
import type { AdapterEvent, ResolvedAccount } from '../types.js';

/**
 * Copilot over the Agent Client Protocol (`copilot --acp`): one open session
 * per run, so tool calls stream into the timeline, permission requests are
 * answered by our permission mode, sessions resume natively, and a message
 * sent mid-run reaches the agent live.
 */
export class CopilotAdapter implements ProviderAdapter {
  readonly id = 'copilot' as const;
  readonly displayName = 'GitHub Copilot';
  readonly supportsNativeResume = true;
  readonly models = [
    { id: 'claude-sonnet-4.6', label: 'Claude Sonnet 4.6' },
    { id: 'gpt-5.4', label: 'GPT-5.4' },
    { id: 'claude-haiku-4.5', label: 'Claude Haiku 4.5' },
  ];

  constructor(private cliPath = 'copilot') {}

  buildEnv(account: ResolvedAccount, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return buildChildEnv(account, base);
  }

  run(
    req: RunRequest,
    account: ResolvedAccount,
    signal: AbortSignal,
  ): AsyncGenerator<AdapterEvent> {
    const args = ['--acp'];
    if (req.model) args.push(`--model=${req.model}`);
    return runAcp({
      command: this.cliPath,
      args,
      env: this.buildEnv(account, process.env),
      req,
      signal,
      detectLimit: detectCopilotLimit,
    });
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
