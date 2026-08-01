import type { ProviderId, RulesFile, SlashCommand, Target, TaskItem, ToolAction, PermissionRequest, PermissionDecision, UsageWindow, TaskMetric, Rule, RuleTarget } from '@usturlab/core';

export interface AccountStatusDto {
  id: string;
  provider: ProviderId;
  label: string;
  authMode: string;
  available: boolean;
  resetAt?: number;
  usage?: UsageWindow[];
  models: Array<{ id: string; label: string }>;
  /** Login identity (email/username) when detectable from CLI state. */
  identity?: string;
  homeDir?: string;
}

export interface ConversationMeta {
  id: string;
  title: string;
  updatedAt: number;
  running?: boolean;
}

export type WebviewToHost =
  | { kind: 'ready' }
  | {
      kind: 'send';
      text: string;
      tags: string[];
      permissionMode?: string;
      routingMode?: 'auto' | 'manual';
      attachments?: string[];
    }
  | { kind: 'pickAttachments' }
  | { kind: 'setModes'; permissionMode?: string; routingMode?: 'auto' | 'manual' }
  | { kind: 'cancel' }
  | { kind: 'newConversation' }
  | { kind: 'openConversation'; id: string }
  | { kind: 'deleteConversation'; id: string }
  | { kind: 'openAccounts' }
  | { kind: 'addAccount' }
  | { kind: 'removeAccount'; id: string }
  | { kind: 'renameAccount'; id: string }
  | { kind: 'openRules' }
  | { kind: 'editRules' }
  | { kind: 'openRulesBuilder' }
  | { kind: 'saveRule'; rule: Rule; ruleIndex?: number }
  | { kind: 'deleteRule'; ruleId: string }
  | { kind: 'reorderRules'; order: string[] }
  | { kind: 'saveDefaultChain'; chain: RuleTarget[] }
  | { kind: 'refreshUsage' }
  | { kind: 'openAnalytics' }
  | { kind: 'clearAnalytics' }
  | { kind: 'permissionDecision'; id: string; decision: PermissionDecision }
  | { kind: 'setAskPermission'; ask: boolean };

export type HostToWebview =
  | { kind: 'userEcho'; text: string }
  | { kind: 'routing'; messageId: string; target: Target; ruleId?: string; reason: string }
  | { kind: 'delta'; messageId: string; text: string }
  | {
      kind: 'toolUse';
      messageId: string;
      name: string;
      detail?: string;
      preview?: string;
      path?: string;
      action?: ToolAction;
    }
  | { kind: 'failover'; messageId: string; from: Target; to: Target; reason: string; resetAt?: number }
  | { kind: 'downgraded'; messageId: string; from: string; to: string }
  | { kind: 'notice'; text: string }
  | { kind: 'done'; messageId: string; costUsd?: number; durationMs?: number }
  | { kind: 'error'; messageId: string; message: string }
  | { kind: 'busy'; running: boolean }
  | { kind: 'accounts'; accounts: AccountStatusDto[] }
  | { kind: 'conversations'; list: ConversationMeta[]; activeId: string }
  | { kind: 'rules'; rules: RulesFile; path: string; exists: boolean; error?: string; customCommands: SlashCommand[] }
  | { kind: 'modes'; permissionMode: string; routingMode: 'auto' | 'manual'; askPermission?: boolean }
  | { kind: 'attachments'; paths: string[] }
  | { kind: 'conversationReset' }
  | { kind: 'review'; messageId: string; by: string; text: string }
  | { kind: 'tasks'; messageId: string; items: TaskItem[] }
  | { kind: 'permission'; messageId: string; request: PermissionRequest; target?: Target }
  | { kind: 'permissionResolved'; id: string; allowed: boolean }
  | { kind: 'analytics'; metrics: TaskMetric[]; accounts: AccountStatusDto[] };
