/**
 * Publishes the package that was just built and verified, and nothing else.
 *
 * `vsce publish` on its own rebuilds from the working tree, so what reaches the public is not the
 * artifact anything was checked against. This hands the Marketplace the exact file
 * `npm run verify-package` opened, by path.
 *
 * Run it through `npm run publish-extension`, which does the preflight, the tests, the build and
 * the verification first.
 */

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const extensionRoot = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8'));
const packagePath = path.join(extensionRoot, `${manifest.name}-${manifest.version}.vsix`);

if (!fs.existsSync(packagePath)) {
    console.error(`No package at ${packagePath}. Run "npm run release" first.`);
    process.exitCode = 1;
    return;
}

console.log(`Publishing ${manifest.publisher}.${manifest.name} ${manifest.version}`);
console.log(`  From: ${packagePath}`);

// vsce's own node entry point, rather than the `vsce.cmd` shim: no shell is involved, so a path
// with a space in it survives, and Windows does not refuse to spawn a .cmd file.
const vsceEntry = path.join(path.dirname(require.resolve('@vscode/vsce/package.json')), 'vsce');

const result = childProcess.spawnSync(
    process.execPath,
    [vsceEntry, 'publish', '--packagePath', packagePath],
    { cwd: extensionRoot, stdio: 'inherit' }
);

if (result.error) {
    console.error(result.error.message);
    process.exitCode = 1;
} else if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
} else {
    console.log('');
    console.log(`Published. The Marketplace takes a few minutes to serve ${manifest.version} to everyone.`);
}
