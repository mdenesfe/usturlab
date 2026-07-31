import type { AdapterEvent, PermissionMode, ProviderId, ResolvedAccount } from '../types.js';

export interface RunRequest {
  /** For providers without native resume the orchestrator pre-embeds history here. */
  prompt: string;
  cwd: string;
  model?: string;
  resumeSessionId?: string;
  permissionMode: PermissionMode;
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
