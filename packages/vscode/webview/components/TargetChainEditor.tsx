import { useState } from 'preact/hooks';
import type { RuleTarget } from '../../../core/src/rules/schema.js';
import type { AccountStatusDto } from '../../src/panel/protocol.js';
import { BRAND_COLOR, BrandMark } from './brandIcons.js';
import { IconClose, IconDown, IconPlus, IconUp } from './icons.js';

/** The four the rules schema can name. OpenRouter reviews, it is never a target. */
const PROVIDERS = ['claude', 'codex', 'gemini', 'copilot'] as const;
type ChainProvider = (typeof PROVIDERS)[number];

/**
 * A failover chain, edited in place. Order is the whole meaning of it — the
 * first target that can take the work gets it — so the rows are numbered and
 * can be moved, not just added and removed.
 */
export function TargetChainEditor({
  chain,
  accounts,
  onChange,
  emptyHint,
}: {
  chain: RuleTarget[];
  accounts: AccountStatusDto[];
  onChange: (chain: RuleTarget[]) => void;
  emptyHint: string;
}) {
  const routable = accounts.filter(
    (a) => !a.reviewOnly && (PROVIDERS as readonly string[]).includes(a.provider),
  );
  const [provider, setProvider] = useState<ChainProvider>(
    (routable[0]?.provider as ChainProvider) ?? 'claude',
  );
  const [account, setAccount] = useState('');
  const [model, setModel] = useState('');

  const forProvider = routable.filter((a) => a.provider === provider);
  const picked = forProvider.find((a) => a.label === account);
  const models = picked?.models ?? [];
  const known = new Set(routable.map((a) => `${a.provider}:${a.label}`));

  const move = (index: number, delta: number) => {
    const next = [...chain];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item!);
    onChange(next);
  };

  const add = () => {
    const name = account.trim();
    if (!name) return;
    onChange([...chain, { provider, account: name, ...(model.trim() && { model: model.trim() }) }]);
    setAccount('');
    setModel('');
  };

  return (
    <div class="chain-editor">
      {chain.length === 0 ? (
        <div class="chain-empty">{emptyHint}</div>
      ) : (
        <div class="chain-items">
          {chain.map((t, i) => {
            const ref = `${t.provider}:${t.account}`;
            return (
              <div key={`${ref}-${i}`} class="chain-item">
                <span class="chain-order">{i + 1}</span>
                <span
                  class="brand-badge small"
                  style={{
                    background: `color-mix(in srgb, ${BRAND_COLOR[t.provider]} 14%, transparent)`,
                  }}
                >
                  <BrandMark provider={t.provider} size={13} />
                </span>
                <span class="chain-target" title={ref}>
                  {ref}
                  {t.model && <span class="chain-model">/{t.model}</span>}
                </span>
                {!known.has(ref) && (
                  <span class="chain-warn" title="No connected account answers to this name">
                    not connected
                  </span>
                )}
                <div class="header-gap" />
                <button
                  class="icon-btn chain-btn"
                  title="Try this one earlier"
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                >
                  <IconUp size={12} />
                </button>
                <button
                  class="icon-btn chain-btn"
                  title="Try this one later"
                  disabled={i === chain.length - 1}
                  onClick={() => move(i, 1)}
                >
                  <IconDown size={12} />
                </button>
                <button
                  class="icon-btn chain-btn remove"
                  title="Remove from the chain"
                  onClick={() => onChange(chain.filter((_, idx) => idx !== i))}
                >
                  <IconClose size={12} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div class="chain-add">
        <select
          class="field-select"
          value={provider}
          onChange={(e) => {
            setProvider((e.target as HTMLSelectElement).value as ChainProvider);
            setAccount('');
            setModel('');
          }}
        >
          {PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>

        {forProvider.length > 0 ? (
          <select
            class="field-select"
            value={account}
            onChange={(e) => {
              setAccount((e.target as HTMLSelectElement).value);
              setModel('');
            }}
          >
            <option value="">account…</option>
            {forProvider.map((a) => (
              <option key={a.id} value={a.label}>
                {a.label}
              </option>
            ))}
          </select>
        ) : (
          // Rules may be written before the account is connected; a name typed
          // here still routes once it is.
          <input
            class="field-input"
            type="text"
            placeholder="account name"
            value={account}
            onInput={(e) => setAccount((e.target as HTMLInputElement).value)}
          />
        )}

        {models.length > 0 ? (
          <select
            class="field-select"
            value={model}
            onChange={(e) => setModel((e.target as HTMLSelectElement).value)}
          >
            <option value="">its default model</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        ) : (
          <input
            class="field-input"
            type="text"
            placeholder="model (optional)"
            value={model}
            onInput={(e) => setModel((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
        )}

        <button class="ghost-btn add-target-btn" disabled={!account.trim()} onClick={add}>
          <IconPlus size={11} /> Add
        </button>
      </div>
    </div>
  );
}
