import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createFakeVscodeHarness, loadWithPatchedVscode } from './helpers/fakeVscode';

function loadView(harness: ReturnType<typeof createFakeVscodeHarness>) {
    const modulePath = path.resolve(__dirname, '..', 'claudeAgentsView.js');
    return loadWithPatchedVscode<typeof import('../claudeAgentsView')>(modulePath, harness.vscode);
}

const AGENTS_JSON = JSON.stringify([
    {
        sessionId: '11111111-1111-1111-1111-111111111111',
        name: 'Repo plan',
        state: 'running',
        cwd: 'C:\\GIT\\ButtonFu',
        startedAt: '2026-08-26T12:00:00.000Z'
    },
    {
        sessionId: '22222222-2222-2222-2222-222222222222',
        name: '',
        state: 'idle',
        cwd: 'C:\\GIT\\Kitae',
        prompt: 'Summarise the engine\nand list its modules'
    }
]);

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test('parseAgents reads a plain array and an object wrapping one', () => {
    const { parseAgents } = loadView(createFakeVscodeHarness());

    assert.equal(parseAgents(AGENTS_JSON).length, 2);
    assert.equal(parseAgents(JSON.stringify({ agents: JSON.parse(AGENTS_JSON) })).length, 2);
});

test('parseAgents accepts the alternative field names the CLI may use', () => {
    const { parseAgents } = loadView(createFakeVscodeHarness());

    const agents = parseAgents(JSON.stringify([
        { session_id: 'a', status: 'running', workingDirectory: 'C:\\one' },
        { id: 'b', state: 'idle', cwd: 'C:\\two' }
    ]));

    assert.deepEqual(agents.map(agent => agent.sessionId), ['a', 'b']);
    assert.equal(agents[0].state, 'running');
    assert.equal(agents[0].cwd, 'C:\\one');
});

test('parseAgents returns nothing for empty output and drops rows with no session id', () => {
    const { parseAgents } = loadView(createFakeVscodeHarness());

    assert.deepEqual(parseAgents(''), []);
    assert.deepEqual(parseAgents('   \n'), []);
    assert.deepEqual(parseAgents('[]'), []);
    assert.deepEqual(parseAgents(JSON.stringify([{ state: 'running' }, null, 'nonsense'])), []);
});

test('parseAgents throws on output that is not JSON, so the caller can say what went wrong', () => {
    const { parseAgents } = loadView(createFakeVscodeHarness());

    assert.throws(() => parseAgents('claude: command not found'));
});

test('describeAgent prefers the name, then the first prompt line, then the id', () => {
    const { describeAgent } = loadView(createFakeVscodeHarness());

    assert.equal(describeAgent({ sessionId: 'x', name: 'Repo plan', state: 'running', cwd: '' }), 'Repo plan');
    assert.equal(describeAgent({ sessionId: 'x', name: '  ', state: 'running', cwd: '', prompt: 'One\nTwo' }), 'One');
    assert.equal(describeAgent({ sessionId: 'x', name: '', state: 'running', cwd: '' }), 'x');
});

test('describeAge renders a duration, and nothing when there is no start time', () => {
    const { describeAge } = loadView(createFakeVscodeHarness());
    const now = Date.parse('2026-08-26T12:00:00.000Z');
    const at = (iso: string) => describeAge({ sessionId: 'x', name: '', state: '', cwd: '', startedAt: iso }, now);

    assert.equal(at('2026-08-26T11:59:50.000Z'), 'just now');
    assert.equal(at('2026-08-26T11:45:00.000Z'), '15 min ago');
    assert.equal(at('2026-08-26T09:00:00.000Z'), '3 h ago');
    assert.equal(at('2026-08-24T12:00:00.000Z'), '2 d ago');
    assert.equal(at('not a date'), '');
    assert.equal(describeAge({ sessionId: 'x', name: '', state: '', cwd: '' }, now), '');
});

