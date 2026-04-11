import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { ApiResult, ButtonConfig, NoteConfig } from '../types';
import type { DevApiSmokeResult } from '../devApiSmoke';
import { createDefaultButton } from '../types';
import { createFakeVscodeHarness, loadWithPatchedVscode } from './helpers/fakeVscode';

const DEV_RESET_API_SMOKE_COMMAND = 'buttonfu.dev.resetApiSmokeData';
const DEV_CLEAR_API_SMOKE_COMMAND = 'buttonfu.dev.clearApiSmokeData';
const DEV_CLEAR_DRIVE_NET_SMOKE_COMMAND = 'buttonfu.dev.clearDriveNetSmokeData';

test('activate registers the flat note commands and providers', async () => {
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
        'buttonfu.api.createButton',
        'buttonfu.api.getButton',
        'buttonfu.api.listButtons',
        'buttonfu.api.updateButton',
        'buttonfu.api.deleteButton',
        'buttonfu.openNoteEditor',
        'buttonfu.addNote',
        'buttonfu.executeNote',
        'buttonfu.openNoteActions',
        'buttonfu.previewNote',
        'buttonfu.copyNote',
        'buttonfu.insertNote',
        'buttonfu.sendNoteToCopilot',
        'buttonfu.editNoteNode',
        'buttonfu.deleteNoteNode',
        'buttonfu.refreshNotes',
        'buttonfu.api.createNote',
        'buttonfu.api.getNote',
        'buttonfu.api.listNotes',
        'buttonfu.api.updateNote',
        'buttonfu.api.deleteNote',
        DEV_RESET_API_SMOKE_COMMAND,
        DEV_CLEAR_API_SMOKE_COMMAND,
        DEV_CLEAR_DRIVE_NET_SMOKE_COMMAND
    ];

    for (const command of expectedCommands) {
        assert.ok(harness.registeredCommands.has(command), `Expected ${command} to be registered.`);
    }

    assert.ok(harness.registeredWebviewProviders.has('buttonfu.buttonsView'));
    assert.equal(harness.registeredTreeViews.has('buttonfu.notesView'), false);
    assert.ok(harness.registeredContentProviders.has('buttonfu-note-preview'));
    assert.ok(context.subscriptions.length > 0, 'Activation should populate context subscriptions.');
});

test('production activation does not register development-only smoke commands', async () => {
    const harness = createFakeVscodeHarness();
    harness.setExtensionMode(harness.vscode.ExtensionMode.Production);
    const extensionModulePath = path.resolve(__dirname, '..', 'extension.js');
    const extension = loadWithPatchedVscode<{ activate(context: any): void }>(extensionModulePath, harness.vscode);
    const context = harness.createExtensionContext();

    extension.activate(context);

    assert.equal(harness.registeredCommands.has(DEV_RESET_API_SMOKE_COMMAND), false);
    assert.equal(harness.registeredCommands.has(DEV_CLEAR_API_SMOKE_COMMAND), false);
    assert.equal(harness.registeredCommands.has(DEV_CLEAR_DRIVE_NET_SMOKE_COMMAND), false);
});

test('button api commands create list update get and delete through the registered command surface', async () => {
    const harness = createFakeVscodeHarness();
    const extensionModulePath = path.resolve(__dirname, '..', 'extension.js');
    const extension = loadWithPatchedVscode<{ activate(context: any): void }>(extensionModulePath, harness.vscode);
    const context = harness.createExtensionContext();

    extension.activate(context);

    const created = await harness.vscode.commands.executeCommand(
        'buttonfu.api.createButton',
        { name: 'Agent Button', locality: 'Global', executionText: 'echo hello' }
    ) as ApiResult<ButtonConfig>;

    assert.equal(created.success, true);
    assert.equal(created.data?.name, 'Agent Button');

    const listed = await harness.vscode.commands.executeCommand('buttonfu.api.listButtons') as ApiResult<ButtonConfig[]>;
    assert.equal(listed.success, true);
    assert.equal(listed.data?.length, 1);

    const updated = await harness.vscode.commands.executeCommand(
        'buttonfu.api.updateButton',
        { id: created.data!.id, name: 'Renamed Button' }
    ) as ApiResult<ButtonConfig>;

    assert.equal(updated.success, true);
    assert.equal(updated.data?.name, 'Renamed Button');

    const fetched = await harness.vscode.commands.executeCommand(
        'buttonfu.api.getButton',
        created.data!.id
    ) as ApiResult<ButtonConfig>;

    assert.equal(fetched.success, true);
    assert.equal(fetched.data?.id, created.data?.id);

    const deleted = await harness.vscode.commands.executeCommand(
        'buttonfu.api.deleteButton',
        created.data!.id
    ) as ApiResult<{ id: string }>;

    assert.equal(deleted.success, true);
    assert.equal((await harness.vscode.commands.executeCommand('buttonfu.api.listButtons') as ApiResult<ButtonConfig[]>).data?.length, 0);
});

