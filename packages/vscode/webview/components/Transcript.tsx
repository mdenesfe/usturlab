import type { Segment, ToolStep, TranscriptItem } from '../../src/panel/transcript.js';
import type { PermissionDecision } from '../../../core/src/adapters/permission.js';
import { formatCost } from '../../../core/src/accounts/billing.js';
import { Markdown } from './Markdown.js';
import { IconUsturlab } from './icons.js';
import { BRAND_COLOR, BrandMark, PROVIDER_NAME } from './brandIcons.js';
import { assistantText } from '../../src/panel/transcript.js';
import { AgentLanes } from './AgentLanes.js';
import { CopyButton } from './CopyButton.js';
import {
  LiveDots,
  ToolStepRow,
  fileName,
  summarizeSteps,
  touchedFiles,
  useAutoOpen,
} from './steps.js';

/**
 * Collapsible timeline entry for consecutive tool activity. It opens itself
 * while the work is live — watching the model work is the point, and a closed
 * box that says "3 steps" hides exactly what you came to see.
 */
function ToolGroup({ steps, running }: { steps: ToolStep[]; running: boolean }) {
  const latest = steps[steps.length - 1];
  const files = touchedFiles(steps);
  const { open, onSummaryClick } = useAutoOpen(running);
  return (
    <details class={`tool-group ${running ? 'live' : ''}`} open={open}>
      <summary class="tool-summary" onClick={onSummaryClick}>
        <span class="tool-count">
          {steps.length} step{steps.length > 1 ? 's' : ''}
        </span>
        <span class="tool-names">{summarizeSteps(steps)}</span>
        {running && latest ? (
          <span class="tool-running">
            {latest.path ? fileName(latest.path) : latest.name}
            <LiveDots />
          </span>
        ) : (
          files.length > 0 && (
            <span class="tool-files" title={steps.map((s) => s.path).filter(Boolean).join('\n')}>
              {files.slice(0, 3).join(' · ')}
              {files.length > 3 ? ` +${files.length - 3}` : ''}
            </span>
          )
        )}
      </summary>
      <div class="tool-steps">
        {steps.map((step, i) => (
          <ToolStepRow key={i} step={step} />
        ))}
      </div>
    </details>
  );
}

const KIND_GLYPH: Record<string, string> = {
  command: '❯',
  edit: '✎',
  read: '◇',
  network: '↓',
  other: '·',
};

/**
 * The model is stopped until this is answered, so it reads as a question with
 * buttons rather than a notice. "Always" is offered per kind of action, not
 * blanket — allowing `git status` should never allow `rm`.
 */
function PermissionCard({
  item,
  onDecide,
}: {
  item: Extract<TranscriptItem, { kind: 'permission' }>;
  onDecide?: (id: string, decision: PermissionDecision) => void;
}) {
  const { request } = item;
  if (item.answered) {
    return (
      <div class={`permission-block answered ${item.allowed ? 'allowed' : 'denied'}`}>
        <span class="permission-mark">{item.allowed ? '✓' : '✕'}</span>
        <span class="permission-title">{request.title}</span>
        <span class="permission-verdict">{item.allowed ? 'allowed' : 'denied'}</span>
      </div>
    );
  }
  return (
    // The model is blocked on this, so it must be announced, not just drawn.
    <div class="permission-block pending" role="alertdialog" aria-label={request.title}>
      <div class="permission-head">
        <span class={`permission-kind ${request.kind}`}>{KIND_GLYPH[request.kind] ?? '·'}</span>
        <span class="permission-title">{request.title}</span>
        {item.target && (
          <span class="permission-by" style={{ color: BRAND_COLOR[item.target.provider] }}>
            {item.target.provider}:{item.target.account}
          </span>
        )}
      </div>
      {request.detail && <pre class="permission-detail">{request.detail}</pre>}
      <div class="permission-actions">
        <button class="perm-btn allow" onClick={() => onDecide?.(request.id, { outcome: 'allow' })}>
          Allow
        </button>
        <button
          class="perm-btn always"
          title={
            request.kind === 'command'
              ? 'Allows this command for the rest of the conversation — not every command'
              : `Allows ${request.kind} actions for the rest of the conversation`
          }
          onClick={() => onDecide?.(request.id, { outcome: 'allow-always' })}
        >
          Always
        </button>
        <button class="perm-btn deny" onClick={() => onDecide?.(request.id, { outcome: 'deny' })}>
          Deny
        </button>
      </div>
    </div>
  );
}

export function Transcript({
  items,
  noAccounts,
  running,
  onAddAccount,
  onPermission,
  onRetry,
}: {
  items: TranscriptItem[];
  noAccounts?: boolean;
  /** Whether the conversation is still running — an agent cannot outlive it. */
  running?: boolean;
  onAddAccount?: () => void;
  onPermission?: (id: string, decision: PermissionDecision) => void;
  onRetry?: () => void;
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
    // A log rather than a live region: announcing every streamed token would
    // make a screen reader unusable. The work bar carries the live state.
    <div class="transcript" role="log" aria-label="Conversation" aria-busy={running === true}>
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
            const answer = assistantText(item).trim();
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
                        title={
                          item.metered
                            ? 'Billed to this account at list price'
                            : 'What these tokens would have cost on the API. This account is a subscription — nothing was charged for this run.'
                        }
                      >
                        · {formatCost(item.costUsd, item.metered)}
                      </span>
                    )}
                    {answer && (
                      <CopyButton text={answer} label="Copy answer" className="answer-copy" />
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
                  if (segment.kind === 'agents') {
                    return <AgentLanes key={j} lanes={segment.lanes} live={running === true} />;
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
                {item.stopped && (
                  <div class="assistant-stopped">⊘ {item.stoppedReason ?? 'stopped'}</div>
                )}
              </div>
            );
          }
          case 'tasks': {
            const done = item.items.filter((t) => t.status === 'done').length;
            const active = item.items.find((t) => t.status === 'active');
            return (
              <details key={i} class="task-block" open={!!active}>
                <summary class="task-summary">
                  <span class="task-label">tasks</span>
                  <span class="task-count">
                    {done}/{item.items.length}
                  </span>
                  <span class="task-bar">
                    <span
                      class="task-fill"
                      style={{ width: `${(done / Math.max(item.items.length, 1)) * 100}%` }}
                    />
                  </span>
                  {active && <span class="task-current">{active.text}</span>}
                </summary>
                <ol class="task-items">
                  {item.items.map((task, j) => (
                    <li key={j} class={`task-item ${task.status}`}>
                      <span class="task-mark">
                        {task.status === 'done' ? '✓' : task.status === 'active' ? '▸' : '○'}
                      </span>
                      <span class="task-text">{task.text}</span>
                    </li>
                  ))}
                </ol>
              </details>
            );
          }
          case 'permission':
            return <PermissionCard key={i} item={item} onDecide={onPermission} />;
          case 'review':
            return (
              <details key={i} class="review-block">
                <summary class="review-summary">
                  <span class="review-badge">review</span>
                  <span class="review-by">{item.by}</span>
                  <span class="review-hint">found something worth checking</span>
                </summary>
                <div class="review-body">
                  <Markdown text={item.text} />
                </div>
              </details>
            );
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
              <div key={i} class="msg-error" role="alert">
                <span class="msg-error-text">{item.text}</span>
                {/* Only the failure you are actually looking at is worth
                    offering to redo; older ones are history. */}
                {i === items.length - 1 && onRetry && !running && (
                  <button class="retry-btn" onClick={onRetry} title="Send your last message again">
                    ↻ Retry
                  </button>
                )}
              </div>
            );
        }
      })}
    </div>
  );
}
