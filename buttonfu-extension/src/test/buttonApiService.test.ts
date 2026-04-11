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
