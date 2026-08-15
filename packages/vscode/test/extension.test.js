const assert = require('node:assert');
const vscode = require('vscode');

suite('usturlab smoke', () => {
  test('activates', async () => {
    const ext = vscode.extensions.getExtension('mdenesfe.usturlab');
    assert.ok(ext, 'extension mdenesfe.usturlab not found');
    await ext.activate();
    assert.ok(ext.isActive, 'extension did not activate');
  });

  test('registers every command it declares', async () => {
    // Read from the manifest rather than a copy of it: a hand-written list
    // silently stops covering whatever was added after it.
    const ext = vscode.extensions.getExtension('mdenesfe.usturlab');
    const declared = ext.packageJSON.contributes.commands.map((c) => c.command);
    assert.ok(declared.length >= 10, 'manifest declares no commands');
    const commands = await vscode.commands.getCommands(true);
    for (const cmd of declared) {
      assert.ok(commands.includes(cmd), `declared but never registered: ${cmd}`);
    }
  });

  test('declares the settings the code reads, with the defaults it assumes', async () => {
    const ext = vscode.extensions.getExtension('mdenesfe.usturlab');
    const props = ext.packageJSON.contributes.configuration.properties;
    const config = vscode.workspace.getConfiguration('usturlab');
    // A setting the code reads but the manifest never declares reads as
    // undefined at runtime and takes the fallback silently, which is how a
    // feature ships switched off without anyone noticing.
    const expected = {
      sizeReasoning: true,
      sendWorkspaceContext: true,
      standingInstructions: true,
      autoPlanHeavyEdits: true,
      verifyChanges: true,
      frameTasks: true,
      askPermission: false,
    };
    for (const [key, value] of Object.entries(expected)) {
      assert.ok(props[`usturlab.${key}`], `undeclared setting: usturlab.${key}`);
      assert.strictEqual(props[`usturlab.${key}`].default, value, `wrong default for ${key}`);
      assert.strictEqual(config.get(key), value, `runtime default differs for ${key}`);
    }
    assert.strictEqual(config.get('routingMode'), 'auto');
    assert.strictEqual(config.get('secondOpinion'), 'hard');
  });

  test('opens chat and accounts tabs without throwing', async () => {
    await vscode.commands.executeCommand('usturlab.newConversation');
    await vscode.commands.executeCommand('usturlab.openAccounts');
    await vscode.commands.executeCommand('usturlab.openRules');
  });

  test('tabs reopen after being closed (regression: stale panel handles)', async () => {
    for (let round = 0; round < 2; round++) {
      await vscode.commands.executeCommand('usturlab.openAccounts');
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      await vscode.commands.executeCommand('usturlab.openRules');
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      await vscode.commands.executeCommand('usturlab.newConversation');
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
    // A final open of each must still succeed.
    await vscode.commands.executeCommand('usturlab.openAccounts');
    await vscode.commands.executeCommand('usturlab.openRules');
    await vscode.commands.executeCommand('usturlab.openChatInTab');
  });
});
