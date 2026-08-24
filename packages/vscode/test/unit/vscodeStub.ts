import { vi } from 'vitest';

/**
 * Just enough of the `vscode` module for the parts of the extension that are
 * plain logic wrapped in API calls. Everything a test needs to assert on is a
 * spy, and `resetVscodeStub()` puts them all back between tests.
 *
 * `vscode` is supplied by the host at runtime and is not installable, so
 * `vitest.config.ts` aliases the import here.
 */

export class Uri {
  private constructor(readonly fsPath: string) {}
  static file(fsPath: string): Uri {
    return new Uri(fsPath);
  }
  toString(): string {
    return `file://${this.fsPath}`;
  }
}

export class RelativePattern {
  constructor(
    readonly base: Uri | string,
    readonly pattern: string,
  ) {}
}

export class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];
  readonly event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => {} };
  };
  fire(e: T): void {
    for (const listener of this.listeners) listener(e);
  }
  dispose(): void {
    this.listeners = [];
  }
}

export class Range {
  constructor(
    readonly startLine: number,
    readonly startChar: number,
    readonly endLine: number,
    readonly endChar: number,
  ) {}
}

export class Diagnostic {
  constructor(
    readonly range: Range,
    readonly message: string,
    readonly severity?: number,
  ) {}
}

export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };
export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };

export const fsSpies = {
  createDirectory: vi.fn(async (_uri: Uri) => {}),
  writeFile: vi.fn(async (_uri: Uri, _content: Uint8Array) => {}),
};

export const workspace = {
  workspaceFolders: undefined as Array<{ uri: Uri }> | undefined,
  isTrusted: true,
  fs: fsSpies,
  createFileSystemWatcher: vi.fn((_pattern: string | RelativePattern) => ({
    onDidChange: vi.fn(),
    onDidCreate: vi.fn(),
    onDidDelete: vi.fn(),
    dispose: vi.fn(),
  })),
  getConfiguration: vi.fn(() => ({ get: vi.fn(), update: vi.fn(async () => {}) })),
};

export const window = {
  /** Resolves to `undefined` — no button pressed — unless a test says otherwise. */
  showErrorMessage: vi.fn(async (_message: string, ..._items: string[]) => undefined as
    | string
    | undefined),
  showInformationMessage: vi.fn(async () => undefined),
  showWarningMessage: vi.fn(async (_message: string, ..._items: string[]) => undefined as
    | string
    | undefined),
  showTextDocument: vi.fn(async (_uri: Uri) => ({})),
};

export const languages = {
  createDiagnosticCollection: vi.fn((_name: string) => ({
    clear: vi.fn(),
    set: vi.fn(),
    dispose: vi.fn(),
  })),
};

export function resetVscodeStub(): void {
  vi.clearAllMocks();
  workspace.workspaceFolders = undefined;
  workspace.isTrusted = true;
  window.showErrorMessage.mockResolvedValue(undefined);
}
