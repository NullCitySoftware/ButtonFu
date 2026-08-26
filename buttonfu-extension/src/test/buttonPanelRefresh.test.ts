import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createDefaultButton } from '../types';
import { createFakeVscodeHarness, loadWithPatchedVscode } from './helpers/fakeVscode';

/** A webview view that behaves the way VS Code's does: hiding it loses everything but the html. */
function createFakeWebviewView() {
    const posted: any[] = [];
    const visibilityListeners: Array<() => void> = [];
    const disposeListeners: Array<() => void> = [];

    const view: any = {
        visible: true,
        webview: {
            options: {},
            html: '',
            cspSource: 'vscode-webview://test',
            asWebviewUri: (uri: unknown) => uri,
            postMessage: (message: unknown) => { posted.push(message); return Promise.resolve(true); },
            onDidReceiveMessage: () => ({ dispose() { /* noop */ } })
        },
        onDidChangeVisibility: (listener: () => void) => {
            visibilityListeners.push(listener);
            return { dispose() { /* noop */ } };
        },
        onDidDispose: (listener: () => void) => {
            disposeListeners.push(listener);
            return { dispose() { /* noop */ } };
        },
        setVisible(visible: boolean) {
            view.visible = visible;
            for (const listener of visibilityListeners) { listener(); }
        }
    };

    return { view, posted };
}

function createFixtures() {
    const harness = createFakeVscodeHarness();
    const buttonStoreModulePath = path.resolve(__dirname, '..', 'buttonStore.js');
    const noteStoreModulePath = path.resolve(__dirname, '..', 'noteStore.js');
    const providerModulePath = path.resolve(__dirname, '..', 'buttonPanelProvider.js');
    const buttonStoreModule = loadWithPatchedVscode<{ ButtonStore: new (context: any) => any }>(buttonStoreModulePath, harness.vscode);
    const noteStoreModule = loadWithPatchedVscode<{ NoteStore: new (context: any) => any }>(noteStoreModulePath, harness.vscode);
    const providerModule = loadWithPatchedVscode<{ ButtonPanelProvider: new (...args: any[]) => any }>(providerModulePath, harness.vscode);
    const context = harness.createExtensionContext();
    const store = new buttonStoreModule.ButtonStore(context);
    const noteStore = new noteStoreModule.NoteStore(context);
    const provider = new providerModule.ButtonPanelProvider(context.extensionUri, store, noteStore, context.globalState);
    return { harness, context, store, provider };
}

async function saveButton(store: any, id: string, name: string) {
    const button = createDefaultButton('Global');
    button.id = id;
    button.name = name;
    button.category = 'General';
    await store.saveButton(button);
}

test('the html a hidden panel is restored from keeps up with the buttons', async () => {
    const { context, store, provider } = createFixtures();
    const { view } = createFakeWebviewView();

    await saveButton(store, 'first', 'First Button');
    provider.resolveWebviewView(view, {}, {});
    assert.match(view.webview.html, /First Button/);

    // A change made while the panel is on screen goes out as a message, which is fast but leaves
    // the stored html behind. Hiding and re-showing must not bring the old content back.
    await saveButton(store, 'second', 'Second Button');
    view.setVisible(false);
    view.setVisible(true);
    assert.match(view.webview.html, /Second Button/, 'A restored panel showed content from before the change.');

    // A change made while the panel is hidden has no live DOM to reach, so it has to be written
    // into the html directly.
    view.setVisible(false);
    await saveButton(store, 'third', 'Third Button');
    assert.match(view.webview.html, /Third Button/, 'A change made while hidden never reached the panel.');

    view.setVisible(true);
    assert.match(view.webview.html, /Third Button/);
    assert.equal(context.globalState.get('options.columns'), undefined);
});

test('the column count survives hiding and re-showing the panel', async () => {
    const { context, store, provider } = createFixtures();
    const { view } = createFakeWebviewView();

    await saveButton(store, 'only', 'Only Button');
    provider.resolveWebviewView(view, {}, {});
    assert.match(view.webview.html, /class="button-flow"/, 'One column should use the flow layout.');

    await context.globalState.update('options.columns', 6);
    provider.refresh();
    view.setVisible(false);
    view.setVisible(true);

    assert.match(view.webview.html, /grid-template-columns:repeat\(6,1fr\)/,
        'The panel fell back to its old column count after being hidden.');
    assert.doesNotMatch(view.webview.html, /class="button-flow"/);
});

test('a visible panel still takes the cheap message path', async () => {
    const { store, provider } = createFixtures();
    const { view, posted } = createFakeWebviewView();

    await saveButton(store, 'only', 'Only Button');
    provider.resolveWebviewView(view, {}, {});
    const htmlAfterResolve = view.webview.html;

    await saveButton(store, 'another', 'Another Button');

    assert.equal(view.webview.html, htmlAfterResolve, 'A visible panel should not be rebuilt from scratch.');
    assert.ok(posted.some(message => message?.type === 'refreshContent' && /Another Button/.test(message.html)));
});
