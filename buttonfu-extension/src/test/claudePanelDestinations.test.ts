import assert from 'node:assert/strict';
import * as os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDefaultButton } from '../types';
import { createFakeVscodeHarness, loadWithPatchedVscode } from './helpers/fakeVscode';
import { useTempDirectory } from './helpers/tempCleanup';

const TEMP_ROOT = useTempDirectory('panel');

interface HeadlessRun {
    exe: string;
    args: string[];
    cwd: string;
}

function createFixtures() {
    const harness = createFakeVscodeHarness();
    const panelOpens: any[] = [];
    const headlessRuns: HeadlessRun[] = [];
    const terminals: any[] = [];
    let headlessResult = { code: 0, stderr: '', cancelled: false };

    harness.vscode.window.createTerminal = (options: any) => {
        const terminal = { options, show() { /* noop */ }, sendText() { /* noop */ }, shellIntegration: undefined };
        terminals.push(terminal);
        return terminal;
    };
    harness.vscode.window.onDidChangeTerminalShellIntegration = () => ({ dispose() { /* noop */ } });
    harness.vscode.window.withProgress = async (_options: unknown, task: any) =>
        task({ report: () => undefined }, { onCancellationRequested: () => ({ dispose() { /* noop */ } }) });
    harness.vscode.ProgressLocation = { Notification: 15 };
    harness.vscode.extensions = { getExtension: () => ({ extensionPath: 'C:\\ext\\claude-code' }) };

    const modulePath = path.resolve(__dirname, '..', 'claudeSessionService.js');
    const serviceModule = loadWithPatchedVscode<{ ClaudeSessionService: new () => any }>(modulePath, harness.vscode);
    const service = new serviceModule.ClaudeSessionService();

    service.resolveExecutable = () => ({ path: 'C:\\bin\\claude.exe', source: 'setting' });
    service.directoryExists = () => true;
    service.pwshAvailable = () => true;
    service.launcherDirectory = () => TEMP_ROOT;
    service.runInTerminal = async () => undefined;
    service.openPanel = async (options: unknown) => { panelOpens.push(options); return true; };
    service.runHeadless = async (exe: string, args: string[], cwd: string) => {
        headlessRuns.push({ exe, args, cwd });
        return headlessResult;
    };

    return {
        harness,
        service,
        panelOpens,
        headlessRuns,
        terminals,
        setHeadlessResult(result: { code: number; stderr: string; cancelled: boolean }) { headlessResult = result; }
    };
}

function claudeButton(overrides: Record<string, unknown> = {}) {
    const button = createDefaultButton('Global');
    button.name = 'Plan this repo';
    button.type = 'ClaudeCommand';
    button.executionText = 'Summarise this repo.';
    button.claudeCwd = os.tmpdir();
    Object.assign(button, overrides);
    return button;
}

// ---------------------------------------------------------------------------
// panelPrefill
// ---------------------------------------------------------------------------

test('panelPrefill opens the panel with the prompt and says it was not sent', async () => {
    const { harness, service, panelOpens } = createFixtures();

    await service.launch(claudeButton({ claudeDestination: 'panelPrefill' }));

    assert.equal(panelOpens.length, 1);
    assert.equal(panelOpens[0].prompt, 'Summarise this repo.');
    assert.equal(panelOpens[0].newWindow, false);
    assert.equal(harness.informationMessages.length, 1);
    assert.match(harness.informationMessages[0], /Press Enter to send it/,
        'A user who thinks this destination runs the prompt will read the silence as a broken button.');
});

test('panelPrefill honours the open-in-its-own-window setting', async () => {
    const { service, panelOpens } = createFixtures();

    await service.launch(claudeButton({ claudeDestination: 'panelPrefill', claudeNewWindow: true }));

    assert.equal(panelOpens[0].newWindow, true);
});

