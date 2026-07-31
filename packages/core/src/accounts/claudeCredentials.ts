import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';

/**
 * Reads the full OAuth access token a `claude auth login` left in an isolated
 * profile (CLAUDE_CONFIG_DIR). Unlike setup-token output, this credential
 * carries the scopes the usage endpoint accepts.
 *
 * Storage: Linux/Windows use <configDir>/.credentials.json; macOS uses the
 * Keychain (community-documented service naming, probed defensively).
 */
export async function getClaudeProfileToken(configDir: string): Promise<string | undefined> {
  const credFile = join(configDir, '.credentials.json');
  if (existsSync(credFile)) {
    try {
      const token = parseToken(readFileSync(credFile, 'utf8'));
      if (token) return token;
    } catch {
      // fall through to keychain
    }
  }

  if (process.platform === 'darwin') {
    const sha8 = createHash('sha256').update(configDir).digest('hex').slice(0, 8);
    const candidates = [
      `Claude Code-credentials-${sha8}`,
      `Claude Code-credentials (${configDir})`,
    ];
    // The unsuffixed service belongs to the default ~/.claude login; never
    // serve it for other profiles or accounts would bleed into each other.
    if (configDir === join(homedir(), '.claude')) {
      candidates.push('Claude Code-credentials');
    }
    for (const service of candidates) {
      const raw = await readKeychain(service);
      if (!raw) continue;
      const token = parseToken(raw);
      if (token) return token;
    }
  }
  return undefined;
}

function parseToken(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const oauth = (parsed.claudeAiOauth ?? parsed) as Record<string, unknown>;
    const token = oauth.accessToken;
    return typeof token === 'string' && token.length > 10 ? token : undefined;
  } catch {
    return undefined;
  }
}

function readKeychain(service: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('security', ['find-generic-password', '-s', service, '-w'], (err, stdout) => {
      resolve(err ? undefined : stdout.trim() || undefined);
    });
  });
}
