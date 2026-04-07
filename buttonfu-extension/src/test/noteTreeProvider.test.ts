import assert = require('node:assert/strict');
import path = require('path');
import test = require('node:test');
import { createDefaultNote, createDefaultNoteFolder } from '../types';
import { createFakeVscodeHarness, loadWithPatchedVscode } from './helpers/fakeVscode';

class FakeDataTransfer {
    private readonly values = new Map<string, any>();

    set(type: string, value: any): void {
        this.values.set(type, value);
    }

    get(type: string): any {
        return this.values.get(type);
    }
}

function createTreeContext() {
    const harness = createFakeVscodeHarness();
    const noteStoreModulePath = path.resolve(__dirname, '..', 'noteStore.js');
    const treeModulePath = path.resolve(__dirname, '..', 'noteTreeProvider.js');
    const noteStoreModule = loadWithPatchedVscode<{ NoteStore: new (context: any) => any }>(noteStoreModulePath, harness.vscode);
    const treeModule = loadWithPatchedVscode<{ NoteTreeProvider: new (store: any) => any }>(treeModulePath, harness.vscode);
    const context = harness.createExtensionContext();
    const store = new noteStoreModule.NoteStore(context);
    const provider = new treeModule.NoteTreeProvider(store);
    return { harness, store, provider };
}

test('handleDrag serializes dragged note ids into the tree mime type', async () => {
    const { store, provider } = createTreeContext();
    const note = createDefaultNote('Global');
    note.name = 'Dragged';
    note.content = 'content';
    const saved = await store.saveNode(note);

    const transfer = new FakeDataTransfer();
    await provider.handleDrag([saved], transfer as any);

    const raw = await transfer.get('application/vnd.code.tree.buttonfu.notes').asString();
    assert.deepEqual(JSON.parse(raw), [saved.id]);
});

test('handleDrop onto a folder moves dragged notes into that folder', async () => {
    const { store, provider } = createTreeContext();
    const folder = createDefaultNoteFolder('Global');
    folder.name = 'Folder';
    const savedFolder = await store.saveNode(folder);

    const note = createDefaultNote('Global');
    note.name = 'Child';
    note.content = 'content';
    const savedNote = await store.saveNode(note);

    const transfer = new FakeDataTransfer();
    transfer.set('application/vnd.code.tree.buttonfu.notes', { asString: async () => JSON.stringify([savedNote.id]) });

    await provider.handleDrop(savedFolder, transfer as any);

    assert.equal(store.getNote(savedNote.id)?.parentId, savedFolder.id);
});

test('handleDrop onto a scope root supports cross-scope moves', async () => {
    const { store, provider } = createTreeContext();
    const note = createDefaultNote('Global');
    note.name = 'Cross-scope';
    note.content = 'content';
    const savedNote = await store.saveNode(note);

    const transfer = new FakeDataTransfer();
    transfer.set('application/vnd.code.tree.buttonfu.notes', { asString: async () => JSON.stringify([savedNote.id]) });

    await provider.handleDrop({ kind: 'scopeRoot', id: 'local', locality: 'Local', label: 'Workspace [TestWorkspace]' }, transfer as any);

    assert.equal(store.getNote(savedNote.id)?.locality, 'Local');
    assert.equal(store.getNote(savedNote.id)?.parentId, null);
});

test('handleDrop onto a note warns and leaves the tree unchanged', async () => {
    const { harness, store, provider } = createTreeContext();
    const target = createDefaultNote('Global');
    target.name = 'Target';
    target.content = 'target';
    const savedTarget = await store.saveNode(target);

    const dragged = createDefaultNote('Global');
    dragged.name = 'Dragged';
    dragged.content = 'dragged';
    const savedDragged = await store.saveNode(dragged);

    const transfer = new FakeDataTransfer();
    transfer.set('application/vnd.code.tree.buttonfu.notes', { asString: async () => JSON.stringify([savedDragged.id]) });

    await provider.handleDrop(savedTarget, transfer as any);

    assert.equal(store.getNote(savedDragged.id)?.parentId, null);
    assert.deepEqual(harness.warningMessages, ['Notes can only be dropped onto folders or scope roots.']);
});