/**
 * Turns a tool call's raw input into something a human can read at a glance.
 *
 * Every provider names its tools differently but they all do the same handful
 * of things — read a file, edit one, run a command, search. The transcript
 * should say *which* file and *what* changed, collapsed to one line and
 * expandable to the actual content.
 */

export type ToolAction = 'read' | 'write' | 'edit' | 'search' | 'run' | 'fetch' | 'task' | 'other';

export interface ToolDetail {
  /** One line, always visible: the file, command or query. */
  detail?: string;
  /** Body shown when the step is expanded. */
  preview?: string;
  /** File the tool touched, relative to the workspace when possible. */
  path?: string;
  action: ToolAction;
}

const MAX_PREVIEW_LINES = 14;
const MAX_PREVIEW_CHARS = 1200;

function str(input: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function num(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  return typeof value === 'number' ? value : undefined;
}

/** Absolute paths are noise; show what the user actually recognizes. */
export function shortenPath(path: string, cwd?: string): string {
  let out = path;
  if (cwd && out.startsWith(cwd)) out = out.slice(cwd.length).replace(/^[/\\]/, '');
  const home = typeof process !== 'undefined' ? process.env.HOME : undefined;
  if (home && out.startsWith(home)) out = '~' + out.slice(home.length);
  return out;
}

function clip(text: string, lines = MAX_PREVIEW_LINES, chars = MAX_PREVIEW_CHARS): string {
  const byLine = text.split('\n');
  let out = byLine.slice(0, lines).join('\n');
  if (out.length > chars) out = out.slice(0, chars) + ' …';
  if (byLine.length > lines) out += `\n… +${byLine.length - lines} more lines`;
  return out;
}

/** Compact before/after for an edit, so the expanded step shows the change itself. */
function diffPreview(oldText: string, newText: string): string {
  const before = clip(oldText, 8, 500)
    .split('\n')
    .map((l) => `- ${l}`)
    .join('\n');
  const after = clip(newText, 8, 500)
    .split('\n')
    .map((l) => `+ ${l}`)
    .join('\n');
  return `${before}\n${after}`;
}

function lineRange(input: Record<string, unknown>): string {
  const offset = num(input, 'offset');
  const limit = num(input, 'limit');
  if (offset === undefined) return '';
  return limit === undefined ? `:${offset}` : `:${offset}-${offset + limit - 1}`;
}

/**
 * `name` is the provider's tool name; `input` its raw arguments. Unknown tools
 * still get a usable line rather than disappearing.
 */
export function describeToolUse(name: string, rawInput: unknown, cwd?: string): ToolDetail {
  const input = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Record<string, unknown>;
  const tool = name.toLowerCase();

  const filePath = str(input, 'file_path', 'filePath', 'path', 'notebook_path', 'notebookPath');
  const short = filePath ? shortenPath(filePath, cwd) : undefined;

  if (tool === 'read' || tool === 'readfile' || tool === 'view') {
    return { action: 'read', path: short, detail: short ? short + lineRange(input) : undefined };
  }

  if (tool === 'edit' || tool === 'multiedit' || tool === 'str_replace' || tool === 'applypatch') {
    const oldText = str(input, 'old_string', 'oldText', 'old_str');
    const newText = str(input, 'new_string', 'newText', 'new_str');
    const all = input.replace_all === true ? ' (all occurrences)' : '';
    return {
      action: 'edit',
      path: short,
      detail: short ? short + all : undefined,
      preview: oldText !== undefined && newText !== undefined ? diffPreview(oldText, newText) : undefined,
    };
  }

  if (tool === 'write' || tool === 'writefile' || tool === 'create') {
    const content = str(input, 'content', 'text') ?? '';
    const lines = content ? content.split('\n').length : 0;
    return {
      action: 'write',
      path: short,
      detail: short ? (lines ? `${short} · ${lines} lines` : short) : undefined,
      preview: content ? clip(content) : undefined,
    };
  }

  if (tool === 'notebookedit') {
    return { action: 'edit', path: short, detail: short, preview: str(input, 'new_source') };
  }

  if (tool === 'delete' || tool === 'remove') {
    return { action: 'edit', path: short, detail: short ? `deleted ${short}` : undefined };
  }

  if (tool === 'move' || tool === 'rename') {
    const to = str(input, 'newPath', 'new_path', 'destination');
    return {
      action: 'edit',
      path: short,
      detail: short && to ? `${short} → ${shortenPath(to, cwd)}` : short,
    };
  }

  if (
    tool === 'bash' ||
    tool === 'shell' ||
    tool === 'run' ||
    tool === 'exec' ||
    tool === 'execute' ||
    tool === 'commandexecution' ||
    tool === 'terminal'
  ) {
    const command = str(input, 'command', 'cmd', 'script') ?? '';
    const first = command.split('\n')[0] ?? '';
    return {
      action: 'run',
      detail: str(input, 'description') ? `${first}` : first,
      preview: command.includes('\n') ? clip(command) : undefined,
    };
  }

  if (tool === 'glob' || tool === 'find') {
    const pattern = str(input, 'pattern', 'glob') ?? '';
    const where = str(input, 'path');
    return {
      action: 'search',
      detail: where ? `${pattern} in ${shortenPath(where, cwd)}` : pattern,
    };
  }

  if (tool === 'grep' || tool === 'search' || tool === 'ripgrep' || tool === 'searchtext') {
    const pattern = str(input, 'pattern', 'query', 'regex') ?? '';
    const where = str(input, 'path', 'glob');
    return {
      action: 'search',
      detail: where ? `"${pattern}" in ${shortenPath(where, cwd)}` : `"${pattern}"`,
    };
  }

  if (tool === 'webfetch' || tool === 'fetch') {
    return { action: 'fetch', detail: str(input, 'url'), preview: str(input, 'prompt') };
  }

  if (tool === 'websearch') {
    return { action: 'fetch', detail: str(input, 'query') };
  }

  if (tool === 'task' || tool === 'agent') {
    const description = str(input, 'description', 'subagent_type');
    return { action: 'task', detail: description, preview: str(input, 'prompt') };
  }

  if (tool === 'todowrite') {
    const todos = Array.isArray(input.todos) ? input.todos : [];
    const lines = todos
      .map((t) => {
        const todo = t as Record<string, unknown>;
        const mark = todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '▸' : '·';
        return `${mark} ${String(todo.content ?? '')}`;
      })
      .join('\n');
    return {
      action: 'other',
      detail: `${todos.length} item${todos.length === 1 ? '' : 's'}`,
      preview: lines || undefined,
    };
  }

  // Codex reports a file edit as a list of changed paths rather than a diff.
  if (tool === 'filechange' || tool === 'patch') {
    const changes = Array.isArray(input.changes) ? input.changes : [];
    const paths = changes
      .map((c) => {
        const change = c as Record<string, unknown>;
        return typeof change.path === 'string' ? shortenPath(change.path, cwd) : undefined;
      })
      .filter((p): p is string => !!p);
    if (paths.length > 0) {
      return {
        action: 'edit',
        path: paths[0],
        detail: paths.length === 1 ? paths[0] : `${paths[0]} +${paths.length - 1} more`,
        preview: paths.length > 1 ? paths.join('\n') : undefined,
      };
    }
    return { action: 'edit', path: short, detail: short };
  }

  // Unknown or MCP tool: surface whichever argument reads like the subject.
  const fallback = str(input, 'command', 'query', 'url', 'pattern', 'prompt', 'name', 'id');
  if (fallback) return { action: 'other', detail: clip(fallback, 1, 160) };
  if (short) return { action: 'other', path: short, detail: short };

  const keys = Object.keys(input);
  if (keys.length === 0) return { action: 'other' };
  let json: string;
  try {
    json = JSON.stringify(input);
  } catch {
    return { action: 'other' };
  }
  return { action: 'other', detail: clip(json, 1, 160) };
}
