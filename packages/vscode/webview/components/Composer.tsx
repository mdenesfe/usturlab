import { useRef, useState } from 'preact/hooks';
import type { AccountStatusDto } from '../../src/panel/protocol.js';
import { IconSend, IconStop } from './icons.js';

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

  const submit = () => {
    if (!text.trim() || running) return;
    onSend(text);
    setText('');
  };

  const insertMention = (account: AccountStatusDto) => {
    const mention = `@${account.provider}:${account.label} `;
    setText((prev) => (prev.startsWith(mention.trim()) ? prev : mention + prev));
    textareaRef.current?.focus();
  };

  return (
    <div class="composer">
      <textarea
        ref={textareaRef}
        value={text}
        placeholder={
          accounts.length === 0
            ? 'No accounts yet — run "usrouter: Add Account"'
            : 'Describe the task…  (@account routes explicitly, #tag triggers rules)'
        }
        disabled={running}
        rows={3}
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
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
                    'ready · click to route explicitly'
                  : `limited${a.resetAt ? ` · resets ${new Date(a.resetAt).toLocaleTimeString()}` : ''}`
              }
              onClick={() => insertMention(a)}
            >
              <span class={`dot ${a.available ? 'ok' : 'off'}`} />
              {a.provider}:{a.label}
            </button>
          ))}
        </div>
        {running ? (
          <button class="run-btn stop" title="Stop" onClick={onCancel}>
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
