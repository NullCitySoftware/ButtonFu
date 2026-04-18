import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createDefaultButton, createDefaultNote } from '../types';
import { createFakeVscodeHarness, loadWithPatchedVscode } from './helpers/fakeVscode';
import { executeWebviewScripts } from './helpers/webviewRuntime';

test('saveOptions persists config-backed options and refreshes the button panel options callback', async () => {
    const harness = createFakeVscodeHarness();
    const buttonStoreModulePath = path.resolve(__dirname, '..', 'buttonStore.js');
    const editorPanelModulePath = path.resolve(__dirname, '..', 'editorPanel.js');
    const buttonStoreModule = loadWithPatchedVscode<{ ButtonStore: new (context: any) => any }>(buttonStoreModulePath, harness.vscode);
    const editorPanelModule = loadWithPatchedVscode<{ ButtonEditorPanel: any }>(editorPanelModulePath, harness.vscode);
    const context = harness.createExtensionContext();
    const store = new buttonStoreModule.ButtonStore(context);
    let optionsChanged = 0;

    editorPanelModule.ButtonEditorPanel.configure(context.globalState, () => {
        optionsChanged += 1;
    });
    editorPanelModule.ButtonEditorPanel.createOrShow(store, context.extensionUri);

    const panel = harness.webviewPanels[0];
    assert.ok(panel, 'Expected a webview panel to be created.');

    try {
        await panel.sendMessage({
            type: 'saveOptions',
            options: {
                showBuildInformation: true,
                showAddAndEditorButtons: false,
                showNotes: false,
                enableAgentBridge: true,
                columns: 3
            }
        });
    } finally {
        panel.dispose();
    }

    assert.deepEqual(harness.configurationUpdates.filter((entry) => entry.key === 'buttonfu.showNotes'), [
        { key: 'buttonfu.showNotes', value: false }
    ]);
    assert.deepEqual(harness.configurationUpdates.filter((entry) => entry.key === 'buttonfu.enableAgentBridge'), [
        { key: 'buttonfu.enableAgentBridge', value: true }
    ]);
    assert.equal(context.globalState.get('options.showBuildInformation'), true);
    assert.equal(context.globalState.get('options.showAddAndEditorButtons'), false);
    assert.equal(context.globalState.get('options.columns'), 3);
    assert.equal(optionsChanged, 1);
});

test('button editor options render the agent bridge toggle and include it in save messages', () => {
    const harness = createFakeVscodeHarness();
    const buttonStoreModulePath = path.resolve(__dirname, '..', 'buttonStore.js');
    const editorPanelModulePath = path.resolve(__dirname, '..', 'editorPanel.js');
    const buttonStoreModule = loadWithPatchedVscode<{ ButtonStore: new (context: any) => any }>(buttonStoreModulePath, harness.vscode);
    const editorPanelModule = loadWithPatchedVscode<{ ButtonEditorPanel: any }>(editorPanelModulePath, harness.vscode);
    const context = harness.createExtensionContext();
    const store = new buttonStoreModule.ButtonStore(context);

    editorPanelModule.ButtonEditorPanel.configure(context.globalState, () => undefined);
    editorPanelModule.ButtonEditorPanel.createOrShow(store, context.extensionUri);

    const panel = harness.webviewPanels[0];
    assert.ok(panel, 'Expected a webview panel to be created.');
    assert.match(panel.panel.webview.html, /id="opt-enableAgentBridge"/);

    const runtime = executeWebviewScripts(panel.panel.webview.html);
    const toggle = runtime.document.getElementById('opt-enableAgentBridge');
    assert.ok(toggle, 'Expected the agent bridge toggle to be rendered.');

    toggle.checked = true;
    toggle.dispatch('change');

    assert.ok(runtime.postedMessages.some((message: any) => (
        message?.type === 'saveOptions' && message?.options?.enableAgentBridge === true
    )));

    panel.dispose();
});

