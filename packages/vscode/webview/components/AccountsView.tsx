import type { AccountStatusDto } from '../../src/panel/protocol.js';
import { vscode } from '../vscodeApi.js';
import { IconAccounts, IconPlus, IconTrash } from './icons.js';

const PROVIDER_GLYPH: Record<string, string> = {
  claude: 'C',
  codex: 'X',
  gemini: 'G',
  copilot: 'P',
};

const AUTH_LABEL: Record<string, string> = {
  'oauth-token': 'subscription token',
  'managed-home': 'subscription profile',
  'api-key': 'API key',
};

function barClass(pct: number): string {
  if (pct >= 90) return 'high';
  if (pct >= 70) return 'mid';
  return 'low';
}

export function AccountsView({ accounts }: { accounts: AccountStatusDto[] }) {
  return (
    <div class="accounts-page">
      <div class="accounts-header">
        <div class="accounts-title">
          <IconAccounts size={16} />
          <span>Accounts</span>
          <span class="accounts-count">{accounts.length}</span>
        </div>
        <button class="run-btn send" onClick={() => vscode.postMessage({ kind: 'addAccount' })}>
          <IconPlus size={12} /> Add account
        </button>
      </div>

      {accounts.length === 0 ? (
        <div class="accounts-empty">
          <IconAccounts size={28} />
          <div class="accounts-empty-title">No accounts yet</div>
          <div class="accounts-empty-line">
            Add your AI subscriptions — multiple Claude accounts, Codex, Gemini, Copilot — and
            usrouter routes every task to the best one.
          </div>
          <button class="run-btn send" onClick={() => vscode.postMessage({ kind: 'addAccount' })}>
            <IconPlus size={12} /> Add your first account
          </button>
        </div>
      ) : (
        <div class="account-cards">
          {accounts.map((a) => (
            <div key={a.id} class={`account-card ${a.available ? '' : 'limited'}`}>
              <div class={`provider-glyph p-${a.provider}`}>{PROVIDER_GLYPH[a.provider]}</div>
              <div class="account-main">
                <div class="account-name">
                  <span class="account-id">
                    {a.provider}:{a.label}
                  </span>
                  <span class="account-auth">{AUTH_LABEL[a.authMode] ?? a.authMode}</span>
                </div>
                <div class="account-status">
                  <span class={`dot ${a.available ? 'ok' : 'off'}`} />
                  {a.available
                    ? 'ready'
                    : `limited${a.resetAt ? ` · resets ${new Date(a.resetAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}`}
                </div>
                {(a.usage ?? []).map((u) => (
                  <div key={u.label} class="usage-row">
                    <div class="usage-bar">
                      <div
                        class={`usage-fill ${barClass(u.utilizationPct)}`}
                        style={{ width: `${Math.min(100, u.utilizationPct)}%` }}
                      />
                    </div>
                    <span class="usage-label">
                      {u.utilizationPct}% · {u.label}
                    </span>
                  </div>
                ))}
              </div>
              <button
                class="icon-btn account-del"
                title="Remove account"
                onClick={() => vscode.postMessage({ kind: 'removeAccount', id: a.id })}
              >
                <IconTrash size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div class="accounts-footer">
        <button class="ghost-btn" onClick={() => vscode.postMessage({ kind: 'openRules' })}>
          Routing rules
        </button>
        <span class="accounts-hint">
          Rules decide which account gets each task · <code>.usrouter/rules.json</code>
        </span>
      </div>
    </div>
  );
}
