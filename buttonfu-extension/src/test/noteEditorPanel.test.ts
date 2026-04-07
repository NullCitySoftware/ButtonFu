import assert = require('node:assert/strict');
import path = require('path');
import test = require('node:test');
import { createDefaultNote } from '../types';
import { createFakeVscodeHarness, loadWithPatchedVscode } from './helpers/fakeVscode';
import { executeWebviewScripts } from './helpers/webviewRuntime';

test('note editor uses the shared icon picker and shared Copilot model lookup', async () => {
    const harness = createFakeVscodeHarness();
    harness.vscode.lm = {
        selectChatModels: async () => ([
            {
                id: 'gpt-5.4',
                name: 'GPT-5.4',
                vendor: 'GitHub',
                family: 'gpt-5',
                maxInputTokens: 128000
            }
        ])
    };

    const noteStoreModulePath = path.resolve(__dirname, '..', 'noteStore.js');
    const noteEditorPanelModulePath = path.resolve(__dirname, '..', 'noteEditorPanel.js');
    const noteStoreModule = loadWithPatchedVscode<{ NoteStore: new (context: any) => any }>(noteStoreModulePath, harness.vscode);
    const noteEditorPanelModule = loadWithPatchedVscode<{ NoteEditorPanel: any }>(noteEditorPanelModulePath, harness.vscode);
    const context = harness.createExtensionContext();
    const store = new noteStoreModule.NoteStore(context);

    noteEditorPanelModule.NoteEditorPanel.configure(context.globalState);
    noteEditorPanelModule.NoteEditorPanel.createOrShow(store, context.extensionUri);

    const panel = harness.webviewPanels[0];
    assert.ok(panel, 'Expected a note editor webview panel to be created.');
    assert.match(panel.panel.webview.html, /<span class="version">/);
    assert.match(panel.panel.webview.html, /id="headerDebugStamp"/);
    assert.match(panel.panel.webview.html, /id="editorTitle">Create Note</);
    assert.match(panel.panel.webview.html, /icon-picker-trigger/);
    assert.match(panel.panel.webview.html, /type="hidden" id="nodeIcon"/);
    assert.match(panel.panel.webview.html, /id="nodeColourPicker"/);
    assert.match(panel.panel.webview.html, /id="noteModelAutocomplete"/);
    assert.match(panel.panel.webview.html, /id="noteModelAutocompleteTrigger"/);
    assert.match(panel.panel.webview.html, /id="userTokensCardToggle"/);
    assert.equal(panel.panel.webview.html.includes("split(/\\r?\\n/)"), true);
    assert.equal(panel.panel.webview.html.includes("join('\\n')"), true);
    assert.ok(panel.panel.webview.html.indexOf('id="noteContent"') < panel.panel.webview.html.indexOf('id="noteAttachFiles"'));
    assert.doesNotMatch(panel.panel.webview.html, /list="iconList"/);

    await panel.sendMessage({ type: 'getModels' });

    const modelResult = panel.postedMessages.find((message: any) => message?.type === 'modelsResult') as any;
    assert.ok(modelResult, 'Expected the note editor to respond with a modelsResult message.');
    assert.deepEqual(modelResult.models, [
        {
            id: 'gpt-5.4',
            name: 'GPT-5.4',
            vendor: 'GitHub',
            family: 'gpt-5',
            maxInputTokens: 128000
        }
    ]);

    panel.dispose();
});

