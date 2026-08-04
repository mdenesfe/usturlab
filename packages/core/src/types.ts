import type { ToolAction } from './adapters/toolDetail.js';
import type { TaskItem } from './adapters/taskList.js';
import type { PermissionRequest } from './adapters/permission.js';

export type ProviderId = 'claude' | 'codex' | 'gemini' | 'copilot' | 'openrouter';

/**
 * Providers that may check work but never produce it.
 *
 * OpenRouter reaches open-weight models over plain HTTP: no tools, no sandbox,
 * no session. That is enough to read a diff and argue with it, and nowhere near
 * enough to write code — an account here would answer an edit request with
 * confident prose and touch nothing. Keeping them out of the authoring chain is
 * exactly what makes a free account safe to connect.
 */
export const REVIEW_ONLY_PROVIDERS: ReadonlySet<ProviderId> = new Set<ProviderId>(['openrouter']);

/** True when this provider can only be a reviewer, never the author. */
export function isReviewOnly(provider: ProviderId): boolean {
  return REVIEW_ONLY_PROVIDERS.has(provider);
}

/**
 * managed-home: CLI owns its auth inside an isolated profile dir
 *   (CLAUDE_CONFIG_DIR / CODEX_HOME / COPILOT_HOME / HOME override for gemini).
 * oauth-token: long-lived token stored in the host secret store
 *   (claude setup-token -> CLAUDE_CODE_OAUTH_TOKEN).
 * api-key: raw API key stored in the host secret store, fed to the CLI via env.
 */
export type AuthMode = 'managed-home' | 'oauth-token' | 'api-key';

export type PermissionMode = 'safe' | 'edits' | 'full';

/**
 * Model weight class. Lives here rather than in the router because it is also
 * how a finished run is recorded — capability is measured per tier, so that a
 * bad run on the cheap model is not held against the expensive one.
 */
export type Tier = 'light' | 'standard' | 'heavy';

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

/** How a subagent ended, or that it has not. */
export type AgentStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/** Everything a provider can tell us about a subagent while it works. */
export interface AgentProgress {
  /** What it is doing right now, in the provider's words. */
  activity?: string;
  lastTool?: string;
  toolUses?: number;
  tokens?: number;
  durationMs?: number;
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
      /** Set when a subagent did this, not the main thread. */
      agentId?: string;
    }
  /**
   * A subagent was spawned. Several can be in flight at once — the panel shows
   * them as concurrent lanes, so `id` has to be stable for the agent's whole
   * life (it is the tool call that spawned it).
   */
  | {
      type: 'agent-start';
      id: string;
      /** What it was asked to do, in the model's own words. */
      label: string;
      /** The provider's name for the kind of agent ("Explore", "general-purpose"). */
      agentKind?: string;
      /** The full instruction it was given. */
      prompt?: string;
      /** The parent did not block on it. */
      background?: boolean;
    }
  | ({ type: 'agent-progress'; id: string } & AgentProgress)
  | ({
      type: 'agent-end';
      id: string;
      status: Exclude<AgentStatus, 'running'>;
      /** What it reported back to the parent. */
      summary?: string;
    } & AgentProgress)
  | { type: 'model-downgraded'; from: string; to: string }
  /** The model's own task list, however that provider expresses it. */
  | { type: 'tasks'; items: TaskItem[] }
  /** The model is waiting on the user before it acts. */
  | { type: 'permission'; request: PermissionRequest }
  /** That wait is over — the CLI moved on (answered, cancelled or timed out). */
  | { type: 'permission-resolved'; id: string; allowed: boolean }
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
  /**
   * Weight class the router sized this turn at. Absent when the target came
   * from a mention, a rule or the manual chain — nobody sized anything then.
   */
  tier?: Tier;
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
