#!/usr/bin/env node
/**
 * ButtonFu Agent Bridge CLI helper (Node.js).
 *
 * Discovers a running ButtonFu Agent Bridge, connects to its named pipe,
 * and sends a JSON-RPC 2.0 request.
 *
 * IMPORTANT — Automation rule
 * ────────────────────────────
 * All button and note mutations MUST go through the ButtonFu Agent Bridge
 * or the registered buttonfu.api.* VS Code commands.
 * Do NOT mutate ButtonFu data by editing VS Code storage, state.vscdb,
 * the nullcity.buttonfu workspace memento, or buttonfu.globalButtons
 * settings directly. Direct writes bypass validation, provenance tracking,
 * UI refresh, and may corrupt or lose data.
 *
 * Usage:
 *   node buttonfu-bridge.js <method> [paramsJson]
 *
 * Examples:
 *   node buttonfu-bridge.js listButtons
 *   node buttonfu-bridge.js describe
 *   node buttonfu-bridge.js createButton '{"name":"Run Tests","locality":"Global","type":"TerminalCommand","executionText":"npm test"}'
 */

'use strict';

const net = require('net');
const fs = require('fs');
const path = require('path');
const { describeBridge, resolveBridge } = require('./bridge-discovery');

function parseBooleanArg(value, flagName) {
    if (value === undefined) {
        throw new Error(`${flagName} requires a value of true or false.`);
    }
    if (value === 'true') {
        return true;
    }
    if (value === 'false') {
        return false;
    }
    throw new Error(`${flagName} must be true or false.`);
}

function buildParamsFromFlags(options) {
    const params = {};
    const assign = (key, value) => {
        if (value !== undefined) {
            params[key] = value;
        }
    };

    assign('id', options.id);
    assign('name', options.name);
    assign('locality', options.locality);
    assign('type', options.type);
    assign('executionText', options.executionText);
    assign('description', options.description);
    assign('category', options.category);
    assign('icon', options.icon);
    assign('colour', options.colour);
    assign('sortOrder', options.sortOrder);
    assign('warnBeforeExecution', options.warnBeforeExecution);
    assign('openEditor', options.openEditor);
    assign('targetWindowId', options.targetWindowId);

    return Object.keys(params).length > 0 ? params : undefined;
}

function isLocalMutationWithoutWorkspace(fullMethod, bridge, params) {
    const workspaceFolders = Array.isArray(bridge.workspaceFolders) ? bridge.workspaceFolders : [];
    if (workspaceFolders.length > 0) {
        return false;
    }

    const mutatingMethods = new Set([
        'buttonfu.api.createButton',
        'buttonfu.api.updateButton',
        'buttonfu.api.deleteButton',
        'buttonfu.api.createNote',
        'buttonfu.api.updateNote',
        'buttonfu.api.deleteNote',
    ]);
    if (!mutatingMethods.has(fullMethod)) {
        return false;
    }

    if (!params || typeof params !== 'object') {
        return false;
    }

    const locality = typeof params.locality === 'string' ? params.locality : '';
    return locality.toLowerCase() === 'local';
}

function parseArgs(argv) {
    const options = {
        method: undefined,
        paramsJson: undefined,
        bridgePid: undefined,
        bridgeFile: undefined,
        windowId: undefined,
        workspacePath: undefined,
        workspaceName: undefined,
        timeoutMs: 5000,
        id: undefined,
        name: undefined,
        locality: undefined,
        type: undefined,
        executionText: undefined,
        description: undefined,
        category: undefined,
        icon: undefined,
        colour: undefined,
        sortOrder: undefined,
        warnBeforeExecution: undefined,
        openEditor: undefined,
        targetWindowId: undefined,
        allowNoWorkspaceLocalMutation: false,
    };

    const positional = [];
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        switch (arg) {
            case '--help':
            case '-h':
                options.help = true;
                break;
            case '--bridge-pid':
                options.bridgePid = Number(argv[++index]);
                break;
            case '--bridge-file':
                options.bridgeFile = argv[++index];
                break;
            case '--window-id':
                options.windowId = argv[++index];
                break;
            case '--workspace-path':
                options.workspacePath = argv[++index];
                break;
            case '--workspace-name':
                options.workspaceName = argv[++index];
                break;
            case '--timeout-ms':
                options.timeoutMs = Number(argv[++index]);
                break;
            case '--id':
                options.id = argv[++index];
                break;
            case '--name':
                options.name = argv[++index];
                break;
            case '--locality':
                options.locality = argv[++index];
                break;
            case '--type':
                options.type = argv[++index];
                break;
            case '--execution-text':
                options.executionText = argv[++index];
                break;
            case '--description':
                options.description = argv[++index];
                break;
            case '--category':
                options.category = argv[++index];
                break;
            case '--icon':
                options.icon = argv[++index];
                break;
            case '--colour':
                options.colour = argv[++index];
                break;
            case '--sort-order':
                options.sortOrder = Number(argv[++index]);
                break;
            case '--warn-before-execution':
                options.warnBeforeExecution = parseBooleanArg(argv[++index], '--warn-before-execution');
                break;
            case '--open-editor':
                options.openEditor = parseBooleanArg(argv[++index], '--open-editor');
                break;
            case '--target-window-id':
                options.targetWindowId = argv[++index];
                break;
            case '--allow-no-workspace-local-mutation':
                options.allowNoWorkspaceLocalMutation = true;
                break;
            default:
                positional.push(arg);
                break;
        }
    }

    options.method = positional[0];
    options.paramsJson = positional[1];
    return options;
}

