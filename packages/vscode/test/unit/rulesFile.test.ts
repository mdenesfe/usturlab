import { beforeEach, describe, expect, it, vi } from 'vitest';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const files = new Map<string, string>();

vi.mock('node:fs', () => ({
  existsSync: (path: string) => files.has(path),
  readFileSync: (path: string) => {
    const content = files.get(path);
    if (content === undefined) throw new Error(`ENOENT: ${path}`);
    return content;
  },
}));

const { RulesManager } = await import('../../src/rules/rulesFile.js');
const { fsSpies, resetVscodeStub, window } = await import('./vscodeStub.js');

const RULES_PATH = join(homedir(), '.usturlab', 'rules.json');

const VALID = JSON.stringify({
  version: 1,
  rules: [
    {
      id: 'tests-to-codex',
      match: { keywords: ['test'] },
      target: [{ provider: 'codex', account: 'work' }],
    },
  ],
  defaultChain: [{ provider: 'claude', account: 'personal' }],
});

/** Valid JSON, invalid rules: the shape a half-finished hand edit leaves behind. */
const UNPARSEABLE = JSON.stringify({ version: 1, rules: [{ id: 'oops' }] });

function written(): unknown {
  const call = fsSpies.writeFile.mock.calls.at(-1);
  return JSON.parse(Buffer.from(call![1]!).toString('utf8'));
}

beforeEach(() => {
  files.clear();
  resetVscodeStub();
});

describe('RulesManager — a file that does not parse', () => {
  it('routes on the built-in default and reports why', () => {
    files.set(RULES_PATH, UNPARSEABLE);
    const manager = new RulesManager();

    expect(manager.getRules().rules).toEqual([]);
    expect(manager.getState().error).toBeTruthy();
    expect(manager.isUnparsed()).toBe(true);
  });

  it('refuses to save over it, because the rules in it are still there', async () => {
    files.set(RULES_PATH, UNPARSEABLE);
    const manager = new RulesManager();

    await manager.saveDefaultChain([{ provider: 'gemini', account: 'main' }]);

    expect(fsSpies.writeFile).not.toHaveBeenCalled();
    expect(window.showErrorMessage).toHaveBeenCalledOnce();
    expect(files.get(RULES_PATH)).toBe(UNPARSEABLE);
  });

  it('refuses every other write path too, not just the chain', async () => {
    files.set(RULES_PATH, UNPARSEABLE);
    const manager = new RulesManager();

    await manager.saveRule({
      id: 'new-one',
      match: { keywords: ['x'] },
      target: [{ provider: 'claude', account: 'personal' }],
    });
    await manager.deleteRule('tests-to-codex');
    await manager.reorderRules(['tests-to-codex']);

    expect(fsSpies.writeFile).not.toHaveBeenCalled();
  });

  it('saves again once the file parses', async () => {
    files.set(RULES_PATH, VALID);
    const manager = new RulesManager();

    expect(manager.isUnparsed()).toBe(false);
    await manager.saveDefaultChain([{ provider: 'gemini', account: 'main' }]);

    expect(fsSpies.writeFile).toHaveBeenCalledOnce();
    expect(written()).toMatchObject({
      defaultChain: [{ provider: 'gemini', account: 'main' }],
      rules: [{ id: 'tests-to-codex' }],
    });
  });
});

describe('RulesManager — writing where no file exists yet', () => {
  it('creates the parent directory with a separator the platform actually uses', async () => {
    const manager = new RulesManager();

    await manager.saveDefaultChain([{ provider: 'claude', account: 'personal' }]);

    // `dirname` rather than a hand-rolled lastIndexOf('/'), which finds nothing
    // in a path built out of backslashes and asks for the filesystem root
    // instead. On POSIX both spellings agree, so this only tells the two apart
    // on the Windows leg of the CI matrix — which is the reason that leg exists.
    expect(fsSpies.createDirectory).toHaveBeenCalledOnce();
    expect(fsSpies.createDirectory.mock.calls[0]![0]!.fsPath).toBe(dirname(RULES_PATH));
    expect(fsSpies.createDirectory.mock.calls[0]![0]!.fsPath).not.toBe('');
    expect(fsSpies.writeFile).toHaveBeenCalledOnce();
  });
});
