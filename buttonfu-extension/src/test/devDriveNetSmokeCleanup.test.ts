import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import type { ApiResult, ButtonConfig, NoteConfig } from '../types';
import { createFakeVscodeHarness, loadWithPatchedVscode } from './helpers/fakeVscode';

const DEV_CLEAR_DRIVE_NET_SMOKE_COMMAND = 'buttonfu.dev.clearDriveNetSmokeData';

test('development Drive.NET smoke cleanup removes GUID-named smoke artifacts and preserves user data', async () => {
    const harness = createFakeVscodeHarness();
    const extensionModulePath = path.resolve(__dirname, '..', 'extension.js');
    const extension = loadWithPatchedVscode<{ activate(context: unknown): void }>(extensionModulePath, harness.vscode);
    const context = harness.createExtensionContext();

    extension.activate(context);

    await harness.vscode.commands.executeCommand('buttonfu.api.createButton', {
        locality: 'Global',
        name: 'f46e82b3a2eb458b86c5d6dedfcb1bdf',
        type: 'TerminalCommand',
        executionText: 'echo ButtonFu DriveNet smoke test'
    });
    await harness.vscode.commands.executeCommand('buttonfu.api.createButton', {
        locality: 'Local',
        name: '2. Smoke Tests',
        type: 'TerminalCommand',
        executionText: 'pwsh -NoProfile -ExecutionPolicy Bypass -File ./buttonfu-extension/tests/drive-net/Run-Manifest.ps1'
    });
    await harness.vscode.commands.executeCommand('buttonfu.api.createNote', {
        locality: 'Local',
        name: 'fd8f7d99-9e76-412d-a9ed-dd53b4ac206b',
        content: 'This note was created by a Drive.NET automation test.'
    });
    await harness.vscode.commands.executeCommand('buttonfu.api.createNote', {
        locality: 'Local',
        name: '3. Smoke Last Result',
        content: '# Drive.NET Smoke Result\n\n- Status: **FAIL**'
    });
    await harness.vscode.commands.executeCommand('buttonfu.api.createButton', {
        locality: 'Global',
        name: 'Keep Me',
        type: 'TerminalCommand',
        executionText: 'echo keep'
    });
    await harness.vscode.commands.executeCommand('buttonfu.api.createNote', {
        locality: 'Local',
        name: 'Keep Note',
        content: 'keep'
    });

    const cleared = await harness.vscode.commands.executeCommand(DEV_CLEAR_DRIVE_NET_SMOKE_COMMAND) as { success: boolean; cleanedIds?: string[]; };
    assert.equal(cleared.success, true);
    assert.equal(cleared.cleanedIds?.length, 4);

    const buttons = await harness.vscode.commands.executeCommand('buttonfu.api.listButtons') as ApiResult<ButtonConfig[]>;
    const notes = await harness.vscode.commands.executeCommand('buttonfu.api.listNotes') as ApiResult<NoteConfig[]>;
    assert.equal(buttons.data?.some((button) => button.name === 'f46e82b3a2eb458b86c5d6dedfcb1bdf'), false);
    assert.equal(buttons.data?.some((button) => button.name === '2. Smoke Tests'), false);
    assert.equal(notes.data?.some((note) => note.name === 'fd8f7d99-9e76-412d-a9ed-dd53b4ac206b'), false);
    assert.equal(notes.data?.some((note) => note.name === '3. Smoke Last Result'), false);
    assert.equal(buttons.data?.some((button) => button.name === 'Keep Me'), true);
    assert.equal(notes.data?.some((note) => note.name === 'Keep Note'), true);
    assert.ok(harness.informationMessages.some((message) => message.includes('Drive.NET smoke cleanup removed 4 item(s)')));
});
