import { useState } from 'preact/hooks';
import type { Rule, RuleExclusion, RuleMatch, RuleTarget } from '../../../core/src/rules/schema.js';
import type { AccountStatusDto } from '../../src/panel/protocol.js';
import { vscode } from '../vscodeApi.js';
import { MatchConditionEditor } from './MatchConditionEditor.js';
import { TargetChainEditor } from './TargetChainEditor.js';
import { BRAND_COLOR, BrandMark } from './brandIcons.js';
import { IconClose, IconPlus, IconRoute, IconTrash } from './icons.js';

const PROVIDERS = ['claude', 'codex', 'gemini', 'copilot'] as const;
type ChainProvider = (typeof PROVIDERS)[number];

const conditionCount = (m: RuleMatch): number =>
  Object.values(m).filter((v) => (Array.isArray(v) ? v.length > 0 : v !== undefined)).length;

/**
 * One rule, edited as a sentence: when this matches, route there, and never
 * there. Saving writes the whole rule back to the file, so the form carries
 * every field it did not touch rather than dropping it.
 */
export function RuleEditor({
  rule,
  index,
  accounts,
  takenIds,
  onSaved,
  onDiscard,
}: {
  rule?: Rule;
  index?: number;
  accounts: AccountStatusDto[];
  takenIds: string[];
  onSaved: (id: string) => void;
  onDiscard: () => void;
}) {
  const [id, setId] = useState(rule?.id ?? '');
  const [description, setDescription] = useState(rule?.description ?? '');
  const [match, setMatch] = useState<RuleMatch>(rule?.match ?? ({} as RuleMatch));
  const [target, setTarget] = useState<RuleTarget[]>(rule?.target ?? []);
  const [exclude, setExclude] = useState<RuleExclusion[]>(rule?.exclude ?? []);
  const [excludeProvider, setExcludeProvider] = useState<ChainProvider>('gemini');
  const [excludeAccount, setExcludeAccount] = useState('');
  const [showErrors, setShowErrors] = useState(false);

  const draft: Rule = {
    id: id.trim(),
    match,
    target,
    ...(description.trim() && { description: description.trim() }),
    ...(exclude.length > 0 && { exclude }),
  };

  // A rule that does not exist yet is unsaved by definition.
  const dirty = !rule || JSON.stringify(draft) !== JSON.stringify(normalize(rule));

  const problem = validate(draft, takenIds);
  const lead = target[0]?.provider;

  const revert = () => {
    if (!rule) {
      onDiscard();
      return;
    }
    setId(rule.id);
    setDescription(rule.description ?? '');
    setMatch(rule.match);
    setTarget(rule.target);
    setExclude(rule.exclude ?? []);
    setShowErrors(false);
  };

  const save = () => {
    if (problem) {
      setShowErrors(true);
      return;
    }
    vscode.postMessage({ kind: 'saveRule', rule: draft, ruleIndex: index });
    setShowErrors(false);
    onSaved(draft.id);
  };

  return (
    <div class="rule-detail">
      <div class="detail-header">
        <span
          class="brand-badge big"
          style={{
            background: lead
              ? `color-mix(in srgb, ${BRAND_COLOR[lead]} 14%, transparent)`
              : 'transparent',
          }}
        >
          {lead ? <BrandMark provider={lead} size={26} /> : <IconRoute size={22} />}
        </span>
        <div class="detail-title">
          <input
            class="title-input"
            type="text"
            spellcheck={false}
            placeholder="rule-id"
            value={id}
            onInput={(e) => setId((e.target as HTMLInputElement).value)}
          />
          <input
            class="sub-input"
            type="text"
            placeholder="what this rule is for — optional"
            value={description}
            onInput={(e) => setDescription((e.target as HTMLInputElement).value)}
          />
        </div>
        <div class="detail-actions">
          {rule && (
            <button
              class="icon-btn account-del"
              title="Delete this rule"
              onClick={() => vscode.postMessage({ kind: 'deleteRule', ruleId: rule.id })}
            >
              <IconTrash size={13} />
            </button>
          )}
        </div>
      </div>

      <div class="detail-section wide">
        <div class="detail-section-title">
          When <span class="section-note">every condition you fill in has to hold</span>
        </div>
        <MatchConditionEditor match={match} onChange={setMatch} />
      </div>

      <div class="detail-section wide">
        <div class="detail-section-title">
          Route to <span class="section-note">first one that can take it wins</span>
        </div>
        <TargetChainEditor
          chain={target}
          accounts={accounts}
          onChange={setTarget}
          emptyHint="No target — this rule only says where the work must not go, and the default chain decides the rest."
        />
      </div>

      <div class="detail-section wide">
        <div class="detail-section-title">
          Never route to <span class="section-note">applies to the whole chain, default included</span>
        </div>
        {exclude.length > 0 && (
          <div class="chip-row">
            {exclude.map((e, i) => (
              <span key={`${e.provider}:${e.account ?? '*'}`} class="edit-chip mono">
                {e.account ? `${e.provider}:${e.account}` : `every ${e.provider}`}
                <button
                  class="chip-x"
                  title="Allow this one again"
                  onClick={() => setExclude(exclude.filter((_, idx) => idx !== i))}
                >
                  <IconClose size={9} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div class="chain-add">
          <select
            class="field-select"
            value={excludeProvider}
            onChange={(e) => {
              setExcludeProvider((e.target as HTMLSelectElement).value as ChainProvider);
              setExcludeAccount('');
            }}
          >
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <select
            class="field-select"
            value={excludeAccount}
            onChange={(e) => setExcludeAccount((e.target as HTMLSelectElement).value)}
          >
            <option value="">every account</option>
            {accounts
              .filter((a) => a.provider === excludeProvider)
              .map((a) => (
                <option key={a.id} value={a.label}>
                  {a.label}
                </option>
              ))}
          </select>
          <button
            class="ghost-btn add-target-btn"
            onClick={() => {
              const entry: RuleExclusion = {
                provider: excludeProvider,
                ...(excludeAccount && { account: excludeAccount }),
              };
              const key = `${entry.provider}:${entry.account ?? '*'}`;
              if (exclude.some((e) => `${e.provider}:${e.account ?? '*'}` === key)) return;
              setExclude([...exclude, entry]);
              setExcludeAccount('');
            }}
          >
            <IconPlus size={11} /> Bar it
          </button>
        </div>
      </div>

      <div class="detail-footer">
        {showErrors && problem ? (
          <span class="rule-problem">{problem}</span>
        ) : (
          <span class="accounts-hint">
            {conditionCount(match) === 0
              ? 'A rule with no condition would match every task — add at least one.'
              : 'Saved straight into the rules file; routing picks it up on the next task.'}
          </span>
        )}
        <div class="header-gap" />
        {dirty && (
          <button class="ghost-btn" onClick={revert}>
            {rule ? 'Revert' : 'Discard'}
          </button>
        )}
        <button class="run-btn send" disabled={!dirty} onClick={save}>
          {rule ? 'Save rule' : 'Create rule'}
        </button>
      </div>
    </div>
  );
}

/** The shape `saveRule` would write, so "dirty" compares like with like. */
function normalize(rule: Rule): Rule {
  return {
    id: rule.id,
    match: rule.match,
    target: rule.target,
    ...(rule.description && { description: rule.description }),
    ...(rule.exclude?.length ? { exclude: rule.exclude } : {}),
  };
}

/** Everything the rules schema would reject, said before the file is written. */
function validate(draft: Rule, takenIds: string[]): string | undefined {
  if (!draft.id) return 'A rule needs an id — it is how the router names it in the transcript.';
  if (takenIds.includes(draft.id)) return `Another rule is already called "${draft.id}".`;
  if (conditionCount(draft.match) === 0) return 'Add at least one condition, or this rule matches everything.';
  if (draft.target.length === 0 && (draft.exclude?.length ?? 0) === 0) {
    return 'Add a target to route to, or an account to bar.';
  }
  return undefined;
}
