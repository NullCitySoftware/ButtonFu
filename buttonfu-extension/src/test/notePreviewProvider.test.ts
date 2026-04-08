import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createDefaultNote } from '../types';
import { createFakeVscodeHarness, loadWithPatchedVscode } from './helpers/fakeVscode';

function createPreviewContext() {
    const harness = createFakeVscodeHarness();
    const noteStoreModulePath = path.resolve(__dirname, '..', 'noteStore.js');
    const previewModulePath = path.resolve(__dirname, '..', 'notePreviewProvider.js');
    const noteStoreModule = loadWithPatchedVscode<{ NoteStore: new (context: any) => any }>(noteStoreModulePath, harness.vscode);
    const previewModule = loadWithPatchedVscode<{ NotePreviewProvider: new (store: any) => any }>(previewModulePath, harness.vscode);
    const context = harness.createExtensionContext();
    const store = new noteStoreModule.NoteStore(context);
    const provider = new previewModule.NotePreviewProvider(store);
    return { harness, store, provider };
}

test('NotePreviewProvider returns content and refreshes tracked notes', async () => {
    const { store, provider } = createPreviewContext();

    const note = createDefaultNote('Global');
    note.name = 'Prompt: Specs/Review';
    note.format = 'Markdown';
    note.content = '# First';
    const saved = await store.saveNode(note);

    const uri = provider.getUri(saved);
    assert.equal(uri.scheme, 'buttonfu-note-preview');
    assert.match(uri.path, /Prompt- Specs-Review\.md$/);
    assert.equal(provider.provideTextDocumentContent(uri), '# First');

    const refreshed: string[] = [];
    provider.onDidChange((changedUri: { toString(): string }) => {
        refreshed.push(changedUri.toString());
    });

    await store.saveNode({ ...saved, content: '# Second' });
    assert.ok(refreshed.length >= 1);
    assert.ok(refreshed.every((entry) => entry === uri.toString()));
    assert.equal(provider.provideTextDocumentContent(uri), '# Second');

    await store.deleteNode(saved.id);
    assert.equal(provider.provideTextDocumentContent(uri), 'This note no longer exists.');
});

test('NotePreviewProvider handles preview URIs without note ids', () => {
    const { harness, provider } = createPreviewContext();
    const uri = harness.vscode.Uri.from({
        scheme: 'buttonfu-note-preview',
        path: '/untitled.txt',
        query: ''
    });

    assert.equal(provider.provideTextDocumentContent(uri), 'Note preview unavailable.');
});