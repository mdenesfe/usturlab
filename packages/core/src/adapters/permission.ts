import type { PermissionMode } from '../types.js';

/**
 * Asking before acting, on every provider.
 *
 * Claude Code's defining behaviour is that it stops and asks before it runs
 * something consequential. The other CLIs can do this too — Codex sends
 * approval requests over its app-server, ACP agents send
 * `session/request_permission` — but usturlab used to answer all of them
 * blindly from the permission mode, which threw the interaction away.
 *
 * The decision the user makes is deliberately richer than yes/no: "yes, and
 * stop asking for this kind of thing" is what makes the flow bearable, and
 * "no, and here is what to do instead" is what makes it useful.
 */

export type PermissionKind = 'command' | 'edit' | 'read' | 'network' | 'other';

export interface PermissionRequest {
  /** Correlates the answer back to the waiting CLI. */
  id: string;
  kind: PermissionKind;
  /** One line: what it wants to do. */
  title: string;
  /** The command, the patch, the URL — whatever the user needs to judge it. */
  detail?: string;
  /** File the action targets, workspace-relative when known. */
  path?: string;
}

export type PermissionDecision =
  | { outcome: 'allow' }
  /** Allow this and everything like it for the rest of the session. */
  | { outcome: 'allow-always' }
  | { outcome: 'deny'; reason?: string };

/**
 * What a mode decides on its own, when the user is not being asked.
 *
 * The gap between `edits` and `full` is enforced where it actually can be —
 * the sandbox and permission flags each CLI is started with (`workspace-write`
 * vs `danger-full-access`, `acceptEdits` vs `--dangerously-skip-permissions`).
 * Second-guessing that here would only deny an agent the commands its own
 * sandbox already allows, so both modes say yes and the sandbox draws the line.
 */
export function decideByMode(mode: PermissionMode, kind: PermissionKind): PermissionDecision {
  // Plan mode may still look at things; it may not change or run them.
  if (mode === 'safe') {
    return kind === 'read'
      ? { outcome: 'allow' }
      : { outcome: 'deny', reason: 'plan mode — propose it instead of doing it' };
  }
  return { outcome: 'allow' };
}

/**
 * Remembers "allow always" answers for the life of a conversation.
 *
 * Keyed by kind *and* by the first token of the command, so allowing `git
 * status` does not silently allow `rm`. That is the whole point of the
 * distinction — a blanket allow is what the Full mode is for.
 */
export class PermissionMemory {
  private allowed = new Set<string>();

  private key(request: PermissionRequest): string {
    if (request.kind !== 'command') return request.kind;
    const first = (request.detail ?? '').trim().split(/\s+/)[0] ?? '';
    return `command:${first}`;
  }

  remember(request: PermissionRequest): void {
    this.allowed.add(this.key(request));
  }

  isAllowed(request: PermissionRequest): boolean {
    return this.allowed.has(this.key(request));
  }

  clear(): void {
    this.allowed.clear();
  }
}

/**
 * The gate every adapter routes an approval through.
 *
 * In ask mode it emits the request, waits for the host, and remembers an
 * "allow always". Outside ask mode it answers from the mode immediately, so
 * the CLI is never left waiting on a dialog that will never be shown.
 *
 * A pending request must survive the run ending — a cancelled turn or a dead
 * process would otherwise leave the CLI's stdin blocked forever, so `close()`
 * settles everything still outstanding.
 */
export class PermissionGate {
  private pending = new Map<string, (decision: PermissionDecision) => void>();
  private memory = new PermissionMemory();
  private closed = false;

  constructor(
    private opts: {
      mode: PermissionMode;
      ask: boolean;
      /** Surfaces the question; the host answers via `respond`. */
      emit: (request: PermissionRequest) => void;
      /** Announces that a question no longer needs answering. */
      resolved?: (id: string, allowed: boolean) => void;
    },
  ) {}

  async ask(request: PermissionRequest): Promise<PermissionDecision> {
    if (this.closed) return { outcome: 'deny', reason: 'the run ended' };

    const byMode = decideByMode(this.opts.mode, request.kind);
    // Reading is never worth interrupting someone for, and Full means Full.
    if (!this.opts.ask || request.kind === 'read' || this.opts.mode === 'full') return byMode;
    if (this.memory.isAllowed(request)) return { outcome: 'allow' };

    this.opts.emit(request);
    const decision = await new Promise<PermissionDecision>((resolve) => {
      this.pending.set(request.id, resolve);
    });
    if (decision.outcome === 'allow-always') this.memory.remember(request);
    this.opts.resolved?.(request.id, decision.outcome !== 'deny');
    return decision;
  }

  /** Called by the host when the user decides. */
  respond(id: string, decision: PermissionDecision): void {
    const resolve = this.pending.get(id);
    if (!resolve) return;
    this.pending.delete(id);
    resolve(decision);
  }

  /**
   * Settles anything still waiting so no CLI is left blocked. The `resolved`
   * callback is fired by `ask` alone — announcing it here too would tell the
   * UI twice about one question.
   */
  close(): void {
    this.closed = true;
    for (const resolve of this.pending.values()) {
      resolve({ outcome: 'deny', reason: 'the run ended before you answered' });
    }
    this.pending.clear();
  }
}

/** Codex approval methods → what they are actually asking for. */
export function codexApprovalKind(method: string): PermissionKind | undefined {
  if (method.includes('commandExecution') || method.includes('execCommand')) return 'command';
  if (method.includes('applyPatch') || method.includes('fileChange')) return 'edit';
  if (method.includes('permissions')) return 'other';
  return undefined;
}

/** ACP tool kinds → the same vocabulary. */
export function acpPermissionKind(toolKind: string | undefined): PermissionKind {
  switch (toolKind) {
    case 'execute':
      return 'command';
    case 'edit':
    case 'delete':
    case 'move':
      return 'edit';
    case 'read':
      return 'read';
    case 'fetch':
      return 'network';
    default:
      return 'other';
  }
}

/** Claude tool names → the same vocabulary. */
export function claudeToolKind(tool: string): PermissionKind {
  const name = tool.toLowerCase();
  if (name === 'bash' || name === 'killshell') return 'command';
  if (name === 'edit' || name === 'write' || name === 'notebookedit') return 'edit';
  if (name === 'read' || name === 'glob' || name === 'grep') return 'read';
  if (name === 'webfetch' || name === 'websearch') return 'network';
  return 'other';
}
