import type { Target } from '@usturlab/core';
import type { HostToWebview } from './protocol.js';

/**
 * Pure transcript logic shared by the webview (live rendering) and the host
 * (stored-log compaction) — and unit-tested without VS Code.
 */

export type TranscriptItem =
  | { kind: 'user'; text: string }
  | {
      kind: 'assistant';
      messageId: string;
      text: string;
      tools: string[];
      done: boolean;
      target?: Target;
      ruleId?: string;
      reason?: string;
      costUsd?: number;
      durationMs?: number;
    }
  | { kind: 'failover'; text: string }
  | { kind: 'notice'; text: string }
  | { kind: 'error'; text: string };

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
      next.push({ kind: 'assistant', messageId: id, text: '', tools: [], done: false });
      i = next.length - 1;
    }
    return i;
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
      next[i] = { ...item, text: item.text + msg.text };
      break;
    }
    case 'toolUse': {
      const i = ensureAssistant(msg.messageId);
      const item = next[i] as Extract<TranscriptItem, { kind: 'assistant' }>;
      next[i] = {
        ...item,
        tools: [...item.tools, msg.detail ? `${msg.name}: ${msg.detail}` : msg.name],
      };
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
      const reset = msg.resetAt ? ` · resets ${new Date(msg.resetAt).toLocaleTimeString()}` : '';
      next.push({
        kind: 'failover',
        text: `${msg.reason}${reset} → ${msg.to.provider}:${msg.to.account}`,
      });
      next.push({
        kind: 'assistant',
        messageId: msg.messageId,
        text: '',
        tools: [],
        done: false,
        target: msg.to,
      });
      break;
    }
    case 'done': {
      const i = lastAssistant(msg.messageId);
      if (i !== -1) {
        const item = next[i] as Extract<TranscriptItem, { kind: 'assistant' }>;
        next[i] = { ...item, done: true, costUsd: msg.costUsd, durationMs: msg.durationMs };
      }
      break;
    }
    case 'error': {
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