test('panelPrefill logs the settings the panel has nowhere to put', async () => {
    const { harness, service } = createFixtures();

    await service.launch(claudeButton({
        claudeDestination: 'panelPrefill',
        claudeModel: 'opus',
        claudeEffort: 'high',
        claudePermissionMode: 'plan'
    }));

    const lines = harness.outputChannelLines.get('ButtonFu Claude') ?? [];
    const ignoredLine = lines.find(line => line.includes('ignored'));
    assert.ok(ignoredLine, 'Expected a log line naming the dropped settings.');
    assert.match(ignoredLine!, /model, effort, permission mode/);
});

test('a missing Claude extension offers a terminal rather than failing quietly', async () => {
    const { harness, service, terminals } = createFixtures();
    service.openPanel = async () => false;
    harness.queueWarningMessageResult('Open a terminal instead');

    await service.launch(claudeButton({ claudeDestination: 'panelPrefill' }));

    assert.equal(harness.warningMessages.length, 1);
    assert.match(harness.warningMessages[0], /not installed/);
    assert.equal(terminals.length, 1, 'Accepting the offer should open a terminal.');
});

test('declining the terminal offer does nothing at all', async () => {
    const { harness, service, terminals } = createFixtures();
    service.openPanel = async () => false;

    await service.launch(claudeButton({ claudeDestination: 'panelPrefill' }));

    assert.equal(harness.warningMessages.length, 1);
    assert.equal(terminals.length, 0);
});

// ---------------------------------------------------------------------------
// headlessThenPanel
// ---------------------------------------------------------------------------

test('headlessThenPanel runs with the print flags, then opens the same session', async () => {
    const { service, headlessRuns, panelOpens } = createFixtures();

    await service.launch(claudeButton({ claudeDestination: 'headlessThenPanel' }));

    assert.equal(headlessRuns.length, 1);
    assert.ok(headlessRuns[0].args.includes('-p'));
    assert.deepEqual(headlessRuns[0].args.slice(-4), ['-p', '--output-format', 'text', 'Summarise this repo.']);

    const sessionId = headlessRuns[0].args[headlessRuns[0].args.indexOf('--session-id') + 1];
    assert.equal(panelOpens.length, 1);
    assert.equal(panelOpens[0].sessionId, sessionId,
        'The panel must resume the very session the headless run wrote.');
    assert.equal(panelOpens[0].prompt, undefined, 'The prompt was already answered; do not retype it.');
});

test('a cancelled headless run says cancelled and opens nothing', async () => {
    const { harness, service, panelOpens, setHeadlessResult } = createFixtures();
    setHeadlessResult({ code: -1, stderr: '', cancelled: true });

    await service.launch(claudeButton({ claudeDestination: 'headlessThenPanel' }));

    assert.equal(panelOpens.length, 0);
    assert.equal(harness.errorMessages.length, 0, 'Cancelling is not a failure.');
    assert.match(harness.informationMessages[0], /cancelled/);
});

test('a failed headless run shows the last line of what Claude printed', async () => {
    const { harness, service, panelOpens, setHeadlessResult } = createFixtures();
    setHeadlessResult({ code: 1, stderr: 'warming up\nInvalid API key\n', cancelled: false });

    await service.launch(claudeButton({ claudeDestination: 'headlessThenPanel' }));

    assert.equal(panelOpens.length, 0);
    assert.equal(harness.errorMessages.length, 1);
    assert.match(harness.errorMessages[0], /Invalid API key/);
});

test('a finished headless run offers the panel again and a resume command to copy', async () => {
    const { harness, service, headlessRuns, setHeadlessResult } = createFixtures();
    setHeadlessResult({ code: 0, stderr: '', cancelled: false });
    harness.queueWarningMessageResult(undefined);

    await service.launch(claudeButton({ claudeDestination: 'headlessThenPanel' }));

    assert.equal(harness.informationMessages.length, 1);
    assert.match(harness.informationMessages[0], /finished "Plan this repo"/);
    assert.ok(headlessRuns[0].args.includes('--session-id'));
});
