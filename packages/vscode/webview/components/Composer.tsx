import { useEffect, useRef, useState } from 'preact/hooks';
import type { AccountStatusDto } from '../../src/panel/protocol.js';
import { IconSend, IconStop } from './icons.js';
import { BrandMark } from './brandIcons.js';

const MAX_TEXTAREA_HEIGHT = 180;

export function Composer({
  accounts,
  running,
  onSend,
  onCancel,
}: {
  accounts: AccountStatusDto[];
  running: boolean;
  onSend: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState('');
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

  const submit = () => {
    if (!text.trim() || running) return;
    onSend(text);
    setText('');
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) el.style.height = 'auto';
    });
  };

  const insertMention = (account: AccountStatusDto) => {
    const mention = `@${account.provider}:${account.label} `;
    setText((prev) => (prev.startsWith(mention.trim()) ? prev : mention + prev));
    textareaRef.current?.focus();
  };

  return (
    <div class={`composer ${running ? 'running' : ''}`}>
      <textarea
        ref={textareaRef}
        value={text}
        placeholder={
          accounts.length === 0
            ? 'No accounts yet — add one to start'
            : running
              ? 'Task running… you can draft the next message (Esc stops the task)'
              : 'Describe the task…  (@account routes explicitly, #tag triggers rules)'
        }
        rows={2}
        onInput={(e) => {
          setText((e.target as HTMLTextAreaElement).value);
          autogrow();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          } else if (e.key === 'Escape' && running) {
            e.preventDefault();
            onCancel();
          }
        }}
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
              onClick={() => insertMention(a)}
            >
              <BrandMark provider={a.provider} size={11} />
              {a.label}
              {(a.usage ?? []).length > 0 ? (
                <span class="pill-pct">
                  {Math.max(...a.usage!.map((u) => u.utilizationPct))}%
                </span>
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