test('buildAgentItems puts the state and age in the description and the folder in the detail', () => {
    const { buildAgentItems, parseAgents } = loadView(createFakeVscodeHarness());
    const now = Date.parse('2026-08-26T12:30:00.000Z');

    const items = buildAgentItems(parseAgents(AGENTS_JSON), now);

    assert.equal(items[0].label, 'Repo plan');
    assert.equal(items[0].description, 'running · 30 min ago');
    assert.equal(items[0].detail, 'C:\\GIT\\ButtonFu');
    assert.equal(items[1].label, 'Summarise the engine');
    assert.equal(items[1].description, 'idle');
});

// ---------------------------------------------------------------------------
// The quick pick
// ---------------------------------------------------------------------------

function createHost(harness: ReturnType<typeof createFakeVscodeHarness>, overrides: Record<string, unknown> = {}) {
    const resumed: unknown[] = [];
    const runs: Array<{ exe: string; args: string[]; cwd: string }> = [];
    const host: any = {
        resolveExecutable: () => 'C:\\bin\\claude.exe',
        cwd: () => 'C:\\GIT\\ButtonFu',
        run: async (exe: string, args: string[], cwd: string) => {
            runs.push({ exe, args, cwd });
            return AGENTS_JSON;
        },
        resumeInTerminal: async (agent: unknown) => { resumed.push(agent); },
        ...overrides
    };
    return { host, resumed, runs, harness };
}

test('showBackgroundAgents lists the sessions and resumes the one that is picked', async () => {
    const harness = createFakeVscodeHarness();
    const { showBackgroundAgents } = loadView(harness);
    const { host, resumed, runs } = createHost(harness);

    harness.queueQuickPickResult(undefined);  // replaced below
    await showBackgroundAgents(host);

    assert.deepEqual(runs[0].args, ['agents', '--json']);
    assert.equal(runs[0].cwd, 'C:\\GIT\\ButtonFu');
    assert.equal(resumed.length, 0, 'Dismissing the picker must do nothing.');
});

test('picking a session and choosing to resume reaches the terminal helper', async () => {
    const harness = createFakeVscodeHarness();
    const { showBackgroundAgents, buildAgentItems, parseAgents } = loadView(harness);
    const { host, resumed } = createHost(harness);

    harness.queueQuickPickResult(buildAgentItems(parseAgents(AGENTS_JSON))[0]);
    harness.queueQuickPickResult('Resume in a terminal');
    await showBackgroundAgents(host);

    assert.equal(resumed.length, 1);
    assert.equal((resumed[0] as any).sessionId, '11111111-1111-1111-1111-111111111111');
});

test('showBackgroundAgents says so when nothing is running', async () => {
    const harness = createFakeVscodeHarness();
    const { showBackgroundAgents } = loadView(harness);
    const { host } = createHost(harness, { run: async () => '[]' });

    await showBackgroundAgents(host);

    assert.equal(harness.informationMessages.length, 1);
    assert.match(harness.informationMessages[0], /No Claude background agents/);
    assert.equal(harness.quickPickCalls.length, 0);
});

test('showBackgroundAgents reports a missing executable and runs nothing', async () => {
    const harness = createFakeVscodeHarness();
    const { showBackgroundAgents } = loadView(harness);
    const { host, runs } = createHost(harness, { resolveExecutable: () => undefined });

    await showBackgroundAgents(host);

    assert.equal(runs.length, 0);
    assert.equal(harness.errorMessages.length, 1);
    assert.match(harness.errorMessages[0], /buttonfu\.claude\.executablePath/);
});

test('showBackgroundAgents turns malformed output into one message rather than throwing', async () => {
    const harness = createFakeVscodeHarness();
    const { showBackgroundAgents } = loadView(harness);
    const { host } = createHost(harness, { run: async () => 'not json at all' });

    await showBackgroundAgents(host);

    assert.equal(harness.errorMessages.length, 1);
    assert.match(harness.errorMessages[0], /could not list/);
});

test('showBackgroundAgents turns a failing CLI into one message rather than throwing', async () => {
    const harness = createFakeVscodeHarness();
    const { showBackgroundAgents } = loadView(harness);
    const { host } = createHost(harness, { run: async () => { throw new Error('claude exited with 1'); } });

    await showBackgroundAgents(host);

    assert.equal(harness.errorMessages.length, 1);
    assert.match(harness.errorMessages[0], /claude exited with 1/);
});
