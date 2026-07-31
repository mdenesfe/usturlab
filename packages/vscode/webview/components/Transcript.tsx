import type { Segment, ToolStep, TranscriptItem } from '../../src/panel/transcript.js';
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

/** "Bash ×36 · Read ×5 · Agent" style summary of a tool group. */
function summarizeSteps(steps: ToolStep[]): string {
  const counts = new Map<string, number>();
  for (const step of steps) counts.set(step.name, (counts.get(step.name) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([name, n]) => (n > 1 ? `${name} ×${n}` : name))
    .join(' · ');
}

/** Collapsible timeline entry for consecutive tool activity. */
function ToolGroup({ steps, running }: { steps: ToolStep[]; running: boolean }) {
  const latest = steps[steps.length - 1];
  return (
    <details class="tool-group">
      <summary class="tool-summary">
        <span class={`tool-gear ${running ? 'spin' : ''}`}>⚙</span>
        <span class="tool-count">
          {steps.length} step{steps.length > 1 ? 's' : ''}
        </span>
        <span class="tool-names">{summarizeSteps(steps)}</span>
        {running && latest && (
          <span class="tool-running">
            {latest.name}
            <LiveDots />
          </span>
        )}
      </summary>
      <div class="tool-steps">
        {steps.map((step, i) => (
          <div key={i} class="tool-step">
            <span class="tool-step-name">{step.name}</span>
            {step.detail && <code class="tool-step-detail">{step.detail}</code>}
          </div>
        ))}
      </div>
    </details>
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
            const lastSegment: Segment | undefined = item.segments[item.segments.length - 1];
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
                {item.segments.map((segment, j) => {
                  const isLast = j === item.segments.length - 1;
                  if (segment.kind === 'tools') {
                    return (
                      <ToolGroup key={j} steps={segment.steps} running={!item.done && isLast} />
                    );
                  }
                  return (
                    <div key={j} class="assistant-body">
                      <Markdown text={segment.text} />
                      {!item.done && isLast && <span class="type-cursor" />}
                    </div>
                  );
                })}
                {!item.done && !lastSegment && (
                  <div class="thinking-row">
                    thinking
                    <LiveDots />
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
