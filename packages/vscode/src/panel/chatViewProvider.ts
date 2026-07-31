import * as vscode from 'vscode';
import { homedir } from 'node:os';
import { relative } from 'node:path';
import {
  Orchestrator,
  SessionStore,
  QuotaTracker,
  AdapterRegistry,
  shortId,
  type PermissionMode,
  type Target,
} from '@usrouter/core';
import type { AccountStore } from '../storage/accountStore.js';
import type { RulesManager } from '../rules/rulesFile.js';
import type {
  AccountStatusDto,
  ConversationMeta,
  HostToWebview,
  WebviewToHost,
} from './protocol.js';

const REPLAYED_KINDS = new Set<HostToWebview['kind']>([
  'userEcho',
  'routing',
  'delta',
  'toolUse',
  'downgraded',
  'failover',
  'done',
  'error',
]);

interface ConversationRecord {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Transcript messages, replayed to hydrate a (re)opened tab. */
  log: HostToWebview[];
  /** Plain turns used to seed engine history after a reload. */
  turns: Array<{ role: 'user' | 'assistant'; text: string }>;
}

interface Surface {
  mode: 'sidebar' | 'tab' | 'accounts' | 'rules';
  conversationId?: string;
}

const CONV_KEY = 'usrouter.conversations';
const NATIVE_SESSIONS_KEY = 'usrouter.nativeSessions';
const MAX_CONVERSATIONS = 50;

