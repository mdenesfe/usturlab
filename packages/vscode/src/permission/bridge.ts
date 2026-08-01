import * as vscode from 'vscode';
import { createServer, type Server } from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeToolKind, describeToolUse, type PermissionDecision, type PermissionRequest } from '@usturlab/core';

/**
 * Host side of Claude's permission bridge.
 *
 * Claude spawns the MCP server as its own process, so the two need a channel.
 * A loopback socket bound to 127.0.0.1 with a per-session random token is the
 * cheapest thing that works on every platform without leaving a socket file
 * behind — and the token means another local process cannot answer for us.
 */
export class PermissionBridge implements vscode.Disposable {
  private server?: Server;
  private port = 0;
  private token = randomBytes(24).toString('hex');
  private configPath?: string;
  private nextId = 0;

  constructor(
    private serverScript: string,
    /** Asks the user; resolving to a decision releases the waiting CLI. */
    private onRequest: (request: PermissionRequest) => Promise<PermissionDecision>,
    private output: vscode.OutputChannel,
  ) {}

  /** Starts listening. Safe to call repeatedly. */
  async start(): Promise<void> {
    if (this.server) return;
    await new Promise<void>((resolve) => {
      const server = createServer((socket) => {
        let buffer = '';
        socket.on('data', (chunk) => {
          buffer += chunk.toString();
          const nl = buffer.indexOf('\n');
          if (nl < 0) return;
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          void this.answer(line).then((decision) => {
            socket.write(JSON.stringify(decision) + '\n');
          });
        });
        socket.on('error', () => socket.destroy());
      });
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        this.port = typeof address === 'object' && address ? address.port : 0;
        this.server = server;
        this.output.appendLine(`[permission] bridge listening on 127.0.0.1:${this.port}`);
        resolve();
      });
      server.on('error', (e) => {
        this.output.appendLine(`[permission] bridge failed: ${e.message}`);
        resolve();
      });
    });
  }

  private async answer(line: string): Promise<{ allow: boolean; message?: string }> {
    let payload: { token?: string; toolName?: string; input?: unknown; toolUseId?: string };
    try {
      payload = JSON.parse(line) as typeof payload;
    } catch {
      return { allow: false, message: 'malformed request' };
    }
    if (payload.token !== this.token) return { allow: false, message: 'unauthorized' };

    const toolName = String(payload.toolName ?? 'a tool');
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const info = describeToolUse(toolName, payload.input, cwd);
    const decision = await this.onRequest({
      id: `claude-${++this.nextId}`,
      kind: claudeToolKind(toolName),
      title: info.detail ? `${toolName} ${info.detail}` : toolName,
      detail: info.preview ?? info.detail,
      path: info.path,
    });
    return decision.outcome === 'deny'
      ? { allow: false, message: decision.reason ?? 'denied by the user' }
      : { allow: true };
  }

  /**
   * The `--mcp-config` file and the env the CLI needs. Written once per
   * session into a temp dir; the token never touches the workspace.
   */
  claudeArgs(): { args: string[]; env: Record<string, string> } | undefined {
    if (!this.server || !this.port) return undefined;
    if (!this.configPath) {
      const dir = mkdtempSync(join(tmpdir(), 'usturlab-perm-'));
      this.configPath = join(dir, 'mcp.json');
      writeFileSync(
        this.configPath,
        JSON.stringify({
          mcpServers: {
            usturlab: {
              command: process.execPath,
              args: [this.serverScript],
              env: {
                USTURLAB_PERMISSION_PORT: String(this.port),
                USTURLAB_PERMISSION_TOKEN: this.token,
              },
            },
          },
        }),
      );
    }
    return {
      args: ['--mcp-config', this.configPath, '--permission-prompt-tool', 'mcp__usturlab__approve'],
      env: {
        USTURLAB_PERMISSION_PORT: String(this.port),
        USTURLAB_PERMISSION_TOKEN: this.token,
      },
    };
  }

  dispose(): void {
    this.server?.close();
    this.server = undefined;
  }
}
