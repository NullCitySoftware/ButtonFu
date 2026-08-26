import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
    buildClaudeArgs,
    describeArgsForLog,
    LAUNCHER_DIRECTORY,
    quotePosixLiteral,
    quotePowerShellLiteral,
    sweepStaleLaunchers,
    writeLauncherScript,
    type ClaudeRunSpec
} from '../claudeCommandBuilder';
import { useTempDirectory } from './helpers/tempCleanup';

const TEMP_ROOT = useTempDirectory('builder');

function spec(overrides: Partial<ClaudeRunSpec> = {}): ClaudeRunSpec {
    return {
        destination: 'terminalHere',
        prompt: 'Summarise this repo.',
        cwd: 'C:\\GIT\\ButtonFu',
        ...overrides
    };
}

// ---------------------------------------------------------------------------
// buildClaudeArgs
// ---------------------------------------------------------------------------

test('buildClaudeArgs emits nothing but the prompt for a bare spec', () => {
    assert.deepEqual(buildClaudeArgs(spec()), ['Summarise this repo.']);
});

test('buildClaudeArgs omits the prompt entirely when it is empty', () => {
    assert.deepEqual(buildClaudeArgs(spec({ prompt: '' })), []);
});

test('buildClaudeArgs emits the flags in the documented order', () => {
    const args = buildClaudeArgs(spec({
        sessionId: '11111111-2222-3333-4444-555555555555',
        sessionName: 'repo plan',
        model: 'opus',
        effort: 'high',
        permissionMode: 'acceptEdits'
    }));

    assert.deepEqual(args, [
        '--session-id', '11111111-2222-3333-4444-555555555555',
        '-n', 'repo plan',
        '--model', 'opus',
        '--effort', 'high',
        '--permission-mode', 'acceptEdits',
        'Summarise this repo.'
    ]);
});

test('buildClaudeArgs spells bypassPermissions as --dangerously-skip-permissions', () => {
    const args = buildClaudeArgs(spec({ permissionMode: 'bypassPermissions' }));

    assert.ok(args.includes('--dangerously-skip-permissions'));
    assert.ok(!args.includes('--permission-mode'));
    assert.ok(!args.includes('bypassPermissions'));
});

test('buildClaudeArgs ignores an empty or unrecognised permission mode', () => {
    assert.deepEqual(buildClaudeArgs(spec({ permissionMode: '' })), ['Summarise this repo.']);
    assert.deepEqual(buildClaudeArgs(spec({ permissionMode: 'yolo' })), ['Summarise this repo.']);
});

test('buildClaudeArgs repeats --add-dir once per directory and keeps the prompt last', () => {
    const args = buildClaudeArgs(spec({ addDirs: ['C:\\GIT\\Kitae', 'C:\\GIT\\Catanari'] }));

    assert.deepEqual(args, [
        '--add-dir', 'C:\\GIT\\Kitae',
        '--add-dir', 'C:\\GIT\\Catanari',
        'Summarise this repo.'
    ]);
    assert.equal(args[args.length - 1], 'Summarise this repo.');
    assert.equal(args.filter(a => a === '--add-dir').length, 2);
});

test('buildClaudeArgs keeps the prompt last even with every option set', () => {
    const args = buildClaudeArgs(spec({
        destination: 'backgroundAgent',
        sessionId: 'abc',
        sessionName: 'n',
        model: 'opus',
        effort: 'max',
        permissionMode: 'bypassPermissions',
        addDirs: ['a', 'b'],
        worktree: true,
        worktreeName: 'wt',
        extraArgs: ['--append-system-prompt', 'be terse']
    }));

    assert.equal(args[args.length - 1], 'Summarise this repo.');
});

test('buildClaudeArgs drops blank entries from addDirs', () => {
    assert.deepEqual(buildClaudeArgs(spec({ addDirs: ['', '   ', 'C:\\GIT\\Kitae'] })), [
        '--add-dir', 'C:\\GIT\\Kitae', 'Summarise this repo.'
    ]);
});

