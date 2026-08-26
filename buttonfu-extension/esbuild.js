const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// The build number is shared with the installer, which stamps it into the setup executable.
// A production build claims the next one and writes it back; a development build only reads,
// so an ordinary compile never dirties the tree.
const buildNumberPath = path.join(__dirname, '..', 'Installer', 'Version.Build.txt');

function readBuildNumber() {
    if (!fs.existsSync(buildNumberPath)) {
        return 0;
    }

    const parsed = parseInt(fs.readFileSync(buildNumberPath, 'utf-8').trim(), 10);
    return Number.isNaN(parsed) ? 0 : parsed;
}

function nextBuildNumber() {
    const claimed = readBuildNumber() + 1;
    fs.writeFileSync(buildNumberPath, `${claimed}
`, 'utf-8');
    return claimed;
}

// esbuild appends to `out/`, so a file left behind by an older layout would ship inside the
// package for as long as nobody noticed. A production build starts from an empty directory.
function cleanOutputDirectory() {
    fs.rmSync(path.join(__dirname, 'out'), { recursive: true, force: true });
}

// Get version from package.json
function getVersion() {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));
        return pkg.version || '0.0.0';
    } catch (e) {
        return '0.0.0';
    }
}

async function main() {
    if (production) {
        cleanOutputDirectory();
    }

    const buildNumber = production ? nextBuildNumber() : readBuildNumber();
    const buildTime = new Date();
    const buildTimeFormatted = buildTime.toLocaleString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
    const version = getVersion();

    console.log(`Building ButtonFu Extension - Build #${buildNumber} at ${buildTimeFormatted}`);

    const ctx = await esbuild.context({
        entryPoints: ['src/extension.ts'],
        bundle: true,
        format: 'cjs',
        minify: production,
        sourcemap: !production,
        sourcesContent: false,
        platform: 'node',
        outfile: 'out/extension.js',
        external: ['vscode'],
        logLevel: 'info',
        define: {
            'BUILD_NUMBER': buildNumber.toString(),
            'BUILD_TIME': JSON.stringify(buildTimeFormatted),
            'BUILD_TIME_ISO': JSON.stringify(buildTime.toISOString()),
            'BUILD_VERSION': JSON.stringify(version)
        },
        plugins: [],
    });
    if (watch) {
        await ctx.watch();
    } else {
        await ctx.rebuild();
        await ctx.dispose();
        // Log content hash so developers can verify builds are fresh
        const outFile = path.join(__dirname, 'out', 'extension.js');
        if (fs.existsSync(outFile)) {
            const hash = crypto.createHash('sha256').update(fs.readFileSync(outFile)).digest('hex').slice(0, 12);
            console.log(`Output hash: ${hash}  out/extension.js`);
        }
    }
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
