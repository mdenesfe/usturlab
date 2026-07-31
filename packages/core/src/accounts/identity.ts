import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { AccountProfile } from '../types.js';

/**
 * Best-effort identity (usually the login email) for an account, read from
 * each CLI's local state — so the accounts panel can show WHICH claude/google/
 * github identity a profile belongs to. Never throws; undefined when unknown.
 */
export async function getAccountIdentity(
  account: AccountProfile,
  claudeCliPath = 'claude',
): Promise<string | undefined> {
  try {
    switch (account.provider) {
      case 'gemini': {
        if (!account.homeDir) return undefined;
        const file = join(account.homeDir, '.gemini', 'google_accounts.json');
        if (!existsSync(file)) return undefined;
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
        return typeof parsed.active === 'string' ? parsed.active : undefined;
      }
      case 'codex': {
        if (!account.homeDir) return undefined;
        const file = join(account.homeDir, 'auth.json');
        if (!existsSync(file)) return undefined;
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
        if (typeof parsed.email === 'string') return parsed.email;
        const idToken = (parsed.tokens as Record<string, unknown> | undefined)?.id_token;
        if (typeof idToken === 'string') return emailFromJwt(idToken);
        return undefined;
      }
      case 'claude': {
        if (account.authMode !== 'managed-home' || !account.homeDir) return undefined;
        const json = await execJson(claudeCliPath, ['auth', 'status', '--json'], {
          CLAUDE_CONFIG_DIR: account.homeDir,
        });
        if (!json) return undefined;
        for (const key of ['email', 'emailAddress', 'account', 'user'] as const) {
          const value = json[key];
          if (typeof value === 'string' && value.includes('@')) return value;
          if (value && typeof value === 'object') {
            const nested = (value as Record<string, unknown>).email ?? (value as Record<string, unknown>).emailAddress;
            if (typeof nested === 'string') return nested;
          }
        }
        return undefined;
      }
      case 'copilot': {
        if (!account.homeDir) return undefined;
        const file = join(account.homeDir, 'config.json');
        if (!existsSync(file)) return undefined;
        // JSONC — strip line comments before parsing.
        const raw = readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const last = parsed.lastLoggedInUser as Record<string, unknown> | undefined;
        if (last && typeof last.login === 'string') return last.login;
        return undefined;
      }
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

function emailFromJwt(jwt: string): string | undefined {
  try {
    const payload = jwt.split('.')[1];
    if (!payload) return undefined;
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    return typeof decoded.email === 'string' ? decoded.email : undefined;
  } catch {
    return undefined;
  }
}

function execJson(
  command: string,
  args: string[],
  env: Record<string, string>,
): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: { ...process.env, ...env } });
    let out = '';
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', () => resolve(undefined));
    child.on('close', () => {
      try {
        resolve(JSON.parse(out) as Record<string, unknown>);
      } catch {
        resolve(undefined);
      }
    });
    setTimeout(() => child.kill('SIGTERM'), 8000).unref();
  });
}
