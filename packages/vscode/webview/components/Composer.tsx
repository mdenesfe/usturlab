import { useEffect, useRef, useState } from 'preact/hooks';
// Deep import: the core barrel pulls node built-ins the browser bundle can't take.
import { SLASH_COMMANDS, type SlashCommand } from '../../../core/src/commands/slashCommands.js';
import type { AccountStatusDto } from '../../src/panel/protocol.js';
import { IconSend, IconStop } from './icons.js';
import { BrandMark } from './brandIcons.js';

const MAX_TEXTAREA_HEIGHT = 180;

interface Suggestion {
  insert: string;
  label: string;
  detail?: string;
  provider?: string;
}

/** Token under the caret that can trigger suggestions: @…, #…, or /… at the very start. */
function activeToken(text: string, caret: number): { start: number; token: string } | undefined {
  const before = text.slice(0, caret);
  const m = /(^|\s)([@#/][\w:./-]*)$/.exec(before);
  if (!m) return undefined;
  const token = m[2]!;
  const start = caret - token.length;
  if (token.startsWith('/') && start !== 0) return undefined;
  return { start, token };
}

function computeSuggestions(
  token: string,
  accounts: AccountStatusDto[],
  tags: string[],
  commands: SlashCommand[],
): Suggestion[] {
  if (token.startsWith('@')) {
    const q = token.slice(1).toLowerCase();
    const slashIdx = q.indexOf('/');
    if (slashIdx >= 0) {
      const acctPart = q.slice(0, slashIdx);
      const modelQuery = q.slice(slashIdx + 1);
      const account = accounts.find(
        (a) => `${a.provider}:${a.label}`.toLowerCase() === acctPart,
      );
      return (account?.models ?? [])
        .filter((m) => m.id.toLowerCase().includes(modelQuery) || m.label.toLowerCase().includes(modelQuery))
        .map((m) => ({
          insert: `@${account!.provider}:${account!.label}/${m.id}`,
          label: m.label,
          detail: m.id,
          provider: account!.provider,
        }));
    }
    return accounts
      .filter((a) => `${a.provider}:${a.label}`.toLowerCase().includes(q))
      .map((a) => ({
        insert: `@${a.provider}:${a.label}`,
        label: `${a.provider}:${a.label}`,
        detail: a.available ? 'ready' : 'limited',
        provider: a.provider,
      }));
  }
  if (token.startsWith('#')) {
    const q = token.slice(1).toLowerCase();
    return tags
      .filter((t) => t.toLowerCase().startsWith(q))
      .map((t) => ({ insert: `#${t}`, label: `#${t}`, detail: 'tag rule' }));
  }
  if (token.startsWith('/')) {
    const q = token.slice(1).toLowerCase();
    return commands.filter((c) => c.name.startsWith(q)).map((c) => ({
      insert: `/${c.name}`,
      label: c.usage ?? `/${c.name}`,
      detail: c.description,
    }));
  }
  return [];
}

export function Composer({
  accounts,
  tags,
  customCommands = [],
  running,
  onSend,
  onCancel,
}: {
  accounts: AccountStatusDto[];
  tags: string[];
  customCommands?: SlashCommand[];
  running: boolean;
  onSend: (text: string) => void;
  onCancel: () => void;
}) {
  const allCommands = [...customCommands, ...SLASH_COMMANDS];
  const [text, setText] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const tokenRef = useRef<{ start: number; token: string }>();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const autogrow = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  };

  const refreshSuggestions = (value: string, caret: number) => {
    const token = activeToken(value, caret);
    tokenRef.current = token;
    const items = token ? computeSuggestions(token.token, accounts, tags, allCommands).slice(0, 8) : [];
    setSuggestions(items);
    setActiveIndex(0);
  };

  const accept = (suggestion: Suggestion) => {
    const el = textareaRef.current;
    const token = tokenRef.current;
    if (!el || !token) return;
    const caret = el.selectionStart ?? text.length;
    const next = text.slice(0, token.start) + suggestion.insert + ' ' + text.slice(caret);
    setText(next);
    setSuggestions([]);
    requestAnimationFrame(() => {
      const pos = token.start + suggestion.insert.length + 1;
      el.setSelectionRange(pos, pos);
      el.focus();
      autogrow();
    });
  };

  const submit = () => {
    if (!text.trim()) return;
    onSend(text);
    setText('');
    setSuggestions([]);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) el.style.height = 'auto';
    });
  };

  return (
    <div class={`composer ${running ? 'running' : ''}`}>
      {suggestions.length > 0 && (
        <div class="suggest-popup">
          {suggestions.map((s, i) => (
            <div
              key={s.insert}
              class={`suggest-row ${i === activeIndex ? 'active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                accept(s);
              }}
              onMouseEnter={() => setActiveIndex(i)}
            >
              {s.provider && (
                <span class="suggest-brand">
                  <BrandMark provider={s.provider} size={11} />
                </span>
              )}
              <span class="suggest-label">{s.label}</span>
              {s.detail && <span class="suggest-detail">{s.detail}</span>}
            </div>
          ))}
          <div class="suggest-hint">↑↓ navigate · Tab/Enter select · Esc dismiss</div>
        </div>
      )}
      <textarea
        ref={textareaRef}
        value={text}
        placeholder={
          accounts.length === 0
            ? 'No accounts yet — add one to start'
            : running
              ? 'Task running… Enter queues your next message · Esc stops'
              : 'Describe the task…  @ account · # tag · / command'
        }
        rows={2}
        onInput={(e) => {
          const el = e.target as HTMLTextAreaElement;
          setText(el.value);
          refreshSuggestions(el.value, el.selectionStart ?? el.value.length);
          autogrow();
        }}
        onKeyDown={(e) => {
          if (suggestions.length > 0) {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActiveIndex((activeIndex + 1) % suggestions.length);
              return;
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActiveIndex((activeIndex - 1 + suggestions.length) % suggestions.length);
              return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault();
              accept(suggestions[activeIndex]!);
              return;
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              setSuggestions([]);
              return;
            }
          }
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          } else if (e.key === 'Escape' && running) {
            e.preventDefault();
            onCancel();
          }
        }}
        onBlur={() => setTimeout(() => setSuggestions([]), 150)}
      />
      <div class="composer-bar">
        <div class="account-strip">
          {accounts.map((a) => (
            <button
              key={a.id}
              class={`account-pill ${a.available ? '' : 'limited'}`}
              title={
                a.available
                  ? (a.usage ?? []).map((u) => `${u.utilizationPct}% of ${u.label}`).join(' · ') ||
                    'ready — click to route explicitly'
                  : `limited${a.resetAt ? ` · resets ${new Date(a.resetAt).toLocaleTimeString()}` : ''}`
              }
              onClick={() => {
                const mention = `@${a.provider}:${a.label} `;
                setText((prev) => (prev.startsWith(mention.trim()) ? prev : mention + prev));
                textareaRef.current?.focus();
              }}
            >
              <BrandMark provider={a.provider} size={11} />
              {a.label}
              {(a.usage ?? []).length > 0 ? (
                <span class="pill-pct">{Math.max(...a.usage!.map((u) => u.utilizationPct))}%</span>
              ) : (
                <span class={`dot ${a.available ? 'ok' : 'off'}`} />
              )}
            </button>
          ))}
        </div>
        {running ? (
          <button class="run-btn stop" title="Stop (Esc)" onClick={onCancel}>
            <IconStop size={12} /> Stop
          </button>
        ) : (
          <button
            class="run-btn send"
            title="Send (Enter)"
            disabled={!text.trim() || accounts.length === 0}
            onClick={submit}
          >
            <IconSend size={12} /> Send
          </button>
        )}
      </div>
    </div>
  );
}
