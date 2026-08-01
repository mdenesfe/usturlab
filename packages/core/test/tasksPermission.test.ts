import { describe, expect, it } from 'vitest';
import {
  sameTasks,
  taskProgress,
  tasksFromAcpPlan,
  tasksFromCodexPlan,
  tasksFromTodoWrite,
} from '../src/adapters/taskList.js';
import {
  PermissionGate,
  PermissionMemory,
  acpPermissionKind,
  claudeToolKind,
  codexApprovalKind,
  decideByMode,
  type PermissionRequest,
} from '../src/adapters/permission.js';

describe('task lists from every provider', () => {
  it('reads Claude TodoWrite', () => {
    const items = tasksFromTodoWrite({
      todos: [
        { content: 'read the router', status: 'completed' },
        { content: 'change the bonus', status: 'in_progress' },
        { content: 'add a test', status: 'pending' },
      ],
    });
    expect(items).toEqual([
      { text: 'read the router', status: 'done' },
      { text: 'change the bonus', status: 'active' },
      { text: 'add a test', status: 'pending' },
    ]);
  });

  it('reads a Codex turn plan', () => {
    const items = tasksFromCodexPlan({
      plan: [
        { step: 'inspect autoRoute.ts', status: 'completed' },
        { step: 'edit it', status: 'inProgress' },
      ],
    });
    expect(items).toEqual([
      { text: 'inspect autoRoute.ts', status: 'done' },
      { text: 'edit it', status: 'active' },
    ]);
  });

  it('reads an ACP plan update', () => {
    const items = tasksFromAcpPlan({
      entries: [
        { content: 'find the file', status: 'completed' },
        { content: 'patch it', status: 'in_progress' },
      ],
    });
    expect(items.map((i) => i.status)).toEqual(['done', 'active']);
  });

  it('survives junk without throwing', () => {
    expect(tasksFromTodoWrite(undefined)).toEqual([]);
    expect(tasksFromCodexPlan({ plan: 'nope' })).toEqual([]);
    expect(tasksFromAcpPlan({ entries: [null, 42, { content: '' }] })).toEqual([]);
  });

  it('summarizes progress and detects a no-op update', () => {
    const items = tasksFromTodoWrite({
      todos: [
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'in_progress' },
        { content: 'c', status: 'pending' },
      ],
    });
    expect(taskProgress(items)).toEqual({ done: 1, total: 3, current: 'b' });
    expect(sameTasks(items, [...items])).toBe(true);
    expect(sameTasks(items, items.slice(1))).toBe(false);
  });
});

describe('permission vocabulary', () => {
  it('maps each provider onto the same kinds', () => {
    expect(codexApprovalKind('commandExecution/requestApproval')).toBe('command');
    expect(codexApprovalKind('applyPatch/approval')).toBe('edit');
    expect(codexApprovalKind('turn/completed')).toBeUndefined();
    expect(acpPermissionKind('execute')).toBe('command');
    expect(acpPermissionKind('edit')).toBe('edit');
    expect(acpPermissionKind(undefined)).toBe('other');
    expect(claudeToolKind('Bash')).toBe('command');
    expect(claudeToolKind('Write')).toBe('edit');
    expect(claudeToolKind('Read')).toBe('read');
  });

  it('lets each mode decide when the user is not being asked', () => {
    expect(decideByMode('full', 'command').outcome).toBe('allow');
    expect(decideByMode('safe', 'read').outcome).toBe('allow');
    expect(decideByMode('safe', 'edit').outcome).toBe('deny');
    // edits vs full is drawn by each CLI's sandbox, not re-litigated here.
    expect(decideByMode('edits', 'edit').outcome).toBe('allow');
    expect(decideByMode('edits', 'command').outcome).toBe('allow');
  });

  it('remembers "always" per command, not for every command', () => {
    const memory = new PermissionMemory();
    const git: PermissionRequest = { id: '1', kind: 'command', title: 'git', detail: 'git status' };
    const rm: PermissionRequest = { id: '2', kind: 'command', title: 'rm', detail: 'rm -rf /' };
    memory.remember(git);
    expect(memory.isAllowed({ ...git, id: '3', detail: 'git log' })).toBe(true);
    expect(memory.isAllowed(rm), 'allowing git must never allow rm').toBe(false);
  });
});

describe('the permission gate', () => {
  const request = (over: Partial<PermissionRequest> = {}): PermissionRequest => ({
    id: 'r1',
    kind: 'command',
    title: 'run something',
    detail: 'npm test',
    ...over,
  });

  it('answers from the mode when asking is off, without bothering anyone', async () => {
    let asked = 0;
    const gate = new PermissionGate({
      mode: 'full',
      ask: false,
      emit: () => asked++,
    });
    expect((await gate.ask(request())).outcome).toBe('allow');
    expect(asked).toBe(0);
  });

  it('surfaces the question and waits for the answer', async () => {
    const seen: PermissionRequest[] = [];
    const gate = new PermissionGate({ mode: 'edits', ask: true, emit: (r) => seen.push(r) });
    const pending = gate.ask(request());
    expect(seen).toHaveLength(1);
    gate.respond('r1', { outcome: 'deny', reason: 'no' });
    expect((await pending).outcome).toBe('deny');
  });

  it('stops asking once told always — for that command', async () => {
    const seen: PermissionRequest[] = [];
    const gate = new PermissionGate({ mode: 'edits', ask: true, emit: (r) => seen.push(r) });

    const first = gate.ask(request());
    gate.respond('r1', { outcome: 'allow-always' });
    await first;

    const second = await gate.ask(request({ id: 'r2', detail: 'npm run build' }));
    expect(second.outcome).toBe('allow');
    expect(seen, 'a remembered command must not be asked again').toHaveLength(1);

    const other = gate.ask(request({ id: 'r3', detail: 'rm -rf build' }));
    expect(seen, 'a different command must still be asked').toHaveLength(2);
    gate.respond('r3', { outcome: 'deny' });
    await other;
  });

  it('never interrupts a read', async () => {
    let asked = 0;
    const gate = new PermissionGate({ mode: 'edits', ask: true, emit: () => asked++ });
    expect((await gate.ask(request({ kind: 'read' }))).outcome).toBe('allow');
    expect(asked).toBe(0);
  });

  it('does not ask in Full — that mode already answered', async () => {
    let asked = 0;
    const gate = new PermissionGate({ mode: 'full', ask: true, emit: () => asked++ });
    expect((await gate.ask(request())).outcome).toBe('allow');
    expect(asked).toBe(0);
  });

  it('releases a waiting CLI when the run ends unanswered', async () => {
    const resolved: Array<{ id: string; allowed: boolean }> = [];
    const gate = new PermissionGate({
      mode: 'edits',
      ask: true,
      emit: () => undefined,
      resolved: (id, allowed) => resolved.push({ id, allowed }),
    });
    const pending = gate.ask(request());
    gate.close();
    const decision = await pending;
    expect(decision.outcome).toBe('deny');
    expect(resolved).toEqual([{ id: 'r1', allowed: false }]);
  });

  it('denies anything asked after the run ended', async () => {
    const gate = new PermissionGate({ mode: 'edits', ask: true, emit: () => undefined });
    gate.close();
    expect((await gate.ask(request())).outcome).toBe('deny');
  });

  it('ignores an answer to a question nobody asked', () => {
    const gate = new PermissionGate({ mode: 'edits', ask: true, emit: () => undefined });
    expect(() => gate.respond('nonexistent', { outcome: 'allow' })).not.toThrow();
  });
});