test('buildClaudeArgs emits --worktree with a name only when one is given', () => {
    assert.deepEqual(buildClaudeArgs(spec({ worktree: true })), ['--worktree', 'Summarise this repo.']);
    assert.deepEqual(buildClaudeArgs(spec({ worktree: true, worktreeName: 'planning' })),
        ['--worktree', 'planning', 'Summarise this repo.']);
    assert.deepEqual(buildClaudeArgs(spec({ worktree: false, worktreeName: 'planning' })),
        ['Summarise this repo.']);
});

test('buildClaudeArgs adds the headless flags for headlessThenPanel', () => {
    const args = buildClaudeArgs(spec({ destination: 'headlessThenPanel' }));
    assert.deepEqual(args, ['-p', '--output-format', 'text', 'Summarise this repo.']);
});

test('buildClaudeArgs adds --bg for backgroundAgent and nothing for other destinations', () => {
    assert.deepEqual(buildClaudeArgs(spec({ destination: 'backgroundAgent' })), ['--bg', 'Summarise this repo.']);
    assert.deepEqual(buildClaudeArgs(spec({ destination: 'terminalNewWindow' })), ['Summarise this repo.']);
    assert.deepEqual(buildClaudeArgs(spec({ destination: 'externalTerminal' })), ['Summarise this repo.']);
    assert.deepEqual(buildClaudeArgs(spec({ destination: 'newVsCodeWindow' })), ['Summarise this repo.']);
});

test('buildClaudeArgs passes extraArgs verbatim without splitting them', () => {
    const args = buildClaudeArgs(spec({ extraArgs: ['--append-system-prompt', 'be terse and quiet'] }));

    assert.deepEqual(args, ['--append-system-prompt', 'be terse and quiet', 'Summarise this repo.']);
});

// ---------------------------------------------------------------------------
// Quoting
// ---------------------------------------------------------------------------

/** Parses a single-quoted PowerShell argument list back into the original strings. */
function parsePowerShellLiterals(line: string): string[] {
    const out: string[] = [];
    let i = 0;
    while (i < line.length) {
        if (line[i] !== "'") { i++; continue; }
        i++;
        let value = '';
        while (i < line.length) {
            if (line[i] === "'") {
                if (line[i + 1] === "'") { value += "'"; i += 2; continue; }
                i++;
                break;
            }
            value += line[i];
            i++;
        }
        out.push(value);
    }
    return out;
}

const NASTY_PROMPTS: { name: string; prompt: string }[] = [
    { name: 'a single quote', prompt: "it's a test, isn't it" },
    { name: 'a double quote and a variable', prompt: 'say "hello" from $HOME please' },
    { name: 'a backtick', prompt: 'run `whoami` and report back' },
    { name: 'three lines', prompt: 'line one\nline two\nline three' },
    { name: 'a shell injection attempt', prompt: '; rm -rf / # and then some' },
    { name: 'every hazard at once', prompt: '$x = "a\'b`c"; echo $x\nrm -rf /' }
];

for (const { name, prompt } of NASTY_PROMPTS) {
    test(`a PowerShell launcher round-trips a prompt containing ${name}`, () => {
        const args = buildClaudeArgs(spec({ prompt }));
        const script = writeLauncherScript('C:\\bin\\claude.exe', args, 'C:\\GIT\\ButtonFu', 'powershell', true, TEMP_ROOT);
        const body = fs.readFileSync(script.path, 'utf8');
        const invocation = body.split('\r\n').find(l => l.startsWith('& '))!;

        assert.deepEqual(parsePowerShellLiterals(invocation), ['C:\\bin\\claude.exe', ...args]);
        assert.ok(!script.shellCommand.includes(prompt.split('\n')[0]));
        fs.unlinkSync(script.path);
    });

    test(`a posix launcher round-trips a prompt containing ${name}`, () => {
        const args = buildClaudeArgs(spec({ prompt }));
        const script = writeLauncherScript('/usr/bin/claude', args, '/home/rob/repo', 'posix', true, TEMP_ROOT);
        const body = fs.readFileSync(script.path, 'utf8');
        // `exec` is the last statement, so everything from it to the end is the invocation.
        // Splitting on newlines would tear a multi-line prompt apart.
        const invocation = body.slice(body.indexOf('exec ')).replace(/\n$/, '');

        // Reverse the posix single-quote escape by splitting on the boundaries it produces.
        const rebuilt = invocation
            .slice('exec '.length)
            .split(/(?<=')\s(?=')/)
            .map(part => part.replace(/^'/, '').replace(/'$/, '').split("'\\''").join("'"));

        assert.deepEqual(rebuilt, ['/usr/bin/claude', ...args]);
        fs.unlinkSync(script.path);
    });
}

