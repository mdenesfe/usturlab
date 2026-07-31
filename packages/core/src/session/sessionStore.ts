import type { Target } from '../types.js';
import { targetKey } from '../types.js';

export interface ConversationTurn {
  role: 'user' | 'assistant';
  text: string;
}

/**
 * Maps panel conversations to native CLI session ids (claude/codex resume) and
 * keeps turn history for providers without headless resume (gemini/copilot),
 * where prior turns are re-embedded into the prompt.
 */
export class SessionStore {
  private native = new Map<string, string>();
  private history = new Map<string, ConversationTurn[]>();
  private briefs = new Map<string, string>();

  private key(conversationId: string, target: Target, cwd: string): string {
    return `${conversationId}::${targetKey(target)}::${cwd}`;
  }

  getNativeSession(conversationId: string, target: Target, cwd: string): string | undefined {
    return this.native.get(this.key(conversationId, target, cwd));
  }

  setNativeSession(conversationId: string, target: Target, cwd: string, sessionId: string): void {
    this.native.set(this.key(conversationId, target, cwd), sessionId);
  }

  /**
   * The brief a session was last told. Transports without a system-prompt slot
   * only need to restate it when it actually changed.
   */
  briefChanged(conversationId: string, target: Target, cwd: string, brief: string): boolean {
    const key = this.key(conversationId, target, cwd);
    return this.briefs.get(key) !== brief;
  }

  rememberBrief(conversationId: string, target: Target, cwd: string, brief: string): void {
    this.briefs.set(this.key(conversationId, target, cwd), brief);
  }

  appendTurn(conversationId: string, turn: ConversationTurn): void {
    const turns = this.history.get(conversationId) ?? [];
    turns.push(turn);
    this.history.set(conversationId, turns);
  }

  getHistory(conversationId: string): ConversationTurn[] {
    return this.history.get(conversationId) ?? [];
  }

  clearConversation(conversationId: string): void {
    this.history.delete(conversationId);
    for (const key of [...this.native.keys()]) {
      if (key.startsWith(`${conversationId}::`)) this.native.delete(key);
    }
    for (const key of [...this.briefs.keys()]) {
      if (key.startsWith(`${conversationId}::`)) this.briefs.delete(key);
    }
  }

  /** Native CLI session ids survive host restarts via these two. */
  serializeNative(): Record<string, string> {
    return Object.fromEntries(this.native);
  }

  restoreNative(data: Record<string, string>): void {
    for (const [key, value] of Object.entries(data)) this.native.set(key, value);
  }
}

const MAX_HANDOFF_CHARS = 8_000;

/**
 * Hands an interrupted answer to whoever picks the task up next.
 *
 * Without this the replacement model starts blind at exactly the moment
 * continuity matters most — it asks "where were we?" while the user is
 * watching half an answer sitting above it.
 */
export function handoffPrompt(prompt: string, partial: string, from: string): string {
  const text = partial.trim();
  if (!text) return prompt;
  // The tail is what matters: it is where the work stopped.
  const trimmed =
    text.length > MAX_HANDOFF_CHARS
      ? '[...earlier output truncated]\n' + text.slice(-MAX_HANDOFF_CHARS)
      : text;
  return (
    `${from} was working on the request below and got cut off mid-answer. ` +
    `This is everything it had produced:\n---\n${trimmed}\n---\n\n` +
    `Pick up from there: keep what is already correct, do not repeat finished work, ` +
    `and re-check anything the interrupted run may have left half-done. ` +
    `Do not ask where to resume — the text above is the state.\n\n` +
    `Original request:\n${prompt}`
  );
}

/** Same account, resumed session: it already has the partial answer in context. */
export function resumeInterruptedPrompt(prompt: string): string {
  return (
    'Your previous response to this request was cut off by a connection error. ' +
    'Continue from where you stopped instead of starting over.\n\n' +
    `Original request:\n${prompt}`
  );
}

const MAX_EMBED_CHARS = 24_000;

/** Prepends compacted conversation history for providers without native resume. */
export function embedHistory(turns: ConversationTurn[], prompt: string): string {
  if (turns.length === 0) return prompt;
  const parts: string[] = [];
  let budget = MAX_EMBED_CHARS;
  for (let i = turns.length - 1; i >= 0 && budget > 0; i--) {
    const t = turns[i]!;
    const text = t.text.length > 4000 ? t.text.slice(0, 4000) + '\n[...truncated]' : t.text;
    const chunk = `${t.role === 'user' ? 'User' : 'Assistant'}: ${text}`;
    budget -= chunk.length;
    if (budget < 0) break;
    parts.unshift(chunk);
  }
  return (
    'Earlier conversation (for context, do not repeat):\n---\n' +
    parts.join('\n\n') +
    '\n---\n\nCurrent request:\n' +
    prompt
  );
}
