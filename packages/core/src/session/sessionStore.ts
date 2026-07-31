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

  private key(conversationId: string, target: Target, cwd: string): string {
    return `${conversationId}::${targetKey(target)}::${cwd}`;
  }

  getNativeSession(conversationId: string, target: Target, cwd: string): string | undefined {
    return this.native.get(this.key(conversationId, target, cwd));
  }

  setNativeSession(conversationId: string, target: Target, cwd: string, sessionId: string): void {
    this.native.set(this.key(conversationId, target, cwd), sessionId);
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
  }

  /** Native CLI session ids survive host restarts via these two. */
  serializeNative(): Record<string, string> {
    return Object.fromEntries(this.native);
  }

  restoreNative(data: Record<string, string>): void {
    for (const [key, value] of Object.entries(data)) this.native.set(key, value);
  }
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
