import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

export type SpawnEvent =
  | { kind: 'line'; stream: 'stdout' | 'stderr'; line: string }
  | { kind: 'exit'; code: number | null; signal: NodeJS.Signals | null }
  | { kind: 'spawn-error'; message: string };

export interface SpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  /** Open a writable stdin (for CLIs that accept streamed input). */
  stdinPipe?: boolean;
  /** Called once with the child so callers can grab stdin. */
  onChild?: (child: ChildProcess) => void;
}

/**
 * A CLI path that points at a JavaScript file is run through this Node,
 * rather than executed. Only a shebang line and an exec bit make such a file
 * runnable on its own, and Windows has neither — so without this, pointing
 * `usturlab.cliPath.*` at a `.mjs` entry point works everywhere except there.
 */
function nodeScript(command: string, args: string[]): [string, string[]] {
  return /\.[cm]?js$/i.test(command) ? [process.execPath, [command, ...args]] : [command, args];
}

/** Spawns a CLI and yields stdout/stderr line-by-line, ending with exit info. */
export async function* spawnLines(
  rawCommand: string,
  rawArgs: string[],
  opts: SpawnOptions,
): AsyncGenerator<SpawnEvent> {
  const [command, args] = nodeScript(rawCommand, rawArgs);
  const child = spawn(command, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: [opts.stdinPipe ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  opts.onChild?.(child);

  const queue: SpawnEvent[] = [];
  let done = false;
  let notify: (() => void) | undefined;
  const push = (e: SpawnEvent) => {
    queue.push(e);
    notify?.();
  };

  const onAbort = () => {
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
    }, 3000).unref();
  };
  if (opts.signal.aborted) onAbort();
  else opts.signal.addEventListener('abort', onAbort, { once: true });

  if (child.stdout) {
    createInterface({ input: child.stdout }).on('line', (line) =>
      push({ kind: 'line', stream: 'stdout', line }),
    );
  }
  if (child.stderr) {
    createInterface({ input: child.stderr }).on('line', (line) =>
      push({ kind: 'line', stream: 'stderr', line }),
    );
  }

  child.on('error', (err: NodeJS.ErrnoException) => {
    const message =
      err.code === 'ENOENT'
        ? // The CLI the caller asked for, not the interpreter we may have
          // put in front of it: naming node here would send them hunting.
          `Command not found: ${rawCommand}. Is the CLI installed and on PATH?`
        : err.message;
    push({ kind: 'spawn-error', message });
    done = true;
    notify?.();
  });

  child.on('close', (code, signal) => {
    push({ kind: 'exit', code, signal });
    done = true;
    notify?.();
  });

  try {
    while (true) {
      const next = queue.shift();
      if (next) {
        yield next;
        if (next.kind === 'exit' || next.kind === 'spawn-error') return;
        continue;
      }
      if (done) return;
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
      notify = undefined;
    }
  } finally {
    opts.signal.removeEventListener('abort', onAbort);
    if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
  }
}
