import type { AdapterEvent, Effort, PermissionMode, ProviderId, ResolvedAccount } from '../types.js';
import type { PermissionDecision } from './permission.js';

/**
 * Live handle for a run in flight. Adapters that can accept mid-run user
 * input (Claude's stream-json stdin) set `inject`; it returns true when the
 * message reached the running model. Callers fall back to queueing otherwise.
 */
export interface LiveRunHandle {
  inject?: (text: string) => boolean;
  /**
   * Answers a pending permission request. Set by adapters whose CLI can ask;
   * the host calls it when the user decides.
   */
  respondPermission?: (id: string, decision: PermissionDecision) => void;
  /**
   * How an injected message shows up:
   * - 'turn'   → the agent answers it as a separate turn (its own reply block)
   * - 'inline' → the agent folds it into the running turn (same reply block)
   */
  injectMode?: 'turn' | 'inline';
}

export interface RunRequest {
  /** For providers without native resume the orchestrator pre-embeds history here. */
  prompt: string;
  /**
   * What to send instead when `resumeSessionId` turns out to be unusable and
   * the CLI silently starts a fresh one.
   *
   * `prompt` is written for a session that remembers the earlier turns: it
   * carries only the context that changed since the last message. A session
   * that was quietly replaced remembers none of it, and would be answering with
   * a brief it never read. Adapters that can tell the difference — the ones
   * that fall back rather than failing — send this instead.
   */
  coldPrompt?: string;
  cwd: string;
  model?: string;
  resumeSessionId?: string;
  permissionMode: PermissionMode;
  /**
   * How much reasoning this turn is worth, sized by the router. Each adapter
   * spends it through whatever its CLI actually exposes; one with no such
   * control ignores it rather than faking one.
   */
  effort?: Effort;
  /**
   * Standing instructions for this provider. Delivered through whatever the
   * CLI actually offers — a system-prompt flag where one exists, otherwise
   * prepended to the session's first prompt.
   */
  systemBrief?: string;
  /**
   * Ask the user before consequential actions instead of deciding from the
   * permission mode alone. The mode still bounds what can be asked for.
   */
  askPermission?: boolean;
  /**
   * Extra CLI args and env the host needs to inject — Claude's permission
   * prompt runs through an MCP server the host owns, so only the host knows
   * how to reach it.
   */
  hostArgs?: { args: string[]; env: Record<string, string> };
  /**
   * Set when a resumed session must hear the brief again because it changed
   * (only matters for transports without a system-prompt slot).
   */
  restateBrief?: boolean;
  /** Populated by adapters that support mid-run injection. */
  handle?: LiveRunHandle;
}

/**
 * How the host detects that login completed, without user interaction:
 * - file: the auth artifact appears on disk (codex auth.json, gemini oauth_creds.json)
 * - output-token: a secret matching `pattern` shows up in the terminal output
 *   (claude setup-token) — captured automatically and stored as the secret
 * - poll: a check command flips to success (claude auth status)
 * - manual-confirm: no reliable signal; fall back to a confirmation button + verify()
 */
export type LoginWatch =
  | { kind: 'file'; path: string }
  | { kind: 'output-token'; pattern: string }
  | { kind: 'poll'; check: () => Promise<boolean>; intervalMs?: number }
  | { kind: 'manual-confirm' };

export interface LoginFlow {
  /** Command to run in a user-visible terminal with `env` applied. */
  terminalCommand: string[];
  env: Record<string, string>;
  /** How the host auto-detects a completed login. */
  watch: LoginWatch;
  /** Used by the manual-confirm fallback. */
  verify: () => Promise<boolean>;
  /** 'oauth-token': manual fallback when output capture is unavailable. */
  postLoginSecretPrompt?: 'oauth-token';
  instructions: string;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly models: Array<{ id: string; label: string }>;
  readonly supportsNativeResume: boolean;

  buildEnv(account: ResolvedAccount, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  run(req: RunRequest, account: ResolvedAccount, signal: AbortSignal): AsyncIterable<AdapterEvent>;
  interactiveCommand(
    account: ResolvedAccount,
    model?: string,
  ): { command: string[]; env: NodeJS.ProcessEnv };
  loginFlow(profileDir: string): LoginFlow;
}

export class AdapterRegistry {
  private adapters = new Map<ProviderId, ProviderAdapter>();

  register(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: ProviderId): ProviderAdapter | undefined {
    return this.adapters.get(id);
  }

  all(): ProviderAdapter[] {
    return [...this.adapters.values()];
  }
}