test('button editor webview script boots and keeps the icon, model, colour, and attachment controls interactive', () => {
    const harness = createFakeVscodeHarness();
    const buttonStoreModulePath = path.resolve(__dirname, '..', 'buttonStore.js');
    const editorPanelModulePath = path.resolve(__dirname, '..', 'editorPanel.js');
    const buttonStoreModule = loadWithPatchedVscode<{ ButtonStore: new (context: any) => any }>(buttonStoreModulePath, harness.vscode);
    const editorPanelModule = loadWithPatchedVscode<{ ButtonEditorPanel: any }>(editorPanelModulePath, harness.vscode);
    const context = harness.createExtensionContext();
    const store = new buttonStoreModule.ButtonStore(context);

    editorPanelModule.ButtonEditorPanel.configure(context.globalState, () => undefined);
    editorPanelModule.ButtonEditorPanel.createOrShow(store, context.extensionUri);

    const panel = harness.webviewPanels[0];
    assert.ok(panel, 'Expected a webview panel to be created.');

    const runtime = executeWebviewScripts(panel.panel.webview.html);
    assert.ok(runtime.postedMessages.some((message: any) => message?.type === 'getButtons'));
    assert.ok(runtime.postedMessages.some((message: any) => message?.type === 'getModels'));
    assert.match(panel.panel.webview.html, /id="btn-source-summary"/);
    assert.match(panel.panel.webview.html, /id="btn-created-by"/);
    assert.match(panel.panel.webview.html, /id="btn-last-modified-by"/);

    runtime.click('iconTrigger');
    assert.equal(runtime.document.getElementById('iconDropdown')?.classList.contains('visible'), true);

    runtime.dispatchMessage({
        type: 'modelsResult',
        models: [
            {
                id: 'gpt-5.4',
                name: 'GPT-5.4',
                vendor: 'GitHub',
                family: 'gpt-5',
                maxInputTokens: 128000
            }
        ]
    });
    runtime.click('modelAutocompleteTrigger');
    assert.equal(runtime.document.getElementById('modelAutocomplete')?.classList.contains('visible'), true);
    assert.match(runtime.document.getElementById('modelAutocomplete')?.innerHTML ?? '', /GPT-5\.4/);

    const colourPicker = runtime.document.getElementById('btn-colour-picker');
    assert.ok(colourPicker, 'Expected the shared colour picker to be rendered.');
    colourPicker.value = '#123456';
    colourPicker.dispatch('change');
    assert.equal(runtime.document.getElementById('btn-colour')?.value, '#123456');

    runtime.click('pickFilesBtn');
    assert.ok(runtime.postedMessages.some((message: any) => message?.type === 'pickFiles'));

    const button = createDefaultButton('Global');
    button.id = 'agent-user-button';
    button.name = 'Agent/User Button';
    button.createdBy = 'Agent';
    button.lastModifiedBy = 'User';
    button.source = 'AgentAndUser';
    runtime.dispatchMessage({
        type: 'refreshButtons',
        buttons: [button],
        keybindings: {},
        workspaceName: 'TestWorkspace'
    });
    runtime.dispatchMessage({ type: 'editButton', buttonId: button.id });
    assert.equal(runtime.document.getElementById('btn-source-summary')?.textContent, 'AgentAndUser');
    assert.equal(runtime.document.getElementById('btn-created-by')?.textContent, 'Agent');
    assert.equal(runtime.document.getElementById('btn-last-modified-by')?.textContent, 'User');

    panel.dispose();
});

