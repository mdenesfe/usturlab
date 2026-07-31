import { useState } from 'preact/hooks';
import type { RuleMatch } from '../../../core/src/rules/schema.js';

interface MatchConditionEditorProps {
  match: RuleMatch;
  onChange: (match: RuleMatch) => void;
}

export function MatchConditionEditor({ match, onChange }: MatchConditionEditorProps) {
  const [newKeyword, setNewKeyword] = useState('');
  const [newGlob, setNewGlob] = useState('');
  const [newTag, setNewTag] = useState('');

  const keywords = match.keywords ?? [];
  const globs = match.globs ?? [];
  const tags = match.tags ?? [];

  const addKeyword = () => {
    if (newKeyword.trim()) {
      onChange({ ...match, keywords: [...keywords, newKeyword.trim()] });
      setNewKeyword('');
    }
  };

  const removeKeyword = (idx: number) => {
    onChange({ ...match, keywords: keywords.filter((_, i) => i !== idx) });
  };

  const addGlob = () => {
    if (newGlob.trim()) {
      onChange({ ...match, globs: [...globs, newGlob.trim()] });
      setNewGlob('');
    }
  };

  const removeGlob = (idx: number) => {
    onChange({ ...match, globs: globs.filter((_, i) => i !== idx) });
  };

  const addTag = () => {
    if (newTag.trim()) {
      onChange({ ...match, tags: [...tags, newTag.trim()] });
      setNewTag('');
    }
  };

  const removeTag = (idx: number) => {
    onChange({ ...match, tags: tags.filter((_, i) => i !== idx) });
  };

  return (
    <div class="match-editor">
      <div class="condition-group">
        <label>Keywords</label>
        <div class="tag-list">
          {keywords.map((kw, idx) => (
            <span key={idx} class="tag">
              {kw}
              <button type="button" class="tag-remove" onClick={() => removeKeyword(idx)}>
                ×
              </button>
            </span>
          ))}
        </div>
        <div class="tag-input">
          <input
            type="text"
            placeholder="e.g., test, debug"
            value={newKeyword}
            onInput={(e) => setNewKeyword((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                addKeyword();
              }
            }}
          />
          <button type="button" class="add-btn" onClick={addKeyword}>
            Add
          </button>
        </div>
      </div>

      <div class="condition-group">
        <label>File Globs</label>
        <div class="tag-list">
          {globs.map((g, idx) => (
            <span key={idx} class="tag mono">
              {g}
              <button type="button" class="tag-remove" onClick={() => removeGlob(idx)}>
                ×
              </button>
            </span>
          ))}
        </div>
        <div class="tag-input">
          <input
            type="text"
            placeholder="e.g., **/*.test.ts"
            value={newGlob}
            onInput={(e) => setNewGlob((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                addGlob();
              }
            }}
          />
          <button type="button" class="add-btn" onClick={addGlob}>
            Add
          </button>
        </div>
      </div>

      <div class="condition-group">
        <label>Tags</label>
        <div class="tag-list">
          {tags.map((t, idx) => (
            <span key={idx} class="tag">
              #{t}
              <button type="button" class="tag-remove" onClick={() => removeTag(idx)}>
                ×
              </button>
            </span>
          ))}
        </div>
        <div class="tag-input">
          <input
            type="text"
            placeholder="e.g., urgent, performance"
            value={newTag}
            onInput={(e) => setNewTag((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                addTag();
              }
            }}
          />
          <button type="button" class="add-btn" onClick={addTag}>
            Add
          </button>
        </div>
      </div>

      <div class="condition-group">
        <label>Max Prompt Chars</label>
        <input
          type="number"
          class="number-input"
          value={match.maxPromptChars ?? ''}
          onInput={(e) => {
            const val = parseInt((e.target as HTMLInputElement).value);
            if (val > 0) {
              onChange({ ...match, maxPromptChars: val });
            } else {
              const { maxPromptChars, ...rest } = match;
              onChange(rest as RuleMatch);
            }
          }}
          placeholder="Optional limit"
        />
      </div>
    </div>
  );
}
