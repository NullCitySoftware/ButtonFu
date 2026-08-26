/**
 * The handoff that gets a Claude session running in a brand new VS Code window.
 *
 * `code.exe` has no flag that runs anything in the window it opens, and the new window is a
 * separate extension host that the launching window cannot reach into. So the launching window
 * leaves a job file in the extension's global storage - shared by every window for this user - and
 * the new window claims it on startup.
 *
 * The claim is a rename, because a rename is atomic on Windows and on posix and the loser of a
 * race is told so by an exception. Two windows on the same folder is an ordinary thing to happen,
 * not a theoretical one, so a read-then-write flag would eventually run a job twice.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { type ClaudeRunSpec } from './claudeCommandBuilder';

/** Where the job files live inside the extension's global storage. */
export const JOBS_DIRECTORY_NAME = 'claude-jobs';

/** How long a queued launch waits for its window, when the setting says nothing. */
export const DEFAULT_HANDOFF_TIMEOUT_SECONDS = 300;

/** One queued launch, waiting for the window that will run it. */
export interface ClaudeHandoffJob {
    /** Job id, which is also the file name. */
    id: string;
    /** When the job was written, in epoch milliseconds. */
    createdAt: number;
    /** After this, in epoch milliseconds, the job is discarded unread. */
    expiresAt: number;
    /** The folder the new window opens. Absolute and resolved. */
    targetFolder: string;
    /** The button's name, for the log and the terminal title. */
    buttonName: string;
    /** The launch itself. Its destination is always `terminalHere`. */
    spec: ClaudeRunSpec;
}

/** The jobs directory inside a given global-storage path. */
export function jobsDirectory(globalStorage: string): string {
    return path.join(globalStorage, JOBS_DIRECTORY_NAME);
}

/** Compares two folder paths the way the host filesystem would. */
export function sameFolder(left: string, right: string): boolean {
    const a = path.resolve(left);
    const b = path.resolve(right);
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Writes a job for the window that will open `targetFolder`.
 *
 * The file is written under a temporary name and renamed into place, so a window scanning the
 * directory at that moment never reads a half-written job.
 */
export function writeHandoffJob(
    globalStorage: string,
    targetFolder: string,
    buttonName: string,
    spec: ClaudeRunSpec,
    timeoutSeconds: number = DEFAULT_HANDOFF_TIMEOUT_SECONDS,
    now: number = Date.now()
): ClaudeHandoffJob {
    const directory = jobsDirectory(globalStorage);
    fs.mkdirSync(directory, { recursive: true });

    const job: ClaudeHandoffJob = {
        id: crypto.randomUUID(),
        createdAt: now,
        expiresAt: now + Math.max(30, timeoutSeconds) * 1000,
        targetFolder: path.resolve(targetFolder),
        buttonName,
        // The new window's job is to run the prompt somewhere you can watch it. A panel in a new
        // window is what the panel destinations' own setting is for.
        spec: { ...spec, destination: 'terminalHere', cwd: path.resolve(targetFolder) }
    };

    const target = path.join(directory, `${job.id}.json`);
    const temporary = `${target}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(job, null, 2), 'utf8');
    fs.renameSync(temporary, target);

    return job;
}

/**
 * Claims the oldest job waiting for this window's folder, or returns nothing.
 *
 * Expired and unreadable jobs are deleted on the way past, which is the only sweep the directory
 * gets: a job left behind by a window that never opened would otherwise sit there forever, and
 * running an hour-old job in a window opened for an unrelated reason is the failure worth
 * designing against.
 */
export function claimPendingJob(
    globalStorage: string,
    workspaceFolder: string | undefined,
    now: number = Date.now()
): ClaudeHandoffJob | undefined {
    const directory = jobsDirectory(globalStorage);

    let entries: string[];
    try {
        entries = fs.readdirSync(directory).filter(entry => entry.endsWith('.json'));
    } catch {
        return undefined;
    }
    if (entries.length === 0) {
        return undefined;
    }

    const candidates: ClaudeHandoffJob[] = [];
    for (const entry of entries) {
        const file = path.join(directory, entry);
        let job: ClaudeHandoffJob;
        try {
            job = JSON.parse(fs.readFileSync(file, 'utf8')) as ClaudeHandoffJob;
        } catch {
            removeQuietly(file);
            continue;
        }

        if (typeof job.expiresAt !== 'number' || job.expiresAt <= now) {
            removeQuietly(file);
            continue;
        }

        if (workspaceFolder && job.targetFolder && sameFolder(job.targetFolder, workspaceFolder)) {
            candidates.push(job);
        }
    }

    candidates.sort((left, right) => left.createdAt - right.createdAt);

    for (const job of candidates) {
        const file = path.join(directory, `${job.id}.json`);
        const claimed = `${file}.claimed`;
        try {
            // The rename IS the claim: it is atomic, and the loser of a race throws.
            fs.renameSync(file, claimed);
        } catch {
            continue;
        }

        removeQuietly(claimed);
        return job;
    }

    return undefined;
}

/** Deletes a file, ignoring the case where it is already gone. */
function removeQuietly(file: string): void {
    try {
        fs.unlinkSync(file);
    } catch {
        // Another window got there first, or the file was never there. Either way, nothing to do.
    }
}
