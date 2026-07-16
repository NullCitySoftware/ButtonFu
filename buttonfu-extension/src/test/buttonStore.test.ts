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

// ---------------------------------------------------------------------------
// Workspace buttons (buttonfu.workspaceButtons — read-only settings source)
// ---------------------------------------------------------------------------

test('getWorkspaceButtons normalises minimal entries with defaults and a stable derived id', async () => {
    const { harness, store } = createStore();

    await harness.vscode.workspace.getConfiguration('buttonfu').update('workspaceButtons', [
        { name: 'Run Local', executionText: 'pwsh -File build.ps1' }
    ]);

    const buttons = store.getWorkspaceButtons();

    assert.equal(buttons.length, 1);
    assert.equal(buttons[0].name, 'Run Local');
    assert.equal(buttons[0].locality, 'Workspace');
    assert.equal(buttons[0].type, 'TerminalCommand');
    assert.equal(buttons[0].category, 'General');
    assert.equal(buttons[0].icon, 'play');
    assert.equal(buttons[0].colour, '');
    assert.ok(buttons[0].id.startsWith('ws-'));

    // TerminalCommand executionText is migrated into a terminal tab like other buttons
    assert.deepEqual(buttons[0].terminals, [
        { name: 'Terminal 1', commands: 'pwsh -File build.ps1', dependentOnPrevious: false }
    ]);

    // Id is stable across loads
    const again = store.getWorkspaceButtons();
    assert.equal(again[0].id, buttons[0].id);
});

test('getWorkspaceButtons skips unusable entries and rides warnBeforeExecution through', async () => {
    const { harness, store } = createStore();

    await harness.vscode.workspace.getConfiguration('buttonfu').update('workspaceButtons', [
        null,
        'not-an-object',
        { executionText: 'no name — skipped' },
        { name: '   ' },
        { name: 'Deploy', category: 'PDF Whiffle', icon: 'rocket', warnBeforeExecution: true, executionText: 'deploy.ps1' }
    ]);

    const buttons = store.getWorkspaceButtons();

    assert.equal(buttons.length, 1);
    assert.equal(buttons[0].name, 'Deploy');
    assert.equal(buttons[0].category, 'PDF Whiffle');
    assert.equal(buttons[0].icon, 'rocket');
    assert.equal(buttons[0].warnBeforeExecution, true);
});

test('getAllButtons merges workspace buttons after global and local ones', async () => {
    const { harness, store } = createStore();

    await harness.vscode.workspace.getConfiguration('buttonfu').update('globalButtons', [
        { id: 'g1', name: 'Global One', locality: 'Global', type: 'TerminalCommand', executionText: 'echo g', category: 'General', icon: 'play', colour: '', description: '', copilotModel: '', copilotMode: 'agent', copilotAttachFiles: [], copilotAttachActiveFile: false, warnBeforeExecution: false, userTokens: [] }
    ]);
    await harness.vscode.workspace.getConfiguration('buttonfu').update('workspaceButtons', [
        { name: 'Workspace One', executionText: 'echo w' }
    ]);

    const all = store.getAllButtons();

    assert.equal(all.length, 2);
    assert.equal(all[0].id, 'g1');
    assert.equal(all[1].locality, 'Workspace');
    assert.ok(store.getButton(all[1].id));
    assert.equal(store.isWorkspaceButton(all[1].id), true);
    assert.equal(store.isWorkspaceButton('g1'), false);
});

test('workspaceButtons configuration changes fire the store change event', async () => {
    const { harness, store } = createStore();
    let changeCount = 0;
    const subscription = store.onDidChange(() => {
        changeCount += 1;
    });

    try {
        await harness.vscode.workspace.getConfiguration('buttonfu').update('workspaceButtons', [
            { name: 'Fresh', executionText: 'echo fresh' }
        ]);
        assert.equal(changeCount, 1);
    } finally {
        subscription.dispose();
    }
});

test('saveButton rejects workspace buttons and deleteButton leaves them untouched', async () => {
    const { harness, store } = createStore();

    await harness.vscode.workspace.getConfiguration('buttonfu').update('workspaceButtons', [
        { name: 'Read Only', executionText: 'echo ro' }
    ]);

    const wsButton = store.getWorkspaceButtons()[0];

    await assert.rejects(
        () => store.saveButton({ ...wsButton }),
        /read-only/
    );

    await store.deleteButton(wsButton.id);
    assert.equal(store.getWorkspaceButtons().length, 1);

    // No save path wrote to the workspaceButtons setting beyond our own seed update
    const workspaceWrites = harness.configurationUpdates.filter((update) => update.key === 'buttonfu.workspaceButtons');
    assert.equal(workspaceWrites.length, 1);
});