test('an empty prompt still produces a runnable launcher', () => {
    const args = buildClaudeArgs(spec({ prompt: '' }));
    const script = writeLauncherScript('claude', args, 'C:\\GIT\\ButtonFu', 'powershell', true, TEMP_ROOT);
    const body = fs.readFileSync(script.path, 'utf8');

    assert.ok(body.includes("& 'claude'"));
    fs.unlinkSync(script.path);
});

test('quotePowerShellLiteral doubles embedded single quotes', () => {
    assert.equal(quotePowerShellLiteral("it's"), "'it''s'");
    assert.equal(quotePowerShellLiteral('$env:PATH'), "'$env:PATH'");
});

test('quotePosixLiteral closes and reopens around an embedded single quote', () => {
    assert.equal(quotePosixLiteral("it's"), "'it'\\''s'");
});

// ---------------------------------------------------------------------------
// Launcher plumbing
// ---------------------------------------------------------------------------

test('the launcher shell command names pwsh, or powershell when pwsh is absent', () => {
    const withPwsh = writeLauncherScript('claude', [], 'C:\\GIT', 'powershell', true, TEMP_ROOT);
    const withoutPwsh = writeLauncherScript('claude', [], 'C:\\GIT', 'powershell', false, TEMP_ROOT);

    assert.ok(withPwsh.shellCommand.startsWith('pwsh -NoProfile -ExecutionPolicy Bypass -File "'));
    assert.ok(withoutPwsh.shellCommand.startsWith('powershell -NoProfile -ExecutionPolicy Bypass -File "'));
    fs.unlinkSync(withPwsh.path);
    fs.unlinkSync(withoutPwsh.path);
});

test('the launcher changes directory before invoking Claude', () => {
    const script = writeLauncherScript('claude', ['hi'], "C:\\GIT\\Rob's Repo", 'powershell', true, TEMP_ROOT);
    const body = fs.readFileSync(script.path, 'utf8');

    assert.ok(body.includes("Set-Location -LiteralPath 'C:\\GIT\\Rob''s Repo'"));
    fs.unlinkSync(script.path);
});

test('sweepStaleLaunchers removes scripts older than a day and keeps fresh ones', () => {
    const fresh = writeLauncherScript('claude', [], 'C:\\GIT', 'powershell', true, TEMP_ROOT);
    const stale = writeLauncherScript('claude', [], 'C:\\GIT', 'powershell', true, TEMP_ROOT);
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(stale.path, twoDaysAgo, twoDaysAgo);

    sweepStaleLaunchers(Date.now(), TEMP_ROOT);

    assert.equal(fs.existsSync(stale.path), false);
    assert.equal(fs.existsSync(fresh.path), true);
    fs.unlinkSync(fresh.path);
});

test('sweepStaleLaunchers does not throw when the launcher directory is absent', () => {
    assert.equal(LAUNCHER_DIRECTORY, path.join(os.tmpdir(), 'buttonfu-claude'));
    assert.doesNotThrow(() => sweepStaleLaunchers(Date.now(), TEMP_ROOT));
});

test('describeArgsForLog hides the prompt behind a character count', () => {
    const args = buildClaudeArgs(spec({ model: 'opus', prompt: 'secret words here' }));

    assert.equal(describeArgsForLog(args, 'secret words here'), '--model opus <prompt: 17 chars>');
});
