import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { LoginFlow, ProviderAdapter, RunRequest } from './adapter.js';
import { EventQueue, JsonRpcProcess, type RpcNotification } from './jsonRpc.js';
import { getNumber, getObject, getString } from './ndjson.js';
import { detectCodexLimit, isTransientFailure } from './limits.js';
import { describeToolUse } from './toolDetail.js';
import { sameTasks, tasksFromCodexPlan } from './taskList.js';
import { PermissionGate, codexApprovalKind } from './permission.js';
import { buildChildEnv } from '../accounts/env.js';
import type { AdapterEvent, PermissionMode, ResolvedAccount, Usage } from '../types.js';

const SANDBOX: Record<PermissionMode, string> = {
  safe: 'read-only',
  edits: 'workspace-write',
  full: 'danger-full-access',
};

/**
 * Codex already counts the cache into `input_tokens` and breaks out the cached
 * part, so the input side needs no arithmetic. Its reasoning tokens are billed
 * and produced like output but reported separately, so they belong in the
 * output figure rather than nowhere.
 */
export function codexUsage(usage: Record<string, unknown> | undefined): Usage {
  const at = (key: string): number => getNumber(usage, key) ?? 0;
  const input = at('input_tokens');
  const cached = at('cached_input_tokens');
  const output = at('output_tokens') + at('reasoning_output_tokens');
  const result: Usage = {};
  if (input > 0) result.inputTokens = input;
  if (output > 0) result.outputTokens = output;
  if (cached > 0) result.cachedInputTokens = cached;
  return result;
}

