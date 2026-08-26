import assert from 'node:assert/strict';
import * as path from 'node:path';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import {
    CLAUDE_EXTENSION_ID,
    claudeIdeLockDirectory,
    describeMissingClaude,
    findWindowIdeLock,
    resolveClaudeExecutable,
    resolveClaudeExecutableDetailed,
    type ClaudeExecutableProbes
} from '../claudeExecutable';

function probes(overrides: Partial<ClaudeExecutableProbes> = {}): ClaudeExecutableProbes {
    return {
        settingPath: () => undefined,
        pathLookup: () => undefined,
        extensionPath: () => undefined,
        fileExists: () => false,
        platform: () => 'win32',
        ...overrides
    };
}

test('the setting wins over everything else', () => {
    const resolved = resolveClaudeExecutableDetailed(probes({
        settingPath: () => 'D:\\tools\\claude.exe',
        pathLookup: () => 'C:\\npm\\claude.cmd',
        extensionPath: () => 'C:\\ext\\claude',
        fileExists: () => true
    }));

    assert.deepEqual(resolved, { path: 'D:\\tools\\claude.exe', source: 'setting' });
});

test('a blank setting is ignored and PATH is used instead', () => {
    const resolved = resolveClaudeExecutableDetailed(probes({
        settingPath: () => '   ',
        pathLookup: name => (name === 'claude' ? 'C:\\npm\\claude.cmd' : undefined)
    }));

    assert.deepEqual(resolved, { path: 'C:\\npm\\claude.cmd', source: 'path' });
});

test('the bundled extension binary is the last resort on Windows', () => {
    const expected = path.join('C:\\ext\\claude-code', 'resources', 'native-binary', 'claude.exe');
    const resolved = resolveClaudeExecutableDetailed(probes({
        extensionPath: id => (id === CLAUDE_EXTENSION_ID ? 'C:\\ext\\claude-code' : undefined),
        fileExists: p => p === expected
    }));

    assert.deepEqual(resolved, { path: expected, source: 'extension' });
});

test('the bundled binary has no .exe suffix off Windows', () => {
    const expected = path.join('/ext/claude-code', 'resources', 'native-binary', 'claude');
    const resolved = resolveClaudeExecutableDetailed(probes({
        platform: () => 'linux',
        extensionPath: () => '/ext/claude-code',
        fileExists: p => p === expected
    }));

    assert.deepEqual(resolved, { path: expected, source: 'extension' });
});

test('an installed extension with no bundled binary resolves to nothing', () => {
    const resolved = resolveClaudeExecutableDetailed(probes({
        extensionPath: () => 'C:\\ext\\claude-code',
        fileExists: () => false
    }));

    assert.equal(resolved, undefined);
});

test('resolveClaudeExecutable returns undefined when no source answers', () => {
    assert.equal(resolveClaudeExecutable(probes()), undefined);
});

test('describeMissingClaude names both fixes', () => {
    const message = describeMissingClaude();

    assert.ok(message.includes('PATH'));
    assert.ok(message.includes('buttonfu.claude.executablePath'));
});

// ---------------------------------------------------------------------------
// findWindowIdeLock
// ---------------------------------------------------------------------------

/** Writes a throwaway lock directory and returns its path. */
function createLockDirectory(files: Record<string, string>): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'buttonfu-ide-'));
    for (const [name, body] of Object.entries(files)) {
        fs.writeFileSync(path.join(directory, name), body);
    }
    return directory;
}

test('findWindowIdeLock picks the lock whose pid is this window process', () => {
    const directory = createLockDirectory({
        '12739.lock': JSON.stringify({ pid: 111, workspaceFolders: ['C:\\GIT\\ButtonFu'], authToken: 'other' }),
        '48622.lock': JSON.stringify({ pid: 26388, workspaceFolders: ['C:\\GIT\\ButtonFu'], authToken: 'mine' }),
        '53956.lock': JSON.stringify({ pid: 222, workspaceFolders: ['C:\\GIT\\ButtonFu'], authToken: 'stale' })
    });

    assert.deepEqual(findWindowIdeLock(26388, directory), { port: 48622, authToken: 'mine' });
    fs.rmSync(directory, { recursive: true, force: true });
});

test('findWindowIdeLock ignores overlapping workspace folders, which every lock shares', () => {
    const shared = ['C:\\GIT\\ButtonFu', 'C:\\GIT\\Kitae'];
    const directory = createLockDirectory({
        '10000.lock': JSON.stringify({ pid: 1, workspaceFolders: shared, authToken: 'a' }),
        '20000.lock': JSON.stringify({ pid: 2, workspaceFolders: shared, authToken: 'b' })
    });

    assert.equal(findWindowIdeLock(3, directory), undefined);
    assert.deepEqual(findWindowIdeLock(2, directory), { port: 20000, authToken: 'b' });
    fs.rmSync(directory, { recursive: true, force: true });
});

test('findWindowIdeLock steps over half-written locks and files that are not locks', () => {
    const directory = createLockDirectory({
        'notes.txt': 'not a lock at all',
        '30000.lock': '{ this is not json',
        '40000.lock': JSON.stringify({ pid: 7, authToken: 'good' })
    });

    assert.deepEqual(findWindowIdeLock(7, directory), { port: 40000, authToken: 'good' });
    fs.rmSync(directory, { recursive: true, force: true });
});

test('findWindowIdeLock prefers a port carried in the body over the file name', () => {
    const directory = createLockDirectory({
        '1.lock': JSON.stringify({ pid: 7, port: 51234, authToken: 'good' })
    });

    assert.deepEqual(findWindowIdeLock(7, directory), { port: 51234, authToken: 'good' });
    fs.rmSync(directory, { recursive: true, force: true });
});

test('findWindowIdeLock returns nothing when the directory is missing', () => {
    assert.equal(findWindowIdeLock(7, path.join(os.tmpdir(), 'buttonfu-no-such-directory')), undefined);
});

test('claudeIdeLockDirectory points at the Claude extension lock folder', () => {
    assert.equal(claudeIdeLockDirectory(), path.join(os.homedir(), '.claude', 'ide'));
});
