export type ProviderId = 'claude' | 'codex' | 'gemini' | 'copilot';

/**
 * managed-home: CLI owns its auth inside an isolated profile dir
 *   (CLAUDE_CONFIG_DIR / CODEX_HOME / COPILOT_HOME / HOME override for gemini).
 * oauth-token: long-lived token stored in the host secret store
 *   (claude setup-token -> CLAUDE_CODE_OAUTH_TOKEN).
 * api-key: raw API key stored in the host secret store, fed to the CLI via env.
 */
export type AuthMode = 'managed-home' | 'oauth-token' | 'api-key';

export type PermissionMode = 'safe' | 'edits' | 'full';

export interface AccountProfile {
  id: string;
  provider: ProviderId;
  label: string;
  authMode: AuthMode;
  homeDir?: string;
  hasSecret: boolean;
  priority: number;
  disabled?: boolean;
}

export type ResolvedAccount = AccountProfile & { secret?: string };

export interface Target {
  provider: ProviderId;
  account: string;
  model?: string;
}

export interface TaskRequest {
  conversationId: string;
  prompt: string;
  cwd: string;
  activeFile?: string;
  languageId?: string;
  tags?: string[];
  permissionMode: PermissionMode;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
}

export type LimitScope = 'session' | 'daily' | 'weekly' | 'credits' | 'unknown';

export interface LimitInfo {
  resetAt?: number;
  scope?: LimitScope;
  raw: string;
}

export type AdapterEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'text-delta'; text: string }
  | { type: 'tool-use'; name: string; detail?: string }
  | { type: 'model-downgraded'; from: string; to: string }
  | { type: 'result'; text: string; usage?: Usage; costUsd?: number }
  | ({ type: 'limit' } & LimitInfo)
  | { type: 'error'; message: string; retryable: boolean };

export interface RoutingDecision {
  chain: Target[];
  ruleId?: string;
  reason: string;
  skipped: Array<{ target: Target; reason: string }>;
}

export type RunEvent =
  | { type: 'routing'; decision: RoutingDecision }
  | { type: 'attempt'; target: Target; attempt: number }
  | { type: 'failover'; from: Target; to: Target; reason: string; resetAt?: number }
  | { type: 'chain-exhausted'; tried: Target[] }
  | AdapterEvent;

export function targetKey(t: Target): string {
  return `${t.provider}:${t.account}`;
}

export function formatTarget(t: Target): string {
  return t.model ? `${t.provider}:${t.account}/${t.model}` : `${t.provider}:${t.account}`;
}
