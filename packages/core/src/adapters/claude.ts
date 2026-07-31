import { spawn } from 'node:child_process';
import type { LoginFlow, ProviderAdapter, RunRequest } from './adapter.js';
import { spawnLines } from './spawn.js';
import { getNumber, getObject, getString, tryParseJson } from './ndjson.js';
import { detectClaudeLimit } from './limits.js';
import { buildChildEnv } from '../accounts/env.js';
import type { AdapterEvent, PermissionMode, ResolvedAccount } from '../types.js';

const PERMISSION_ARGS: Record<PermissionMode, string[]> = {
  safe: ['--permission-mode', 'plan'],
  edits: ['--permission-mode', 'acceptEdits'],
  full: ['--dangerously-skip-permissions'],
};

export class ClaudeAdapter implements ProviderAdapter {
  readonly id = 'claude' as const;
  readonly displayName = 'Claude Code';
  readonly supportsNativeResume = true;
  readonly models = [
    { id: 'sonnet', label: 'Sonnet' },
    { id: 'opus', label: 'Opus' },
    { id: 'haiku', label: 'Haiku' },
    { id: 'fable', label: 'Fable' },
  ];

  constructor(private cliPath = 'claude') {}

  buildEnv(account: ResolvedAccount, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return buildChildEnv(account, base);
  }

  async *run(
    req: RunRequest,
    account: ResolvedAccount,
    signal: AbortSignal,
  ): AsyncGenerator<AdapterEvent> {
    // stream-json input keeps stdin open, so additional user messages can be
    // injected into the RUNNING session (Claude answers them as extra turns).
    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      ...PERMISSION_ARGS[req.permissionMode],
    ];
    if (req.model) args.push('--model', req.model);
    if (req.resumeSessionId) args.push('--resume', req.resumeSessionId);

    const env = this.buildEnv(account, process.env);
    let sawRateLimitRetry = false;
    let sawResult = false;
    let sessionEmitted = false;
    let stderrTail = '';
    let lastText = '';

    let stdin: NodeJS.WritableStream | undefined;
    let pendingTurns = 0;
    const writeUser = (text: string): boolean => {
      if (!stdin || !(stdin as NodeJS.WriteStream).writable) return false;
      pendingTurns++;
      stdin.write(
        JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n',
      );
      return true;
    };
    if (req.handle) req.handle.inject = writeUser;

