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
    assert.equal(buttons[0].createdBy, 'User');
    assert.equal(buttons[0].lastModifiedBy, 'User');
    assert.equal(buttons[0].source, 'User');
    assert.deepEqual(buttons[0].terminals, [
        {
            name: 'Terminal 1',
            commands: 'Write-Host legacy',
            dependentOnPrevious: false
        }
    ]);
});

test('saveButton moves an existing button across scopes without leaving a duplicate behind', async () => {
    const { store } = createStore();

    await store.saveButton({
        id: 'cross-scope-button',
        name: 'Cross Scope',
        locality: 'Global',
        description: '',
        type: 'TerminalCommand',
        executionText: 'echo cross-scope',
        category: 'General',
        icon: 'beaker',
        colour: '',
        copilotModel: '',
        copilotMode: 'agent',
        copilotAttachFiles: [],
        copilotAttachActiveFile: false,
        warnBeforeExecution: false,
        userTokens: []
    });

    await store.saveButton({
        id: 'cross-scope-button',
        name: 'Cross Scope',
        locality: 'Local',
        description: '',
        type: 'TerminalCommand',
        executionText: 'echo cross-scope',
        category: 'General',
        icon: 'beaker',
        colour: '',
        copilotModel: '',
        copilotMode: 'agent',
        copilotAttachFiles: [],
        copilotAttachActiveFile: false,
        warnBeforeExecution: false,
        userTokens: []
    });

    assert.equal(store.getGlobalButtons().length, 0);
    assert.equal(store.getLocalButtons().length, 1);
    assert.equal(store.getLocalButtons()[0]?.id, 'cross-scope-button');
});

test('saveButton upgrades source to AgentAndUser when agent-created buttons are later edited by the user', async () => {
    const { store } = createStore();

    await store.saveButton({
        id: 'agent-button',
        name: 'Agent Button',
        locality: 'Global',
        description: '',
        type: 'TerminalCommand',
        executionText: 'echo agent',
        category: 'General',
        icon: 'robot',
        colour: '',
        copilotModel: '',
        copilotMode: 'agent',
        copilotAttachFiles: [],
        copilotAttachActiveFile: false,
        warnBeforeExecution: false,
        userTokens: []
    }, 'Agent');

    await store.saveButton({
        id: 'agent-button',
        name: 'Agent Button Updated By User',
        locality: 'Global',
        description: '',
        type: 'TerminalCommand',
        executionText: 'echo user',
        category: 'General',
        icon: 'robot',
        colour: '',
        copilotModel: '',
        copilotMode: 'agent',
        copilotAttachFiles: [],
        copilotAttachActiveFile: false,
        warnBeforeExecution: false,
        userTokens: []
    });

    assert.equal(store.getButton('agent-button')?.createdBy, 'Agent');
    assert.equal(store.getButton('agent-button')?.lastModifiedBy, 'User');
    assert.equal(store.getButton('agent-button')?.source, 'AgentAndUser');
});

test('saveButton fires one change event per logical save, including cross-scope moves', async () => {
    const { store } = createStore();
    let changeCount = 0;
    const subscription = store.onDidChange(() => {
        changeCount += 1;
    });

    try {
        await store.saveButton({
            id: 'eventful-button',
            name: 'Eventful Button',
            locality: 'Global',
            description: '',
            type: 'TerminalCommand',
            executionText: 'echo global',
            category: 'General',
            icon: 'pulse',
            colour: '',
            copilotModel: '',
            copilotMode: 'agent',
            copilotAttachFiles: [],
            copilotAttachActiveFile: false,
            warnBeforeExecution: false,
            userTokens: []
        });

        assert.equal(changeCount, 1);

        changeCount = 0;

        await store.saveButton({
            id: 'eventful-button',
            name: 'Eventful Button',
            locality: 'Local',
            description: '',
            type: 'TerminalCommand',
            executionText: 'echo local',
            category: 'General',
            icon: 'pulse',
            colour: '',
            copilotModel: '',
            copilotMode: 'agent',
            copilotAttachFiles: [],
            copilotAttachActiveFile: false,
            warnBeforeExecution: false,
            userTokens: []
        });

        assert.equal(changeCount, 1);
    } finally {
        subscription.dispose();
    }
});