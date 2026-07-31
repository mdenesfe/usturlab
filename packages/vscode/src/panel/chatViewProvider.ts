import * as vscode from 'vscode';
import { homedir } from 'node:os';
import { relative } from 'node:path';
import {
  Orchestrator,
  SessionStore,
  QuotaTracker,
  AdapterRegistry,
  getAccountIdentity,
  formatTarget,
  matchSlashCommand,
  shortId,
  observedBurn,
  isRetry,
  isTransientFailure,
  type ConversationContext,
  type LiveRunHandle,
  type PermissionMode,
  type Target,
  type TaskMetric,
} from '@usturlab/core';
import type { AccountStore } from '../storage/accountStore.js';
import type { MetricsStore } from '../storage/metricsStore.js';
import type { RulesManager } from '../rules/rulesFile.js';
import type {
  AccountStatusDto,
  ConversationMeta,
  HostToWebview,
  WebviewToHost,
} from './protocol.js';
import { compactLog } from './transcript.js';

const REPLAYED_KINDS = new Set<HostToWebview['kind']>([
  'userEcho',
  'routing',
  'delta',
  'toolUse',
  'downgraded',
  'notice',
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
  mode: 'sidebar' | 'tab' | 'accounts' | 'rules' | 'rulesBuilder' | 'analytics';
  conversationId?: string;
}

const CONV_KEY = 'usturlab.conversations';
const NATIVE_SESSIONS_KEY = 'usturlab.nativeSessions';
const MAX_CONVERSATIONS = 50;

/**
 * Claude-panel style layout: the sidebar webview is a session list only;
 * each conversation opens as its own editor tab (one tab per conversation,
 * revealed if already open). Conversations persist across reloads.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'usturlab.chat';

  private surfaces = new Map<vscode.Webview, Surface>();
  private panels = new Map<string, vscode.WebviewPanel>();
  private accountsPanel?: vscode.WebviewPanel;
  private rulesPanel?: vscode.WebviewPanel;
  private rulesBuilderPanel?: vscode.WebviewPanel;
  private analyticsPanel?: vscode.WebviewPanel;
  private conversations = new Map<string, ConversationRecord>();
  private tasks = new Map<string, AbortController>();
  private queues = new Map<
    string,
    Array<{
      text: string;
      tags: string[];
      modes?: { permissionMode?: PermissionMode; routingMode?: 'auto' | 'manual'; attachments?: string[] };
    }>
  >();
  private liveRuns = new Map<
    string,
    { handle: LiveRunHandle; messageIds: string[]; turnIdx: number; userTexts: string[]; lastTarget?: Target }
  >();
  private persistTimer?: NodeJS.Timeout;
  private onTargetChosen?: (target: Target) => void;
  private usageRefresher?: () => Promise<void>;
  private identities = new Map<string, string>();
  /** What the router needs to keep a thread on one model: where it ran and how heavy it got. */
  /** Conversations the user had to interject into — a signal the model was off track. */
  private steeredRuns = new Set<string>();
  private threadContext = new Map<
    string,
    {
      lastTarget?: Target;
      peakComplexity?: string;
      turnCount: number;
      /** Last finished run, so a quick re-ask can be attributed back to it. */
      lastPrompt?: string;
      lastFinishedAt?: number;
      lastMetricId?: string;
    }
  >();

  constructor(
    private ctx: vscode.ExtensionContext,
    private orchestrator: Orchestrator,
    private sessions: SessionStore,
    private accounts: AccountStore,
    private quota: QuotaTracker,
    private adapters: AdapterRegistry,
    private rules: RulesManager,
    private metrics: MetricsStore,
    private output: vscode.OutputChannel,
  ) {
    const offQuota = quota.onDidChange(() => this.pushAccounts());
    ctx.subscriptions.push(
      accounts.onDidChange(() => {
        this.pushAccounts();
        // A freshly authed account gets its identity/usage without reopening.
        void this.loadIdentities();
        void this.usageRefresher?.();
      }),
      rules.onDidChange(() => {
        this.pushAccounts();
        this.pushRules();
      }),
      // An open analytics tab follows every recorded run live.
      metrics.onDidChange(() => this.pushAnalytics()),
      { dispose: offQuota },
      {
        dispose: () => {
          // Flush pending writes so a window close never loses the last turn.
          if (this.persistTimer) clearTimeout(this.persistTimer);
          this.persistNow();
        },
      },
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

  /** Conversation memory for the router: same thread → same model unless work escalates. */
  conversationContext(conversationId: string): ConversationContext | undefined {
    const ctx = this.threadContext.get(conversationId);
    if (!ctx) return undefined;
    return {
      lastTarget: ctx.lastTarget,
      peakComplexity: ctx.peakComplexity as ConversationContext['peakComplexity'],
      turnCount: ctx.turnCount,
    };
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
    'analytics',
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

  /** reveal() throws once a panel is disposed under us; treat that as gone. */
  private safeReveal(panel: vscode.WebviewPanel | undefined): boolean {
    if (!panel) return false;
    try {
      panel.reveal();
      return true;
    } catch {
      return false;
    }
  }

  /** Opens (or reveals) the editor tab bound to a conversation. */
  openConversationTab(id: string): void {
    const rec = this.conversations.get(id);
    if (!rec) return;

    const existing = this.panels.get(id);
    if (this.safeReveal(existing)) return;
    if (existing) this.panels.delete(id);

    const panel = vscode.window.createWebviewPanel(
      'usturlab.chatTab',
      rec.title || 'New chat',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'media')],
      },
    );
    panel.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'tab-icon.svg');
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
    if (this.safeReveal(this.accountsPanel)) return;
    this.accountsPanel = undefined;
    const panel = vscode.window.createWebviewPanel(
      'usturlab.accountsTab',
      'usturlab · Accounts',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'media')],
      },
    );
    panel.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'tab-icon.svg');
    this.accountsPanel = panel;
    this.attach(panel.webview, { mode: 'accounts' });
    panel.onDidDispose(() => {
      this.surfaces.delete(panel.webview);
      this.accountsPanel = undefined;
    });
  }

  /** Opens (or reveals) the routing-rules tab. */
  openRulesTab(): void {
    if (this.safeReveal(this.rulesPanel)) return;
    this.rulesPanel = undefined;
    const panel = vscode.window.createWebviewPanel(
      'usturlab.rulesTab',
      'usturlab · Rules',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'media')],
      },
    );
    panel.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'tab-icon.svg');
    this.rulesPanel = panel;
    this.attach(panel.webview, { mode: 'rules' });
    panel.onDidDispose(() => {
      this.surfaces.delete(panel.webview);
      this.rulesPanel = undefined;
    });
  }

  /** Opens (or reveals) the visual rules builder tab. */
  openRulesBuilderTab(): void {
    if (this.safeReveal(this.rulesBuilderPanel)) return;
    this.rulesBuilderPanel = undefined;
    const panel = vscode.window.createWebviewPanel(
      'usturlab.rulesBuilderTab',
      'usturlab · Rules Builder',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'media')],
      },
    );
    panel.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'tab-icon.svg');
    this.rulesBuilderPanel = panel;
    this.attach(panel.webview, { mode: 'rulesBuilder' });
    panel.onDidDispose(() => {
      this.surfaces.delete(panel.webview);
      this.rulesBuilderPanel = undefined;
    });
  }

  /** Opens (or reveals) the analytics tab. */
  openAnalyticsTab(): void {
    if (this.safeReveal(this.analyticsPanel)) return;
    this.analyticsPanel = undefined;
    const panel = vscode.window.createWebviewPanel(
      'usturlab.analyticsTab',
      'usturlab · Analytics',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'media')],
      },
    );
    panel.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'tab-icon.svg');
    this.analyticsPanel = panel;
    this.attach(panel.webview, { mode: 'analytics' });
    panel.onDidDispose(() => {
      this.surfaces.delete(panel.webview);
      this.analyticsPanel = undefined;
    });
  }

  private modesMessage(): HostToWebview {
    const config = vscode.workspace.getConfiguration('usturlab');
    return {
      kind: 'modes',
      permissionMode: config.get<string>('permissionMode', 'safe'),
      routingMode: config.get<'auto' | 'manual'>('routingMode', 'auto'),
    };
  }

  private rulesMessage(): HostToWebview {
    const state = this.rules.getState();
    return {
      kind: 'rules',
      rules: state.rules,
      path: state.path,
      exists: state.exists,
      error: state.error,
      customCommands: this.rules.getCustomCommands(),
    };
  }

  private pushRules(): void {
    const msg = this.rulesMessage();
    for (const [webview, surface] of this.surfaces) {
      // Chat tabs consume rules too (tag suggestions in the composer).
      if (surface.mode === 'rules' || surface.mode === 'tab') this.safePost(webview, msg);
    }
  }

  private pushAnalytics(webview?: vscode.Webview): void {
    const msg: HostToWebview = {
      kind: 'analytics',
      metrics: this.metrics.all(),
      accounts: this.accountDtos(),
    };
    if (webview) {
      this.safePost(webview, msg);
    } else {
      for (const [w, surface] of this.surfaces) {
        if (surface.mode === 'analytics') this.safePost(w, msg);
      }
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

  /** /clear — wipe transcript + engine context of one conversation, keep the tab. */
  clearConversation(id: string): void {
    const rec = this.conversations.get(id);
    if (!rec) return;
    this.queues.delete(id);
    this.tasks.get(id)?.abort();
    this.tasks.delete(id);
    rec.log = [];
    rec.turns = [];
    rec.title = '';
    this.sessions.clearConversation(id);
    this.threadContext.delete(id);
    const panel = this.panels.get(id);
    if (panel) panel.title = 'New chat';
    for (const [webview, surface] of this.surfaces) {
      if (surface.mode === 'tab' && surface.conversationId === id) {
        this.safePost(webview, { kind: 'conversationReset' });
        this.safePost(webview, { kind: 'busy', running: false });
      }
    }
    this.sendConversations();
    this.persistSoon();
  }

  deleteConversation(id: string): void {
    const rec = this.conversations.get(id);
    if (!rec) return;
    this.queues.delete(id);
    this.tasks.get(id)?.abort();
    this.tasks.delete(id);
    this.panels.get(id)?.dispose();
    this.conversations.delete(id);
    this.sessions.clearConversation(id);
    this.sendConversations();
    this.persistSoon();
  }

  cancelAll(): void {
    this.queues.clear();
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

  private persistNow(): void {
    const list = [...this.conversations.values()]
      .filter((c) => c.log.length > 0)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_CONVERSATIONS);
    void this.ctx.globalState.update(CONV_KEY, list);
    void this.ctx.globalState.update(NATIVE_SESSIONS_KEY, this.sessions.serializeNative());
  }

  private persistSoon(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.persistNow(), 800);
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
      // Fresh usage + identities on open; results fan out via listeners.
      void this.usageRefresher?.();
      void this.loadIdentities();
      return;
    }
    if (surface.mode === 'rules') {
      this.safePost(webview, this.rulesMessage());
      this.safePost(webview, this.modesMessage());
      return;
    }
    if (surface.mode === 'rulesBuilder') {
      this.safePost(webview, this.rulesMessage());
      this.safePost(webview, {
        kind: 'accounts',
        accounts: this.accountDtos(),
      } satisfies HostToWebview);
      return;
    }
    if (surface.mode === 'analytics') {
      this.pushAnalytics(webview);
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
    this.safePost(webview, this.rulesMessage());
    this.safePost(webview, this.modesMessage());
    if (rec) {
      for (const msg of rec.log) this.safePost(webview, msg);
      this.safePost(webview, {
        kind: 'busy',
        running: this.tasks.has(rec.id),
      } satisfies HostToWebview);
    }
  }

  private async onMessage(msg: WebviewToHost, webview: vscode.Webview): Promise<void> {
    try {
      await this.dispatchMessage(msg, webview);
    } catch (e) {
      this.output.appendLine(`[ui] ${msg.kind} failed: ${(e as Error).stack ?? e}`);
    }
  }

  private async dispatchMessage(msg: WebviewToHost, webview: vscode.Webview): Promise<void> {
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
        void vscode.commands.executeCommand('usturlab.addAccount');
        break;
      case 'removeAccount':
        void vscode.commands.executeCommand('usturlab.removeAccount', msg.id);
        break;
      case 'renameAccount':
        await this.renameAccount(msg.id);
        break;
      case 'editRules':
        void vscode.commands.executeCommand('usturlab.editRules');
        break;
      case 'openRulesBuilder':
        this.openRulesBuilderTab();
        break;
      case 'saveRule':
        void this.rules.saveRule(msg.rule, msg.ruleIndex);
        break;
      case 'deleteRule':
        void this.rules.deleteRule(msg.ruleId);
        break;
      case 'reorderRules':
        void this.rules.reorderRules(msg.order);
        break;
      case 'saveDefaultChain':
        void this.rules.saveDefaultChain(msg.chain);
        break;
      case 'openAnalytics':
        this.openAnalyticsTab();
        break;
      case 'clearAnalytics':
        void this.metrics.clear();
        break;
      case 'refreshUsage':
        void this.usageRefresher?.();
        break;
      case 'cancel':
        if (surface.conversationId) {
          this.queues.delete(surface.conversationId);
          this.tasks.get(surface.conversationId)?.abort();
          this.tasks.delete(surface.conversationId);
          this.toConversation(surface.conversationId, { kind: 'busy', running: false }, { log: false });
          this.sendConversations();
        }
        break;
      case 'send':
        if (surface.conversationId) {
          await this.handleSend(surface.conversationId, msg.text, msg.tags, {
            permissionMode: msg.permissionMode as PermissionMode | undefined,
            routingMode: msg.routingMode,
            attachments: msg.attachments,
          });
        }
        break;
      case 'pickAttachments': {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: true,
          openLabel: 'Attach',
          defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
        });
        this.safePost(webview, {
          kind: 'attachments',
          paths: (picked ?? []).map((uri) => uri.fsPath),
        });
        break;
      }
      case 'setModes': {
        const config = vscode.workspace.getConfiguration('usturlab');
        if (msg.permissionMode) {
          await config.update('permissionMode', msg.permissionMode, vscode.ConfigurationTarget.Global);
        }
        if (msg.routingMode) {
          await config.update('routingMode', msg.routingMode, vscode.ConfigurationTarget.Global);
        }
        break;
      }
    }
  }

  // ── task lifecycle ───────────────────────────────────────────────

  private performAction(conversationId: string, action: import('@usturlab/core').SlashAction): void {
    const notice = (t: string) => this.toConversation(conversationId, { kind: 'notice', text: t });
    switch (action) {
      case 'newChat':
        this.newConversation();
        break;
      case 'clearChat':
        this.clearConversation(conversationId);
        break;
      case 'openAccounts':
        this.openAccountsTab();
        notice('opened accounts');
        break;
      case 'openRules':
        this.openRulesTab();
        notice('opened routing rules');
        break;
      case 'refreshUsage':
        void this.usageRefresher?.();
        notice('refreshing usage…');
        break;
      case 'openTerminal':
        void vscode.commands.executeCommand('usturlab.openInTerminal');
        break;
    }
    this.sendConversations();
  }

  /** Entry point for user sends: echoes immediately; queues while a task runs. */
  private async handleSend(
    conversationId: string,
    text: string,
    tags: string[],
    modes: {
      permissionMode?: PermissionMode;
      routingMode?: 'auto' | 'manual';
      attachments?: string[];
    } = {},
  ): Promise<void> {
    if (!this.conversations.has(conversationId)) return;
    // Attachments travel as plain paths — every CLI can read files itself.
    if (modes.attachments?.length) {
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const shown = modes.attachments.map((p) => (ws && p.startsWith(ws) ? relative(ws, p) : p));
      text = `${text}\n\nAttached files:\n${shown.map((p) => `- ${p}`).join('\n')}`;
    }
    this.toConversation(conversationId, { kind: 'userEcho', text });
    this.detectRetry(conversationId, text);
    // Host actions (/accounts, /clear…) must never be injected or queued.
    const slashAction = matchSlashCommand(text, this.rules.getCustomCommands());
    if (slashAction?.cmd.kind === 'action' && slashAction.cmd.action) {
      this.performAction(conversationId, slashAction.cmd.action);
      return;
    }
    if (this.tasks.has(conversationId)) {
      // Prefer real mid-run injection (Claude's streamed stdin); the running
      // model sees the message immediately. Queue only when unsupported.
      const live = this.liveRuns.get(conversationId);
      if (live?.handle.inject?.(text)) {
        this.steeredRuns.add(conversationId);
        if (live.handle.injectMode === 'inline') {
          // The agent folds this into the turn already streaming — no new block.
          this.toConversation(conversationId, {
            kind: 'notice',
            text: 'delivered to the running task',
          });
        } else {
          const injectedId = shortId();
          live.messageIds.push(injectedId);
          live.userTexts.push(text);
          if (live.lastTarget) {
            this.toConversation(conversationId, {
              kind: 'routing',
              messageId: injectedId,
              target: live.lastTarget,
              reason: 'continued in the running session',
            });
          }
        }
        return;
      }
      const strategy = vscode.workspace
        .getConfiguration('usturlab')
        .get<'queue' | 'restart'>('midRunStrategy', 'queue');
      if (strategy === 'restart') {
        const inFlight = live?.userTexts[live.turnIdx] ?? '';
        this.toConversation(conversationId, {
          kind: 'notice',
          text: 'restarting with both messages merged (this model cannot take mid-run input)',
        });
        this.tasks.get(conversationId)?.abort();
        this.tasks.delete(conversationId);
        const merged = inFlight
          ? `${inFlight}\n\n[Additional message sent while you were working — address both]: ${text}`
          : text;
        // Let the aborted run finish its cleanup before starting the retry.
        await new Promise((resolve) => setTimeout(resolve, 200));
        await this.runTask(conversationId, merged, tags, modes);
        return;
      }
      this.toConversation(conversationId, {
        kind: 'notice',
        text: 'queued — this model cannot take mid-run input; runs next',
      });
      const queue = this.queues.get(conversationId) ?? [];
      queue.push({ text, tags, modes });
      this.queues.set(conversationId, queue);
      return;
    }
    await this.runTask(conversationId, text, tags, modes);
  }

  /**
   * A near-identical prompt right after an answer means that answer did not
   * land — the run counts as friction even though it technically succeeded.
   */
  private detectRetry(conversationId: string, text: string): void {
    const ctx = this.threadContext.get(conversationId);
    if (!ctx?.lastMetricId || !ctx.lastPrompt || !ctx.lastFinishedAt) return;
    if (!isRetry(ctx.lastPrompt, text, Date.now() - ctx.lastFinishedAt)) return;
    void this.metrics.markRetried(ctx.lastMetricId);
    // Only the run that was actually re-asked is penalized.
    ctx.lastMetricId = undefined;
  }

  private async runTask(
    conversationId: string,
    text: string,
    tags: string[],
    modes: {
      permissionMode?: PermissionMode;
      routingMode?: 'auto' | 'manual';
      attachments?: string[];
    } = {},
  ): Promise<void> {
    const rec = this.conversations.get(conversationId);
    if (!rec) return;
    if (this.tasks.has(conversationId)) return;

    // Safety net for actions that were queued before handleSend intercepted them.
    const slash = matchSlashCommand(text, this.rules.getCustomCommands());
    if (slash?.cmd.kind === 'action' && slash.cmd.action) {
      this.performAction(conversationId, slash.cmd.action);
      return;
    }
    if (!rec.title) {
      rec.title = text.split('\n')[0]!.slice(0, 60);
      this.panels.get(conversationId)?.title !== undefined &&
        (this.panels.get(conversationId)!.title = rec.title);
    }

    const messageId = shortId();
    const startedAt = Date.now();
    let gotResult = false;
    let escalated = false;
    const usageBefore = this.accountUsagePct(conversationId);
    const controller = new AbortController();
    this.tasks.set(conversationId, controller);
    const live = {
      handle: {} as LiveRunHandle,
      messageIds: [messageId],
      turnIdx: 0,
      userTexts: [text],
      lastTarget: undefined as Target | undefined,
    };
    this.liveRuns.set(conversationId, live);
    const currentId = () => live.messageIds[Math.min(live.turnIdx, live.messageIds.length - 1)]!;
    const post = (msg: HostToWebview) => this.toConversation(conversationId, msg);
    this.toConversation(conversationId, { kind: 'busy', running: true }, { log: false });
    this.sendConversations();

    const editor = vscode.window.activeTextEditor;
    const ws = vscode.workspace.workspaceFolders?.[0];
    const cwd = ws?.uri.fsPath ?? homedir();
    const activeFile =
      editor && ws ? relative(ws.uri.fsPath, editor.document.uri.fsPath) : editor?.document.uri.fsPath;

    const permissionMode =
      modes.permissionMode ??
      vscode.workspace.getConfiguration('usturlab').get<PermissionMode>('permissionMode', 'safe');
    const routingMode =
      modes.routingMode ??
      vscode.workspace.getConfiguration('usturlab').get<'auto' | 'manual'>('routingMode', 'auto');

    let metric: Partial<TaskMetric> = { id: messageId, timestamp: Date.now(), conversationId };
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
          routingMode,
        },
        controller.signal,
        live.handle,
      );

      for await (const ev of events) {
        switch (ev.type) {
          case 'routing': {
            const cls = ev.decision.classification;
            metric = {
              ...metric,
              kind: cls?.kind,
              complexity: cls?.complexity,
              routingReason: ev.decision.reason,
              ruleId: ev.decision.ruleId,
            };
            if (cls?.complexity) {
              const ctx = this.threadContext.get(conversationId) ?? { turnCount: 0 };
              const order = ['trivial', 'simple', 'moderate', 'hard'];
              if (
                !ctx.peakComplexity ||
                order.indexOf(cls.complexity) > order.indexOf(ctx.peakComplexity)
              ) {
                ctx.peakComplexity = cls.complexity;
              }
              this.threadContext.set(conversationId, ctx);
            }
            if (ev.decision.escalated) {
              escalated = true;
              post({
                kind: 'notice',
                text: `work got heavier — moving this thread up to the ${ev.decision.escalated.to} tier`,
              });
            }
            if (ev.decision.suggestPermission === 'safe') {
              post({
                kind: 'notice',
                text: 'heavy change — planning first; switch to Edit to let it write',
              });
            }
            const first = ev.decision.chain[0];
            if (first) {
              metric = { ...metric, provider: first.provider, account: first.account, model: first.model };
              metric.ruleId = ev.decision.ruleId;
              metric.routingReason = ev.decision.reason;
              post({
                kind: 'routing',
                messageId: currentId(),
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
                messageId: currentId(),
                message: skipped
                  ? `No account available. Skipped: ${skipped}`
                  : 'No accounts configured yet — run "usturlab: Add Account" first.',
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
            live.lastTarget = ev.target;
            this.onTargetChosen?.(ev.target);
            if (ev.attempt > 1) {
              post({
                kind: 'notice',
                text: `connection dropped — retrying on ${formatTarget(ev.target)} (attempt ${ev.attempt})`,
              });
            }
            break;
          case 'text-delta':
            post({ kind: 'delta', messageId: currentId(), text: ev.text });
            break;
          case 'tool-use':
            post({ kind: 'toolUse', messageId: currentId(), name: ev.name, detail: ev.detail });
            break;
          case 'model-downgraded':
            post({ kind: 'downgraded', messageId: currentId(), from: ev.from, to: ev.to });
            break;
          case 'failover': {
            // The account that could not finish is recorded on its own, or the
            // learning loop would only ever see whoever cleaned up after it.
            if (metric.provider && metric.account) {
              void this.metrics.record({
                id: `${metric.id}-${metric.provider}-${metric.account}`,
                timestamp: metric.timestamp!,
                conversationId,
                provider: metric.provider,
                account: metric.account,
                model: metric.model,
                ruleId: metric.ruleId,
                routingReason: metric.routingReason,
                kind: metric.kind,
                complexity: metric.complexity,
                durationMs: Date.now() - startedAt,
                status: 'failover',
                failoverReason: ev.reason,
                transient: isTransientFailure(ev.reason),
              });
            }
            metric = {
              ...metric,
              provider: ev.to.provider,
              account: ev.to.account,
              model: ev.to.model,
              status: undefined,
              errorMessage: undefined,
              failedFrom: { provider: ev.from.provider, account: ev.from.account, model: ev.from.model },
              failoverReason: ev.reason,
            };
            post({
              kind: 'failover',
              messageId: currentId(),
              from: ev.from,
              to: ev.to,
              reason: ev.reason,
              resetAt: ev.resetAt,
            });
            break;
          }
          case 'result': {
            const turnUser = live.userTexts[live.turnIdx] ?? text;
            rec.turns.push({ role: 'user', text: turnUser }, { role: 'assistant', text: ev.text });
            if (live.turnIdx > 0) {
              // Injected turns: keep the engine history in sync too (the
              // orchestrator records only the first pair).
              this.sessions.appendTurn(conversationId, { role: 'user', text: turnUser });
              this.sessions.appendTurn(conversationId, { role: 'assistant', text: ev.text });
            }
            gotResult = true;
            const durationMs = Date.now() - startedAt;
            metric = { ...metric, inputTokens: ev.usage?.inputTokens, outputTokens: ev.usage?.outputTokens, costUsd: ev.costUsd, durationMs, status: 'success' };
            post({
              kind: 'done',
              messageId: currentId(),
              costUsd: ev.costUsd,
              durationMs,
            });
            live.turnIdx++;
            break;
          }
          case 'limit': {
            const reset = ev.resetAt ? ` Resets ${new Date(ev.resetAt).toLocaleString()}.` : '';
            post({ kind: 'error', messageId: currentId(), message: `Usage limit reached.${reset}` });
            break;
          }
          case 'error':
            metric = {
              ...metric,
              status: 'error',
              errorMessage: ev.message,
              transient: isTransientFailure(ev.message),
            };
            post({ kind: 'error', messageId: currentId(), message: ev.message });
            break;
          case 'chain-exhausted':
            if (ev.tried.length > 0) {
              post({
                kind: 'error',
                messageId: currentId(),
                message: `All ${ev.tried.length} account(s) in the chain failed or hit limits.`,
              });
            }
            break;
          case 'session':
            break;
        }
      }
    } catch (e) {
      metric = { ...metric, status: 'error', errorMessage: (e as Error).message };
      post({ kind: 'error', messageId: currentId(), message: (e as Error).message });
      this.output.appendLine(`[error] ${(e as Error).stack ?? e}`);
    } finally {
      if (metric.status && metric.provider && metric.account) {
        const steered = this.steeredRuns.delete(conversationId);
        const target = live.lastTarget;
        const usageAfter = target ? this.usagePctForTarget(target) : undefined;
        void this.metrics.record({
          id: metric.id!,
          timestamp: metric.timestamp!,
          conversationId: metric.conversationId!,
          provider: metric.provider,
          account: metric.account,
          model: metric.model,
          ruleId: metric.ruleId,
          routingReason: metric.routingReason,
          kind: metric.kind,
          complexity: metric.complexity,
          inputTokens: metric.inputTokens,
          outputTokens: metric.outputTokens,
          costUsd: metric.costUsd,
          durationMs: metric.durationMs,
          burnPct: observedBurn(usageBefore, usageAfter),
          status: metric.status as 'success' | 'error' | 'failover',
          errorMessage: metric.errorMessage,
          transient: metric.transient,
          failedFrom: metric.failedFrom,
          failoverReason: metric.failoverReason,
          steered,
          escalated,
        });
      }
      // Remember where this thread ran so the next turn stays put, and what it
      // was asked, so a quick re-ask can be recognized as friction.
      if (live.lastTarget) {
        const ctx = this.threadContext.get(conversationId) ?? { turnCount: 0 };
        ctx.lastTarget = live.lastTarget;
        ctx.turnCount += 1;
        ctx.lastPrompt = text;
        ctx.lastFinishedAt = Date.now();
        ctx.lastMetricId = metric.status ? metric.id : undefined;
        this.threadContext.set(conversationId, ctx);
      }
      if (this.tasks.get(conversationId) === controller) this.tasks.delete(conversationId);
      if (this.liveRuns.get(conversationId) === live) this.liveRuns.delete(conversationId);
      if (!controller.signal.aborted) {
        this.notifyFinished(conversationId, gotResult, startedAt, live.lastTarget);
      }
      rec.log = compactLog(rec.log);
      this.toConversation(conversationId, { kind: 'busy', running: false }, { log: false });
      this.pushAccounts();
      this.sendConversations();
      this.persistSoon();
    }
  }

  /** Toast when a run ends while the user is looking elsewhere. */
  private notifyFinished(
    conversationId: string,
    ok: boolean,
    startedAt: number,
    target: Target | undefined,
  ): void {
    const enabled = vscode.workspace
      .getConfiguration('usturlab')
      .get<boolean>('notifyOnFinish', true);
    if (!enabled) return;
    const panel = this.panels.get(conversationId);
    if (panel?.active && vscode.window.state.focused) return;

    const title = this.conversations.get(conversationId)?.title || 'Chat';
    const secs = ((Date.now() - startedAt) / 1000).toFixed(0);
    const where = target ? ` · ${formatTarget(target)}` : '';
    const message = ok
      ? `usturlab: "${title}" finished in ${secs}s${where}`
      : `usturlab: "${title}" needs attention${where}`;
    const show = ok ? vscode.window.showInformationMessage : vscode.window.showWarningMessage;
    void show(message, 'Open').then((choice) => {
      if (choice === 'Open') this.openConversationTab(conversationId);
    });
  }

  // ── accounts ─────────────────────────────────────────────────────

  private async renameAccount(id: string): Promise<void> {
    const account = this.accounts.all().find((a) => a.id === id);
    if (!account) return;
    const label = await vscode.window.showInputBox({
      title: `usturlab: rename ${account.provider}:${account.label}`,
      value: account.label,
      prompt: 'Label used in rules and @mentions',
      validateInput: (value) => {
        const trimmed = value.trim();
        if (!trimmed) return 'Label is required';
        if (!/^[a-zA-Z0-9][\w-]*$/.test(trimmed)) {
          return 'Use letters, numbers, - or _ only';
        }
        if (
          this.accounts
            .all()
            .some((a) => a.id !== id && a.provider === account.provider && a.label === trimmed)
        ) {
          return `A ${account.provider} account labeled "${trimmed}" already exists`;
        }
        return undefined;
      },
    });
    if (!label || label.trim() === account.label) return;
    const oldLabel = account.label;
    await this.accounts.upsert({ ...account, label: label.trim() });
    void vscode.window.showInformationMessage(
      `usturlab: renamed to ${account.provider}:${label.trim()}. If your rules reference "${oldLabel}", update them.`,
    );
  }

  private async loadIdentities(): Promise<void> {
    const cliPath = vscode.workspace
      .getConfiguration('usturlab')
      .get<string>('cliPath.claude', 'claude');
    let changed = false;
    for (const account of this.accounts.all()) {
      if (this.identities.has(account.id)) continue;
      const identity = await getAccountIdentity(account, cliPath);
      if (identity) {
        this.identities.set(account.id, identity);
        changed = true;
      }
    }
    if (changed) this.pushAccounts();
  }

  /** Tightest window fill for the account a thread last used, if known. */
  private usagePctForTarget(target: Target): number | undefined {
    const account = this.accounts
      .all()
      .find((a) => a.provider === target.provider && a.label === target.account);
    if (!account) return undefined;
    const windows = this.quota.snapshot([account.id])[0]?.usage ?? [];
    return windows.length > 0 ? Math.max(...windows.map((w) => w.utilizationPct)) : undefined;
  }

  private accountUsagePct(conversationId: string): number | undefined {
    const target = this.threadContext.get(conversationId)?.lastTarget;
    return target ? this.usagePctForTarget(target) : undefined;
  }

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
          identity: this.identities.get(a.id),
          homeDir: a.homeDir,
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
  <title>usturlab</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">window.__USTURLAB_MODE__ = '${mode}';</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
