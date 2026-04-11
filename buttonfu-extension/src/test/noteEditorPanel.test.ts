import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
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
    assert.match(panel.panel.webview.html, /id="noteCategory"/);
    assert.match(panel.panel.webview.html, /id="noteDefaultAction"/);
    assert.doesNotMatch(panel.panel.webview.html, /id="nodeKind"/);
    assert.doesNotMatch(panel.panel.webview.html, /id="nodeParent"/);

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

test('note editor webview script boots and the icon, model, default action, colour, attachment, and card controls stay live', () => {
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
    note.category = 'Prompts';
    note.defaultAction = 'copy';
    note.content = 'Body';
    note.copilotAttachFiles = ['docs/spec.md'];

    assert.ok(runtime.postedMessages.some((message: any) => message?.type === 'requestData'));
    assert.ok(runtime.postedMessages.some((message: any) => message?.type === 'getModels'));
    assert.match(runtime.document.getElementById('noteCopilotMode')?.innerHTML ?? '', /Agent/);
    assert.match(runtime.document.getElementById('noteDefaultAction')?.innerHTML ?? '', /Copy to Clipboard/);

    runtime.dispatchMessage({
        type: 'setState',
        nodes: [note],
        request: {
            mode: 'edit',
            nodeId: note.id,
            locality: note.locality
        },
        workspaceName: 'TestWorkspace',
        hasWorkspace: true
    });
    assert.equal(runtime.document.getElementById('editorTitle')?.textContent, 'Edit Note');
    assert.equal(runtime.document.getElementById('noteCategory')?.value, 'Prompts');
    assert.equal(runtime.document.getElementById('noteDefaultAction')?.value, 'copy');
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

test('note editor blocks whitespace-only names until valid input is provided', () => {
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
    assert.ok(panel.panel.webview.html.indexOf('id="nodeName"') < panel.panel.webview.html.indexOf('id="noteCategory"'));

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

test('note editor createOrShowWithNew seeds the requested locality', () => {
    const harness = createFakeVscodeHarness();
    const noteStoreModulePath = path.resolve(__dirname, '..', 'noteStore.js');
    const noteEditorPanelModulePath = path.resolve(__dirname, '..', 'noteEditorPanel.js');
    const noteStoreModule = loadWithPatchedVscode<{ NoteStore: new (context: any) => any }>(noteStoreModulePath, harness.vscode);
    const noteEditorPanelModule = loadWithPatchedVscode<{ NoteEditorPanel: any }>(noteEditorPanelModulePath, harness.vscode);
    const context = harness.createExtensionContext();
    const store = new noteStoreModule.NoteStore(context);

    noteEditorPanelModule.NoteEditorPanel.configure(context.globalState);
    noteEditorPanelModule.NoteEditorPanel.createOrShowWithNew(store, context.extensionUri, 'Local');

    const panel = harness.webviewPanels[0];
    assert.ok(panel, 'Expected a note editor webview panel to be created.');

    const runtime = executeWebviewScripts(panel.panel.webview.html);
    runtime.dispatchMessage({
        type: 'setState',
        nodes: [],
        request: {
            mode: 'new',
            locality: 'Local'
        },
        workspaceName: 'TestWorkspace',
        hasWorkspace: true
    });

    assert.equal(runtime.document.getElementById('nodeLocality')?.value, 'Local');
    assert.equal(runtime.document.getElementById('noteDefaultAction')?.value, 'open');
    assert.equal(runtime.document.activeElement?.id, 'nodeName');

    panel.dispose();
});

test('note editor keeps Local scope available even without a workspace folder', () => {
    const harness = createFakeVscodeHarness();
    const noteStoreModulePath = path.resolve(__dirname, '..', 'noteStore.js');
    const noteEditorPanelModulePath = path.resolve(__dirname, '..', 'noteEditorPanel.js');
    const noteStoreModule = loadWithPatchedVscode<{ NoteStore: new (context: any) => any }>(noteStoreModulePath, harness.vscode);
    const noteEditorPanelModule = loadWithPatchedVscode<{ NoteEditorPanel: any }>(noteEditorPanelModulePath, harness.vscode);
    const context = harness.createExtensionContext();
    const store = new noteStoreModule.NoteStore(context);

    noteEditorPanelModule.NoteEditorPanel.configure(context.globalState);
    noteEditorPanelModule.NoteEditorPanel.createOrShowWithNew(store, context.extensionUri, 'Local');

    const panel = harness.webviewPanels[0];
    assert.ok(panel, 'Expected a note editor webview panel to be created.');

    const runtime = executeWebviewScripts(panel.panel.webview.html);
    runtime.dispatchMessage({
        type: 'setState',
        nodes: [],
        request: {
            mode: 'new',
            locality: 'Local'
        },
        workspaceName: null,
        hasWorkspace: false
    });

    const localitySelect = runtime.document.getElementById('nodeLocality');
    assert.ok(localitySelect, 'Expected the scope selector to exist.');
    assert.equal(localitySelect.disabled, false);
    assert.match(localitySelect.innerHTML, /value="Global"/);
    assert.match(localitySelect.innerHTML, /value="Local"/);
    assert.equal(localitySelect.value, 'Local');

    panel.dispose();
});

test('note editor preserves a user-selected scope for a new note across refreshes and saves it', () => {
    const harness = createFakeVscodeHarness();
    const noteStoreModulePath = path.resolve(__dirname, '..', 'noteStore.js');
    const noteEditorPanelModulePath = path.resolve(__dirname, '..', 'noteEditorPanel.js');
    const noteStoreModule = loadWithPatchedVscode<{ NoteStore: new (context: any) => any }>(noteStoreModulePath, harness.vscode);
    const noteEditorPanelModule = loadWithPatchedVscode<{ NoteEditorPanel: any }>(noteEditorPanelModulePath, harness.vscode);
    const context = harness.createExtensionContext();
    const store = new noteStoreModule.NoteStore(context);

    noteEditorPanelModule.NoteEditorPanel.configure(context.globalState);
    noteEditorPanelModule.NoteEditorPanel.createOrShowWithNew(store, context.extensionUri, 'Global');

    const panel = harness.webviewPanels[0];
    assert.ok(panel, 'Expected a note editor webview panel to be created.');

    const runtime = executeWebviewScripts(panel.panel.webview.html);
    runtime.dispatchMessage({
        type: 'setState',
        nodes: [],
        request: {
            mode: 'new',
            locality: 'Global'
        },
        workspaceName: 'TestWorkspace',
        hasWorkspace: true
    });

    const localitySelect = runtime.document.getElementById('nodeLocality');
    assert.ok(localitySelect, 'Expected the scope selector to exist.');
    localitySelect.value = 'Local';
    localitySelect.dispatch('change');

    runtime.dispatchMessage({
        type: 'setState',
        nodes: [],
        request: {
            mode: 'new',
            locality: 'Global'
        },
        workspaceName: 'TestWorkspace',
        hasWorkspace: true
    });

    assert.equal(runtime.document.getElementById('nodeLocality')?.value, 'Local');

    const nameInput = runtime.document.getElementById('nodeName');
    assert.ok(nameInput, 'Expected the note name input to exist.');
    nameInput.value = 'Scoped note';
    nameInput.dispatch('input');

    runtime.click('saveBtn');

    const saveMessage = runtime.postedMessages.filter((message: any) => message?.type === 'saveNode').at(-1) as any;
    assert.ok(saveMessage, 'Expected a saveNode message to be posted.');
    assert.equal(saveMessage.note.locality, 'Local');

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
            `Delete note "${target.name}"?`,
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
    assert.equal(latestState.request.locality, 'Global');

    panel.dispose();
});