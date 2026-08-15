import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import {
  briefSections,
  classifyTask,
  describeChecks,
  selectChecks,
  shapeTask,
  type BriefSection,
  type ConventionSource,
  type EditorContext,
  type ProviderId,
  type RepoContext,
  type TaskRequest,
  type VerifyCommand,
} from '@usturlab/core';

const exec = promisify(execFile);

/**
 * Gathers the things the model would have known if it were sitting where the
 * user is: the file in front of them, what they highlighted, what the repo
 * currently looks like, and the conventions the project wrote down.
 *
 * Everything here is best-effort and cached — a slow or failing git call must
 * never delay a run, it just means that section is missing from the brief.
 */

/** Convention files, in the order they are worth reading. */
const CONVENTION_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  '.cursorrules',
  '.github/copilot-instructions.md',
  '.usturlab/conventions.md',
];

const GIT_TIMEOUT_MS = 1500;
const CONVENTION_TTL_MS = 30_000;
const MAX_DIFF_CHARS = 4000;

interface Cached<T> {
  value: T;
  at: number;
}

export class WorkspaceContext {
  private conventionCache?: Cached<ConventionSource[]>;
  private repoCache?: Cached<RepoContext>;

  constructor(private output: vscode.OutputChannel) {}

  private get root(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  /** What the user is looking at right now — the most perishable, most useful part. */
  editorContext(): EditorContext {
    const root = this.root;
    const editor = vscode.window.activeTextEditor;
    const rel = (uri: vscode.Uri) => (root ? relative(root, uri.fsPath) : uri.fsPath);

    const context: EditorContext = {};
    if (editor && editor.document.uri.scheme === 'file') {
      context.activeFile = rel(editor.document.uri);
      context.languageId = editor.document.languageId;
      const selection = editor.selection;
      if (!selection.isEmpty) {
        const text = editor.document.getText(selection);
        // A whole-file "select all" says nothing; a real highlight says a lot.
        if (text.length < 4000) {
          context.selection = text;
          context.selectionRange = {
            start: selection.start.line + 1,
            end: selection.end.line + 1,
          };
        }
      }
    }

    const open = vscode.workspace.textDocuments
      .filter((d) => d.uri.scheme === 'file' && !d.isClosed)
      .map((d) => rel(d.uri))
      .filter((p) => p && p !== context.activeFile && !p.startsWith('..'));
    if (open.length > 0) context.openFiles = [...new Set(open)].slice(0, 8);

    return context;
  }

  /** Branch, uncommitted files, and the diff when it is small enough to be useful. */
  async repoContext(): Promise<RepoContext> {
    const root = this.root;
    if (!root) return {};
    if (this.repoCache && Date.now() - this.repoCache.at < 3000) return this.repoCache.value;

    const git = async (args: string[]): Promise<string> => {
      try {
        const { stdout } = await exec('git', args, { cwd: root, timeout: GIT_TIMEOUT_MS });
        return stdout;
      } catch {
        return '';
      }
    };

    const [branch, status, diff] = await Promise.all([
      git(['rev-parse', '--abbrev-ref', 'HEAD']),
      git(['status', '--porcelain']),
      git(['diff', '--stat']),
    ]);

    const value: RepoContext = {};
    if (branch.trim()) value.branch = branch.trim();
    const changed = status
      .split('\n')
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
    if (changed.length > 0) value.changedFiles = changed;
    // The stat, not the patch: the shape of the change is what orients a model,
    // and the full patch would eat the whole budget on a busy tree.
    if (diff.trim() && diff.length < MAX_DIFF_CHARS) value.diff = diff.trim();

    this.repoCache = { value, at: Date.now() };
    return value;
  }

  /** Convention files the project wrote for agents, whichever flavour they used. */
  conventions(): ConventionSource[] {
    const root = this.root;
    if (!root) return [];
    if (this.conventionCache && Date.now() - this.conventionCache.at < CONVENTION_TTL_MS) {
      return this.conventionCache.value;
    }

    const found: ConventionSource[] = [];
    const seen = new Set<string>();
    for (const name of CONVENTION_FILES) {
      const path = join(root, name);
      if (!existsSync(path)) continue;
      try {
        const text = readFileSync(path, 'utf8');
        // Several of these files are usually copies of each other; the first
        // one wins and the duplicates are dropped rather than sent twice.
        const fingerprint = text.trim().slice(0, 400);
        if (seen.has(fingerprint)) continue;
        seen.add(fingerprint);
        found.push({ path: name, text });
      } catch {
        // unreadable — skip
      }
    }

    this.conventionCache = { value: found, at: Date.now() };
    return found;
  }

  /**
   * The brief is built synchronously at send time from a snapshot refreshed
   * just before the run, so a slow git call can never stall the request.
   */
  private snapshot: { editor: EditorContext; repo: RepoContext } = { editor: {}, repo: {} };

  async refresh(): Promise<void> {
    this.snapshot = { editor: this.editorContext(), repo: await this.repoContext() };
  }

  /**
   * How this request should be approached, including the exact check that will
   * be run against it afterwards. The classification is recomputed here rather
   * than threaded through the orchestrator: it is pure and cheap, and the brief
   * must not depend on routing having happened first.
   */
  private shapingFor(task: TaskRequest, checks: VerifyCommand[]): string[] {
    const classification = classifyTask(task);
    const selected = selectChecks(checks, {
      kind: classification.kind,
      complexity: classification.complexity,
      wroteCode: classification.writesCode,
    });
    return shapeTask({
      prompt: task.prompt,
      classification,
      check: describeChecks(selected),
      activeFile: this.snapshot.editor.activeFile,
      permissionMode: task.permissionMode,
    }).map((line) => line.text);
  }

  buildFor(
    task: TaskRequest,
    provider: ProviderId,
    extras: {
      preferences?: string[];
      touchedFiles?: string[];
      lastFailure?: string;
      /** Checks this repo declares, so the brief can name the one that will run. */
      checks?: VerifyCommand[];
      shapeTasks?: boolean;
    } = {},
  ): BriefSection[] {
    try {
      return briefSections({
        provider,
        editor: this.snapshot.editor,
        repo: this.snapshot.repo,
        conventions: this.conventions(),
        preferences: extras.preferences,
        shaping:
          extras.shapeTasks === false ? undefined : this.shapingFor(task, extras.checks ?? []),
        thread: { touchedFiles: extras.touchedFiles, lastFailure: extras.lastFailure },
      });
    } catch (e) {
      this.output.appendLine(`[brief] failed: ${(e as Error).message}`);
      return [];
    }
  }
}
