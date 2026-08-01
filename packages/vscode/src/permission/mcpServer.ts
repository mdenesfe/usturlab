/**
 * A one-tool MCP server, spawned by the Claude CLI, that asks usturlab.
 *
 * Claude Code cannot ask for permission over stream-json in headless mode —
 * `--permission-mode manual` silently degrades to `default` and the tool just
 * runs. Its real hook is `--permission-prompt-tool`, which names an MCP tool
 * Claude calls before every action. This file is that tool.
 *
 * It holds no policy of its own: it forwards the question to the extension
 * over a loopback socket and returns whatever the user decided. If the
 * extension is unreachable it denies, because a permission prompt that fails
 * open is worse than no permission prompt at all.
 *
 * Bundled separately from the extension — it runs as its own process.
 */
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';

const PORT = Number(process.env.USTURLAB_PERMISSION_PORT ?? 0);
const TOKEN = process.env.USTURLAB_PERMISSION_TOKEN ?? '';
const ASK_TIMEOUT_MS = 10 * 60_000;

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

function send(message: JsonRpcMessage): void {
  process.stdout.write(JSON.stringify(message) + '\n');
}

/** Asks the extension host; denies if it cannot be reached or does not answer. */
async function askHost(payload: Record<string, unknown>): Promise<{ allow: boolean; message?: string }> {
  if (!PORT || !TOKEN) return { allow: false, message: 'usturlab is not reachable' };
  return new Promise((resolve) => {
    const socket = createConnection({ port: PORT, host: '127.0.0.1' });
    const done = (value: { allow: boolean; message?: string }) => {
      socket.destroy();
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(
      () => done({ allow: false, message: 'timed out waiting for a decision' }),
      ASK_TIMEOUT_MS,
    );

    socket.on('error', () => done({ allow: false, message: 'usturlab is not reachable' }));
    socket.on('connect', () => socket.write(JSON.stringify({ token: TOKEN, ...payload }) + '\n'));

    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const nl = buffer.indexOf('\n');
      if (nl < 0) return;
      try {
        const answer = JSON.parse(buffer.slice(0, nl)) as { allow?: boolean; message?: string };
        done({ allow: answer.allow === true, message: answer.message });
      } catch {
        done({ allow: false, message: 'malformed decision' });
      }
    });
    socket.on('close', () => done({ allow: false, message: 'connection closed' }));
  });
}

const TOOL = {
  name: 'approve',
  description:
    'Ask the user to approve a tool call. Called automatically by Claude Code before it acts.',
  inputSchema: {
    type: 'object',
    properties: {
      tool_name: { type: 'string' },
      input: { type: 'object' },
      tool_use_id: { type: 'string' },
    },
    required: ['tool_name', 'input'],
  },
};

async function handle(message: JsonRpcMessage): Promise<void> {
  const { id, method, params } = message;
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'usturlab', version: '1.0.0' },
      },
    });
    return;
  }
  if (method === 'notifications/initialized') return;
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: [TOOL] } });
    return;
  }
  if (method === 'tools/call') {
    const args = (params?.arguments ?? {}) as Record<string, unknown>;
    const decision = await askHost({
      toolName: args.tool_name,
      input: args.input,
      toolUseId: args.tool_use_id,
    });
    // The contract Claude expects: a single JSON text block naming the behavior.
    const behavior = decision.allow
      ? { behavior: 'allow', updatedInput: args.input }
      : { behavior: 'deny', message: decision.message ?? 'denied by the user' };
    send({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: JSON.stringify(behavior) }] },
    });
    return;
  }
  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${method}` } });
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let message: JsonRpcMessage;
  try {
    message = JSON.parse(line) as JsonRpcMessage;
  } catch {
    return;
  }
  void handle(message);
});
