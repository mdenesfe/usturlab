import type { Segment, TranscriptItem } from '../../src/panel/transcript.js';
import type { PermissionDecision } from '../../../core/src/adapters/permission.js';
import { formatCost } from '../../../core/src/accounts/billing.js';
import { Markdown } from './Markdown.js';
import { IconUsturlab } from './icons.js';
import { BRAND_COLOR, BrandMark, PROVIDER_NAME } from './brandIcons.js';
import { assistantText } from '../../src/panel/transcript.js';
import { AgentLanes } from './AgentLanes.js';
import { CopyButton } from './CopyButton.js';
import { useEffect, useState } from 'preact/hooks';
import { LiveDots, ToolStepRow, fileName, formatDuration, useAutoOpen } from './steps.js';

/**
 * What the run is doing, and how long it has been doing it — once.
 *
 * The state was being drawn twice: a `thinking` row where the answer was going
 * to appear, and a pinned bar saying the same word again above the composer.
 * It belongs where you are already looking, at the head of the reply being
 * written, and it carries the clock so nothing else has to.
 */
function LiveState({ items, startedAt }: { items: TranscriptItem[]; startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // A pending question outranks everything: nothing is running until it is
  // answered. Only one raised since the latest reply counts — an older one was
  // left behind by a run that already ended.
  let blocked = false;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind === 'permission' && !item.answered) {
      blocked = true;
      break;
    }
    if (item?.kind === 'assistant') break;
  }
  const last = [...items].reverse().find((item) => item.kind === 'assistant');
  const segments = last?.kind === 'assistant' ? last.segments : [];
  const agents = segments
    .flatMap((s) => (s.kind === 'agents' ? s.lanes : []))
    .filter((lane) => lane.status === 'running').length;
  const tail = segments[segments.length - 1];

  const label = blocked
    ? 'waiting for you'
    : agents > 0
      ? `${agents} agent${agents === 1 ? '' : 's'}`
      : tail?.kind === 'text'
        ? 'writing'
        : tail?.kind === 'tools'
          ? 'working'
          : 'thinking';

  return (
    // The transcript is a log, so this is the one place a screen reader is told
    // what is going on — state changes only, never the streamed text.
    <span class={`live-state ${blocked ? 'blocked' : ''}`} role="status">
      <span class="live-label">{label}</span>
      {!blocked && <LiveDots />}
      <span class="live-time">{formatDuration(Math.max(0, now - startedAt))}</span>
    </span>
  );
}

/**
 * Everything the model did to produce the answer, on one line.
 *
 * The work is not the point — the answer is. Files read, commands run and
 * subagents dispatched collapse into a single count that opens when you
 * actually want it. While the run is live the line names what is happening
 * right now, so nothing feels frozen, and the work bar carries the rest.
 */
function Activity({ segments, live }: { segments: Segment[]; live: boolean }) {
  const { open, onSummaryClick } = useAutoOpen(false);
  const steps = segments.flatMap((s) => (s.kind === 'tools' ? s.steps : []));
  const lanes = segments.flatMap((s) => (s.kind === 'agents' ? s.lanes : []));
  if (steps.length === 0 && lanes.length === 0) return null;

  const counts = [
    steps.length > 0 ? `${steps.length} step${steps.length > 1 ? 's' : ''}` : undefined,
    lanes.length > 0 ? `${lanes.length} agent${lanes.length > 1 ? 's' : ''}` : undefined,
  ].filter(Boolean);
  const latest = steps[steps.length - 1];

  return (
    <details class="activity" open={open}>
      <summary class="activity-summary" onClick={onSummaryClick}>
        {live && latest ? (
          <span class="activity-now">
            {latest.path ? fileName(latest.path) : latest.name}
            <LiveDots />
          </span>
        ) : (
          <span class="activity-count">{counts.join(' · ')}</span>
        )}
      </summary>
      <div class="activity-body">
        {segments.map((segment, i) => {
          if (segment.kind === 'tools') {
            return (
              <div key={i} class="tool-steps">
                {segment.steps.map((step, j) => (
                  <ToolStepRow key={j} step={step} />
                ))}
              </div>
            );
          }
          if (segment.kind === 'agents') return <AgentLanes key={i} lanes={segment.lanes} live={live} />;
          return null;
        })}
      </div>
    </details>
  );
}