test('button editor includes notes in refresh payloads and renders workspace note rows', async () => {
    const harness = createFakeVscodeHarness();
    const buttonStoreModulePath = path.resolve(__dirname, '..', 'buttonStore.js');
    const noteStoreModulePath = path.resolve(__dirname, '..', 'noteStore.js');
    const editorPanelModulePath = path.resolve(__dirname, '..', 'editorPanel.js');
    const buttonStoreModule = loadWithPatchedVscode<{ ButtonStore: new (context: any) => any }>(buttonStoreModulePath, harness.vscode);
    const noteStoreModule = loadWithPatchedVscode<{ NoteStore: new (context: any) => any }>(noteStoreModulePath, harness.vscode);
    const editorPanelModule = loadWithPatchedVscode<{ ButtonEditorPanel: any }>(editorPanelModulePath, harness.vscode);
    const context = harness.createExtensionContext();
    const buttonStore = new buttonStoreModule.ButtonStore(context);
    const noteStore = new noteStoreModule.NoteStore(context);

    const button = createDefaultButton('Local');
    button.id = 'workspace-button';
    button.name = 'Workspace Button';
    button.executionText = 'echo workspace';

    const note = createDefaultNote('Local');
    note.id = 'workspace-note';
    note.name = 'Workspace Note';
    note.content = 'Remember the workspace note row.';

    await buttonStore.saveButton(button);
    await noteStore.saveNode(note);

    editorPanelModule.ButtonEditorPanel.configure(context.globalState, () => undefined);
    editorPanelModule.ButtonEditorPanel.createOrShow(buttonStore, context.extensionUri, noteStore);

    const panel = harness.webviewPanels[0];
    assert.ok(panel, 'Expected a webview panel to be created.');

    try {
        await panel.sendMessage({ type: 'getButtons' });

        const refreshMessage = panel.postedMessages.at(-1) as {
            type: string;
            buttons: Array<{ id: string }>;
            notes: Array<{ id: string }>;
            showNotes: boolean;
        };

        assert.equal(refreshMessage.type, 'refreshButtons');
        assert.deepEqual(refreshMessage.buttons.map((entry) => entry.id), ['workspace-button']);
        assert.deepEqual(refreshMessage.notes.map((entry) => entry.id), ['workspace-note']);
        assert.equal(refreshMessage.showNotes, true);

        const runtime = executeWebviewScripts(panel.panel.webview.html);
        runtime.dispatchMessage(refreshMessage);

        assert.equal(String(runtime.document.getElementById('localCount')?.textContent), '2');
        assert.match(runtime.document.getElementById('localButtonList')?.innerHTML ?? '', /Workspace Note/);
        assert.match(runtime.document.getElementById('localButtonList')?.innerHTML ?? '', /data-note-id="workspace-note"/);
        assert.match(runtime.document.getElementById('workspaceSectionTitle')?.textContent ?? '', /Workspace Items \[TestWorkspace\]/);
    } finally {
        panel.dispose();
    }
});

