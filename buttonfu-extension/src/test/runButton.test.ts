import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import type { ApiResult, ButtonConfig } from '../types';
import { createFakeVscodeHarness, loadWithPatchedVscode } from './helpers/fakeVscode';

function createFixtures(options: { allowed?: boolean } = {}) {
    const harness = createFakeVscodeHarness();
    const executed: Array<{ button: ButtonConfig; userValues: Record<string, string> }> = [];

    const storePath = path.resolve(__dirname, '..', 'buttonStore.js');
    const storeModule = loadWithPatchedVscode<{ ButtonStore: new (context: any) => any }>(storePath, harness.vscode);
    const context = harness.createExtensionContext();
    const store = new storeModule.ButtonStore(context);

    const apiPath = path.resolve(__dirname, '..', 'buttonApiService.js');
    const api = loadWithPatchedVscode<typeof import('../buttonApiService')>(apiPath, harness.vscode);

    const executorPath = path.resolve(__dirname, '..', 'buttonExecutor.js');
    const executorModule = loadWithPatchedVscode<{ ButtonExecutor: new (...args: any[]) => any }>(
        executorPath, harness.vscode, {
            './claudeSessionService': { ClaudeSessionService: class { async launch(): Promise<void> { /* noop */ } } }
        });
    const executor = new executorModule.ButtonExecutor();
    executor.executeWithTokens = async (button: ButtonConfig, _snap: unknown, userValues: Record<string, string>) => {
        executed.push({ button, userValues });
    };

    const host = {
        allowed: () => options.allowed ?? true,
        executor: () => executor
    };

    return { harness, store, api, host, executed };
}

async function saveClaudeButton(store: any, overrides: Record<string, unknown> = {}) {
    const button = {
        id: 'claude-1',
        name: 'Plan this repo',
        locality: 'Global',
        description: '',
        type: 'ClaudeCommand',
        executionText: 'Summarise this repo.',
        category: 'Claude',
        icon: 'sparkle',
        colour: '',
        copilotModel: '',
        copilotMode: 'agent',
        copilotAttachFiles: [],
        copilotAttachActiveFile: false,
        claudeDestination: 'terminalHere',
        warnBeforeExecution: false,
        userTokens: [],
        ...overrides
    };
    await store.saveButton(button, 'User');
    return button;
}

test('runButton refuses everything while the setting is off', async () => {
    const { store, api, host, executed } = createFixtures({ allowed: false });
    await saveClaudeButton(store);

    const result = await api.runButton(store, { id: 'claude-1' }, host);

    assert.equal(result.success, false);
    assert.match(result.errors![0], /buttonfu\.claude\.allowBridgeRun/);
    assert.equal(executed.length, 0);
});

test('runButton refuses a button of any other type, by name', async () => {
    const { store, api, host, executed } = createFixtures();
    await saveClaudeButton(store, { id: 'terminal-1', type: 'TerminalCommand', name: 'Deploy the site' });

    const result = await api.runButton(store, { id: 'terminal-1' }, host);

    assert.equal(result.success, false);
    assert.match(result.errors![0], /Only Claude buttons can be run over the bridge/);
    assert.match(result.errors![0], /Terminal Command/);
    assert.equal(executed.length, 0);
});

test('runButton starts a Claude button through the same path a click takes', async () => {
    const { store, api, host, executed } = createFixtures();
    await saveClaudeButton(store);

    const result = await api.runButton(store, { id: 'claude-1' }, host) as ApiResult<{ id: string; launched: true }>;

    assert.equal(result.success, true);
    assert.equal(result.data?.id, 'claude-1');
    assert.equal(result.data?.launched, true);
    assert.equal(executed.length, 1);
    assert.equal(executed[0].button.name, 'Plan this repo');
});