test('note api commands create list update get and delete through the registered command surface', async () => {
    const harness = createFakeVscodeHarness();
    const extensionModulePath = path.resolve(__dirname, '..', 'extension.js');
    const extension = loadWithPatchedVscode<{ activate(context: any): void }>(extensionModulePath, harness.vscode);
    const context = harness.createExtensionContext();

    extension.activate(context);

    const created = await harness.vscode.commands.executeCommand(
        'buttonfu.api.createNote',
        { name: 'Agent Note', locality: 'Local', content: 'hello from api' }
    ) as ApiResult<NoteConfig>;

    assert.equal(created.success, true);
    assert.equal(created.data?.name, 'Agent Note');

    const listed = await harness.vscode.commands.executeCommand('buttonfu.api.listNotes') as ApiResult<NoteConfig[]>;
    assert.equal(listed.success, true);
    assert.equal(listed.data?.length, 1);

    const updated = await harness.vscode.commands.executeCommand(
        'buttonfu.api.updateNote',
        { id: created.data!.id, content: 'updated content' }
    ) as ApiResult<NoteConfig>;

    assert.equal(updated.success, true);
    assert.equal(updated.data?.content, 'updated content');

    const fetched = await harness.vscode.commands.executeCommand(
        'buttonfu.api.getNote',
        created.data!.id
    ) as ApiResult<NoteConfig>;

    assert.equal(fetched.success, true);
    assert.equal(fetched.data?.id, created.data?.id);

    const deleted = await harness.vscode.commands.executeCommand(
        'buttonfu.api.deleteNote',
        created.data!.id
    ) as ApiResult<{ id: string }>;

    assert.equal(deleted.success, true);
    assert.equal((await harness.vscode.commands.executeCommand('buttonfu.api.listNotes') as ApiResult<NoteConfig[]>).data?.length, 0);
});

test('api create commands optionally open the editors for the saved item', async () => {
    const harness = createFakeVscodeHarness();
    const extensionModulePath = path.resolve(__dirname, '..', 'extension.js');
    let openedButtonId: string | undefined;
    let openedNoteId: string | undefined;

    const extension = loadWithPatchedVscode<{ activate(context: any): void }>(extensionModulePath, harness.vscode, {
        './editorPanel': {
            ButtonEditorPanel: {
                configure: () => undefined,
                createOrShow: () => undefined,
                createOrShowWithNew: () => undefined,
                createOrShowWithTab: () => undefined,
                createOrShowWithButton: (_store: unknown, _extensionUri: unknown, buttonId: string) => {
                    openedButtonId = buttonId;
                }
            }
        },
        './noteEditorPanel': {
            NoteEditorPanel: {
                configure: () => undefined,
                closeCurrent: () => undefined,
                createOrShow: () => undefined,
                createOrShowWithNew: () => undefined,
                createOrShowWithNode: (_store: unknown, _extensionUri: unknown, nodeId: string) => {
                    openedNoteId = nodeId;
                }
            }
        }
    });
    const context = harness.createExtensionContext();

    extension.activate(context);

    const createdButton = await harness.vscode.commands.executeCommand(
        'buttonfu.api.createButton',
        { name: 'Open Me', locality: 'Global', openEditor: true }
    ) as ApiResult<ButtonConfig>;
    const createdNote = await harness.vscode.commands.executeCommand(
        'buttonfu.api.createNote',
        { name: 'Open Note', locality: 'Global', openEditor: true }
    ) as ApiResult<NoteConfig>;

    assert.equal(openedButtonId, createdButton.data?.id);
    assert.equal(openedNoteId, createdNote.data?.id);
});

