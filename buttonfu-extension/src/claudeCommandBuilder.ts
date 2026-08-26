/**
 * Pure argv construction for ClaudeCommand buttons.
 *
 * Nothing in this file spawns a process, reads a setting or imports `vscode`. It turns a
 * {@link ClaudeRunSpec} into the exact argument list the Claude CLI should receive, and writes
 * the small launcher script that lets a shell run that argument list without a single character
 * of the prompt ever appearing on a command line.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ClaudeDestination } from './types';

/** Everything a single Claude launch needs, already token-resolved. */
export interface ClaudeRunSpec {
    /** Where the session starts. */
    destination: ClaudeDestination;
    /** Fully token-resolved prompt text. May contain quotes, newlines, anything. */
    prompt: string;
    /** Absolute working directory. */
    cwd: string;
    /** Session uuid minted by the caller. Omitted only where a session id is meaningless. */
    sessionId?: string;
    /** Session display name, shown in the prompt box, the picker and the terminal title. */
    sessionName?: string;
    /** Model alias or full name. Empty means the CLI default. */
    model?: string;
    /** Reasoning effort. Empty means the CLI default. */
    effort?: string;
    /** Permission mode the session starts in. */
    permissionMode?: string;
    /** Extra directories the session may read. */
    addDirs?: string[];
    /** Run the session in a fresh git worktree. */
    worktree?: boolean;
    /** Name for that worktree. Ignored unless `worktree` is true. */
    worktreeName?: string;
    /** Extra arguments, already split into argv entries. Never split and never shell-parsed. */
    extraArgs?: string[];
}

/** Permission modes the CLI accepts through `--permission-mode`. */
const PERMISSION_MODE_FLAGS: readonly string[] = ['acceptEdits', 'auto', 'plan', 'manual', 'dontAsk'];

/** The mode the CLI spells as its own flag rather than a `--permission-mode` value. */
const SKIP_PERMISSIONS_MODE = 'bypassPermissions';

/** Directory the launcher scripts are written into. */
export const LAUNCHER_DIRECTORY = path.join(os.tmpdir(), 'buttonfu-claude');

/** How long a launcher script survives before {@link sweepStaleLaunchers} removes it. */
const LAUNCHER_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Builds the argument list that follows the executable.
 *
 * The prompt is always the final entry. `--add-dir` is variadic in the CLI, so it swallows every
 * following bare word until the next flag: a prompt placed anywhere before the end would be
 * parsed as another directory. Each directory therefore gets its own `--add-dir` pair, and the
 * prompt stays last. Do not reorder these.
 */
export function buildClaudeArgs(spec: ClaudeRunSpec): string[] {
    const args: string[] = [];

    if (spec.sessionId) {
        args.push('--session-id', spec.sessionId);
    }

    if (spec.sessionName && spec.sessionName.trim()) {
        args.push('-n', spec.sessionName.trim());
    }

    if (spec.model && spec.model.trim()) {
        args.push('--model', spec.model.trim());
    }

    if (spec.effort && spec.effort.trim()) {
        args.push('--effort', spec.effort.trim());
    }

    const mode = (spec.permissionMode ?? '').trim();
    if (mode === SKIP_PERMISSIONS_MODE) {
        args.push('--dangerously-skip-permissions');
    } else if (PERMISSION_MODE_FLAGS.includes(mode)) {
        args.push('--permission-mode', mode);
    }

    if (spec.worktree) {
        args.push('--worktree');
        if (spec.worktreeName && spec.worktreeName.trim()) {
            args.push(spec.worktreeName.trim());
        }
    }

    for (const dir of spec.addDirs ?? []) {
        if (dir && dir.trim()) {
            args.push('--add-dir', dir.trim());
        }
    }

    if (spec.destination === 'headlessThenPanel') {
        args.push('-p', '--output-format', 'text');
    } else if (spec.destination === 'backgroundAgent') {
        args.push('--bg');
    }

    for (const extra of spec.extraArgs ?? []) {
        if (typeof extra === 'string' && extra.length > 0) {
            args.push(extra);
        }
    }

    if (spec.prompt && spec.prompt.length > 0) {
        args.push(spec.prompt);
    }

    return args;
}

