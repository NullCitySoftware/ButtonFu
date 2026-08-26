/**
 * Verifies the built package before it goes anywhere.
 *
 * `vsce package` will happily produce a VSIX whose name, manifest and contents disagree with what
 * anyone expected, and the Marketplace serves whatever it is handed. This opens the artifact and
 * checks it says what package.json says, and that nothing internal rode along inside it.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const extensionRoot = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8'));

// A VSIX is a zip. Only the central directory is needed to list entries and find the manifest.
function readZipEntries(buffer) {
    const signature = 0x06054b50;
    let end = buffer.length - 22;
    while (end >= 0 && buffer.readUInt32LE(end) !== signature) {
        end--;
    }
    if (end < 0) {
        throw new Error('The package is not a readable zip archive.');
    }

    const count = buffer.readUInt16LE(end + 10);
    let offset = buffer.readUInt32LE(end + 16);
    const entries = [];

    for (let i = 0; i < count; i++) {
        if (buffer.readUInt32LE(offset) !== 0x02014b50) {
            throw new Error('The package central directory is malformed.');
        }
        const method = buffer.readUInt16LE(offset + 10);
        const compressedSize = buffer.readUInt32LE(offset + 20);
        const nameLength = buffer.readUInt16LE(offset + 28);
        const extraLength = buffer.readUInt16LE(offset + 30);
        const commentLength = buffer.readUInt16LE(offset + 32);
        const localOffset = buffer.readUInt32LE(offset + 42);
        const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
        entries.push({ name, method, compressedSize, localOffset });
        offset += 46 + nameLength + extraLength + commentLength;
    }

    return entries;
}

function readEntry(buffer, entry) {
    const localNameLength = buffer.readUInt16LE(entry.localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(entry.localOffset + 28);
    const start = entry.localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(start, start + entry.compressedSize);
    return entry.method === 0 ? raw : zlib.inflateRawSync(raw);
}

function main() {
    const expectedName = `${manifest.name}-${manifest.version}.vsix`;
    const packagePath = process.argv[2]
        ? path.resolve(process.argv[2])
        : path.join(extensionRoot, expectedName);

    console.log('ButtonFu package verification');
    console.log(`  Package: ${packagePath}`);

    const problems = [];

    if (!fs.existsSync(packagePath)) {
        console.error(`  BLOCKED: No package at ${packagePath}. Build one with "npm run vsce-package".`);
        process.exitCode = 1;
        return;
    }

    if (path.basename(packagePath) !== expectedName) {
        problems.push(`Package is named "${path.basename(packagePath)}" but package.json says it should be "${expectedName}".`);
    }

    const buffer = fs.readFileSync(packagePath);
    if (buffer.length === 0) {
        problems.push('Package is empty.');
    }

    const entries = readZipEntries(buffer);

    // The Marketplace reads the version out of extension.vsixmanifest, not the filename, so this
    // is the number the public would actually receive.
    const vsixManifest = entries.find((entry) => entry.name === 'extension.vsixmanifest');
    if (!vsixManifest) {
        problems.push('Package has no extension.vsixmanifest.');
    } else {
        const xml = readEntry(buffer, vsixManifest).toString('utf8');
        const declared = /Id="([^"]+)"[^>]*Version="([^"]+)"/.exec(xml);
        if (!declared) {
            problems.push('Could not read the identity out of extension.vsixmanifest.');
        } else {
            console.log(`  Declares: ${declared[1]} ${declared[2]}`);
            if (declared[2] !== manifest.version) {
                problems.push(`Package declares version ${declared[2]} but package.json says ${manifest.version}.`);
            }
            if (declared[1] !== manifest.name) {
                problems.push(`Package declares id ${declared[1]} but package.json says ${manifest.name}.`);
            }
        }
    }

    const packaged = JSON.parse(readEntry(buffer, entries.find((e) => e.name === 'extension/package.json')).toString('utf8'));
    if (packaged.version !== manifest.version) {
        problems.push(`The package.json inside declares ${packaged.version} but this tree is at ${manifest.version}.`);
    }

    // Anything here is internal and has no business reaching a user's machine.
    const forbidden = [
        { label: 'TypeScript sources', test: (name) => name.startsWith('extension/src/') },
        { label: 'test suites', test: (name) => name.startsWith('extension/tests/') || name.startsWith('extension/.test-out/') },
        { label: 'build and release scripts', test: (name) => name.startsWith('extension/scripts/') },
        { label: 'working notes', test: (name) => name.startsWith('extension/docs/') },
        { label: 'a nested package', test: (name) => name.endsWith('.vsix') },
        { label: 'source maps', test: (name) => name.endsWith('.map') },
    ];

    for (const rule of forbidden) {
        const hits = entries.filter((entry) => rule.test(entry.name));
        if (hits.length > 0) {
            problems.push(`Package ships ${rule.label} (${hits.length} file(s), e.g. ${hits[0].name}). Exclude them in .vscodeignore.`);
        }
    }

    // And the things it must have, because their absence only shows up at runtime.
    const required = [
        'extension/out/extension.js',
        'extension/resources/icon.png',
        'extension/resources/icon.svg',
        'extension/node_modules/@vscode/codicons/dist/codicon.css',
        'extension/node_modules/@vscode/codicons/dist/codicon.ttf',
        'extension/readme.md',
        'extension/changelog.md',
        'extension/LICENSE.txt',
    ];

    for (const name of required) {
        if (!entries.some((entry) => entry.name === name)) {
            problems.push(`Package is missing ${name}.`);
        }
    }

    console.log(`  Contents: ${entries.length} entries, ${(buffer.length / 1024).toFixed(0)} KB`);

    if (problems.length > 0) {
        console.error('');
        for (const message of problems) {
            console.error(`  BLOCKED: ${message}`);
        }
        console.error('');
        console.error('Package verification failed. Do not publish this artifact.');
        process.exitCode = 1;
        return;
    }

    console.log('  Package verified.');
}

try {
    main();
} catch (error) {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
}
