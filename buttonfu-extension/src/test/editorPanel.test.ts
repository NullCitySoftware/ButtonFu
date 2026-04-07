import assert = require('node:assert/strict');
import path = require('path');
import test = require('node:test');
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

    panel.dispose();
});