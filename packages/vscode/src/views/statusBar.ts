import * as vscode from 'vscode';
import { formatTarget, type Target } from '@usturlab/core';

export class RouterStatusBar implements vscode.Disposable {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.item.name = 'usturlab';
    this.item.command = 'usturlab.openInTerminal';
    this.idle();
    this.item.show();
  }

  idle(): void {
    this.item.text = '$(arrow-swap) usturlab';
    this.item.tooltip = 'usturlab — open a routed session in the terminal';
  }

  routed(target: Target): void {
    this.item.text = `$(arrow-swap) ${formatTarget(target)}`;
    this.item.tooltip = `usturlab — last routed to ${formatTarget(target)}`;
  }

  dispose(): void {
    this.item.dispose();
  }
}