test('development smoke commands reset and clear repeatable local api smoke data', async () => {
    const harness = createFakeVscodeHarness();
    const extensionModulePath = path.resolve(__dirname, '..', 'extension.js');
    const extension = loadWithPatchedVscode<{ activate(context: any): void }>(extensionModulePath, harness.vscode);
    const context = harness.createExtensionContext();

    extension.activate(context);

    const firstReset = await harness.vscode.commands.executeCommand(DEV_RESET_API_SMOKE_COMMAND) as DevApiSmokeResult;
    assert.equal(firstReset.success, true);
    assert.equal(firstReset.button?.locality, 'Local');
    assert.equal(firstReset.note?.locality, 'Local');
    assert.equal(firstReset.button?.createdBy, 'Agent');
    assert.equal(firstReset.button?.lastModifiedBy, 'Agent');
    assert.equal(firstReset.note?.createdBy, 'Agent');
    assert.equal(firstReset.note?.lastModifiedBy, 'Agent');
    assert.equal(firstReset.button?.source, 'Agent');
    assert.equal(firstReset.note?.source, 'Agent');
    assert.match(firstReset.note?.content ?? '', /registered `buttonfu\.api\.createNote` and `buttonfu\.api\.updateNote` commands/);
    assert.match(firstReset.note?.content ?? '', /Expected source summary: Agent/);
    assert.match(firstReset.note?.content ?? '', /Expected createdBy: Agent/);
    assert.match(firstReset.note?.content ?? '', /Expected lastModifiedBy: Agent/);

    const firstButtonList = await harness.vscode.commands.executeCommand('buttonfu.api.listButtons', { locality: 'Local' }) as ApiResult<ButtonConfig[]>;
    const firstNoteList = await harness.vscode.commands.executeCommand('buttonfu.api.listNotes', { locality: 'Local' }) as ApiResult<NoteConfig[]>;
    assert.equal(firstButtonList.data?.filter((button) => button.name === 'ButtonFu API Smoke Button').length, 1);
    assert.equal(firstNoteList.data?.filter((note) => note.name === 'ButtonFu API Smoke Note').length, 1);

    const secondReset = await harness.vscode.commands.executeCommand(DEV_RESET_API_SMOKE_COMMAND) as DevApiSmokeResult;
    assert.equal(secondReset.success, true);

    const secondButtonList = await harness.vscode.commands.executeCommand('buttonfu.api.listButtons', { locality: 'Local' }) as ApiResult<ButtonConfig[]>;
    const secondNoteList = await harness.vscode.commands.executeCommand('buttonfu.api.listNotes', { locality: 'Local' }) as ApiResult<NoteConfig[]>;
    assert.equal(secondButtonList.data?.filter((button) => button.name === 'ButtonFu API Smoke Button').length, 1);
    assert.equal(secondNoteList.data?.filter((note) => note.name === 'ButtonFu API Smoke Note').length, 1);

    const cleared = await harness.vscode.commands.executeCommand(DEV_CLEAR_API_SMOKE_COMMAND) as DevApiSmokeResult;
    assert.equal(cleared.success, true);

    const clearedButtons = await harness.vscode.commands.executeCommand('buttonfu.api.listButtons', { locality: 'Local' }) as ApiResult<ButtonConfig[]>;
    const clearedNotes = await harness.vscode.commands.executeCommand('buttonfu.api.listNotes', { locality: 'Local' }) as ApiResult<NoteConfig[]>;
    assert.equal(clearedButtons.data?.filter((button) => button.name === 'ButtonFu API Smoke Button').length, 0);
    assert.equal(clearedNotes.data?.filter((note) => note.name === 'ButtonFu API Smoke Note').length, 0);
    assert.ok(harness.informationMessages.some((message) => message.includes('ButtonFu dev API smoke')));
});

test('addNote prompts for scope when invoked without a locality', async () => {
    const harness = createFakeVscodeHarness();
    const extensionModulePath = path.resolve(__dirname, '..', 'extension.js');
    let createLocality: string | undefined;

    const extension = loadWithPatchedVscode<{ activate(context: any): void }>(extensionModulePath, harness.vscode, {
        './noteEditorPanel': {
            NoteEditorPanel: {
                createOrShow: () => undefined,
                createOrShowWithNode: () => undefined,
                createOrShowWithNew: (_store: unknown, _extensionUri: unknown, locality: string) => {
                    createLocality = locality;
                }
            }
        }
    });
    const context = harness.createExtensionContext();

    extension.activate(context);
    harness.queueQuickPickResult({ locality: 'Local' });

    await harness.registeredCommands.get('buttonfu.addNote')?.();

    assert.equal(harness.quickPickCalls.length, 1);
    assert.equal(createLocality, 'Local');
});

