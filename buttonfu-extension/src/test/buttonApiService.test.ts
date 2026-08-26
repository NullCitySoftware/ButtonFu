import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import type { ApiResult } from '../types';
import type { ButtonConfig } from '../types';
import { createFakeVscodeHarness, loadWithPatchedVscode } from './helpers/fakeVscode';

function createFixtures() {
    const harness = createFakeVscodeHarness();

    const storePath = path.resolve(__dirname, '..', 'buttonStore.js');
    const storeModule = loadWithPatchedVscode<{ ButtonStore: new (context: any) => any }>(storePath, harness.vscode);
    const context = harness.createExtensionContext();
    const store = new storeModule.ButtonStore(context);

    const apiPath = path.resolve(__dirname, '..', 'buttonApiService.js');
    const api = loadWithPatchedVscode<typeof import('../buttonApiService')>(apiPath, harness.vscode);

    return { harness, store, api };
}

// ---------------------------------------------------------------------------
// createButton
// ---------------------------------------------------------------------------

test('createButton succeeds with minimal required fields', async () => {
    const { store, api } = createFixtures();

    const result = await api.createButton(store, { name: 'Build Widgets', locality: 'Global' }) as ApiResult<ButtonConfig>;

    assert.equal(result.success, true);
    assert.equal(result.data?.name, 'Build Widgets');
    assert.equal(result.data?.locality, 'Global');
    assert.equal(result.data?.type, 'TerminalCommand');
    assert.equal(result.data?.createdBy, 'Agent');
    assert.equal(result.data?.lastModifiedBy, 'Agent');
    assert.equal(result.data?.source, 'Agent');
    assert.ok(result.data?.id);
    assert.equal(store.getButton(result.data!.id)?.name, 'Build Widgets');
});

test('createButton merges optional fields with defaults', async () => {
    const { store, api } = createFixtures();

    const result = await api.createButton(store, {
        name: 'Deploy',
        locality: 'Local',
        type: 'CopilotCommand',
        icon: 'rocket',
        category: 'DevOps'
    }) as ApiResult<ButtonConfig>;

    assert.equal(result.success, true);
    assert.equal(result.data?.type, 'CopilotCommand');
    assert.equal(result.data?.icon, 'rocket');
    assert.equal(result.data?.category, 'DevOps');
});

test('createButton rejects missing name', async () => {
    const { store, api } = createFixtures();

    const result = await api.createButton(store, { locality: 'Global' }) as ApiResult<ButtonConfig>;

    assert.equal(result.success, false);
    assert.ok(result.errors?.some((e: string) => e.includes('name')));
});

test('createButton rejects invalid locality', async () => {
    const { store, api } = createFixtures();

    const result = await api.createButton(store, { name: 'Test', locality: 'Nowhere' }) as ApiResult<ButtonConfig>;

    assert.equal(result.success, false);
    assert.ok(result.errors?.some((e: string) => e.includes('locality')));
});

test('createButton rejects invalid type', async () => {
    const { store, api } = createFixtures();

    const result = await api.createButton(store, { name: 'Test', locality: 'Global', type: 'FlyingCarpet' }) as ApiResult<ButtonConfig>;

    assert.equal(result.success, false);
    assert.ok(result.errors?.some((e: string) => e.includes('type')));
});

test('createButton rejects null input', async () => {
    const { store, api } = createFixtures();

    const result = await api.createButton(store, null) as ApiResult<ButtonConfig>;

    assert.equal(result.success, false);
});

test('createButton batch creates multiple buttons', async () => {
    const { store, api } = createFixtures();

    const result = await api.createButton(store, [
        { name: 'Alpha', locality: 'Global' },
        { name: 'Bravo', locality: 'Local' }
    ]);

    assert.ok(Array.isArray(result));
    assert.equal(result.length, 2);
    assert.equal(result[0].success, true);
    assert.equal(result[1].success, true);
    assert.equal(store.getAllButtons().length, 2);
});

