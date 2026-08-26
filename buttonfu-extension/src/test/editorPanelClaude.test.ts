import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createDefaultButton } from '../types';
import { createFakeVscodeHarness, loadWithPatchedVscode } from './helpers/fakeVscode';
import { executeWebviewScripts } from './helpers/webviewRuntime';

function createFixtures(executeButtonTest?: (btn: any) => Promise<void>) {
    const harness = createFakeVscodeHarness();
    const buttonStoreModulePath = path.resolve(__dirname, '..', 'buttonStore.js');
    const editorPanelModulePath = path.resolve(__dirname, '..', 'editorPanel.js');
    const buttonStoreModule = loadWithPatchedVscode<{ ButtonStore: new (context: any) => any }>(buttonStoreModulePath, harness.vscode);
    const editorPanelModule = loadWithPatchedVscode<{ ButtonEditorPanel: any }>(editorPanelModulePath, harness.vscode);
    const context = harness.createExtensionContext();
    const store = new buttonStoreModule.ButtonStore(context);

    editorPanelModule.ButtonEditorPanel.configure(context.globalState, () => undefined, executeButtonTest);
    editorPanelModule.ButtonEditorPanel.createOrShow(store, context.extensionUri);

    const panel = harness.webviewPanels[0];
    assert.ok(panel, 'Expected a webview panel to be created.');
    return { harness, store, panel };
}

test('saveButton normalises the Claude fields arriving from the webview', async () => {
    const { store, panel } = createFixtures();

    try {
        // A button saved before this feature existed: every claude field missing.
        await panel.sendMessage({
            type: 'saveButton',
            button: { id: 'legacy', name: 'Legacy', type: 'TerminalCommand', locality: 'Global' }
        });

        // A newer editor sending values that are not valid.
        await panel.sendMessage({
            type: 'saveButton',
            button: {
                id: 'nonsense', name: 'Nonsense', type: 'ClaudeCommand', locality: 'Global',
                claudeDestination: 'teleport',
                claudePermissionMode: 'yolo',
                claudeEffort: 'ludicrous',
                claudeModel: 7,
                claudeAddDirs: ['C:\\GIT\\Kitae', 42, null],
                claudeExtraArgs: 'not an array',
                claudeWorktree: 'yes'
            }
        });
    } finally {
        panel.dispose();
    }

    const legacy = store.getButton('legacy');
    assert.equal(legacy.claudeDestination, 'panelPrefill');
    assert.equal(legacy.claudePermissionMode, 'bypassPermissions');
    assert.deepEqual(legacy.claudeAddDirs, []);
    assert.deepEqual(legacy.claudeExtraArgs, []);

    const nonsense = store.getButton('nonsense');
    assert.equal(nonsense.claudeDestination, 'panelPrefill');
    assert.equal(nonsense.claudePermissionMode, 'bypassPermissions');
    assert.equal(nonsense.claudeEffort, '');
    assert.equal(nonsense.claudeModel, '');
    assert.deepEqual(nonsense.claudeAddDirs, ['C:\\GIT\\Kitae']);
    assert.deepEqual(nonsense.claudeExtraArgs, []);
    assert.equal(nonsense.claudeWorktree, true);
});

test('a valid Claude button saved from the editor keeps every field it was given', async () => {
    const { store, panel } = createFixtures();

    try {
        await panel.sendMessage({
            type: 'saveButton',
            button: {
                id: 'good', name: 'Good', type: 'ClaudeCommand', locality: 'Global',
                executionText: 'Summarise this repo.',
                claudeDestination: 'newVsCodeWindow',
                claudePermissionMode: 'plan',
                claudeEffort: 'high',
                claudeModel: 'opus',
                claudeTargetFolder: 'C:\\GIT\\Kitae',
                claudeAddDirs: ['C:\\GIT\\Catanari'],
                claudeExtraArgs: ['--append-system-prompt', 'be terse'],
                claudeWorktree: true,
                claudeWorktreeName: 'planning',
                claudeNewWindow: true
            }
        });
    } finally {
        panel.dispose();
    }

    const saved = store.getButton('good');
    assert.equal(saved.claudeDestination, 'newVsCodeWindow');
    assert.equal(saved.claudePermissionMode, 'plan');
    assert.equal(saved.claudeEffort, 'high');
    assert.equal(saved.claudeModel, 'opus');
    assert.equal(saved.claudeTargetFolder, 'C:\\GIT\\Kitae');
    assert.deepEqual(saved.claudeAddDirs, ['C:\\GIT\\Catanari']);
    assert.deepEqual(saved.claudeExtraArgs, ['--append-system-prompt', 'be terse']);
    assert.equal(saved.claudeWorktree, true);
    assert.equal(saved.claudeWorktreeName, 'planning');
    assert.equal(saved.claudeNewWindow, true);
});

test('testButton carries the Claude fields through to the test callback', async () => {
    const calls: any[] = [];
    const { panel } = createFixtures(async (btn: any) => { calls.push(btn); });

    try {
        await panel.sendMessage({
            type: 'testButton',
            button: {
                id: 'claude-test', name: 'Claude Test', type: 'ClaudeCommand',
                executionText: 'Summarise this repo.',
                claudeDestination: 'backgroundAgent',
                claudeModel: 'opus',
                userTokens: []
            }
        });
    } finally {
        panel.dispose();
    }

    assert.equal(calls.length, 1);
    assert.equal(calls[0].type, 'ClaudeCommand');
    assert.equal(calls[0].claudeDestination, 'backgroundAgent');
    assert.equal(calls[0].claudeModel, 'opus');
});

