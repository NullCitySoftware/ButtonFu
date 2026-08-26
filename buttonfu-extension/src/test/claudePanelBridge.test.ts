import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createFakeVscodeHarness, loadWithPatchedVscode } from './helpers/fakeVscode';

const CLAUDE_EXTENSION = 'anthropic.claude-code';

function createFixtures(options: { installed?: boolean; hasCommand?: boolean } = {}) {
    const installed = options.installed ?? true;
    const hasCommand = options.hasCommand ?? true;
    const harness = createFakeVscodeHarness();
    const openedExternally: string[] = [];

    harness.vscode.extensions = {
        getExtension: (id: string) =>
            (installed && id === CLAUDE_EXTENSION ? { extensionPath: 'C:\\ext\\claude-code' } : undefined)
    };
    harness.vscode.env.openExternal = async (uri: { toString(): string }) => {
        openedExternally.push(uri.toString());
        return true;
    };
    harness.vscode.Uri.parse = (value: string) => ({ toString: () => value, fsPath: value, path: value });
    if (hasCommand) {
        harness.setExternalCommandHandler('claude-vscode.editor.open', () => undefined);
    }

    const modulePath = path.resolve(__dirname, '..', 'claudePanelBridge.js');
    const bridge = loadWithPatchedVscode<typeof import('../claudePanelBridge')>(modulePath, harness.vscode);

    return { harness, bridge, openedExternally };
}

// ---------------------------------------------------------------------------
// The deep link
// ---------------------------------------------------------------------------

test('buildDeepLink carries the session and the prompt', () => {
    const { bridge } = createFixtures();

    const link = bridge.buildDeepLink({ sessionId: 'abc-123', prompt: 'hello' }).toString();

    assert.equal(link, 'vscode://anthropic.claude-code/open?session=abc-123&prompt=hello');
});

test('buildDeepLink omits whichever half is missing', () => {
    const { bridge } = createFixtures();

    assert.equal(bridge.buildDeepLink({ sessionId: 'abc' }).toString(),
        'vscode://anthropic.claude-code/open?session=abc');
    assert.equal(bridge.buildDeepLink({ prompt: 'hi' }).toString(),
        'vscode://anthropic.claude-code/open?prompt=hi');
    assert.equal(bridge.buildDeepLink({}).toString(), 'vscode://anthropic.claude-code/open');
});

test('buildDeepLink encodes the characters that would otherwise end the prompt early', () => {
    const { bridge } = createFixtures();

    const link = bridge.buildDeepLink({ prompt: 'a & b # c + d\ne' }).toString();
    const encoded = link.slice(link.indexOf('prompt=') + 'prompt='.length);

    assert.equal(decodeURIComponent(encoded), 'a & b # c + d\ne');
    assert.ok(!encoded.includes('&'), 'A raw ampersand would look like the start of another parameter.');
    assert.ok(!encoded.includes('#'), 'A raw hash would truncate the URI at a fragment.');
    assert.ok(!encoded.includes('\n'));
    assert.ok(encoded.includes('%2B'), 'A raw plus would decode back as a space.');
});

// ---------------------------------------------------------------------------
// Opening the panel
// ---------------------------------------------------------------------------

test('openPanel prefers the extension command when it exists', async () => {
    const { harness, bridge, openedExternally } = createFixtures();

    assert.equal(await bridge.openPanel({ sessionId: 'abc', prompt: 'hello' }), true);

    const call = harness.executedCommands.find(entry => entry.command === 'claude-vscode.editor.open');
    assert.ok(call, 'Expected the panel command to be used.');
    assert.deepEqual(call!.args.slice(0, 2), ['abc', 'hello']);
    assert.equal(openedExternally.length, 0);
});

test('openPanel falls back to the deep link when the command is missing', async () => {
    const { harness, bridge, openedExternally } = createFixtures({ hasCommand: false });

    assert.equal(await bridge.openPanel({ sessionId: 'abc', prompt: 'hello' }), true);

    assert.equal(openedExternally.length, 1);
    assert.equal(openedExternally[0], 'vscode://anthropic.claude-code/open?session=abc&prompt=hello');
    assert.ok(!harness.executedCommands.some(entry => entry.command === 'claude-vscode.editor.open'));
});

test('openPanel reports failure when the Claude extension is not installed', async () => {
    const { harness, bridge, openedExternally } = createFixtures({ installed: false });

    assert.equal(await bridge.openPanel({ sessionId: 'abc' }), false);

    assert.equal(openedExternally.length, 0);
    assert.equal(harness.executedCommands.length, 0);
});

test('openPanel moves the panel into its own window only when asked', async () => {
    const { harness, bridge } = createFixtures();

    await bridge.openPanel({ sessionId: 'abc' });
    assert.ok(!harness.executedCommands.some(entry => entry.command === 'workbench.action.moveEditorToNewWindow'));

    await bridge.openPanel({ sessionId: 'abc', newWindow: true });
    assert.ok(harness.executedCommands.some(entry => entry.command === 'workbench.action.moveEditorToNewWindow'));
});

test('isClaudeExtensionInstalled reflects whether the extension is there', () => {
    assert.equal(createFixtures().bridge.isClaudeExtensionInstalled(), true);
    assert.equal(createFixtures({ installed: false }).bridge.isClaudeExtensionInstalled(), false);
});

test('logPanelIgnoredFields records what the panel could not carry, and stays quiet otherwise', () => {
    const { harness, bridge } = createFixtures();

    bridge.logPanelIgnoredFields('Plan this repo', []);
    assert.equal(harness.outputChannelLines.get('ButtonFu Claude'), undefined);

    bridge.logPanelIgnoredFields('Plan this repo', ['model', 'effort']);
    const lines = harness.outputChannelLines.get('ButtonFu Claude') ?? [];
    assert.equal(lines.length, 1);
    assert.match(lines[0], /ignored: model, effort/);
});
