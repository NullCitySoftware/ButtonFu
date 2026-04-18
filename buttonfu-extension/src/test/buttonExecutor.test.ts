import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDefaultButton } from '../types';
import { createFakeVscodeHarness, loadWithPatchedVscode } from './helpers/fakeVscode';

function createExecutorContext(overrides: Record<string, unknown> = {}) {
    const harness = createFakeVscodeHarness();
    const modulePath = path.resolve(__dirname, '..', 'buttonExecutor.js');
    const executorModule = loadWithPatchedVscode<{ ButtonExecutor: new () => any }>(modulePath, harness.vscode, overrides);
    const executor = new executorModule.ButtonExecutor();
    return { harness, executor };
}

test('execute palette action passes parsed JSON arguments to the command', async () => {
    const { harness, executor } = createExecutorContext();
    const button = createDefaultButton('Global');
    button.type = 'PaletteAction';
    button.executionText = 'workbench.action.files.save|{"force":true}';

    await executor.execute(button);

    assert.deepEqual(harness.executedCommands.at(-1), {
        command: 'workbench.action.files.save',
        args: [{ force: true }]
    });
    assert.equal(harness.warningMessages.length, 0);
});

test('execute palette action warns and falls back when JSON arguments are invalid', async () => {
    const { harness, executor } = createExecutorContext();
    const button = createDefaultButton('Global');
    button.type = 'PaletteAction';
    button.executionText = 'workbench.action.files.save|{invalid-json}';

    await executor.execute(button);

    assert.deepEqual(harness.executedCommands.at(-1), {
        command: 'workbench.action.files.save',
        args: []
    });
    assert.equal(
        harness.warningMessages.at(-1),
        'ButtonFu: Invalid JSON arguments for command "workbench.action.files.save". Executing without arguments.'
    );
});

test('execute task starts the matching VS Code task and shows a status message', async () => {
    const { harness, executor } = createExecutorContext();
    harness.setTasks([
        {
            name: 'Build Workspace',
            source: 'workspace'
        }
    ]);

    const button = createDefaultButton('Global');
    button.type = 'TaskExecution';
    button.executionText = 'Build Workspace';

    await executor.execute(button);

    assert.equal(harness.executedTasks.length, 1);
    assert.deepEqual(harness.executedTasks[0], { name: 'Build Workspace', source: 'workspace' });
    assert.match(harness.statusBarMessages.at(-1)?.text || '', /starting task "Build Workspace"/);
    assert.equal(harness.errorMessages.length, 0);
});

test('execute task shows Drive.NET smoke prerequisite guidance before launching the task', async () => {
    const { harness, executor } = createExecutorContext();
    harness.setTasks([
        {
            name: 'Drive.NET: manifest smoke - buttonfu-extension',
            source: 'workspace'
        }
    ]);

    const button = createDefaultButton('Local');
    button.type = 'TaskExecution';
    button.executionText = 'Drive.NET: manifest smoke - buttonfu-extension';

    await executor.execute(button);

    assert.equal(harness.executedTasks.length, 1);
    assert.equal(
        harness.informationMessages.at(-1),
        'ButtonFu: starting Drive.NET smoke tests. This requires the "Run ButtonFu Extension (Isolated Smoke Test)" Extension Development Host to already be running.'
    );
});

test('captureSystemTokens resolves GitBranch for git worktree checkouts', () => {
    const { harness, executor } = createExecutorContext();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buttonfu-button-worktree-'));
    const worktreePath = path.join(root, 'checkout');
    const worktreeGitDir = path.join(root, 'repo', '.git', 'worktrees', 'feature');

    fs.mkdirSync(worktreePath, { recursive: true });
    fs.mkdirSync(worktreeGitDir, { recursive: true });
    fs.writeFileSync(path.join(worktreePath, '.git'), 'gitdir: ../repo/.git/worktrees/feature\n');
    fs.writeFileSync(path.join(worktreeGitDir, 'HEAD'), 'ref: refs/heads/feature/button-flow\n');

    harness.setWorkspaceFolders([{ name: 'Worktree', fsPath: worktreePath }], { fireEvent: false });

    try {
        const button = createDefaultButton('Global');
        button.name = 'Worktree Button';

        const snapshot = executor.captureSystemTokens(button);
        assert.equal(snapshot['$gitbranch$'], 'feature/button-flow');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('captureSystemTokens skips GitBranch filesystem fallback in untrusted workspaces', () => {
    const { harness, executor } = createExecutorContext();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buttonfu-button-untrusted-'));
    const worktreePath = path.join(root, 'checkout');
    const worktreeGitDir = path.join(root, 'repo', '.git', 'worktrees', 'feature');

    fs.mkdirSync(worktreePath, { recursive: true });
    fs.mkdirSync(worktreeGitDir, { recursive: true });
    fs.writeFileSync(path.join(worktreePath, '.git'), 'gitdir: ../repo/.git/worktrees/feature\n');
    fs.writeFileSync(path.join(worktreeGitDir, 'HEAD'), 'ref: refs/heads/feature/button-flow\n');

    harness.setWorkspaceFolders([{ name: 'Worktree', fsPath: worktreePath }], { fireEvent: false });
    harness.setWorkspaceTrust(false);

    try {
        const button = createDefaultButton('Global');
        button.name = 'Worktree Button';

        const snapshot = executor.captureSystemTokens(button);
        assert.equal(snapshot['$gitbranch$'], '');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('captureSystemTokens ignores unsupported gitdir redirects', () => {
    const { harness, executor } = createExecutorContext();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buttonfu-button-gitdir-'));
    const workspacePath = path.join(root, 'workspace');
    const outsidePath = path.join(root, 'outside');

    fs.mkdirSync(workspacePath, { recursive: true });
    fs.mkdirSync(outsidePath, { recursive: true });
    fs.writeFileSync(path.join(workspacePath, '.git'), 'gitdir: ../outside\n');
    fs.writeFileSync(path.join(outsidePath, 'HEAD'), 'ref: refs/heads/private-data\n');

    harness.setWorkspaceFolders([{ name: 'Workspace', fsPath: workspacePath }], { fireEvent: false });

    try {
        const button = createDefaultButton('Global');
        button.name = 'Workspace Button';

        const snapshot = executor.captureSystemTokens(button);
        assert.equal(snapshot['$gitbranch$'], '');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('captureSystemTokens ignores symlinked git HEAD files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buttonfu-button-headlink-'));
    const workspacePath = path.join(root, 'workspace');
    const gitPath = path.join(workspacePath, '.git');
    const headFile = path.join(gitPath, 'HEAD');

    fs.mkdirSync(gitPath, { recursive: true });
    fs.writeFileSync(headFile, 'ref: refs/heads/main\n');

    const realFs = fs;
    const mockedFs = {
        ...realFs,
        lstatSync: (targetPath: fs.PathLike, options?: fs.StatOptions & { bigint?: false | undefined }) => {
            const stats = realFs.lstatSync(targetPath, options as any);
            if (path.resolve(String(targetPath)) !== path.resolve(headFile)) {
                return stats;
            }

            return {
                ...stats,
                isFile: () => false,
                isSymbolicLink: () => true
            };
        }
    };

    const { harness, executor } = createExecutorContext({ fs: mockedFs });
    harness.setWorkspaceFolders([{ name: 'Workspace', fsPath: workspacePath }], { fireEvent: false });

    try {
        const button = createDefaultButton('Global');
        button.name = 'Workspace Button';

        const snapshot = executor.captureSystemTokens(button);
        assert.equal(snapshot['$gitbranch$'], '');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});