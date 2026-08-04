import type {
  AgentProgress,
  AgentStatus,
  PermissionRequest,
  TaskItem,
  Target,
  ToolAction,
} from '@usturlab/core';
import type { HostToWebview } from './protocol.js';

/**
 * Pure transcript logic shared by the webview (live rendering) and the host
 * (stored-log compaction) — and unit-tested without VS Code.
 *
 * Assistant content is an ordered timeline: text segments interleaved with
 * grouped tool activity, exactly in the order they happened.
 */

export interface ToolStep {
  name: string;
  /** One line, always visible: the file, command or query. */
  detail?: string;
  /** Body revealed when the step is expanded (a diff, file content, a command). */
  preview?: string;
  /** File the step touched, workspace-relative when known. */
  path?: string;
  action?: ToolAction;
}

/**
 * One subagent. Agents spawned while another is still running belong to the
 * same segment — that adjacency is what the panel draws as a parallel fan-out.
 */
export interface AgentLane {
  id: string;
  label: string;
  agentKind?: string;
  prompt?: string;
  background?: boolean;
  status: AgentStatus;
  /** What it is doing right now, while it runs. */
  activity?: string;
  lastTool?: string;
  toolUses?: number;
  tokens?: number;
  durationMs?: number;
  /** What it reported back when it finished. */
  summary?: string;
  /** Its own tool activity, kept out of the main thread's timeline. */
  steps: ToolStep[];
}

export type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'tools'; steps: ToolStep[] }
  | { kind: 'agents'; lanes: AgentLane[] };

export type TranscriptItem =
  | { kind: 'user'; text: string }
  | {
      kind: 'assistant';
      messageId: string;
      segments: Segment[];
      done: boolean;
      /** Ended without an answer: cancelled, restarted or shut down mid-run. */
      stopped?: boolean;
      stoppedReason?: string;
      target?: Target;
      ruleId?: string;
      reason?: string;
      costUsd?: number;
      durationMs?: number;
    }
  | { kind: 'review'; by: string; text: string }
  /** The model's own checklist; replaced in place as it progresses. */
  | { kind: 'tasks'; items: TaskItem[] }
  /** A question the model is blocked on until the user answers. */
  | { kind: 'permission'; request: PermissionRequest; target?: Target; answered?: boolean; allowed?: boolean }
  | { kind: 'failover'; text: string }
  | { kind: 'notice'; text: string }
  | { kind: 'error'; text: string };

/** Later numbers win; a field the provider left out keeps what we already had. */
function mergeProgress(lane: AgentLane, progress: AgentProgress): AgentLane {
  return {
    ...lane,
    activity: progress.activity ?? lane.activity,
    lastTool: progress.lastTool ?? lane.lastTool,
    toolUses: progress.toolUses ?? lane.toolUses,
    tokens: progress.tokens ?? lane.tokens,
    durationMs: progress.durationMs ?? lane.durationMs,
  };
}

export function assistantText(item: Extract<TranscriptItem, { kind: 'assistant' }>): string {
  return item.segments
    .filter((s): s is Extract<Segment, { kind: 'text' }> => s.kind === 'text')
    .map((s) => s.text)
    .join('');
}