test('createButton batch returns per-item errors', async () => {
    const { store, api } = createFixtures();

    const result = await api.createButton(store, [
        { name: 'Good', locality: 'Global' },
        { locality: 'Global' } // missing name
    ]);

    assert.ok(Array.isArray(result));
    assert.equal(result[0].success, true);
    assert.equal(result[1].success, false);
    assert.equal(store.getAllButtons().length, 1);
});

test('createButton strips openEditor from persisted data', async () => {
    const { store, api } = createFixtures();

    const result = await api.createButton(store, {
        name: 'Fancy',
        locality: 'Global',
        openEditor: true
    }) as ApiResult<ButtonConfig>;

    assert.equal(result.success, true);
    const saved = store.getButton(result.data!.id);
    assert.equal((saved as any).openEditor, undefined);
});

test('createButton ignores unexpected fields from API input', async () => {
    const { store, api } = createFixtures();

    const result = await api.createButton(store, {
        name: 'Allowlisted Only',
        locality: 'Global',
        unexpectedField: 'should-not-persist'
    }) as ApiResult<ButtonConfig>;

    assert.equal(result.success, true);
    const saved = store.getButton(result.data!.id) as ButtonConfig & { unexpectedField?: string };
    assert.equal(saved.unexpectedField, undefined);
    assert.equal((result.data as ButtonConfig & { unexpectedField?: string }).unexpectedField, undefined);
});

// ---------------------------------------------------------------------------
// getButton
// ---------------------------------------------------------------------------

test('getButton returns existing button', async () => {
    const { store, api } = createFixtures();
    const created = await api.createButton(store, { name: 'Finder', locality: 'Global' }) as ApiResult<ButtonConfig>;
    assert.equal(created.success, true);

    const result = api.getButton(store, created.data!.id);

    assert.equal(result.success, true);
    assert.equal(result.data?.name, 'Finder');
});

test('getButton accepts object with id field', async () => {
    const { store, api } = createFixtures();
    const created = await api.createButton(store, { name: 'Obj', locality: 'Global' }) as ApiResult<ButtonConfig>;

    const result = api.getButton(store, { id: created.data!.id });

    assert.equal(result.success, true);
});

test('getButton returns error for missing id', () => {
    const { store, api } = createFixtures();

    const result = api.getButton(store, undefined);

    assert.equal(result.success, false);
});

test('getButton returns error for unknown id', () => {
    const { store, api } = createFixtures();

    const result = api.getButton(store, 'nonexistent-uuid');

    assert.equal(result.success, false);
});

// ---------------------------------------------------------------------------
// listButtons
// ---------------------------------------------------------------------------

test('listButtons returns all buttons', async () => {
    const { store, api } = createFixtures();
    await api.createButton(store, { name: 'G1', locality: 'Global' }) as ApiResult<ButtonConfig>;
    await api.createButton(store, { name: 'L1', locality: 'Local' }) as ApiResult<ButtonConfig>;

    const result = api.listButtons(store);

    assert.equal(result.success, true);
    assert.equal(result.data?.length, 2);
});

test('listButtons filters by locality', async () => {
    const { store, api } = createFixtures();
    await api.createButton(store, { name: 'G1', locality: 'Global' }) as ApiResult<ButtonConfig>;
    await api.createButton(store, { name: 'L1', locality: 'Local' }) as ApiResult<ButtonConfig>;

    const globalOnly = api.listButtons(store, { locality: 'Global' });
    assert.equal(globalOnly.data?.length, 1);
    assert.equal(globalOnly.data?.[0].locality, 'Global');

    const localOnly = api.listButtons(store, { locality: 'Local' });
    assert.equal(localOnly.data?.length, 1);
    assert.equal(localOnly.data?.[0].locality, 'Local');
});

// ---------------------------------------------------------------------------
// updateButton
// ---------------------------------------------------------------------------

