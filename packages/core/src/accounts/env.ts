import type { ProviderId, ResolvedAccount } from '../types.js';

/**
 * Env vars that can hijack auth for each provider and must never leak from the
 * parent process into a routed subprocess (e.g. a stray ANTHROPIC_API_KEY
 * silently overrides subscription auth in `claude -p`).
 */
const SCRUB: Record<ProviderId, string[]> = {
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR'],
  codex: ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_HOME'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_GENAI_USE_VERTEXAI'],
  copilot: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'COPILOT_HOME'],
};

/**
 * Env overrides for a VS Code terminal (TerminalOptions.env): scrubbed vars
 * map to null (removed from the shell), auth vars to their values.
 */
export function terminalEnvOverrides(account: ResolvedAccount): Record<string, string | null> {
  const overrides: Record<string, string | null> = {};
  for (const key of SCRUB[account.provider]) overrides[key] = null;
  const additions = buildChildEnv(account, {});
  for (const [key, value] of Object.entries(additions)) {
    if (value !== undefined) overrides[key] = value;
  }
  return overrides;
}

export function buildChildEnv(
  account: ResolvedAccount,
  base: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of SCRUB[account.provider]) delete env[key];

  switch (account.provider) {
    case 'claude':
      if (account.authMode === 'oauth-token' && account.secret) {
        env.CLAUDE_CODE_OAUTH_TOKEN = account.secret;
      } else if (account.authMode === 'managed-home' && account.homeDir) {
        env.CLAUDE_CONFIG_DIR = account.homeDir;
      } else if (account.authMode === 'api-key' && account.secret) {
        env.ANTHROPIC_API_KEY = account.secret;
      }
      break;
    case 'codex':
      if (account.authMode === 'managed-home' && account.homeDir) {
        env.CODEX_HOME = account.homeDir;
      } else if (account.authMode === 'api-key' && account.secret) {
        env.CODEX_API_KEY = account.secret;
      }
      break;
    case 'gemini':
      if (account.authMode === 'managed-home' && account.homeDir) {
        // No official config-dir env; gemini resolves os.homedir().
        env.HOME = account.homeDir;
        env.USERPROFILE = account.homeDir;
      } else if (account.authMode === 'api-key' && account.secret) {
        env.GEMINI_API_KEY = account.secret;
      }
      break;
    case 'copilot':
      if (account.homeDir) env.COPILOT_HOME = account.homeDir;
      if (account.authMode === 'api-key' && account.secret) {
        env.COPILOT_GITHUB_TOKEN = account.secret;
      }
      break;
  }
  return env;
}
