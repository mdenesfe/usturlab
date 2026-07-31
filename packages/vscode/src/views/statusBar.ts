import * as vscode from 'vscode';
import { formatTarget, type Target } from '@usrouter/core';

export class RouterStatusBar implements vscode.Disposable {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.item.name = 'usrouter';
    this.item.command = 'usrouter.openInTerminal';
    this.idle();
    this.item.show();
  }

  idle(): void {
    this.item.text = '$(arrow-swap) usrouter';
    this.item.tooltip = 'usrouter — open a routed session in the terminal';
  }

  routed(target: Target): void {
    this.item.text = `$(arrow-swap) ${formatTarget(target)}`;
    this.item.tooltip = `usrouter — last routed to ${formatTarget(target)}`;
  }

  dispose(): void {
    this.item.dispose();
  }
}
