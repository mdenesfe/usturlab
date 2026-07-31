import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LoginFlow, ProviderAdapter, RunRequest } from './adapter.js';
import { spawnLines } from './spawn.js';
import { getObject, getString, tryParseJson } from './ndjson.js';
import { detectGeminiLimit } from './limits.js';
import { buildChildEnv } from '../accounts/env.js';
import type { AdapterEvent, PermissionMode, ResolvedAccount } from '../types.js';

const APPROVAL: Record<PermissionMode, string> = {
  safe: 'default',
  edits: 'auto_edit',
  full: 'yolo',
};

export class GeminiAdapter implements ProviderAdapter {
  readonly id = 'gemini' as const;
  readonly displayName = 'Gemini CLI';
  // Headless JSON output lacks the session id upstream (gemini-cli#14435),
  // so conversations continue via history embedding instead of --resume.
  readonly supportsNativeResume = false;
  readonly models = [
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  ];

  constructor(private cliPath = 'gemini') {}

  buildEnv(account: ResolvedAccount, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return buildChildEnv(account, base);
  }

  async *run(
    req: RunRequest,
    account: ResolvedAccount,
    signal: AbortSignal,
  ): AsyncGenerator<AdapterEvent> {
    const args = ['-p', req.prompt, '--output-format', 'stream-json', '--approval-mode', APPROVAL[req.permissionMode]];
    if (req.model) args.push('-m', req.model);

    const env = this.buildEnv(account, process.env);
    // Headless runs in a not-yet-trusted workspace abort otherwise; the user
    // initiated the task in their own workspace, so trust it.
    env.GEMINI_CLI_TRUST_WORKSPACE = 'true';
    let text = '';
    let stderrTail = '';
    let finished = false;

    for await (const ev of spawnLines(this.cliPath, args, { cwd: req.cwd, env, signal })) {
      if (ev.kind === 'spawn-error') {
        yield { type: 'error', message: ev.message, retryable: false };
        return;
      }
      if (ev.kind === 'exit') {
        if (!finished) {
          const haystack = `${text}\n${stderrTail}`;
          const limit = detectGeminiLimit(haystack);
          if (limit) yield { type: 'limit', ...limit };
          else if (ev.code !== 0) {
            yield {
              type: 'error',
              message: stderrTail.trim() || `gemini exited with code ${ev.code}`,
              // Exit 42 is an input error, 53 a turn-limit — neither retries.
              retryable: false,
            };
          } else if (text) {
            yield { type: 'result', text };
          }
        }
        return;
      }
      if (ev.stream === 'stderr') {
        stderrTail = (stderrTail + '\n' + ev.line).slice(-4096);
        continue;
      }

      const msg = tryParseJson(ev.line);
      if (!msg) continue;

      switch (msg.type) {
        case 'message': {
          if (msg.role && msg.role !== 'assistant') break;
          const t = getString(msg, 'content') ?? getString(msg, 'text') ?? '';
          if (t) {
            text += t;
            yield { type: 'text-delta', text: t };
          }
          break;
        }
        case 'tool_use': {
          const name = getString(msg, 'name') ?? getString(msg, 'tool') ?? 'tool';
          yield { type: 'tool-use', name };
          break;
        }
        case 'result': {
          finished = true;
          const response = getString(msg, 'response') ?? text;
          const errObj = getObject(msg, 'error');
          if (errObj) {
            const errText = JSON.stringify(errObj);
            const limit = detectGeminiLimit(errText);
            if (limit) yield { type: 'limit', ...limit };
            else yield { type: 'error', message: getString(errObj, 'message') ?? errText, retryable: false };
            break;
          }
          // The CLI silently falls back Pro -> Flash on quota pressure; surface it.
          const models = getObject(msg, 'stats', 'models');
          if (req.model?.includes('pro') && models) {
            const served = Object.keys(models);
            if (served.length > 0 && !served.some((m) => m.includes('pro'))) {
              yield { type: 'model-downgraded', from: req.model, to: served[0]! };
            }
          }
          yield { type: 'result', text: response };
          break;
        }
        case 'error': {
          finished = true;
          const errText = JSON.stringify(msg);
          const limit = detectGeminiLimit(errText);
          if (limit) yield { type: 'limit', ...limit };
          else yield { type: 'error', message: getString(msg, 'message') ?? errText, retryable: false };
          break;
        }
      }
    }
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
            { security: { auth: { selectedType: 'oauth-personal' } }, selectedAuthType: 'oauth-personal' },
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
      env: { HOME: profileDir, USERPROFILE: profileDir },
      watch: { kind: 'file', path: join(geminiDir, 'oauth_creds.json') },
      instructions:
        'Gemini CLI will start with an isolated profile. A browser opens — sign in with the Google ' +
        'account you want to add. usrouter detects the completed login automatically; you can close the terminal afterwards.',
      verify: async () => existsSync(join(geminiDir, 'oauth_creds.json')),
    };
  }
}
