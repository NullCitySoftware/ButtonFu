import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createDefaultNote } from '../types';
import { createFakeVscodeHarness, loadWithPatchedVscode } from './helpers/fakeVscode';

function createStore() {
    const harness = createFakeVscodeHarness();
    const noteStoreModulePath = path.resolve(__dirname, '..', 'noteStore.js');
    const noteStoreModule = loadWithPatchedVscode<{ NoteStore: new (context: any) => any }>(noteStoreModulePath, harness.vscode);
    const context = harness.createExtensionContext();
    const store = new noteStoreModule.NoteStore(context);
    return { harness, store };
}

test('saving a note can move it across scopes', async () => {
    const { store } = createStore();

    const note = createDefaultNote('Global');
    note.name = 'Cross-scope note';
    note.content = 'hello';
    const saved = await store.saveNode(note);

    const moved = await store.saveNode({
        ...saved,
        locality: 'Local'
    });

    assert.equal(moved.locality, 'Local');
    assert.equal(store.getNote(saved.id)?.locality, 'Local');
});

test('reorderNode swaps locality order', async () => {
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

    const ordered = store.getGlobalNodes();
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
            category: 'Prompts'
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

test('legacy folders and nested notes are dropped while surviving notes are normalized', async () => {
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
            id: 'nested-note',
            name: 'Nested note',
            locality: 'Global',
            parentId: 'legacy-folder',
            kind: 'note',
            icon: 'note',
            colour: '',
            content: 'hidden',
            format: 'PlainText',
            copilotModel: '',
            copilotMode: 'agent',
            copilotAttachFiles: [],
            copilotAttachActiveFile: false,
            userTokens: [],
            updatedAt: 1
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

    const notes = store.getGlobalNodes();
    assert.equal(notes.length, 1);
    assert.equal(notes[0].id, 'legacy-note');
    assert.equal(notes[0].icon, 'note');
    assert.equal(notes[0].category, 'General');
    assert.equal(notes[0].defaultAction, 'open');
});

test('blank categories are normalized to General on save', async () => {
    const { store } = createStore();

    const note = createDefaultNote('Global');
    note.name = 'Categorized';
    note.content = 'body';
    note.category = '   ';
    const saved = await store.saveNode(note);

    assert.equal(saved.category, 'General');
});