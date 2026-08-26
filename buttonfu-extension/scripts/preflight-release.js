/**
 * Checks, before anything is packaged or published, that the version about to go out is the
 * version that should go out.
 *
 * ButtonFu sat at 1.1.3 on the Marketplace for months while the repo moved through 1.2.0 and
 * 1.3.0, because packaging and publishing were separate hand-run steps and nothing ever compared
 * the two. Every check here exists to make that state impossible to reach again.
 */

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const extensionRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(extensionRoot, '..');
const manifestPath = path.join(extensionRoot, 'package.json');
const changelogPath = path.join(repoRoot, 'CHANGELOG.md');

const problems = [];
const warnings = [];

function fail(message) {
    problems.push(message);
}

function warn(message) {
    warnings.push(message);
}

function parseVersion(value) {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value ?? '');
    if (!match) {
        return null;
    }
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left, right) {
    for (let i = 0; i < 3; i++) {
        if (left[i] !== right[i]) {
            return left[i] < right[i] ? -1 : 1;
        }
    }
    return 0;
}

/** Reads the version the Marketplace is currently serving to the public. */
async function fetchPublishedVersion(publisher, name) {
    const response = await fetch('https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery', {
        method: 'POST',
        headers: {
            'Accept': 'application/json;api-version=7.2-preview.1',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            filters: [{ criteria: [{ filterType: 7, value: `${publisher}.${name}` }], pageNumber: 1, pageSize: 1 }],
            flags: 914
        })
    });

    if (!response.ok) {
        throw new Error(`Marketplace query returned HTTP ${response.status}.`);
    }

    const body = await response.json();
    const extension = body?.results?.[0]?.extensions?.[0];
    if (!extension) {
        return null;
    }

    return extension.versions?.[0]?.version ?? null;
}

/** Names anything uncommitted under the extension, so a published build is traceable to a commit. */
function uncommittedExtensionFiles() {
    const result = childProcess.spawnSync('git', ['status', '--porcelain', '--', 'buttonfu-extension'], {
        cwd: repoRoot,
        encoding: 'utf8'
    });

    if (result.status !== 0) {
        return null;
    }

    return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

async function main() {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const version = manifest.version;
    const parsed = parseVersion(version);

    console.log(`ButtonFu release preflight`);
    console.log(`  Candidate: ${manifest.publisher}.${manifest.name} ${version}`);

    if (!parsed) {
        fail(`package.json version "${version}" is not a plain major.minor.patch number.`);
    }

    // The changelog is the release notes the Marketplace shows, so a missing section means the
    // public would get a page that does not mention what they are being asked to install.
    const changelog = fs.readFileSync(changelogPath, 'utf8');
    const heading = `## [${version}]`;
    const hasNotes = changelog.split(/\r?\n/).some((line) => line.startsWith(heading));
    if (!hasNotes) {
        fail(`CHANGELOG.md has no "${heading}" section. Every published version needs its notes.`);
    }

    const dirty = uncommittedExtensionFiles();
    if (dirty === null) {
        warn('Could not read git status, so it is not known whether this build matches a commit.');
    } else if (dirty.length > 0) {
        warn(`${dirty.length} uncommitted file(s) under buttonfu-extension. The published build will not match any commit:`);
        for (const entry of dirty.slice(0, 12)) {
            warn(`    ${entry}`);
        }
        if (dirty.length > 12) {
            warn(`    ...and ${dirty.length - 12} more.`);
        }
    }

    let published = null;
    try {
        published = await fetchPublishedVersion(manifest.publisher, manifest.name);
    } catch (error) {
        warn(`Could not reach the Marketplace, so the published version is unknown: ${error.message}`);
    }

    if (published === null) {
        console.log('  Published: nothing yet (first release, or the Marketplace could not be reached)');
    } else {
        console.log(`  Published: ${published}`);
        const publishedParts = parseVersion(published);
        if (parsed && publishedParts) {
            const order = compareVersions(publishedParts, parsed);
            if (order === 0) {
                fail(`Version ${version} is already public. The Marketplace refuses a repeat, so bump package.json first.`);
            } else if (order > 0) {
                fail(`Version ${version} is older than the public ${published}. Publishing it would take features away from everyone.`);
            } else {
                console.log(`  Moving the public from ${published} to ${version}.`);
            }
        }
    }

    console.log('');
    for (const message of warnings) {
        console.warn(`  WARNING: ${message}`);
    }

    if (problems.length > 0) {
        console.error('');
        for (const message of problems) {
            console.error(`  BLOCKED: ${message}`);
        }
        console.error('');
        console.error('Preflight failed. Nothing has been packaged or published.');
        process.exitCode = 1;
        return;
    }

    console.log('  Preflight passed.');
}

main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
});
