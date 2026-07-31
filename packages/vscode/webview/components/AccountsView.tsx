import { useEffect, useRef, useState } from 'preact/hooks';
import type { AccountStatusDto } from '../../src/panel/protocol.js';
import { vscode } from '../vscodeApi.js';
import { IconAccounts, IconEdit, IconPlus, IconTrash } from './icons.js';
import { BRAND_COLOR, BrandMark, PROVIDER_NAME } from './brandIcons.js';

const AUTH_LABEL: Record<string, string> = {
  'oauth-token': 'subscription token',
  'managed-home': 'subscription login',
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
        ? 'setup-token only grants chat. Re-add this account via "Claude subscription (recommended)" — a full profile login — to get quota bars.'
        : 'No data yet — hit Refresh. Usage reads from this profile’s login credential.';
    case 'copilot':
      return a.authMode === 'api-key'
        ? 'No data yet — the PAT needs the "Plan: read" permission.'
        : 'Usage view needs a PAT account (fine-grained token with "Plan: read").';
    default:
      return 'No usage data.';
  }
}

function fmtAt(ts: number): string {
  const d = new Date(ts);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtIn(ts: number): string | undefined {
  const diff = ts - Date.now();
  if (diff <= 0) return undefined;
  const min = Math.round(diff / 60_000);
  if (min < 60) return `${min}m`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ${min % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function AccountsView({ accounts }: { accounts: AccountStatusDto[] }) {
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [listWidth, setListWidth] = useState(240);
  const dragging = useRef(false);
  const selected = accounts.find((a) => a.id === selectedId) ?? accounts[0];

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (dragging.current) setListWidth(Math.min(420, Math.max(180, e.clientX)));
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
              <span
                class="brand-badge small"
                style={{ background: `color-mix(in srgb, ${BRAND_COLOR[a.provider]} 14%, transparent)` }}
              >
                <BrandMark provider={a.provider} size={13} />
              </span>
              <span class="accounts-row-name" title={`${a.provider}:${a.label}`}>
                {a.label}
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
            <span
              class="brand-badge big"
              style={{ background: `color-mix(in srgb, ${BRAND_COLOR[selected.provider]} 14%, transparent)` }}
            >
              <BrandMark provider={selected.provider} size={26} />
            </span>
            <div class="detail-title">
              <div class="detail-name">
                {selected.label}
                <button
                  class="icon-btn rename-btn"
                  title="Rename account"
                  onClick={() => vscode.postMessage({ kind: 'renameAccount', id: selected.id })}
                >
                  <IconEdit size={12} />
                </button>
              </div>
              <div class="detail-sub">
                <span class="detail-provider" style={{ color: BRAND_COLOR[selected.provider] }}>
                  {PROVIDER_NAME[selected.provider]}
                </span>
                <span class="account-auth">{AUTH_LABEL[selected.authMode] ?? selected.authMode}</span>
                <span class={`detail-status ${selected.available ? 'ok' : 'off'}`}>
                  <span class={`dot ${selected.available ? 'ok' : 'off'}`} />
                  {selected.available
                    ? 'ready'
                    : `limited${selected.resetAt ? ` · resets ${fmtAt(selected.resetAt)}` : ''}`}
                </span>
              </div>
            </div>
            <div class="detail-actions">
              <button class="ghost-btn" onClick={() => vscode.postMessage({ kind: 'refreshUsage' })}>
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

          <div class="detail-section wide">
            <div class="detail-section-title">Usage</div>
            {(selected.usage ?? []).length > 0 ? (
              <div class="usage-grid">
                {(selected.usage ?? []).map((u) => {
                  const rel = u.resetAt ? fmtIn(u.resetAt) : undefined;
                  return (
                    <div key={u.label} class="usage-card">
                      <div class="usage-card-label">{u.label}</div>
                      <div class={`usage-card-pct ${barClass(u.utilizationPct)}`}>
                        {u.utilizationPct}
                        <span class="pct-sign">%</span>
                      </div>
                      <div class="usage-bar big">
                        <div
                          class={`usage-fill ${barClass(u.utilizationPct)}`}
                          style={{ width: `${Math.min(100, u.utilizationPct)}%` }}
                        />
                      </div>
                      {u.resetAt && (
                        <div class="usage-card-reset">
                          resets {rel ? `in ${rel}` : ''} · {fmtAt(u.resetAt)}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div class="usage-hint">{usageHint(selected)}</div>
            )}
          </div>

          <div class="detail-section">
            <div class="detail-section-title">Account</div>
            <div class="info-rows">
              {selected.identity && (
                <div class="info-row">
                  <span class="info-key">signed in as</span>
                  <span class="info-val">{selected.identity}</span>
                </div>
              )}
              <div class="info-row">
                <span class="info-key">auth</span>
                <span class="info-val">{AUTH_LABEL[selected.authMode] ?? selected.authMode}</span>
              </div>
              {selected.homeDir && (
                <div class="info-row">
                  <span class="info-key">profile</span>
                  <span class="info-val" title={selected.homeDir}>
                    {selected.homeDir.replace(/^.*\/(\.usrouter\/.*)$/, '~/$1')}
                  </span>
                </div>
              )}
              <div class="info-row">
                <span class="info-key">rules ref</span>
                <span class="info-val">
                  <code>
                    {selected.provider}:{selected.label}
                  </code>
                </span>
              </div>
            </div>
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
