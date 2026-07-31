import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LoginFlow, ProviderAdapter, RunRequest } from './adapter.js';
import { runAcp } from './acp.js';
import { detectGeminiLimit } from './limits.js';
import { buildChildEnv } from '../accounts/env.js';
import type { AdapterEvent, PermissionMode, ResolvedAccount } from '../types.js';

const APPROVAL: Record<PermissionMode, string> = {
  safe: 'default',
  edits: 'auto_edit',
  full: 'yolo',
};

/**
 * Gemini over the Agent Client Protocol (`gemini --acp`) — the same session
 * transport Copilot uses, so mid-run messages, native resume and streamed
 * tool calls work the same way here.
 */
export class GeminiAdapter implements ProviderAdapter {
  readonly id = 'gemini' as const;
  readonly displayName = 'Gemini CLI';
  readonly supportsNativeResume = true;
  readonly models = [
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  ];

  constructor(private cliPath = 'gemini') {}

  buildEnv(account: ResolvedAccount, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env = buildChildEnv(account, base);
    // Headless runs in a not-yet-trusted workspace abort otherwise; the user
    // initiated the task in their own workspace, so trust it.
    env.GEMINI_CLI_TRUST_WORKSPACE = 'true';
    return env;
  }

  run(
    req: RunRequest,
    account: ResolvedAccount,
    signal: AbortSignal,
  ): AsyncGenerator<AdapterEvent> {
    const args = ['--acp', '--approval-mode', APPROVAL[req.permissionMode]];
    if (req.model) args.push('-m', req.model);
    return runAcp({
      command: this.cliPath,
      args,
      env: this.buildEnv(account, process.env),
      req,
      signal,
      detectLimit: detectGeminiLimit,
    });
  }

  interactiveCommand(account: ResolvedAccount, model?: string) {
    const command = [this.cliPath];
    if (model) command.push('-m', model);
    return { command, env: this.buildEnv(account, process.env) };
  }

  loginFlow(profileDir: string): LoginFlow {
    // Pre-select Google login so the CLI skips its auth-method picker and goes
    // straight to the browser OAuth flow.
    const geminiDir = join(profileDir, '.gemini');
    try {
      mkdirSync(geminiDir, { recursive: true });
      const settingsPath = join(geminiDir, 'settings.json');
      if (!existsSync(settingsPath)) {
        writeFileSync(
          settingsPath,
          JSON.stringify(
            {
              security: { auth: { selectedType: 'oauth-personal' } },
              selectedAuthType: 'oauth-personal',
              // Shared project memory: every provider reads the same AGENTS.md.
              context: { fileName: ['AGENTS.md', 'GEMINI.md'] },
              contextFileName: ['AGENTS.md', 'GEMINI.md'],
            },
            null,
            2,
          ),
        );
      }
    } catch {
      // Best-effort; the user can still pick the auth method interactively.
    }
    return {
      terminalCommand: [this.cliPath],
      // Trust env skips the folder-trust dialog so the flow goes straight to
      // the Google sign-in.
      env: { HOME: profileDir, USERPROFILE: profileDir, GEMINI_CLI_TRUST_WORKSPACE: 'true' },
      watch: { kind: 'file', path: join(geminiDir, 'oauth_creds.json') },
      instructions:
        'Gemini CLI will start with an isolated profile. A browser opens — sign in with the Google ' +
        'account you want to add. usturlab detects the completed login automatically; you can close the terminal afterwards.',
      verify: async () => existsSync(join(geminiDir, 'oauth_creds.json')),
    };
  }
}