test('addNote uses an explicit locality without prompting', async () => {
    const harness = createFakeVscodeHarness();
    const extensionModulePath = path.resolve(__dirname, '..', 'extension.js');
    let createLocality: string | undefined;

    const extension = loadWithPatchedVscode<{ activate(context: any): void }>(extensionModulePath, harness.vscode, {
        './noteEditorPanel': {
            NoteEditorPanel: {
                createOrShow: () => undefined,
                createOrShowWithNode: () => undefined,
                createOrShowWithNew: (_store: unknown, _extensionUri: unknown, locality: string) => {
                    createLocality = locality;
                }
            }
        }
    });
    const context = harness.createExtensionContext();

    extension.activate(context);

    await harness.registeredCommands.get('buttonfu.addNote')?.({ locality: 'Global' });

    assert.equal(harness.quickPickCalls.length, 0);
    assert.equal(createLocality, 'Global');
});

test('executeNote routes through the note action service default action', async () => {
    const harness = createFakeVscodeHarness();
    const extensionModulePath = path.resolve(__dirname, '..', 'extension.js');
    let executedArg: unknown;

    const extension = loadWithPatchedVscode<{ activate(context: any): void }>(extensionModulePath, harness.vscode, {
        './noteActionService': {
            NoteActionService: class NoteActionServiceStub {
                constructor(_store: unknown, _extensionUri: unknown, _previewProvider: unknown) {}

                async executeDefaultAction(arg: unknown): Promise<void> {
                    executedArg = arg;
                }

                async openNoteActions(): Promise<void> { return; }
                async previewNote(): Promise<void> { return; }
                async copyNote(): Promise<void> { return; }
                async insertNote(): Promise<void> { return; }
                async sendNoteToCopilot(): Promise<void> { return; }
            }
        }
    });
    const context = harness.createExtensionContext();

    extension.activate(context);
    await harness.registeredCommands.get('buttonfu.executeNote')?.('note-123');

    assert.equal(executedArg, 'note-123');
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

test('package manifest removes the notes tree view and keeps the sidebar notes setting', () => {
    const packageJsonPath = path.resolve(__dirname, '..', '..', 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const notesSetting = packageJson.contributes.configuration.properties['buttonfu.showNotes'];
    const commandPalette = packageJson.contributes.menus.commandPalette;

    assert.equal(packageJson.contributes.views.buttonfu.some((view: { id: string }) => view.id === 'buttonfu.notesView'), false);
    assert.equal(notesSetting.default, true);
    assert.match(notesSetting.description, /split buttons/i);
    assert.ok(commandPalette.some((item: { command: string; when: string }) => item.command === 'buttonfu.openNoteEditor' && item.when === 'config.buttonfu.showNotes'));
});

test('package manifest exposes development smoke commands only behind the dev-mode context key', () => {
    const packageJsonPath = path.resolve(__dirname, '..', '..', 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const commands = packageJson.contributes.commands;
    const commandPalette = packageJson.contributes.menus.commandPalette;

    assert.ok(commands.some((item: { command: string }) => item.command === DEV_RESET_API_SMOKE_COMMAND));
    assert.ok(commands.some((item: { command: string }) => item.command === DEV_CLEAR_API_SMOKE_COMMAND));
    assert.ok(commands.some((item: { command: string }) => item.command === DEV_CLEAR_DRIVE_NET_SMOKE_COMMAND));
    assert.ok(commandPalette.some((item: { command: string; when: string }) => item.command === DEV_RESET_API_SMOKE_COMMAND && item.when === 'buttonfu.isDevelopmentMode'));
    assert.ok(commandPalette.some((item: { command: string; when: string }) => item.command === DEV_CLEAR_API_SMOKE_COMMAND && item.when === 'buttonfu.isDevelopmentMode'));
    assert.ok(commandPalette.some((item: { command: string; when: string }) => item.command === DEV_CLEAR_DRIVE_NET_SMOKE_COMMAND && item.when === 'buttonfu.isDevelopmentMode'));
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

test('disabling showNotes closes the note editor and refreshes the sidebar provider', async () => {
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
        './buttonPanelProvider': {
            ButtonPanelProvider: class ButtonPanelProviderStub {
                static viewType = 'buttonfu.buttonsView';

                constructor(_extensionUri: unknown, _store: unknown, _noteStore: unknown, _globalState: unknown) {}

                resolveWebviewView(): void {}

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