test('note editor webview script boots and the icon, model, mode, colour, attachment, and card controls stay live', () => {
    const harness = createFakeVscodeHarness();
    const noteStoreModulePath = path.resolve(__dirname, '..', 'noteStore.js');
    const noteEditorPanelModulePath = path.resolve(__dirname, '..', 'noteEditorPanel.js');
    const noteStoreModule = loadWithPatchedVscode<{ NoteStore: new (context: any) => any }>(noteStoreModulePath, harness.vscode);
    const noteEditorPanelModule = loadWithPatchedVscode<{ NoteEditorPanel: any }>(noteEditorPanelModulePath, harness.vscode);
    const context = harness.createExtensionContext();
    const store = new noteStoreModule.NoteStore(context);

    noteEditorPanelModule.NoteEditorPanel.configure(context.globalState);
    noteEditorPanelModule.NoteEditorPanel.createOrShow(store, context.extensionUri);

    const panel = harness.webviewPanels[0];
    assert.ok(panel, 'Expected a note editor webview panel to be created.');

    const runtime = executeWebviewScripts(panel.panel.webview.html);
    const note = createDefaultNote('Global');
    note.name = 'Prompt Note';
    note.content = 'Body';
    note.copilotAttachFiles = ['docs/spec.md'];

    assert.ok(runtime.postedMessages.some((message: any) => message?.type === 'requestData'));
    assert.ok(runtime.postedMessages.some((message: any) => message?.type === 'getModels'));
    assert.match(runtime.document.getElementById('noteCopilotMode')?.innerHTML ?? '', /Agent/);

    runtime.dispatchMessage({
        type: 'setState',
        nodes: [note],
        request: {
            mode: 'edit',
            kind: 'note',
            nodeId: note.id,
            locality: note.locality,
            parentId: note.parentId
        },
        workspaceName: 'TestWorkspace',
        hasWorkspace: true
    });
    assert.equal(runtime.document.getElementById('editorTitle')?.textContent, 'Edit Note');
    assert.equal(runtime.document.getElementById('noteAttachFiles')?.value, 'docs/spec.md');

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
    runtime.click('nodeIconTrigger');
    assert.equal(runtime.document.getElementById('nodeIconDropdown')?.classList.contains('visible'), true);

    runtime.click('noteModelAutocompleteTrigger');
    assert.equal(runtime.document.getElementById('noteModelAutocomplete')?.classList.contains('visible'), true);
    assert.match(runtime.document.getElementById('noteModelAutocomplete')?.innerHTML ?? '', /GPT-5\.4/);

    const colourPicker = runtime.document.getElementById('nodeColourPicker');
    assert.ok(colourPicker, 'Expected the shared note colour picker to be rendered.');
    colourPicker.value = '#654321';
    colourPicker.dispatch('change');
    assert.equal(runtime.document.getElementById('nodeColour')?.value, '#654321');

    runtime.click('pickFilesBtn');
    assert.ok(runtime.postedMessages.some((message: any) => message?.type === 'pickFiles'));

    runtime.dispatchMessage({ type: 'filesPicked', files: ['src/extra.ts', 'docs/spec.md'] });
    assert.equal(runtime.document.getElementById('noteAttachFiles')?.value, 'docs/spec.md\nsrc/extra.ts');

    runtime.click('userTokensCardToggle');
    assert.equal(runtime.document.getElementById('userTokensCardBody')?.style.display, 'none');
    assert.ok(runtime.postedMessages.some((message: any) => message?.type === 'saveUiState' && message.key === 'userTokensCollapsed' && message.value === true));

    panel.dispose();
});

test('note editor keeps Name before Kind and blocks whitespace-only names until valid input is provided', () => {
    const harness = createFakeVscodeHarness();
    const noteStoreModulePath = path.resolve(__dirname, '..', 'noteStore.js');
    const noteEditorPanelModulePath = path.resolve(__dirname, '..', 'noteEditorPanel.js');
    const noteStoreModule = loadWithPatchedVscode<{ NoteStore: new (context: any) => any }>(noteStoreModulePath, harness.vscode);
    const noteEditorPanelModule = loadWithPatchedVscode<{ NoteEditorPanel: any }>(noteEditorPanelModulePath, harness.vscode);
    const context = harness.createExtensionContext();
    const store = new noteStoreModule.NoteStore(context);

    noteEditorPanelModule.NoteEditorPanel.configure(context.globalState);
    noteEditorPanelModule.NoteEditorPanel.createOrShow(store, context.extensionUri);

    const panel = harness.webviewPanels[0];
    assert.ok(panel, 'Expected a note editor webview panel to be created.');
    assert.ok(panel.panel.webview.html.indexOf('id="nodeName"') < panel.panel.webview.html.indexOf('id="nodeKind"'));

    const runtime = executeWebviewScripts(panel.panel.webview.html);

    runtime.click('saveBtn');
    assert.equal(runtime.postedMessages.some((message: any) => message?.type === 'saveNode'), false);
    assert.equal(runtime.document.getElementById('nodeName')?.classList.contains('input-error'), true);
    assert.equal(runtime.document.getElementById('nodeNameError')?.classList.contains('visible'), true);
    assert.equal(runtime.document.getElementById('nodeNameError')?.textContent, 'A name is required.');

    const nameInput = runtime.document.getElementById('nodeName');
    assert.ok(nameInput, 'Expected the note name input to exist.');

    nameInput.value = '   ';
    nameInput.dispatch('input');
    assert.equal(runtime.document.getElementById('nodeName')?.classList.contains('input-error'), true);
    assert.equal(runtime.document.getElementById('nodeNameError')?.classList.contains('visible'), true);

    nameInput.value = 'Valid note';
    nameInput.dispatch('input');
    assert.equal(runtime.document.getElementById('nodeName')?.classList.contains('input-error'), false);
    assert.equal(runtime.document.getElementById('nodeNameError')?.classList.contains('visible'), false);

    runtime.click('saveBtn');
    assert.equal(runtime.postedMessages.some((message: any) => message?.type === 'saveNode'), true);

    panel.dispose();
});

