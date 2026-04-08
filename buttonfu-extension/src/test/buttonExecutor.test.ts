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