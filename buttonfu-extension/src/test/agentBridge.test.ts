import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { AgentBridge, BridgeInfo, getBridgeDirectory, getBridgeFilePath, cleanStaleBridgeFiles, listBridgeFiles } from '../agentBridge';
import type { ExecuteCommandFn, BridgeLogger, WorkspaceContextProvider } from '../agentBridge';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collects log messages for assertions. */
function createTestLogger(): BridgeLogger & { messages: string[] } {
    const messages: string[] = [];
    return { messages, log: (msg: string) => messages.push(msg) };
}

/** A fake executeCommand that records calls and returns a canned response. */
function createFakeExecuteCommand(
    response: unknown = { success: true, data: { id: 'btn-1' } }
): ExecuteCommandFn & { calls: Array<{ command: string; args: unknown[] }> } {
    const calls: Array<{ command: string; args: unknown[] }> = [];
    const fn = Object.assign(
        (command: string, ...rest: unknown[]): Thenable<unknown> => {
            calls.push({ command, args: rest });
            return Promise.resolve(response);
        },
        { calls }
    );
    return fn;
}

/** Read and parse the bridge info file for the current process. */
function readBridgeInfo(): BridgeInfo {
    const filePath = getBridgeFilePath(process.pid);
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

/** Create a fake workspace context for tests. */
function createFakeWorkspaceContext(overrides?: Partial<Record<keyof WorkspaceContextProvider, unknown>>): WorkspaceContextProvider {
    return {
        getWindowId: () => (overrides?.getWindowId as string) ?? 'test-window-42',
        getVscodePid: () => (overrides?.getVscodePid as number) ?? process.pid,
        getWorkspaceName: () => (overrides?.getWorkspaceName as string) ?? 'FakeWorkspace',
        getWorkspaceFolders: () => (overrides?.getWorkspaceFolders as string[]) ?? ['/tmp/fake-workspace'],
        getLocalButtonCount: () => (overrides?.getLocalButtonCount as number) ?? 2,
        getGlobalButtonCount: () => (overrides?.getGlobalButtonCount as number) ?? 5,
        getLocalNoteCount: () => (overrides?.getLocalNoteCount as number) ?? 1,
        getGlobalNoteCount: () => (overrides?.getGlobalNoteCount as number) ?? 3,
        hasWorkspace: () => (overrides?.hasWorkspace as boolean) ?? true
    };
}

/** Connect to the bridge pipe and return a helper for sending/receiving. */
function connectToBridge(pipeName: string): Promise<{
    socket: net.Socket;
    send(obj: Record<string, unknown>): void;
    readLine(): Promise<string>;
    destroy(): void;
}> {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(pipeName, () => {
            let buffer = '';
            const lineQueue: string[] = [];
            const waiters: Array<(line: string) => void> = [];

            socket.on('data', (chunk: Buffer) => {
                buffer += chunk.toString('utf-8');
                let idx: number;
                while ((idx = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.substring(0, idx).trim();
                    buffer = buffer.substring(idx + 1);
                    if (line) {
                        const waiter = waiters.shift();
                        if (waiter) {
                            waiter(line);
                        } else {
                            lineQueue.push(line);
                        }
                    }
                }
            });

            resolve({
                socket,
                send(obj: Record<string, unknown>): void {
                    socket.write(JSON.stringify(obj) + '\n');
                },
                readLine(): Promise<string> {
                    const queued = lineQueue.shift();
                    if (queued) {
                        return Promise.resolve(queued);
                    }
                    return new Promise((res) => {
                        waiters.push(res);
                    });
                },
                destroy(): void {
                    socket.destroy();
                }
            });
        });
        socket.on('error', reject);
    });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

test('bridge starts, writes bridge file, and stops cleanly', async () => {
    const logger = createTestLogger();
    const exec = createFakeExecuteCommand();
    const bridge = new AgentBridge(exec, logger, '1.2.3');
    bridge.setWorkspaceContext(createFakeWorkspaceContext());

    await bridge.start();
    assert.equal(bridge.isRunning, true);

    const info = readBridgeInfo();
    assert.equal(info.discoveryVersion, 3);
    assert.equal(info.bridgeName, 'ButtonFu Agent Bridge');
    assert.equal(info.extensionVersion, '1.2.3');
    assert.equal(info.pid, process.pid);
    assert.equal(typeof info.authToken, 'string');
    assert.equal(info.authToken.length, 64); // 32 bytes hex
    assert.ok(info.pipeName);
    assert.equal(info.protocol, 'jsonrpc-2.0');
    assert.equal(info.framing, 'newline-delimited');
    assert.equal(info.transportKind, 'named-pipe');
    assert.equal(info.describeMethod, 'buttonfu.api.describe');
    assert.equal(info.schemaVersion, 2);
    assert.deepEqual(info.capabilities, ['buttons', 'notes', 'introspection', 'batch-operations']);
    assert.deepEqual(info.limits, {
        maxMessageBytes: 1_048_576,
        maxConnections: 3,
        rateLimitWindowMs: 60_000,
        rateLimitMaxRequests: 60
    });

    // Workspace identity fields
    assert.equal(info.windowId, 'test-window-42');
    assert.equal(info.vscodePid, process.pid);
    assert.equal(info.workspaceName, 'FakeWorkspace');
    assert.deepEqual(info.workspaceFolders, ['/tmp/fake-workspace']);
    assert.ok(info.lastHeartbeatAt);
    assert.ok(info.startedAt);

    await bridge.stop();
    assert.equal(bridge.isRunning, false);
    assert.equal(fs.existsSync(getBridgeFilePath(process.pid)), false);
});

test('bridge start is idempotent', async () => {
    const logger = createTestLogger();
    const exec = createFakeExecuteCommand();
    const bridge = new AgentBridge(exec, logger);

    await bridge.start();
    await bridge.start(); // second call — should not throw
    assert.equal(bridge.isRunning, true);

    await bridge.stop();
});

test('bridge stop is idempotent', async () => {
    const logger = createTestLogger();
    const exec = createFakeExecuteCommand();
    const bridge = new AgentBridge(exec, logger);

    await bridge.start();
    await bridge.stop();
    await bridge.stop(); // second call — should not throw
    assert.equal(bridge.isRunning, false);
});

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

test('valid auth token allows request', async () => {
    const exec = createFakeExecuteCommand({ success: true, data: [] });
    const bridge = new AgentBridge(exec, createTestLogger());
    await bridge.start();

    try {
        const info = readBridgeInfo();
        const client = await connectToBridge(info.pipeName);
        client.send({
            jsonrpc: '2.0',
            id: 1,
            method: 'buttonfu.api.listButtons',
            auth: info.authToken
        });

        const raw = await client.readLine();
        const response = JSON.parse(raw);
        assert.equal(response.id, 1);
        assert.deepEqual(response.result, { success: true, data: [] });
        assert.equal(response.error, undefined);

        client.destroy();
    } finally {
        await bridge.stop();
    }
});

test('missing auth token returns auth error', async () => {
    const bridge = new AgentBridge(createFakeExecuteCommand(), createTestLogger());
    await bridge.start();

    try {
        const info = readBridgeInfo();
        const client = await connectToBridge(info.pipeName);
        client.send({ jsonrpc: '2.0', id: 2, method: 'buttonfu.api.listButtons' });

        const raw = await client.readLine();
        const response = JSON.parse(raw);
        assert.equal(response.error?.code, -32000);
        assert.ok(response.error?.message.includes('Authentication'));

        client.destroy();
    } finally {
        await bridge.stop();
    }
});

test('wrong auth token returns auth error', async () => {
    const bridge = new AgentBridge(createFakeExecuteCommand(), createTestLogger());
    await bridge.start();

    try {
        const info = readBridgeInfo();
        const client = await connectToBridge(info.pipeName);
        client.send({
            jsonrpc: '2.0',
            id: 3,
            method: 'buttonfu.api.listButtons',
            auth: 'deadbeef'.repeat(8)
        });

        const raw = await client.readLine();
        const response = JSON.parse(raw);
        assert.equal(response.error?.code, -32000);

        client.destroy();
    } finally {
        await bridge.stop();
    }
});

test('wrong-length auth token returns auth error', async () => {
    const bridge = new AgentBridge(createFakeExecuteCommand(), createTestLogger());
    await bridge.start();

    try {
        const info = readBridgeInfo();
        const client = await connectToBridge(info.pipeName);
        client.send({
            jsonrpc: '2.0',
            id: 4,
            method: 'buttonfu.api.listButtons',
            auth: 'short'
        });

        const raw = await client.readLine();
        const response = JSON.parse(raw);
        assert.equal(response.error?.code, -32000);

        client.destroy();
    } finally {
        await bridge.stop();
    }
});

// ---------------------------------------------------------------------------
// Method allowlist
// ---------------------------------------------------------------------------

test('allowed method is forwarded to executeCommand', async () => {
    const exec = createFakeExecuteCommand({ success: true, data: { id: 'btn-42' } });
    const bridge = new AgentBridge(exec, createTestLogger());
    await bridge.start();

    try {
        const info = readBridgeInfo();
        const client = await connectToBridge(info.pipeName);
        client.send({
            jsonrpc: '2.0',
            id: 10,
            method: 'buttonfu.api.createButton',
            params: { name: 'Test Widget', locality: 'Global' },
            auth: info.authToken
        });

        const raw = await client.readLine();
        const response = JSON.parse(raw);
        assert.equal(response.id, 10);
        assert.equal(response.result.success, true);
        assert.deepEqual(response.result.data, { id: 'btn-42' });
        // Mutation results include bridgeContext
        assert.ok(response.result.bridgeContext, 'createButton result should include bridgeContext');

        assert.equal(exec.calls.length, 1);
        assert.equal(exec.calls[0].command, 'buttonfu.api.createButton');
        assert.deepEqual(exec.calls[0].args, [{ name: 'Test Widget', locality: 'Global' }]);

        client.destroy();
    } finally {
        await bridge.stop();
    }
});

test('disallowed method returns method-not-found error', async () => {
    const exec = createFakeExecuteCommand();
    const bridge = new AgentBridge(exec, createTestLogger());
    await bridge.start();

    try {
        const info = readBridgeInfo();
        const client = await connectToBridge(info.pipeName);
        client.send({
            jsonrpc: '2.0',
            id: 11,
            method: 'workbench.action.openSettings',
            auth: info.authToken
        });

        const raw = await client.readLine();
        const response = JSON.parse(raw);
        assert.equal(response.error?.code, -32601);
        assert.equal(exec.calls.length, 0);

        client.destroy();
    } finally {
        await bridge.stop();
    }
});

test('all ten API methods are in the allowlist', async () => {
    const exec = createFakeExecuteCommand({ success: true });
    const bridge = new AgentBridge(exec, createTestLogger());
    await bridge.start();

    const allowed = [
        'buttonfu.api.createButton',
        'buttonfu.api.getButton',
        'buttonfu.api.listButtons',
        'buttonfu.api.updateButton',
        'buttonfu.api.deleteButton',
        'buttonfu.api.createNote',
        'buttonfu.api.getNote',
        'buttonfu.api.listNotes',
        'buttonfu.api.updateNote',
        'buttonfu.api.deleteNote'
    ];

    try {
        const info = readBridgeInfo();
        const client = await connectToBridge(info.pipeName);

        for (let i = 0; i < allowed.length; i++) {
            client.send({ jsonrpc: '2.0', id: 100 + i, method: allowed[i], auth: info.authToken });
            const raw = await client.readLine();
            const response = JSON.parse(raw);
            assert.equal(response.error, undefined, `${allowed[i]} should be allowed`);
        }

        client.destroy();
    } finally {
        await bridge.stop();
    }
});

// ---------------------------------------------------------------------------
// JSON-RPC validation
// ---------------------------------------------------------------------------

test('malformed JSON returns parse error', async () => {
    const bridge = new AgentBridge(createFakeExecuteCommand(), createTestLogger());
    await bridge.start();

    try {
        const info = readBridgeInfo();
        const client = await connectToBridge(info.pipeName);
        client.socket.write('this is not json\n');

        const raw = await client.readLine();
        const response = JSON.parse(raw);
        assert.equal(response.error?.code, -32700);

        client.destroy();
    } finally {
        await bridge.stop();
    }
});

test('missing jsonrpc field returns invalid-request error', async () => {
    const bridge = new AgentBridge(createFakeExecuteCommand(), createTestLogger());
    await bridge.start();

    try {
        const info = readBridgeInfo();
        const client = await connectToBridge(info.pipeName);
        client.send({ id: 1, method: 'buttonfu.api.listButtons', auth: info.authToken });

        const raw = await client.readLine();
        const response = JSON.parse(raw);
        assert.equal(response.error?.code, -32600);

        client.destroy();
    } finally {
        await bridge.stop();
    }
});

test('array payload returns invalid-request error', async () => {
    const bridge = new AgentBridge(createFakeExecuteCommand(), createTestLogger());
    await bridge.start();

    try {
        const info = readBridgeInfo();
        const client = await connectToBridge(info.pipeName);
        client.socket.write('[{"jsonrpc":"2.0","id":1,"method":"buttonfu.api.listButtons"}]\n');

        const raw = await client.readLine();
        const response = JSON.parse(raw);
        assert.equal(response.error?.code, -32600);

        client.destroy();
    } finally {
        await bridge.stop();
    }
});

test('non-string method returns invalid-request error', async () => {
    const bridge = new AgentBridge(createFakeExecuteCommand(), createTestLogger());
    await bridge.start();

    try {
        const info = readBridgeInfo();
        const client = await connectToBridge(info.pipeName);
        client.send({ jsonrpc: '2.0', id: 1, method: 42, auth: info.authToken });

        const raw = await client.readLine();
        const response = JSON.parse(raw);
        assert.equal(response.error?.code, -32600);

        client.destroy();
    } finally {
        await bridge.stop();
    }
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

test('requests beyond rate limit are rejected', async () => {
    const exec = createFakeExecuteCommand({ success: true });
    const bridge = new AgentBridge(exec, createTestLogger());
    await bridge.start();

    try {
        const info = readBridgeInfo();
        const client = await connectToBridge(info.pipeName);

        // Send 61 requests rapidly (limit is 60 per 60 s)
        for (let i = 0; i < 61; i++) {
            client.send({
                jsonrpc: '2.0',
                id: 200 + i,
                method: 'buttonfu.api.listButtons',
                auth: info.authToken
            });
        }

        // Read all 61 responses
        const responses: any[] = [];
        for (let i = 0; i < 61; i++) {
            const raw = await client.readLine();
            responses.push(JSON.parse(raw));
        }

        // First 60 should succeed, 61st should be rate-limited
        const rateLimited = responses.filter((r) => r.error?.code === -32001);
        assert.ok(rateLimited.length >= 1, 'At least one request should be rate-limited');

        const succeeded = responses.filter((r) => !r.error);
        assert.equal(succeeded.length, 60);

        client.destroy();
    } finally {
        await bridge.stop();
    }
});

// ---------------------------------------------------------------------------
// Command execution error handling
// ---------------------------------------------------------------------------

test('executeCommand rejection returns internal error', async () => {
    const exec: ExecuteCommandFn = () => Promise.reject(new Error('Store exploded'));
    const bridge = new AgentBridge(exec, createTestLogger());
    await bridge.start();

    try {
        const info = readBridgeInfo();
        const client = await connectToBridge(info.pipeName);
        client.send({
            jsonrpc: '2.0',
            id: 50,
            method: 'buttonfu.api.createButton',
            params: { name: 'Kaboom', locality: 'Global' },
            auth: info.authToken
        });

        const raw = await client.readLine();
        const response = JSON.parse(raw);
        assert.equal(response.error?.code, -32603);
        assert.ok(response.error?.message.includes('Store exploded'));

        client.destroy();
    } finally {
        await bridge.stop();
    }
});

// ---------------------------------------------------------------------------
// Stale bridge file cleanup
// ---------------------------------------------------------------------------

test('cleanStaleBridgeFiles removes files for dead PIDs', () => {
    const dir = getBridgeDirectory();
    fs.mkdirSync(dir, { recursive: true });

    // Write a bridge file with a PID that (almost certainly) doesn't exist
    const fakePid = 2_000_000_000;
    const fakePath = path.join(dir, `bridge-${fakePid}.json`);
    fs.writeFileSync(fakePath, JSON.stringify({ pid: fakePid, authToken: 'x', pipeName: 'x', startedAt: '', lastHeartbeatAt: new Date().toISOString() }));

    assert.ok(fs.existsSync(fakePath));
    cleanStaleBridgeFiles();
    assert.equal(fs.existsSync(fakePath), false);
});

test('cleanStaleBridgeFiles preserves files for live PIDs', () => {
    const dir = getBridgeDirectory();
    fs.mkdirSync(dir, { recursive: true });

    const livePath = path.join(dir, `bridge-${process.pid}.json`);
    fs.writeFileSync(livePath, JSON.stringify({ pid: process.pid, authToken: 'y', pipeName: 'y', startedAt: '', lastHeartbeatAt: new Date().toISOString() }));

    cleanStaleBridgeFiles();
    assert.ok(fs.existsSync(livePath));

    // Clean up
    fs.unlinkSync(livePath);
});

test('cleanStaleBridgeFiles removes files with stale heartbeat', () => {
    const dir = getBridgeDirectory();
    fs.mkdirSync(dir, { recursive: true });

    // Use current PID (alive) but very old heartbeat
    const stalePath = path.join(dir, `bridge-${process.pid}.json`);
    const oldDate = new Date(Date.now() - 300_000).toISOString(); // 5 min ago
    fs.writeFileSync(stalePath, JSON.stringify({ pid: process.pid, authToken: 'z', pipeName: 'z', startedAt: oldDate, lastHeartbeatAt: oldDate }));

    cleanStaleBridgeFiles();
    assert.equal(fs.existsSync(stalePath), false);
});

// ---------------------------------------------------------------------------
// Multiple messages on one connection
// ---------------------------------------------------------------------------

test('multiple sequential requests on one connection succeed', async () => {
    const exec = createFakeExecuteCommand({ success: true, data: [] });
    const bridge = new AgentBridge(exec, createTestLogger());
    await bridge.start();

    try {
        const info = readBridgeInfo();
        const client = await connectToBridge(info.pipeName);

        for (let i = 0; i < 5; i++) {
            client.send({
                jsonrpc: '2.0',
                id: 300 + i,
                method: 'buttonfu.api.listButtons',
                auth: info.authToken
            });

            const raw = await client.readLine();
            const response = JSON.parse(raw);
            assert.equal(response.id, 300 + i);
            assert.equal(response.error, undefined);
        }

        client.destroy();
    } finally {
        await bridge.stop();
    }
});

// ---------------------------------------------------------------------------
// Notification (no id) handling
// ---------------------------------------------------------------------------

test('notification (no id) executes the command but sends no response', async () => {
    const exec = createFakeExecuteCommand({ success: true });
    const bridge = new AgentBridge(exec, createTestLogger());
    await bridge.start();

    try {
        const info = readBridgeInfo();
        const client = await connectToBridge(info.pipeName);

        // Send notification (no id field)
        client.send({
            jsonrpc: '2.0',
            method: 'buttonfu.api.listButtons',
            auth: info.authToken
        });

        // Send a follow-up request with id to confirm the socket is still alive
        // and the notification was silently consumed.
        client.send({
            jsonrpc: '2.0',
            id: 'after-notification',
            method: 'buttonfu.api.listButtons',
            auth: info.authToken
        });

        const raw = await client.readLine();
        const response = JSON.parse(raw);
        // The first response we get should be from the follow-up request,
        // proving the notification produced no response.
        assert.equal(response.id, 'after-notification');
        assert.equal(response.error, undefined);

        client.destroy();
    } finally {
        await bridge.stop();
    }
});

// ---------------------------------------------------------------------------
// Introspection (describe)
// ---------------------------------------------------------------------------

test('describe returns API schema with methods, types, and error codes', async () => {
    const exec = createFakeExecuteCommand();
    const bridge = new AgentBridge(exec, createTestLogger(), '1.2.3');
    await bridge.start();

    try {
        const info = readBridgeInfo();
        const client = await connectToBridge(info.pipeName);
        client.send({
            jsonrpc: '2.0',
            id: 900,
            method: 'buttonfu.api.describe',
            auth: info.authToken
        });

        const raw = await client.readLine();
        const response = JSON.parse(raw);
        assert.equal(response.id, 900);
        assert.equal(response.error, undefined);

        const schema = response.result;
        assert.equal(schema.name, 'ButtonFu Agent Bridge');
        assert.equal(schema.version, '1.2.3');
        assert.equal(schema.schemaVersion, 2);
        assert.equal(schema.protocol, 'JSON-RPC 2.0 over newline-delimited named pipe');

        // 10 CRUD + 2 introspection methods
        const methodNames = schema.methods.map((m: { method: string }) => m.method);
        assert.ok(methodNames.includes('buttonfu.api.createButton'));
        assert.ok(methodNames.includes('buttonfu.api.listButtons'));
        assert.ok(methodNames.includes('buttonfu.api.createNote'));
        assert.ok(methodNames.includes('buttonfu.api.deleteNote'));
        assert.ok(methodNames.includes('buttonfu.api.getBridgeContext'));
        assert.ok(methodNames.includes('buttonfu.api.listBridges'));
        assert.equal(methodNames.length, 12);

        // Type definitions present
        assert.ok(schema.types.ButtonConfig);
        assert.ok(schema.types.NoteConfig);
        assert.ok(schema.types.UserToken);
        assert.ok(schema.types.TerminalTab);
        assert.ok(schema.types.BridgeContext);

        // Error codes documented (including new workspace mismatch)
        assert.equal(schema.errorCodes[-32000], 'Authentication failed — missing or wrong auth token.');
        assert.equal(schema.errorCodes[-32601], 'Method not found — method is not in the allowlist.');
        assert.equal(schema.errorCodes[-32003], 'Workspace mismatch — targetWindowId does not match this bridge.');

        // Authentication guidance present
        assert.ok(schema.authentication.includes('auth'));

        client.destroy();
    } finally {
        await bridge.stop();
    }
});

test('describe requires authentication', async () => {
    const exec = createFakeExecuteCommand();
    const bridge = new AgentBridge(exec, createTestLogger());
    await bridge.start();

    try {
        const info = readBridgeInfo();
        const client = await connectToBridge(info.pipeName);
        client.send({
            jsonrpc: '2.0',
            id: 901,
            method: 'buttonfu.api.describe'
        });

        const raw = await client.readLine();
        const response = JSON.parse(raw);
        assert.equal(response.error?.code, -32000);

        client.destroy();
    } finally {
        await bridge.stop();
    }
});

test('describe does not invoke executeCommand', async () => {
    const exec = createFakeExecuteCommand();
    const bridge = new AgentBridge(exec, createTestLogger());
    await bridge.start();

    try {
        const info = readBridgeInfo();
        const client = await connectToBridge(info.pipeName);
        client.send({
            jsonrpc: '2.0',
            id: 902,
            method: 'buttonfu.api.describe',
            auth: info.authToken
        });

        await client.readLine();
        assert.equal(exec.calls.length, 0, 'describe must not call executeCommand');

        client.destroy();
    } finally {
        await bridge.stop();
    }
});

// ---------------------------------------------------------------------------
// getBridgeContext
// ---------------------------------------------------------------------------

test('getBridgeContext returns workspace identity and store counts', async () => {
    const exec = createFakeExecuteCommand();
    const bridge = new AgentBridge(exec, createTestLogger(), '1.2.3');
    bridge.setWorkspaceContext(createFakeWorkspaceContext());
    await bridge.start();

    try {
        const info = readBridgeInfo();
        const client = await connectToBridge(info.pipeName);
        client.send({
            jsonrpc: '2.0',
            id: 950,
            method: 'buttonfu.api.getBridgeContext',
            auth: info.authToken
        });

        const raw = await client.readLine();
        const response = JSON.parse(raw);
        assert.equal(response.id, 950);
        assert.equal(response.error, undefined);

        const ctx = response.result;
        assert.equal(ctx.windowId, 'test-window-42');
        assert.equal(ctx.vscodePid, process.pid);
        assert.equal(ctx.workspaceName, 'FakeWorkspace');
        assert.deepEqual(ctx.workspaceFolders, ['/tmp/fake-workspace']);
        assert.equal(ctx.hasWorkspace, true);
        assert.equal(ctx.globalButtonCount, 5);
        assert.equal(ctx.localButtonCount, 2);
        assert.equal(ctx.globalNoteCount, 3);
        assert.equal(ctx.localNoteCount, 1);

        assert.equal(exec.calls.length, 0, 'getBridgeContext must not call executeCommand');

        client.destroy();
    } finally {
        await bridge.stop();
    }
});

test('getBridgeContext requires authentication', async () => {
    const bridge = new AgentBridge(createFakeExecuteCommand(), createTestLogger());
    await bridge.start();

    try {
        const info = readBridgeInfo();
        const client = await connectToBridge(info.pipeName);
        client.send({
            jsonrpc: '2.0',
            id: 951,
            method: 'buttonfu.api.getBridgeContext'
        });

        const raw = await client.readLine();
        const response = JSON.parse(raw);
        assert.equal(response.error?.code, -32000);

        client.destroy();
    } finally {
        await bridge.stop();
    }
});

// ---------------------------------------------------------------------------
// listBridges
// ---------------------------------------------------------------------------

test('listBridges returns live bridge entries without auth tokens', async () => {
    const exec = createFakeExecuteCommand();
    const bridge = new AgentBridge(exec, createTestLogger(), '1.2.3');
    bridge.setWorkspaceContext(createFakeWorkspaceContext());
    await bridge.start();

    try {
        const info = readBridgeInfo();
        const client = await connectToBridge(info.pipeName);
        client.send({
            jsonrpc: '2.0',
            id: 960,
            method: 'buttonfu.api.listBridges',
            auth: info.authToken
        });

        const raw = await client.readLine();
        const response = JSON.parse(raw);
        assert.equal(response.id, 960);
        assert.equal(response.error, undefined);

        const bridges = response.result.bridges;
        assert.ok(Array.isArray(bridges));
        assert.ok(bridges.length >= 1);

        // Find our own bridge
        const own = bridges.find((b: any) => b.pid === process.pid);
        assert.ok(own, 'should find own bridge in listing');
        assert.equal(own.authToken, undefined, 'authToken must be redacted');
        assert.equal(own.workspaceName, 'FakeWorkspace');

        assert.equal(exec.calls.length, 0, 'listBridges must not call executeCommand');

        client.destroy();
    } finally {
        await bridge.stop();
    }
});

// ---------------------------------------------------------------------------
// Workspace mismatch targeting
// ---------------------------------------------------------------------------

test('targetWindowId mismatch returns workspace mismatch error', async () => {
    const exec = createFakeExecuteCommand({ success: true, data: { id: 'btn-1' } });
    const bridge = new AgentBridge(exec, createTestLogger());
    bridge.setWorkspaceContext(createFakeWorkspaceContext({ getWindowId: 'window-A' }));
    await bridge.start();

    try {
        const info = readBridgeInfo();
        const client = await connectToBridge(info.pipeName);
        client.send({
            jsonrpc: '2.0',
            id: 970,
            method: 'buttonfu.api.createButton',
            params: { name: 'Test', locality: 'Local', targetWindowId: 'window-B' },
            auth: info.authToken
        });

        const raw = await client.readLine();
        const response = JSON.parse(raw);
        assert.equal(response.error?.code, -32003);
        assert.ok(response.error?.message.includes('window-B'));
        assert.equal(exec.calls.length, 0, 'mismatched request must not reach executeCommand');

        client.destroy();
    } finally {
        await bridge.stop();
    }
});

test('matching targetWindowId allows request through', async () => {
    const exec = createFakeExecuteCommand({ success: true, data: { id: 'btn-2' } });
    const bridge = new AgentBridge(exec, createTestLogger());
    bridge.setWorkspaceContext(createFakeWorkspaceContext({ getWindowId: 'window-A' }));
    await bridge.start();

    try {
        const info = readBridgeInfo();
        const client = await connectToBridge(info.pipeName);
        client.send({
            jsonrpc: '2.0',
            id: 971,
            method: 'buttonfu.api.createButton',
            params: { name: 'Test', locality: 'Local', targetWindowId: 'window-A' },
            auth: info.authToken
        });

        const raw = await client.readLine();
        const response = JSON.parse(raw);
        assert.equal(response.error, undefined);
        assert.equal(exec.calls.length, 1);

        client.destroy();
    } finally {
        await bridge.stop();
    }
});

// ---------------------------------------------------------------------------
// Result enrichment with bridgeContext
// ---------------------------------------------------------------------------

test('mutation responses include bridgeContext', async () => {
    const exec = createFakeExecuteCommand({ success: true, data: { id: 'btn-99' } });
    const bridge = new AgentBridge(exec, createTestLogger());
    bridge.setWorkspaceContext(createFakeWorkspaceContext());
    await bridge.start();

    try {
        const info = readBridgeInfo();
        const client = await connectToBridge(info.pipeName);
        client.send({
            jsonrpc: '2.0',
            id: 980,
            method: 'buttonfu.api.createButton',
            params: { name: 'Enriched', locality: 'Global' },
            auth: info.authToken
        });

        const raw = await client.readLine();
        const response = JSON.parse(raw);
        assert.equal(response.error, undefined);
        assert.ok(response.result.bridgeContext, 'mutation result should include bridgeContext');
        assert.equal(response.result.bridgeContext.windowId, 'test-window-42');
        assert.equal(response.result.bridgeContext.workspaceName, 'FakeWorkspace');

        client.destroy();
    } finally {
        await bridge.stop();
    }
});

test('read-only responses do not include bridgeContext', async () => {
    const exec = createFakeExecuteCommand({ success: true, data: [] });
    const bridge = new AgentBridge(exec, createTestLogger());
    bridge.setWorkspaceContext(createFakeWorkspaceContext());
    await bridge.start();

    try {
        const info = readBridgeInfo();
        const client = await connectToBridge(info.pipeName);
        client.send({
            jsonrpc: '2.0',
            id: 981,
            method: 'buttonfu.api.listButtons',
            auth: info.authToken
        });

        const raw = await client.readLine();
        const response = JSON.parse(raw);
        assert.equal(response.error, undefined);
        assert.equal(response.result.bridgeContext, undefined, 'read-only result should not have bridgeContext');

        client.destroy();
    } finally {
        await bridge.stop();
    }
});

// ---------------------------------------------------------------------------
// listBridgeFiles
// ---------------------------------------------------------------------------

test('listBridgeFiles returns entries without authToken', () => {
    const dir = getBridgeDirectory();
    fs.mkdirSync(dir, { recursive: true });

    const testPath = path.join(dir, `bridge-${process.pid}.json`);
    fs.writeFileSync(testPath, JSON.stringify({
        pid: process.pid,
        authToken: 'secret-token-xxx',
        pipeName: 'test-pipe',
        startedAt: new Date().toISOString(),
        lastHeartbeatAt: new Date().toISOString(),
        windowId: 'win-1',
        workspaceName: 'TestWs'
    }));

    try {
        const results = listBridgeFiles();
        const own = results.find(b => b.pid === process.pid);
        assert.ok(own);
        assert.equal((own as any).authToken, undefined, 'authToken must be stripped');
        assert.equal(own.windowId, 'win-1');
    } finally {
        fs.unlinkSync(testPath);
    }
});
