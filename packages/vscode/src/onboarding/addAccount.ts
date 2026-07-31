import * as vscode from 'vscode';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  ClaudeAdapter,
  fetchClaudeUsage,
  slugify,
  type AccountProfile,
  type AdapterRegistry,
  type AuthMode,
  type LoginFlow,
  type ProviderId,
} from '@usrouter/core';
import type { AccountStore } from '../storage/accountStore.js';
import {
  captureOutputMatch,
  pollUntil,
  waitForFile,
  waitForShellIntegration,
  withTimeout,
} from './loginWatch.js';

interface AuthOption {
  label: string;
  description: string;
  mode: AuthMode;
}

const AUTH_OPTIONS: Record<ProviderId, AuthOption[]> = {
  claude: [
    {
      label: 'Claude subscription (recommended)',
      description: 'claude setup-token — long-lived token, works with Pro/Max',
      mode: 'oauth-token',
    },
    {
      label: 'Claude subscription (isolated profile)',
      description: 'Full CLAUDE_CONFIG_DIR profile with its own /login',
      mode: 'managed-home',
    },
    { label: 'Anthropic API key', description: 'Pay-as-you-go, not a subscription', mode: 'api-key' },
  ],
  codex: [
    {
      label: 'ChatGPT subscription',
      description: 'codex login in an isolated CODEX_HOME profile',
      mode: 'managed-home',
    },
    { label: 'OpenAI API key', description: 'CODEX_API_KEY — usage-based billing', mode: 'api-key' },
  ],
  gemini: [
    {
      label: 'Google account',
      description: 'Login with Google (free tier / Google AI Pro & Ultra)',
      mode: 'managed-home',
    },
    { label: 'Gemini API key', description: 'GEMINI_API_KEY', mode: 'api-key' },
  ],
  copilot: [
    {
      label: 'GitHub account',
      description: '/login device flow in an isolated COPILOT_HOME profile',
      mode: 'managed-home',
    },
    {
      label: 'Personal access token',
      description: 'Fine-grained PAT with "Copilot Requests" permission',
      mode: 'api-key',
    },
  ],
};

