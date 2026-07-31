import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { LoginFlow, ProviderAdapter, RunRequest } from './adapter.js';
import { spawnLines } from './spawn.js';
import { getNumber, getObject, getString, tryParseJson } from './ndjson.js';
import { detectCodexLimit } from './limits.js';
import { buildChildEnv } from '../accounts/env.js';
import type { AdapterEvent, PermissionMode, ResolvedAccount } from '../types.js';

const SANDBOX: Record<PermissionMode, string> = {
  safe: 'read-only',
  edits: 'workspace-write',
  full: 'danger-full-access',
};

/** Codex wraps API errors as JSON-escaped strings, sometimes twice — dig out the human message. */
function unwrapErrorMessage(raw: string): string {
  let message = raw;
  for (let i = 0; i < 3; i++) {
    const trimmed = message.trim();
    if (!trimmed.startsWith('{')) break;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const nested =
        (parsed.error as Record<string, unknown> | undefined)?.message ?? parsed.message;
      if (typeof nested === 'string') {
        message = nested;
        continue;
      }
    } catch {
      break;
    }
    break;
  }
  return message;
}

export class CodexAdapter implements ProviderAdapter {
  readonly id = 'codex' as const;
  readonly displayName = 'Codex CLI';
  readonly supportsNativeResume = true;
  // ChatGPT-account Codex accepts few model ids and rejects the rest with a
  // 400; routing without a model (CLI default) is always safe. gpt-5.6-terra
  // verified as the served default on 2026-07-31.
  readonly models = [{ id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra (default)' }];

  constructor(private cliPath = 'codex') {}

  buildEnv(account: ResolvedAccount, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return buildChildEnv(account, base);
  }

  async *run(
    req: RunRequest,
    account: ResolvedAccount,
    signal: AbortSignal,
  ): AsyncGenerator<AdapterEvent> {
    const args = req.resumeSessionId
      ? ['exec', 'resume', req.resumeSessionId]
      : ['exec'];
    args.push('--json', '--skip-git-repo-check', '-s', SANDBOX[req.permissionMode]);
    if (req.model) args.push('-m', req.model);
    args.push(req.prompt);

    const env = this.buildEnv(account, process.env);
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
          const limit = detectCodexLimit(haystack);
          if (limit) yield { type: 'limit', ...limit };
          else if (ev.code !== 0) {
            yield {
              type: 'error',
              message: stderrTail.trim() || `codex exited with code ${ev.code}`,
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
        case 'thread.started': {
          const sid = getString(msg, 'thread_id') ?? getString(msg, 'session_id');
          if (sid) yield { type: 'session', sessionId: sid };
          break;
        }
        case 'item.started': {
          const item = getObject(msg, 'item');
          if (item?.item_type === 'command_execution' || item?.type === 'command_execution') {
            yield {
              type: 'tool-use',
              name: 'shell',
              detail: getString(item, 'command'),
            };
          }
          break;
        }
        case 'item.completed': {
          const item = getObject(msg, 'item');
          const itemType = item?.item_type ?? item?.type;
          if (itemType === 'agent_message') {
            const t = getString(item, 'text') ?? '';
            if (t) {
              text += (text ? '\n' : '') + t;
              yield { type: 'text-delta', text: t };
            }
          }
          break;
        }
        case 'turn.completed': {
          finished = true;
          yield {
            type: 'result',
            text,
            usage: {
              inputTokens: getNumber(msg, 'usage', 'input_tokens'),
              outputTokens: getNumber(msg, 'usage', 'output_tokens'),
            },
          };
          break;
        }
        case 'turn.failed':
        case 'error': {
          finished = true;
          const message = unwrapErrorMessage(
            getString(msg, 'error', 'message') ?? getString(msg, 'message') ?? 'codex turn failed',
          );
          const limit = detectCodexLimit(message);
          if (limit) yield { type: 'limit', ...limit };
          else yield { type: 'error', message, retryable: false };
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
    return {
      terminalCommand: [this.cliPath, 'login'],
      env: { CODEX_HOME: profileDir },
      watch: { kind: 'file', path: join(profileDir, 'auth.json') },
      instructions:
        'A browser window will open — sign in with the ChatGPT account you want to add. ' +
        'usrouter detects the completed login automatically.',
      verify: () =>
        new Promise<boolean>((resolve) => {
          const child = spawn(this.cliPath, ['login', 'status'], {
            env: { ...process.env, CODEX_HOME: profileDir },
            stdio: 'ignore',
          });
          child.on('error', () => resolve(false));
          child.on('close', (code) => resolve(code === 0));
        }),
    };
  }
}