/** Item types worth showing in the tool timeline, mapped to display names. */
const TOOL_ITEM_NAMES: Record<string, string> = {
  commandExecution: 'Shell',
  fileChange: 'Edit',
  mcpToolCall: 'MCP',
  dynamicToolCall: 'Tool',
  webSearch: 'WebSearch',
  imageView: 'ViewImage',
  subAgentActivity: 'Agent',
  collabAgentToolCall: 'Agent',
  contextCompaction: 'Compact',
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

/**
 * Codex over its app-server protocol (line-delimited JSON-RPC) — the same
 * transport its editor integrations use. Unlike `codex exec`, the thread
 * stays open, so `turn/steer` can push a message into the RUNNING turn and
 * the model reacts immediately.
 */
export class CodexAdapter implements ProviderAdapter {
  readonly id = 'codex' as const;
  readonly displayName = 'Codex CLI';
  readonly supportsNativeResume = true;
  // ChatGPT-account Codex rejects most explicit model ids with a 400;
  // routing without a model (CLI default) is always safe.
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
    const events = new EventQueue<AdapterEvent>();
    const env = this.buildEnv(account, process.env);

    let threadId: string | undefined;
    let activeTurnId: string | undefined;
    let text = '';
    let finished = false;
    let stderrTail = '';
    let lastTasks: ReturnType<typeof tasksFromCodexPlan> = [];
    const openItems = new Map<string, string>();

    const gate = new PermissionGate({
      mode: req.permissionMode,
      ask: req.askPermission === true,
      emit: (request) => events.push({ type: 'permission', request }),
      resolved: (id, allowed) => events.push({ type: 'permission-resolved', id, allowed }),
    });
    if (req.handle) req.handle.respondPermission = (id, decision) => gate.respond(id, decision);

    const finish = (event?: AdapterEvent) => {
      if (finished) return;
      finished = true;
      gate.close();
      if (event) events.push(event);
      events.end();
      rpc.dispose();
    };

    const onNotification = (n: RpcNotification) => {
      switch (n.method) {
        case 'thread/started': {
          const id = getString(n.params, 'thread', 'id') ?? getString(n.params, 'threadId');
          if (id && !threadId) {
            threadId = id;
            events.push({ type: 'session', sessionId: id });
          }
          break;
        }
        case 'turn/started': {
          activeTurnId =
            getString(n.params, 'turn', 'id') ?? getString(n.params, 'turnId') ?? activeTurnId;
          break;
        }
        case 'item/agentMessage/delta': {
          const delta = getString(n.params, 'delta');
          if (delta) {
            text += delta;
            events.push({ type: 'text-delta', text: delta });
          }
          break;
        }
        case 'item/started': {
          const item = getObject(n.params, 'item');
          const type = getString(item, 'type');
          const itemId = getString(item, 'id');
          if (!type) break;
          const name = TOOL_ITEM_NAMES[type];
          if (name) {
            if (itemId) openItems.set(itemId, name);
            // Codex puts the arguments on the item itself; the shared describer
            // turns them into the same file/diff view every provider gets.
            const info = describeToolUse(
              getString(item, 'toolName') ?? name,
              { ...item, ...(getObject(item, 'arguments') ?? {}) },
              req.cwd,
            );
            events.push({
              type: 'tool-use',
              name,
              detail: info.detail,
              preview: info.preview,
              path: info.path,
              action: info.action,
            });
          }
          break;
        }
        case 'turn/plan/updated': {
          const items = tasksFromCodexPlan(n.params);
          if (items.length > 0 && !sameTasks(items, lastTasks)) {
            lastTasks = items;
            events.push({ type: 'tasks', items });
          }
          break;
        }
        case 'item/completed': {
          const item = getObject(n.params, 'item');
          const itemId = getString(item, 'id');
          if (itemId) openItems.delete(itemId);
          break;
        }
        case 'turn/completed': {
          const turn = getObject(n.params, 'turn');
          const status = getString(turn, 'status');
          if (status === 'failed') {
            const message = unwrapErrorMessage(
              getString(turn, 'error', 'message') ?? 'codex turn failed',
            );
            const limit = detectCodexLimit(message);
            finish(limit ? { type: 'limit', ...limit } : { type: 'error', message, retryable: isTransientFailure(message) });
            break;
          }
          finish({ type: 'result', text, usage: codexUsage(getObject(turn, 'usage')) });
          break;
        }
        case 'error': {
          const message = unwrapErrorMessage(getString(n.params, 'message') ?? 'codex error');
          const limit = detectCodexLimit(message);
          finish(limit ? { type: 'limit', ...limit } : { type: 'error', message, retryable: isTransientFailure(message) });
          break;
        }
        default:
          break;
      }
    };

    // Codex takes reasoning effort as a config key, and `-c` overrides it for
    // this process only — the user's own config.toml is left alone.
    const effortArgs = req.effort ? ['-c', `model_reasoning_effort=${req.effort}`] : [];

    const rpc = new JsonRpcProcess(this.cliPath, [...effortArgs, 'app-server'], {
      cwd: req.cwd,
      env,
      signal,
      onNotification,
      // Codex asks before running commands and before applying patches. In
      // ask mode that question reaches the user; otherwise the permission
      // mode answers it, and a run never hangs on a dialog nobody sees.
      onServerRequest: async (r) => {
        const kind = codexApprovalKind(r.method);
        if (!kind) return { decision: 'approved' };
        const detail =
          getString(r.params, 'command') ??
          getString(r.params, 'reason') ??
          getString(r.params, 'patch');
        const decision = await gate.ask({
          id: `${r.id}`,
          kind,
          title:
            kind === 'command'
              ? `run \`${(detail ?? 'a command').split('\n')[0]}\``
              : kind === 'edit'
                ? `apply changes to ${getString(r.params, 'path') ?? 'the workspace'}`
                : 'a permission change',
          detail,
          path: getString(r.params, 'path'),
        });
        return { decision: decision.outcome === 'deny' ? 'denied' : 'approved' };
      },
      onStderr: (line) => {
        if (!line.includes('models cache')) stderrTail = (stderrTail + '\n' + line).slice(-4096);
      },
      onExit: () => {
        if (!finished) {
          const haystack = `${text}\n${stderrTail}`;
          const limit = detectCodexLimit(haystack);
          if (limit) finish({ type: 'limit', ...limit });
          else if (text) finish({ type: 'result', text });
          else {
            const message = stderrTail.trim() || 'codex app-server exited unexpectedly';
            finish({ type: 'error', message, retryable: isTransientFailure(message) });
          }
        }
      },
      onSpawnError: (message) => finish({ type: 'error', message, retryable: false }),
    });

    rpc.start();

    void (async () => {
      try {
        await rpc.request('initialize', {
          clientInfo: { name: 'usturlab', version: '0.1.0' },
        });
        rpc.notify('initialized', {});

        const threadParams: Record<string, unknown> = {
          cwd: req.cwd,
          // 'never' would decide everything server-side and never reach us, so
          // ask mode has to opt in to being asked.
          approvalPolicy: req.askPermission ? 'on-request' : 'never',
          sandbox: SANDBOX[req.permissionMode],
        };
        if (req.model) threadParams.model = req.model;
        // developerInstructions adds to Codex's own base prompt; baseInstructions
        // would replace it, which would make it worse, not better.
        if (req.systemBrief?.trim()) threadParams.developerInstructions = req.systemBrief;

        let started: Record<string, unknown>;
        // A thread that could not be resumed is a thread that remembers
        // nothing, so the message written for it has to change too.
        let resumed = false;
        if (req.resumeSessionId) {
          try {
            started = await rpc.request('thread/resume', {
              ...threadParams,
              threadId: req.resumeSessionId,
            });
            resumed = true;
          } catch {
            // Thread rolled off disk or belongs to another cwd — start fresh.
            started = await rpc.request('thread/start', threadParams);
          }
        } else {
          started = await rpc.request('thread/start', threadParams);
        }
        const id = getString(started, 'thread', 'id') ?? getString(started, 'threadId');
        if (id && !threadId) {
          threadId = id;
          events.push({ type: 'session', sessionId: id });
        }
        if (!threadId) throw new Error('codex app-server did not return a thread id');

        const turn = await rpc.request('turn/start', {
          threadId,
          input: [{ type: 'text', text: resumed ? req.prompt : (req.coldPrompt ?? req.prompt) }],
        });
        activeTurnId = getString(turn, 'turn', 'id') ?? activeTurnId;

        // Live steering: a message sent while this turn runs reaches the model.
        if (req.handle) {
          // turn/steer folds the message into the running turn.
          req.handle.injectMode = 'inline';
          req.handle.inject = (injected: string) => {
            if (finished || !threadId || !activeTurnId) return false;
            void rpc
              .request('turn/steer', {
                threadId,
                expectedTurnId: activeTurnId,
                input: [{ type: 'text', text: injected }],
              })
              .catch(() => undefined);
            return true;
          };
        }
      } catch (e) {
        const message = unwrapErrorMessage((e as Error).message);
        const limit = detectCodexLimit(message);
        finish(limit ? { type: 'limit', ...limit } : { type: 'error', message, retryable: isTransientFailure(message) });
      }
    })();

    try {
      for await (const event of events) yield event;
    } finally {
      if (req.handle) req.handle.inject = undefined;
      rpc.dispose();
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
        'usturlab detects the completed login automatically.',
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
