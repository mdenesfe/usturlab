import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
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
  accountHeadroom,
  assessThread,
  describeReport,
  isMetered,
  repairPrompt,
  pickReviewer,
  reviewPrompt,
  revisionPrompt,
  isClean,
  isReviewOnly,
  parsePlan,
  type PermissionDecision,
  type PermissionRequest,
  pickExecutor,
  executePrompt,
  executorTier,
  AUTO_TIER_MODELS,
  type ConversationContext,
  type LiveRunHandle,
  type PermissionMode,
  type Target,
  type TaskMetric,
} from '@usturlab/core';
import type { AccountStore } from '../storage/accountStore.js';
import type { MetricsStore } from '../storage/metricsStore.js';
import type { PreferenceStore } from '../storage/preferenceStore.js';
import type { WorkspaceContext } from '../context/workspaceContext.js';
import type { Verifier } from '../verify/verifier.js';
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
  // A lane's opening and its verdict are worth keeping; the progress ticks in
  // between are live-only and would bloat every stored conversation.
  'agentStart',
  'agentEnd',
  'downgraded',
  'notice',
  'failover',
  'review',
  'tasks',
  'permission',
  'permissionResolved',
  'done',
  'stopped',
  'error',
]);

/** `#hashtags` become routing tags — the same thing the panel derives on send. */
function tagsOf(text: string): string[] {
  return [...text.matchAll(/(^|\s)#([\w-]+)/g)].map((m) => m[2]!);
}

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
  mode: 'sidebar' | 'tab' | 'accounts' | 'rules' | 'analytics';
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
  /** Same list, docked in the secondary side bar (top right) instead. */
  static readonly secondaryViewType = 'usturlab.chatSecondary';

  private surfaces = new Map<vscode.Webview, Surface>();
  private panels = new Map<string, vscode.WebviewPanel>();
  private accountsPanel?: vscode.WebviewPanel;
  private rulesPanel?: vscode.WebviewPanel;
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
  /** Claude's bridge answers arrive outside any adapter, so they wait here. */
  private pendingBridge = new Map<string, (decision: PermissionDecision) => void>();
  private threadContext = new Map<
    string,
    {
      lastTarget?: Target;
      /** Complexity of the last few turns, newest first — a window, not a peak. */
      recentComplexity?: string[];
      /** Task kind of the most recent turn, for attributing a correction. */
      lastKind?: string;
      turnCount: number;
      /** Last finished run, so a quick re-ask can be attributed back to it. */
      lastPrompt?: string;
      lastFinishedAt?: number;
      lastMetricId?: string;
      /**
       * Everything the last run read. This is the size of what another account
       * would have to rebuild from cold, so it is what makes moving expensive.
       */
      lastContextTokens?: number;
      /** Files this thread has touched, and what last went wrong — brief material. */
      touchedFiles?: string[];
      lastFailure?: string;
      /** Evidence the thread is circling: runs steered, checks left red. */
      corrections?: number;
      failedVerifications?: number;
    }
  >();
  /** Threads already told they are crowded — said once, not every turn. */
  private crowdedThreads = new Set<string>();

  constructor(
    private ctx: vscode.ExtensionContext,
    private orchestrator: Orchestrator,
    private sessions: SessionStore,
    private accounts: AccountStore,
    private quota: QuotaTracker,
    private adapters: AdapterRegistry,
    private rules: RulesManager,
    private metrics: MetricsStore,
    private preferences: PreferenceStore,
    private workspaceContext: WorkspaceContext,
    private verifier: Verifier,
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

  /** True when this account pays per token, so a reported cost is real money. */
  private isMetered(target: Target | undefined): boolean {
    if (!target) return false;
    const profile = this.accounts
      .all()
      .find((a) => a.provider === target.provider && a.label === target.account);
    return profile ? isMetered(profile) : false;
  }

  /** What this thread has already done, for the workspace brief. */
  threadFiles(conversationId: string): { touchedFiles?: string[]; lastFailure?: string } {
    const ctx = this.threadContext.get(conversationId);
    return { touchedFiles: ctx?.touchedFiles, lastFailure: ctx?.lastFailure };
  }

  /**
   * Say once, when the evidence is there, that this chat is now working against
   * itself. It is advice, not a mode: the user keeps typing either way.
   */
  private warnIfCrowded(
    conversationId: string,
    ctx: { turnCount: number; corrections?: number; failedVerifications?: number },
    post: (msg: HostToWebview) => void,
  ): void {
    if (this.crowdedThreads.has(conversationId)) return;
    const verdict = assessThread({
      turnCount: ctx.turnCount,
      corrections: ctx.corrections ?? 0,
      failedVerifications: ctx.failedVerifications ?? 0,
    });
    if (!verdict.crowded) return;
    this.crowdedThreads.add(conversationId);
    post({ kind: 'notice', text: `${verdict.reason} — ${verdict.advice}` });
  }

  /** Conversation memory for the router: same thread → same model unless work escalates. */
  conversationContext(conversationId: string): ConversationContext | undefined {
    const ctx = this.threadContext.get(conversationId);
    if (!ctx) return undefined;
    return {
      lastTarget: ctx.lastTarget,
      recentComplexity: ctx.recentComplexity as ConversationContext['recentComplexity'],
      turnCount: ctx.turnCount,
      // How warm that target still is, and how much a move would cost.
      lastRunAt: ctx.lastFinishedAt,
      lastContextTokens: ctx.lastContextTokens,
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
    'rules',
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
      askPermission: config.get<boolean>('askPermission', false),
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
    // A cleared chat is the fresh start the warning asked for.
    this.crowdedThreads.delete(id);
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
      this.markStopped(id, 'stopped');
      this.toConversation(id, { kind: 'busy', running: false }, { log: false });
    }
    this.tasks.clear();
    this.sendConversations();
  }

  /**
   * Closes off whatever was streaming. A cancelled run never reaches `result`,
   * so nothing else ever marks that turn finished: the answer would keep a
   * blinking cursor and its agents would look like they were still working,
   * every time the conversation is reopened.
   */
  private markStopped(conversationId: string, reason?: string): void {
    const live = this.liveRuns.get(conversationId);
    const messageId = live?.messageIds[Math.min(live.turnIdx, live.messageIds.length - 1)];
    if (!messageId) return;
    this.toConversation(conversationId, { kind: 'stopped', messageId, reason });
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
      // The rule editor picks targets from the accounts that actually exist.
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
      case 'permissionDecision':
        // The surface knows which conversation it belongs to; the webview
        // never has to track it.
        if (surface.conversationId) {
          this.answerPermission(surface.conversationId, msg.id, msg.decision);
        }
        return;
      case 'setAskPermission':
        await vscode.workspace
          .getConfiguration('usturlab')
          .update('askPermission', msg.ask, vscode.ConfigurationTarget.Global);
        // Every open surface reflects the switch, not just the one clicked.
        for (const [w] of this.surfaces) this.safePost(w, this.modesMessage());
        return;
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
          this.markStopped(surface.conversationId, 'stopped by you');
          this.toConversation(surface.conversationId, { kind: 'busy', running: false }, { log: false });
          this.sendConversations();
        }
        break;
      case 'retryLast':
        if (surface.conversationId) void this.retryLast(surface.conversationId);
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
        // A message sent into a running task is a correction; repeated ones
        // become standing rules the user can accept.
        void this.preferences.recordCorrection({
          text,
          timestamp: Date.now(),
          provider: live.lastTarget?.provider ?? 'unknown',
          kind: this.threadContext.get(conversationId)?.lastKind,
        });
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
        this.markStopped(conversationId, 'restarted with your new message');
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
   * Sends the last thing the user asked for again. The text comes from the
   * host's own record rather than the panel, so a retry after a failure asks
   * for exactly what was asked before — and it routes fresh, which is the
   * point: the account that just failed is on cooldown and gets skipped.
   */
  private async retryLast(conversationId: string): Promise<void> {
    if (this.tasks.has(conversationId)) return;
    const rec = this.conversations.get(conversationId);
    const last = [...(rec?.turns ?? [])].reverse().find((turn) => turn.role === 'user');
    const text = last?.text?.trim();
    if (!text) return;
    await this.handleSend(conversationId, text, tagsOf(text));
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

    // Snapshot the workspace before the run so the brief describes where the
    // user actually is, not where they were when the panel opened.
    await this.workspaceContext.refresh();
    const filesBefore = new Set(await this.verifier.changedFiles());

    const messageId = shortId();
    const startedAt = Date.now();
    let gotResult = false;
    let escalated = false;
    let briefLineIds: string[] | undefined;
    let answerText = '';
    let autoPlanned = false;
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
              tier: ev.decision.tier,
              effort: ev.decision.effort,
              routingReason: ev.decision.reason,
              ruleId: ev.decision.ruleId,
            };
            if (cls?.complexity) {
              const ctx = this.threadContext.get(conversationId) ?? { turnCount: 0 };
              // Newest first, and only the last few kept: the router sizes a
              // turn from what the thread has been doing lately, not from the
              // heaviest thing it ever did.
              ctx.recentComplexity = [cls.complexity, ...(ctx.recentComplexity ?? [])].slice(0, 4);
              ctx.lastKind = cls.kind;
              this.threadContext.set(conversationId, ctx);
            }
            autoPlanned = ev.decision.suggestPermission === 'safe';
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
            post({
              kind: 'toolUse',
              messageId: currentId(),
              name: ev.name,
              detail: ev.detail,
              preview: ev.preview,
              path: ev.path,
              action: ev.action,
              agentId: ev.agentId,
            });
            break;
          case 'agent-start':
            post({
              kind: 'agentStart',
              messageId: currentId(),
              id: ev.id,
              label: ev.label,
              agentKind: ev.agentKind,
              prompt: ev.prompt,
              background: ev.background,
            });
            break;
          case 'agent-progress':
            post({
              kind: 'agentProgress',
              messageId: currentId(),
              id: ev.id,
              activity: ev.activity,
              lastTool: ev.lastTool,
              toolUses: ev.toolUses,
              tokens: ev.tokens,
              durationMs: ev.durationMs,
            });
            break;
          case 'agent-end':
            post({
              kind: 'agentEnd',
              messageId: currentId(),
              id: ev.id,
              status: ev.status,
              summary: ev.summary,
              toolUses: ev.toolUses,
              tokens: ev.tokens,
              durationMs: ev.durationMs,
            });
            break;
          case 'model-downgraded':
            post({ kind: 'downgraded', messageId: currentId(), from: ev.from, to: ev.to });
            // Whatever the CLI picked for itself, we no longer know its weight
            // class — so this run is not evidence about one. Clearing the tier
            // keeps it out of the per-tier capability probes instead of filing
            // it under a tier it may not have run on.
            metric.model = undefined;
            metric.tier = undefined;
            metric.effort = undefined;
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
                tier: metric.tier,
                effort: metric.effort,
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
          case 'brief':
            briefLineIds = ev.lineIds;
            break;
          case 'tasks':
            post({ kind: 'tasks', messageId: currentId(), items: ev.items });
            break;
          case 'permission':
            // The CLI is blocked until the user answers, so this cannot be a
            // toast that scrolls away — it goes into the transcript.
            post({
              kind: 'permission',
              messageId: currentId(),
              request: ev.request,
              target: live.lastTarget,
            });
            this.notifyPermission(conversationId, ev.request);
            break;
          case 'permission-resolved':
            post({ kind: 'permissionResolved', id: ev.id, allowed: ev.allowed });
            break;
          case 'result': {
            answerText = ev.text;
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
            // Whether that dollar figure is a bill or a hypothetical depends on
            // how the account authenticates, which only the host knows.
            const metered = this.isMetered(live.lastTarget);
            metric = {
              ...metric,
              inputTokens: ev.usage?.inputTokens,
              outputTokens: ev.usage?.outputTokens,
              cachedInputTokens: ev.usage?.cachedInputTokens,
              costUsd: ev.costUsd,
              metered,
              durationMs,
              status: 'success',
            };
            post({
              kind: 'done',
              messageId: currentId(),
              costUsd: ev.costUsd,
              metered,
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
      // The run produced an answer; now find out whether it is true.
      if (gotResult && !controller.signal.aborted) {
        const outcome = await this.checkAndImprove({
          conversationId,
          task: text,
          answer: answerText,
          target: live.lastTarget,
          kind: metric.kind,
          complexity: metric.complexity,
          permissionMode,
          filesBefore,
          post,
          messageId: currentId(),
          signal: controller.signal,
        });
        metric = { ...metric, verified: outcome.verified, reviewedBy: outcome.reviewedBy };
      }
    } catch (e) {
      metric = { ...metric, status: 'error', errorMessage: (e as Error).message };
      post({ kind: 'error', messageId: currentId(), message: (e as Error).message });
      this.output.appendLine(`[error] ${(e as Error).stack ?? e}`);
      const ctx = this.threadContext.get(conversationId) ?? { turnCount: 0 };
      ctx.lastFailure = (e as Error).message.slice(0, 300);
      this.threadContext.set(conversationId, ctx);
    } finally {
      const steered = this.steeredRuns.delete(conversationId);
      if (metric.status && metric.provider && metric.account) {
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
          tier: metric.tier,
          effort: metric.effort,
          inputTokens: metric.inputTokens,
          outputTokens: metric.outputTokens,
          cachedInputTokens: metric.cachedInputTokens,
          costUsd: metric.costUsd,
          metered: metric.metered,
          durationMs: metric.durationMs,
          burnPct: observedBurn(usageBefore, usageAfter),
          status: metric.status as 'success' | 'error' | 'failover',
          errorMessage: metric.errorMessage,
          transient: metric.transient,
          failedFrom: metric.failedFrom,
          failoverReason: metric.failoverReason,
          steered,
          escalated,
          briefLineIds,
          verified: metric.verified,
          reviewedBy: metric.reviewedBy,
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
        // Keep the last known figure when a run did not report one — a silent
        // turn does not mean the conversation suddenly became free to move.
        if (metric.inputTokens) ctx.lastContextTokens = metric.inputTokens;
        if (steered) ctx.corrections = (ctx.corrections ?? 0) + 1;
        if (metric.verified === 'failed') {
          ctx.failedVerifications = (ctx.failedVerifications ?? 0) + 1;
        }
        this.threadContext.set(conversationId, ctx);
        this.warnIfCrowded(conversationId, ctx, post);
      }
      if (this.tasks.get(conversationId) === controller) this.tasks.delete(conversationId);
      if (this.liveRuns.get(conversationId) === live) this.liveRuns.delete(conversationId);
      if (!controller.signal.aborted) {
        this.notifyFinished(conversationId, gotResult, startedAt, live.lastTarget);
      }
      // Asked between runs, never during one.
      if (autoPlanned && gotResult && live.lastTarget && !controller.signal.aborted) {
        void this.offerPlanExecution(conversationId, text, answerText, live.lastTarget);
      } else {
        void this.preferences.offerTopSuggestion();
      }
      rec.log = compactLog(rec.log);
      this.toConversation(conversationId, { kind: 'busy', running: false }, { log: false });
      this.pushAccounts();
      this.sendConversations();
      this.persistSoon();
    }
  }

  /**
   * After an answer arrives: check it against reality, let the model fix what
   * the checks caught, and — for hard work — have a different provider look
   * for what the checks cannot see.
   *
   * Every step is skippable and none of them may block the user seeing the
   * answer: the answer is already on screen when this runs.
   */
  private async checkAndImprove(args: {
    conversationId: string;
    task: string;
    answer: string;
    target?: Target;
    kind?: string;
    complexity?: string;
    permissionMode: PermissionMode;
    filesBefore: Set<string>;
    post: (msg: HostToWebview) => void;
    messageId: string;
    signal: AbortSignal;
  }): Promise<{ verified?: 'passed' | 'repaired' | 'failed'; reviewedBy?: string }> {
    const config = vscode.workspace.getConfiguration('usturlab');
    const outcome: { verified?: 'passed' | 'repaired' | 'failed'; reviewedBy?: string } = {};
    if (!args.target) return outcome;

    const changedNow = await this.verifier.changedFiles();
    const touched = changedNow.filter((f) => !args.filesBefore.has(f));
    if (touched.length > 0) {
      const ctx = this.threadContext.get(args.conversationId) ?? { turnCount: 0 };
      ctx.touchedFiles = [...new Set([...(ctx.touchedFiles ?? []), ...touched])].slice(-20);
      this.threadContext.set(args.conversationId, ctx);
    }

    // ── verification ────────────────────────────────────────
    if (config.get<boolean>('verifyChanges', true) && !args.signal.aborted) {
      const report = await this.verifier.verify(
        {
          kind: args.kind,
          complexity: args.complexity,
          wroteCode: touched.length > 0,
          permissionMode: args.permissionMode,
        },
        args.signal,
      );
      if (report) {
        if (report.ok) {
          outcome.verified = 'passed';
          args.post({ kind: 'notice', text: `verified — ${describeReport(report)}` });
        } else {
          args.post({
            kind: 'notice',
            text: `${describeReport(report)} — asking ${formatTarget(args.target)} to fix it`,
          });
          const repaired = await this.followUp(
            args.conversationId,
            repairPrompt(report, touched),
            args.target,
            args.messageId,
            args.signal,
          );
          if (repaired) {
            const recheck = await this.verifier.verify(
              {
                kind: args.kind,
                complexity: args.complexity,
                wroteCode: true,
                permissionMode: args.permissionMode,
              },
              args.signal,
            );
            outcome.verified = !recheck || recheck.ok ? 'repaired' : 'failed';
            args.post({
              kind: 'notice',
              text:
                outcome.verified === 'repaired'
                  ? 'fixed itself — checks pass now'
                  : 'still failing after one repair attempt; over to you',
            });
          } else {
            outcome.verified = 'failed';
          }
          if (outcome.verified === 'failed') {
            const ctx = this.threadContext.get(args.conversationId) ?? { turnCount: 0 };
            ctx.lastFailure = report.failureText?.slice(0, 300);
            this.threadContext.set(args.conversationId, ctx);
          }
        }
      }
    }

    // ── second opinion ──────────────────────────────────────
    const policy = config.get<'never' | 'hard' | 'always'>('secondOpinion', 'hard');
    if (policy === 'never' || args.signal.aborted) return outcome;

    const headroom: Record<string, number> = {};
    for (const account of this.accounts.all()) {
      headroom[`${account.provider}:${account.label}`] = accountHeadroom(account.id, this.quota);
    }
    const candidates: Target[] = this.accounts
      .all()
      .filter((a) => !a.disabled)
      .map((a) => ({ provider: a.provider, account: a.label }));

    const reviewer = pickReviewer({
      author: args.target,
      candidates,
      classification: {
        kind: (args.kind ?? 'edit') as never,
        complexity: (args.complexity ?? 'moderate') as never,
        writesCode: touched.length > 0,
        signals: [],
      },
      headroom,
      policy,
    });
    if (!reviewer) return outcome;

    args.post({ kind: 'notice', text: reviewer.reason });
    const diff = touched.length > 0 ? await this.diffFor(touched) : undefined;
    const review = await this.askOffThread(
      reviewer.target,
      reviewPrompt({
        task: args.task,
        answer: args.answer,
        diff,
        authorProvider: args.target.provider,
      }),
      args.signal,
    );
    if (!review) return outcome;
    outcome.reviewedBy = `${reviewer.target.provider}:${reviewer.target.account}`;

    if (isClean(review)) {
      args.post({ kind: 'notice', text: `${outcome.reviewedBy} found no problems` });
      return outcome;
    }
    args.post({ kind: 'review', messageId: args.messageId, by: outcome.reviewedBy, text: review });
    await this.followUp(
      args.conversationId,
      revisionPrompt(review),
      args.target,
      args.messageId,
      args.signal,
    );
    return outcome;
  }

  /**
   * The other half of auto-plan: a plan specific enough to follow does not
   * need the model that wrote it. Authoring the plan was the hard part — the
   * typing can go to a cheaper account, which is the whole reason to own
   * several subscriptions.
   */
  private async offerPlanExecution(
    conversationId: string,
    task: string,
    planText: string,
    planner: Target,
  ): Promise<void> {
    const plan = parsePlan(planText);
    if (!plan.executable) return;

    const headroom: Record<string, number> = {};
    for (const account of this.accounts.all()) {
      headroom[`${account.provider}:${account.label}`] = accountHeadroom(account.id, this.quota);
    }
    const candidates: Target[] = this.accounts
      .all()
      .filter((a) => !a.disabled)
      .sort((a, b) => a.priority - b.priority)
      .map((a) => ({ provider: a.provider, account: a.label }));

    const executor = pickExecutor(planner, candidates, headroom);
    if (!executor) return;

    const tier = executorTier('heavy');
    const target: Target = { ...executor, model: AUTO_TIER_MODELS[executor.provider][tier] };
    const label = formatTarget(target);
    const choice = await vscode.window.showInformationMessage(
      `${plan.steps.length}-step plan ready. Carry it out on ${label} and keep ${formatTarget(planner)} free?`,
      'Run it',
      'Not now',
    );
    if (choice !== 'Run it') return;

    // An @mention is how the router is told to obey; it is stripped before the
    // model sees the prompt, so no plumbing is needed to force the target.
    const mention = `@${target.provider}:${target.account}${target.model ? `/${target.model}` : ''}`;
    await this.runTask(
      conversationId,
      `${mention} ${executePrompt(task, plan, formatTarget(planner))}`,
      [],
      {
        permissionMode: vscode.workspace
          .getConfiguration('usturlab')
          .get<PermissionMode>('permissionMode', 'edits'),
      },
    );
  }

  /** `git diff` for the files a run touched, budgeted for a prompt. */
  private async diffFor(files: string[]): Promise<string | undefined> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) return undefined;
    return new Promise((resolve) => {
      execFile(
        'git',
        ['diff', '--', ...files.slice(0, 20)],
        { cwd, timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => resolve(err || !stdout.trim() ? undefined : stdout.slice(0, 12_000)),
      );
    });
  }

  /**
   * Continues the same conversation on the same account — the model keeps its
   * session, so a repair or revision costs one turn, not a fresh context.
   */
  private async followUp(
    conversationId: string,
    prompt: string,
    target: Target,
    messageId: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const text = await this.askOffThread(target, prompt, signal, conversationId);
    if (!text) return false;
    this.toConversation(conversationId, { kind: 'delta', messageId, text: `\n\n${text}` });
    return true;
  }

  /**
   * One-shot request to a specific account, outside the visible turn loop.
   * Reuses the conversation's session when one is given so the model has the
   * context; otherwise it is a clean, cheap ask.
   */
  private async askOffThread(
    target: Target,
    prompt: string,
    signal: AbortSignal,
    conversationId?: string,
  ): Promise<string | undefined> {
    const adapter = this.adapters.get(target.provider);
    if (!adapter) return undefined;
    const account = await this.accounts.resolve(target);
    if (!account) return undefined;
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? homedir();
    const resumeSessionId =
      conversationId && adapter.supportsNativeResume
        ? this.sessions.getNativeSession(conversationId, target, cwd)
        : undefined;

    try {
      let text = '';
      for await (const ev of adapter.run(
        {
          prompt,
          cwd,
          model: target.model,
          resumeSessionId,
          // A reviewer must never edit; a repair runs under the user's own mode.
          permissionMode: conversationId
            ? vscode.workspace
                .getConfiguration('usturlab')
                .get<PermissionMode>('permissionMode', 'safe')
            : 'safe',
        },
        account,
        signal,
      )) {
        if (signal.aborted) return undefined;
        if (ev.type === 'result') text = ev.text;
        if (ev.type === 'limit') {
          // A free reviewer runs out most days. Park the account so the next
          // task picks a different one instead of paying for the round trip.
          this.quota.markLimitHit(account.id, {
            resetAt: ev.resetAt,
            scope: ev.scope,
            provider: target.provider,
          });
          return undefined;
        }
        if (ev.type === 'error') return undefined;
      }
      return text.trim() || undefined;
    } catch (e) {
      this.output.appendLine(`[off-thread] ${formatTarget(target)}: ${(e as Error).message}`);
      return undefined;
    }
  }

  /**
   * A blocked run is worth a notification: the model is idle until the user
   * answers, and the tab may not even be visible. Answering from the toast
   * saves a trip back to the panel.
   */
  private notifyPermission(conversationId: string, request: PermissionRequest): void {
    if (this.isVisible(conversationId)) return;
    const title = request.title.length > 70 ? request.title.slice(0, 70) + '…' : request.title;
    void vscode.window
      .showWarningMessage(`usturlab is waiting: ${title}`, 'Allow', 'Allow always', 'Deny')
      .then((choice) => {
        if (!choice) return;
        const decision: PermissionDecision =
          choice === 'Deny'
            ? { outcome: 'deny' }
            : choice === 'Allow always'
              ? { outcome: 'allow-always' }
              : { outcome: 'allow' };
        this.answerPermission(conversationId, request.id, decision);
      });
  }

  /** Releases the waiting CLI with the user's answer. */
  answerPermission(conversationId: string, id: string, decision: PermissionDecision): void {
    const live = this.liveRuns.get(conversationId);
    if (live?.handle.respondPermission) {
      live.handle.respondPermission(id, decision);
      return;
    }
    // Claude's prompt runs through the bridge, which is not tied to a run.
    this.pendingBridge.get(id)?.(decision);
    this.pendingBridge.delete(id);
  }

  /** Claude asks through the MCP bridge, outside the adapter event stream. */
  async askViaBridge(request: PermissionRequest): Promise<PermissionDecision> {
    const conversationId = this.activeConversationId();
    if (!conversationId) return { outcome: 'deny', reason: 'no active conversation' };
    const live = this.liveRuns.get(conversationId);
    this.toConversation(conversationId, {
      kind: 'permission',
      messageId: live?.messageIds[live.turnIdx] ?? shortId(),
      request,
      target: live?.lastTarget,
    });
    this.notifyPermission(conversationId, request);
    const decision = await new Promise<PermissionDecision>((resolve) => {
      this.pendingBridge.set(request.id, resolve);
    });
    this.toConversation(conversationId, {
      kind: 'permissionResolved',
      id: request.id,
      allowed: decision.outcome !== 'deny',
    });
    return decision;
  }

  /** The conversation a bridge request belongs to: the one currently running. */
  private activeConversationId(): string | undefined {
    for (const [id] of this.tasks) return id;
    return undefined;
  }

  private isVisible(conversationId: string): boolean {
    return this.panels.get(conversationId)?.active === true;
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
          reviewOnly: isReviewOnly(a.provider),
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
