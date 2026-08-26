import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
    claimPendingJob,
    jobsDirectory,
    sameFolder,
    writeHandoffJob,
    type ClaudeHandoffJob
} from '../claudeHandoff';
import type { ClaudeRunSpec } from '../claudeCommandBuilder';
import { tempDirectory, useTempDirectory } from './helpers/tempCleanup';

const TEMP_ROOT = useTempDirectory('handoff');

function createStorage(): string {
    return tempDirectory(TEMP_ROOT, 'handoff');
}

function spec(overrides: Partial<ClaudeRunSpec> = {}): ClaudeRunSpec {
    return {
        destination: 'newVsCodeWindow',
        prompt: 'Summarise this repo.',
        cwd: 'C:\\GIT\\ButtonFu',
        sessionId: '11111111-2222-3333-4444-555555555555',
        ...overrides
    };
}

function listJobs(storage: string): string[] {
    try {
        return fs.readdirSync(jobsDirectory(storage));
    } catch {
        return [];
    }
}

test('a written job carries the folder, the button and a terminal destination', () => {
    const storage = createStorage();
    const folder = os.tmpdir();

    const job = writeHandoffJob(storage, folder, 'Plan this repo', spec());

    assert.equal(job.targetFolder, path.resolve(folder));
    assert.equal(job.buttonName, 'Plan this repo');
    assert.equal(job.spec.destination, 'terminalHere',
        'The new window runs the prompt where it can be watched, not in a panel.');
    assert.equal(job.spec.cwd, path.resolve(folder));
    assert.equal(job.spec.prompt, 'Summarise this repo.');
    assert.deepEqual(listJobs(storage), [`${job.id}.json`], 'No temporary file should be left behind.');

    fs.rmSync(storage, { recursive: true, force: true });
});

test('a job is claimed once, and the second claimant gets nothing', () => {
    const storage = createStorage();
    const folder = os.tmpdir();
    writeHandoffJob(storage, folder, 'Plan this repo', spec());

    const first = claimPendingJob(storage, folder);
    const second = claimPendingJob(storage, folder);

    assert.ok(first, 'The first window should get the job.');
    assert.equal(second, undefined, 'A job must never run twice.');
    assert.deepEqual(listJobs(storage), [], 'A claimed job is removed.');

    fs.rmSync(storage, { recursive: true, force: true });
});

test('a job for another folder is left alone', () => {
    const storage = createStorage();
    const wanted = tempDirectory(TEMP_ROOT, 'target');
    const other = tempDirectory(TEMP_ROOT, 'other');
    writeHandoffJob(storage, wanted, 'Plan this repo', spec());

    assert.equal(claimPendingJob(storage, other), undefined);
    assert.equal(listJobs(storage).length, 1, 'Someone else job must survive.');
    assert.ok(claimPendingJob(storage, wanted));

    for (const directory of [storage, wanted, other]) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('an expired job is deleted rather than run', () => {
    const storage = createStorage();
    const folder = os.tmpdir();
    const now = Date.now();
    writeHandoffJob(storage, folder, 'Plan this repo', spec(), 30, now);

    assert.equal(claimPendingJob(storage, folder, now + 31_000), undefined,
        'A stale job running in a window opened for an unrelated reason is the failure to avoid.');
    assert.deepEqual(listJobs(storage), []);

    fs.rmSync(storage, { recursive: true, force: true });
});

test('the timeout has a floor, so a job cannot expire before the window opens', () => {
    const storage = createStorage();
    const now = Date.now();

    const job = writeHandoffJob(storage, os.tmpdir(), 'Plan this repo', spec(), 1, now);

    assert.equal(job.expiresAt - job.createdAt, 30_000);
    fs.rmSync(storage, { recursive: true, force: true });
});

test('the oldest matching job is claimed first', () => {
    const storage = createStorage();
    const folder = os.tmpdir();
    const now = Date.now();
    writeHandoffJob(storage, folder, 'Second', spec(), 300, now);
    writeHandoffJob(storage, folder, 'First', spec(), 300, now - 10_000);

    assert.equal(claimPendingJob(storage, folder, now)?.buttonName, 'First');
    assert.equal(claimPendingJob(storage, folder, now)?.buttonName, 'Second');

    fs.rmSync(storage, { recursive: true, force: true });
});

test('an unreadable job is swept away rather than blocking the queue', () => {
    const storage = createStorage();
    const folder = os.tmpdir();
    fs.mkdirSync(jobsDirectory(storage), { recursive: true });
    fs.writeFileSync(path.join(jobsDirectory(storage), 'broken.json'), '{ half writ');
    const good = writeHandoffJob(storage, folder, 'Plan this repo', spec());

    assert.equal(claimPendingJob(storage, folder)?.id, good.id);
    assert.deepEqual(listJobs(storage), []);

    fs.rmSync(storage, { recursive: true, force: true });
});

test('claiming costs nothing when there is no jobs directory or no workspace folder', () => {
    const storage = createStorage();

    assert.equal(claimPendingJob(storage, os.tmpdir()), undefined);
    assert.equal(claimPendingJob(path.join(storage, 'never-created'), os.tmpdir()), undefined);

    writeHandoffJob(storage, os.tmpdir(), 'Plan this repo', spec());
    assert.equal(claimPendingJob(storage, undefined), undefined, 'A window with no folder claims nothing.');

    fs.rmSync(storage, { recursive: true, force: true });
});

test('sameFolder normalises the path, and ignores case only on Windows', () => {
    assert.equal(sameFolder('C:\\GIT\\ButtonFu', 'C:\\GIT\\ButtonFu'), true);
    assert.equal(sameFolder(path.join(os.tmpdir(), 'a', '..', 'a'), path.join(os.tmpdir(), 'a')), true);
    assert.equal(sameFolder('C:\\GIT\\ButtonFu', 'C:\\GIT\\Kitae'), false);

    const mixedCase = sameFolder('C:\\GIT\\ButtonFu', 'c:\\git\\buttonfu');
    assert.equal(mixedCase, process.platform === 'win32');
});

test('a job round-trips through JSON with its spec intact', () => {
    const storage = createStorage();
    const folder = os.tmpdir();
    const written = writeHandoffJob(storage, folder, 'Plan this repo', spec({
        model: 'opus',
        permissionMode: 'bypassPermissions',
        addDirs: ['C:\\GIT\\Kitae'],
        extraArgs: ['--append-system-prompt', 'be terse']
    }));

    const claimed = claimPendingJob(storage, folder) as ClaudeHandoffJob;

    assert.equal(claimed.spec.model, 'opus');
    assert.equal(claimed.spec.permissionMode, 'bypassPermissions');
    assert.deepEqual(claimed.spec.addDirs, ['C:\\GIT\\Kitae']);
    assert.deepEqual(claimed.spec.extraArgs, ['--append-system-prompt', 'be terse']);
    assert.equal(claimed.spec.sessionId, written.spec.sessionId,
        'The session id must survive, or the new window starts a different conversation.');

    fs.rmSync(storage, { recursive: true, force: true });
});

test('the claim is a rename, so a racing second claimant is told it lost', () => {
    const storage = createStorage();
    const folder = os.tmpdir();
    const job = writeHandoffJob(storage, folder, 'Plan this repo', spec());
    const file = path.join(jobsDirectory(storage), `${job.id}.json`);

    // Both windows listed the directory before either claimed, so both try the same rename.
    fs.renameSync(file, `${file}.claimed`);
    assert.throws(() => fs.renameSync(file, `${file}.claimed`),
        'A read-then-write flag would let both windows run the job.');

    fs.rmSync(storage, { recursive: true, force: true });
});
