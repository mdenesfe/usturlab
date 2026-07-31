import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { AccountProfile, ProviderId } from '@usturlab/core';
import type { AccountStore } from './storage/accountStore.js';

const OLD_ROOT = join(homedir(), '.usrouter');
const NEW_ROOT = join(homedir(), '.usturlab');
const PROVIDERS: ProviderId[] = ['claude', 'codex', 'gemini', 'copilot'];

/**
 * One-time usrouter → usturlab migration:
 * 1. moves ~/.usrouter to ~/.usturlab (CLI logins live in the profile dirs)
 * 2. duplicates Claude's path-hashed Keychain entries for the new paths
 * 3. rebuilds account metadata from the profile dirs (the old extension id's
 *    storage is unreachable) — only profiles with a live login come back
 */
export async function migrateFromUsrouter(
  accounts: AccountStore,
  log: (line: string) => void,
): Promise<void> {
  try {
    if (existsSync(OLD_ROOT) && !existsSync(NEW_ROOT)) {
      const oldProfiles = join(OLD_ROOT, 'profiles');
      const dirs = existsSync(oldProfiles) ? readdirSync(oldProfiles) : [];
      renameSync(OLD_ROOT, NEW_ROOT);
      log('[migrate] moved ~/.usrouter → ~/.usturlab');
      if (process.platform === 'darwin') {
        for (const dir of dirs) {
          if (!dir.startsWith('claude-')) continue;
          await copyClaudeKeychain(join(oldProfiles, dir), join(NEW_ROOT, 'profiles', dir), log);
        }
      }
    }

    const profilesRoot = join(NEW_ROOT, 'profiles');
    if (accounts.all().length > 0 || !existsSync(profilesRoot)) return;

    let priority = 1;
    for (const dir of readdirSync(profilesRoot)) {
      const provider = PROVIDERS.find((p) => dir.startsWith(`${p}-`));
      if (!provider) continue;
      const homeDir = join(profilesRoot, dir);
      if (!(await hasLiveLogin(provider, homeDir))) continue;
      const profile: AccountProfile = {
        id: dir,
        provider,
        label: dir.slice(provider.length + 1) || 'personal',
        authMode: 'managed-home',
        homeDir,
        hasSecret: false,
        priority: priority++,
      };
      await accounts.upsert(profile);
      log(`[migrate] restored account ${provider}:${profile.label}`);
    }
  } catch (e) {
    log(`[migrate] ${(e as Error).message}`);
  }
}

const sha8 = (path: string) => createHash('sha256').update(path).digest('hex').slice(0, 8);

function copyClaudeKeychain(
  oldPath: string,
  newPath: string,
  log: (line: string) => void,
): Promise<void> {
  return new Promise((resolve) => {
    const oldService = `Claude Code-credentials-${sha8(oldPath)}`;
    const newService = `Claude Code-credentials-${sha8(newPath)}`;
    execFile('security', ['find-generic-password', '-s', oldService, '-w'], (err, stdout) => {
      const secret = err ? undefined : stdout.trim();
      if (!secret) return resolve();
      const account = process.env.USER ?? 'user';
      execFile(
        'security',
        ['add-generic-password', '-U', '-a', account, '-s', newService, '-w', secret],
        (addErr) => {
          if (!addErr) log(`[migrate] rekeyed Claude credential for ${newPath}`);
          resolve();
        },
      );
    });
  });
}

async function hasLiveLogin(provider: ProviderId, homeDir: string): Promise<boolean> {
  switch (provider) {
    case 'codex':
      return existsSync(join(homeDir, 'auth.json'));
    case 'gemini':
      return existsSync(join(homeDir, '.gemini', 'oauth_creds.json'));
    case 'copilot': {
      try {
        const raw = readFileSync(join(homeDir, 'config.json'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
        const parsed = JSON.parse(raw) as { loggedInUsers?: unknown[] };
        return Array.isArray(parsed.loggedInUsers) && parsed.loggedInUsers.length > 0;
      } catch {
        return false;
      }
    }
    case 'claude': {
      if (existsSync(join(homeDir, '.credentials.json'))) return true;
      if (process.platform !== 'darwin') return false;
      return new Promise((resolve) => {
        execFile(
          'security',
          ['find-generic-password', '-s', `Claude Code-credentials-${sha8(homeDir)}`],
          (err) => resolve(!err),
        );
      });
    }
    default:
      return false;
  }
}
