import type { ToolAction } from './adapters/toolDetail.js';

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
  /** Per-message override of the routing mode. */
  routingMode?: 'auto' | 'manual';
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
  | {
      type: 'tool-use';
      name: string;
      /** One line, always visible: the file, command or query. */
      detail?: string;
      /** Body revealed when the step is expanded (a diff, file content, a command). */
      preview?: string;
      /** File the tool touched, workspace-relative when known. */
      path?: string;
      action?: ToolAction;
    }
  | { type: 'model-downgraded'; from: string; to: string }
  | { type: 'result'; text: string; usage?: Usage; costUsd?: number }
  | ({ type: 'limit' } & LimitInfo)
  | { type: 'error'; message: string; retryable: boolean };

export interface RoutingDecision {
  chain: Target[];
  ruleId?: string;
  reason: string;
  skipped: Array<{ target: Target; reason: string }>;
  /** Present when the router classified the task itself (auto mode). */
  classification?: {
    kind: string;
    complexity: string;
    signals: string[];
  };
  /** The conversation moved to a heavier model because the work got harder. */
  escalated?: { from: string; to: string };
  /** Router asks for this turn to be planned before it edits. */
  suggestPermission?: PermissionMode;
  /** Expected share of the chosen account's window, in percentage points. */
  estimatedBurnPct?: number;
}

export type RunEvent =
  /** Standing instructions this run carried, so outcomes can be attributed to them. */
  | { type: 'brief'; target: Target; lineIds: string[] }
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