test('updateButton patches existing button', async () => {
    const { store, api } = createFixtures();
    const created = await api.createButton(store, { name: 'Original', locality: 'Global' }) as ApiResult<ButtonConfig>;

    const result = await api.updateButton(store, { id: created.data!.id, name: 'Renamed' });

    assert.equal(result.success, true);
    assert.equal(result.data?.name, 'Renamed');
    assert.equal(result.data?.locality, 'Global');
    assert.equal(result.data?.createdBy, 'Agent');
    assert.equal(result.data?.lastModifiedBy, 'Agent');
    assert.equal(result.data?.source, 'Agent');
});

test('updateButton rejects missing id', async () => {
    const { store, api } = createFixtures();

    const result = await api.updateButton(store, { name: 'Orphan' });

    assert.equal(result.success, false);
});

test('updateButton rejects nonexistent button', async () => {
    const { store, api } = createFixtures();

    const result = await api.updateButton(store, { id: 'ghost-uuid', name: 'Phantom' });

    assert.equal(result.success, false);
});

test('updateButton rejects invalid type', async () => {
    const { store, api } = createFixtures();
    const created = await api.createButton(store, { name: 'Typed', locality: 'Global' }) as ApiResult<ButtonConfig>;

    const result = await api.updateButton(store, { id: created.data!.id, type: 'Catapult' });

    assert.equal(result.success, false);
});

test('updateButton can move a button across scopes without leaving a duplicate', async () => {
    const { store, api } = createFixtures();
    const created = await api.createButton(store, { name: 'Traveler', locality: 'Global' }) as ApiResult<ButtonConfig>;

    const result = await api.updateButton(store, { id: created.data!.id, locality: 'Local' });

    assert.equal(result.success, true);
    assert.equal(store.getGlobalButtons().length, 0);
    assert.equal(store.getLocalButtons().length, 1);
    assert.equal(store.getLocalButtons()[0]?.id, created.data!.id);
});

test('updateButton upgrades a user-created button to AgentAndUser', async () => {
    const { store, api } = createFixtures();

    await store.saveButton({
        id: 'user-button',
        name: 'User Button',
        locality: 'Global',
        description: '',
        type: 'TerminalCommand',
        executionText: 'echo user',
        category: 'General',
        icon: 'play',
        colour: '',
        copilotModel: '',
        copilotMode: 'agent',
        copilotAttachFiles: [],
        copilotAttachActiveFile: false,
        warnBeforeExecution: false,
        userTokens: []
    });

    const result = await api.updateButton(store, { id: 'user-button', name: 'Agent-touched Button' });

    assert.equal(result.success, true);
    assert.equal(result.data?.createdBy, 'User');
    assert.equal(result.data?.lastModifiedBy, 'Agent');
    assert.equal(result.data?.source, 'AgentAndUser');
});

test('updateButton ignores unexpected fields from API input', async () => {
    const { store, api } = createFixtures();
    const created = await api.createButton(store, { name: 'Original', locality: 'Global' }) as ApiResult<ButtonConfig>;

    const result = await api.updateButton(store, {
        id: created.data!.id,
        name: 'Still Clean',
        unexpectedField: 'should-not-persist'
    });

    assert.equal(result.success, true);
    const saved = store.getButton(created.data!.id) as ButtonConfig & { unexpectedField?: string };
    assert.equal(saved.unexpectedField, undefined);
    assert.equal((result.data as ButtonConfig & { unexpectedField?: string }).unexpectedField, undefined);
});

// ---------------------------------------------------------------------------
// deleteButton
// ---------------------------------------------------------------------------

test('deleteButton removes existing button', async () => {
    const { store, api } = createFixtures();
    const created = await api.createButton(store, { name: 'Doomed', locality: 'Global' }) as ApiResult<ButtonConfig>;

    const result = await api.deleteButton(store, created.data!.id) as ApiResult<{ id: string }>;

    assert.equal(result.success, true);
    assert.equal(store.getButton(created.data!.id), undefined);
});

test('deleteButton accepts object with id', async () => {
    const { store, api } = createFixtures();
    const created = await api.createButton(store, { name: 'Also Doomed', locality: 'Local' }) as ApiResult<ButtonConfig>;

    const result = await api.deleteButton(store, { id: created.data!.id }) as ApiResult<{ id: string }>;

    assert.equal(result.success, true);
});

