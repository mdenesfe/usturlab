import { EventQueue, JsonRpcProcess } from './jsonRpc.js';
import { getObject, getString } from './ndjson.js';
import { isTransientFailure } from './limits.js';
import { describeToolUse } from './toolDetail.js';
import { sameTasks, tasksFromAcpPlan } from './taskList.js';
import { PermissionGate, acpPermissionKind } from './permission.js';
import type { AdapterEvent, LimitInfo } from '../types.js';
import type { RunRequest } from './adapter.js';

/**
 * Agent Client Protocol runner — the JSON-RPC dialect Gemini CLI (`--acp`)
 * and Copilot CLI (`--acp`) both speak for editor integration. One open
 * session per run means a message sent mid-turn reaches the agent live
 * (verified against Copilot: the running turn is cancelled and the new
 * message is answered inside the same session, keeping its context).
 */

export interface AcpOptions {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  req: RunRequest;
  signal: AbortSignal;
  detectLimit: (text: string) => LimitInfo | undefined;
  /** Legacy fallback when the CLI does not understand ACP. */
  onUnsupported?: () => void;
}

export async function* runAcp(opts: AcpOptions): AsyncGenerator<AdapterEvent> {
  const { req, signal } = opts;
  const events = new EventQueue<AdapterEvent>();

  let sessionId: string | undefined;
  let text = '';
  let finished = false;
  let stderrTail = '';
  // A cancelled prompt settles AFTER the one that replaced it, so the run
  // ends only when every outstanding prompt has settled.
  let outstanding = 0;
  // Index into `text` where the current turn's output starts.
  let segStart = 0;

  let refusal = false;
  let lastTasks: ReturnType<typeof tasksFromAcpPlan> = [];

  const gate = new PermissionGate({
    mode: req.permissionMode,
    ask: req.askPermission === true,
    emit: (request) => events.push({ type: 'permission', request }),
    resolved: (id, allowed) => events.push({ type: 'permission-resolved', id, allowed }),
  });
  if (req.handle) req.handle.respondPermission = (id, decision) => gate.respond(id, decision);

  /** One outstanding prompt settled; the last one ends the run. */
  const settle = (error?: Error) => {
    outstanding = Math.max(0, outstanding - 1);
    if (outstanding > 0 || finished) return;
    if (error) {
      finish({ type: 'error', message: error.message, retryable: isTransientFailure(error.message) });
    } else if (refusal) {
      finish({ type: 'error', message: text || 'agent refused the request', retryable: false });
    } else {
      finish({ type: 'result', text: text.slice(segStart) });
    }
  };

  const finish = (event?: AdapterEvent) => {
    if (finished) return;
    finished = true;
    gate.close();
    if (event) events.push(event);
    events.end();
    rpc.dispose();
  };

  const rpc = new JsonRpcProcess(opts.command, opts.args, {
    cwd: req.cwd,
    env: opts.env,
    signal,
    onNotification: (n) => {
      if (n.method !== 'session/update') return;
      const update = getObject(n.params, 'update');
      const kind = getString(update, 'sessionUpdate');
      switch (kind) {
        case 'agent_message_chunk': {
          const chunk = getString(update, 'content', 'text');
          // Cancellation notices are protocol noise, not model output.
          if (chunk && /^Info: Operation cancelled by user\.?$/i.test(chunk.trim())) break;
          if (chunk) {
            text += chunk;
            events.push({ type: 'text-delta', text: chunk });
          }
          break;
        }
        case 'tool_call': {
          const title = getString(update, 'title') ?? getString(update, 'kind') ?? 'tool';
          const rawInput = getObject(update, 'rawInput') ?? {};
          const located = getString(update, 'locations', '0', 'path');
          const info = describeToolUse(
            getString(update, 'kind') ?? title,
            located ? { path: located, ...rawInput } : rawInput,
            req.cwd,
          );
          // ACP ships the real before/after for an edit; prefer it over ours.
          const diff = getObject(update, 'content', '0');
          const preview =
            getString(diff, 'type') === 'diff'
              ? describeToolUse(
                  'edit',
                  {
                    file_path: getString(diff, 'path') ?? located,
                    old_string: getString(diff, 'oldText') ?? '',
                    new_string: getString(diff, 'newText') ?? '',
                  },
                  req.cwd,
                ).preview
              : info.preview;
          events.push({
            type: 'tool-use',
            name: title,
            detail: info.detail,
            preview,
            path: info.path,
            action: info.action,
          });
          break;
        }
        case 'plan': {
          const items = tasksFromAcpPlan(update);
          if (items.length > 0 && !sameTasks(items, lastTasks)) {
            lastTasks = items;
            events.push({ type: 'tasks', items });
          }
          break;
        }
        default:
          break;
      }
    },
    onServerRequest: async (r) => {
      if (r.method === 'session/request_permission') {
        const options = (r.params.options as Array<{ optionId?: string; kind?: string }>) ?? [];
        const toolCall = getObject(r.params, 'toolCall') ?? {};
        const title = getString(toolCall, 'title') ?? 'perform an action';
        const decision = await gate.ask({
          id: `${r.id}`,
          kind: acpPermissionKind(getString(toolCall, 'kind')),
          title,
          detail:
            getString(toolCall, 'rawInput', 'command') ??
            getString(toolCall, 'rawInput', 'description'),
          path: getString(toolCall, 'locations', '0', 'path'),
        });

        // ACP wants one of the options the agent offered; map our answer onto
        // whichever of them means the same thing.
        const byKind = (kind: string) => options.find((o) => o.kind === kind);
        if (decision.outcome === 'deny') {
          const reject = byKind('reject_once') ?? byKind('reject_always');
          return reject?.optionId
            ? { outcome: { outcome: 'selected', optionId: reject.optionId } }
            : { outcome: { outcome: 'cancelled' } };
        }
        const allow =
          decision.outcome === 'allow-always'
            ? (byKind('allow_always') ?? byKind('allow_once'))
            : (byKind('allow_once') ?? byKind('allow_always'));
        const chosen = allow ?? options[0];
        return chosen?.optionId
          ? { outcome: { outcome: 'selected', optionId: chosen.optionId } }
          : { outcome: { outcome: 'cancelled' } };
      }
      // We advertise no client filesystem, so nothing else needs answering.
      return {};
    },
    onStderr: (line) => {
      if (line.trim()) stderrTail = (stderrTail + '\n' + line).slice(-4096);
    },
    onExit: () => {
      if (finished) return;
      const haystack = `${text}\n${stderrTail}`;
      const limit = opts.detectLimit(haystack);
      if (limit) finish({ type: 'limit', ...limit });
      else if (text) finish({ type: 'result', text });
      else {
        const message = stderrTail.trim() || `${opts.command} exited unexpectedly`;
        finish({ type: 'error', message, retryable: isTransientFailure(message) });
      }
    },
    onSpawnError: (message) => finish({ type: 'error', message, retryable: false }),
  });

  rpc.start();

  void (async () => {
    try {
      await rpc.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      });

      let created: Record<string, unknown> | undefined;
      if (req.resumeSessionId) {
        try {
          created = await rpc.request('session/load', {
            sessionId: req.resumeSessionId,
            cwd: req.cwd,
            mcpServers: [],
          });
          sessionId = req.resumeSessionId;
        } catch {
          created = undefined;
        }
      }
      if (!sessionId) {
        created = await rpc.request('session/new', { cwd: req.cwd, mcpServers: [] });
        sessionId = getString(created, 'sessionId');
      }
      if (!sessionId) throw new Error('ACP agent did not return a session id');
      events.push({ type: 'session', sessionId });

      // Live mid-run messaging: another session/prompt reaches the agent now.
      if (req.handle) {
        req.handle.injectMode = 'turn';
        req.handle.inject = (injected: string) => {
          if (finished || !sessionId) return false;
          // ACP agents cancel the running turn and answer the new message, so
          // close the interrupted turn with whatever it produced.
          events.push({ type: 'result', text: text.slice(segStart) });
          segStart = text.length;
          outstanding++;
          void rpc
            .request(
              'session/prompt',
              { sessionId, prompt: [{ type: 'text', text: injected }] },
              30 * 60_000,
            )
            .then(() => settle())
            .catch((e) => settle(e as Error));
          return true;
        };
      }

      // ACP has no system-prompt slot, so standing instructions ride on the
      // first prompt of a session — and again only when they changed.
      const brief = req.systemBrief?.trim();
      const needsBrief = !!brief && (!req.resumeSessionId || req.restateBrief === true);
      const promptText = needsBrief
        ? `Standing instructions for this session — follow them for every turn, ` +
          `and do not acknowledge them:\n${brief}\n\n---\n\n${req.prompt}`
        : req.prompt;

      outstanding++;
      const response = await rpc.request(
        'session/prompt',
        { sessionId, prompt: [{ type: 'text', text: promptText }] },
        30 * 60_000,
      );
      refusal = getString(response, 'stopReason') === 'refusal';
      settle();
    } catch (e) {
      const message = (e as Error).message;
      if (/unknown option|unexpected argument|unrecognized/i.test(message)) {
        opts.onUnsupported?.();
        finish({
          type: 'error',
          message: `${opts.command} does not support ACP — update the CLI`,
          retryable: false,
        });
        return;
      }
      const limit = opts.detectLimit(message);
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
