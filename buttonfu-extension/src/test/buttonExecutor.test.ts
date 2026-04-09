import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDefaultButton } from '../types';
import { createFakeVscodeHarness, loadWithPatchedVscode } from './helpers/fakeVscode';

function createExecutorContext() {
    const harness = createFakeVscodeHarness();
    const modulePath = path.resolve(__dirname, '..', 'buttonExecutor.js');
    const executorModule = loadWithPatchedVscode<{ ButtonExecutor: new () => any }>(modulePath, harness.vscode);
    const executor = new executorModule.ButtonExecutor();
    return { harness, executor };
}

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