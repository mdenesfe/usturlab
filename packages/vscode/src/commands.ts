import * as vscode from 'vscode';
import type { AdapterRegistry, QuotaTracker } from '@usrouter/core';
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
    vscode.commands.registerCommand('usrouter.addAccount', () =>
      addAccountWizard(accounts, adapters),
    ),

    vscode.commands.registerCommand('usrouter.removeAccount', async (idArg?: string) => {
      let id = idArg;
      if (!id) {
        const pick = await vscode.window.showQuickPick(
          accounts.all().map((a) => ({ label: `${a.provider}:${a.label}`, id: a.id })),
          { title: 'usrouter: remove which account?' },
        );
        id = pick?.id;
      }
      if (!id) return;
      const account = accounts.all().find((a) => a.id === id);
      if (!account) return;
      const confirmed = await vscode.window.showWarningMessage(
        `Remove ${account.provider}:${account.label}? Its stored secret is deleted; the profile directory under ~/.usrouter/profiles is kept.`,
        { modal: true },
        'Remove',
      );
      if (confirmed !== 'Remove') return;
      await accounts.remove(id);
    }),

    vscode.commands.registerCommand('usrouter.editRules', () => rules.openOrCreate()),

    vscode.commands.registerCommand('usrouter.newConversation', () => chat.newConversation()),

    vscode.commands.registerCommand('usrouter.openChatInTab', () => chat.openMostRecent()),

    vscode.commands.registerCommand('usrouter.openAccounts', () => chat.openAccountsTab()),

    vscode.commands.registerCommand('usrouter.openRules', () => chat.openRulesTab()),

    vscode.commands.registerCommand('usrouter.cancelTask', () => chat.cancelAll()),

    vscode.commands.registerCommand('usrouter.openInTerminal', () =>
      openInTerminal(accounts, adapters, (target) => statusBar.routed(target)),
    ),

    vscode.commands.registerCommand('usrouter.debug.simulateLimit', async () => {
      const pick = await vscode.window.showQuickPick(
        accounts.all().map((a) => ({ label: `${a.provider}:${a.label}`, id: a.id, provider: a.provider })),
        { title: 'usrouter: simulate a usage limit on which account?' },
      );
      if (!pick) return;
      quota.markLimitHit(pick.id, {
        resetAt: Date.now() + 60 * 60 * 1000,
        scope: 'session',
        provider: pick.provider,
      });
      void vscode.window.showInformationMessage(
        `usrouter: ${pick.label} marked as limited for 1 hour (use it to test failover).`,
      );
    }),
  );
}
