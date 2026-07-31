import { useEffect, useRef, useState } from 'preact/hooks';
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

function worstPct(a: AccountStatusDto): number | undefined {
  if (!a.usage || a.usage.length === 0) return undefined;
  return Math.max(...a.usage.map((u) => u.utilizationPct));
}

function usageHint(a: AccountStatusDto): string {
  switch (a.provider) {
    case 'gemini':
      return 'Gemini CLI does not expose usage data.';
    case 'codex':
      return 'Usage appears after the first task runs on this profile — Codex writes rate-limit snapshots into its session files.';
    case 'claude':
      return a.authMode === 'oauth-token'
        ? 'setup-token only grants chat (the consent screen asks nothing more). Re-add this account via "Claude subscription (recommended)" — a full profile login — to get quota bars.'
        : 'No data yet — hit Refresh. Usage reads from this profile’s login credential.';
    case 'copilot':
      return a.authMode === 'api-key'
        ? 'No data yet — the PAT needs the "Plan: read" permission.'
        : 'Usage view needs a PAT account (fine-grained token with "Plan: read").';
    default:
      return 'No usage data.';
  }
}

function fmtReset(ts?: number): string | undefined {
  if (!ts) return undefined;
  const d = new Date(ts);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function AccountsView({ accounts }: { accounts: AccountStatusDto[] }) {
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [listWidth, setListWidth] = useState(240);
  const dragging = useRef(false);
  const selected = accounts.find((a) => a.id === selectedId) ?? accounts[0];

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (dragging.current) setListWidth(Math.min(420, Math.max(170, e.clientX)));
    };
    const up = () => {
      dragging.current = false;
      document.body.classList.remove('resizing');
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, []);

  if (accounts.length === 0) {
    return (
      <div class="accounts-page">
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
      </div>
    );
  }

  return (
    <div class="accounts-split">
      <div class="accounts-list" style={{ width: `${listWidth}px` }}>
        <div class="accounts-list-head">
          <span class="accounts-list-title">Accounts</span>
          <span class="accounts-count">{accounts.length}</span>
          <div class="header-gap" />
          <button
            class="icon-btn"
            title="Add account"
            onClick={() => vscode.postMessage({ kind: 'addAccount' })}
          >
            <IconPlus />
          </button>
        </div>
        {accounts.map((a) => {
          const pct = worstPct(a);
          return (
            <div
              key={a.id}
              class={`accounts-row ${selected?.id === a.id ? 'active' : ''}`}
              onClick={() => setSelectedId(a.id)}
            >
              <div class={`provider-glyph small p-${a.provider}`}>{PROVIDER_GLYPH[a.provider]}</div>
              <span class="accounts-row-name" title={`${a.provider}:${a.label}`}>
                {a.provider}:{a.label}
              </span>
              <span class="accounts-row-state">
                {pct !== undefined ? (
                  <span class={`row-pct ${barClass(pct)}`}>{pct}%</span>
                ) : (
                  <span class={`dot ${a.available ? 'ok' : 'off'}`} />
                )}
              </span>
            </div>
          );
        })}
      </div>

      <div
        class="splitter"
        onMouseDown={() => {
          dragging.current = true;
          document.body.classList.add('resizing');
        }}
      />

      {selected && (
        <div class="account-detail">
          <div class="detail-header">
            <div class={`provider-glyph big p-${selected.provider}`}>
              {PROVIDER_GLYPH[selected.provider]}
            </div>
            <div class="detail-title">
              <div class="detail-name">
                {selected.provider}:{selected.label}
              </div>
              <div class="detail-sub">
                <span class="account-auth">{AUTH_LABEL[selected.authMode] ?? selected.authMode}</span>
                <span class={`detail-status ${selected.available ? 'ok' : 'off'}`}>
                  <span class={`dot ${selected.available ? 'ok' : 'off'}`} />
                  {selected.available
                    ? 'ready'
                    : `limited${selected.resetAt ? ` · resets ${fmtReset(selected.resetAt)}` : ''}`}
                </span>
              </div>
            </div>
            <div class="detail-actions">
              <button
                class="ghost-btn"
                onClick={() => vscode.postMessage({ kind: 'refreshUsage' })}
              >
                Refresh
              </button>
              <button
                class="icon-btn account-del"
                title="Remove account"
                onClick={() => vscode.postMessage({ kind: 'removeAccount', id: selected.id })}
              >
                <IconTrash size={13} />
              </button>
            </div>
          </div>

          <div class="detail-section">
            <div class="detail-section-title">Usage</div>
            {(selected.usage ?? []).length > 0 ? (
              (selected.usage ?? []).map((u) => (
                <div key={u.label} class="usage-block">
                  <div class="usage-block-head">
                    <span class="usage-block-label">{u.label}</span>
                    <span class={`usage-block-pct ${barClass(u.utilizationPct)}`}>
                      {u.utilizationPct}%
                    </span>
                  </div>
                  <div class="usage-bar big">
                    <div
                      class={`usage-fill ${barClass(u.utilizationPct)}`}
                      style={{ width: `${Math.min(100, u.utilizationPct)}%` }}
                    />
                  </div>
                  {u.resetAt && <div class="usage-block-reset">resets {fmtReset(u.resetAt)}</div>}
                </div>
              ))
            ) : (
              <div class="usage-hint">{usageHint(selected)}</div>
            )}
          </div>

          {selected.models.length > 0 && (
            <div class="detail-section">
              <div class="detail-section-title">Models</div>
              <div class="detail-models">
                {selected.models.map((m) => (
                  <span key={m.id} class="chain-pill" title={m.id}>
                    {m.label}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div class="detail-footer">
            <button class="ghost-btn" onClick={() => vscode.postMessage({ kind: 'openRules' })}>
              Routing rules
            </button>
            <span class="accounts-hint">
              Reference this account in rules as{' '}
              <code>
                {selected.provider}:{selected.label}
              </code>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
