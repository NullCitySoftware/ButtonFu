/**
 * Syntax-checks the button editor's webview script.
 *
 * The script lives inside a TypeScript template literal in `src/editorPanel.ts`, which means the
 * TypeScript compiler only ever sees it as a string: a stray bracket in there compiles cleanly and
 * then shows up as a blank editor at runtime, with nothing to say why. This pulls the script back
 * out and hands it to `node --check`.
 *
 * The template's `${...}` placeholders become `null`, and the escapes the template literal needs
 * are unescaped, so what gets checked is what the browser would actually receive.
 */

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SOURCE = path.resolve(__dirname, '..', 'src', 'editorPanel.ts');
const OPENING_TAG = '    <script nonce="${nonce}">';
const CLOSING_TAG = '    </script>';

function extractWebviewScript(source) {
    const start = source.indexOf(OPENING_TAG);
    if (start === -1) {
        throw new Error(`Could not find the webview script opening tag in ${SOURCE}.`);
    }

    const bodyStart = source.indexOf('\n', start) + 1;
    const end = source.indexOf(CLOSING_TAG, bodyStart);
    if (end === -1) {
        throw new Error(`Could not find the webview script closing tag in ${SOURCE}.`);
    }

    return source
        .slice(bodyStart, end)
        // A placeholder can hold anything; as an expression statement, null stands in for all of them.
        .replace(/\$\{[^}]*\}/g, 'null')
        // Inside a template literal these are escaped. The browser sees them unescaped.
        .replace(/\\`/g, '`')
        .replace(/\\\$/g, '$');
}

function main() {
    const script = extractWebviewScript(fs.readFileSync(SOURCE, 'utf8'));
    const checkPath = path.join(os.tmpdir(), `buttonfu-webview-check-${process.pid}.js`);

    fs.writeFileSync(checkPath, script, 'utf8');
    try {
        const result = childProcess.spawnSync(process.execPath, ['--check', checkPath], { stdio: 'inherit' });
        if (result.error) {
            throw result.error;
        }
        if (result.status !== 0) {
            console.error(`\nThe editor webview script does not parse. It lives in ${SOURCE}.`);
            process.exit(result.status ?? 1);
        }
    } finally {
        try {
            fs.unlinkSync(checkPath);
        } catch {
            // Already gone. Nothing to do.
        }
    }
}

try {
    main();
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
}
