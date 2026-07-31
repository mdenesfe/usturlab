import type { Target } from '@usrouter/core';
import { Markdown } from './Markdown.js';
import { RoutingBadge } from './RoutingBadge.js';
import { IconRoute } from './icons.js';

export type TranscriptItem =
  | { kind: 'user'; text: string }
  | {
      kind: 'assistant';
      messageId: string;
      text: string;
      tools: string[];
      done: boolean;
      target?: Target;
      ruleId?: string;
      reason?: string;
      costUsd?: number;
    }
  | { kind: 'failover'; text: string }
  | { kind: 'notice'; text: string }
  | { kind: 'error'; text: string };

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
            <IconRoute size={22} />
            <span>usrouter</span>
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
                  <code>.usrouter/rules.json</code> edit routing rules
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
                <span class="msg-user-mark">❯</span>
                <span class="msg-user-text">{item.text}</span>
              </div>
            );
          case 'assistant':
            return (
              <div key={i} class="msg-assistant">
                {item.target && (
                  <RoutingBadge target={item.target} ruleId={item.ruleId} reason={item.reason} />
                )}
                {item.tools.length > 0 && (
                  <div class="tools">
                    {item.tools.map((t, j) => (
                      <span key={j} class="tool-chip" title={t}>
                        {t}
                      </span>
                    ))}
                  </div>
                )}
                {item.text ? (
                  <Markdown text={item.text} />
                ) : !item.done ? (
                  <span class="thinking">thinking</span>
                ) : null}
                {item.done && item.costUsd !== undefined && (
                  <div
                    class="cost"
                    title="API-equivalent value — subscription usage is not billed per request"
                  >
                    ≈ ${item.costUsd.toFixed(4)}
                  </div>
                )}
              </div>
            );
          case 'failover':
            return (
              <div key={i} class="divider failover">
                <span>{item.text}</span>
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
