import * as vscode from 'vscode';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MCP_TEMPLATE, parseMcpFile, syncMcpToProfile } from '@usturlab/core';
import type { AdapterRegistry, QuotaTracker } from '@usturlab/core';
import type { AccountStore } from './storage/accountStore.js';
import type { RulesManager } from './rules/rulesFile.js';
import type { ChatViewProvider } from './panel/chatViewProvider.js';
import type { RouterStatusBar } from './views/statusBar.js';
import { addAccountWizard } from './onboarding/addAccount.js';
import { openInTerminal } from './terminalMode.js';

export function registerCommands(
  ctx: vscode.ExtensionContext,
  deps: {
    accounts: AccountStore;
    adapters: AdapterRegistry;
    quota: QuotaTracker;
    rules: RulesManager;
    chat: ChatViewProvider;
    statusBar: RouterStatusBar;
  },
): void {
  const { accounts, adapters, quota, rules, chat, statusBar } = deps;

  ctx.subscriptions.push(
    vscode.commands.registerCommand('usturlab.addAccount', () =>
      addAccountWizard(accounts, adapters),
    ),

    vscode.commands.registerCommand('usturlab.removeAccount', async (idArg?: string) => {
      let id = idArg;
      if (!id) {
        const pick = await vscode.window.showQuickPick(
          accounts.all().map((a) => ({ label: `${a.provider}:${a.label}`, id: a.id })),
          { title: 'usturlab: remove which account?' },
        );
        id = pick?.id;
      }
      if (!id) return;
      const account = accounts.all().find((a) => a.id === id);
      if (!account) return;
      const confirmed = await vscode.window.showWarningMessage(
        `Remove ${account.provider}:${account.label}? Its stored secret is deleted; the profile directory under ~/.usturlab/profiles is kept.`,
        { modal: true },
        'Remove',
      );
      if (confirmed !== 'Remove') return;
      await accounts.remove(id);
    }),

    vscode.commands.registerCommand('usturlab.editRules', () => rules.openOrCreate()),

    // Kept as an alias: the builder and the rules tab are one screen now.
    vscode.commands.registerCommand('usturlab.openRulesBuilder', () => chat.openRulesTab()),

    vscode.commands.registerCommand('usturlab.editCommands', () => rules.openOrCreateCommands()),

    vscode.commands.registerCommand('usturlab.syncMcp', async () => {
      const ws = vscode.workspace.workspaceFolders?.[0];
      const candidates = [
        ws ? join(ws.uri.fsPath, '.usturlab', 'mcp.json') : undefined,
        join(homedir(), '.usturlab', 'mcp.json'),
      ].filter((c): c is string => !!c);
      const path = candidates.find((c) => existsSync(c));
      if (!path) {
        const create = await vscode.window.showInformationMessage(
          'usturlab: no MCP definition file yet. Define servers once — usturlab syncs them into every provider profile.',
          'Create mcp.json',
        );
        if (create) {
          const target = vscode.Uri.file(candidates[0]!);
          await vscode.workspace.fs.writeFile(target, Buffer.from(MCP_TEMPLATE, 'utf8'));
          await vscode.window.showTextDocument(target);
        }
        return;
      }
      const parsed = parseMcpFile(readFileSync(path, 'utf8'));
      if (!parsed.ok) {
        void vscode.window.showErrorMessage(`usturlab: mcp.json invalid — ${parsed.error}`);
        return;
      }
      const names = Object.keys(parsed.servers);
      if (names.length === 0) {
        void vscode.window.showWarningMessage('usturlab: mcp.json defines no servers.');
        return;
      }
      const results = accounts.all().map((account) => {
        const error = syncMcpToProfile(account, parsed.servers);
        return `${account.provider}:${account.label} ${error ? `✗ (${error})` : '✓'}`;
      });
      void vscode.window.showInformationMessage(
        `usturlab: synced ${names.length} MCP server(s) → ${results.join(' · ')}. They load on each account's next run.`,
      );
    }),

    vscode.commands.registerCommand('usturlab.newConversation', () => chat.newConversation()),

    vscode.commands.registerCommand('usturlab.openChatInTab', () => chat.openMostRecent()),

    vscode.commands.registerCommand('usturlab.openAccounts', () => chat.openAccountsTab()),

    vscode.commands.registerCommand('usturlab.openRules', () => chat.openRulesTab()),

    vscode.commands.registerCommand('usturlab.openAnalytics', () => chat.openAnalyticsTab()),
    vscode.commands.registerCommand('usturlab.toggleAsk', async () => {
      const config = vscode.workspace.getConfiguration('usturlab');
      const next = !config.get<boolean>('askPermission', false);
      await config.update('askPermission', next, vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage(
        next
          ? 'usturlab will ask before each command or file change.'
          : 'usturlab will decide from the permission mode again.',
      );
    }),

    vscode.commands.registerCommand('usturlab.cancelTask', () => chat.cancelAll()),

    vscode.commands.registerCommand('usturlab.openInTerminal', () =>
      openInTerminal(accounts, adapters, (target) => statusBar.routed(target)),
    ),

    vscode.commands.registerCommand('usturlab.debug.simulateLimit', async () => {
      const pick = await vscode.window.showQuickPick(
        accounts.all().map((a) => ({ label: `${a.provider}:${a.label}`, id: a.id, provider: a.provider })),
        { title: 'usturlab: simulate a usage limit on which account?' },
      );
      if (!pick) return;
      quota.markLimitHit(pick.id, {
        resetAt: Date.now() + 60 * 60 * 1000,
        scope: 'session',
        provider: pick.provider,
      });
      void vscode.window.showInformationMessage(
        `usturlab: ${pick.label} marked as limited for 1 hour (use it to test failover).`,
      );
    }),
  );
}