export function applyHostMessage(items: TranscriptItem[], msg: HostToWebview): TranscriptItem[] {
  const next = [...items];
  const lastAssistant = (id: string) => {
    for (let i = next.length - 1; i >= 0; i--) {
      const item = next[i];
      if (item?.kind === 'assistant' && item.messageId === id) return i;
    }
    return -1;
  };
  const ensureAssistant = (id: string) => {
    let i = lastAssistant(id);
    if (i === -1) {
      next.push({ kind: 'assistant', messageId: id, segments: [], done: false });
      i = next.length - 1;
    }
    return i;
  };
  /**
   * Rewrites one lane wherever it lives; false when no such agent is known.
   * Agent ids are globally unique, so the search deliberately ignores which
   * message it was told: an agent launched asynchronously often reports back
   * turns later, by which time the id has moved on.
   */
  const updateLane = (agentId: string, patch: (lane: AgentLane) => AgentLane): boolean => {
    for (let i = next.length - 1; i >= 0; i--) {
      const item = next[i];
      if (item?.kind !== 'assistant') continue;
      for (let s = item.segments.length - 1; s >= 0; s--) {
        const segment = item.segments[s];
        if (segment?.kind !== 'agents') continue;
        const at = segment.lanes.findIndex((lane) => lane.id === agentId);
        if (at === -1) continue;
        const lanes = [...segment.lanes];
        lanes[at] = patch(lanes[at]!);
        const segments = [...item.segments];
        segments[s] = { kind: 'agents', lanes };
        next[i] = { ...item, segments };
        return true;
      }
    }
    return false;
  };

  switch (msg.kind) {
    case 'userEcho': {
      next.push({ kind: 'user', text: msg.text });
      break;
    }
    case 'routing': {
      const i = ensureAssistant(msg.messageId);
      next[i] = {
        ...(next[i] as Extract<TranscriptItem, { kind: 'assistant' }>),
        target: msg.target,
        ruleId: msg.ruleId,
        reason: msg.reason,
      };
      break;
    }
    case 'delta': {
      const i = ensureAssistant(msg.messageId);
      const item = next[i] as Extract<TranscriptItem, { kind: 'assistant' }>;
      const segments = [...item.segments];
      const last = segments[segments.length - 1];
      if (last?.kind === 'text') {
        segments[segments.length - 1] = { kind: 'text', text: last.text + msg.text };
      } else {
        segments.push({ kind: 'text', text: msg.text });
      }
      next[i] = { ...item, segments };
      break;
    }
    case 'toolUse': {
      const i = ensureAssistant(msg.messageId);
      const step: ToolStep = {
        name: msg.name,
        detail: msg.detail,
        preview: msg.preview,
        path: msg.path,
        action: msg.action,
      };
      // A subagent's work goes to its own lane; an unknown agent id falls back
      // to the main timeline rather than vanishing.
      if (
        msg.agentId &&
        updateLane(msg.agentId, (lane) => ({ ...lane, steps: [...lane.steps, step] }))
      ) {
        break;
      }
      const item = next[i] as Extract<TranscriptItem, { kind: 'assistant' }>;
      const segments = [...item.segments];
      const last = segments[segments.length - 1];
      if (last?.kind === 'tools') {
        segments[segments.length - 1] = { kind: 'tools', steps: [...last.steps, step] };
      } else {
        segments.push({ kind: 'tools', steps: [step] });
      }
      next[i] = { ...item, segments };
      break;
    }
    case 'agentStart': {
      const i = ensureAssistant(msg.messageId);
      const item = next[i] as Extract<TranscriptItem, { kind: 'assistant' }>;
      const segments = [...item.segments];
      const last = segments[segments.length - 1];
      const lane: AgentLane = {
        id: msg.id,
        label: msg.label,
        agentKind: msg.agentKind,
        prompt: msg.prompt,
        background: msg.background,
        status: 'running',
        steps: [],
      };
      // Agents whose lifetimes overlap share one segment — that adjacency is
      // exactly what "these ran in parallel" means, and all the panel needs.
      if (last?.kind === 'agents' && last.lanes.some((l) => l.status === 'running')) {
        segments[segments.length - 1] = { kind: 'agents', lanes: [...last.lanes, lane] };
      } else {
        segments.push({ kind: 'agents', lanes: [lane] });
      }
      next[i] = { ...item, segments };
      break;
    }
    case 'agentProgress': {
      updateLane(msg.id, (lane) => mergeProgress(lane, msg));
      break;
    }
    case 'agentEnd': {
      updateLane(msg.id, (lane) => ({
        ...mergeProgress(lane, msg),
        status: msg.status,
        summary: msg.summary ?? lane.summary,
        activity: undefined,
      }));
      break;
    }
    case 'tasks': {
      // One live checklist per conversation: update in place, never stack.
      const at = next.findIndex((i) => i.kind === 'tasks');
      if (at >= 0) next[at] = { kind: 'tasks', items: msg.items };
      else next.push({ kind: 'tasks', items: msg.items });
      break;
    }
    case 'permission': {
      next.push({ kind: 'permission', request: msg.request, target: msg.target });
      break;
    }
    case 'permissionResolved': {
      const at = next.findIndex((i) => i.kind === 'permission' && i.request.id === msg.id);
      if (at >= 0) {
        next[at] = { ...(next[at] as Extract<TranscriptItem, { kind: 'permission' }>), answered: true, allowed: msg.allowed };
      }
      break;
    }
    case 'review': {
      next.push({ kind: 'review', by: msg.by, text: msg.text });
      break;
    }
    case 'downgraded': {
      next.push({ kind: 'notice', text: `model downgraded upstream: ${msg.from} → ${msg.to}` });
      break;
    }
    case 'notice': {
      next.push({ kind: 'notice', text: msg.text });
      break;
    }
    case 'failover': {
      // That attempt is over — the banner below says why. Leaving it "live"
      // would put a blinking cursor on an answer nobody is writing any more.
      const abandoned = lastAssistant(msg.messageId);
      if (abandoned !== -1) {
        const item = next[abandoned] as Extract<TranscriptItem, { kind: 'assistant' }>;
        if (!item.done) next[abandoned] = { ...item, done: true };
      }
      const reset = msg.resetAt ? ` · resets ${new Date(msg.resetAt).toLocaleTimeString()}` : '';
      next.push({
        kind: 'failover',
        text: `${msg.reason}${reset} → ${msg.to.provider}:${msg.to.account}`,
      });
      next.push({
        kind: 'assistant',
        messageId: msg.messageId,
        segments: [],
        done: false,
        target: msg.to,
      });
      break;
    }
    case 'done': {
      const i = lastAssistant(msg.messageId);
      if (i !== -1) {
        const item = next[i] as Extract<TranscriptItem, { kind: 'assistant' }>;
        // Lanes are deliberately left alone: an agent launched asynchronously
        // outlives the turn that spawned it, and Claude keeps answering while
        // it works. A lane's status stays the last thing we were actually told;
        // whether it is still going is a question about the run, not the turn.
        next[i] = { ...item, done: true, costUsd: msg.costUsd, durationMs: msg.durationMs };
      }
      break;
    }
    case 'stopped': {
      // Without this the bubble keeps a blinking cursor for good — in the
      // stored log too, so reopening the conversation replays the same lie.
      const i = lastAssistant(msg.messageId);
      if (i === -1) {
        next.push({ kind: 'notice', text: msg.reason ?? 'stopped' });
        break;
      }
      const item = next[i] as Extract<TranscriptItem, { kind: 'assistant' }>;
      next[i] = { ...item, done: true, stopped: true, stoppedReason: msg.reason };
      break;
    }
    case 'error': {
      // The turn is over too. The error row explains why, so the bubble just
      // stops — otherwise it sits there thinking for the rest of its life.
      const i = lastAssistant(msg.messageId);
      if (i !== -1) {
        const item = next[i] as Extract<TranscriptItem, { kind: 'assistant' }>;
        if (!item.done) next[i] = { ...item, done: true };
      }
      next.push({ kind: 'error', text: msg.message });
      break;
    }
    default:
      break;
  }
  return next;
}

export function reduceTranscript(log: HostToWebview[]): TranscriptItem[] {
  let items: TranscriptItem[] = [];
  for (const msg of log) items = applyHostMessage(items, msg);
  return items;
}

/**
 * Merges consecutive delta events (same messageId) so stored logs stay small.
 * Invariant: reduceTranscript(compactLog(log)) === reduceTranscript(log).
 */
export function compactLog(log: HostToWebview[]): HostToWebview[] {
  const out: HostToWebview[] = [];
  for (const msg of log) {
    const last = out[out.length - 1];
    if (msg.kind === 'delta' && last?.kind === 'delta' && last.messageId === msg.messageId) {
      last.text += msg.text;
      continue;
    }
    out.push({ ...msg });
  }
  return out;
}
