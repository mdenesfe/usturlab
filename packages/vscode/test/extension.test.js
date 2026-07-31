const assert = require('node:assert');
const vscode = require('vscode');

suite('usturlab smoke', () => {
  test('activates', async () => {
    const ext = vscode.extensions.getExtension('mdenesfe.usturlab');
    assert.ok(ext, 'extension mdenesfe.usturlab not found');
    await ext.activate();
    assert.ok(ext.isActive, 'extension did not activate');
  });

  test('registers all commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    const expected = [
      'usturlab.addAccount',
      'usturlab.removeAccount',
      'usturlab.editRules',
      'usturlab.newConversation',
      'usturlab.openChatInTab',
      'usturlab.openAccounts',
      'usturlab.openRules',
      'usturlab.openInTerminal',
      'usturlab.cancelTask',
      'usturlab.debug.simulateLimit',
    ];
    for (const cmd of expected) {
      assert.ok(commands.includes(cmd), `missing command: ${cmd}`);
    }
  });

  test('opens chat and accounts tabs without throwing', async () => {
    await vscode.commands.executeCommand('usturlab.newConversation');
    await vscode.commands.executeCommand('usturlab.openAccounts');
    await vscode.commands.executeCommand('usturlab.openRules');
  });
});
