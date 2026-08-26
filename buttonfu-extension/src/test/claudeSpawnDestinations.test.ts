import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDefaultButton } from '../types';
import { createFakeVscodeHarness, loadWithPatchedVscode } from './helpers/fakeVscode';
import { useTempDirectory } from './helpers/tempCleanup';

const TEMP_ROOT = useTempDirectory('spawn');

interface SpawnCall {
    exe: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: string;
}

/** A child process that never really started, so exits and failures can be provoked. */
class FakeChild extends EventEmitter {
    readonly stdout = new EventEmitter();
    readonly stderr = new EventEmitter();
}

function createFixtures(platform: 'win32' | 'darwin' | 'linux' = 'win32') {
    const harness = createFakeVscodeHarness();
    const spawns: SpawnCall[] = [];
    const children: FakeChild[] = [];

    harness.vscode.window.createTerminal = () => ({
        show() { /* noop */ },
        sendText() { /* noop */ },
        shellIntegration: undefined
    });
    harness.vscode.window.onDidChangeTerminalShellIntegration = () => ({ dispose() { /* noop */ } });
    harness.vscode.extensions = { getExtension: () => undefined };

    const modulePath = path.resolve(__dirname, '..', 'claudeSessionService.js');
    const serviceModule = loadWithPatchedVscode<{ ClaudeSessionService: new () => any }>(modulePath, harness.vscode);
    const service = new serviceModule.ClaudeSessionService();

    service.resolveExecutable = () => ({ path: 'C:\\bin\\claude.exe', source: 'setting' });
    service.directoryExists = () => true;
    service.pwshAvailable = () => true;
    service.launcherDirectory = () => TEMP_ROOT;
    service.shellKind = () => (platform === 'win32' ? 'powershell' : 'posix');
    service.commandExists = () => true;
    service.findIdeLock = () => ({ port: 48622, authToken: 'token' });
    service.spawnDetached = (exe: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, stdio = 'ignore') => {
        spawns.push({ exe, args, cwd, env, stdio });
        const child = new FakeChild();
        children.push(child);
        return child;
    };

    return { harness, service, spawns, children };
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

/** Deletes the launcher script an external-terminal spawn left behind. */
function cleanUpLauncher(args: string[]): void {
    const scriptPath = args.find(arg => arg.includes('launch-'));
    if (scriptPath && fs.existsSync(scriptPath)) {
        fs.unlinkSync(scriptPath);
    }
}

// ---------------------------------------------------------------------------
// externalTerminal
// ---------------------------------------------------------------------------

test('externalTerminal spawns Windows Terminal detached, with the IDE port', async () => {
    const { service, spawns } = createFixtures();

    await service.launch(claudeButton({ claudeDestination: 'externalTerminal' }));

    assert.equal(spawns.length, 1);
    assert.equal(spawns[0].exe, 'wt.exe');
    assert.deepEqual(spawns[0].args.slice(0, 3), ['-d', os.tmpdir(), 'pwsh']);
    assert.ok(spawns[0].args.includes('-NoExit'), 'Without -NoExit the window closes and the transcript is lost.');
    assert.equal(spawns[0].env.CLAUDE_CODE_SSE_PORT, '48622');
    assert.equal(spawns[0].stdio, 'ignore');
    cleanUpLauncher(spawns[0].args);
});

test('externalTerminal falls back to cmd.exe start when Windows Terminal is absent', async () => {
    const { service, spawns } = createFixtures();
    service.commandExists = (name: string) => name !== 'wt.exe';

    await service.launch(claudeButton({ claudeDestination: 'externalTerminal' }));

    assert.equal(spawns[0].exe, 'cmd.exe');
    assert.deepEqual(spawns[0].args.slice(0, 3), ['/c', 'start', 'Claude']);
    assert.ok(spawns[0].args.includes('-NoExit'));
    cleanUpLauncher(spawns[0].args);
});

test('externalTerminal uses the configured command, substituting the script and folder', async () => {
    const { harness, service, spawns } = createFixtures();
    await harness.vscode.workspace.getConfiguration('buttonfu')
        .update('claude.externalTerminalCommand', ['alacritty', '--working-directory', '${cwd}', '-e', 'sh', '${script}']);

    await service.launch(claudeButton({ claudeDestination: 'externalTerminal' }));

    assert.equal(spawns[0].exe, 'alacritty');
    assert.equal(spawns[0].args[1], os.tmpdir());
    assert.ok(spawns[0].args[4].includes('launch-'));
    assert.ok(!spawns[0].args.includes('${script}'));
    cleanUpLauncher(spawns[0].args);
});

test('externalTerminal opens Terminal.app on macOS', async () => {
    const { service, spawns } = createFixtures('darwin');
    service.buildExternalTerminalCommand = (scriptPath: string) => ['open', '-a', 'Terminal', scriptPath];

    await service.launch(claudeButton({ claudeDestination: 'externalTerminal' }));

    assert.deepEqual(spawns[0].args.slice(0, 2), ['-a', 'Terminal']);
    cleanUpLauncher(spawns[0].args);
});

test('externalTerminal says so when no terminal program can be found', async () => {
    const { harness, service, spawns } = createFixtures();
    service.buildExternalTerminalCommand = () => undefined;

    await service.launch(claudeButton({ claudeDestination: 'externalTerminal' }));

    assert.equal(spawns.length, 0);
    assert.equal(harness.errorMessages.length, 1);
    assert.match(harness.errorMessages[0], /buttonfu\.claude\.externalTerminalCommand/);
});

test('a spawn failure that arrives late still reaches the user', async () => {
    const { harness, service, spawns, children } = createFixtures();

    await service.launch(claudeButton({ claudeDestination: 'externalTerminal' }));
    children[0].emit('error', new Error('The system cannot find the file specified.'));

    assert.equal(harness.errorMessages.length, 1);
    assert.match(harness.errorMessages[0], /cannot find the file/);
    cleanUpLauncher(spawns[0].args);
});

test('the external launcher carries the prompt, and the spawn arguments do not', async () => {
    const { service, spawns } = createFixtures();
    const prompt = 'Say "hello" and $stop; rm -rf /';

    await service.launch(claudeButton({ claudeDestination: 'externalTerminal', executionText: prompt }));

    assert.ok(!spawns[0].args.some(arg => arg.includes('hello')));
    const scriptPath = spawns[0].args.find(arg => arg.includes('launch-'))!;
    assert.ok(fs.readFileSync(scriptPath, 'utf8').includes(prompt));
    fs.unlinkSync(scriptPath);
});

// ---------------------------------------------------------------------------
// backgroundAgent
// ---------------------------------------------------------------------------

test('backgroundAgent spawns the CLI directly with --bg and no launcher script', async () => {
    const { service, spawns } = createFixtures();

    await service.launch(claudeButton({ claudeDestination: 'backgroundAgent' }));

    assert.equal(spawns.length, 1);
    assert.equal(spawns[0].exe, 'C:\\bin\\claude.exe');
    assert.ok(spawns[0].args.includes('--bg'));
    assert.equal(spawns[0].args[spawns[0].args.length - 1], 'Summarise this repo.');
    assert.ok(!spawns[0].args.some(arg => arg.includes('launch-')),
        'A background agent takes the argument list directly, with no script in between.');
    assert.equal(spawns[0].stdio, 'pipe');
});

test('backgroundAgent does not inherit this window IDE port, because it outlives the window', async () => {
    const { service, spawns } = createFixtures();

    await service.launch(claudeButton({ claudeDestination: 'backgroundAgent' }));

    assert.equal(spawns[0].env.CLAUDE_CODE_SSE_PORT, undefined);
});

test('backgroundAgent tells the user it started, and offers the agents list', async () => {
    const { harness, service } = createFixtures();

    await service.launch(claudeButton({ claudeDestination: 'backgroundAgent' }));

    assert.equal(harness.informationMessages.length, 1);
    assert.match(harness.informationMessages[0], /running in the background/);
});

test('a background agent that dies early reports what it printed to stderr', async () => {
    const { harness, service, children } = createFixtures();

    await service.launch(claudeButton({ claudeDestination: 'backgroundAgent' }));
    children[0].stderr.emit('data', Buffer.from('Invalid API key\n'));
    children[0].emit('exit', 1);

    assert.equal(harness.errorMessages.length, 1);
    assert.match(harness.errorMessages[0], /Invalid API key/);
});

test('a background agent that exits cleanly says nothing further', async () => {
    const { harness, service, children } = createFixtures();

    await service.launch(claudeButton({ claudeDestination: 'backgroundAgent' }));
    children[0].emit('exit', 0);

    assert.equal(harness.errorMessages.length, 0);
});
