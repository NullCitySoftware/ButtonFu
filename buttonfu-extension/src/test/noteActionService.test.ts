import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createDefaultNote, createDefaultNoteFolder } from '../types';
import { createFakeVscodeHarness, loadWithPatchedVscode } from './helpers/fakeVscode';

function createActionContext(moduleOverrides: Record<string, unknown> = {}) {
    const harness = createFakeVscodeHarness();
    const noteStoreModulePath = path.resolve(__dirname, '..', 'noteStore.js');
    const previewModulePath = path.resolve(__dirname, '..', 'notePreviewProvider.js');
    const actionModulePath = path.resolve(__dirname, '..', 'noteActionService.js');
    const noteStoreModule = loadWithPatchedVscode<{ NoteStore: new (context: any) => any }>(noteStoreModulePath, harness.vscode);
    const previewModule = loadWithPatchedVscode<{ NotePreviewProvider: new (store: any) => any }>(previewModulePath, harness.vscode);
    const actionModule = loadWithPatchedVscode<{ NoteActionService: new (store: any, extensionUri: any, previewProvider: any) => any }>(actionModulePath, harness.vscode, moduleOverrides);
    const context = harness.createExtensionContext();
    const store = new noteStoreModule.NoteStore(context);
    const previewProvider = new previewModule.NotePreviewProvider(store);
    const service = new actionModule.NoteActionService(store, context.extensionUri, previewProvider);
    return { harness, context, store, previewProvider, service };
}

test('previewNote opens plain-text notes in a read-only document', async () => {
    const { harness, store, service } = createActionContext();
    const note = createDefaultNote('Global');
    note.name = 'Scratch';
    note.content = 'plain text';
    note.format = 'PlainText';
    const saved = await store.saveNode(note);

    await service.previewNote(saved.id);

    assert.equal(harness.openedTextDocuments.length, 1);
    assert.equal(harness.shownTextDocuments.length, 1);
});

test('previewNote prefers markdown preview when available', async () => {
    const { harness, store, service } = createActionContext();
    let previewUri: { toString(): string } | undefined;
    harness.setExternalCommandHandler('markdown.showPreviewToSide', (uri: { toString(): string }) => {
        previewUri = uri;
    });

    const note = createDefaultNote('Global');
    note.name = 'Markdown';
    note.content = '# Heading';
    note.format = 'Markdown';
    const saved = await store.saveNode(note);

    await service.previewNote(saved.id);

    assert.ok(previewUri);
    assert.equal(harness.openedTextDocuments.length, 0);
    assert.ok(harness.executedCommands.some((entry) => entry.command === 'markdown.showPreviewToSide'));
});

test('copyNote writes to clipboard and reports status', async () => {
    const { harness, store, service } = createActionContext();
    const note = createDefaultNote('Global');
    note.name = 'Copy target';
    note.content = 'copy me';
    const saved = await store.saveNode(note);

    await service.copyNote(saved.id);

    assert.deepEqual(harness.clipboardWrites, ['copy me']);
    assert.match(harness.statusBarMessages[0]?.text ?? '', /Copied note/);
});

test('insertNote replaces each active editor selection', async () => {
    const { harness, store, service } = createActionContext();
    const editor = harness.setActiveTextEditor({ selectionCount: 2, filePath: path.join(process.cwd(), 'test-workspace', 'active.ts') });

    const note = createDefaultNote('Global');
    note.name = 'Insert target';
    note.content = 'insert me';
    const saved = await store.saveNode(note);

    await service.insertNote(saved.id);

    assert.equal(editor.editOperations.length, 2);
    assert.deepEqual(editor.editOperations.map((operation: { text: string }) => operation.text), ['insert me', 'insert me']);
});

test('openNoteActions preserves action order and dispatches copy', async () => {
    const { harness, store, service } = createActionContext();
    const note = createDefaultNote('Global');
    note.name = 'Ordered actions';
    note.content = 'ordered';
    const saved = await store.saveNode(note);

    harness.queueQuickPickResult({ action: 'copy' });
    await service.openNoteActions(saved.id);

    const labels = harness.quickPickCalls[0]?.items.map((item) => (item as { label: string }).label) ?? [];
    assert.deepEqual(labels, [
        'Open',
        'Insert into Active Editor',
        'Send to Copilot Chat',
        'Copy to Clipboard',
        'Edit',
        'Move To Folder',
        'Delete'
    ]);
    assert.deepEqual(harness.clipboardWrites, ['ordered']);
});

