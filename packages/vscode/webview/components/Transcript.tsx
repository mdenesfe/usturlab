import type { Segment, ToolStep, TranscriptItem } from '../../src/panel/transcript.js';
import type { PermissionDecision } from '../../../core/src/adapters/permission.js';
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

// Deliberately basic glyphs: a webview cannot rely on any icon font.
const ACTION_GLYPH: Record<string, string> = {
  read: '◇',
  write: '✚',
  edit: '✎',
  search: '⌕',
  run: '❯',
  fetch: '↓',
  task: '⚑',
  other: '·',
};

const ACTION_LABEL: Record<string, string> = {
  read: 'read',
  write: 'wrote',
  edit: 'edited',
  search: 'searched',
  run: 'ran',
  fetch: 'fetched',
  task: 'agent',
  other: '',
};

function fileName(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

/**
 * Files the group touched, newest last — the mini preview the collapsed row
 * shows so you can see what happened without opening anything.
 */
function touchedFiles(steps: ToolStep[]): string[] {
  const seen: string[] = [];
  for (const step of steps) {
    if (!step.path) continue;
    const name = fileName(step.path);
    if (!seen.includes(name)) seen.push(name);
  }
  return seen;
}

/** One row: what was done, to which file, expandable to the content itself. */
function ToolStepRow({ step }: { step: ToolStep }) {
  const action = step.action ?? 'other';
  const head = (
    <>
      <span class={`tool-step-action ${action}`} title={ACTION_LABEL[action] || undefined}>
        {ACTION_GLYPH[action] ?? '·'}
      </span>
      <span class="tool-step-name">{step.name}</span>
      <span class="tool-step-detail">{step.detail}</span>
    </>
  );
  if (!step.preview) {
    return <div class="tool-step">{head}</div>;
  }
  return (
    <details class="tool-step expandable">
      <summary class="tool-step-summary">{head}</summary>
      <pre class={`tool-step-preview ${action}`}>
        {action === 'edit'
          ? step.preview.split('\n').map((line, i) => (
              <div
                key={i}
                class={`diff-line ${line.startsWith('-') ? 'del' : line.startsWith('+') ? 'add' : ''}`}
              >
                {line || ' '}
              </div>
            ))
          : step.preview}
      </pre>
    </details>
  );
}

/** Collapsible timeline entry for consecutive tool activity. */
function ToolGroup({ steps, running }: { steps: ToolStep[]; running: boolean }) {
  const latest = steps[steps.length - 1];
  const files = touchedFiles(steps);
  return (
    <details class="tool-group">
      <summary class="tool-summary">
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
    <div class="permission-block pending">
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
  onAddAccount,
  onPermission,
}: {
  items: TranscriptItem[];
  noAccounts?: boolean;
  onAddAccount?: () => void;
  onPermission?: (id: string, decision: PermissionDecision) => void;
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
              <div key={i} class="msg-error">
                {item.text}
              </div>
            );
        }
      })}
    </div>
  );
}