test('deleteButton batch removes multiple', async () => {
    const { store, api } = createFixtures();
    const a = await api.createButton(store, { name: 'A', locality: 'Global' }) as ApiResult<ButtonConfig>;
    const b = await api.createButton(store, { name: 'B', locality: 'Global' }) as ApiResult<ButtonConfig>;

    const result = await api.deleteButton(store, [a.data!.id, b.data!.id]);

    assert.ok(Array.isArray(result));
    assert.equal(result.length, 2);
    assert.equal(result[0].success, true);
    assert.equal(result[1].success, true);
    assert.equal(store.getAllButtons().length, 0);
});

test('deleteButton returns error for unknown id', async () => {
    const { store, api } = createFixtures();

    const result = await api.deleteButton(store, 'phantom-id') as ApiResult<{ id: string }>;

    assert.equal(result.success, false);
});


// ---------------------------------------------------------------------------
// Workspace buttons (read-only settings source)
// ---------------------------------------------------------------------------

test('listButtons supports the Workspace locality filter', async () => {
    const { harness, store, api } = createFixtures();

    await harness.vscode.workspace.getConfiguration('buttonfu').update('workspaceButtons', [
        { name: 'Repo Button', executionText: 'echo repo' }
    ]);
    await api.createButton(store, { name: 'User Button', locality: 'Global' });

    const workspaceOnly = api.listButtons(store, { locality: 'Workspace' });
    assert.equal(workspaceOnly.success, true);
    assert.equal(workspaceOnly.data?.length, 1);
    assert.equal(workspaceOnly.data?.[0].name, 'Repo Button');
    assert.equal(workspaceOnly.data?.[0].locality, 'Workspace');

    const all = api.listButtons(store);
    assert.equal(all.data?.length, 2);
});

test('updateButton and deleteButton reject read-only workspace buttons', async () => {
    const { harness, store, api } = createFixtures();

    await harness.vscode.workspace.getConfiguration('buttonfu').update('workspaceButtons', [
        { name: 'Repo Button', executionText: 'echo repo' }
    ]);
    const wsId = store.getWorkspaceButtons()[0].id;

    const updateResult = await api.updateButton(store, { id: wsId, name: 'Renamed' });
    assert.equal(updateResult.success, false);
    assert.match(updateResult.errors?.[0] ?? '', /read-only/);

    const deleteResult = await api.deleteButton(store, wsId) as ApiResult<{ id: string }>;
    assert.equal(deleteResult.success, false);
    assert.match(deleteResult.errors?.[0] ?? '', /read-only/);

    assert.equal(store.getWorkspaceButtons().length, 1);
    assert.equal(store.getWorkspaceButtons()[0].name, 'Repo Button');
});

// ---------------------------------------------------------------------------
// ClaudeCommand fields
// ---------------------------------------------------------------------------

test('createButton accepts a ClaudeCommand button with every claude field', async () => {
    const { store, api } = createFixtures();

    const result = await api.createButton(store, {
        name: 'Plan this repo',
        locality: 'Global',
        type: 'ClaudeCommand',
        executionText: 'Read AGENTS.md and summarise what this repo does.',
        claudeDestination: 'terminalNewWindow',
        claudeModel: 'opus',
        claudeEffort: 'high',
        claudePermissionMode: 'acceptEdits',
        claudeCwd: 'C:\GIT\ButtonFu',
        claudeTargetFolder: 'C:\GIT\Kitae',
        claudeSessionName: 'repo plan',
        claudeAddDirs: ['C:\GIT\Catanari'],
        claudeWorktree: true,
        claudeWorktreeName: 'planning',
        claudeExtraArgs: ['--append-system-prompt', 'be terse'],
        claudeNewWindow: true
    }) as ApiResult<ButtonConfig>;

    assert.equal(result.success, true);
    const stored = store.getButton(result.data!.id) as ButtonConfig;
    assert.equal(stored.type, 'ClaudeCommand');
    assert.equal(stored.claudeDestination, 'terminalNewWindow');
    assert.equal(stored.claudeModel, 'opus');
    assert.equal(stored.claudeEffort, 'high');
    assert.equal(stored.claudePermissionMode, 'acceptEdits');
    assert.equal(stored.claudeCwd, 'C:\GIT\ButtonFu');
    assert.equal(stored.claudeTargetFolder, 'C:\GIT\Kitae');
    assert.equal(stored.claudeSessionName, 'repo plan');
    assert.deepEqual(stored.claudeAddDirs, ['C:\GIT\Catanari']);
    assert.equal(stored.claudeWorktree, true);
    assert.equal(stored.claudeWorktreeName, 'planning');
    assert.deepEqual(stored.claudeExtraArgs, ['--append-system-prompt', 'be terse']);
    assert.equal(stored.claudeNewWindow, true);
});

