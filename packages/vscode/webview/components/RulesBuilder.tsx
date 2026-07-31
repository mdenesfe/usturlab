import { useState } from 'preact/hooks';
import type { Rule, RulesFile, RuleTarget } from '../../../core/src/rules/schema.js';
import type { AccountStatusDto } from '../../src/panel/protocol.js';
import { vscode } from '../vscodeApi.js';
import { RuleEditor } from './RuleEditor.js';
import { MatchConditionEditor } from './MatchConditionEditor.js';

interface RulesBuilderProps {
  rules: RulesFile;
  accounts: AccountStatusDto[];
}

export function RulesBuilder({ rules, accounts }: RulesBuilderProps) {
  const [editingRule, setEditingRule] = useState<Rule | undefined>();
  const [editingDefault, setEditingDefault] = useState(false);
  const [defaultChain, setDefaultChain] = useState<RuleTarget[]>(rules.defaultChain ?? []);
  const [newDefaultProvider, setNewDefaultProvider] = useState<'claude' | 'codex' | 'gemini' | 'copilot'>('claude');
  const [newDefaultAccount, setNewDefaultAccount] = useState('');
  const [newDefaultModel, setNewDefaultModel] = useState('');

  if (editingRule) {
    return (
      <RuleEditor
        rule={editingRule}
        accounts={accounts}
        onSave={(rule) => {
          const index = rules.rules.findIndex((r) => r.id === rule.id);
          vscode.postMessage({
            kind: 'saveRule',
            rule,
            ruleIndex: index >= 0 ? index : undefined,
          });
          setEditingRule(undefined);
        }}
        onCancel={() => setEditingRule(undefined)}
      />
    );
  }

  if (editingDefault) {
    return (
      <div class="default-chain-editor">
        <div class="editor-header">
          <h2>Edit default chain</h2>
          <div class="editor-actions">
            <button
              type="button"
              class="cancel-btn"
              onClick={() => {
                setEditingDefault(false);
                setDefaultChain(rules.defaultChain ?? []);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              class="save-btn"
              onClick={() => {
                vscode.postMessage({ kind: 'saveDefaultChain', chain: defaultChain });
                setEditingDefault(false);
              }}
            >
              Save
            </button>
          </div>
        </div>

        <div class="editor-form">
          <div class="default-list">
            {defaultChain.map((t, idx) => (
              <div key={idx} class="target-item">
                <div class="target-label">
                  {t.provider}:{t.account}
                  {t.model && <span class="target-model"> / {t.model}</span>}
                </div>
                <button type="button" class="target-remove" onClick={() => setDefaultChain(defaultChain.filter((_, i) => i !== idx))}>
                  Remove
                </button>
              </div>
            ))}
          </div>

          <div class="add-target">
            <select
              value={newDefaultProvider}
              onChange={(e) => setNewDefaultProvider((e.target as HTMLSelectElement).value as any)}
            >
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
              <option value="gemini">Gemini</option>
              <option value="copilot">Copilot</option>
            </select>

            <select
              value={newDefaultAccount}
              onChange={(e) => setNewDefaultAccount((e.target as HTMLSelectElement).value)}
            >
              <option value="">Select account</option>
              {accounts
                .filter((a) => a.provider === newDefaultProvider)
                .map((a) => (
                  <option key={a.id} value={a.label}>
                    {a.label}
                  </option>
                ))}
            </select>

            <input
              type="text"
              placeholder="Model (optional)"
              value={newDefaultModel}
              onInput={(e) => setNewDefaultModel((e.target as HTMLInputElement).value)}
            />

            <button
              type="button"
              class="add-btn"
              onClick={() => {
                if (newDefaultAccount.trim()) {
                  const newTarget: RuleTarget = {
                    provider: newDefaultProvider,
                    account: newDefaultAccount.trim(),
                    ...(newDefaultModel.trim() && { model: newDefaultModel.trim() }),
                  };
                  setDefaultChain([...defaultChain, newTarget]);
                  setNewDefaultAccount('');
                  setNewDefaultModel('');
                }
              }}
            >
              Add
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div class="rules-builder">
      <div class="builder-header">
        <h1>Routing Rules</h1>
        <button class="new-rule-btn" onClick={() => setEditingRule({} as Rule)}>
          + New
        </button>
      </div>

      <div class="rules-list">
        {rules.rules.length === 0 ? (
          <div class="empty-state">
            Create a routing rule to direct tasks to specific accounts or models
          </div>
        ) : (
          rules.rules.map((rule) => (
            <div key={rule.id} class="rule-card">
              <div class="rule-header">
                <div class="rule-title">{rule.id}</div>
                {rule.description && <div class="rule-desc">{rule.description}</div>}
              </div>

              <div class="rule-content">
                {rule.match.keywords && rule.match.keywords.length > 0 && (
                  <div class="match-chips">
                    <span class="chip-label">Keywords</span>
                    {rule.match.keywords.map((kw) => (
                      <span key={kw} class="chip">
                        {kw}
                      </span>
                    ))}
                  </div>
                )}

                {rule.match.globs && rule.match.globs.length > 0 && (
                  <div class="match-chips">
                    <span class="chip-label">Files</span>
                    {rule.match.globs.map((g) => (
                      <span key={g} class="chip mono">
                        {g}
                      </span>
                    ))}
                  </div>
                )}

                {rule.match.tags && rule.match.tags.length > 0 && (
                  <div class="match-chips">
                    <span class="chip-label">Tags</span>
                    {rule.match.tags.map((t) => (
                      <span key={t} class="chip">
                        #{t}
                      </span>
                    ))}
                  </div>
                )}

                <div class="chain-row">
                  <span class="chain-label">→</span>
                  {rule.target.map((t, idx) => (
                    <span key={idx} class="chain-pill">
                      {t.provider}:{t.account}
                      {t.model && <span class="model-suffix">/{t.model}</span>}
                    </span>
                  ))}
                </div>
              </div>

              <div class="rule-actions">
                <button class="edit-btn" onClick={() => setEditingRule(rule)}>
                  Edit
                </button>
                <button class="delete-btn" onClick={() => vscode.postMessage({ kind: 'deleteRule', ruleId: rule.id })}>
                  Delete
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      <div class="default-chain-section">
        <div class="section-header">
          <div>
            <h2>Default failover</h2>
            <p class="section-desc">When no rule matches</p>
          </div>
          <button class="edit-btn small" onClick={() => setEditingDefault(true)}>
            Edit
          </button>
        </div>

        {(rules.defaultChain ?? []).length === 0 ? (
          <div class="empty-chain">
            No default chain configured
          </div>
        ) : (
          <div class="chain-display">
            {rules.defaultChain.map((t, idx) => (
              <span key={idx} class="chain-pill">
                {t.provider}:{t.account}
                {t.model && <span class="model-suffix">/{t.model}</span>}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