test('button editor keeps button rows ahead of note rows when mixed items share the same sort order', async () => {
    const harness = createFakeVscodeHarness();
    const buttonStoreModulePath = path.resolve(__dirname, '..', 'buttonStore.js');
    const noteStoreModulePath = path.resolve(__dirname, '..', 'noteStore.js');
    const editorPanelModulePath = path.resolve(__dirname, '..', 'editorPanel.js');
    const buttonStoreModule = loadWithPatchedVscode<{ ButtonStore: new (context: any) => any }>(buttonStoreModulePath, harness.vscode);
    const noteStoreModule = loadWithPatchedVscode<{ NoteStore: new (context: any) => any }>(noteStoreModulePath, harness.vscode);
    const editorPanelModule = loadWithPatchedVscode<{ ButtonEditorPanel: any }>(editorPanelModulePath, harness.vscode);
    const context = harness.createExtensionContext();
    const buttonStore = new buttonStoreModule.ButtonStore(context);
    const noteStore = new noteStoreModule.NoteStore(context);

    const button = createDefaultButton('Local');
    button.id = 'collision-button';
    button.name = 'Zulu Button';
    button.sortOrder = 10;

    const note = createDefaultNote('Local');
    note.id = 'collision-note';
    note.name = 'Alpha Note';
    note.sortOrder = 10;
    note.content = 'Same sort order as the button.';

    await buttonStore.saveButton(button);
    await noteStore.saveNode(note);

    editorPanelModule.ButtonEditorPanel.configure(context.globalState, () => undefined);
    editorPanelModule.ButtonEditorPanel.createOrShow(buttonStore, context.extensionUri, noteStore);

    const panel = harness.webviewPanels[0];
    assert.ok(panel, 'Expected a webview panel to be created.');

    try {
        await panel.sendMessage({ type: 'getButtons' });

        const refreshMessage = panel.postedMessages.at(-1) as {
            type: string;
            buttons: Array<{ id: string }>;
            notes: Array<{ id: string }>;
        };

        const runtime = executeWebviewScripts(panel.panel.webview.html);
        runtime.dispatchMessage(refreshMessage);

        const html = runtime.document.getElementById('localButtonList')?.innerHTML ?? '';
        const buttonIndex = html.indexOf('data-button-id="collision-button"');
        const noteIndex = html.indexOf('data-note-id="collision-note"');

        assert.notEqual(buttonIndex, -1);
        assert.notEqual(noteIndex, -1);
        assert.ok(buttonIndex < noteIndex, 'Expected the button card to render before the note card when sortOrder collides.');
    } finally {
        panel.dispose();
    }
});
test('testButton message is forwarded to the executeButtonTest callback with a sanitised ButtonConfig', async () => {
    const harness = createFakeVscodeHarness();
    const buttonStoreModulePath = path.resolve(__dirname, '..', 'buttonStore.js');
    const editorPanelModulePath = path.resolve(__dirname, '..', 'editorPanel.js');
    const buttonStoreModule = loadWithPatchedVscode<{ ButtonStore: new (context: any) => any }>(buttonStoreModulePath, harness.vscode);
    const editorPanelModule = loadWithPatchedVscode<{ ButtonEditorPanel: any }>(editorPanelModulePath, harness.vscode);
    const context = harness.createExtensionContext();
    const store = new buttonStoreModule.ButtonStore(context);

    const calls: any[] = [];
    editorPanelModule.ButtonEditorPanel.configure(context.globalState, () => undefined, async (btn: any) => {
        calls.push(btn);
    });
    editorPanelModule.ButtonEditorPanel.createOrShow(store, context.extensionUri);

    const panel = harness.webviewPanels[0];
    assert.ok(panel, 'Expected a webview panel to be created.');

    try {
        await panel.sendMessage({
            type: 'testButton',
            button: {
                id: 'test-id',
                name: 'My Button',
                type: 'TerminalCommand',
                terminals: [{ name: 'Tab 1', commands: 'echo hello', dependentOnPrevious: false }],
                executionText: '',
                copilotModel: 'gpt-4',
                copilotMode: 'ask',
                copilotAttachFiles: ['file.ts'],
                copilotAttachActiveFile: true,
                warnBeforeExecution: true,
                userTokens: []
            }
        });
    } finally {
        panel.dispose();
    }

    assert.equal(calls.length, 1, 'Expected executeButtonTest to be called once.');
    const btn = calls[0];
    assert.equal(btn.type, 'TerminalCommand');
    assert.equal(btn.name, 'My Button');
    assert.deepEqual(btn.terminals, [{ name: 'Tab 1', commands: 'echo hello', dependentOnPrevious: false }]);
    assert.equal(btn.warnBeforeExecution, false, 'warnBeforeExecution must be suppressed for test runs from the editor.');
    assert.equal(btn.copilotModel, 'gpt-4');
    assert.equal(btn.copilotMode, 'ask');
    assert.deepEqual(btn.copilotAttachFiles, ['file.ts']);
    assert.equal(btn.copilotAttachActiveFile, true);
});

test('testButton message is ignored when the button type is invalid', async () => {
    const harness = createFakeVscodeHarness();
    const buttonStoreModulePath = path.resolve(__dirname, '..', 'buttonStore.js');
    const editorPanelModulePath = path.resolve(__dirname, '..', 'editorPanel.js');
    const buttonStoreModule = loadWithPatchedVscode<{ ButtonStore: new (context: any) => any }>(buttonStoreModulePath, harness.vscode);
    const editorPanelModule = loadWithPatchedVscode<{ ButtonEditorPanel: any }>(editorPanelModulePath, harness.vscode);
    const context = harness.createExtensionContext();
    const store = new buttonStoreModule.ButtonStore(context);

    const calls: any[] = [];
    editorPanelModule.ButtonEditorPanel.configure(context.globalState, () => undefined, async (btn: any) => {
        calls.push(btn);
    });
    editorPanelModule.ButtonEditorPanel.createOrShow(store, context.extensionUri);

    const panel = harness.webviewPanels[0];
    assert.ok(panel, 'Expected a webview panel to be created.');

    try {
        await panel.sendMessage({ type: 'testButton', button: { type: 'EvilType', name: 'x' } });
    } finally {
        panel.dispose();
    }

    assert.equal(calls.length, 0, 'executeButtonTest must not be called for an invalid type.');
});

