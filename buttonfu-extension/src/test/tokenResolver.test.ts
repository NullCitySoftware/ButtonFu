import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createFakeVscodeHarness, loadWithPatchedVscode } from './helpers/fakeVscode';

interface TokenResolverModule {
    findTokensInText(text: string): string[];
    replaceTokens(text: string, systemSnap: Record<string, string>, userValues: Record<string, string>): string;
    isSupportedGitHeadFile(headFile: string): boolean;
}

function loadTokenResolver(): TokenResolverModule {
    const harness = createFakeVscodeHarness();
    const modulePath = path.resolve(__dirname, '..', 'tokenResolver.js');
    return loadWithPatchedVscode<TokenResolverModule>(modulePath, harness.vscode);
}

// ---------------------------------------------------------------------------
// findTokensInText
// ---------------------------------------------------------------------------

test('findTokensInText returns empty array when no tokens are present', () => {
    const { findTokensInText } = loadTokenResolver();
    assert.deepEqual(findTokensInText('hello world'), []);
    assert.deepEqual(findTokensInText(''), []);
});

test('findTokensInText returns all tokens found in order', () => {
    const { findTokensInText } = loadTokenResolver();
    const tokens = findTokensInText('Run $Date$ — user: $Username$ done');
    assert.deepEqual(tokens, ['$Date$', '$Username$']);
});

test('findTokensInText deduplicates tokens case-insensitively, preserving first occurrence', () => {
    const { findTokensInText } = loadTokenResolver();
    const tokens = findTokensInText('$Date$ and $date$ and $DATE$');
    assert.deepEqual(tokens, ['$Date$']);
});

test('findTokensInText does not match invalid token forms', () => {
    const { findTokensInText } = loadTokenResolver();
    // Must start with a letter or underscore (not a digit)
    assert.deepEqual(findTokensInText('$123$ is not a token'), []);
    // Lone dollar signs should not match
    assert.deepEqual(findTokensInText('price is $10'), []);
});

test('findTokensInText handles mixed valid and invalid token forms', () => {
    const { findTokensInText } = loadTokenResolver();
    const tokens = findTokensInText('$ValidToken$ costs $10 today $AnotherToken$');
    assert.deepEqual(tokens, ['$ValidToken$', '$AnotherToken$']);
});

// ---------------------------------------------------------------------------
// replaceTokens
// ---------------------------------------------------------------------------

test('replaceTokens substitutes system snapshot values case-insensitively', () => {
    const { replaceTokens } = loadTokenResolver();
    const result = replaceTokens(
        'branch=$GitBranch$',
        { '$gitbranch$': 'main' },
        {}
    );
    assert.equal(result, 'branch=main');
});

test('replaceTokens substitutes user-provided values', () => {
    const { replaceTokens } = loadTokenResolver();
    const result = replaceTokens(
        'hello $MyName$',
        {},
        { '$myname$': 'World' }
    );
    assert.equal(result, 'hello World');
});

test('replaceTokens leaves unrecognised tokens untouched', () => {
    const { replaceTokens } = loadTokenResolver();
    const result = replaceTokens(
        'run $Unknown$ command',
        {},
        {}
    );
    assert.equal(result, 'run $Unknown$ command');
});

test('replaceTokens prefers system snapshot over user values for the same token', () => {
    const { replaceTokens } = loadTokenResolver();
    const result = replaceTokens(
        '$Date$',
        { '$date$': '2026-01-01' },
        { '$date$': 'overridden' }
    );
    assert.equal(result, '2026-01-01');
});

test('replaceTokens replaces all occurrences in a single pass', () => {
    const { replaceTokens } = loadTokenResolver();
    const result = replaceTokens(
        '$A$ + $A$ = $B$',
        { '$a$': '1', '$b$': '2' },
        {}
    );
    assert.equal(result, '1 + 1 = 2');
});

test('replaceTokens handles empty text without error', () => {
    const { replaceTokens } = loadTokenResolver();
    const result = replaceTokens('', { '$date$': '2026-01-01' }, {});
    assert.equal(result, '');
});

// ---------------------------------------------------------------------------
// isSupportedGitHeadFile
// ---------------------------------------------------------------------------

test('isSupportedGitHeadFile accepts a standard .git/HEAD path', () => {
    const { isSupportedGitHeadFile } = loadTokenResolver();
    const headFile = path.join('C:', 'repos', 'myproject', '.git', 'HEAD');
    assert.equal(isSupportedGitHeadFile(headFile), true);
});

test('isSupportedGitHeadFile accepts a worktree HEAD under .git/worktrees/', () => {
    const { isSupportedGitHeadFile } = loadTokenResolver();
    const headFile = path.join('C:', 'repos', 'myproject', '.git', 'worktrees', 'feature-branch', 'HEAD');
    assert.equal(isSupportedGitHeadFile(headFile), true);
});

test('isSupportedGitHeadFile accepts a submodule HEAD under .git/modules/', () => {
    const { isSupportedGitHeadFile } = loadTokenResolver();
    const headFile = path.join('C:', 'repos', 'myproject', '.git', 'modules', 'vendor', 'lib', 'HEAD');
    assert.equal(isSupportedGitHeadFile(headFile), true);
});

test('isSupportedGitHeadFile rejects a path that does not end in HEAD', () => {
    const { isSupportedGitHeadFile } = loadTokenResolver();
    const headFile = path.join('C:', 'repos', 'myproject', '.git', 'config');
    assert.equal(isSupportedGitHeadFile(headFile), false);
});

test('isSupportedGitHeadFile rejects a path traversal outside .git/', () => {
    const { isSupportedGitHeadFile } = loadTokenResolver();
    // A crafted gitdir redirect pointing outside the repo
    const headFile = path.resolve('C:', 'repos', 'myproject', '.git', '..', '..', 'etc', 'HEAD');
    assert.equal(isSupportedGitHeadFile(headFile), false);
});

test('isSupportedGitHeadFile rejects a non-.git parent directory', () => {
    const { isSupportedGitHeadFile } = loadTokenResolver();
    const headFile = path.join('C:', 'repos', 'myproject', 'not-git', 'HEAD');
    assert.equal(isSupportedGitHeadFile(headFile), false);
});
