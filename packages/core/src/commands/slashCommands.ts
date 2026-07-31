/**
 * Slash commands, Claude-style but provider-agnostic:
 * - kind 'action': handled by the host UI (open panels, clear chat...)
 * - kind 'prompt': routed to the model. When the target is Claude and the
 *   command is claudeNative, the raw "/name args" passes through so Claude
 *   Code runs its own richer built-in; every other provider gets the
 *   equivalent English template.
 */

export type SlashAction =
  | 'newChat'
  | 'clearChat'
  | 'openAccounts'
  | 'openRules'
  | 'refreshUsage'
  | 'openTerminal';

export interface SlashCommand {
  name: string;
  description: string;
  kind: 'action' | 'prompt';
  action?: SlashAction;
  /** Provider-agnostic prompt; `{args}` is replaced with the user's arguments. */
  template?: string;
  /** Claude Code understands this natively — pass the raw slash text through. */
  claudeNative?: boolean;
  /** Hint shown in the picker, e.g. "/fix <description>". */
  usage?: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: 'init',
    kind: 'prompt',
    claudeNative: true,
    description: 'Analyze the repo and write AGENTS.md/CLAUDE.md docs',
    template:
      'Analyze this repository — structure, build/test/lint commands, architecture, conventions — and create or update an AGENTS.md file documenting how to work in it.',
  },
  {
    name: 'review',
    kind: 'prompt',
    claudeNative: true,
    description: 'Review pending changes for bugs and risks',
    template:
      'Review the pending changes in this repository (inspect git status and git diff) and report bugs, risks and concrete improvements, ranked by severity.',
  },
  {
    name: 'security-review',
    kind: 'prompt',
    claudeNative: true,
    description: 'Security review of pending changes',
    template:
      'Perform a security review of the pending changes (git diff): injection, authorization gaps, secret leaks, unsafe deserialization, SSRF. Report findings with severity and concrete fixes.',
  },
  {
    name: 'commit',
    kind: 'prompt',
    description: 'Commit current changes with a good message',
    template:
      'Stage the appropriate files and create a git commit for the current changes with a clear, well-scoped commit message. Show the result.',
  },
  {
    name: 'test',
    kind: 'prompt',
    description: 'Run the test suite and fix failures',
    template:
      "Run this project's test suite, report any failures, then fix them and re-run until green.",
  },
  {
    name: 'fix',
    kind: 'prompt',
    usage: '/fix <description>',
    description: 'Find and fix an issue',
    template: 'Fix the following issue in this codebase: {args}. Verify the fix.',
  },
  {
    name: 'explain',
    kind: 'prompt',
    usage: '/explain <target>',
    description: 'Explain how code works',
    template: 'Explain how {args} works in this codebase: architecture, data flow and key functions.',
  },
  {
    name: 'refactor',
    kind: 'prompt',
    usage: '/refactor <target>',
    description: 'Refactor without changing behavior',
    template:
      'Refactor {args} to improve clarity and maintainability without changing behavior. Run the tests afterwards if available.',
  },
  {
    name: 'docs',
    kind: 'prompt',
    usage: '/docs <target>',
    description: 'Write or update documentation',
    template: 'Write or update documentation for {args}.',
  },
  {
    name: 'debug',
    kind: 'prompt',
    usage: '/debug <error>',
    description: 'Root-cause and fix a problem',
    template: 'Debug this problem: {args}. Find the root cause, explain it, then fix it.',
  },
  { name: 'new', kind: 'action', action: 'newChat', description: 'Start a new chat' },
  { name: 'clear', kind: 'action', action: 'clearChat', description: 'Clear this conversation' },
  { name: 'accounts', kind: 'action', action: 'openAccounts', description: 'Open the accounts panel' },
  { name: 'rules', kind: 'action', action: 'openRules', description: 'Open routing rules' },
  { name: 'usage', kind: 'action', action: 'refreshUsage', description: 'Refresh usage data' },
  {
    name: 'terminal',
    kind: 'action',
    action: 'openTerminal',
    description: 'Open a routed session in the terminal',
  },
];

export interface SlashMatch {
  cmd: SlashCommand;
  args: string;
}

export function matchSlashCommand(text: string): SlashMatch | undefined {
  const m = /^\/([a-z][a-z-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return undefined;
  const cmd = SLASH_COMMANDS.find((c) => c.name === m[1]);
  return cmd ? { cmd, args: m[2]?.trim() ?? '' } : undefined;
}

export function expandSlashCommand(cmd: SlashCommand, args: string): string {
  let template = cmd.template ?? '';
  if (template.includes('{args}')) {
    return template.replace('{args}', args || 'the current changes');
  }
  return args ? `${template}\n\nAdditional context: ${args}` : template;
}
