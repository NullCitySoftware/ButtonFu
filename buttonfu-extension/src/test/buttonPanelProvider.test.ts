import assert = require('node:assert/strict');
import path = require('path');
import test = require('node:test');
import { createDefaultButton, createDefaultNote, createDefaultNoteFolder } from '../types';
import { createFakeVscodeHarness, loadWithPatchedVscode } from './helpers/fakeVscode';
import { executeWebviewScripts } from './helpers/webviewRuntime';

test('button panel keeps the legacy grouped layout with a workspace empty message', async () => {
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

    const general = createDefaultButton('Global');
    general.name = 'Git Commit + Push';
    general.category = 'General';
    general.icon = 'play';

    const reviews = createDefaultButton('Global');
    reviews.name = '3 Lens Review';
    reviews.category = 'Reviews';
    reviews.icon = 'beaker';
    reviews.sortOrder = (general.sortOrder ?? 0) + 10;

    await harness.vscode.workspace.getConfiguration('buttonfu').update('globalButtons', [general, reviews]);

    const provider = new providerModule.ButtonPanelProvider(context.extensionUri, store, noteStore, context.globalState);
    const html = (provider as any)._getHtmlContent({
        cspSource: 'vscode-webview://test',
        asWebviewUri: (uri: unknown) => uri
    });

    assert.match(html, /<div class="locality-header header-with-actions">[\s\S]*<span>Global<\/span>/);
    assert.match(html, /<span>General<\/span>/);
    assert.match(html, /Git Commit \+ Push/);
    assert.match(html, /<span>Reviews<\/span>/);
    assert.match(html, /3 Lens Review/);
    assert.match(html, /<div class="locality-header header-with-actions">[\s\S]*<span>Workspace \[TestWorkspace\]<\/span>/);
    assert.match(html, /No workspace buttons\. Add one via the editor\./);
    assert.doesNotMatch(html, /No global buttons\. Add one via the editor\./);
    assert.match(html, /<span>Notes<\/span>/);
    assert.match(html, /No global notes\. Add one via the editor\./);
    assert.equal((html.match(/class="locality-header/g) || []).length, 2);
    assert.match(html, /id="addNoteBtn"[\s\S]*id="openNoteEditorBtn"/);
});

test('button panel still shows the workspace section when the workspace has no buttons at all', () => {
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

    const html = (provider as any)._getHtmlContent({
        cspSource: 'vscode-webview://test',
        asWebviewUri: (uri: unknown) => uri
    });

    assert.match(html, /<div class="locality-header header-with-actions">[\s\S]*<span>Workspace \[TestWorkspace\]<\/span>/);
    assert.match(html, /No workspace buttons\. Add one via the editor\./);
    assert.match(html, /Workspace Notes \[TestWorkspace\]/);
});

test('button panel still shows workspace sections when no folder is open', () => {
    const harness = createFakeVscodeHarness();
    harness.setWorkspaceFolders([], { name: '', fireEvent: false });
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

    const html = (provider as any)._getHtmlContent({
        cspSource: 'vscode-webview://test',
        asWebviewUri: (uri: unknown) => uri
    });

    assert.match(html, /<div class="locality-header header-with-actions">[\s\S]*<span>Workspace<\/span>/);
    assert.match(html, /No workspace buttons\. Add one via the editor\./);
    assert.match(html, /Workspace Notes/);
});

test('button panel lets folder rows create notes inline without making scope headers interactive', async () => {
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

    const folder = createDefaultNoteFolder('Global');
    folder.id = 'prompt-folder';
    folder.name = 'Prompt Folder';
    await noteStore.saveNode(folder);

    const provider = new providerModule.ButtonPanelProvider(context.extensionUri, store, noteStore, context.globalState);
    const html = (provider as any)._getHtmlContent({
        cspSource: 'vscode-webview://test',
        asWebviewUri: (uri: unknown) => uri
    });

    assert.match(html, /id="noteContextMenu"/);
    assert.match(html, /class="notes-scope-label"[^>]*>Global Notes<\/div>/);
    assert.doesNotMatch(html, /data-note-target-kind="scopeRoot"/);
    assert.doesNotMatch(html, /id="noteTargetBanner"/);
    assert.match(html, /id="note-folder-row-prompt-folder"/);
    assert.match(html, /id="note-folder-add-prompt-folder"/);

    const runtime = executeWebviewScripts(html);

    runtime.click('note-folder-add-prompt-folder');
    assert.deepEqual(runtime.postedMessages.at(-1), {
        type: 'addNote',
        target: {
            id: 'prompt-folder',
            locality: 'Global',
            kind: 'folder'
        }
    });

    runtime.contextMenu('note-folder-row-prompt-folder', 32, 44);
    assert.equal(runtime.document.getElementById('noteContextMenu')?.classList.contains('visible'), true);
    assert.equal((runtime.document.getElementById('noteContextEdit') as any)?.hidden, false);
    assert.equal((runtime.document.getElementById('noteContextDelete') as any)?.hidden, false);

    runtime.click('noteContextAddFolder');
    assert.deepEqual(runtime.postedMessages.at(-1), {
        type: 'addNoteFolder',
        target: {
            id: 'prompt-folder',
            locality: 'Global',
            kind: 'folder'
        }
    });

    runtime.click('addNoteBtn');
    assert.deepEqual(runtime.postedMessages.at(-1), { type: 'addNote' });
});

test('folder with children renders a chevron that toggles collapse state', async () => {
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

    const folder = createDefaultNoteFolder('Global');
    folder.id = 'parent-folder';
    folder.name = 'My Folder';
    await noteStore.saveNode(folder);

    const note = createDefaultNote('Global', 'parent-folder');
    note.id = 'child-note';
    note.name = 'Child Note';
    await noteStore.saveNode(note);

    const provider = new providerModule.ButtonPanelProvider(context.extensionUri, store, noteStore, context.globalState);
    const html = (provider as any)._getHtmlContent({
        cspSource: 'vscode-webview://test',
        asWebviewUri: (uri: unknown) => uri
    });

    // Folder with children shows a down-chevron (expanded) and the child note
    assert.match(html, /id="note-chevron-parent-folder"/);
    assert.match(html, /codicon-chevron-down/);
    assert.match(html, /id="note-row-child-note"/);

    // Clicking the chevron posts a toggleNoteFolder message
    const runtime = executeWebviewScripts(html);
    runtime.click('note-chevron-parent-folder');
    assert.deepEqual(runtime.postedMessages.at(-1), {
        type: 'toggleNoteFolder',
        id: 'parent-folder'
    });

    // After collapsing (persisted in globalState), re-render hides children
    await context.globalState.update('notes.collapsedFolders', ['parent-folder']);
    const collapsedHtml = (provider as any)._getHtmlContent({
        cspSource: 'vscode-webview://test',
        asWebviewUri: (uri: unknown) => uri
    });
    assert.match(collapsedHtml, /codicon-chevron-right/);
    assert.doesNotMatch(collapsedHtml, /id="note-row-child-note"/);
});

test('empty folder renders no chevron', async () => {
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

    const folder = createDefaultNoteFolder('Global');
    folder.id = 'empty-folder';
    folder.name = 'Empty';
    await noteStore.saveNode(folder);

    const provider = new providerModule.ButtonPanelProvider(context.extensionUri, store, noteStore, context.globalState);
    const html = (provider as any)._getHtmlContent({
        cspSource: 'vscode-webview://test',
        asWebviewUri: (uri: unknown) => uri
    });

    assert.match(html, /id="note-folder-row-empty-folder"/);
    assert.doesNotMatch(html, /id="note-chevron-empty-folder"/);
    assert.doesNotMatch(html, /codicon-chevron-down/);
});

test('note rows and folder rows have draggable attribute and drag data', async () => {
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

    const folder = createDefaultNoteFolder('Global');
    folder.id = 'drag-folder';
    folder.name = 'Drag Folder';
    await noteStore.saveNode(folder);

    const note = createDefaultNote('Global');
    note.id = 'drag-note';
    note.name = 'Drag Note';
    await noteStore.saveNode(note);

    const provider = new providerModule.ButtonPanelProvider(context.extensionUri, store, noteStore, context.globalState);
    const html = (provider as any)._getHtmlContent({
        cspSource: 'vscode-webview://test',
        asWebviewUri: (uri: unknown) => uri
    });

    // Folder row is draggable with drag data
    assert.match(html, /id="note-folder-row-drag-folder"[^>]*draggable="true"/);
    assert.match(html, /id="note-folder-row-drag-folder"[^>]*data-note-drag-id="drag-folder"/);

    // Note row is draggable with drag data
    assert.match(html, /id="note-row-drag-note"[^>]*draggable="true"/);
    assert.match(html, /id="note-row-drag-note"[^>]*data-note-drag-id="drag-note"/);

    // Scope labels are drop targets
    assert.match(html, /id="note-scope-global"[^>]*data-note-drop-scope="Global"/);

    // Idle rows do not force hand/grab cursors; drag feedback uses the OS drag cursor instead.
    assert.doesNotMatch(html, /\.note-row\s*\{[^}]*cursor:\s*pointer;/);
    assert.doesNotMatch(html, /\[draggable="true"\]\s*\{[^}]*cursor:\s*grab;/);
});

test('double-clicking a note row posts editNoteNode message', async () => {
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

    const note = createDefaultNote('Global');
    note.id = 'dblclick-note';
    note.name = 'Double Click Me';
    await noteStore.saveNode(note);

    const provider = new providerModule.ButtonPanelProvider(context.extensionUri, store, noteStore, context.globalState);
    const html = (provider as any)._getHtmlContent({
        cspSource: 'vscode-webview://test',
        asWebviewUri: (uri: unknown) => uri
    });

    const runtime = executeWebviewScripts(html);
    runtime.doubleClick('note-row-dblclick-note');
    assert.deepEqual(runtime.postedMessages.at(-1), {
        type: 'editNoteNode',
        id: 'dblclick-note'
    });
});