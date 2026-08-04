import type { AgentLane } from '../../src/panel/transcript.js';
import { Markdown } from './Markdown.js';
import {
  LiveDots,
  ToolStepRow,
  formatDuration,
  formatTokens,
  summarizeSteps,
  useAutoOpen,
} from './steps.js';

/**
 * Subagents, drawn as concurrent lanes.
 *
 * The one thing this has to communicate is that several agents are working at
 * the same time — a stack of collapsed rows reads as a sequence, so every lane
 * stays visible with its own live state, and the duration bars turn a finished
 * fan-out into a picture of who took how long.
 */

const STATUS_MARK: Record<AgentLane['status'], string> = {
  running: '',
  completed: '✓',
  failed: '✕',
  cancelled: '⊘',
};

const STATUS_TITLE: Record<AgentLane['status'], string> = {
  running: 'still working',
  completed: 'finished',
  failed: 'failed',
  cancelled: 'never reported back — the run ended first',
};

/**
 * A lane's own status is the last thing the provider told us. Whether it is
 * *still* going is a fact about the run: once that has stopped, an agent that
 * never reported back did not finish, and saying "running" forever is a lie
 * the panel would keep telling every time the conversation is reopened.
 */
function effectiveStatus(lane: AgentLane, live: boolean): AgentLane['status'] {
  return lane.status === 'running' && !live ? 'cancelled' : lane.status;
}

/** The first thing its report actually says, short enough for one row. */
function reportedLine(summary: string): string | undefined {
  const line = summary
    .split('\n')
    .map((l) => l.replace(/^[#>*\-\s]+/, '').trim())
    .find(Boolean);
  if (!line) return undefined;
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

function Meta({ lane }: { lane: AgentLane }) {
  const parts: string[] = [];
  if (lane.toolUses !== undefined) parts.push(`${lane.toolUses} tool${lane.toolUses === 1 ? '' : 's'}`);
  if (lane.tokens !== undefined) parts.push(`${formatTokens(lane.tokens)} tok`);
  if (lane.durationMs !== undefined) parts.push(formatDuration(lane.durationMs));
  if (parts.length === 0) return null;
  return <span class="agent-meta">{parts.join(' · ')}</span>;
}

function Lane({ lane, longestMs, status }: { lane: AgentLane; longestMs: number; status: AgentLane['status'] }) {
  const running = status === 'running';
  const { open, onSummaryClick } = useAutoOpen(running);
  const said = lane.summary ? reportedLine(lane.summary) : undefined;
  const hasBody = lane.steps.length > 0 || !!lane.summary || !!lane.prompt;
  // Proportional to the slowest lane, so a finished fan-out shows its own shape.
  const width = running || !lane.durationMs ? 100 : Math.max(4, (lane.durationMs / longestMs) * 100);

  return (
    <details class={`agent-lane ${status}`} open={open && hasBody}>
      {/* The bar lives inside the summary: a closed <details> hides everything
          after it, and a finished lane's length is exactly what you want then. */}
      <summary class="agent-lane-head" onClick={onSummaryClick}>
        <div class="agent-lane-row">
          {/* The dot carries the state in colour alone; this says it in words. */}
          <span class="agent-dot" />
          <span class="sr-only">{STATUS_TITLE[status]}</span>
          {lane.agentKind && <span class="agent-kind">{lane.agentKind}</span>}
          <span class="agent-label" title={lane.prompt ?? lane.label}>
            {lane.label}
          </span>
          {lane.background && (
            <span class="agent-bg" title="Runs without the parent waiting">
              bg
            </span>
          )}
          <span class="agent-right">
            {running ? (
              <>
                {(lane.activity ?? lane.lastTool) && (
                  <span class="agent-now">{lane.activity ?? lane.lastTool}</span>
                )}
                <LiveDots />
              </>
            ) : (
              <>
                {said && (
                  <span class="agent-said" title={lane.summary}>
                    {said}
                  </span>
                )}
                <span class={`agent-verdict ${status}`} title={STATUS_TITLE[status]}>
                  {STATUS_MARK[status]}
                </span>
              </>
            )}
            <Meta lane={lane} />
          </span>
        </div>
        <div class="agent-track">
          <span class={`agent-track-fill ${status}`} style={{ width: `${width}%` }} />
        </div>
      </summary>
      {hasBody && (
        <div class="agent-lane-body">
          {lane.prompt && (
            <details class="agent-prompt">
              <summary class="agent-prompt-head">its instructions</summary>
              <pre class="agent-prompt-text">{lane.prompt}</pre>
            </details>
          )}
          {lane.steps.length > 0 && (
            <div class="agent-steps">
              {lane.steps.map((step, i) => (
                <ToolStepRow key={i} step={step} />
              ))}
            </div>
          )}
          {lane.summary && (
            <div class="agent-report">
              <div class="agent-report-label">reported back</div>
              <Markdown text={lane.summary} />
            </div>
          )}
        </div>
      )}
    </details>
  );
}

export function AgentLanes({ lanes, live = false }: { lanes: AgentLane[]; live?: boolean }) {
  const statuses = lanes.map((lane) => effectiveStatus(lane, live));
  const count = (status: AgentLane['status']) => statuses.filter((s) => s === status).length;
  const running = count('running');
  const finished = count('completed');
  const failed = count('failed');
  const stopped = count('cancelled');
  // Two lanes only ran in parallel if they were open at the same time, which is
  // exactly the rule that put them in this segment.
  const parallel = lanes.length > 1;
  const longestMs = Math.max(1, ...lanes.map((lane) => lane.durationMs ?? 0));

  const state = [
    running > 0 ? `${running} running` : undefined,
    finished > 0 ? `${finished} done` : undefined,
    failed > 0 ? `${failed} failed` : undefined,
    stopped > 0 ? `${stopped} stopped` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');

  const tokens = lanes.reduce((sum, lane) => sum + (lane.tokens ?? 0), 0);
  const tools = lanes.reduce((sum, lane) => sum + (lane.toolUses ?? lane.steps.length), 0);
  const allSteps = lanes.flatMap((lane) => lane.steps);

  return (
    <div class={`agent-fanout ${running > 0 ? 'live' : ''} ${parallel ? 'parallel' : ''}`}>
      <div class="agent-fanout-head">
        <span class="agent-fanout-count">
          {lanes.length} agent{lanes.length > 1 ? 's' : ''}
        </span>
        {parallel && <span class="agent-fanout-mode">in parallel</span>}
        <span class="agent-fanout-state">{state}</span>
        <span class="agent-fanout-total">
          {tools > 0 ? `${tools} tools` : ''}
          {tokens > 0 ? ` · ${formatTokens(tokens)} tok` : ''}
        </span>
      </div>
      <div class="agent-lanes">
        {lanes.map((lane, i) => (
          <Lane key={lane.id} lane={lane} longestMs={longestMs} status={statuses[i]!} />
        ))}
      </div>
      {running === 0 && allSteps.length > 0 && (
        <div class="agent-fanout-foot" title={summarizeSteps(allSteps)}>
          {summarizeSteps(allSteps)}
        </div>
      )}
    </div>
  );
}
