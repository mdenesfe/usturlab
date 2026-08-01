import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

/**
 * Minimal line-delimited JSON-RPC 2.0 client over a child process's stdio —
 * the transport CLIs expose for editor integration (codex app-server, and
 * the same shape used by other agent protocols).
 */

export interface RpcNotification {
  method: string;
  params: Record<string, unknown>;
}

export interface RpcServerRequest {
  id: string | number;
  method: string;
  params: Record<string, unknown>;
}

export interface JsonRpcOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  onNotification: (n: RpcNotification) => void;
  /**
   * Server→client requests (approvals, elicitations). Return the result
   * payload, or a promise for it — an approval that has to reach the user and
   * come back takes as long as the user takes.
   */
  onServerRequest?: (r: RpcServerRequest) => unknown | Promise<unknown>;
  onStderr?: (line: string) => void;
  onExit?: (code: number | null) => void;
  onSpawnError?: (message: string) => void;
}

export class JsonRpcProcess {
  private child?: ChildProcess;
  private nextId = 0;
  private pending = new Map<
    number,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();
  private closed = false;

  constructor(
    private command: string,
    private args: string[],
    private opts: JsonRpcOptions,
  ) {}

  start(): void {
    const child = spawn(this.command, this.args, {
      cwd: this.opts.cwd,
      env: this.opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    const onAbort = () => this.dispose();
    if (this.opts.signal.aborted) onAbort();
    else this.opts.signal.addEventListener('abort', onAbort, { once: true });

    if (child.stdout) {
      createInterface({ input: child.stdout }).on('line', (line) => this.handleLine(line));
    }
    if (child.stderr) {
      createInterface({ input: child.stderr }).on('line', (line) => this.opts.onStderr?.(line));
    }

    child.on('error', (err: NodeJS.ErrnoException) => {
      const message =
        err.code === 'ENOENT'
          ? `Command not found: ${this.command}. Is the CLI installed and on PATH?`
          : err.message;
      this.failAll(new Error(message));
      this.opts.onSpawnError?.(message);
    });

    child.on('close', (code) => {
      this.closed = true;
      this.failAll(new Error(`process exited with code ${code}`));
      this.opts.onExit?.(code);
    });
  }

  private handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    // Response to one of our requests.
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const entry = this.pending.get(msg.id as number);
      if (!entry) return;
      this.pending.delete(msg.id as number);
      if (msg.error) {
        const err = msg.error as { message?: string };
        entry.reject(new Error(err.message ?? 'JSON-RPC error'));
      } else {
        entry.resolve((msg.result ?? {}) as Record<string, unknown>);
      }
      return;
    }

    // Server → client request (approvals). Answer so the CLI is never stuck —
    // even when the answer has to go to the user and come back first.
    if (msg.id !== undefined && typeof msg.method === 'string') {
      const id = msg.id;
      void Promise.resolve(
        this.opts.onServerRequest?.({
          id: id as string | number,
          method: msg.method,
          params: (msg.params ?? {}) as Record<string, unknown>,
        }),
      )
        .then((result) => this.write({ jsonrpc: '2.0', id, result: result ?? {} }))
        .catch(() => this.write({ jsonrpc: '2.0', id, result: {} }));
      return;
    }

    if (typeof msg.method === 'string') {
      this.opts.onNotification({
        method: msg.method,
        params: (msg.params ?? {}) as Record<string, unknown>,
      });
    }
  }

  private write(payload: unknown): boolean {
    const stdin = this.child?.stdin;
    if (!stdin || this.closed || !stdin.writable) return false;
    stdin.write(JSON.stringify(payload) + '\n');
    return true;
  }

  request(method: string, params: unknown, timeoutMs = 120_000): Promise<Record<string, unknown>> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      if (!this.write({ jsonrpc: '2.0', id, method, params })) {
        reject(new Error('process is not writable'));
        return;
      }
      this.pending.set(id, { resolve, reject });
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
  }

  notify(method: string, params: unknown): boolean {
    return this.write({ jsonrpc: '2.0', method, params });
  }

  private failAll(error: Error): void {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }

  dispose(): void {
    if (!this.child || this.closed) return;
    this.closed = true;
    const child = this.child;
    try {
      child.stdin?.end();
    } catch {
      // ignore
    }
    child.kill('SIGTERM');
    const timer = setTimeout(() => {
      if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
    }, 3000);
    if (typeof timer.unref === 'function') timer.unref();
  }
}

/** Async queue that turns callback-driven events into an async iterator. */
export class EventQueue<T> {
  private items: T[] = [];
  private resolvers: Array<(value: IteratorResult<T>) => void> = [];
  private ended = false;

  push(item: T): void {
    const resolver = this.resolvers.shift();
    if (resolver) resolver({ value: item, done: false });
    else this.items.push(item);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const resolve of this.resolvers.splice(0)) {
      resolve({ value: undefined as never, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      const item = this.items.shift();
      if (item !== undefined) {
        yield item;
        continue;
      }
      if (this.ended) return;
      const next = await new Promise<IteratorResult<T>>((resolve) => this.resolvers.push(resolve));
      if (next.done) return;
      yield next.value;
    }
  }
}
