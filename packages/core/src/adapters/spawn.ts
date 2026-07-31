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

/** Spawns a CLI and yields stdout/stderr line-by-line, ending with exit info. */
export async function* spawnLines(
  command: string,
  args: string[],
  opts: SpawnOptions,
): AsyncGenerator<SpawnEvent> {
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
        ? `Command not found: ${command}. Is the CLI installed and on PATH?`
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
