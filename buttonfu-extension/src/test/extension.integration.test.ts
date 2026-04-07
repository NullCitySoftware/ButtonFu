import assert = require('node:assert/strict');
import fs = require('fs');
import path = require('path');
import test = require('node:test');
import { createDefaultButton } from '../types';
import { createFakeVscodeHarness, loadWithPatchedVscode } from './helpers/fakeVscode';

test('activate registers notes commands and providers', async () => {
    const harness = createFakeVscodeHarness();
    const extensionModulePath = path.resolve(__dirname, '..', 'extension.js');
    const extension = loadWithPatchedVscode<{ activate(context: any): void }>(extensionModulePath, harness.vscode);
    const context = harness.createExtensionContext();

    extension.activate(context);

    const expectedCommands = [
        'buttonfu.openEditor',
        'buttonfu.executeButton',
        'buttonfu.addButton',
        'buttonfu.editButton',
        'buttonfu.deleteButton',
        'buttonfu.refreshButtons',
        'buttonfu.openNoteEditor',
        'buttonfu.addNote',
        'buttonfu.addNoteFolder',
        'buttonfu.openNoteActions',
        'buttonfu.previewNote',
        'buttonfu.copyNote',
        'buttonfu.insertNote',
        'buttonfu.sendNoteToCopilot',
        'buttonfu.editNoteNode',
        'buttonfu.deleteNoteNode',
        'buttonfu.refreshNotes',
        'buttonfu.moveNoteUp',
        'buttonfu.moveNoteDown',
        'buttonfu.moveNoteToFolder'
    ];

    for (const command of expectedCommands) {
        assert.ok(harness.registeredCommands.has(command), `Expected ${command} to be registered.`);
    }

    assert.ok(harness.registeredWebviewProviders.has('buttonfu.buttonsView'));
    assert.ok(harness.registeredTreeViews.has('buttonfu.notesView'));
    assert.ok(harness.registeredContentProviders.has('buttonfu-note-preview'));
    assert.ok(context.subscriptions.length > 0, 'Activation should populate context subscriptions.');
});

test('addNote prompts for scope when invoked without a tree target', async () => {
    const harness = createFakeVscodeHarness();
    const extensionModulePath = path.resolve(__dirname, '..', 'extension.js');
    let createRequest: { kind: string; locality: string; parentId: string | null } | undefined;

    const extension = loadWithPatchedVscode<{ activate(context: any): void }>(extensionModulePath, harness.vscode, {
        './noteEditorPanel': {
            NoteEditorPanel: {
                createOrShow: () => undefined,
                createOrShowWithNode: () => undefined,
                createOrShowWithNew: (_store: unknown, _extensionUri: unknown, kind: string, locality: string, parentId: string | null) => {
                    createRequest = { kind, locality, parentId };
                }
            }
        }
    });
    const context = harness.createExtensionContext();

    extension.activate(context);
    harness.queueQuickPickResult({ locality: 'Local' });

    await harness.registeredCommands.get('buttonfu.addNote')?.();

    assert.equal(harness.quickPickCalls.length, 1);
    assert.deepEqual(createRequest, {
        kind: 'note',
        locality: 'Local',
        parentId: null
    });
});

test('openNoteEditor is enabled by default and opens the editor', async () => {
    const harness = createFakeVscodeHarness();
    const extensionModulePath = path.resolve(__dirname, '..', 'extension.js');
    let opened = false;

    const extension = loadWithPatchedVscode<{ activate(context: any): void }>(extensionModulePath, harness.vscode, {
        './noteEditorPanel': {
            NoteEditorPanel: {
                createOrShow: () => { opened = true; },
                createOrShowWithNode: () => undefined,
                createOrShowWithNew: () => undefined,
                closeCurrent: () => undefined
            }
        }
    });
    const context = harness.createExtensionContext();

    extension.activate(context);
    await harness.registeredCommands.get('buttonfu.openNoteEditor')?.();

    assert.equal(opened, true);
    assert.deepEqual(harness.informationMessages, []);
});

