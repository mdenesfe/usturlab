import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  discoverChecks,
  selectChecks,
  summarize,
  trimOutput,
  type CheckResult,
  type RepoManifest,
  type VerifyCommand,
  type VerifyReport,
} from '@usturlab/core';

const exec = promisify(execFile);

const CHECK_TIMEOUT_MS = 180_000;
const DISCOVERY_TTL_MS = 60_000;

/**
 * Runs the project's own checks against what a model just claimed.
 *
 * The commands are never invented — only what package.json or a Makefile
 * declares is ever executed, so verification can never run something the user
 * did not already have. Nothing runs in plan mode, because a run that was not
 * allowed to change the workspace has nothing to verify.
 */
export class Verifier {
  private discovered?: { commands: VerifyCommand[]; at: number; root: string };

  constructor(private output: vscode.OutputChannel) {}

  private get root(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private readManifest(root: string): RepoManifest {
    const manifest: RepoManifest = {};
    try {
      const pkgPath = join(root, 'package.json');
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
        manifest.scripts = pkg.scripts as Record<string, string> | undefined;
        manifest.packageManager = typeof pkg.packageManager === 'string' ? pkg.packageManager : undefined;
      }
    } catch {
      // malformed package.json — nothing to discover
    }
    try {
      const makefile = join(root, 'Makefile');
      if (existsSync(makefile)) {
        manifest.makeTargets = [...readFileSync(makefile, 'utf8').matchAll(/^([\w.-]+):/gm)].map(
          (m) => m[1]!,
        );
      }
    } catch {
      // unreadable — skip
    }
    return manifest;
  }

  available(): VerifyCommand[] {
    const root = this.root;
    if (!root) return [];
    if (this.discovered && this.discovered.root === root && Date.now() - this.discovered.at < DISCOVERY_TTL_MS) {
      return this.discovered.commands;
    }
    const commands = discoverChecks(this.readManifest(root));
    this.discovered = { commands, at: Date.now(), root };
    return commands;
  }

  /** Paths with uncommitted changes — the evidence that anything happened at all. */
  async changedFiles(): Promise<string[]> {
    const root = this.root;
    if (!root) return [];
    try {
      const { stdout } = await exec('git', ['status', '--porcelain'], { cwd: root, timeout: 3000 });
      return stdout
        .split('\n')
        .map((l) => l.slice(3).trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Runs the checks worth running for this task. Returns undefined when there
   * is nothing to verify, so callers can tell "passed" from "not applicable".
   */
  async verify(
    opts: { kind?: string; complexity?: string; wroteCode: boolean; permissionMode: string },
    signal: AbortSignal,
  ): Promise<VerifyReport | undefined> {
    // Plan mode changed nothing and is not allowed to run commands.
    if (opts.permissionMode === 'safe') return undefined;
    const root = this.root;
    if (!root) return undefined;

    const commands = selectChecks(this.available(), opts);
    if (commands.length === 0) return undefined;

    const results: CheckResult[] = [];
    for (const command of commands) {
      if (signal.aborted) break;
      const [bin, ...args] = command.argv;
      if (!bin) continue;
      this.output.appendLine(`[verify] ${command.argv.join(' ')} (${command.source})`);
      try {
        await exec(bin, args, { cwd: root, timeout: CHECK_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
        results.push({ kind: command.kind, ok: true });
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string; killed?: boolean; message?: string };
        if (err.killed) {
          // A check that times out is not a verdict on the code.
          results.push({ kind: command.kind, ok: true, skipped: 'timed out' });
          continue;
        }
        results.push({
          kind: command.kind,
          ok: false,
          output: trimOutput(`${err.stdout ?? ''}\n${err.stderr ?? err.message ?? ''}`),
        });
      }
    }

    if (results.length === 0) return undefined;
    return summarize(results);
  }
}
