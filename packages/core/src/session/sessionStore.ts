import type { Target } from '../types.js';
import { targetKey } from '../types.js';
import type { BriefState } from '../context/brief.js';
import { clipToTokens, estimateTokens, tailWithinTokens } from '../context/tokens.js';

export interface ConversationTurn {
  role: 'user' | 'assistant';
  text: string;
}

/** What a live session has been told, and how much that is still worth trusting. */
interface SessionBrief {
  state: BriefState;
  /** Turns since it last heard the whole brief. */
  sinceFull: number;
  /** Context it reported last turn — a drop means the CLI compacted it. */
  contextTokens?: number;
}

/**
 * How many deltas a session may be sent before it hears everything again.
 *
 * A delta assumes the session still holds what it was told earlier, and every
 * CLI here compacts its own context when the window fills — summarizing older
 * turns, brief included, without telling anyone. Nothing we can read says when
 * that happened, so the assumption is refreshed on a fixed interval instead of
 * being trusted forever. Eight turns of savings, then one full brief.
 */
const FULL_BRIEF_EVERY = 8;

/**
 * A context this much smaller than last turn's did not shrink by itself. It is
 * the one compaction signature that shows up in numbers we are given.
 */
const COMPACTION_DROP = 0.6;

/**
 * Maps panel conversations to native CLI session ids (claude/codex resume) and
 * keeps turn history for providers without headless resume (gemini/copilot),
 * where prior turns are re-embedded into the prompt.
 */
export class SessionStore {
  private native = new Map<string, string>();
  private history = new Map<string, ConversationTurn[]>();
  private briefs = new Map<string, string>();
  private taskBriefs = new Map<string, SessionBrief>();

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

  /**
   * Which task-brief sections this session has already been told, so the next
   * turn can send only what moved. Keyed like the native session id, because
   * that is exactly what it tracks: a context that still remembers.
   *
   * Undefined means "assume it knows nothing" — a target with no session, one
   * whose context was compacted, and one that has been living on deltas long
   * enough that it may have been.
   */
  taskBriefState(conversationId: string, target: Target, cwd: string): BriefState | undefined {
    const memory = this.taskBriefs.get(this.key(conversationId, target, cwd));
    if (!memory || memory.sinceFull >= FULL_BRIEF_EVERY) return undefined;
    return memory.state;
  }

  /**
   * Committed only once a run actually produced an answer. A brief sent into an
   * attempt that hit a limit was never read, and recording it would leave the
   * next turn silent about context the model never saw.
   */
  rememberTaskBrief(
    conversationId: string,
    target: Target,
    cwd: string,
    state: BriefState,
    info: { sentFull: boolean; contextTokens?: number },
  ): void {
    const key = this.key(conversationId, target, cwd);
    const previous = this.taskBriefs.get(key);
    const compacted =
      previous?.contextTokens !== undefined &&
      info.contextTokens !== undefined &&
      info.contextTokens < previous.contextTokens * COMPACTION_DROP;
    this.taskBriefs.set(key, {
      state,
      // A compacted session may have lost this very brief along with the turns
      // around it, so the next one starts over rather than building on it.
      sinceFull: compacted ? FULL_BRIEF_EVERY : info.sentFull ? 0 : (previous?.sinceFull ?? 0) + 1,
      contextTokens: info.contextTokens ?? previous?.contextTokens,
    });
  }

  /** This session is not the one we were talking to. Everything must be said again. */
  forgetTaskBrief(conversationId: string, target: Target, cwd: string): void {
    this.taskBriefs.delete(this.key(conversationId, target, cwd));
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
    for (const map of [this.native, this.briefs, this.taskBriefs] as Array<Map<string, unknown>>) {
      for (const key of [...map.keys()]) {
        if (key.startsWith(`${conversationId}::`)) map.delete(key);
      }
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

const MAX_HANDOFF_TOKENS = 2_000;

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
  const trimmed = keepTail(text, MAX_HANDOFF_TOKENS);
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

/**
 * Keeps the last `maxTokens` worth of whole lines. Used where the *end* of a
 * text is the part that matters — an interrupted answer stops at its tail, and
 * that is exactly where the next model has to pick it up.
 */
function keepTail(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  const lines = text.split('\n');
  const kept: string[] = [];
  let spent = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    const cost = estimateTokens(line) + 1;
    if (spent + cost > maxTokens) {
      // One line can outweigh the whole budget. Losing the end of the answer to
      // a line boundary would defeat the point of keeping the tail at all.
      if (kept.length === 0) kept.unshift(tailWithinTokens(line, maxTokens));
      break;
    }
    spent += cost;
    kept.unshift(line);
  }
  return '[...earlier output truncated]\n' + kept.join('\n');
}

/** Token budget for history re-embedded into a cold target's first prompt. */
const MAX_EMBED_TOKENS = 6_000;
/** No single turn may eat more than this share of that budget. */
const MAX_TURN_TOKENS = 1_000;

/**
 * Prepends conversation history for a target that has no session yet — the
 * first turn on a provider without native resume, and every failover.
 *
 * This is the price of moving, paid in full at the far end where no cache
 * exists; `movePenalty` is what stops the router from paying it casually.
 */
export function embedHistory(turns: ConversationTurn[], prompt: string): string {
  if (turns.length === 0) return prompt;
  const parts: string[] = [];
  let budget = MAX_EMBED_TOKENS;
  for (let i = turns.length - 1; i >= 0 && budget > 0; i--) {
    const t = turns[i]!;
    const text = clipToTokens(t.text, MAX_TURN_TOKENS);
    const chunk = `${t.role === 'user' ? 'User' : 'Assistant'}: ${text}`;
    budget -= estimateTokens(chunk);
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
