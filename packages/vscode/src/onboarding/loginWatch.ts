import * as vscode from 'vscode';
import { existsSync } from 'node:fs';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Matches control characters on purpose: CSI sequences and OSC strings are how
// a CLI paints its login prompt, and they have to come out before the text can
// be searched for the token.
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/** Shell integration lets us read the login command's output; needs a moment to attach. */
export async function waitForShellIntegration(
  terminal: vscode.Terminal,
  timeoutMs: number,
): Promise<vscode.TerminalShellIntegration | undefined> {
  if (terminal.shellIntegration) return terminal.shellIntegration;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      sub.dispose();
      resolve(undefined);
    }, timeoutMs);
    const sub = vscode.window.onDidChangeTerminalShellIntegration((e) => {
      if (e.terminal === terminal) {
        clearTimeout(timer);
        sub.dispose();
        resolve(e.shellIntegration);
      }
    });
  });
}

/** Runs the command via shell integration and scans its live output for `pattern`. */
export async function captureOutputMatch(
  si: vscode.TerminalShellIntegration,
  command: string,
  pattern: RegExp,
  cancel: vscode.CancellationToken,
): Promise<string | undefined> {
  const execution = si.executeCommand(command);
  let buffer = '';
  for await (const chunk of execution.read()) {
    if (cancel.isCancellationRequested) return undefined;
    buffer = (buffer + stripAnsi(chunk)).slice(-16_384);
    const match = pattern.exec(buffer);
    if (match) return match[0];
  }
  return pattern.exec(buffer)?.[0];
}

export async function waitForFile(
  path: string,
  cancel: vscode.CancellationToken,
  timeoutMs: number,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs && !cancel.isCancellationRequested) {
    if (existsSync(path)) return true;
    await sleep(1500);
  }
  return false;
}

export async function pollUntil(
  check: () => Promise<boolean>,
  intervalMs: number,
  cancel: vscode.CancellationToken,
  timeoutMs: number,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs && !cancel.isCancellationRequested) {
    if (await check()) return true;
    await sleep(intervalMs);
  }
  return false;
}

export function withTimeout<T>(
  promise: Promise<T | undefined>,
  cancel: vscode.CancellationToken,
  timeoutMs: number,
): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    const sub = cancel.onCancellationRequested(() => {
      clearTimeout(timer);
      resolve(undefined);
    });
    void promise.then((value) => {
      clearTimeout(timer);
      sub.dispose();
      resolve(value);
    });
  });
}
