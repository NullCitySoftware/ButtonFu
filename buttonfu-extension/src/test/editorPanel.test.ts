import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createDefaultButton, createDefaultNote } from '../types';
import { createFakeVscodeHarness, loadWithPatchedVscode } from './helpers/fakeVscode';
import { executeWebviewScripts } from './helpers/webviewRuntime';

test('saveOptions persists showNotes and refreshes the button panel options callback', async () => {
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
                columns: 3
            }
        });
    } finally {
        panel.dispose();
    }

    assert.deepEqual(harness.configurationUpdates.filter((entry) => entry.key === 'buttonfu.showNotes'), [
        { key: 'buttonfu.showNotes', value: false }
    ]);
    assert.equal(context.globalState.get('options.showBuildInformation'), true);
    assert.equal(context.globalState.get('options.showAddAndEditorButtons'), false);
    assert.equal(context.globalState.get('options.columns'), 3);
    assert.equal(optionsChanged, 1);
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