import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDefaultButton } from '../types';
import { createFakeVscodeHarness, loadWithPatchedVscode } from './helpers/fakeVscode';
import { useTempDirectory } from './helpers/tempCleanup';

const TEMP_ROOT = useTempDirectory('session');

interface FakeTerminal {
    options: any;
    shown: boolean;
    sentText: string[];
    executed: string[];
    shellIntegration: any;
    show(): void;
    sendText(text: string): void;
}

function createFixtures(options: { withShellIntegration?: boolean } = {}) {
    const harness = createFakeVscodeHarness();
    const terminals: FakeTerminal[] = [];
    const shellIntegrationListeners: Array<(event: any) => void> = [];

    harness.vscode.window.createTerminal = (terminalOptions: any): FakeTerminal => {
        const terminal: FakeTerminal = {
            options: terminalOptions,
            shown: false,
            sentText: [],
            executed: [],
            shellIntegration: undefined,
            show() { terminal.shown = true; },
            sendText(text: string) { terminal.sentText.push(text); }
        };
        if (options.withShellIntegration) {
            terminal.shellIntegration = {
                executeCommand: (command: string) => { terminal.executed.push(command); }
            };
        }
        terminals.push(terminal);
        return terminal;
    };
    harness.vscode.window.onDidChangeTerminalShellIntegration = (listener: (event: any) => void) => {
        shellIntegrationListeners.push(listener);
        return { dispose() { /* noop */ } };
    };
    harness.vscode.extensions = { getExtension: () => undefined };

    const modulePath = path.resolve(__dirname, '..', 'claudeSessionService.js');
    const serviceModule = loadWithPatchedVscode<{ ClaudeSessionService: new () => any }>(modulePath, harness.vscode);
    const service = new serviceModule.ClaudeSessionService();

    // The real machine has no bearing on argument building or destination routing.
    service.resolveExecutable = () => ({ path: 'C:\\bin\\claude.exe', source: 'setting' });
    service.directoryExists = () => true;
    service.pwshAvailable = () => true;
    service.launcherDirectory = () => TEMP_ROOT;

    return { harness, service, terminals, shellIntegrationListeners };
}

function claudeButton(overrides: Record<string, unknown> = {}) {
    const button = createDefaultButton('Global');
    button.name = 'Plan this repo';
    button.type = 'ClaudeCommand';
    button.executionText = 'Read AGENTS.md and summarise what this repo does.';
    button.claudeCwd = os.tmpdir();
    Object.assign(button, overrides);
    return button;
}

// ---------------------------------------------------------------------------
// buildRequest
// ---------------------------------------------------------------------------

test('buildRequest mints a session id and falls back to the button name', () => {
    const { service } = createFixtures();

    const request = service.buildRequest(claudeButton());

    assert.match(request.sessionId, /^[0-9a-f-]{36}$/);
    assert.equal(request.sessionName, 'Plan this repo');
    assert.equal(request.destination, 'panelPrefill');
    assert.equal(request.prompt, 'Read AGENTS.md and summarise what this repo does.');
});

test('buildRequest prefers an explicit session name', () => {
    const { service } = createFixtures();

    const request = service.buildRequest(claudeButton({ claudeSessionName: '  repo plan  ' }));

    assert.equal(request.sessionName, 'repo plan');
});

test('buildRequest mints a fresh session id every time', () => {
    const { service } = createFixtures();
    const button = claudeButton();

    assert.notEqual(service.buildRequest(button).sessionId, service.buildRequest(button).sessionId);
});

test('buildRequest falls back to the workspace folder, then to home', () => {
    const { harness, service } = createFixtures();
    const button = claudeButton({ claudeCwd: '' });

    harness.setWorkspaceFolders([{ fsPath: 'C:\\GIT\\ButtonFu', name: 'ButtonFu' }]);
    assert.equal(service.buildRequest(button).cwd, 'C:\\GIT\\ButtonFu');

    harness.setWorkspaceFolders([]);
    assert.equal(service.buildRequest(button).cwd, os.homedir());
});

test('launch refuses a working directory that does not exist, and starts nothing', async () => {
    const { harness, service, terminals } = createFixtures();
    service.directoryExists = () => false;

    await service.launch(claudeButton({ claudeCwd: 'C:\\nowhere\\at\\all' }));

    assert.equal(terminals.length, 0);
    assert.equal(harness.errorMessages.length, 1);
    assert.match(harness.errorMessages[0], /C:\\nowhere\\at\\all/);
});

test('launch reports a missing Claude executable rather than spawning anything', async () => {
    const { harness, service, terminals } = createFixtures();
    service.resolveExecutable = () => undefined;

    await service.launch(claudeButton());

    assert.equal(terminals.length, 0);
    assert.equal(harness.errorMessages.length, 1);
    assert.match(harness.errorMessages[0], /PATH/);
    assert.match(harness.errorMessages[0], /buttonfu\.claude\.executablePath/);
});

test('launch reports a destination it does not recognise rather than throwing', async () => {
    const { harness, service, terminals } = createFixtures();
    service.runInTerminal = async () => undefined;

    // Every destination in the enum is built, so this stands in for one from a newer version.
    await service.launch(claudeButton({ claudeDestination: 'teleport' }));

    assert.equal(terminals.length, 0);
    assert.equal(harness.errorMessages.length, 1);
    assert.match(harness.errorMessages[0], /teleport/);
});

// ---------------------------------------------------------------------------
// Terminal destinations
// ---------------------------------------------------------------------------