/**
 * Claude-panel style layout: the sidebar webview is a session list only;
 * each conversation opens as its own editor tab (one tab per conversation,
 * revealed if already open). Conversations persist across reloads.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'usrouter.chat';

  private surfaces = new Map<vscode.Webview, Surface>();
  private panels = new Map<string, vscode.WebviewPanel>();
  private accountsPanel?: vscode.WebviewPanel;
  private rulesPanel?: vscode.WebviewPanel;
  private conversations = new Map<string, ConversationRecord>();
  private tasks = new Map<string, AbortController>();
  private persistTimer?: NodeJS.Timeout;
  private onTargetChosen?: (target: Target) => void;
  private usageRefresher?: () => Promise<void>;

  constructor(
    private ctx: vscode.ExtensionContext,
    private orchestrator: Orchestrator,
    private sessions: SessionStore,
    private accounts: AccountStore,
    private quota: QuotaTracker,
    private adapters: AdapterRegistry,
    private rules: RulesManager,
    private output: vscode.OutputChannel,
  ) {
    const offQuota = quota.onDidChange(() => this.pushAccounts());
    ctx.subscriptions.push(
      accounts.onDidChange(() => this.pushAccounts()),
      rules.onDidChange(() => {
        this.pushAccounts();
        this.pushRules();
      }),
      { dispose: offQuota },
      { dispose: () => this.persistTimer && clearTimeout(this.persistTimer) },
      { dispose: () => this.cancelAll() },
    );

    for (const rec of ctx.globalState.get<ConversationRecord[]>(CONV_KEY, [])) {
      this.conversations.set(rec.id, rec);
      // Old conversations keep their context after a reload.
      for (const turn of rec.turns) sessions.appendTurn(rec.id, turn);
    }
    sessions.restoreNative(ctx.globalState.get<Record<string, string>>(NATIVE_SESSIONS_KEY, {}));
  }

  setTargetListener(cb: (target: Target) => void): void {
    this.onTargetChosen = cb;
  }

  setUsageRefresher(cb: () => Promise<void>): void {
    this.usageRefresher = cb;
  }

  // ── surfaces ─────────────────────────────────────────────────────

  resolveWebviewView(view: vscode.WebviewView): void {
    this.attach(view.webview, { mode: 'sidebar' });
    view.onDidDispose(() => this.surfaces.delete(view.webview));
  }

  private static readonly ACCOUNT_MODES: ReadonlySet<Surface['mode']> = new Set([
    'sidebar',
    'tab',
    'accounts',
  ]);

  private attach(webview: vscode.Webview, surface: Surface): void {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'media')],
    };
    webview.html = this.html(webview, surface.mode);
    webview.onDidReceiveMessage((msg: WebviewToHost) => this.onMessage(msg, webview));
    this.surfaces.set(webview, surface);
  }

  /**
   * postMessage throws (sync or async) once a webview is disposed; disposal
   * can race our quota/rules listeners, so every send goes through here and
   * a dead surface is dropped instead of surfacing "Webview is disposed".
   */
  private safePost(webview: vscode.Webview, msg: HostToWebview): void {
    try {
      Promise.resolve(webview.postMessage(msg)).then(undefined, () => {
        this.surfaces.delete(webview);
      });
    } catch {
      this.surfaces.delete(webview);
    }
  }

  /** Opens (or reveals) the editor tab bound to a conversation. */
  openConversationTab(id: string): void {
    const rec = this.conversations.get(id);
    if (!rec) return;

    const existing = this.panels.get(id);
    if (existing) {
      existing.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'usrouter.chatTab',
      rec.title || 'New chat',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'media')],
      },
    );
    panel.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'icon.svg');
    this.panels.set(id, panel);
    this.attach(panel.webview, { mode: 'tab', conversationId: id });
    panel.onDidDispose(() => {
      this.surfaces.delete(panel.webview);
      this.panels.delete(id);
      // A never-used chat vanishes when its tab closes.
      const record = this.conversations.get(id);
      if (record && record.log.length === 0) {
        this.conversations.delete(id);
        this.sessions.clearConversation(id);
      }
      this.sendConversations();
    });
    this.sendConversations();
  }

  /** Opens (or reveals) the clean accounts management tab. */
  openAccountsTab(): void {
    if (this.accountsPanel) {
      this.accountsPanel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'usrouter.accountsTab',
      'usrouter · Accounts',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'media')],
      },
    );
    panel.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'icon.svg');
    this.accountsPanel = panel;
    this.attach(panel.webview, { mode: 'accounts' });
    panel.onDidDispose(() => {
      this.surfaces.delete(panel.webview);
      this.accountsPanel = undefined;
    });
  }

  /** Opens (or reveals) the routing-rules tab. */
  openRulesTab(): void {
    if (this.rulesPanel) {
      this.rulesPanel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'usrouter.rulesTab',
      'usrouter · Rules',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'media')],
      },
    );
    panel.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'icon.svg');
    this.rulesPanel = panel;
    this.attach(panel.webview, { mode: 'rules' });
    panel.onDidDispose(() => {
      this.surfaces.delete(panel.webview);
      this.rulesPanel = undefined;
    });
  }

  private rulesMessage(): HostToWebview {
    const state = this.rules.getState();
    return {
      kind: 'rules',
      rules: state.rules,
      path: state.path,
      exists: state.exists,
      error: state.error,
    };
  }

  private pushRules(): void {
    const msg = this.rulesMessage();
    for (const [webview, surface] of this.surfaces) {
      if (surface.mode === 'rules') this.safePost(webview, msg);
    }
  }

  // ── conversations ────────────────────────────────────────────────

  newConversation(): void {
    const rec: ConversationRecord = {
      id: shortId(),
      title: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      log: [],
      turns: [],
    };
    this.conversations.set(rec.id, rec);
    this.openConversationTab(rec.id);
  }

  /** Most recent conversation, or a fresh one. */
  openMostRecent(): void {
    const newest = [...this.conversations.values()].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (newest) this.openConversationTab(newest.id);
    else this.newConversation();
  }

  deleteConversation(id: string): void {
    const rec = this.conversations.get(id);
    if (!rec) return;
    this.tasks.get(id)?.abort();
    this.tasks.delete(id);
    this.panels.get(id)?.dispose();
    this.conversations.delete(id);
    this.sessions.clearConversation(id);
    this.sendConversations();
    this.persistSoon();
  }

  cancelAll(): void {
    for (const [id, controller] of this.tasks) {
      controller.abort();
      this.toConversation(id, { kind: 'busy', running: false }, { log: false });
    }
    this.tasks.clear();
    this.sendConversations();
  }

  private metas(): ConversationMeta[] {
    return [...this.conversations.values()]
      .filter((c) => c.log.length > 0 || this.panels.has(c.id))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((c) => ({
        id: c.id,
        title: c.title || 'New chat',
        updatedAt: c.updatedAt,
        running: this.tasks.has(c.id),
      }));
  }

  private sendConversations(): void {
    const msg: HostToWebview = { kind: 'conversations', list: this.metas(), activeId: '' };
    for (const [webview, surface] of this.surfaces) {
      if (surface.mode === 'sidebar') this.safePost(webview, msg);
    }
  }

  private persistSoon(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      const list = [...this.conversations.values()]
        .filter((c) => c.log.length > 0)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_CONVERSATIONS);
      void this.ctx.globalState.update(CONV_KEY, list);
      void this.ctx.globalState.update(NATIVE_SESSIONS_KEY, this.sessions.serializeNative());
    }, 800);
  }

  /** Merge consecutive delta events so stored logs stay small. */
  private compactLog(rec: ConversationRecord): void {
    const out: HostToWebview[] = [];
    for (const msg of rec.log) {
      const last = out[out.length - 1];
      if (msg.kind === 'delta' && last?.kind === 'delta' && last.messageId === msg.messageId) {
        last.text += msg.text;
        continue;
      }
      out.push({ ...msg });
    }
    rec.log = out;
  }

  // ── messaging ────────────────────────────────────────────────────

  private toConversation(
    conversationId: string,
    msg: HostToWebview,
    opts: { log: boolean } = { log: true },
  ): void {
    if (opts.log && REPLAYED_KINDS.has(msg.kind)) {
      const rec = this.conversations.get(conversationId);
      if (rec) {
        rec.log.push(msg);
        rec.updatedAt = Date.now();
        this.persistSoon();
      }
    }
    for (const [webview, surface] of this.surfaces) {
      if (surface.mode === 'tab' && surface.conversationId === conversationId) {
        this.safePost(webview, msg);
      }
    }
  }

  private hydrate(webview: vscode.Webview, surface: Surface): void {
    if (surface.mode === 'sidebar') {
      this.safePost(webview, { kind: 'conversations', list: this.metas(), activeId: '' });
      this.safePost(webview, {
        kind: 'accounts',
        accounts: this.accountDtos(),
      } satisfies HostToWebview);
      return;
    }
    if (surface.mode === 'accounts') {
      this.safePost(webview, {
        kind: 'accounts',
        accounts: this.accountDtos(),
      } satisfies HostToWebview);
      // Fresh usage on open; results fan out via the quota listener.
      void this.usageRefresher?.();
      return;
    }
    if (surface.mode === 'rules') {
      this.safePost(webview, this.rulesMessage());
      return;
    }
    const rec = surface.conversationId
      ? this.conversations.get(surface.conversationId)
      : undefined;
    this.safePost(webview, { kind: 'conversationReset' } satisfies HostToWebview);
    this.safePost(webview, {
      kind: 'accounts',
      accounts: this.accountDtos(),
    } satisfies HostToWebview);
    if (rec) {
      for (const msg of rec.log) this.safePost(webview, msg);
      this.safePost(webview, {
        kind: 'busy',
        running: this.tasks.has(rec.id),
      } satisfies HostToWebview);
    }
  }

  private async onMessage(msg: WebviewToHost, webview: vscode.Webview): Promise<void> {
    const surface = this.surfaces.get(webview);
    if (!surface) return;
    switch (msg.kind) {
      case 'ready':
        this.hydrate(webview, surface);
        break;
      case 'newConversation':
        this.newConversation();
        break;
      case 'openConversation':
        this.openConversationTab(msg.id);
        break;
      case 'deleteConversation':
        this.deleteConversation(msg.id);
        break;
      case 'openAccounts':
        this.openAccountsTab();
        break;
      case 'openRules':
        this.openRulesTab();
        break;
      case 'addAccount':
        void vscode.commands.executeCommand('usrouter.addAccount');
        break;
      case 'removeAccount':
        void vscode.commands.executeCommand('usrouter.removeAccount', msg.id);
        break;
      case 'editRules':
        void vscode.commands.executeCommand('usrouter.editRules');
        break;
      case 'refreshUsage':
        void this.usageRefresher?.();
        break;
      case 'cancel':
        if (surface.conversationId) {
          this.tasks.get(surface.conversationId)?.abort();
          this.tasks.delete(surface.conversationId);
          this.toConversation(surface.conversationId, { kind: 'busy', running: false }, { log: false });
          this.sendConversations();
        }
        break;
      case 'send':
        if (surface.conversationId) {
          await this.runTask(surface.conversationId, msg.text, msg.tags);
        }
        break;
    }
  }

  // ── task lifecycle ───────────────────────────────────────────────

  private async runTask(conversationId: string, text: string, tags: string[]): Promise<void> {
    const rec = this.conversations.get(conversationId);
    if (!rec) return;
    if (this.tasks.has(conversationId)) {
      void vscode.window.showWarningMessage('usrouter: this chat already has a running task.');
      return;
    }
    if (!rec.title) {
      rec.title = text.split('\n')[0]!.slice(0, 60);
      this.panels.get(conversationId)?.title !== undefined &&
        (this.panels.get(conversationId)!.title = rec.title);
    }

    const messageId = shortId();
    const controller = new AbortController();
    this.tasks.set(conversationId, controller);
    const post = (msg: HostToWebview) => this.toConversation(conversationId, msg);
    post({ kind: 'userEcho', text });
    this.toConversation(conversationId, { kind: 'busy', running: true }, { log: false });
    this.sendConversations();

    const editor = vscode.window.activeTextEditor;
    const ws = vscode.workspace.workspaceFolders?.[0];
    const cwd = ws?.uri.fsPath ?? homedir();
    const activeFile =
      editor && ws ? relative(ws.uri.fsPath, editor.document.uri.fsPath) : editor?.document.uri.fsPath;

    const permissionMode = vscode.workspace
      .getConfiguration('usrouter')
      .get<PermissionMode>('permissionMode', 'safe');

    try {
      const events = this.orchestrator.run(
        {
          conversationId,
          prompt: text,
          cwd,
          activeFile,
          languageId: editor?.document.languageId,
          tags,
          permissionMode,
        },
        controller.signal,
      );

      for await (const ev of events) {
        switch (ev.type) {
          case 'routing': {
            const first = ev.decision.chain[0];
            if (first) {
              post({
                kind: 'routing',
                messageId,
                target: first,
                ruleId: ev.decision.ruleId,
                reason: ev.decision.reason,
              });
            } else {
              const skipped = ev.decision.skipped
                .map((s) => `${s.target.provider}:${s.target.account} (${s.reason})`)
                .join(', ');
              post({
                kind: 'error',
                messageId,
                message: skipped
                  ? `No account available. Skipped: ${skipped}`
                  : 'No accounts configured yet — run "usrouter: Add Account" first.',
              });
            }
            for (const s of ev.decision.skipped) {
              this.output.appendLine(
                `[routing] skipped ${s.target.provider}:${s.target.account}: ${s.reason}`,
              );
            }
            break;
          }
          case 'attempt':
            this.onTargetChosen?.(ev.target);
            if (ev.attempt > 1) {
              post({ kind: 'toolUse', messageId, name: `retry #${ev.attempt}` });
            }
            break;
          case 'text-delta':
            post({ kind: 'delta', messageId, text: ev.text });
            break;
          case 'tool-use':
            post({ kind: 'toolUse', messageId, name: ev.name, detail: ev.detail });
            break;
          case 'model-downgraded':
            post({ kind: 'downgraded', messageId, from: ev.from, to: ev.to });
            break;
          case 'failover':
            post({
              kind: 'failover',
              messageId,
              from: ev.from,
              to: ev.to,
              reason: ev.reason,
              resetAt: ev.resetAt,
            });
            break;
          case 'result':
            rec.turns.push({ role: 'user', text }, { role: 'assistant', text: ev.text });
            post({ kind: 'done', messageId, costUsd: ev.costUsd });
            break;
          case 'limit': {
            const reset = ev.resetAt ? ` Resets ${new Date(ev.resetAt).toLocaleString()}.` : '';
            post({ kind: 'error', messageId, message: `Usage limit reached.${reset}` });
            break;
          }
          case 'error':
            post({ kind: 'error', messageId, message: ev.message });
            break;
          case 'chain-exhausted':
            if (ev.tried.length > 0) {
              post({
                kind: 'error',
                messageId,
                message: `All ${ev.tried.length} account(s) in the chain failed or hit limits.`,
              });
            }
            break;
          case 'session':
            break;
        }
      }
    } catch (e) {
      post({ kind: 'error', messageId, message: (e as Error).message });
      this.output.appendLine(`[error] ${(e as Error).stack ?? e}`);
    } finally {
      if (this.tasks.get(conversationId) === controller) this.tasks.delete(conversationId);
      this.compactLog(rec);
      this.toConversation(conversationId, { kind: 'busy', running: false }, { log: false });
      this.pushAccounts();
      this.sendConversations();
      this.persistSoon();
    }
  }

  // ── accounts ─────────────────────────────────────────────────────

  private accountDtos(): AccountStatusDto[] {
    const all = this.accounts.all();
    const snapshots = this.quota.snapshot(all.map((a) => a.id));
    return all
      .sort((a, b) => a.priority - b.priority)
      .map((a) => {
        const snap = snapshots.find((s) => s.accountId === a.id);
        return {
          id: a.id,
          provider: a.provider,
          label: a.label,
          authMode: a.authMode,
          available: !a.disabled && (snap?.available ?? true),
          resetAt: snap?.resetAt,
          usage: snap?.usage,
          models: this.adapters.get(a.provider)?.models ?? [],
        };
      });
  }

  pushAccounts(): void {
    const msg: HostToWebview = { kind: 'accounts', accounts: this.accountDtos() };
    for (const [webview, surface] of this.surfaces) {
      if (ChatViewProvider.ACCOUNT_MODES.has(surface.mode)) this.safePost(webview, msg);
    }
  }

  private html(webview: vscode.Webview, mode: Surface['mode']): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'webview.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'webview.css'),
    );
    const nonce = shortId(16);
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri}" rel="stylesheet">
  <title>usrouter</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">window.__USROUTER_MODE__ = '${mode}';</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