test('the Claude editor section shows only the fields each destination can honour', () => {
    const { panel } = createFixtures();
    const runtime = executeWebviewScripts(panel.panel.webview.html);

    const button = createDefaultButton('Global');
    button.id = 'claude-button';
    button.name = 'Plan this repo';
    button.type = 'ClaudeCommand';
    button.claudeDestination = 'terminalNewWindow';
    button.claudeModel = 'opus';
    button.claudeAddDirs = ['C:\\GIT\\Kitae'];
    button.claudeExtraArgs = ['--append-system-prompt', 'be terse'];

    runtime.dispatchMessage({ type: 'refreshButtons', buttons: [button], keybindings: {} });
    runtime.dispatchMessage({ type: 'editButton', buttonId: button.id });

    assert.equal(runtime.document.getElementById('claudeSection')?.classList.contains('visible'), true);
    assert.equal(runtime.document.getElementById('copilotSection')?.classList.contains('visible'), false);
    assert.equal(runtime.document.getElementById('btn-claudeModel')?.value, 'opus');
    assert.equal(runtime.document.getElementById('btn-claudeExtraArgs')?.value, '--append-system-prompt\nbe terse');
    assert.match(runtime.document.getElementById('claudeAddDirChips')?.innerHTML ?? '', /Kitae/);

    // A terminal destination shows the CLI fields but not the new-window folder.
    assert.equal(runtime.document.getElementById('claudeField-claudeModel')?.classList.contains('visible'), true);
    assert.equal(runtime.document.getElementById('claudeField-claudeTargetFolder')?.classList.contains('visible'), false);
    assert.equal(runtime.document.getElementById('claudeNoRunWarning')?.classList.contains('visible'), false);

    // A new VS Code window needs a folder to open.
    const destination = runtime.document.getElementById('btn-claudeDestination')!;
    destination.value = 'newVsCodeWindow';
    destination.dispatch('change');
    assert.equal(runtime.document.getElementById('claudeField-claudeTargetFolder')?.classList.contains('visible'), true);

    // The panel prefill types the prompt and stops, so it warns and hides the CLI fields.
    destination.value = 'panelPrefill';
    destination.dispatch('change');
    assert.equal(runtime.document.getElementById('claudeNoRunWarning')?.classList.contains('visible'), true);
    assert.equal(runtime.document.getElementById('claudeField-claudeModel')?.classList.contains('visible'), false);
    assert.equal(runtime.document.getElementById('claudeField-claudeNewWindow')?.classList.contains('visible'), true);

    runtime.click('pickClaudeCwdBtn');
    assert.ok(runtime.postedMessages.some((message: any) => message?.type === 'pickClaudeFolder' && message?.target === 'cwd'));

    runtime.dispatchMessage({ type: 'claudeFolderResult', target: 'addDir', folder: 'C:\\GIT\\Catanari' });
    assert.match(runtime.document.getElementById('claudeAddDirChips')?.innerHTML ?? '', /Catanari/);

    panel.dispose();
});

test('switching a button back to a non-Claude type hides the Claude section', () => {
    const { panel } = createFixtures();
    const runtime = executeWebviewScripts(panel.panel.webview.html);

    const type = runtime.document.getElementById('btn-type')!;
    type.value = 'ClaudeCommand';
    type.dispatch('change');
    assert.equal(runtime.document.getElementById('claudeSection')?.classList.contains('visible'), true);

    type.value = 'CopilotCommand';
    type.dispatch('change');
    assert.equal(runtime.document.getElementById('claudeSection')?.classList.contains('visible'), false);
    assert.equal(runtime.document.getElementById('copilotSection')?.classList.contains('visible'), true);

    panel.dispose();
});

test('a new Claude button starts on the panel, with the run-time fields hidden', () => {
    const { panel } = createFixtures();
    const runtime = executeWebviewScripts(panel.panel.webview.html);

    const button = createDefaultButton('Global');
    button.id = 'fresh-button';
    button.name = 'Fresh';
    button.type = 'ClaudeCommand';

    runtime.dispatchMessage({ type: 'refreshButtons', buttons: [button], keybindings: {} });
    runtime.dispatchMessage({ type: 'editButton', buttonId: button.id });

    assert.equal(runtime.document.getElementById('btn-claudeDestination')?.value, 'panelPrefill');
    assert.equal(runtime.document.getElementById('claudeNoRunWarning')?.classList.contains('visible'), true,
        'The warning is the first thing a new button shows, so it has to be there from the start.');
    for (const field of ['claudeModel', 'claudeEffort', 'claudePermissionMode', 'claudeCwd', 'claudeAddDirs']) {
        assert.equal(runtime.document.getElementById(`claudeField-${field}`)?.classList.contains('visible'), false,
            `${field} should be hidden, because the panel has nowhere to take it from.`);
    }
    assert.equal(runtime.document.getElementById('claudeField-claudeNewWindow')?.classList.contains('visible'), true);

    panel.dispose();
});
