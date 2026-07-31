import * as vscode from 'vscode';
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
} from '@usrouter/core';
import { refreshUsage } from './usage.js';
import { AccountStore } from './storage/accountStore.js';
import { globalStateQuotaPersistence } from './storage/quotaPersistence.js';
import { RulesManager } from './rules/rulesFile.js';
import { ChatViewProvider } from './panel/chatViewProvider.js';
import { RouterStatusBar } from './views/statusBar.js';
import { registerCommands } from './commands.js';

export function activate(ctx: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('usrouter');
  ctx.subscriptions.push(output);

  const config = vscode.workspace.getConfiguration('usrouter');
  const cliPath = (provider: string, fallback: string) =>
    config.get<string>(`cliPath.${provider}`, fallback);

  const adapters = new AdapterRegistry();
  adapters.register(new ClaudeAdapter(cliPath('claude', 'claude')));
  adapters.register(new CodexAdapter(cliPath('codex', 'codex')));
  adapters.register(new GeminiAdapter(cliPath('gemini', 'gemini')));
  adapters.register(new CopilotAdapter(cliPath('copilot', 'copilot')));

  const accounts = new AccountStore(ctx);
  const quota = new QuotaTracker(globalStateQuotaPersistence(ctx));
  const sessions = new SessionStore();
  const rules = new RulesManager();
  ctx.subscriptions.push(rules);

  const orchestrator = new Orchestrator({
    adapters,
    quota,
    sessions,
    getRules: () => rules.getRules(),
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

  output.appendLine('[usrouter] activated');
}

/** Opt-in continuous polling (usrouter.pollUsage); on-demand refresh always works. */
function startUsagePolling(
  ctx: vscode.ExtensionContext,
  tick: () => Promise<void>,
  output: vscode.OutputChannel,
): void {
  let timer: NodeJS.Timeout | undefined;

  const apply = () => {
    const enabled = vscode.workspace.getConfiguration('usrouter').get<boolean>('pollUsage', false);
    if (enabled && !timer) {
      output.appendLine('[usrouter] usage polling enabled');
      void tick();
      timer = setInterval(() => void tick(), CLAUDE_USAGE_MIN_INTERVAL_MS);
    } else if (!enabled && timer) {
      clearInterval(timer);
      timer = undefined;
      output.appendLine('[usrouter] usage polling disabled');
    }
  };

  apply();
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('usrouter.pollUsage')) apply();
    }),
    { dispose: () => timer && clearInterval(timer) },
  );
}

export function deactivate(): void {}
