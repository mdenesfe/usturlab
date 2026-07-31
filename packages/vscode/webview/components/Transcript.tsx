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
                    ? { borderLeftColor: `color-mix(in srgb, ${color} 55%, transparent)` }
                    : undefined
                }
              >
                {item.target && provider && (
                  <div class="assistant-head">
                    <BrandMark provider={provider} size={14} />
                    <span class="assistant-name" style={{ color }}>
                      {item.target.account}
                    </span>
                    <span class="assistant-meta" title={PROVIDER_NAME[provider]}>
                      {provider}
                      {item.target.model ? ` · ${item.target.model}` : ''}
                    </span>
                    {item.ruleId && (
                      <span class="assistant-meta" title={item.reason}>
                        · {item.ruleId}
                      </span>
                    )}
                  </div>
                )}
                {item.tools.length > 0 && (
                  <div class="tools">
                    {item.tools.map((t, j) => (
                      <span key={j} class="tool-chip" title={t}>
                        ⚙ {t}
                      </span>
                    ))}
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
                {item.done && (item.durationMs !== undefined || item.costUsd !== undefined) && (
                  <div class="assistant-foot">
                    <span class="foot-check">✓</span>
                    {item.durationMs !== undefined && (
                      <span>{(item.durationMs / 1000).toFixed(1)}s</span>
                    )}
                    {item.costUsd !== undefined && (
                      <span title="API-equivalent value — subscription usage is not billed per request">
                        ≈ ${item.costUsd.toFixed(4)}
                      </span>
                    )}
                  </div>
                )}
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
