import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createDefaultButton } from '../types';
import { createFakeVscodeHarness, loadWithPatchedVscode } from './helpers/fakeVscode';

function createFixtures() {
    const harness = createFakeVscodeHarness();
    const launched: any[] = [];

    // Stand in for the session service so the dispatch can be observed without starting Claude.
    const serviceStub = {
        ClaudeSessionService: class {
            async launch(button: unknown): Promise<void> { launched.push(button); }
        }
    };

    const modulePath = path.resolve(__dirname, '..', 'buttonExecutor.js');
    const executorModule = loadWithPatchedVscode<{ ButtonExecutor: new () => any }>(
        modulePath, harness.vscode, { './claudeSessionService': serviceStub });

    return { harness, executor: new executorModule.ButtonExecutor(), launched };
}

function claudeButton(overrides: Record<string, unknown> = {}) {
    const button = createDefaultButton('Global');
    button.name = 'Plan this repo';
    button.type = 'ClaudeCommand';
    button.executionText = 'Summarise $WorkspacePath$.';
    Object.assign(button, overrides);
    return button;
}

test('a ClaudeCommand button reaches the session service and nothing else', async () => {
    const { harness, executor, launched } = createFixtures();

    await executor.execute(claudeButton());

    assert.equal(launched.length, 1);
    assert.equal(launched[0].name, 'Plan this repo');
    assert.equal(harness.executedCommands.length, 0, 'No command should be executed for a Claude button.');
    assert.equal(harness.executedTasks.length, 0);
});

test('tokens are replaced in the Claude directory, name and argument fields', async () => {
    const { harness, executor, launched } = createFixtures();
    harness.setWorkspaceFolders([{ fsPath: 'C:\\GIT\\ButtonFu', name: 'ButtonFu' }]);

    const button = claudeButton({
        claudeCwd: '$WorkspacePath$',
        claudeTargetFolder: '$WorkspacePath$\\sibling',
        claudeAddDirs: ['$WorkspacePath$\\docs', 'C:\\GIT\\Kitae'],
        claudeSessionName: 'plan of $WorkspaceName$',
        claudeExtraArgs: ['--append-system-prompt', 'You are in $WorkspaceName$.']
    });

    const snapshot = executor.captureSystemTokens(button);
    await executor.executeWithTokens(button, snapshot, {});

    assert.equal(launched.length, 1);
    const sent = launched[0];
    assert.equal(sent.claudeCwd, 'C:\\GIT\\ButtonFu');
    assert.equal(sent.claudeTargetFolder, 'C:\\GIT\\ButtonFu\\sibling');
    assert.deepEqual(sent.claudeAddDirs, ['C:\\GIT\\ButtonFu\\docs', 'C:\\GIT\\Kitae']);
    assert.equal(sent.claudeSessionName, 'plan of ButtonFu');
    assert.deepEqual(sent.claudeExtraArgs, ['--append-system-prompt', 'You are in ButtonFu.']);
    assert.equal(sent.executionText, 'Summarise C:\\GIT\\ButtonFu.');
});

test('a Claude prompt is not shell-escaped on the way through', async () => {
    const { executor, launched } = createFixtures();

    const button = claudeButton({ executionText: 'Explain "quotes", $vars and `backticks` in C:\\GIT.' });
    const snapshot = executor.captureSystemTokens(button);
    await executor.executeWithTokens(button, snapshot, {});

    assert.equal(launched[0].executionText, 'Explain "quotes", $vars and `backticks` in C:\\GIT.',
        'Escaping the prompt here would leave the escape characters visible to Claude.');
});

test('a token value with shell metacharacters reaches the prompt verbatim', async () => {
    const { executor, launched } = createFixtures();

    const button = claudeButton({
        executionText: 'Review $Target$ please.',
        userTokens: [{ token: '$Target$', label: 'Target', dataType: 'String', defaultValue: '', required: true }]
    });
    const snapshot = executor.captureSystemTokens(button);
    await executor.executeWithTokens(button, snapshot, { '$target$': 'a file; rm -rf / && echo "x"' });

    assert.equal(launched[0].executionText, 'Review a file; rm -rf / && echo "x" please.');
});

test('a non-Claude button never reaches the session service', async () => {
    const { harness, executor, launched } = createFixtures();

    const button = createDefaultButton('Global');
    button.type = 'PaletteAction';
    button.executionText = 'workbench.action.files.save';
    await executor.execute(button);

    assert.equal(launched.length, 0);
    assert.equal(harness.executedCommands.at(-1)?.command, 'workbench.action.files.save');
});
