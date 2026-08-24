import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
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

/** Content hashes of workspace command files the user has enabled. */
const APPROVED_COMMANDS_KEY = 'usturlab.approvedWorkspaceCommands';

/** The slice of `vscode.Memento` this needs; keeps the class testable. */
export interface ApprovalStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

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
  private watchers: vscode.FileSystemWatcher[] = [];
  /** Set while a workspace command file is waiting to be enabled. */
  private pendingCommands: { path: string; hash: string; count: number } | undefined;
  /** Approvals given with no store behind them: this window only. */
  private sessionApproved = new Set<string>();
  private prompted = new Set<string>();

  constructor(private readonly approvals?: ApprovalStore) {
    // Every location `locate()` is willing to read from has to be watched, or
    // "edits to the JSON apply live" is only true for the workspace copy: the
    // home-directory fallbacks sit outside the workspace and need a watcher of
    // their own, and the legacy .usrouter paths are still read.
    const patterns: Array<string | vscode.RelativePattern> = [
      '**/.usturlab/{rules,commands}.json',
      '**/.usrouter/{rules,commands}.json',
      new vscode.RelativePattern(
        vscode.Uri.file(join(homedir(), '.usturlab')),
        '{rules,commands}.json',
      ),
      new vscode.RelativePattern(
        vscode.Uri.file(join(homedir(), '.usrouter')),
        '{rules,commands}.json',
      ),
    ];
    for (const pattern of patterns) {
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      watcher.onDidChange(() => this.load());
      watcher.onDidCreate(() => this.load());
      watcher.onDidDelete(() => this.load());
      this.watchers.push(watcher);
    }
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

  /**
   * Every command file that exists, in preference order, each tagged with
   * whether it came out of the open workspace. A workspace copy only appears
   * when the workspace is trusted; the home-directory copies are always the
   * user's own.
   */
  private commandCandidates(): Array<{ path: string; fromWorkspace: boolean }> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    const trusted = vscode.workspace.isTrusted !== false;
    const inWorkspace = ws && trusted ? ws.uri.fsPath : undefined;
    const candidates: Array<{ path: string; fromWorkspace: boolean }> = [];
    for (const dir of ['.usturlab', '.usrouter']) {
      if (inWorkspace)
        candidates.push({ path: join(inWorkspace, dir, 'commands.json'), fromWorkspace: true });
      candidates.push({ path: join(homedir(), dir, 'commands.json'), fromWorkspace: false });
    }
    return candidates.filter((c) => existsSync(c.path));
  }

  private locateCommands(): { path: string; fromWorkspace: boolean } | undefined {
    return this.commandCandidates()[0];
  }

  /**
   * Commands from the home directory are the user's own and load silently. A
   * file inside the workspace is text someone else may have written, and a
   * command's template *becomes the prompt* a provider runs — so it stays
   * inert until the user enables it. The approval is keyed by content, so
   * editing an enabled file asks again instead of inheriting the old yes.
   */
  private loadCommands(): void {
    this.customCommands = [];
    this.pendingCommands = undefined;
    for (const found of this.commandCandidates()) {
      let content: string;
      try {
        content = readFileSync(found.path, 'utf8');
      } catch {
        continue;
      }
      const parsed = parseCommandsFile(content);
      if (!parsed.ok || parsed.commands.length === 0) continue;
      if (!found.fromWorkspace) {
        this.customCommands = parsed.commands;
        return;
      }
      const hash = createHash('sha256').update(content).digest('hex');
      if (this.approvedHashes().includes(hash)) {
        this.customCommands = parsed.commands;
        return;
      }
      // Not enabled: ask about it, but keep looking — a file the workspace
      // put there must not take the user's own commands away with it.
      if (!this.pendingCommands) {
        this.pendingCommands = { path: found.path, hash, count: parsed.commands.length };
        this.promptForWorkspaceCommands(this.pendingCommands);
      }
    }
  }

  private approvedHashes(): string[] {
    const stored = this.approvals?.get<string[]>(APPROVED_COMMANDS_KEY) ?? [];
    return [...stored, ...this.sessionApproved];
  }

  /** Asked once per file content — a watcher re-firing must not nag. */
  private promptForWorkspaceCommands(pending: { path: string; hash: string; count: number }): void {
    if (this.prompted.has(pending.hash)) return;
    this.prompted.add(pending.hash);
    const review = 'Review';
    const enable = 'Enable';
    void Promise.resolve(
      vscode.window.showWarningMessage(
        `This workspace defines ${pending.count} custom slash command${
          pending.count === 1 ? '' : 's'
        }. Their text is sent to a provider as your prompt — review ${pending.path} before enabling.`,
        review,
        enable,
      ),
    ).then(async (pick) => {
      if (pick === review) {
        await vscode.window.showTextDocument(vscode.Uri.file(pending.path));
      } else if (pick === enable) {
        await this.approveWorkspaceCommands();
      }
    });
  }

  /** True while the workspace offers commands the user has not enabled. */
  hasPendingWorkspaceCommands(): boolean {
    return this.pendingCommands !== undefined;
  }

  /** Enables the workspace command file, for exactly the content on disk now. */
  async approveWorkspaceCommands(): Promise<void> {
    const pending = this.pendingCommands;
    if (!pending) return;
    if (this.approvals) {
      const kept = this.approvedHashes().filter((h) => h !== pending.hash);
      await this.approvals.update(APPROVED_COMMANDS_KEY, [...kept, pending.hash].slice(-20));
    } else {
      this.sessionApproved.add(pending.hash);
    }
    this.load();
  }

  async openOrCreateCommands(): Promise<void> {
    const existing = this.locateCommands()?.path;
    const ws = vscode.workspace.workspaceFolders?.[0];
    const path =
      existing ??
      (ws ? join(ws.uri.fsPath, '.usturlab', 'commands.json') : join(homedir(), '.usturlab', 'commands.json'));
    const uri = vscode.Uri.file(path);
    if (!existing) {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(dirname(path)));
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
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(dirname(path)));
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

  /**
   * True when a rules file exists on disk that we could not parse. Everything
   * that writes has to check this: a file that failed to parse was replaced in
   * memory by EMPTY_RULES, so writing that back would delete every rule still
   * in it over a fixable syntax error.
   */
  isUnparsed(): boolean {
    return this.lastError !== undefined && this.locate().exists;
  }

  private async write(rules: RulesFile): Promise<void> {
    const { path, exists } = this.locate();
    if (this.isUnparsed()) {
      const open = 'Open rules.json';
      const pick = await vscode.window.showErrorMessage(
        `usturlab did not save: ${path} does not parse, and writing over it would discard the rules still in it. Fix the JSON first.`,
        open,
      );
      if (pick === open) await this.openOrCreate();
      return;
    }
    const uri = vscode.Uri.file(path);
    if (!exists) await vscode.workspace.fs.createDirectory(vscode.Uri.file(dirname(path)));
    const content = JSON.stringify(rules, null, 2);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
  }

  dispose(): void {
    for (const watcher of this.watchers) watcher.dispose();
    this.diagnostics.dispose();
    this.emitter.dispose();
  }
}
