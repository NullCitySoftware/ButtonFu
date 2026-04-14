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
const os = require('os');

// ── Resolve bridge file ─────────────────────────────────────────────────

function findBridgeFile() {
    const dir = path.join(os.homedir(), '.buttonfu');
    if (!fs.existsSync(dir)) {
        throw new Error(`Bridge directory not found: ${dir}. Is buttonfu.enableAgentBridge set to true?`);
    }

    const files = fs.readdirSync(dir)
        .filter(f => f.startsWith('bridge-') && f.endsWith('.json'))
        .map(f => ({ name: f, full: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);

    if (files.length === 0) {
        throw new Error(`No bridge files found in ${dir}. Enable the Agent Bridge in ButtonFu settings.`);
    }

    for (const f of files) {
        try {
            const info = JSON.parse(fs.readFileSync(f.full, 'utf-8'));
            process.kill(info.pid, 0); // throws if dead
            return f.full;
        } catch {
            // skip dead or corrupt
        }
    }

    throw new Error('No live bridge found. All bridge files belong to dead processes.');
}

// ── Main ────────────────────────────────────────────────────────────────

function main() {
    const args = process.argv.slice(2);
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
        console.log(`Usage: node buttonfu-bridge.js <method> [paramsJson]

Methods: describe, listButtons, createButton, updateButton, deleteButton,
         listNotes, createNote, updateNote, deleteNote, getBridgeContext, listBridges

Examples:
  node buttonfu-bridge.js listButtons
  node buttonfu-bridge.js createButton '{"name":"Run Tests","locality":"Global","type":"TerminalCommand","executionText":"npm test"}'`);
        process.exit(0);
    }

    const methodArg = args[0];
    const paramsArg = args[1];

    const bridgePath = findBridgeFile();
    const bridge = JSON.parse(fs.readFileSync(bridgePath, 'utf-8'));

    const fullMethod = methodArg.startsWith('buttonfu.api.') ? methodArg : `buttonfu.api.${methodArg}`;

    const rpc = {
        jsonrpc: '2.0',
        id: 1,
        method: fullMethod,
        auth: bridge.authToken,
    };

    if (paramsArg) {
        rpc.params = JSON.parse(paramsArg);
    }

    const body = JSON.stringify(rpc) + '\n';

    const socket = net.createConnection(bridge.pipeName, () => {
        socket.write(body);
    });
    const responseTimeout = setTimeout(() => {
        console.error('Timeout waiting for bridge response.');
        socket.destroy();
        process.exit(1);
    }, 5000);

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