/** A generated launcher script and the one line that runs it. */
export interface LauncherScript {
    /** Absolute path of the generated script. */
    path: string;
    /** The command to send to a terminal. Contains no user text. */
    shellCommand: string;
}

/** Quotes a literal for a single-quoted PowerShell string, which does not interpolate. */
export function quotePowerShellLiteral(value: string): string {
    return "'" + value.split("'").join("''") + "'";
}

/** Quotes a literal for a single-quoted posix shell word. */
export function quotePosixLiteral(value: string): string {
    return "'" + value.split("'").join("'\\''") + "'";
}

/**
 * Writes a launcher script that runs `exe` with `args` in `cwd`.
 *
 * The prompt lives inside the file as a quoted literal, so the line the terminal receives is only
 * ever an invocation of the script. `pwshAvailable` decides which host the Windows command names;
 * it is passed in rather than probed so this stays testable.
 */
export function writeLauncherScript(
    exe: string,
    args: string[],
    cwd: string,
    shell: 'powershell' | 'posix',
    pwshAvailable = true,
    directory: string = LAUNCHER_DIRECTORY
): LauncherScript {
    fs.mkdirSync(directory, { recursive: true });
    const id = crypto.randomUUID();

    if (shell === 'powershell') {
        const scriptPath = path.join(directory, `launch-${id}.ps1`);
        const parts = [exe, ...args].map(quotePowerShellLiteral);
        const body = [
            '# Generated by ButtonFu. Safe to delete.',
            `Set-Location -LiteralPath ${quotePowerShellLiteral(cwd)}`,
            `& ${parts.join(' ')}`,
            ''
        ].join('\r\n');
        fs.writeFileSync(scriptPath, body, { encoding: 'utf8' });
        const host = pwshAvailable ? 'pwsh' : 'powershell';
        return {
            path: scriptPath,
            shellCommand: `${host} -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`
        };
    }

    const scriptPath = path.join(directory, `launch-${id}.sh`);
    const parts = [exe, ...args].map(quotePosixLiteral);
    const body = [
        '#!/bin/sh',
        '# Generated by ButtonFu. Safe to delete.',
        `cd ${quotePosixLiteral(cwd)} || exit 1`,
        `exec ${parts.join(' ')}`,
        ''
    ].join('\n');
    fs.writeFileSync(scriptPath, body, { encoding: 'utf8', mode: 0o700 });
    return { path: scriptPath, shellCommand: `sh ${quotePosixLiteral(scriptPath)}` };
}

/**
 * Deletes launcher scripts older than a day.
 *
 * A launcher cannot delete itself reliably, because an interrupted session never reaches its last
 * line. Sweeping by age is the honest fix. Called once at activation.
 */
export function sweepStaleLaunchers(
    now: number = Date.now(),
    directory: string = LAUNCHER_DIRECTORY
): void {
    let entries: string[];
    try {
        entries = fs.readdirSync(directory);
    } catch {
        return;
    }

    for (const entry of entries) {
        const full = path.join(directory, entry);
        try {
            if (now - fs.statSync(full).mtimeMs > LAUNCHER_MAX_AGE_MS) {
                fs.unlinkSync(full);
            }
        } catch {
            // A script another window is still running, or one already gone. Either way, leave it.
        }
    }
}

/** Renders an argv for a log line, with the prompt reduced to its length. */
export function describeArgsForLog(args: string[], prompt: string): string {
    return args
        .map(arg => (prompt.length > 0 && arg === prompt ? `<prompt: ${prompt.length} chars>` : arg))
        .join(' ');
}
