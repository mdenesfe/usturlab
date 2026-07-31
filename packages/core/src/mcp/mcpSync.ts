import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AccountProfile } from '../types.js';

/**
 * Define MCP servers once (.usturlab/mcp.json) and fan them out to every
 * provider profile — each CLI has its own config format:
 *   claude  → <profile>/.claude.json          mcpServers
 *   gemini  → <profile>/.gemini/settings.json mcpServers
 *   codex   → <profile>/config.toml           [mcp_servers.*] (managed block)
 *   copilot → <profile>/mcp-config.json       mcpServers
 */
export interface McpServerDef {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export function parseMcpFile(
  content: string,
): { ok: true; servers: Record<string, McpServerDef> } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(content) as { servers?: unknown };
    if (parsed.servers === null || typeof parsed.servers !== 'object' || Array.isArray(parsed.servers)) {
      return { ok: false, error: 'missing "servers" object' };
    }
    const servers: Record<string, McpServerDef> = {};
    for (const [name, def] of Object.entries(parsed.servers as Record<string, unknown>)) {
      if (def === null || typeof def !== 'object') continue;
      const d = def as Record<string, unknown>;
      servers[name] = {
        command: typeof d.command === 'string' ? d.command : undefined,
        args: Array.isArray(d.args) ? d.args.filter((a): a is string => typeof a === 'string') : undefined,
        env:
          d.env && typeof d.env === 'object'
            ? Object.fromEntries(
                Object.entries(d.env as Record<string, unknown>).filter(
                  (kv): kv is [string, string] => typeof kv[1] === 'string',
                ),
              )
            : undefined,
        url: typeof d.url === 'string' ? d.url : undefined,
      };
    }
    return { ok: true, servers };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Returns an error string, or undefined on success/skip. */
export function syncMcpToProfile(
  account: AccountProfile,
  servers: Record<string, McpServerDef>,
): string | undefined {
  if (!account.homeDir) return 'no profile directory';
  try {
    switch (account.provider) {
      case 'claude': {
        if (account.authMode !== 'managed-home') return 'token-only account (no profile config)';
        return mergeJsonFile(join(account.homeDir, '.claude.json'), 'mcpServers', servers, (d) =>
          d.url ? { type: 'http', url: d.url } : { type: 'stdio', command: d.command, args: d.args ?? [], env: d.env ?? {} },
        );
      }
      case 'gemini': {
        return mergeJsonFile(
          join(account.homeDir, '.gemini', 'settings.json'),
          'mcpServers',
          servers,
          (d) => (d.url ? { httpUrl: d.url } : { command: d.command, args: d.args ?? [], env: d.env ?? {} }),
        );
      }
      case 'copilot': {
        return mergeJsonFile(join(account.homeDir, 'mcp-config.json'), 'mcpServers', servers, (d) =>
          d.url
            ? { type: 'http', url: d.url, tools: ['*'] }
            : { type: 'local', command: d.command, args: d.args ?? [], env: d.env ?? {}, tools: ['*'] },
        );
      }
      case 'codex': {
        return writeCodexToml(join(account.homeDir, 'config.toml'), servers);
      }
      default:
        return 'unsupported provider';
    }
  } catch (e) {
    return (e as Error).message;
  }
}

function mergeJsonFile(
  path: string,
  key: string,
  servers: Record<string, McpServerDef>,
  convert: (def: McpServerDef) => Record<string, unknown>,
): undefined {
  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      existing = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    } catch {
      existing = {};
    }
  }
  const current = (existing[key] as Record<string, unknown> | undefined) ?? {};
  for (const [name, def] of Object.entries(servers)) current[name] = convert(def);
  existing[key] = current;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(existing, null, 2));
  return undefined;
}

const BEGIN = '# usturlab-mcp-begin (managed — do not edit inside)';
const END = '# usturlab-mcp-end';

function writeCodexToml(path: string, servers: Record<string, McpServerDef>): undefined {
  const lines: string[] = [BEGIN];
  for (const [name, def] of Object.entries(servers)) {
    lines.push(`[mcp_servers.${tomlKey(name)}]`);
    if (def.url) lines.push(`url = ${JSON.stringify(def.url)}`);
    if (def.command) lines.push(`command = ${JSON.stringify(def.command)}`);
    if (def.args?.length) lines.push(`args = [${def.args.map((a) => JSON.stringify(a)).join(', ')}]`);
    if (def.env && Object.keys(def.env).length > 0) {
      lines.push(`[mcp_servers.${tomlKey(name)}.env]`);
      for (const [k, v] of Object.entries(def.env)) lines.push(`${tomlKey(k)} = ${JSON.stringify(v)}`);
    }
  }
  lines.push(END);
  const block = lines.join('\n');

  let content = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const beginIdx = content.indexOf(BEGIN);
  const endIdx = content.indexOf(END);
  if (beginIdx !== -1 && endIdx !== -1) {
    content = content.slice(0, beginIdx) + block + content.slice(endIdx + END.length);
  } else {
    content = content.trimEnd() + (content.trim() ? '\n\n' : '') + block + '\n';
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return undefined;
}

const tomlKey = (key: string) => (/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key));

export const MCP_TEMPLATE = `{
  "servers": {
    "context7": {
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp"]
    }
  }
}
`;
