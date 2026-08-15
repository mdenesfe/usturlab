import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AccountProfile, ProviderId } from '../types.js';

/**
 * Define MCP servers once (.usturlab/mcp.json) and fan them out to every
 * provider profile — each CLI has its own config format:
 *   claude  → <profile>/.claude.json          mcpServers
 *   gemini  → <profile>/.gemini/settings.json mcpServers
 *   codex   → <profile>/config.toml           [mcp_servers.*] (managed block)
 *   copilot → <profile>/mcp-config.json       mcpServers
 *
 * Fanning out is the default, not the rule. Every server a profile carries puts
 * its whole tool schema into that CLI's context on every single turn, so a
 * server four CLIs hold is a tax paid four times — and three of them may never
 * call it. `providers` narrows a server to the ones that should have it.
 */
export interface McpServerDef {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  /**
   * Which CLIs get this server. Omitted means all of them — the old behaviour,
   * kept so an existing mcp.json means exactly what it did before.
   */
  providers?: ProviderId[];
}

const PROVIDER_IDS: ReadonlySet<string> = new Set<ProviderId>([
  'claude',
  'codex',
  'gemini',
  'copilot',
  'openrouter',
]);

/** The servers this provider should actually be given. */
export function serversFor(
  provider: ProviderId,
  servers: Record<string, McpServerDef>,
): Record<string, McpServerDef> {
  const scoped: Record<string, McpServerDef> = {};
  for (const [name, def] of Object.entries(servers)) {
    if (def.providers && !def.providers.includes(provider)) continue;
    scoped[name] = def;
  }
  return scoped;
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
        providers: Array.isArray(d.providers)
          ? (d.providers.filter(
              (p): p is ProviderId => typeof p === 'string' && PROVIDER_IDS.has(p),
            ) as ProviderId[])
          : undefined,
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
  allServers: Record<string, McpServerDef>,
): string | undefined {
  if (!account.homeDir) return 'no profile directory';
  const servers = serversFor(account.provider, allServers);
  // A server this profile used to be given and is not being given now has to be
  // taken back out — merging alone would leave its schema in the profile, and
  // in that CLI's context, forever. Two ways that happens: it was scoped away
  // from this provider, or it was deleted from mcp.json entirely. The manifest
  // is what makes the second one visible; the current file covers profiles
  // written before there was a manifest.
  const previous = readManifest(account.homeDir);
  const dropped = [...new Set([...previous, ...Object.keys(allServers)])].filter(
    (name) => !(name in servers),
  );
  try {
    switch (account.provider) {
      case 'claude': {
        if (account.authMode !== 'managed-home') return 'token-only account (no profile config)';
        mergeJsonFile(join(account.homeDir, '.claude.json'), 'mcpServers', servers, dropped, (d) =>
          d.url ? { type: 'http', url: d.url } : { type: 'stdio', command: d.command, args: d.args ?? [], env: d.env ?? {} },
        );
        break;
      }
      case 'gemini': {
        mergeJsonFile(
          join(account.homeDir, '.gemini', 'settings.json'),
          'mcpServers',
          servers,
          dropped,
          (d) => (d.url ? { httpUrl: d.url } : { command: d.command, args: d.args ?? [], env: d.env ?? {} }),
        );
        break;
      }
      case 'copilot': {
        mergeJsonFile(join(account.homeDir, 'mcp-config.json'), 'mcpServers', servers, dropped, (d) =>
          d.url
            ? { type: 'http', url: d.url, tools: ['*'] }
            : { type: 'local', command: d.command, args: d.args ?? [], env: d.env ?? {}, tools: ['*'] },
        );
        break;
      }
      case 'codex': {
        // The managed block is rewritten whole, so a dropped server disappears
        // with it — nothing to remove by name.
        writeCodexToml(join(account.homeDir, 'config.toml'), servers);
        break;
      }
      default:
        return 'unsupported provider';
    }
    writeManifest(account.homeDir, Object.keys(servers));
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}

/**
 * What usturlab last wrote into this profile.
 *
 * Without it, a server deleted from mcp.json is simply never mentioned again —
 * and goes on being loaded by that CLI, and paid for in its context, until
 * someone edits the profile by hand.
 */
const MANIFEST = '.usturlab-mcp.json';

function readManifest(homeDir: string): string[] {
  const path = join(homeDir, MANIFEST);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { servers?: unknown };
    return Array.isArray(parsed.servers)
      ? parsed.servers.filter((s): s is string => typeof s === 'string')
      : [];
  } catch {
    return [];
  }
}

function writeManifest(homeDir: string, names: string[]): void {
  mkdirSync(homeDir, { recursive: true });
  writeFileSync(join(homeDir, MANIFEST), JSON.stringify({ servers: names }, null, 2));
}

function mergeJsonFile(
  path: string,
  key: string,
  servers: Record<string, McpServerDef>,
  dropped: string[],
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
  for (const name of dropped) delete current[name];
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
  "_help": "A server with no \\"providers\\" goes to every CLI, and every CLI then carries its tool schema in every turn. Narrow it with \\"providers\\": [\\"claude\\", \\"codex\\"] when only some of them need it.",
  "servers": {
    "context7": {
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp"]
    }
  }
}
`;
