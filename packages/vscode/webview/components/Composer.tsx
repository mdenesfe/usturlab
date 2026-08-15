import { useEffect, useRef, useState } from 'preact/hooks';
// Deep import: the core barrel pulls node built-ins the browser bundle can't take.
import { SLASH_COMMANDS, type SlashCommand } from '../../../core/src/commands/slashCommands.js';
import type { AccountStatusDto } from '../../src/panel/protocol.js';
import { IconPlus, IconSend, IconStop } from './icons.js';
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
      // A review-only account cannot be routed to, so offering it as a mention
      // would only produce a target the router refuses.
      .filter((a) => !a.reviewOnly && `${a.provider}:${a.label}`.toLowerCase().includes(q))
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

/*
 * Three levels, and they are levels: each one allows strictly more than the
 * one above it. What separates Edit from Full is the sandbox each CLI is
 * started with, so the hints name that rather than both saying "accepts
 * things automatically".
 */
const PERMISSION_MODES: Array<{ id: string; label: string; hint: string }> = [
  { id: 'safe', label: 'Plan', hint: 'Reads and proposes. Changes nothing, runs nothing.' },
  { id: 'edits', label: 'Edit', hint: 'Edits files in this workspace and runs commands inside it.' },
  { id: 'full', label: 'Full', hint: 'No sandbox and no approvals — it can reach outside the workspace.' },
];

const ROUTING_MODES: Array<{ id: 'auto' | 'manual'; label: string; hint: string }> = [
  { id: 'auto', label: 'Auto', hint: 'Reads the task and picks the model. Rules always win.' },
  { id: 'manual', label: 'Manual', hint: 'Follows your chain in order, without judging the task.' },
];

/**
 * The three switches behind one word.
 *
 * They are three separate axes and the menu has to say so. Asking before each
 * step was listed as a fourth permission level, which made it look like an
 * alternative to Plan/Edit/Full — it is not: it sits on top of whichever level
 * is set, and choosing it used to hide which one that was. It is a toggle now,
 * and it says when it does nothing: Full skips approvals by definition, so
 * there is nothing left to ask about.
 */