test('createButton defaults a Claude button to the panel, unattended, with empty lists', async () => {
    const { store, api } = createFixtures();

    const result = await api.createButton(store, { name: 'Bare Claude', locality: 'Global', type: 'ClaudeCommand' }) as ApiResult<ButtonConfig>;

    assert.equal(result.success, true);
    assert.equal(result.data?.claudeDestination, 'panelPrefill',
        'A new button types its prompt and waits, so a first click never sets an agent off unread.');
    assert.equal(result.data?.claudePermissionMode, 'bypassPermissions');
    assert.deepEqual(result.data?.claudeAddDirs, []);
    assert.deepEqual(result.data?.claudeExtraArgs, []);
});

test('createButton honours the default permission mode passed in', async () => {
    const { store, api } = createFixtures();

    const result = await api.createButton(store, { name: 'Careful Claude', locality: 'Global', type: 'ClaudeCommand' }, 'plan') as ApiResult<ButtonConfig>;

    assert.equal(result.data?.claudePermissionMode, 'plan');
});

test('createButton rejects an unknown claudeDestination', async () => {
    const { store, api } = createFixtures();

    const result = await api.createButton(store, {
        name: 'Bad destination', locality: 'Global', type: 'ClaudeCommand', claudeDestination: 'teleport'
    }) as ApiResult<ButtonConfig>;

    assert.equal(result.success, false);
    assert.ok(result.errors?.some(e => e.includes('claudeDestination must be one of')));
});

test('createButton rejects an unknown claudePermissionMode', async () => {
    const { store, api } = createFixtures();

    const result = await api.createButton(store, {
        name: 'Bad mode', locality: 'Global', type: 'ClaudeCommand', claudePermissionMode: 'yolo'
    }) as ApiResult<ButtonConfig>;

    assert.equal(result.success, false);
    assert.ok(result.errors?.some(e => e.includes('claudePermissionMode must be one of')));
});

test('createButton rejects claudeExtraArgs that is not an array of strings', async () => {
    const { store, api } = createFixtures();

    const result = await api.createButton(store, {
        name: 'Bad args', locality: 'Global', type: 'ClaudeCommand', claudeExtraArgs: ['--model', 7]
    }) as ApiResult<ButtonConfig>;

    assert.equal(result.success, false);
    assert.ok(result.errors?.some(e => e.includes('claudeExtraArgs must be an array of strings')));
});

test('updateButton can change a Claude destination and rejects a bad one', async () => {
    const { store, api } = createFixtures();

    const created = await api.createButton(store, { name: 'Switchable', locality: 'Global', type: 'ClaudeCommand' }) as ApiResult<ButtonConfig>;

    const good = await api.updateButton(store, { id: created.data!.id, claudeDestination: 'backgroundAgent' });
    assert.equal(good.success, true);
    assert.equal(store.getButton(created.data!.id)?.claudeDestination, 'backgroundAgent');

    const bad = await api.updateButton(store, { id: created.data!.id, claudeDestination: 'nowhere' });
    assert.equal(bad.success, false);
    assert.equal(store.getButton(created.data!.id)?.claudeDestination, 'backgroundAgent');
});