test('sendNoteToCopilot forwards note prompt settings', async () => {
    const { store, service } = createActionContext();
    const note = createDefaultNote('Global');
    note.name = 'Copilot target';
    note.content = 'ship it';
    note.copilotMode = 'edit';
    note.copilotModel = 'gpt-test';
    note.copilotAttachFiles = ['docs/spec.md'];
    note.copilotAttachActiveFile = true;
    const saved = await store.saveNode(note);

    let capturedRequest: unknown;
    (service as any).promptActions = {
        sendToCopilot: async (request: unknown) => {
            capturedRequest = request;
        }
    };

    await service.sendNoteToCopilot(saved.id);

    assert.deepEqual(capturedRequest, {
        prompt: 'ship it',
        model: 'gpt-test',
        mode: 'edit',
        attachFiles: ['docs/spec.md'],
        attachActiveFile: true
    });
});

test('moveNodeToFolder offers scope root and destination folders', async () => {
    const { harness, store, service } = createActionContext();
    const folder = createDefaultNoteFolder('Global');
    folder.name = 'Prompts';
    const savedFolder = await store.saveNode(folder);

    const note = createDefaultNote('Global');
    note.name = 'Move target';
    note.content = 'move me';
    const savedNote = await store.saveNode(note);

    harness.queueQuickPickResult({ targetLocality: 'Global', targetParentId: savedFolder.id });
    await service.moveNodeToFolder(savedNote.id);

    const pickerLabels = harness.quickPickCalls[0]?.items.map((item) => (item as { label: string }).label) ?? [];
    assert.deepEqual(pickerLabels, ['Global Root', 'Prompts', 'Workspace [TestWorkspace] Root']);
    assert.equal(store.getNote(savedNote.id)?.parentId, savedFolder.id);
});

test('moveNodeToFolder can switch a note between global and workspace scopes', async () => {
    const { harness, store, service } = createActionContext();
    const note = createDefaultNote('Global');
    note.name = 'Scope switch';
    note.content = 'move me';
    const savedNote = await store.saveNode(note);

    harness.queueQuickPickResult({ targetLocality: 'Local', targetParentId: null });
    await service.moveNodeToFolder(savedNote.id);

    assert.equal(store.getNote(savedNote.id)?.locality, 'Local');
    assert.equal(store.getNote(savedNote.id)?.parentId, null);
});

test('prompt-enabled copyNote resolves aliases and default user tokens immediately', async () => {
    const { harness, store, service } = createActionContext();
    const note = createDefaultNote('Global');
    note.name = 'Prompt note';
    note.promptEnabled = true;
    note.content = 'Name=$NoteName$ Topic=$Topic$';
    note.userTokens = [
        {
            token: '$Topic$',
            label: 'Topic',
            description: 'Topic to insert',
            dataType: 'String',
            defaultValue: 'Docs',
            required: true
        }
    ];
    const saved = await store.saveNode(note);

    await service.copyNote(saved.id);

    assert.deepEqual(harness.clipboardWrites, ['Name=Prompt note Topic=Docs']);
});

test('prompt-enabled copyNote opens the token panel when unresolved values remain', async () => {
    let capturedRequest: any;
    const { harness, store, service } = createActionContext({
        './promptTokenInputPanel': {
            PromptTokenInputPanel: class PromptTokenInputPanelStub {
                constructor(request: unknown) {
                    capturedRequest = request;
                }
            }
        }
    });

    const note = createDefaultNote('Global');
    note.name = 'Unresolved prompt';
    note.promptEnabled = true;
    note.content = 'Use $Topic$ for $NoteName$';
    note.userTokens = [
        {
            token: '$Topic$',
            label: 'Topic',
            description: 'Topic to insert',
            dataType: 'String',
            defaultValue: '',
            required: true
        }
    ];
    const saved = await store.saveNode(note);

    await service.copyNote(saved.id);

    assert.ok(capturedRequest, 'Expected the prompt token panel to be created.');
    assert.equal(capturedRequest.title, 'Unresolved prompt');
    assert.equal(capturedRequest.unresolvedTokens.length, 1);
    assert.equal(capturedRequest.unresolvedTokens[0].token, '$Topic$');
    assert.equal(capturedRequest.usedSystemTokens[0].token, '$NoteName$');

    await capturedRequest.onExecute({ '$topic$': 'Safety' });
    assert.deepEqual(harness.clipboardWrites, ['Use Safety for Unresolved prompt']);
});