/**
 * The model's checklist, closed. The summary carries what you actually need
 * mid-run — how far along it is and what it is on — and the rows themselves
 * are one click away for when you want them.
 */
function TaskGroup({ item }: { item: Extract<TranscriptItem, { kind: 'tasks' }> }) {
  const done = item.items.filter((t) => t.status === 'done').length;
  const active = item.items.find((t) => t.status === 'active');
  const { open, onSummaryClick } = useAutoOpen(false);
  return (
    <details class={`tl tl-tasks ${active ? 'tl-live' : ''} task-block`} open={open}>
      <summary class="task-summary" onClick={onSummaryClick}>
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
      <div class={`tl tl-permission permission-block answered ${item.allowed ? 'allowed' : 'denied'}`}>
        <span class="permission-mark">{item.allowed ? '✓' : '✕'}</span>
        <span class="permission-title">{request.title}</span>
        <span class="permission-verdict">{item.allowed ? 'allowed' : 'denied'}</span>
      </div>
    );
  }
  return (
    // The model is blocked on this, so it must be announced, not just drawn.
    <div
      class="tl tl-permission pending permission-block"
      role="alertdialog"
      aria-label={request.title}
    >
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
  startedAt = 0,
  onAddAccount,
  onPermission,
  onRetry,
}: {
  items: TranscriptItem[];
  noAccounts?: boolean;
  /** Whether the conversation is still running — an agent cannot outlive it. */
  running?: boolean;
  /** When the current run began, for the clock on the reply being written. */
  startedAt?: number;
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
              // The dot and the dimmer type are enough to say who is speaking;
              // the word is kept for anyone listening rather than looking.
              <div key={i} class="tl tl-user">
                <div class="sr-only">you</div>
                <div class="tl-user-text">{item.text}</div>
              </div>
            );
          case 'assistant': {
            const provider = item.target?.provider;
            const color = provider ? BRAND_COLOR[provider] : undefined;
            const answer = assistantText(item).trim();
            // The cursor belongs on the prose being typed, which is not always
            // the last segment — a tool call can land after it.
            const lastTextIndex = item.segments.reduce(
              (found, segment, j) => (segment.kind === 'text' ? j : found),
              -1,
            );
            return (
              // The dot on the rail is the account's own colour, so a run that
              // failed over reads as two providers at a glance.
              <div
                key={i}
                class={`tl tl-assistant ${item.done ? '' : 'tl-live'}`}
                style={color ? `--dot:${color}` : undefined}
              >
                {item.target && provider && (
                  <div class="assistant-head">
                    <span title={PROVIDER_NAME[provider]} class="assistant-mark">
                      <BrandMark provider={provider} size={13} />
                    </span>
                    {/* The rail dot already carries the account's colour, so the
                        name itself does not need to be painted too. */}
                    <span class="assistant-name">{item.target.account}</span>
                    {!item.done && running && startedAt > 0 && (
                      <LiveState items={items} startedAt={startedAt} />
                    )}
                    <span class="assistant-meta" title={item.ruleId ? `rule: ${item.ruleId}` : undefined}>
                      {item.target.model ? `· ${item.target.model} ` : ''}
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
                {/* The answer, uninterrupted — what the model did to get here
                    is one line below it rather than spliced through it. */}
                {item.segments.map((segment, j) => {
                  if (segment.kind !== 'text') return null;
                  return (
                    <div key={j} class="assistant-body">
                      <Markdown text={segment.text} />
                      {!item.done && j === lastTextIndex && <span class="type-cursor" />}
                    </div>
                  );
                })}
                <Activity segments={item.segments} live={!item.done} />
                {item.stopped && (
                  <div class="assistant-stopped">⊘ {item.stoppedReason ?? 'stopped'}</div>
                )}
              </div>
            );
          }
          case 'tasks':
            return <TaskGroup key={i} item={item} />;
          case 'permission':
            return <PermissionCard key={i} item={item} onDecide={onPermission} />;
          case 'review':
            return (
              <details key={i} class="tl tl-review review-block">
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
              <div key={i} class="tl tl-failover failover-banner">
                ⚡ {item.text}
              </div>
            );
          case 'notice':
            return (
              <div key={i} class="tl tl-notice">
                <span>{item.text}</span>
              </div>
            );
          case 'error':
            return (
              <div key={i} class="tl tl-error msg-error" role="alert">
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
