/**
 * The model's own task list, normalized.
 *
 * All four CLIs keep one, and all four describe it differently: Claude writes
 * it with a `TodoWrite` tool call, Codex sends `turn/plan/updated`, and the
 * ACP agents send a `plan` session update. The panel should not care which.
 */

export type TaskStatus = 'pending' | 'active' | 'done';

export interface TaskItem {
  text: string;
  status: TaskStatus;
}

/** Whatever a provider calls each state, it means one of three things. */
function normalizeStatus(raw: unknown): TaskStatus {
  const value = String(raw ?? '').toLowerCase().replace(/[_\s]/g, '');
  if (value === 'completed' || value === 'done' || value === 'complete') return 'done';
  if (value === 'inprogress' || value === 'active' || value === 'running' || value === 'current') {
    return 'active';
  }
  return 'pending';
}

function toItems(
  raw: unknown,
  text: (entry: Record<string, unknown>) => unknown,
  status: (entry: Record<string, unknown>) => unknown,
): TaskItem[] {
  if (!Array.isArray(raw)) return [];
  const items: TaskItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const label = text(record);
    if (typeof label !== 'string' || !label.trim()) continue;
    items.push({ text: label.trim(), status: normalizeStatus(status(record)) });
  }
  return items;
}

/** Claude: the `todos` array of a TodoWrite tool call. */
export function tasksFromTodoWrite(input: unknown): TaskItem[] {
  const record = (input ?? {}) as Record<string, unknown>;
  return toItems(
    record.todos,
    (e) => e.content ?? e.text,
    (e) => e.status,
  );
}

/** Codex: `turn/plan/updated` → `plan: [{ step, status }]`. */
export function tasksFromCodexPlan(params: unknown): TaskItem[] {
  const record = (params ?? {}) as Record<string, unknown>;
  return toItems(
    record.plan,
    (e) => e.step ?? e.content,
    (e) => e.status,
  );
}

/** ACP: a `plan` session update → `entries: [{ content, status }]`. */
export function tasksFromAcpPlan(update: unknown): TaskItem[] {
  const record = (update ?? {}) as Record<string, unknown>;
  return toItems(
    record.entries,
    (e) => e.content ?? e.title,
    (e) => e.status,
  );
}

export interface TaskProgress {
  done: number;
  total: number;
  /** The step being worked on, when the model says which. */
  current?: string;
}

export function taskProgress(items: TaskItem[]): TaskProgress {
  return {
    done: items.filter((i) => i.status === 'done').length,
    total: items.length,
    current: items.find((i) => i.status === 'active')?.text,
  };
}

/** True when the two lists say the same thing — used to skip redundant updates. */
export function sameTasks(a: TaskItem[], b: TaskItem[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, i) => item.text === b[i]!.text && item.status === b[i]!.status);
}