test('terminalHere opens a plain terminal and never moves it to a new window', async () => {
    const { harness, service, terminals } = createFixtures();
    service.runInTerminal = async () => undefined;

    await service.launch(claudeButton({ claudeDestination: 'terminalHere' }));

    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].shown, true);
    assert.equal(terminals[0].options.location, undefined);
    assert.equal(terminals[0].options.name, 'Claude: Plan this repo');
    assert.equal(terminals[0].options.isTransient, true);
    assert.ok(!harness.executedCommands.some(entry => entry.command === 'workbench.action.moveEditorToNewWindow'));
});

test('terminalNewWindow opens an editor terminal and tears it off afterwards', async () => {
    const { harness, service, terminals } = createFixtures();
    const order: string[] = [];
    service.runInTerminal = async () => { order.push('command'); };
    const originalExecute = harness.vscode.commands.executeCommand;
    harness.vscode.commands.executeCommand = async (command: string, ...args: any[]) => {
        order.push(command);
        return originalExecute(command, ...args);
    };

    await service.launch(claudeButton({ claudeDestination: 'terminalNewWindow' }));

    assert.equal(terminals.length, 1);
    assert.deepEqual(terminals[0].options.location, { viewColumn: 1 });
    assert.deepEqual(order, ['command', 'workbench.action.moveEditorToNewWindow'],
        'The terminal must be torn off after the command, not before.');
});

test('neither terminal destination passes env or strictEnv', async () => {
    const { service, terminals } = createFixtures();
    service.runInTerminal = async () => undefined;

    await service.launch(claudeButton({ claudeDestination: 'terminalHere' }));
    await service.launch(claudeButton({ claudeDestination: 'terminalNewWindow' }));

    for (const terminal of terminals) {
        assert.ok(!('env' in terminal.options),
            'A custom env drops CLAUDE_CODE_SSE_PORT and the session loses its IDE connection.');
        assert.ok(!('strictEnv' in terminal.options),
            'strictEnv drops CLAUDE_CODE_SSE_PORT and the session loses its IDE connection.');
    }
});

test('the line sent to the terminal carries no prompt text, but the launcher does', async () => {
    const { service } = createFixtures();
    const prompt = 'Say "hello" from $HOME, it\'s `important`\nand keep going.';
    let sent = '';
    service.runInTerminal = async (_terminal: unknown, command: string) => { sent = command; };

    await service.launch(claudeButton({ claudeDestination: 'terminalHere', executionText: prompt }));

    assert.match(sent, /^pwsh -NoProfile -ExecutionPolicy Bypass -File "/);
    assert.ok(!sent.includes('hello'));

    const scriptPath = sent.slice(sent.indexOf('"') + 1, sent.lastIndexOf('"'));
    const body = fs.readFileSync(scriptPath, 'utf8');
    assert.ok(body.includes("'Say \"hello\" from $HOME, it''s `important`\nand keep going.'"));
    fs.unlinkSync(scriptPath);
});

test('the launcher carries the flags the button asked for, with the prompt last', async () => {
    const { service } = createFixtures();
    let sent = '';
    service.runInTerminal = async (_terminal: unknown, command: string) => { sent = command; };

    await service.launch(claudeButton({
        claudeDestination: 'terminalHere',
        claudeModel: 'opus',
        claudePermissionMode: 'bypassPermissions',
        claudeAddDirs: ['C:\\GIT\\Kitae', 'C:\\GIT\\Catanari']
    }));

    const scriptPath = sent.slice(sent.indexOf('"') + 1, sent.lastIndexOf('"'));
    const body = fs.readFileSync(scriptPath, 'utf8');
    const invocation = body.split('\r\n').find(line => line.startsWith('& '))!;

    assert.ok(invocation.includes("'--model' 'opus'"));
    assert.ok(invocation.includes("'--dangerously-skip-permissions'"));
    assert.ok(!invocation.includes('--permission-mode'));
    assert.ok(invocation.includes("'--add-dir' 'C:\\GIT\\Kitae' '--add-dir' 'C:\\GIT\\Catanari'"));
    assert.ok(invocation.trimEnd().endsWith("'Read AGENTS.md and summarise what this repo does.'"),
        'The prompt must be the final argument, or --add-dir swallows it.');
    fs.unlinkSync(scriptPath);
});

// ---------------------------------------------------------------------------
// runInTerminal
// ---------------------------------------------------------------------------

test('runInTerminal uses shell integration when the terminal already has it', async () => {
    const { service, terminals, harness } = createFixtures({ withShellIntegration: true });

    await service.launch(claudeButton({ claudeDestination: 'terminalHere' }));

    assert.equal(terminals[0].executed.length, 1);
    assert.equal(terminals[0].sentText.length, 0);
    assert.equal(harness.errorMessages.length, 0);
});

test('runInTerminal waits for shell integration to arrive before sending', async () => {
    const { service, terminals, shellIntegrationListeners } = createFixtures();

    const pending = service.launch(claudeButton({ claudeDestination: 'terminalHere' }));
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].sentText.length, 0, 'Nothing should be sent before the shell is ready.');

    terminals[0].shellIntegration = {
        executeCommand: (command: string) => { terminals[0].executed.push(command); }
    };
    for (const listener of shellIntegrationListeners) {
        listener({ terminal: terminals[0] });
    }
    await pending;

    assert.equal(terminals[0].executed.length, 1);
    assert.equal(terminals[0].sentText.length, 0);
});
