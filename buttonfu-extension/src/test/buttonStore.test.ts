import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createFakeVscodeHarness, loadWithPatchedVscode } from './helpers/fakeVscode';

function createStore() {
    const harness = createFakeVscodeHarness();
    const modulePath = path.resolve(__dirname, '..', 'buttonStore.js');
    const buttonStoreModule = loadWithPatchedVscode<{ ButtonStore: new (context: any) => any }>(modulePath, harness.vscode);
    const context = harness.createExtensionContext();
    const store = new buttonStoreModule.ButtonStore(context);
    return { harness, store };
}

test('getGlobalButtons migrates legacy PowerShell commands into terminal tabs', async () => {
    const { harness, store } = createStore();

    await harness.vscode.workspace.getConfiguration('buttonfu').update('globalButtons', [
        {
            id: 'legacy-button',
            name: 'Legacy PowerShell',
            locality: 'Global',
            description: '',
            type: 'PowerShellCommand',
            executionText: 'Write-Host legacy',
            category: 'General',
            icon: 'terminal-powershell',
            colour: '',
            copilotModel: '',
            copilotMode: 'agent',
            copilotAttachFiles: [],
            copilotAttachActiveFile: false,
            warnBeforeExecution: false,
            userTokens: []
        }
    ]);

    const buttons = store.getGlobalButtons();

    assert.equal(buttons[0].type, 'TerminalCommand');
    assert.equal(buttons[0].executionText, '');
    assert.deepEqual(buttons[0].terminals, [
        {
            name: 'Terminal 1',
            commands: 'Write-Host legacy',
            dependentOnPrevious: false
        }
    ]);
});