test('runButton finds a button by name, optionally narrowed by scope', async () => {
    const { store, api, host, executed } = createFixtures();
    await saveClaudeButton(store);

    assert.equal((await api.runButton(store, { name: 'plan THIS repo' }, host)).success, true);
    assert.equal((await api.runButton(store, { name: 'Plan this repo', locality: 'Global' }, host)).success, true);
    assert.equal((await api.runButton(store, { name: 'Plan this repo', locality: 'Local' }, host)).success, false);
    assert.equal(executed.length, 2);
});

test('runButton says which button it could not find', async () => {
    const { store, api, host } = createFixtures();

    const byId = await api.runButton(store, { id: 'nope' }, host);
    assert.equal(byId.success, false);
    assert.match(byId.errors![0], /Button not found: nope/);

    const byNothing = await api.runButton(store, {}, host);
    assert.equal(byNothing.success, false);
    assert.match(byNothing.errors![0], /id or name is required/);
});

test('runButton refuses a button whose user tokens have nobody to fill them in', async () => {
    const { store, api, host, executed } = createFixtures();
    await saveClaudeButton(store, {
        executionText: 'Review $Target$ and $Scope$.',
        userTokens: [
            { token: '$Target$', label: 'Target', dataType: 'String', defaultValue: '', required: true },
            { token: '$Scope$', label: 'Scope', dataType: 'String', defaultValue: '', required: true }
        ]
    });

    const result = await api.runButton(store, { id: 'claude-1' }, host);

    assert.equal(result.success, false);
    assert.match(result.errors![0], /\$Target\$, \$Scope\$/);
    assert.equal(executed.length, 0);
});

test('runButton accepts token values from the caller, with or without the dollars', async () => {
    const { store, api, host, executed } = createFixtures();
    await saveClaudeButton(store, {
        executionText: 'Review $Target$ and $Scope$.',
        userTokens: [
            { token: '$Target$', label: 'Target', dataType: 'String', defaultValue: '', required: true },
            { token: '$Scope$', label: 'Scope', dataType: 'String', defaultValue: '', required: true }
        ]
    });

    const result = await api.runButton(
        store, { id: 'claude-1', tokens: { Target: 'the router', '$Scope$': 'everything' } }, host);

    assert.equal(result.success, true);
    assert.equal(executed.length, 1);
    assert.equal(executed[0].userValues['$target$'], 'the router');
    assert.equal(executed[0].userValues['$scope$'], 'everything');
});

test('a token with a default needs nothing from the caller', async () => {
    const { store, api, host, executed } = createFixtures();
    await saveClaudeButton(store, {
        executionText: 'Review $Target$.',
        userTokens: [{ token: '$Target$', label: 'Target', dataType: 'String', defaultValue: 'the router', required: true }]
    });

    assert.equal((await api.runButton(store, { id: 'claude-1' }, host)).success, true);
    assert.equal(executed.length, 1);
});

test('runButton runs a warn-before-execution button and says the confirmation was skipped', async () => {
    const { store, api, host, executed } = createFixtures();
    await saveClaudeButton(store, { warnBeforeExecution: true });

    const result = await api.runButton(store, { id: 'claude-1' }, host) as ApiResult<{ notes?: string[] }>;

    assert.equal(result.success, true);
    assert.equal(executed.length, 1);
    assert.ok(result.data?.notes?.some(note => /Warn Before Execution was skipped/.test(note)));
});

test('runButton rejects input that is not an object', async () => {
    const { store, api, host } = createFixtures();

    assert.equal((await api.runButton(store, 'claude-1', host)).success, false);
    assert.equal((await api.runButton(store, null, host)).success, false);
    assert.equal((await api.runButton(store, ['claude-1'], host)).success, false);
});

test('the setting is checked before the button is even looked up', async () => {
    const { store, api, host } = createFixtures({ allowed: false });

    const result = await api.runButton(store, { id: 'does-not-exist' }, host);

    assert.match(result.errors![0], /disabled/,
        'A disabled bridge should not leak whether a button exists.');
});
