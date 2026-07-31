import * as vscode from 'vscode';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  COMMANDS_TEMPLATE,
  EMPTY_RULES,
  RULES_TEMPLATE,
  parseCommandsFile,
  parseRulesFile,
  type Rule,
  type RulesFile,
  type RuleTarget,
  type SlashCommand,
} from '@usturlab/core';

export interface RulesState {
  rules: RulesFile;
  path: string;
  exists: boolean;
  error?: string;
}

export class RulesManager implements vscode.Disposable {
  private current: RulesFile = EMPTY_RULES;
  private customCommands: SlashCommand[] = [];
  private lastError: string | undefined;
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private diagnostics = vscode.languages.createDiagnosticCollection('usturlab');
  private watcher: vscode.FileSystemWatcher;

  constructor() {
    this.watcher = vscode.workspace.createFileSystemWatcher('**/.usturlab/{rules,commands}.json');
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

  getCustomCommands(): SlashCommand[] {
    return this.customCommands;
  }

  private locateCommands(): string | undefined {
    const ws = vscode.workspace.workspaceFolders?.[0];
    const candidates: string[] = [];
    if (ws) candidates.push(join(ws.uri.fsPath, '.usturlab', 'commands.json'));
    candidates.push(join(homedir(), '.usturlab', 'commands.json'));
    if (ws) candidates.push(join(ws.uri.fsPath, '.usrouter', 'commands.json'));
    candidates.push(join(homedir(), '.usrouter', 'commands.json'));
    return candidates.find((c) => existsSync(c));
  }

  private loadCommands(): void {
    this.customCommands = [];
    const path = this.locateCommands();
    if (!path) return;
    try {
      const parsed = parseCommandsFile(readFileSync(path, 'utf8'));
      if (parsed.ok) this.customCommands = parsed.commands;
    } catch {
      // ignore, keep empty
    }
  }

  async openOrCreateCommands(): Promise<void> {
    const existing = this.locateCommands();
    const ws = vscode.workspace.workspaceFolders?.[0];
    const path =
      existing ??
      (ws ? join(ws.uri.fsPath, '.usturlab', 'commands.json') : join(homedir(), '.usturlab', 'commands.json'));
    const uri = vscode.Uri.file(path);
    if (!existing) {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(COMMANDS_TEMPLATE, 'utf8'));
    }
    await vscode.window.showTextDocument(uri);
  }

  getState(): RulesState {
    const { path, exists } = this.locate();
    return { rules: this.current, path, exists, error: this.lastError };
  }

  load(): void {
    this.loadCommands();
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

  async saveRule(rule: Rule, index?: number): Promise<void> {
    const current = this.current;
    const rules = [...current.rules];
    if (index !== undefined && index >= 0 && index < rules.length) {
      rules[index] = rule;
    } else {
      rules.push(rule);
    }
    await this.write({ ...current, rules });
  }

  async deleteRule(ruleId: string): Promise<void> {
    const current = this.current;
    await this.write({
      ...current,
      rules: current.rules.filter((r) => r.id !== ruleId),
    });
  }

  async reorderRules(order: string[]): Promise<void> {
    const current = this.current;
    const ruleMap = new Map(current.rules.map((r) => [r.id, r]));
    const reordered: Rule[] = [];
    for (const id of order) {
      const rule = ruleMap.get(id);
      if (rule) reordered.push(rule);
    }
    for (const rule of current.rules) {
      if (!order.includes(rule.id)) reordered.push(rule);
    }
    await this.write({ ...current, rules: reordered });
  }

  async saveDefaultChain(chain: RuleTarget[]): Promise<void> {
    await this.write({ ...this.current, defaultChain: chain });
  }

  private async write(rules: RulesFile): Promise<void> {
    const { path, exists } = this.locate();
    const uri = vscode.Uri.file(path);
    if (!exists) {
      const dir = path.substring(0, path.lastIndexOf('/'));
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir));
    }
    const content = JSON.stringify(rules, null, 2);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
  }

  dispose(): void {
    this.watcher.dispose();
    this.diagnostics.dispose();
    this.emitter.dispose();
  }
}
