import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

/**
 * Gives a test file its own scratch directory, and deletes it when the file finishes.
 *
 * `node --test` runs each test file in its own process, several at a time, so a file that sweeps
 * a shared temp location deletes directories the other files are still using. Everything a test
 * creates therefore goes under one directory of its own, and only that directory is removed.
 *
 * Call once at the top of a test file and pass the returned root to `tempDirectory()` or straight
 * to the code under test.
 */
export function useTempDirectory(label: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `buttonfu-${label}-`));

    test.after(() => {
        try {
            fs.rmSync(root, { recursive: true, force: true });
        } catch {
            // Something is still holding a file open. It is a temp directory; leave it.
        }
    });

    return root;
}

/** Makes a uniquely named directory inside a scratch root. */
export function tempDirectory(root: string, label: string): string {
    return fs.mkdtempSync(path.join(root, `${label}-`));
}