// ── Main ────────────────────────────────────────────────────────────────

function main() {
    const options = parseArgs(process.argv.slice(2));
    if (!options.method || options.help) {
        console.log(`Usage: node buttonfu-bridge.js [selectors] <method> [paramsJson]

Methods: describe, listButtons, createButton, updateButton, deleteButton,
         listNotes, createNote, updateNote, deleteNote, getBridgeContext, listBridges

Selectors:
  --bridge-pid <pid>
  --bridge-file <path>
  --window-id <windowId>
  --workspace-path <path>
  --workspace-name <name>
  --timeout-ms <ms>

Common button params (alternative to paramsJson for create/update/delete):
    --id <id>
    --name <name>
    --locality <Global|Local>
    --type <TerminalCommand|PaletteAction|TaskExecution|CopilotCommand>
    --execution-text <text>
    --description <text>
    --category <name>
    --icon <codicon>
    --colour <hex-or-theme-token>
    --sort-order <number>
    --warn-before-execution <true|false>
    --open-editor <true|false>
    --target-window-id <windowId>
    --allow-no-workspace-local-mutation

Examples:
  node buttonfu-bridge.js listButtons
  node buttonfu-bridge.js --workspace-path "p:\\Source\\DotNet\\_Other\\ButtonFu" listButtons
    node buttonfu-bridge.js --workspace-path "p:\\Source\\DotNet\\_Other\\ButtonFu" createButton --name "Run Tests" --locality Local --type TaskExecution --execution-text "Drive.NET: manifest smoke - buttonfu-extension" --category Testing --icon beaker --warn-before-execution true
  node buttonfu-bridge.js createButton '{"name":"Run Tests","locality":"Global","type":"TerminalCommand","executionText":"npm test"}'`);
        process.exit(0);
    }

    const bridge = resolveBridge({
        bridgePid: options.bridgePid,
        bridgeFile: options.bridgeFile,
        windowId: options.windowId,
        workspacePath: options.workspacePath,
        workspaceName: options.workspaceName,
        cwdPath: process.cwd(),
    });

    const fullMethod = options.method.startsWith('buttonfu.api.') ? options.method : `buttonfu.api.${options.method}`;

    console.error(`Using bridge: ${describeBridge(bridge)} file=${bridge.__filePath}`);

    const rpc = {
        jsonrpc: '2.0',
        id: 1,
        method: fullMethod,
        auth: bridge.authToken,
    };

    if (options.paramsJson) {
        rpc.params = JSON.parse(options.paramsJson);
    } else {
        const paramsFromFlags = buildParamsFromFlags(options);
        if (paramsFromFlags !== undefined) {
            rpc.params = paramsFromFlags;
        }
    }

    if (!options.allowNoWorkspaceLocalMutation && isLocalMutationWithoutWorkspace(fullMethod, bridge, rpc.params)) {
        const windowId = bridge.windowId || '(unknown)';
        throw new Error(
            `Refusing local mutation on bridge window ${windowId} because it has no workspace folders. ` +
            'Use --workspace-path or --window-id for the intended workspace window, or pass --allow-no-workspace-local-mutation to override intentionally.'
        );
    }

    const body = JSON.stringify(rpc) + '\n';

    const socket = net.createConnection(bridge.pipeName, () => {
        socket.write(body);
    });
    const responseTimeout = setTimeout(() => {
        console.error('Timeout waiting for bridge response.');
        socket.destroy();
        process.exit(1);
    }, options.timeoutMs);

    const clearResponseTimeout = () => {
        clearTimeout(responseTimeout);
    };

    let buffer = '';
    socket.on('data', (chunk) => {
        buffer += chunk.toString('utf-8');
        const idx = buffer.indexOf('\n');
        if (idx !== -1) {
            const line = buffer.substring(0, idx).trim();
            if (line) {
                try {
                    const parsed = JSON.parse(line);
                    console.log(JSON.stringify(parsed, null, 2));
                } catch {
                    console.log(line);
                }
            }
            clearResponseTimeout();
            socket.destroy();
        }
    });

    socket.on('error', (err) => {
        clearResponseTimeout();
        console.error(`Bridge connection error: ${err.message}`);
        process.exit(1);
    });

    socket.on('close', clearResponseTimeout);
}

main();