export async function addAccountWizard(
  accounts: AccountStore,
  adapters: AdapterRegistry,
): Promise<void> {
  const providerPick = await vscode.window.showQuickPick(
    adapters.all().map((a) => ({ label: a.displayName, id: a.id })),
    { title: 'usrouter: which provider?', placeHolder: 'Provider of the subscription to add' },
  );
  if (!providerPick) return;
  const provider = providerPick.id;
  const adapter = adapters.get(provider)!;

  const authPick = await vscode.window.showQuickPick(AUTH_OPTIONS[provider], {
    title: `usrouter: how do you sign in to ${adapter.displayName}?`,
  });
  if (!authPick) return;

  const label = await vscode.window.showInputBox({
    title: 'usrouter: account label',
    prompt: 'Short name used in rules, e.g. "personal", "work"',
    value: AUTH_OPTIONS[provider].indexOf(authPick) === 0 ? 'personal' : '',
    validateInput: (value) => {
      const trimmed = value.trim();
      if (!trimmed) return 'Label is required';
      if (!/^[a-zA-Z0-9][\w-]*$/.test(trimmed)) {
        return 'Use letters, numbers, - or _ only (e.g. "personal", "work-2")';
      }
      if (accounts.all().some((a) => a.provider === provider && a.label === trimmed)) {
        return `A ${provider} account labeled "${trimmed}" already exists`;
      }
      return undefined;
    },
  });
  if (!label) return;

  const id = `${provider}-${slugify(label)}`;
  const profileDir = join(homedir(), '.usrouter', 'profiles', id);
  mkdirSync(profileDir, { recursive: true });

  const profile: AccountProfile = {
    id,
    provider,
    label: label.trim(),
    authMode: authPick.mode,
    homeDir: authPick.mode === 'api-key' && provider !== 'copilot' ? undefined : profileDir,
    hasSecret: false,
    priority: accounts.all().length + 1,
  };

  if (authPick.mode === 'api-key') {
    const key = await vscode.window.showInputBox({
      title: `usrouter: ${adapter.displayName} API key / token`,
      password: true,
      prompt: 'Stored in the VS Code secret store, never written to disk in plain text',
    });
    if (!key) return;
    await accounts.setSecret(id, key.trim());
    profile.hasSecret = true;
    await accounts.upsert(profile);
    void vscode.window.showInformationMessage(`usrouter: added ${provider}:${profile.label}`);
    return;
  }

  const flow: LoginFlow =
    provider === 'claude' && authPick.mode === 'managed-home'
      ? (adapter as ClaudeAdapter).managedLoginFlow(profileDir)
      : adapter.loginFlow(profileDir);

  const proceed = await vscode.window.showInformationMessage(
    `usrouter — add ${adapter.displayName} account "${label}"`,
    { modal: true, detail: flow.instructions },
    'Open login terminal',
  );
  if (!proceed) return;

  const terminal = vscode.window.createTerminal({
    name: `usrouter login: ${id}`,
    env: flow.env,
  });
  terminal.show();

  const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
  const command = flow.terminalCommand.join(' ');

  interface Outcome {
    ok: boolean;
    secret?: string;
    manualFallback?: boolean;
  }

  // Login completion is detected automatically (auth file appears, status
  // command flips, or the token shows up in terminal output) — the user only
  // authorizes in the browser. Manual confirmation is a fallback.
  const outcome: Outcome =
    flow.watch.kind === 'manual-confirm'
      ? { ok: false, manualFallback: true }
      : await vscode.window.withProgress<Outcome>(
          {
            location: vscode.ProgressLocation.Notification,
            title: `usrouter: authorize ${adapter.displayName} in the browser — connection is detected automatically`,
            cancellable: true,
          },
          async (_progress, cancel) => {
            const watch = flow.watch;
            if (watch.kind === 'output-token') {
              const si = await waitForShellIntegration(terminal, 6000);
              if (!si) {
                terminal.sendText(command);
                return { ok: false, manualFallback: true };
              }
              const secret = await withTimeout(
                captureOutputMatch(si, command, new RegExp(watch.pattern), cancel),
                cancel,
                LOGIN_TIMEOUT_MS,
              );
              return secret ? { ok: true, secret } : { ok: false, manualFallback: true };
            }
            terminal.sendText(command);
            if (watch.kind === 'file') {
              return { ok: await waitForFile(watch.path, cancel, LOGIN_TIMEOUT_MS) };
            }
            if (watch.kind === 'poll') {
              return {
                ok: await pollUntil(watch.check, watch.intervalMs ?? 3000, cancel, LOGIN_TIMEOUT_MS),
              };
            }
            return { ok: false };
          },
        );

  if (flow.watch.kind === 'manual-confirm') {
    terminal.sendText(command);
  }

  if (!outcome.ok && outcome.manualFallback) {
    const confirmed = await vscode.window.showInformationMessage(
      `usrouter: complete the ${adapter.displayName} login in the terminal, then click here.`,
      'I completed the login',
      'Cancel',
    );
    if (confirmed !== 'I completed the login') {
      void vscode.window.showWarningMessage(
        `usrouter: account setup for ${provider}:${label} was canceled — nothing was saved.`,
      );
      return;
    }
    if (flow.postLoginSecretPrompt === 'oauth-token') {
      const token = await vscode.window.showInputBox({
        title: 'usrouter: paste the token printed by the CLI',
        password: true,
        ignoreFocusOut: true,
        prompt: 'Copy the long token (sk-ant-oat…) printed in the terminal and paste it here',
      });
      if (!token) {
        void vscode.window.showWarningMessage(
          `usrouter: no token pasted — ${provider}:${label} was NOT saved. Run "usrouter: Add Account" again; the terminal may still show the token.`,
        );
        return;
      }
      outcome.secret = token.trim();
      outcome.ok = true;
    } else {
      const ok = await flow.verify();
      if (!ok) {
        const retry = await vscode.window.showWarningMessage(
          `usrouter could not verify the ${adapter.displayName} login for "${label}". Save the account anyway?`,
          'Save anyway',
          'Cancel',
        );
        if (retry !== 'Save anyway') {
          void vscode.window.showWarningMessage(
            `usrouter: account setup for ${provider}:${label} was canceled — nothing was saved.`,
          );
          return;
        }
      }
      outcome.ok = true;
    }
  }

  if (!outcome.ok) {
    void vscode.window.showWarningMessage(
      `usrouter: login was not detected — ${provider}:${label} was NOT saved. Run "usrouter: Add Account" to retry.`,
    );
    return;
  }

  if (outcome.secret) {
    await accounts.setSecret(id, outcome.secret);
    profile.hasSecret = true;
  }
  await accounts.upsert(profile);
  void vscode.window.showInformationMessage(
    `usrouter: ${provider}:${profile.label} connected ✓ You can close the login terminal.`,
  );

  // Verify at login time whether this credential can also serve the usage
  // view, so the user learns immediately instead of staring at empty bars.
  if (provider === 'claude' && outcome.secret) {
    void fetchClaudeUsage(outcome.secret).then((windows) => {
      if (windows.length > 0) {
        void vscode.window.showInformationMessage(
          `usrouter: usage view enabled for ${provider}:${profile.label} (${windows
            .map((w) => `${w.utilizationPct}% ${w.label}`)
            .join(', ')})`,
        );
      } else {
        void vscode.window.showWarningMessage(
          `usrouter: ${provider}:${profile.label} chat works, but this token cannot read usage data. The Accounts view will not show quota bars for it.`,
        );
      }
    });
  }
  await vscode.commands.executeCommand('usrouter.openAccounts');
}
