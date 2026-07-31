import type { TranscriptItem } from '../../src/panel/transcript.js';
import { Markdown } from './Markdown.js';
import { IconUsturlab } from './icons.js';
import { BRAND_COLOR, BrandMark, PROVIDER_NAME } from './brandIcons.js';

function LiveDots() {
  return (
    <span class="live-dots">
      <i />
      <i />
      <i />
    </span>
  );
}

export function Transcript({
  items,
  noAccounts,
  onAddAccount,
}: {
  items: TranscriptItem[];
  noAccounts?: boolean;
  onAddAccount?: () => void;
}) {
  if (items.length === 0) {
    return (
      <div class="transcript empty">
        <div class="empty-box">
          <div class="empty-logo">
            <IconUsturlab size={22} />
            <span>usturlab</span>
          </div>
          {noAccounts ? (
            <>
              <div class="empty-line">
                Connect your AI subscriptions — multiple Claude accounts, Codex, Gemini, Copilot —
                and every task is routed to the best one.
              </div>
              <button class="run-btn send empty-cta" onClick={onAddAccount}>
                Add your first account
              </button>
            </>
          ) : (
            <>
              <div class="empty-line">Route every task to the best subscription you own.</div>
              <div class="empty-hints">
                <div>
                  <code>@claude:work/opus</code> route explicitly
                </div>
                <div>
                  <code>#tests</code> trigger tag rules
                </div>
                <div>
                  <code>/review</code> commands run on every model
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }
  return (
    <div class="transcript">
      {items.map((item, i) => {
        switch (item.kind) {
          case 'user':
            return (
              <div key={i} class="msg-user">
                <div class="msg-user-label">you</div>
                <div class="msg-user-text">{item.text}</div>
              </div>
            );
          case 'assistant': {
            const provider = item.target?.provider;
            const color = provider ? BRAND_COLOR[provider] : undefined;
            return (
              <div
                key={i}
                class="msg-assistant"
                style={
                  color
                    ? { background: `color-mix(in srgb, ${color} 6%, transparent)` }
                    : undefined
                }
              >
                {item.target && provider && (
                  <div class="assistant-head">
                    <span title={PROVIDER_NAME[provider]} class="assistant-mark">
                      <BrandMark provider={provider} size={13} />
                    </span>
                    <span class="assistant-name" style={{ color }}>
                      {item.target.account}
                    </span>
                    <span class="assistant-meta">
                      {item.target.model ? `· ${item.target.model} ` : ''}
                      {item.ruleId ? `· ${item.ruleId} ` : ''}
                      {item.done && item.durationMs !== undefined
                        ? `· ${(item.durationMs / 1000).toFixed(1)}s`
                        : ''}
                    </span>
                    {item.done && item.costUsd !== undefined && (
                      <span
                        class="assistant-meta"
                        title="API-equivalent value — subscription usage is not billed per request"
                      >
                        · ≈${item.costUsd.toFixed(2)}
                      </span>
                    )}
                  </div>
                )}
                {item.tools.length > 0 && (
                  <div class="tools-line" title={item.tools.join('\n')}>
                    ⚙ {item.tools.join(' · ')}
                  </div>
                )}
                {item.text ? (
                  <div class="assistant-body">
                    <Markdown text={item.text} />
                    {!item.done && <span class="type-cursor" />}
                  </div>
                ) : !item.done ? (
                  <div class="thinking-row">
                    thinking
                    <LiveDots />
                  </div>
                ) : null}
              </div>
            );
          }
          case 'failover':
            return (
              <div key={i} class="failover-banner">
                ⚡ {item.text}
              </div>
            );
          case 'notice':
            return (
              <div key={i} class="divider notice">
                <span>{item.text}</span>
              </div>
            );
          case 'error':
            return (
              <div key={i} class="msg-error">
                {item.text}
              </div>
            );
        }
      })}
    </div>
  );
}
