const assert = require('node:assert');
const vscode = require('vscode');

suite('usrouter smoke', () => {
  test('activates', async () => {
    const ext = vscode.extensions.getExtension('mdenesfe.usrouter');
    assert.ok(ext, 'extension mdenesfe.usrouter not found');
    await ext.activate();
    assert.ok(ext.isActive, 'extension did not activate');
  });

  test('registers all commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    const expected = [
      'usrouter.addAccount',
      'usrouter.removeAccount',
      'usrouter.editRules',
      'usrouter.newConversation',
      'usrouter.openChatInTab',
      'usrouter.openAccounts',
      'usrouter.openRules',
      'usrouter.openInTerminal',
      'usrouter.cancelTask',
      'usrouter.debug.simulateLimit',
    ];
    for (const cmd of expected) {
      assert.ok(commands.includes(cmd), `missing command: ${cmd}`);
    }
  });

  test('opens chat and accounts tabs without throwing', async () => {
    await vscode.commands.executeCommand('usrouter.newConversation');
    await vscode.commands.executeCommand('usrouter.openAccounts');
    await vscode.commands.executeCommand('usrouter.openRules');
  });
});