test('button editor webview renders terminal test controls above Commands and switches between plain and split modes by tab count', () => {
    const harness = createFakeVscodeHarness();
    const buttonStoreModulePath = path.resolve(__dirname, '..', 'buttonStore.js');
    const editorPanelModulePath = path.resolve(__dirname, '..', 'editorPanel.js');
    const buttonStoreModule = loadWithPatchedVscode<{ ButtonStore: new (context: any) => any }>(buttonStoreModulePath, harness.vscode);
    const editorPanelModule = loadWithPatchedVscode<{ ButtonEditorPanel: any }>(editorPanelModulePath, harness.vscode);
    const context = harness.createExtensionContext();
    const store = new buttonStoreModule.ButtonStore(context);

    editorPanelModule.ButtonEditorPanel.configure(context.globalState, () => undefined);
    editorPanelModule.ButtonEditorPanel.createOrShow(store, context.extensionUri);

    const panel = harness.webviewPanels[0];
    assert.ok(panel, 'Expected a webview panel to be created.');

    assert.match(panel.panel.webview.html, /class="terminal-command-header"[\s\S]*id="terminalTabTestRow"[\s\S]*id="terminal-tab-commands"/, 'Expected the terminal test control row to render above the Commands textbox.');
    assert.match(panel.panel.webview.html, /id="btnTestExecution"/, 'Expected the Test button for the execution group to be present.');

    const runtime = executeWebviewScripts(panel.panel.webview.html);

    const oneTab = createDefaultButton('Global');
    oneTab.id = 'one-tab';
    oneTab.name = 'One Tab';
    oneTab.type = 'TerminalCommand';
    oneTab.terminals = [{ name: 'Terminal 1', commands: 'echo one', dependentOnPrevious: false }];

    const twoTabs = createDefaultButton('Global');
    twoTabs.id = 'two-tabs';
    twoTabs.name = 'Two Tabs';
    twoTabs.type = 'TerminalCommand';
    twoTabs.terminals = [
        { name: 'Terminal 1', commands: 'echo one', dependentOnPrevious: false },
        { name: 'Terminal 2', commands: 'echo two', dependentOnPrevious: false }
    ];

    runtime.dispatchMessage({
        type: 'refreshButtons',
        buttons: [oneTab, twoTabs],
        notes: [],
        keybindings: {},
        workspaceName: 'TestWorkspace'
    });

    runtime.dispatchMessage({ type: 'editButton', buttonId: oneTab.id });
    const rowOne = runtime.document.getElementById('terminalTabTestRow')?.innerHTML ?? '';
    assert.match(rowOne, /id="btnTestTab"/, 'Expected plain Test button for a single tab.');
    assert.doesNotMatch(rowOne, /id="btnTestTabArrow"/, 'Split-button arrow must not render for a single tab.');

    runtime.dispatchMessage({ type: 'editButton', buttonId: twoTabs.id });
    const rowTwo = runtime.document.getElementById('terminalTabTestRow')?.innerHTML ?? '';
    assert.match(rowTwo, /id="btnTestTab"/, 'Expected Test primary button for multiple tabs.');
    assert.match(rowTwo, /id="btnTestTabArrow"/, 'Expected split-button arrow for multiple tabs.');
    assert.match(rowTwo, /id="btnTestAllTabs"/, 'Expected Test All Tabs action for multiple tabs.');

    panel.dispose();
});
