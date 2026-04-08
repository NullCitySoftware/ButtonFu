import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createDefaultNote, createDefaultNoteFolder } from '../types';
import { createFakeVscodeHarness, loadWithPatchedVscode } from './helpers/fakeVscode';

function createStore() {
    const harness = createFakeVscodeHarness();
    const noteStoreModulePath = path.resolve(__dirname, '..', 'noteStore.js');
    const noteStoreModule = loadWithPatchedVscode<{ NoteStore: new (context: any) => any }>(noteStoreModulePath, harness.vscode);
    const context = harness.createExtensionContext();
    const store = new noteStoreModule.NoteStore(context);
    return { harness, store };
}

test('moveNode can move a note across scopes', async () => {
    const { store } = createStore();

    const note = createDefaultNote('Global');
    note.name = 'Cross-scope note';
    note.content = 'hello';
    const saved = await store.saveNode(note);

    const moved = await store.moveNode(saved.id, 'Local', null);
    assert.equal(moved, true);
    assert.equal(store.getNote(saved.id)?.locality, 'Local');
});

test('moving a folder across scopes updates its descendants', async () => {
    const { store } = createStore();

    const folder = createDefaultNoteFolder('Global');
    folder.name = 'Prompt Library';
    const savedFolder = await store.saveNode(folder);

    const childNote = createDefaultNote('Global', savedFolder.id);
    childNote.name = 'Nested note';
    childNote.content = 'nested';
    const savedNote = await store.saveNode(childNote);

    const moved = await store.moveNode(savedFolder.id, 'Local', null);
    assert.equal(moved, true);
    assert.equal(store.getFolder(savedFolder.id)?.locality, 'Local');
    assert.equal(store.getNote(savedNote.id)?.locality, 'Local');
    assert.equal(store.getNote(savedNote.id)?.parentId, savedFolder.id);
});

test('deleteNode removes a folder subtree', async () => {
    const { store } = createStore();

    const folder = createDefaultNoteFolder('Global');
    folder.name = 'Delete me';
    const savedFolder = await store.saveNode(folder);

    const childNote = createDefaultNote('Global', savedFolder.id);
    childNote.name = 'Child';
    childNote.content = 'child';
    const savedNote = await store.saveNode(childNote);

    await store.deleteNode(savedFolder.id);

    assert.equal(store.getFolder(savedFolder.id), undefined);
    assert.equal(store.getNote(savedNote.id), undefined);
});

test('reorderNode swaps sibling order within a parent', async () => {
    const { store } = createStore();

    const first = createDefaultNote('Global');
    first.name = 'First';
    first.content = 'one';
    first.sortOrder = 0;
    const savedFirst = await store.saveNode(first);

    const second = createDefaultNote('Global');
    second.name = 'Second';
    second.content = 'two';
    second.sortOrder = 10;
    const savedSecond = await store.saveNode(second);

    await store.reorderNode(savedSecond.id, 'up');

    const ordered = store.getChildren('Global', null);
    assert.equal(ordered[0]?.id, savedSecond.id);
    assert.equal(ordered[1]?.id, savedFirst.id);
});

test('saving a workspace note does not rewrite global note settings', async () => {
    const { harness, store } = createStore();

    const globalNote = createDefaultNote('Global');
    globalNote.name = 'Global';
    globalNote.content = 'global';
    await store.saveNode(globalNote);

    harness.configurationUpdates.length = 0;

    const localNote = createDefaultNote('Local');
    localNote.name = 'Workspace';
    localNote.content = 'local';
    await store.saveNode(localNote);

    assert.deepEqual(harness.configurationUpdates, []);
});

test('moveNode rejects moving a folder into its own descendant', async () => {
    const { store } = createStore();

    const parentFolder = createDefaultNoteFolder('Global');
    parentFolder.name = 'Parent';
    const savedParent = await store.saveNode(parentFolder);

    const childFolder = createDefaultNoteFolder('Global', savedParent.id);
    childFolder.name = 'Child';
    const savedChild = await store.saveNode(childFolder);

    const moved = await store.moveNode(savedParent.id, 'Global', savedChild.id);

    assert.equal(moved, false);
    assert.equal(store.getFolder(savedParent.id)?.parentId, null);
    assert.equal(store.getFolder(savedChild.id)?.parentId, savedParent.id);
});

test('saving an edited note clears a parent that becomes invalid after a scope change', async () => {
    const { store } = createStore();

    const folder = createDefaultNoteFolder('Global');
    folder.name = 'Global Folder';
    const savedFolder = await store.saveNode(folder);

    const note = createDefaultNote('Global', savedFolder.id);
    note.name = 'Scoped note';
    note.content = 'content';
    const savedNote = await store.saveNode(note);

    const updated = await store.saveNode({
        ...savedNote,
        locality: 'Local'
    });

    assert.equal(updated.locality, 'Local');
    assert.equal(updated.parentId, null);
});

test('saving a note preserves updatedAt for metadata-only edits and refreshes it for content changes', async () => {
    const { store } = createStore();
    const originalNow = Date.now;

    try {
        Date.now = () => 1000;
        const note = createDefaultNote('Global');
        note.name = 'Tracked note';
        note.content = 'first';
        const saved = await store.saveNode(note);

        Date.now = () => 2000;
        const metadataOnly = await store.saveNode({
            ...saved,
            colour: 'charts.yellow'
        });

        assert.equal(metadataOnly.updatedAt, 1000);

        Date.now = () => 3000;
        const contentEdited = await store.saveNode({
            ...metadataOnly,
            content: 'second'
        });

        assert.equal(contentEdited.updatedAt, 3000);
    } finally {
        Date.now = originalNow;
    }
});

test('saving an unchanged global note does not emit duplicate or no-op change events', async () => {
    const { store } = createStore();
    let changeCount = 0;
    store.onDidChange(() => {
        changeCount += 1;
    });

    const note = createDefaultNote('Global');
    note.name = 'Stable note';
    note.content = 'body';

    const saved = await store.saveNode(note);
    assert.equal(changeCount, 1);

    await store.saveNode(saved);
    assert.equal(changeCount, 1);
});

test('saving a note requires a non-empty trimmed name', async () => {
    const { store } = createStore();

    const note = createDefaultNote('Global');
    note.name = '   ';
    note.content = 'body';

    await assert.rejects(() => store.saveNode(note), /A name is required\./);
    assert.equal(store.getAllNodes().length, 0);
});

test('loading persisted nodes normalizes opposite built-in note and folder icons', async () => {
    const { harness, store } = createStore();

    await harness.vscode.workspace.getConfiguration('buttonfu').update('globalNotes', [
        {
            id: 'legacy-folder',
            name: 'Legacy folder',
            locality: 'Global',
            parentId: null,
            kind: 'folder',
            icon: 'notebook',
            colour: ''
        },
        {
            id: 'legacy-note',
            name: 'Legacy note',
            locality: 'Global',
            parentId: null,
            kind: 'note',
            icon: 'folder',
            colour: '',
            content: 'body',
            format: 'PlainText',
            copilotModel: '',
            copilotMode: 'agent',
            copilotAttachFiles: [],
            copilotAttachActiveFile: false,
            userTokens: [],
            updatedAt: 1
        }
    ]);

    assert.equal(store.getFolder('legacy-folder')?.icon, 'folder');
    assert.equal(store.getNote('legacy-note')?.icon, 'note');
});