test('note editor syncs the default icon with Kind changes without overwriting custom icons', () => {
    const harness = createFakeVscodeHarness();
    const noteStoreModulePath = path.resolve(__dirname, '..', 'noteStore.js');
    const noteEditorPanelModulePath = path.resolve(__dirname, '..', 'noteEditorPanel.js');
    const noteStoreModule = loadWithPatchedVscode<{ NoteStore: new (context: any) => any }>(noteStoreModulePath, harness.vscode);
    const noteEditorPanelModule = loadWithPatchedVscode<{ NoteEditorPanel: any }>(noteEditorPanelModulePath, harness.vscode);
    const context = harness.createExtensionContext();
    const store = new noteStoreModule.NoteStore(context);

    noteEditorPanelModule.NoteEditorPanel.configure(context.globalState);
    noteEditorPanelModule.NoteEditorPanel.createOrShow(store, context.extensionUri);

    const panel = harness.webviewPanels[0];
    assert.ok(panel, 'Expected a note editor webview panel to be created.');

    const runtime = executeWebviewScripts(panel.panel.webview.html);
    runtime.dispatchMessage({
        type: 'setState',
        nodes: [],
        request: {
            mode: 'new',
            kind: 'note',
            locality: 'Global',
            parentId: null
        },
        workspaceName: 'TestWorkspace',
        hasWorkspace: true
    });

    const kindSelect = runtime.document.getElementById('nodeKind');
    const iconInput = runtime.document.getElementById('nodeIcon');
    assert.ok(kindSelect, 'Expected the Kind input to exist.');
    assert.ok(iconInput, 'Expected the Icon input to exist.');

    assert.equal(iconInput.value, 'note');
    assert.equal(runtime.document.getElementById('editorTitle')?.textContent, 'Create Note');

    kindSelect.value = 'folder';
    kindSelect.dispatch('change');
    assert.equal(iconInput.value, 'folder');
    assert.equal(runtime.document.getElementById('editorTitle')?.textContent, 'Create Folder');

    kindSelect.value = 'note';
    kindSelect.dispatch('change');
    assert.equal(iconInput.value, 'note');
    assert.equal(runtime.document.getElementById('editorTitle')?.textContent, 'Create Note');

    iconInput.value = 'book';
    kindSelect.value = 'folder';
    kindSelect.dispatch('change');
    assert.equal(iconInput.value, 'book');

    panel.dispose();
});

test('note editor persists the User Tokens card collapse state across sessions', async () => {
    const harness = createFakeVscodeHarness();
    const noteStoreModulePath = path.resolve(__dirname, '..', 'noteStore.js');
    const noteEditorPanelModulePath = path.resolve(__dirname, '..', 'noteEditorPanel.js');
    const noteStoreModule = loadWithPatchedVscode<{ NoteStore: new (context: any) => any }>(noteStoreModulePath, harness.vscode);
    const noteEditorPanelModule = loadWithPatchedVscode<{ NoteEditorPanel: any }>(noteEditorPanelModulePath, harness.vscode);
    const context = harness.createExtensionContext();
    const store = new noteStoreModule.NoteStore(context);

    noteEditorPanelModule.NoteEditorPanel.configure(context.globalState);
    noteEditorPanelModule.NoteEditorPanel.createOrShow(store, context.extensionUri);

    const firstPanel = harness.webviewPanels[0];
    assert.ok(firstPanel, 'Expected the first note editor panel to be created.');

    await firstPanel.sendMessage({ type: 'saveUiState', key: 'userTokensCollapsed', value: true });
    assert.deepEqual(context.globalState.get('noteEditor.uiState'), { userTokensCollapsed: true });

    firstPanel.dispose();
    noteEditorPanelModule.NoteEditorPanel.createOrShow(store, context.extensionUri);

    const secondPanel = harness.webviewPanels[1];
    assert.ok(secondPanel, 'Expected the second note editor panel to be created.');

    const runtime = executeWebviewScripts(secondPanel.panel.webview.html);
    assert.equal(runtime.document.getElementById('userTokensCardBody')?.style.display, 'none');

    secondPanel.dispose();
});

