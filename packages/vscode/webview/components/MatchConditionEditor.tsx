import { useState } from 'preact/hooks';
import type { RuleMatch } from '../../../core/src/rules/schema.js';
import { IconClose } from './icons.js';

/**
 * One condition, as a row of values you can add to and take from. Every field
 * here behaves the same way — values inside a field are OR-ed, and the fields
 * you fill in are AND-ed — so they are all drawn the same way too.
 */
function ChipField({
  label,
  hint,
  values,
  placeholder,
  mono,
  prefix,
  onChange,
}: {
  label: string;
  hint: string;
  values: string[];
  placeholder: string;
  mono?: boolean;
  prefix?: string;
  onChange: (values: string[] | undefined) => void;
}) {
  const [draft, setDraft] = useState('');

  const add = () => {
    const value = draft.trim().replace(/^#/, '');
    if (!value || values.includes(value)) {
      setDraft('');
      return;
    }
    onChange([...values, value]);
    setDraft('');
  };

  // An empty list is not the same as "no condition": the field has to leave the
  // rule entirely, or it would match nothing at all.
  const remove = (index: number) => {
    const next = values.filter((_, i) => i !== index);
    onChange(next.length > 0 ? next : undefined);
  };

  return (
    <div class="match-field">
      <div class="field-head">
        <span class="field-label">{label}</span>
        <span class="field-note">{hint}</span>
      </div>
      <div class="chip-row">
        {values.map((value, i) => (
          <span key={value} class={`edit-chip ${mono ? 'mono' : ''}`}>
            {prefix}
            {value}
            <button class="chip-x" title={`Remove ${value}`} onClick={() => remove(i)}>
              <IconClose size={9} />
            </button>
          </span>
        ))}
        <input
          class={`chip-input ${mono ? 'mono' : ''}`}
          type="text"
          placeholder={values.length === 0 ? placeholder : '+'}
          value={draft}
          onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
          onBlur={add}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
            if (e.key === 'Backspace' && draft === '' && values.length > 0) {
              remove(values.length - 1);
            }
          }}
        />
      </div>
    </div>
  );
}

export function MatchConditionEditor({
  match,
  onChange,
}: {
  match: RuleMatch;
  onChange: (match: RuleMatch) => void;
}) {
  const set = (key: keyof RuleMatch, value: string[] | number | undefined) => {
    const next = { ...match } as Record<string, unknown>;
    if (value === undefined) delete next[key];
    else next[key] = value;
    onChange(next as RuleMatch);
  };

  return (
    <div class="match-editor">
      <ChipField
        label="prompt contains"
        hint="any one of these words"
        values={match.keywords ?? []}
        placeholder="test, refactor, güvenlik"
        onChange={(v) => set('keywords', v)}
      />
      <ChipField
        label="open file matches"
        hint="glob against the active editor"
        values={match.globs ?? []}
        placeholder="**/*.test.ts"
        mono
        onChange={(v) => set('globs', v)}
      />
      <ChipField
        label="language is"
        hint="VS Code language id"
        values={match.languages ?? []}
        placeholder="typescript, python"
        mono
        onChange={(v) => set('languages', v)}
      />
      <ChipField
        label="tagged"
        hint="#tag typed in the prompt"
        values={match.tags ?? []}
        placeholder="urgent"
        prefix="#"
        onChange={(v) => set('tags', v)}
      />

      <div class="match-field">
        <div class="field-head">
          <span class="field-label">prompt length</span>
          <span class="field-note">no longer than, in characters</span>
        </div>
        <input
          class="field-input narrow"
          type="number"
          min="1"
          placeholder="any length"
          value={match.maxPromptChars ?? ''}
          onInput={(e) => {
            const value = parseInt((e.target as HTMLInputElement).value, 10);
            set('maxPromptChars', Number.isFinite(value) && value > 0 ? value : undefined);
          }}
        />
      </div>
    </div>
  );
}
