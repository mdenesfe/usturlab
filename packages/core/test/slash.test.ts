import { describe, expect, it } from 'vitest';
import {
  SLASH_COMMANDS,
  expandSlashCommand,
  matchSlashCommand,
} from '../src/commands/slashCommands.js';

describe('slash commands', () => {
  it('matches a bare command', () => {
    const m = matchSlashCommand('/review');
    expect(m?.cmd.name).toBe('review');
    expect(m?.args).toBe('');
  });

  it('matches a command with arguments', () => {
    const m = matchSlashCommand('/fix the login button crashes on empty input');
    expect(m?.cmd.name).toBe('fix');
    expect(m?.args).toBe('the login button crashes on empty input');
  });

  it('ignores non-commands and unknown commands', () => {
    expect(matchSlashCommand('hello /review')).toBeUndefined();
    expect(matchSlashCommand('/definitely-not-a-command')).toBeUndefined();
    expect(matchSlashCommand('normal prompt')).toBeUndefined();
  });

  it('expands {args} templates', () => {
    const fix = SLASH_COMMANDS.find((c) => c.name === 'fix')!;
    expect(expandSlashCommand(fix, 'null pointer in parser')).toContain('null pointer in parser');
    expect(expandSlashCommand(fix, '')).toContain('the current changes');
  });

  it('appends args as context when the template has no placeholder', () => {
    const review = SLASH_COMMANDS.find((c) => c.name === 'review')!;
    const out = expandSlashCommand(review, 'focus on the auth module');
    expect(out).toContain('git diff');
    expect(out).toContain('focus on the auth module');
  });

  it('claude-native commands are flagged for passthrough', () => {
    for (const name of ['init', 'review', 'security-review']) {
      expect(SLASH_COMMANDS.find((c) => c.name === name)?.claudeNative).toBe(true);
    }
  });

  it('every action command has an action, every prompt command a template', () => {
    for (const cmd of SLASH_COMMANDS) {
      if (cmd.kind === 'action') expect(cmd.action).toBeDefined();
      else expect(cmd.template).toBeTruthy();
    }
  });
});
