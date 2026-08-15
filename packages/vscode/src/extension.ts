import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join as joinPath } from 'node:path';
import {
  AdapterRegistry,
  buildProviderBrief,
  briefLinesFor,
  disqualifiedLines,
  ClaudeAdapter,
  CodexAdapter,
  CopilotAdapter,
  GeminiAdapter,
  OpenRouterAdapter,
  Orchestrator,
  QuotaTracker,
  SessionStore,
  CLAUDE_USAGE_MIN_INTERVAL_MS,
} from '@usturlab/core';
import { refreshUsage } from './usage.js';
import { migrateFromUsrouter } from './migration.js';
import { AccountStore } from './storage/accountStore.js';
import { MetricsStore } from './storage/metricsStore.js';
import { PreferenceStore } from './storage/preferenceStore.js';
import { WorkspaceContext } from './context/workspaceContext.js';
import { Verifier } from './verify/verifier.js';
import { PermissionBridge } from './permission/bridge.js';
import { globalStateQuotaPersistence } from './storage/quotaPersistence.js';
import { RulesManager } from './rules/rulesFile.js';
import { ChatViewProvider } from './panel/chatViewProvider.js';
import { RouterStatusBar } from './views/statusBar.js';
import { registerCommands } from './commands.js';

export function activate(ctx: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('usturlab');
  ctx.subscriptions.push(output);

  hideSecondarySidebarOnOldVSCode();

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
  // No CLI and no subscription: an HTTP call to free open-weight models, used
  // only to review what the others wrote.
  adapters.register(new OpenRouterAdapter());

  const accounts = new AccountStore(ctx);
  void migrateFromUsrouter(accounts, (line) => output.appendLine(line));
  const quota = new QuotaTracker(globalStateQuotaPersistence(ctx));
  const sessions = new SessionStore();
  const rules = new RulesManager();
  const metrics = new MetricsStore(ctx);
  const preferences = new PreferenceStore(ctx);
  const workspaceContext = new WorkspaceContext(output);
  const verifier = new Verifier(output);
  // Claude asks through a local MCP server it spawns itself; the bridge is the
  // host end of that conversation.
  const bridge = new PermissionBridge(
    joinPath(ctx.extensionPath, 'dist', 'permissionServer.js'),
    (request) => chatRef!.askViaBridge(request),
    output,
  );
  ctx.subscriptions.push(bridge);
  ctx.subscriptions.push(rules);

  /** Standing instructions, minus any line the evidence says to stop sending. */
  const providerBrief = (provider: Parameters<typeof buildProviderBrief>[0]['provider'], mode: 'safe' | 'edits' | 'full') => {
    const all = briefLinesFor({ provider, permissionMode: mode });
    const disabled = disqualifiedLines(all.map((l) => l.id), metrics.all());
    const options = {
      provider,
      permissionMode: mode,
      preferences: preferences.preferences(),
      disabledLineIds: disabled,
    };
    return { text: buildProviderBrief(options), lineIds: briefLinesFor(options).map((l) => l.id) };
  };

  // Declared before the orchestrator so routing can read thread memory.
  let chatRef: ChatViewProvider | undefined;

  const orchestrator = new Orchestrator({
    adapters,
    quota,
    sessions,
    getMetrics: () => metrics.all(),
    getConversationContext: (id) => chatRef?.conversationContext(id),
    getAutoPlan: () =>
      vscode.workspace.getConfiguration('usturlab').get<boolean>('autoPlanHeavyEdits', true),
    getRules: () => rules.getRules(),
    getCustomCommands: () => rules.getCustomCommands(),
    getRoutingMode: () =>
      vscode.workspace.getConfiguration('usturlab').get<'auto' | 'manual'>('routingMode', 'auto'),
    getAccounts: () => accounts.all(),
    resolveAccount: (target) => accounts.resolve(target),
    getBrief: (task, provider) => {
      const config = vscode.workspace.getConfiguration('usturlab');
      if (!config.get<boolean>('sendWorkspaceContext', true)) return '';
      return workspaceContext.buildFor(task, provider, {
        preferences: preferences.preferences(),
        // The same commands verification would run, so the model is told the
        // check it is about to be judged by — and told it even when we are not
        // running it ourselves, which is when it matters most.
        checks: verifier.available(),
        shapeTasks: config.get<boolean>('frameTasks', true),
        ...chatRef?.threadFiles(task.conversationId),
      });
    },
    getAskPermission: () =>
      vscode.workspace.getConfiguration('usturlab').get<boolean>('askPermission', false),
    getHostArgs: (provider) => (provider === 'claude' ? bridge.claudeArgs() : undefined),
    getProviderBrief: (provider, mode) =>
      vscode.workspace.getConfiguration('usturlab').get<boolean>('standingInstructions', true)
        ? providerBrief(provider, mode)
        : { text: '', lineIds: [] },
  });

  const statusBar = new RouterStatusBar();
  ctx.subscriptions.push(statusBar);

  const chat = new ChatViewProvider(
    ctx,
    orchestrator,
    sessions,
    accounts,
    quota,
    adapters,
    rules,
    metrics,
    preferences,
    workspaceContext,
    verifier,
    output,
  );
  chatRef = chat;
  chat.setTargetListener((target) => statusBar.routed(target));
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chat, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider(ChatViewProvider.secondaryViewType, chat, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  registerCommands(ctx, { accounts, adapters, quota, rules, chat, statusBar });

  // Only listen once asking is actually on; a socket nobody uses is waste.
  const applyAsk = () => {
    if (vscode.workspace.getConfiguration('usturlab').get<boolean>('askPermission', false)) {
      void bridge.start();
    }
  };
  applyAsk();
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('usturlab.askPermission')) applyAsk();
    }),
  );

  const usageRefresher = () => refreshUsage(accounts, quota, (line) => output.appendLine(line));
  chat.setUsageRefresher(usageRefresher);
  startUsagePolling(ctx, usageRefresher, output);

  output.appendLine('[usturlab] activated');
}

/**
 * View containers may live in the secondary side bar — the strip at the top
 * right — only from VS Code 1.106 on. Older builds would spill that copy of
 * the chat list into the Explorer, so hide it there and keep the activity bar.
 */
function hideSecondarySidebarOnOldVSCode(): void {
  const [major = 0, minor = 0] = vscode.version.split('.').map(Number);
  if (major > 1 || (major === 1 && minor >= 106)) return;
  void vscode.commands.executeCommand('setContext', 'usturlab.noSecondarySidebar', true);
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
