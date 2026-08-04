import * as vscode from 'vscode';
import {
  terminalEnvOverrides,
  formatTarget,
  isReviewOnly,
  type AdapterRegistry,
  type Target,
} from '@usturlab/core';
import type { AccountStore } from './storage/accountStore.js';

export async function openInTerminal(
  accounts: AccountStore,
  adapters: AdapterRegistry,
  onRouted?: (target: Target) => void,
): Promise<void> {
  // Review-only providers are an HTTP call, not a CLI — there is no session to
  // open a terminal on.
  const all = accounts.all().filter((a) => !a.disabled && !isReviewOnly(a.provider));
  if (all.length === 0) {
    void vscode.window.showWarningMessage('usturlab: no accounts yet — run "usturlab: Add Account" first.');
    return;
  }

  const pick = await vscode.window.showQuickPick(
    all
      .sort((a, b) => a.priority - b.priority)
      .map((a) => ({
        label: `${a.provider}:${a.label}`,
        description: a.authMode,
        account: a,
      })),
    { title: 'usturlab: open an interactive session', placeHolder: 'Which account?' },
  );
  if (!pick) return;

  const adapter = adapters.get(pick.account.provider);
  if (!adapter) return;

  const modelPick = await vscode.window.showQuickPick(
    [{ label: 'default model', id: undefined as string | undefined }].concat(
      adapter.models.map((m) => ({ label: m.label, id: m.id as string | undefined })),
    ),
    { title: 'usturlab: model' },
  );
  if (!modelPick) return;

  const resolved = await accounts.resolve({
    provider: pick.account.provider,
    account: pick.account.label,
  });
  if (!resolved) return;

  const { command } = adapter.interactiveCommand(resolved, modelPick.id);
  const target: Target = {
    provider: pick.account.provider,
    account: pick.account.label,
    model: modelPick.id,
  };

  const terminal = vscode.window.createTerminal({
    name: `usturlab: ${formatTarget(target)}`,
    // Overrides merge into the shell env; scrubbed vars are removed (null).
    env: terminalEnvOverrides(resolved),
    cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
  });
  terminal.show();
  terminal.sendText(command.join(' '));
  onRouted?.(target);
}
