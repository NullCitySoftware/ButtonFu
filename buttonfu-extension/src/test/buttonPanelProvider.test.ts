import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createDefaultButton, createDefaultNote } from '../types';
import { createFakeVscodeHarness, loadWithPatchedVscode } from './helpers/fakeVscode';
import { executeWebviewScripts } from './helpers/webviewRuntime';

function createProviderContext() {
    const harness = createFakeVscodeHarness();
    const buttonStoreModulePath = path.resolve(__dirname, '..', 'buttonStore.js');
    const noteStoreModulePath = path.resolve(__dirname, '..', 'noteStore.js');
    const providerModulePath = path.resolve(__dirname, '..', 'buttonPanelProvider.js');
    const buttonStoreModule = loadWithPatchedVscode<{ ButtonStore: new (context: any) => any }>(buttonStoreModulePath, harness.vscode);
    const noteStoreModule = loadWithPatchedVscode<{ NoteStore: new (context: any) => any }>(noteStoreModulePath, harness.vscode);
    const providerModule = loadWithPatchedVscode<{ ButtonPanelProvider: new (extensionUri: any, store: any, noteStore: any, globalState: any) => any }>(providerModulePath, harness.vscode);
    const context = harness.createExtensionContext();
    const store = new buttonStoreModule.ButtonStore(context);
    const noteStore = new noteStoreModule.NoteStore(context);
    const provider = new providerModule.ButtonPanelProvider(context.extensionUri, store, noteStore, context.globalState);
    return { harness, context, store, noteStore, provider };
}

function renderHtml(provider: any) {
    return provider._getHtmlContent({
        cspSource: 'vscode-webview://test',
        asWebviewUri: (uri: unknown) => uri
    });
}

test('button panel mixes note split buttons into the grouped layout', async () => {
    const { harness, noteStore, provider } = createProviderContext();

    const general = createDefaultButton('Global');
    general.name = 'Git Commit + Push';
    general.category = 'General';
    general.icon = 'play';
    general.sortOrder = 0;

    const note = createDefaultNote('Global');
    note.id = 'review-note';
    note.name = 'Review Checklist';
    note.category = 'General';
    note.sortOrder = 5;
    note.content = 'Check output';

    const reviews = createDefaultButton('Global');
    reviews.name = '3 Lens Review';
    reviews.category = 'Reviews';
    reviews.icon = 'beaker';
    reviews.sortOrder = 10;

    await harness.vscode.workspace.getConfiguration('buttonfu').update('globalButtons', [general, reviews]);
    await noteStore.saveNode(note);

    const html = renderHtml(provider);

    assert.match(html, /<div class="locality-header">[\s\S]*<span>Global<\/span>/);
    assert.match(html, /<span>General<\/span>/);
    assert.match(html, /Git Commit \+ Push/);
    assert.match(html, /id="note-split-review-note"/);
    assert.match(html, /Review Checklist/);
    assert.match(html, /<span>Reviews<\/span>/);
    assert.match(html, /3 Lens Review/);
    assert.match(html, /<div class="locality-header">[\s\S]*<span>Workspace \[TestWorkspace\]<\/span>/);
    assert.match(html, /No workspace buttons or notes\. Add one via the editor\./);
    assert.doesNotMatch(html, />Notes</);
    assert.doesNotMatch(html, /noteContextMenu/);
    assert.match(html, /id="addNoteFooterBtn"/);
    assert.match(html, /id="openNoteEditorBtn"/);
});

test('button panel still shows the workspace header when no folder is open', async () => {
    const { harness, noteStore, provider } = createProviderContext();
    harness.setWorkspaceFolders([], { name: '', fireEvent: false });

    const note = createDefaultNote('Global');
    note.id = 'workspace-label-note';
    note.name = 'Workspace Label';
    note.content = 'body';
    await noteStore.saveNode(note);

    const html = renderHtml(provider);

    assert.match(html, /<div class="locality-header">[\s\S]*<span>Workspace<\/span>/);
    assert.match(html, /No workspace buttons or notes\. Add one via the editor\./);
});

test('button panel hides note controls when showNotes is disabled', async () => {
    const { harness, noteStore, provider } = createProviderContext();

    const note = createDefaultNote('Global');
    note.id = 'hidden-note';
    note.name = 'Hidden';
    note.content = 'body';
    await noteStore.saveNode(note);

    await harness.vscode.workspace.getConfiguration('buttonfu').update('showNotes', false);
    const html = renderHtml(provider);

    assert.doesNotMatch(html, /note-split-hidden-note/);
    assert.doesNotMatch(html, /id="addNoteFooterBtn"/);
    assert.doesNotMatch(html, /id="openNoteEditorBtn"/);
});

test('note split buttons post execute and dropdown menu actions', async () => {
    const { noteStore, provider } = createProviderContext();

    const note = createDefaultNote('Global');
    note.id = 'split-note';
    note.name = 'Split Note';
    note.content = '# Heading';
    note.format = 'Markdown';
    await noteStore.saveNode(note);

    const html = renderHtml(provider);
    const runtime = executeWebviewScripts(html);

    runtime.click('note-run-split-note');
    assert.deepEqual(runtime.postedMessages.at(-1), {
        type: 'executeNote',
        id: 'split-note'
    });

    runtime.click('note-menu-split-note');
    assert.equal(runtime.document.getElementById('noteActionMenu')?.classList.contains('visible'), true);
    assert.equal(runtime.document.getElementById('noteMenuOpenLabel')?.textContent, 'Preview');

    runtime.click('noteActionCopy');
    assert.deepEqual(runtime.postedMessages.at(-1), {
        type: 'copyNote',
        id: 'split-note'
    });

    runtime.click('note-menu-split-note');
    runtime.click('noteActionEdit');
    assert.deepEqual(runtime.postedMessages.at(-1), {
        type: 'editNoteNode',
        id: 'split-note'
    });
});

test('button panel hides hash-like note names behind readable fallback labels', async () => {
    const { noteStore, provider } = createProviderContext();

    const note = createDefaultNote('Local');
    note.id = 'hash-name-note';
    note.name = '4065be8cb3d141c38416bc4d7e9da4af';
    note.category = 'General';
    note.content = 'Drive.NET Smoke Tests';
    await noteStore.saveNode(note);

    const html = renderHtml(provider);

    assert.match(html, /Drive\.NET Smoke Tests/);
    assert.doesNotMatch(html, /<span class="btn-label">4065be8cb3d141c38416bc4d7e9da4af<\/span>/);
});

test('note add buttons post scope-aware create messages', async () => {
    const { harness, provider } = createProviderContext();
    const general = createDefaultButton('Global');
    general.name = 'Seed';
    general.category = 'General';
    await harness.vscode.workspace.getConfiguration('buttonfu').update('globalButtons', [general]);

    const html = renderHtml(provider);
    const runtime = executeWebviewScripts(html);

    runtime.click('addNoteGlobalBtn');
    assert.deepEqual(runtime.postedMessages.at(-1), {
        type: 'addNote',
        locality: 'Global'
    });

    runtime.click('addNoteFooterBtn');
    assert.deepEqual(runtime.postedMessages.at(-1), {
        type: 'addNote'
    });

    runtime.click('openNoteEditorBtn');
    assert.deepEqual(runtime.postedMessages.at(-1), {
        type: 'openNoteEditor'
    });
});