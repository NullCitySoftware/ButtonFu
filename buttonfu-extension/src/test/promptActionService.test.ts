import assert = require('node:assert/strict');
import fs = require('fs');
import os = require('os');
import path = require('path');
import test = require('node:test');
import { createFakeVscodeHarness, loadWithPatchedVscode } from './helpers/fakeVscode';

function createPromptContext() {
    const harness = createFakeVscodeHarness();
    // Register a no-op chat focus command so sendToCopilot's focus gate passes.
    harness.setExternalCommandHandler('workbench.panel.chat.view.copilot.focus', () => undefined);
    const modulePath = path.resolve(__dirname, '..', 'promptActionService.js');
    const promptModule = loadWithPatchedVscode<{ PromptActionService: new () => any }>(modulePath, harness.vscode);
    const service = new promptModule.PromptActionService();
    return { harness, service };
}

function createWorktreeFixture(branchName: string): { root: string; worktreePath: string; cleanup(): void } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buttonfu-worktree-'));
    const worktreePath = path.join(root, 'checkout');
    const worktreeGitDir = path.join(root, 'repo', '.git', 'worktrees', 'feature');

    fs.mkdirSync(worktreePath, { recursive: true });
    fs.mkdirSync(worktreeGitDir, { recursive: true });
    fs.writeFileSync(path.join(worktreePath, '.git'), 'gitdir: ../repo/.git/worktrees/feature\n');
    fs.writeFileSync(path.join(worktreeGitDir, 'HEAD'), `ref: refs/heads/${branchName}\n`);

    return {
        root,
        worktreePath,
        cleanup(): void {
            fs.rmSync(root, { recursive: true, force: true });
        }
    };
}

test('sendToCopilot restores the clipboard after a successful send', async () => {
    const { harness, service } = createPromptContext();
    harness.setClipboardText('original clipboard');

    await service.sendToCopilot({ prompt: 'updated prompt' });

    assert.equal(await harness.vscode.env.clipboard.readText(), 'original clipboard');
    assert.deepEqual(harness.clipboardWrites.slice(-2), ['updated prompt', 'original clipboard']);
    assert.deepEqual(harness.warningMessages, []);
});

test('sendToCopilot leaves the prompt on the clipboard when submission fails', async () => {
    const { harness, service } = createPromptContext();
    harness.setClipboardText('original clipboard');
    harness.setExternalCommandHandler('workbench.action.chat.submit', () => {
        throw new Error('submit failed');
    });
    const originalConsoleError = console.error;
    console.error = () => undefined;

    try {
        await service.sendToCopilot({ prompt: 'fallback prompt' });
    } finally {
        console.error = originalConsoleError;
    }

    assert.equal(await harness.vscode.env.clipboard.readText(), 'fallback prompt');
    assert.equal(harness.warningMessages[0], 'Could not automatically send to Copilot Chat. Prompt copied to clipboard.');
    assert.equal(harness.clipboardWrites[harness.clipboardWrites.length - 1], 'fallback prompt');
});

test('sendToCopilot aborts early when no chat focus command is available', async () => {
    const harness = createFakeVscodeHarness();
    // Do NOT register the focus command — simulates Copilot Chat unavailable.
    const modulePath = path.resolve(__dirname, '..', 'promptActionService.js');
    const promptModule = loadWithPatchedVscode<{ PromptActionService: new () => any }>(modulePath, harness.vscode);
    const service = new promptModule.PromptActionService();
    harness.setClipboardText('original clipboard');

    await service.sendToCopilot({ prompt: 'orphan prompt' });

    assert.equal(await harness.vscode.env.clipboard.readText(), 'orphan prompt');
    assert.equal(harness.warningMessages[0], 'Could not open Copilot Chat. Prompt copied to clipboard.');
});

test('sendToCopilot resolves workspace-prefixed attachments across multiple roots', async () => {
    const { harness, service } = createPromptContext();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buttonfu-attachments-'));
    const appRoot = path.join(root, 'app');
    const docsRoot = path.join(root, 'docs');
    const attachedFile = path.join(docsRoot, 'guides', 'note.md');
    const attachedPaths: string[] = [];

    fs.mkdirSync(path.dirname(attachedFile), { recursive: true });
    fs.writeFileSync(attachedFile, '# Attached');

    harness.setWorkspaceFolders([
        { name: 'App', fsPath: appRoot },
        { name: 'DocsSpace', fsPath: docsRoot }
    ]);
    harness.setExternalCommandHandler('workbench.action.chat.attachFile', (uri: { fsPath: string }) => {
        attachedPaths.push(uri.fsPath);
    });

    try {
        await service.sendToCopilot({
            prompt: 'attach docs',
            attachFiles: [path.join('DocsSpace', 'guides', 'note.md')]
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }

    assert.deepEqual(attachedPaths, [attachedFile]);
});

test('captureSystemTokens resolves GitBranch from worktree HEAD files', () => {
    const { harness, service } = createPromptContext();
    const fixture = createWorktreeFixture('feature/worktree');

    harness.setWorkspaceFolders([{ name: 'Worktree', fsPath: fixture.worktreePath }], { fireEvent: false });

    try {
        const snapshot = service.captureSystemTokens();
        assert.equal(snapshot['$gitbranch$'], 'feature/worktree');
    } finally {
        fixture.cleanup();
    }
});