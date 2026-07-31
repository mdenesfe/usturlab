import type { Rule, RuleTarget, RulesFile } from '@usturlab/core';
import { vscode } from '../vscodeApi.js';
import { IconPlus, IconRoute } from './icons.js';

function TargetChain({ chain }: { chain: RuleTarget[] }) {
  return (
    <div class="target-chain">
      {chain.map((t, i) => (
        <>
          {i > 0 && <span class="chain-arrow">→</span>}
          <span key={i} class="chain-pill">
            {t.provider}:{t.account}
            {t.model && <span class="chain-model">/{t.model}</span>}
          </span>
        </>
      ))}
    </div>
  );
}

function matchChips(rule: Rule): Array<{ label: string; values: string }> {
  const chips: Array<{ label: string; values: string }> = [];
  const m = rule.match;
  if (m.keywords?.length) chips.push({ label: 'keywords', values: m.keywords.join(', ') });
  if (m.globs?.length) chips.push({ label: 'files', values: m.globs.join(', ') });
  if (m.languages?.length) chips.push({ label: 'lang', values: m.languages.join(', ') });
  if (m.tags?.length) chips.push({ label: 'tags', values: m.tags.map((t) => `#${t}`).join(' ') });
  if (m.maxPromptChars) chips.push({ label: 'max', values: `${m.maxPromptChars} chars` });
  return chips;
}

export function RulesView({
  rules,
  path,
  exists,
  error,
}: {
  rules: RulesFile;
  path: string;
  exists: boolean;
  error?: string;
}) {
  return (
    <div class="accounts-page">
      <div class="accounts-header">
        <div class="accounts-title">
          <IconRoute size={16} />
          <span>Routing rules</span>
          <span class="accounts-count">{rules.rules.length}</span>
        </div>
        <button class="run-btn send" onClick={() => vscode.postMessage({ kind: 'editRules' })}>
          {exists ? 'Open JSON' : 'Create rules file'}
        </button>
      </div>

      <div class="rules-path" title={path}>
        {path}
        {!exists && <span class="rules-missing"> · not created yet</span>}
      </div>

      {error && <div class="msg-error">rules file invalid — routing falls back to priority order: {error}</div>}

      {!exists && !error && (
        <div class="accounts-empty">
          <IconRoute size={28} />
          <div class="accounts-empty-title">No rules yet</div>
          <div class="accounts-empty-line">
            Without rules, tasks go to your accounts in priority order. Create the rules file to
            route by keywords, file globs, languages, tags or prompt length — with a failover chain
            per rule.
          </div>
          <button class="run-btn send" onClick={() => vscode.postMessage({ kind: 'editRules' })}>
            <IconPlus size={12} /> Create from template
          </button>
        </div>
      )}

      {rules.rules.map((rule) => (
        <div key={rule.id} class="rule-card">
          <div class="rule-head">
            <span class="rule-id">{rule.id}</span>
            {rule.description && <span class="rule-desc">{rule.description}</span>}
          </div>
          <div class="rule-match">
            {matchChips(rule).map((chip) => (
              <span key={chip.label} class="match-chip">
                <span class="match-label">{chip.label}</span> {chip.values}
              </span>
            ))}
          </div>
          <TargetChain chain={rule.target} />
        </div>
      ))}

      {rules.defaultChain.length > 0 && (
        <div class="rule-card default-chain">
          <div class="rule-head">
            <span class="rule-id">default chain</span>
            <span class="rule-desc">when no rule matches — and the tail of every failover</span>
          </div>
          <TargetChain chain={rules.defaultChain} />
        </div>
      )}

      <div class="accounts-footer">
        <span class="accounts-hint">
          First matching rule wins · fields AND, values OR · <code>@mention</code> bypasses rules ·
          edits apply live
        </span>
      </div>
    </div>
  );
}