    for await (const ev of spawnLines(this.cliPath, args, {
      cwd: req.cwd,
      env,
      signal,
      stdinPipe: true,
      onChild: (child) => {
        stdin = child.stdin ?? undefined;
        writeUser(req.prompt);
      },
    })) {
      if (ev.kind === 'spawn-error') {
        yield { type: 'error', message: ev.message, retryable: false };
        return;
      }
      if (ev.kind === 'exit') {
        if (!sawResult && ev.code !== 0) {
          const haystack = `${lastText}\n${stderrTail}`;
          const limit = sawRateLimitRetry
            ? (detectClaudeLimit(haystack) ?? { scope: 'unknown' as const, raw: haystack })
            : detectClaudeLimit(haystack);
          if (limit) {
            yield { type: 'limit', ...limit };
          } else {
            yield {
              type: 'error',
              message: stderrTail.trim() || `claude exited with code ${ev.code}`,
              retryable: false,
            };
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
      const type = msg.type;

      if (type === 'system') {
        if (msg.subtype === 'init') {
          const sid = getString(msg, 'session_id');
          if (sid && !sessionEmitted) {
            sessionEmitted = true;
            yield { type: 'session', sessionId: sid };
          }
        } else if (msg.subtype === 'api_retry' && msg.error === 'rate_limit') {
          sawRateLimitRetry = true;
        }
        continue;
      }

      // First-class limit signal (verified against claude 2.1.216 output):
      // {"type":"rate_limit_event","rate_limit_info":{"status":"rate_limited","resetsAt":...,"rateLimitType":"five_hour"}}
      if (type === 'rate_limit_event') {
        const status = getString(msg, 'rate_limit_info', 'status');
        if (status === 'rate_limited') {
          const resetsAt = getNumber(msg, 'rate_limit_info', 'resetsAt');
          const windowType = getString(msg, 'rate_limit_info', 'rateLimitType');
          yield {
            type: 'limit',
            resetAt: resetsAt ? resetsAt * 1000 : undefined,
            scope: windowType === 'seven_day' ? 'weekly' : 'session',
            raw: ev.line,
          };
          return;
        }
        continue;
      }

      if (type === 'stream_event') {
        // Skip subagent output; only the main thread streams to the transcript.
        if (msg.parent_tool_use_id) continue;
        const delta = getObject(msg, 'event', 'delta');
        if (delta && delta.type === 'text_delta' && typeof delta.text === 'string') {
          lastText = (lastText + delta.text).slice(-8192);
          yield { type: 'text-delta', text: delta.text };
        }
        continue;
      }

      if (type === 'assistant') {
        const content = getObject(msg, 'message')?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = block as Record<string, unknown>;
            if (b.type === 'tool_use' && typeof b.name === 'string') {
              yield { type: 'tool-use', name: b.name };
            }
          }
        }
        continue;
      }

      if (type === 'result') {
        sawResult = true;
        const text = getString(msg, 'result') ?? '';
        const isError = msg.is_error === true || String(msg.subtype ?? '').startsWith('error');
        const limit = detectClaudeLimit(text) ?? (sawRateLimitRetry && isError
          ? { scope: 'unknown' as const, raw: text }
          : undefined);
        if (isError && limit) {
          yield { type: 'limit', ...limit };
        } else if (isError) {
          yield { type: 'error', message: text || 'claude reported an error', retryable: false };
        } else {
          const sid = getString(msg, 'session_id');
          if (sid && !sessionEmitted) {
            sessionEmitted = true;
            yield { type: 'session', sessionId: sid };
          }
          yield {
            type: 'result',
            text,
            costUsd: getNumber(msg, 'total_cost_usd'),
            usage: {
              inputTokens: getNumber(msg, 'usage', 'input_tokens'),
              outputTokens: getNumber(msg, 'usage', 'output_tokens'),
            },
          };
        }
        // One result per turn: keep the session open while injected turns
        // are pending; close stdin when everything is answered.
        pendingTurns--;
        if (pendingTurns <= 0) {
          if (req.handle) req.handle.inject = undefined;
          stdin?.end();
        }
      }
    }
  }

  interactiveCommand(account: ResolvedAccount, model?: string) {
    const command = [this.cliPath];
    if (model) command.push('--model', model);
    return { command, env: this.buildEnv(account, process.env) };
  }

  loginFlow(profileDir: string): LoginFlow {
    return {
      terminalCommand: [this.cliPath, 'setup-token'],
      env: { CLAUDE_CONFIG_DIR: profileDir },
      // The printed token is captured from the terminal output automatically.
      watch: { kind: 'output-token', pattern: 'sk-ant-oat[A-Za-z0-9_-]{8,}' },
      postLoginSecretPrompt: 'oauth-token',
      instructions:
        'The terminal will run "claude setup-token": a browser opens — log in with the Claude account you want to add. ' +
        'If the CLI asks for an authorization code, paste it INTO THE TERMINAL. ' +
        'usturlab detects the token automatically when it appears.',
      verify: async () => true,
    };
  }

  /** Login flow for managed-home accounts (full config dir, no token). */
  managedLoginFlow(profileDir: string): LoginFlow {
    const check = () =>
      new Promise<boolean>((resolve) => {
        const child = spawn(this.cliPath, ['auth', 'status'], {
          env: { ...process.env, CLAUDE_CONFIG_DIR: profileDir },
          stdio: 'ignore',
        });
        child.on('error', () => resolve(false));
        child.on('close', (code) => resolve(code === 0));
      });
    return {
      terminalCommand: [this.cliPath, 'auth', 'login'],
      env: { CLAUDE_CONFIG_DIR: profileDir },
      watch: { kind: 'poll', check, intervalMs: 3000 },
      instructions:
        'The terminal will run "claude auth login": a browser opens — sign in with the Claude account you want to add. ' +
        'usturlab detects the completed login automatically.',
      verify: check,
    };
  }
}
