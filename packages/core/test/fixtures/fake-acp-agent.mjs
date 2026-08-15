#!/usr/bin/env node
/**
 * Minimal ACP agent used by tests: speaks the same JSON-RPC dialect as
 * `gemini --acp` / `copilot --acp` so the adapter can be verified end to end
 * without a live account. Behaviour is driven by the prompt text:
 *   "TOOL"       → emits a tool_call update
 *   "PERMISSION" → asks the client for permission before answering
 *   "SLOW"       → streams slowly so a test can inject mid-turn
 *   "LIMIT"      → fails the prompt with a quota error
 */
import { createInterface } from 'node:readline';

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const notify = (method, params) => send({ jsonrpc: '2.0', method, params });
const update = (sessionId, update) => notify('session/update', { sessionId, update });
const chunk = (sessionId, text) =>
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });

let nextServerId = 1000;
const serverPending = new Map();
const askPermission = (sessionId, title) =>
  new Promise((resolve) => {
    const id = nextServerId++;
    serverPending.set(id, resolve);
    send({
      jsonrpc: '2.0',
      id,
      method: 'session/request_permission',
      params: {
        sessionId,
        toolCall: { title, kind: 'execute' },
        options: [
          { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
          { optionId: 'no', name: 'Reject', kind: 'reject_once' },
        ],
      },
    });
  });

let sessionCounter = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The turn currently streaming, so a new prompt can cancel it like real agents do. */
let active = null;

async function runPrompt(sessionId, text, respond) {
  if (active) {
    active.cancelled = true;
    chunk(sessionId, 'Info: Operation cancelled by user');
  }
  const turn = { cancelled: false };
  active = turn;

  if (/LIMIT/.test(text)) {
    active = null;
    respond({ error: { code: -32000, message: 'Quota exceeded: RESOURCE_EXHAUSTED' } });
    return;
  }
  if (/TOOL/.test(text)) {
    update(sessionId, {
      sessionUpdate: 'tool_call',
      title: 'Shell',
      kind: 'execute',
      rawInput: { command: 'ls -la' },
    });
  }
  if (/PERMISSION/.test(text)) {
    const outcome = await askPermission(sessionId, 'Run shell command');
    chunk(sessionId, outcome === 'yes' ? 'PERMISSION-GRANTED' : 'PERMISSION-DENIED');
    if (turn.cancelled) return;
    active = null;
    respond({ result: { stopReason: 'end_turn' } });
    return;
  }

  const pieces = /SLOW/.test(text) ? ['one ', 'two ', 'three ', 'four ', 'five '] : ['done'];
  for (const piece of pieces) {
    if (turn.cancelled) break;
    chunk(sessionId, piece);
    await sleep(/SLOW/.test(text) ? 120 : 0);
  }
  if (/INJECTED/.test(text)) chunk(sessionId, 'INJECTED-OK');
  if (active === turn) active = null;
  // A cancelled turn settles last, exactly like the real agents.
  if (turn.cancelled) await sleep(80);
  // Usage is optional in the protocol; an agent that reports it puts it here,
  // in the shape the real Copilot bundle declares.
  const usage = /USAGE/.test(text)
    ? {
        usage: {
          inputTokens: 1200,
          outputTokens: 300,
          cachedReadTokens: 8000,
          cachedWriteTokens: 0,
          thoughtTokens: 0,
          totalTokens: 9500,
        },
      }
    : {};
  respond({ result: { stopReason: 'end_turn', ...usage } });
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  // Response to one of our server→client requests (permission).
  if (msg.id !== undefined && msg.result !== undefined && !msg.method) {
    const resolve = serverPending.get(msg.id);
    if (resolve) {
      serverPending.delete(msg.id);
      const outcome = msg.result?.outcome;
      resolve(outcome?.outcome === 'selected' ? outcome.optionId : 'cancelled');
      return;
    }
  }

  const respond = (payload) => send({ jsonrpc: '2.0', id: msg.id, ...payload });

  switch (msg.method) {
    case 'initialize':
      respond({
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true },
          agentInfo: { name: 'FakeAcp', version: '1.0.0' },
        },
      });
      break;
    case 'session/new':
      respond({ result: { sessionId: `fake-session-${++sessionCounter}` } });
      break;
    case 'session/load':
      if (String(msg.params?.sessionId ?? '').startsWith('fake-session-')) respond({ result: {} });
      else respond({ error: { code: -32000, message: 'unknown session' } });
      break;
    case 'session/prompt': {
      const text = (msg.params?.prompt ?? []).map((p) => p.text ?? '').join(' ');
      void runPrompt(msg.params.sessionId, text, respond);
      break;
    }
    default:
      if (msg.id !== undefined) respond({ result: {} });
  }
});