test('notes commands are blocked when the showNotes setting is disabled', async () => {
    const harness = createFakeVscodeHarness();
    const extensionModulePath = path.resolve(__dirname, '..', 'extension.js');
    let opened = false;

    const extension = loadWithPatchedVscode<{ activate(context: any): void }>(extensionModulePath, harness.vscode, {
        './noteEditorPanel': {
            NoteEditorPanel: {
                createOrShow: () => { opened = true; },
                createOrShowWithNode: () => undefined,
                createOrShowWithNew: () => undefined,
                closeCurrent: () => undefined
            }
        }
    });
    const context = harness.createExtensionContext();

    extension.activate(context);
    await harness.vscode.workspace.getConfiguration('buttonfu').update('showNotes', false);
    await harness.registeredCommands.get('buttonfu.openNoteEditor')?.();

    assert.equal(opened, false);
    assert.deepEqual(harness.informationMessages, [
        'ButtonFu Notes are disabled. Enable "Show Notes" in ButtonFu Options to use the Notes feature.'
    ]);
});

test('package manifest hides the native notes view and keeps Notes enabled through the sidebar section setting', () => {
    const packageJsonPath = path.resolve(__dirname, '..', '..', 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

    const notesView = packageJson.contributes.views.buttonfu.find((view: { id: string }) => view.id === 'buttonfu.notesView');
    const notesSetting = packageJson.contributes.configuration.properties['buttonfu.showNotes'];
    const commandPalette = packageJson.contributes.menus.commandPalette;

    assert.equal(notesView.when, 'false');
    assert.equal(notesSetting.default, true);
    assert.match(notesSetting.description, /Notes section/);
    assert.ok(commandPalette.some((item: { command: string; when: string }) => item.command === 'buttonfu.openNoteEditor' && item.when === 'config.buttonfu.showNotes'));
});

test('package manifest keeps the legacy Buttons view toolbar actions', () => {
    const packageJsonPath = path.resolve(__dirname, '..', '..', 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const viewTitle = packageJson.contributes.menus['view/title'];

    const addButton = viewTitle.find((item: { command: string; when: string }) => item.command === 'buttonfu.addButton' && item.when === 'view == buttonfu.buttonsView');
    const openEditor = viewTitle.find((item: { command: string; when: string }) => item.command === 'buttonfu.openEditor' && item.when === 'view == buttonfu.buttonsView');
    const refreshButtons = viewTitle.find((item: { command: string; when: string }) => item.command === 'buttonfu.refreshButtons' && item.when === 'view == buttonfu.buttonsView');

    assert.equal(addButton, undefined);
    assert.equal(openEditor.group, 'navigation@1');
    assert.equal(refreshButtons.group, 'navigation@2');
});

test('disabling showNotes closes the note editor and refreshes the tree', async () => {
    const harness = createFakeVscodeHarness();
    const extensionModulePath = path.resolve(__dirname, '..', 'extension.js');
    let closed = 0;
    let refreshed = 0;

    const extension = loadWithPatchedVscode<{ activate(context: any): void }>(extensionModulePath, harness.vscode, {
        './noteEditorPanel': {
            NoteEditorPanel: {
                createOrShow: () => undefined,
                createOrShowWithNode: () => undefined,
                createOrShowWithNew: () => undefined,
                closeCurrent: () => { closed += 1; }
            }
        },
        './noteTreeProvider': {
            NoteTreeProvider: class NoteTreeProviderStub {
                static viewType = 'buttonfu.notesView';

                constructor(_store: unknown) {}

                refresh(): void {
                    refreshed += 1;
                }
            }
        }
    });
    const context = harness.createExtensionContext();

    extension.activate(context);
    await harness.vscode.workspace.getConfiguration('buttonfu').update('showNotes', false);

    assert.equal(closed, 1);
    assert.equal(refreshed, 1);
});

test('dynamic button commands are registered for saved buttons and removed after deletion', async () => {
    const harness = createFakeVscodeHarness();
    const extensionModulePath = path.resolve(__dirname, '..', 'extension.js');
    const extension = loadWithPatchedVscode<{ activate(context: any): void }>(extensionModulePath, harness.vscode);
    const context = harness.createExtensionContext();

    const button = createDefaultButton('Global');
    button.id = 'dynamic-button';
    button.name = 'Dynamic Button';
    button.executionText = 'echo dynamic';

    await harness.vscode.workspace.getConfiguration('buttonfu').update('globalButtons', [button]);
    extension.activate(context);

    assert.ok(harness.registeredCommands.has('buttonfu.run.dynamic-button'));

    harness.queueWarningMessageResult('Delete');
    await harness.registeredCommands.get('buttonfu.deleteButton')?.({ buttonId: button.id });

    assert.equal(harness.registeredCommands.has('buttonfu.run.dynamic-button'), false);
});