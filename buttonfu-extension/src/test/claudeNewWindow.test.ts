import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { claimPendingJob, jobsDirectory } from '../claudeHandoff';
import { createDefaultButton } from '../types';
import { createFakeVscodeHarness, loadWithPatchedVscode } from './helpers/fakeVscode';
import { tempDirectory, useTempDirectory } from './helpers/tempCleanup';

const TEMP_ROOT = useTempDirectory('newwindow');

function createFixtures() {
    const harness = createFakeVscodeHarness();
    const storage = tempDirectory(TEMP_ROOT, 'newwindow');
    const terminals: any[] = [];

    harness.vscode.window.createTerminal = (options: any) => {
        const terminal = { options, show() { /* noop */ }, sendText() { /* noop */ }, shellIntegration: undefined };
        terminals.push(terminal);
        return terminal;
    };
    harness.vscode.window.onDidChangeTerminalShellIntegration = () => ({ dispose() { /* noop */ } });
    harness.vscode.extensions = { getExtension: () => undefined };

    const modulePath = path.resolve(__dirname, '..', 'claudeSessionService.js');
    const serviceModule = loadWithPatchedVscode<{ ClaudeSessionService: new (storage?: string) => any }>(
        modulePath, harness.vscode);
    const service = new serviceModule.ClaudeSessionService(storage);

    service.resolveExecutable = () => ({ path: 'C:\\bin\\claude.exe', source: 'setting' });
    service.pwshAvailable = () => true;
    service.launcherDirectory = () => TEMP_ROOT;
    service.runInTerminal = async () => undefined;

    return { harness, service, storage, terminals };
}

function claudeButton(overrides: Record<string, unknown> = {}) {
    const button = createDefaultButton('Global');
    button.name = 'Plan the engine';
    button.type = 'ClaudeCommand';
    button.executionText = 'Summarise this repo.';
    button.claudeDestination = 'newVsCodeWindow';
    button.claudeCwd = os.tmpdir();
    Object.assign(button, overrides);
    return button;
}

test('newVsCodeWindow queues a job and opens the folder in a new window', async () => {
    const { harness, service, storage } = createFixtures();
    const target = tempDirectory(TEMP_ROOT, 'target');

    await service.launch(claudeButton({ claudeTargetFolder: target, claudeModel: 'opus' }));

    const open = harness.executedCommands.find(entry => entry.command === 'vscode.openFolder');
    assert.ok(open, 'Expected the folder to be opened.');
    assert.deepEqual(open!.args[1], { forceNewWindow: true },
        'The button means "give me another window", even if the folder is already open.');

    const job = claimPendingJob(storage, target);
    assert.ok(job, 'Expected a job waiting for the new window.');
    assert.equal(job!.buttonName, 'Plan the engine');
    assert.equal(job!.spec.destination, 'terminalHere');
    assert.equal(job!.spec.model, 'opus');
    assert.equal(job!.spec.cwd, path.resolve(target));

    fs.rmSync(storage, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
});

test('newVsCodeWindow with no folder set says which field is missing, and queues nothing', async () => {
    const { harness, service, storage } = createFixtures();

    await service.launch(claudeButton({ claudeTargetFolder: '' }));

    assert.equal(harness.errorMessages.length, 1);
    assert.match(harness.errorMessages[0], /Folder To Open/);
    assert.ok(!harness.executedCommands.some(entry => entry.command === 'vscode.openFolder'));
    assert.equal(fs.existsSync(jobsDirectory(storage)), false);

    fs.rmSync(storage, { recursive: true, force: true });
});

test('newVsCodeWindow with a folder that does not exist opens nothing', async () => {
    const { harness, service, storage } = createFixtures();

    await service.launch(claudeButton({ claudeTargetFolder: path.join(os.tmpdir(), 'buttonfu-no-such-folder') }));

    assert.equal(harness.errorMessages.length, 1);
    assert.match(harness.errorMessages[0], /does not exist/);
    assert.ok(!harness.executedCommands.some(entry => entry.command === 'vscode.openFolder'));

    fs.rmSync(storage, { recursive: true, force: true });
});

test('launchSpec runs a queued job in a terminal, keeping its session id', async () => {
    const { service, terminals, storage } = createFixtures();
    const target = tempDirectory(TEMP_ROOT, 'target');
    await service.launch(claudeButton({ claudeTargetFolder: target }));
    const job = claimPendingJob(storage, target)!;

    let sent = '';
    service.runInTerminal = async (_terminal: unknown, command: string) => { sent = command; };
    await service.launchSpec(job.spec, job.buttonName);

    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].options.name, 'Claude: Plan the engine');
    const scriptPath = sent.slice(sent.indexOf('"') + 1, sent.lastIndexOf('"'));
    const body = fs.readFileSync(scriptPath, 'utf8');
    assert.ok(body.includes(job.spec.sessionId!), 'The queued session id must reach the new window.');
    assert.ok(body.includes('Summarise this repo.'));

    fs.unlinkSync(scriptPath);
    fs.rmSync(storage, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
});

test('resumeInTerminal carries an existing session on, with no prompt', async () => {
    const { service, terminals } = createFixtures();
    let sent = '';
    service.runInTerminal = async (_terminal: unknown, command: string) => { sent = command; };

    await service.resumeInTerminal('abc-123', os.tmpdir());

    assert.equal(terminals.length, 1);
    const scriptPath = sent.slice(sent.indexOf('"') + 1, sent.lastIndexOf('"'));
    const invocation = fs.readFileSync(scriptPath, 'utf8').split('\r\n').find(line => line.startsWith('& '))!;
    assert.ok(invocation.includes("'--resume' 'abc-123'"));
    fs.unlinkSync(scriptPath);
});

test('a service with no storage refuses the new-window destination and leaves the rest working', async () => {
    const { harness, service, terminals } = createFixtures();
    const target = tempDirectory(TEMP_ROOT, 'target');
    const modulePath = path.resolve(__dirname, '..', 'claudeSessionService.js');
    const serviceModule = loadWithPatchedVscode<{ ClaudeSessionService: new (storage?: string) => any }>(
        modulePath, harness.vscode);
    const storageless = new serviceModule.ClaudeSessionService();
    storageless.resolveExecutable = () => ({ path: 'C:\\bin\\claude.exe', source: 'setting' });
    storageless.runInTerminal = async () => undefined;
    storageless.pwshAvailable = () => true;
    storageless.launcherDirectory = () => TEMP_ROOT;

    await storageless.launch(claudeButton({ claudeTargetFolder: target }));
    assert.equal(harness.errorMessages.length, 1);

    await storageless.launch(claudeButton({ claudeDestination: 'terminalHere', claudeTargetFolder: '' }));
    assert.equal(terminals.length, 1, 'Every other destination should be unaffected.');

    fs.rmSync(target, { recursive: true, force: true });
    void service;
});