test('note editor delete delegates to the command and resets to create mode after confirmation', async () => {
    const harness = createFakeVscodeHarness();
    const noteStoreModulePath = path.resolve(__dirname, '..', 'noteStore.js');
    const noteEditorPanelModulePath = path.resolve(__dirname, '..', 'noteEditorPanel.js');
    const noteStoreModule = loadWithPatchedVscode<{ NoteStore: new (context: any) => any }>(noteStoreModulePath, harness.vscode);
    const noteEditorPanelModule = loadWithPatchedVscode<{ NoteEditorPanel: any }>(noteEditorPanelModulePath, harness.vscode);
    const context = harness.createExtensionContext();
    const store = new noteStoreModule.NoteStore(context);
    const note = createDefaultNote('Global');
    note.name = 'Delete Me';
    const saved = await store.saveNode(note);

    harness.queueWarningMessageResult('Delete');
    harness.setExternalCommandHandler('buttonfu.deleteNoteNode', async (nodeId: string) => {
        const target = store.getNode(nodeId);
        if (!target) {
            return;
        }

        const confirmed = await harness.vscode.window.showWarningMessage(
            `Delete ${target.kind === 'folder' ? 'folder' : 'note'} "${target.name}"?`,
            { modal: true },
            'Delete'
        );

        if (confirmed === 'Delete') {
            await store.deleteNode(nodeId);
        }
    });

    noteEditorPanelModule.NoteEditorPanel.configure(context.globalState);
    noteEditorPanelModule.NoteEditorPanel.createOrShowWithNode(store, context.extensionUri, saved.id);

    const panel = harness.webviewPanels[0];
    assert.ok(panel, 'Expected a note editor webview panel to be created.');

    await panel.sendMessage({ type: 'deleteNode', id: saved.id });

    assert.equal(store.getNode(saved.id), undefined);
    assert.ok(harness.executedCommands.some((entry) => entry.command === 'buttonfu.deleteNoteNode' && entry.args[0] === saved.id));

    const setStateMessages = panel.postedMessages.filter((message: any) => message?.type === 'setState') as Array<any>;
    const latestState = setStateMessages.at(-1);
    assert.ok(latestState, 'Expected the note editor to post an updated state after deletion.');
    assert.equal(latestState.request.mode, 'new');
    assert.equal(latestState.request.kind, 'note');
    assert.equal(latestState.request.locality, 'Global');

    panel.dispose();
});

test('getAvailableCopilotModels falls back, dedupes, and sorts the discovered models', async () => {
    const harness = createFakeVscodeHarness();
    const webviewControlsModulePath = path.resolve(__dirname, '..', 'webviewControls.js');
    const selectors: Array<{ vendor?: string } | undefined> = [];

    harness.vscode.lm = {
        selectChatModels: async (selector?: { vendor?: string }) => {
            selectors.push(selector);
            if (selector?.vendor === 'copilot') {
                return [];
            }

            return [
                {
                    id: 'gpt-5.4',
                    name: 'GPT-5.4',
                    vendor: 'GitHub',
                    family: 'gpt-5',
                    maxInputTokens: 128000
                },
                {
                    id: 'gpt-4.1',
                    name: 'GPT-4.1',
                    vendor: 'Azure',
                    family: 'gpt-4',
                    maxInputTokens: 64000
                },
                {
                    id: 'gpt-5.4',
                    name: 'GPT-5.4 Duplicate',
                    vendor: 'GitHub',
                    family: 'gpt-5',
                    maxInputTokens: 128000
                }
            ];
        }
    };

    const webviewControls = loadWithPatchedVscode<{ getAvailableCopilotModels(): Promise<any[]> }>(webviewControlsModulePath, harness.vscode);
    const models = await webviewControls.getAvailableCopilotModels();

    assert.deepEqual(selectors, [{ vendor: 'copilot' }, undefined]);
    assert.deepEqual(models, [
        {
            id: 'gpt-4.1',
            name: 'GPT-4.1',
            vendor: 'Azure',
            family: 'gpt-4',
            maxInputTokens: 64000
        },
        {
            id: 'gpt-5.4',
            name: 'GPT-5.4',
            vendor: 'GitHub',
            family: 'gpt-5',
            maxInputTokens: 128000
        }
    ]);
});