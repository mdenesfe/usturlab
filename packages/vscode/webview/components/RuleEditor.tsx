import { useState } from 'preact/hooks';
import type { Rule, RuleTarget } from '../../../core/src/rules/schema.js';
import type { AccountStatusDto } from '../../src/panel/protocol.js';
import { MatchConditionEditor } from './MatchConditionEditor.js';

interface RuleEditorProps {
  rule?: Rule;
  accounts: AccountStatusDto[];
  onSave: (rule: Rule) => void;
  onCancel: () => void;
}

export function RuleEditor({ rule, accounts, onSave, onCancel }: RuleEditorProps) {
  const [id, setId] = useState(rule?.id ?? '');
  const [description, setDescription] = useState(rule?.description ?? '');
  const [match, setMatch] = useState(rule?.match ?? {});
  const [targets, setTargets] = useState<RuleTarget[]>(rule?.target ?? []);
  const [newTargetProvider, setNewTargetProvider] = useState<'claude' | 'codex' | 'gemini' | 'copilot'>('claude');
  const [newTargetAccount, setNewTargetAccount] = useState('');
  const [newTargetModel, setNewTargetModel] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const handleSave = () => {
    const newErrors: Record<string, string> = {};
    if (!id.trim()) newErrors.id = 'ID is required';
    // A rule that only says where work must NOT go is complete without a target.
    if (targets.length === 0 && !rule?.exclude?.length) {
      newErrors.targets = 'At least one target is required';
    }

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    const newRule: Rule = {
      id: id.trim(),
      match,
      target: targets,
      ...(description.trim() && { description: description.trim() }),
      // Exclusions are authored in the rules file; this form rebuilds the rule
      // from its own state, so carry them through rather than dropping them.
      ...(rule?.exclude?.length ? { exclude: rule.exclude } : {}),
    };

    onSave(newRule);
  };

  const addTarget = () => {
    if (!newTargetAccount.trim()) return;
    const newTarget: RuleTarget = {
      provider: newTargetProvider,
      account: newTargetAccount.trim(),
      ...(newTargetModel.trim() && { model: newTargetModel.trim() }),
    };
    setTargets([...targets, newTarget]);
    setNewTargetAccount('');
    setNewTargetModel('');
  };

  const removeTarget = (idx: number) => {
    setTargets(targets.filter((_, i) => i !== idx));
  };

  const getAccountLabel = (provider: string, account: string) => {
    const acc = accounts.find((a) => a.provider === provider && a.label === account);
    return acc ? `${acc.provider}:${acc.label}` : `${provider}:${account}`;
  };

  const availableAccounts = accounts.filter((a) => a.provider === newTargetProvider);

  return (
    <div class="rule-editor">
      <div class="editor-header">
        <h2>{rule ? 'Edit Rule' : 'New Rule'}</h2>
        <div class="editor-actions">
          <button type="button" class="cancel-btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" class="save-btn" onClick={handleSave}>
            Save
          </button>
        </div>
      </div>

      <div class="editor-form">
        <div class="form-group">
          <label>Rule ID *</label>
          <input
            type="text"
            value={id}
            onInput={(e) => setId((e.target as HTMLInputElement).value)}
            placeholder="e.g., tests-to-codex"
          />
          {errors.id && <div class="error-text">{errors.id}</div>}
        </div>

        <div class="form-group">
          <label>Description</label>
          <input
            type="text"
            value={description}
            onInput={(e) => setDescription((e.target as HTMLInputElement).value)}
            placeholder="Optional human-readable description"
          />
        </div>

        <div class="form-group">
          <label>Match Conditions</label>
          <MatchConditionEditor match={match} onChange={setMatch} />
        </div>

        {(rule?.exclude?.length ?? 0) > 0 && (
          <div class="form-group">
            <label>Never route here</label>
            <div class="target-list">
              {rule!.exclude!.map((e, idx) => (
                <div key={idx} class="target-item">
                  <div class="target-label">
                    {e.account ? `${e.provider}:${e.account}` : `every ${e.provider} account`}
                  </div>
                </div>
              ))}
            </div>
            <div class="field-hint">
              Kept as written. Exclusions are edited in the rules file for now.
            </div>
          </div>
        )}

        <div class="form-group">
          <label>Failover Chain *</label>
          <div class="target-list">
            {targets.map((t, idx) => (
              <div key={idx} class="target-item">
                <div class="target-label">
                  {getAccountLabel(t.provider, t.account)}
                  {t.model && <span class="target-model"> / {t.model}</span>}
                </div>
                <button type="button" class="target-remove" onClick={() => removeTarget(idx)}>
                  Remove
                </button>
              </div>
            ))}
          </div>
          {errors.targets && <div class="error-text">{errors.targets}</div>}

          <div class="add-target">
            <select
              value={newTargetProvider}
              onChange={(e) => setNewTargetProvider((e.target as HTMLSelectElement).value as any)}
            >
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
              <option value="gemini">Gemini</option>
              <option value="copilot">Copilot</option>
            </select>

            <select
              value={newTargetAccount}
              onChange={(e) => setNewTargetAccount((e.target as HTMLSelectElement).value)}
            >
              <option value="">Select account</option>
              {availableAccounts.map((a) => (
                <option key={a.id} value={a.label}>
                  {a.label}
                </option>
              ))}
            </select>

            <input
              type="text"
              placeholder="Model (optional)"
              value={newTargetModel}
              onInput={(e) => setNewTargetModel((e.target as HTMLInputElement).value)}
            />

            <button type="button" class="add-btn" onClick={addTarget}>
              Add Target
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
