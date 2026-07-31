import * as vscode from 'vscode';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { EMPTY_RULES, RULES_TEMPLATE, parseRulesFile, type RulesFile } from '@usturlab/core';

export interface RulesState {
  rules: RulesFile;
  path: string;
  exists: boolean;
  error?: string;
}

export class RulesManager implements vscode.Disposable {
  private current: RulesFile = EMPTY_RULES;
  private lastError: string | undefined;
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private diagnostics = vscode.languages.createDiagnosticCollection('usturlab');
  private watcher: vscode.FileSystemWatcher;

  constructor() {
    this.watcher = vscode.workspace.createFileSystemWatcher('**/.usturlab/rules.json');
    this.watcher.onDidChange(() => this.load());
    this.watcher.onDidCreate(() => this.load());
    this.watcher.onDidDelete(() => this.load());
    this.load();
  }

  /** Workspace rules file wins; falls back to ~/.usturlab, then legacy .usrouter paths. */
  locate(): { path: string; exists: boolean } {
    const ws = vscode.workspace.workspaceFolders?.[0];
    const candidates: string[] = [];
    if (ws) {
      candidates.push(join(ws.uri.fsPath, '.usturlab', 'rules.json'));
      candidates.push(join(homedir(), '.usturlab', 'rules.json'));
      candidates.push(join(ws.uri.fsPath, '.usrouter', 'rules.json'));
      candidates.push(join(homedir(), '.usrouter', 'rules.json'));
    } else {
      candidates.push(join(homedir(), '.usturlab', 'rules.json'));
      candidates.push(join(homedir(), '.usrouter', 'rules.json'));
    }
    for (const path of candidates) {
      if (existsSync(path)) return { path, exists: true };
    }
    return { path: candidates[0]!, exists: false };
  }

  getRules(): RulesFile {
    return this.current;
  }

  getState(): RulesState {
    const { path, exists } = this.locate();
    return { rules: this.current, path, exists, error: this.lastError };
  }

  load(): void {
    const { path, exists } = this.locate();
    this.diagnostics.clear();
    this.lastError = undefined;
    if (!exists) {
      this.current = EMPTY_RULES;
      this.emitter.fire();
      return;
    }
    let content: string;
    try {
      content = readFileSync(path, 'utf8');
    } catch (e) {
      this.current = EMPTY_RULES;
      this.lastError = (e as Error).message;
      this.emitter.fire();
      return;
    }
    const parsed = parseRulesFile(content);
    if (parsed.ok) {
      this.current = parsed.rules;
    } else {
      this.lastError = parsed.error;
      // Invalid file: keep routing on the built-in default and surface the error.
      this.current = EMPTY_RULES;
      const uri = vscode.Uri.file(path);
      this.diagnostics.set(uri, [
        new vscode.Diagnostic(
          new vscode.Range(0, 0, 0, 1),
          `usturlab rules invalid (falling back to priority order): ${parsed.error}`,
          vscode.DiagnosticSeverity.Warning,
        ),
      ]);
    }
    this.emitter.fire();
  }

  async openOrCreate(): Promise<void> {
    const { path, exists } = this.locate();
    const uri = vscode.Uri.file(path);
    if (!exists) {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(RULES_TEMPLATE, 'utf8'));
    }
    await vscode.window.showTextDocument(uri);
  }

  dispose(): void {
    this.watcher.dispose();
    this.diagnostics.dispose();
    this.emitter.dispose();
  }
}
