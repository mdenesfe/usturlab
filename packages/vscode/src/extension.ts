import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join as joinPath } from 'node:path';
import {
  AdapterRegistry,
  ClaudeAdapter,
  CodexAdapter,
  CopilotAdapter,
  GeminiAdapter,
  Orchestrator,
  QuotaTracker,
  SessionStore,
  CLAUDE_USAGE_MIN_INTERVAL_MS,
} from '@usturlab/core';
import { refreshUsage } from './usage.js';
import { migrateFromUsrouter } from './migration.js';
import { AccountStore } from './storage/accountStore.js';
import { globalStateQuotaPersistence } from './storage/quotaPersistence.js';
import { RulesManager } from './rules/rulesFile.js';
import { ChatViewProvider } from './panel/chatViewProvider.js';
import { RouterStatusBar } from './views/statusBar.js';
import { registerCommands } from './commands.js';

export function activate(ctx: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('usturlab');
  ctx.subscriptions.push(output);

  // VS Code launched from the Dock inherits a minimal PATH; make sure the
  // usual CLI homes are reachable so `claude`/`codex`/... resolve.
  const extraDirs = [
    joinPath(homedir(), '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  const pathEntries = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const dir of extraDirs) {
    if (existsSync(dir) && !pathEntries.includes(dir)) pathEntries.push(dir);
  }
  process.env.PATH = pathEntries.join(delimiter);

  const config = vscode.workspace.getConfiguration('usturlab');
  const cliPath = (provider: string, fallback: string) =>
    config.get<string>(`cliPath.${provider}`, fallback);

  const adapters = new AdapterRegistry();
  adapters.register(new ClaudeAdapter(cliPath('claude', 'claude')));
  adapters.register(new CodexAdapter(cliPath('codex', 'codex')));
  adapters.register(new GeminiAdapter(cliPath('gemini', 'gemini')));
  adapters.register(new CopilotAdapter(cliPath('copilot', 'copilot')));

  const accounts = new AccountStore(ctx);
  void migrateFromUsrouter(accounts, (line) => output.appendLine(line));
  const quota = new QuotaTracker(globalStateQuotaPersistence(ctx));
  const sessions = new SessionStore();
  const rules = new RulesManager();
  ctx.subscriptions.push(rules);

  const orchestrator = new Orchestrator({
    adapters,
    quota,
    sessions,
    getRules: () => rules.getRules(),
    getCustomCommands: () => rules.getCustomCommands(),
    getAccounts: () => accounts.all(),
    resolveAccount: (target) => accounts.resolve(target),
  });

  const statusBar = new RouterStatusBar();
  ctx.subscriptions.push(statusBar);

  const chat = new ChatViewProvider(ctx, orchestrator, sessions, accounts, quota, adapters, rules, output);
  chat.setTargetListener((target) => statusBar.routed(target));
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chat, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  registerCommands(ctx, { accounts, adapters, quota, rules, chat, statusBar });

  const usageRefresher = () => refreshUsage(accounts, quota, (line) => output.appendLine(line));
  chat.setUsageRefresher(usageRefresher);
  startUsagePolling(ctx, usageRefresher, output);

  output.appendLine('[usturlab] activated');
}

/** Opt-in continuous polling (usturlab.pollUsage); on-demand refresh always works. */
function startUsagePolling(
  ctx: vscode.ExtensionContext,
  tick: () => Promise<void>,
  output: vscode.OutputChannel,
): void {
  let timer: NodeJS.Timeout | undefined;

  const apply = () => {
    const enabled = vscode.workspace.getConfiguration('usturlab').get<boolean>('pollUsage', false);
    if (enabled && !timer) {
      output.appendLine('[usturlab] usage polling enabled');
      void tick();
      timer = setInterval(() => void tick(), CLAUDE_USAGE_MIN_INTERVAL_MS);
    } else if (!enabled && timer) {
      clearInterval(timer);
      timer = undefined;
      output.appendLine('[usturlab] usage polling disabled');
    }
  };

  apply();
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('usturlab.pollUsage')) apply();
    }),
    { dispose: () => timer && clearInterval(timer) },
  );
}

export function deactivate(): void {}