function ModeMenu({
  permissionMode,
  askPermission,
  routingMode,
  onModeChange,
}: {
  permissionMode: string;
  askPermission: boolean;
  routingMode: 'auto' | 'manual';
  onModeChange: (modes: {
    permissionMode?: string;
    routingMode?: 'auto' | 'manual';
    ask?: boolean;
  }) => void;
}) {
  const [open, setOpen] = useState(false);
  const label = PERMISSION_MODES.find((m) => m.id === permissionMode)?.label ?? permissionMode;
  // Full ignores it — the run is unattended by definition.
  const asking = askPermission && permissionMode !== 'full';

  return (
    <div class="mode-menu" onBlur={() => setTimeout(() => setOpen(false), 120)}>
      <button
        class={`mode-btn ${open ? 'open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="What the model may do, whether it asks first, and how it is routed"
        onClick={() => setOpen((v) => !v)}
      >
        {label}
        {/* Only what you changed away from the default earns a word here. */}
        {asking && <span class="mode-extra">ask</span>}
        {routingMode === 'manual' && <span class="mode-extra">manual</span>}
      </button>
      {open && (
        <div class="menu-popup" role="menu" onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
          <div class="menu-label">the model may</div>
          {PERMISSION_MODES.map((m) => (
            <button
              key={m.id}
              class={`menu-row ${permissionMode === m.id ? 'on' : ''}`}
              role="menuitemradio"
              aria-checked={permissionMode === m.id}
              title={m.hint}
              onClick={() => {
                onModeChange({ permissionMode: m.id });
                setOpen(false);
              }}
            >
              <span class="menu-name">{m.label}</span>
              <span class="menu-hint">{m.hint}</span>
            </button>
          ))}
          {/* Not a fourth level: it rides on top of the one above. */}
          <button
            class={`menu-row toggle ${asking ? 'on' : ''} ${permissionMode === 'full' ? 'inert' : ''}`}
            role="menuitemcheckbox"
            aria-checked={asking}
            onClick={() => {
              onModeChange({ ask: !askPermission });
              setOpen(false);
            }}
          >
            <span class="menu-name">
              <span class="menu-check">{asking ? '✓' : ''}</span> ask before each step
            </span>
            <span class="menu-hint">
              {permissionMode === 'full'
                ? 'Full has no approvals to stop at — set Plan or Edit for this to apply.'
                : 'Stops on every command and file change, on every provider. Reads never interrupt you.'}
            </span>
          </button>
          <div class="menu-label">routing</div>
          {ROUTING_MODES.map((m) => (
            <button
              key={m.id}
              class={`menu-row ${routingMode === m.id ? 'on' : ''}`}
              role="menuitemradio"
              aria-checked={routingMode === m.id}
              title={m.hint}
              onClick={() => {
                onModeChange({ routingMode: m.id });
                setOpen(false);
              }}
            >
              <span class="menu-name">{m.label}</span>
              <span class="menu-hint">{m.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Composer({
  accounts,
  tags,
  customCommands = [],
  running,
  permissionMode,
  askPermission,
  routingMode,
  attachments,
  onSend,
  onCancel,
  onModeChange,
  onPickAttachments,
  onRemoveAttachment,
}: {
  accounts: AccountStatusDto[];
  tags: string[];
  customCommands?: SlashCommand[];
  running: boolean;
  permissionMode: string;
  askPermission: boolean;
  routingMode: 'auto' | 'manual';
  attachments: string[];
  onSend: (text: string) => void;
  onCancel: () => void;
  onModeChange: (modes: {
    permissionMode?: string;
    routingMode?: 'auto' | 'manual';
    /** Whether to stop and ask — orthogonal to the permission level. */
    ask?: boolean;
  }) => void;
  onPickAttachments: () => void;
  onRemoveAttachment: (path: string) => void;
}) {
  const allCommands = [...customCommands, ...SLASH_COMMANDS];
  // Accounts that can actually be given a task — a reviewer is connected but
  // never routed to, so it must not make the composer look ready when it is not.
  const routable = accounts.filter((a) => !a.reviewOnly);
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
          routable.length === 0
            ? accounts.length === 0
              ? 'No accounts yet — add one to start'
              : 'Only a reviewer account is connected — add one that can do the work'
            : running
              ? 'Running… Esc stops'
              : 'Describe the task…'
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
      {attachments.length > 0 && (
        <div class="attachment-strip">
          {attachments.map((path) => (
            <span key={path} class="attachment-chip" title={path}>
              {path.split('/').pop()}
              <button
                class="attachment-x"
                title="Remove"
                onClick={() => onRemoveAttachment(path)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div class="composer-bar">
        <button
          class="icon-btn attach-btn"
          title="Attach files"
          aria-label="Attach files"
          onClick={onPickAttachments}
        >
          <IconPlus size={13} />
        </button>
        <ModeMenu
          permissionMode={permissionMode}
          askPermission={askPermission}
          routingMode={routingMode}
          onModeChange={onModeChange}
        />
        {/*
          Which account gets the work is the router's job, and typing @ still
          overrides it. A row of pills only restated what the accounts tab
          already says, and grew a line taller with every account added.
        */}
        <span class="bar-gap" />
        {running ? (
          <button class="run-btn stop" title="Stop (Esc)" onClick={onCancel}>
            <IconStop size={12} /> Stop
          </button>
        ) : (
          <button
            class="run-btn send"
            title="Send (Enter)"
            disabled={!text.trim() || routable.length === 0}
            onClick={submit}
          >
            <IconSend size={12} /> Send
          </button>
        )}
      </div>
    </div>
  );
}
