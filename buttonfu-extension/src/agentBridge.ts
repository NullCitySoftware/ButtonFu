/**
 * Named-pipe JSON-RPC bridge for external agent access to the ButtonFu API.
 *
 * Security model:
 *  - Transport: local IPC only (Windows named pipes / Unix domain sockets).
 *    On Unix, the bridge directory, socket file, and discovery file are
 *    chmod'd to restrictive permissions before use.
 *  - Authentication: per-session 256-bit random token verified with
 *    crypto.timingSafeEqual on every request.
 *  - Authorisation: strict static allowlist of ButtonFu API method names.
 *  - Rate limiting: per-connection sliding window (60 req / 60 s).
 *  - Resource caps: 1 MB max message, 3 max concurrent connections.
 *  - Discovery: bridge info (pipe name, auth token, PID) written to
 *    ~/.buttonfu/bridge-{pid}.json with restrictive permissions.
 *  - Lifecycle: stale bridge files are cleaned on start; bridge file and
 *    Unix socket are deleted on stop / deactivate.
 */

import * as net from 'net';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AGENT_BRIDGE_NAME, AGENT_BRIDGE_SCHEMA_VERSION, AUTOMATION_GUIDANCE, buildApiSchema } from './apiSchema';
import type { AutomationGuidance, BridgeContext } from './apiSchema';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Introspection methods handled directly by the bridge. */
const DESCRIBE_METHOD = 'buttonfu.api.describe';
const GET_BRIDGE_CONTEXT_METHOD = 'buttonfu.api.getBridgeContext';
const LIST_BRIDGES_METHOD = 'buttonfu.api.listBridges';
const BRIDGE_DISCOVERY_VERSION = 3;
const HEARTBEAT_INTERVAL_MS = 30_000;
const ALLOWED_METHODS: ReadonlySet<string> = new Set([
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
]);

const MAX_MESSAGE_BYTES = 1_048_576;        // 1 MB
const MAX_CONNECTIONS = 3;
const RATE_WINDOW_MS = 60_000;              // 60 s
const RATE_MAX_REQUESTS = 60;               // per connection per window
const AUTH_TOKEN_BYTES = 32;                // 256-bit token
export const STALE_BRIDGE_AGE_MS = 120_000; // 2 min with no heartbeat = stale
const WORKSPACE_MISMATCH_ERROR = -32003;

// JSON-RPC 2.0 error codes
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;
const AUTH_ERROR = -32000;
const RATE_LIMITED_ERROR = -32001;
const MESSAGE_TOO_LARGE_ERROR = -32002;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
    jsonrpc: string;
    id?: number | string | null;
    method: string;
    params?: unknown;
    auth?: string;
}

interface JsonRpcResponse {
    jsonrpc: '2.0';
    id: number | string | null;
    result?: unknown;
    error?: { code: number; message: string };
}

export interface BridgeInfo {
    discoveryVersion: number;
    bridgeName: string;
    extensionVersion: string;
    pipeName: string;
    authToken: string;
    protocol: 'jsonrpc-2.0';
    framing: 'newline-delimited';
    transportKind: 'named-pipe';
    describeMethod: string;
    schemaVersion: number;
    capabilities: string[];
    automationGuidance: AutomationGuidance;
    limits: {
        maxMessageBytes: number;
        maxConnections: number;
        rateLimitWindowMs: number;
        rateLimitMaxRequests: number;
    };
    pid: number;
    startedAt: string;
    lastHeartbeatAt: string;
    windowId: string;
    vscodePid: number;
    workspaceName: string;
    workspaceFolders: string[];
}

/** Minimal callable that mirrors `vscode.commands.executeCommand`. */
export type ExecuteCommandFn = (command: string, ...rest: unknown[]) => Thenable<unknown>;

/** Injectable log sink so tests can capture output without a real OutputChannel. */
export interface BridgeLogger {
    log(message: string): void;
}

/** Supplies workspace/window identity for bridge metadata. */
export interface WorkspaceContextProvider {
    getWindowId(): string;
    getVscodePid(): number;
    getWorkspaceName(): string;
    getWorkspaceFolders(): string[];
    getLocalButtonCount(): number;
    getGlobalButtonCount(): number;
    getLocalNoteCount(): number;
    getGlobalNoteCount(): number;
    hasWorkspace(): boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

export function getBridgeDirectory(): string {
    return path.join(os.homedir(), '.buttonfu');
}

export function getBridgeFilePath(pid: number): string {
    return path.join(getBridgeDirectory(), `bridge-${pid}.json`);
}

export function getPipeName(pid: number): string {
    return process.platform === 'win32'
        ? `\\\\.\\pipe\\buttonfu-vscode-${pid}`
        : path.join(getBridgeDirectory(), `buttonfu-vscode-${pid}.sock`);
}

function ensureSecureBridgeDirectory(): string {
    const bridgeDir = getBridgeDirectory();
    fs.mkdirSync(bridgeDir, { recursive: true, mode: 0o700 });

    if (process.platform !== 'win32') {
        fs.chmodSync(bridgeDir, 0o700);
        const permissions = fs.statSync(bridgeDir).mode & 0o777;
        if ((permissions & 0o077) !== 0) {
            throw new Error(`Bridge directory must not be group/world accessible: ${bridgeDir}`);
        }
    }

    return bridgeDir;
}

function writeBridgeInfoFile(filePath: string, info: BridgeInfo): void {
    const content = JSON.stringify(info, null, 2);

    if (process.platform === 'win32') {
        fs.writeFileSync(filePath, content, { encoding: 'utf-8' });
        return;
    }

    const tmpPath = `${filePath}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(tmpPath, content, { encoding: 'utf-8', mode: 0o600 });
        fs.renameSync(tmpPath, filePath);
        fs.chmodSync(filePath, 0o600);
    } finally {
        try { fs.unlinkSync(tmpPath); } catch { /* already renamed or absent */ }
    }
}

function removeUnixSocketFile(pipeName: string): void {
    if (!pipeName || process.platform === 'win32') {
        return;
    }

    try { fs.unlinkSync(pipeName); } catch { /* already gone */ }
}

function getJsonRpcErrorId(request: unknown): number | string | null {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
        return null;
    }

    const id = (request as { id?: unknown }).id;
    return id === null || typeof id === 'string' || typeof id === 'number'
        ? id
        : null;
}

function isNotificationRequest(request: unknown): boolean {
    return !!request
        && typeof request === 'object'
        && !Array.isArray(request)
        && !('id' in request);
}

function authTokensMatch(providedToken: string, expectedToken: string): boolean {
    const expectedBuf = Buffer.from(expectedToken, 'utf-8');
    const providedRaw = Buffer.from(providedToken, 'utf-8');
    const providedBuf = Buffer.alloc(expectedBuf.length);
    providedRaw.copy(providedBuf, 0, 0, expectedBuf.length);

    // Evaluate both conditions before combining to avoid short-circuit timing leaks.
    const lenMatch = providedRaw.length === expectedBuf.length;
    const tokensMatch = crypto.timingSafeEqual(providedBuf, expectedBuf);
    return tokensMatch && lenMatch;
}

function buildBridgeInfo(
    pid: number,
    pipeName: string,
    authToken: string,
    extensionVersion: string,
    workspaceCtx?: WorkspaceContextProvider
): BridgeInfo {
    const now = new Date().toISOString();
    return {
        discoveryVersion: BRIDGE_DISCOVERY_VERSION,
        bridgeName: AGENT_BRIDGE_NAME,
        extensionVersion,
        pipeName,
        authToken,
        protocol: 'jsonrpc-2.0',
        framing: 'newline-delimited',
        transportKind: 'named-pipe',
        describeMethod: DESCRIBE_METHOD,
        schemaVersion: AGENT_BRIDGE_SCHEMA_VERSION,
        capabilities: ['buttons', 'notes', 'introspection', 'batch-operations'],
        automationGuidance: AUTOMATION_GUIDANCE,
        limits: {
            maxMessageBytes: MAX_MESSAGE_BYTES,
            maxConnections: MAX_CONNECTIONS,
            rateLimitWindowMs: RATE_WINDOW_MS,
            rateLimitMaxRequests: RATE_MAX_REQUESTS
        },
        pid,
        startedAt: now,
        lastHeartbeatAt: now,
        windowId: workspaceCtx?.getWindowId() ?? '',
        vscodePid: workspaceCtx?.getVscodePid() ?? pid,
        workspaceName: workspaceCtx?.getWorkspaceName() ?? '',
        workspaceFolders: workspaceCtx?.getWorkspaceFolders() ?? []
    };
}

/** Remove bridge files whose owning PID is no longer alive or whose heartbeat is stale. */
export function cleanStaleBridgeFiles(): void {
    const dir = getBridgeDirectory();
    let entries: string[];
    try {
        entries = fs.readdirSync(dir);
    } catch {
        return; // directory doesn't exist yet — nothing to clean
    }

    const now = Date.now();
    for (const file of entries) {
        if (!file.startsWith('bridge-') || !file.endsWith('.json')) {
            continue;
        }

        const filePath = path.join(dir, file);
        try {
            const raw = fs.readFileSync(filePath, 'utf-8');
            const info: Partial<BridgeInfo> = JSON.parse(raw);
            const pidDead = typeof info.pid === 'number' && !isProcessAlive(info.pid);
            const heartbeatStale = typeof info.lastHeartbeatAt === 'string'
                && (now - new Date(info.lastHeartbeatAt).getTime()) > STALE_BRIDGE_AGE_MS;
            if (pidDead || heartbeatStale) {
                fs.unlinkSync(filePath);
            }
        } catch {
            // Corrupt or unreadable — remove it
            try { fs.unlinkSync(filePath); } catch { /* best effort */ }
        }
    }
}

/** List all live bridge files for external discovery. */
export function listBridgeFiles(): Array<Omit<BridgeInfo, 'authToken'>> {
    const dir = getBridgeDirectory();
    let entries: string[];
    try {
        entries = fs.readdirSync(dir);
    } catch {
        return [];
    }

    const results: Array<Omit<BridgeInfo, 'authToken'>> = [];
    for (const file of entries) {
        if (!file.startsWith('bridge-') || !file.endsWith('.json')) {
            continue;
        }

        const filePath = path.join(dir, file);
        try {
            const raw = fs.readFileSync(filePath, 'utf-8');
            const info: BridgeInfo = JSON.parse(raw);
            if (typeof info.pid === 'number' && isProcessAlive(info.pid)) {
                // Strip authToken for security — callers must read their own bridge file
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                const { authToken: _token, ...safe } = info;
                results.push(safe);
            }
        } catch {
            // skip corrupt files
        }
    }
    return results;
}

// ---------------------------------------------------------------------------
// AgentBridge
// ---------------------------------------------------------------------------

export class AgentBridge {
    private server: net.Server | null = null;
    private authToken = '';
    private bridgeFilePath = '';
    private pipeName = '';
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private readonly connections = new Set<net.Socket>();
    private readonly connectionRates = new WeakMap<net.Socket, number[]>();
    private disposed = false;
    private workspaceContext: WorkspaceContextProvider | undefined;

    constructor(
        private readonly executeCommand: ExecuteCommandFn,
        private readonly logger: BridgeLogger,
        private readonly extensionVersion: string = '0.0.0'
    ) {}

    get isRunning(): boolean {
        return this.server !== null && this.server.listening;
    }

    /** Inject a workspace context provider for bridge metadata enrichment. */
    setWorkspaceContext(provider: WorkspaceContextProvider): void {
        this.workspaceContext = provider;
    }

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    async start(): Promise<void> {
        if (this.server) {
            this.logger.log('[AgentBridge] Already running.');
            return;
        }
        this.disposed = false;

        this.authToken = crypto.randomBytes(AUTH_TOKEN_BYTES).toString('hex');

        const pid = process.pid;
        const pipeName = getPipeName(pid);

        ensureSecureBridgeDirectory();

        if (process.platform !== 'win32') {
            removeUnixSocketFile(pipeName);
        }

        this.server = net.createServer((socket) => this.onConnection(socket));
        this.server.maxConnections = MAX_CONNECTIONS;

        await new Promise<void>((resolve, reject) => {
            const onError = (err: Error) => {
                this.server = null;
                reject(err);
            };

            this.server!.once('error', onError);
            this.server!.listen(pipeName, () => {
                this.server!.removeListener('error', onError);

                if (process.platform !== 'win32') {
                    try {
                        fs.chmodSync(pipeName, 0o600);
                    } catch (err) {
                        this.server!.close(() => {
                            this.server = null;
                            removeUnixSocketFile(pipeName);
                            reject(err as Error);
                        });
                        return;
                    }
                }

                resolve();
            });
        });

        this.pipeName = pipeName;

        try {
            cleanStaleBridgeFiles();
            this.bridgeFilePath = getBridgeFilePath(pid);

            const info = buildBridgeInfo(pid, pipeName, this.authToken, this.extensionVersion, this.workspaceContext);
            writeBridgeInfoFile(this.bridgeFilePath, info);

            this.heartbeatTimer = setInterval(() => {
                if (!this.bridgeFilePath) {
                    return;
                }

                try {
                    const raw = fs.readFileSync(this.bridgeFilePath, 'utf-8');
                    const current: BridgeInfo = JSON.parse(raw);
                    current.lastHeartbeatAt = new Date().toISOString();
                    writeBridgeInfoFile(this.bridgeFilePath, current);
                } catch {
                    // best effort — file may be gone during shutdown
                }
            }, HEARTBEAT_INTERVAL_MS);
        } catch (err) {
            if (this.heartbeatTimer) {
                clearInterval(this.heartbeatTimer);
                this.heartbeatTimer = null;
            }

            if (this.server) {
                await new Promise<void>((resolve) => {
                    this.server!.close(() => resolve());
                });
                this.server = null;
            }

            removeUnixSocketFile(this.pipeName);
            this.pipeName = '';
            this.authToken = '';

            if (this.bridgeFilePath) {
                try { fs.unlinkSync(this.bridgeFilePath); } catch { /* already gone */ }
                this.bridgeFilePath = '';
            }

            throw err;
        }

        this.logger.log(`[AgentBridge] Listening on ${pipeName}`);
        this.logger.log(`[AgentBridge] Bridge info: ${this.bridgeFilePath}`);
    }

    async stop(): Promise<void> {
        if (this.disposed) {
            return;
        }
        this.disposed = true;

        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }

        for (const socket of this.connections) {
            socket.destroy();
        }
        this.connections.clear();

        if (this.server) {
            await new Promise<void>((resolve) => {
                this.server!.close(() => resolve());
            });
            this.server = null;
        }

        this.authToken = '';

        if (this.bridgeFilePath) {
            try { fs.unlinkSync(this.bridgeFilePath); } catch { /* already gone */ }
            this.bridgeFilePath = '';
        }

        removeUnixSocketFile(this.pipeName);
        this.pipeName = '';

        this.logger.log('[AgentBridge] Stopped.');
    }

    // ------------------------------------------------------------------
    // Connection handling
    // ------------------------------------------------------------------

    private onConnection(socket: net.Socket): void {
        if (this.connections.size >= MAX_CONNECTIONS) {
            socket.destroy();
            return;
        }

        this.connections.add(socket);
        this.connectionRates.set(socket, []);

        // Destroy sockets that connect but never send data within 30 s to prevent
        // slot exhaustion from idle connections.
        socket.setTimeout(30_000);
        socket.on('timeout', () => { socket.destroy(); });

        let buffer = '';

        socket.on('data', (chunk: Buffer) => {
            // First data received — cancel the idle-connection timeout.
            socket.setTimeout(0);

            buffer += chunk.toString('utf-8');

            if (Buffer.byteLength(buffer, 'utf-8') > MAX_MESSAGE_BYTES) {
                this.sendError(socket, null, MESSAGE_TOO_LARGE_ERROR, 'Message exceeds 1 MB limit.');
                socket.destroy();
                return;
            }

            let newlineIdx: number;
            while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
                const line = buffer.substring(0, newlineIdx).trim();
                buffer = buffer.substring(newlineIdx + 1);
                if (line) {
                    this.processMessage(socket, line).catch(() => {
                        socket.destroy();
                    });
                }
            }
        });

        socket.on('close', () => {
            this.connections.delete(socket);
        });

        socket.on('error', () => {
            this.connections.delete(socket);
        });
    }

    // ------------------------------------------------------------------
    // Message processing
    // ------------------------------------------------------------------

    private async processMessage(socket: net.Socket, raw: string): Promise<void> {
        let request: unknown;
        try {
            request = JSON.parse(raw);
        } catch {
            this.sendError(socket, null, PARSE_ERROR, 'Parse error.');
            return;
        }

        const isNotification = isNotificationRequest(request);

        const timestamps = this.connectionRates.get(socket);
        if (timestamps) {
            const now = Date.now();
            while (timestamps.length > 0 && now - timestamps[0] >= RATE_WINDOW_MS) {
                timestamps.shift();
            }
            if (timestamps.length >= RATE_MAX_REQUESTS) {
                if (!isNotification) {
                    this.sendError(socket, getJsonRpcErrorId(request), RATE_LIMITED_ERROR, 'Rate limit exceeded. Try again later.');
                }
                return;
            }
            timestamps.push(now);
        }

        if (
            !request ||
            typeof request !== 'object' ||
            Array.isArray(request) ||
            (request as JsonRpcRequest).jsonrpc !== '2.0' ||
            typeof (request as JsonRpcRequest).method !== 'string'
        ) {
            if (!isNotification) {
                this.sendError(socket, getJsonRpcErrorId(request), INVALID_REQUEST, 'Invalid JSON-RPC 2.0 request.');
            }
            return;
        }

        const rpcRequest = request as JsonRpcRequest;
        const id = rpcRequest.id ?? null;
        if (id !== null && typeof id !== 'string' && typeof id !== 'number') {
            this.sendError(socket, null, INVALID_REQUEST, 'Request id must be a string, number, or null.');
            return;
        }

        if (typeof rpcRequest.auth !== 'string') {
            if (!isNotification) {
                this.sendError(socket, id, AUTH_ERROR, 'Authentication required.');
            }
            return;
        }

        if (!authTokensMatch(rpcRequest.auth, this.authToken)) {
            if (!isNotification) {
                this.sendError(socket, id, AUTH_ERROR, 'Authentication failed.');
            }
            return;
        }

        if (rpcRequest.method === DESCRIBE_METHOD) {
            if (!isNotification) {
                this.sendResult(socket, id, buildApiSchema(this.extensionVersion));
            }
            return;
        }

        if (rpcRequest.method === GET_BRIDGE_CONTEXT_METHOD) {
            if (!isNotification) {
                this.sendResult(socket, id, this.buildBridgeContext());
            }
            return;
        }

        if (rpcRequest.method === LIST_BRIDGES_METHOD) {
            cleanStaleBridgeFiles();
            if (!isNotification) {
                this.sendResult(socket, id, { bridges: listBridgeFiles() });
            }
            return;
        }

        if (!ALLOWED_METHODS.has(rpcRequest.method)) {
            if (!isNotification) {
                this.sendError(socket, id, METHOD_NOT_FOUND, `Method not allowed: ${rpcRequest.method}`);
            }
            return;
        }

        const params = rpcRequest.params as Record<string, unknown> | undefined;
        if (params && typeof params === 'object' && typeof params.targetWindowId === 'string') {
            const currentWindowId = this.workspaceContext?.getWindowId() ?? '';
            if (currentWindowId && params.targetWindowId !== currentWindowId) {
                if (!isNotification) {
                    this.sendError(
                        socket,
                        id,
                        WORKSPACE_MISMATCH_ERROR,
                        `Workspace mismatch: request targeted windowId "${params.targetWindowId}" but this bridge belongs to windowId "${currentWindowId}".`
                    );
                }
                return;
            }
        }

        try {
            const result = await this.executeCommand(rpcRequest.method, rpcRequest.params);
            if (!isNotification) {
                const enriched = this.enrichResult(rpcRequest.method, result);
                this.sendResult(socket, id, enriched);
            }
        } catch (err: unknown) {
            if (!isNotification) {
                const message = err instanceof Error ? err.message : 'Internal error.';
                this.sendError(socket, id, INTERNAL_ERROR, message);
            }
        }
    }

    // ------------------------------------------------------------------
    // Bridge context & result enrichment
    // ------------------------------------------------------------------

    private buildBridgeContext(): BridgeContext {
        const ctx = this.workspaceContext;
        return {
            windowId: ctx?.getWindowId() ?? '',
            vscodePid: ctx?.getVscodePid() ?? process.pid,
            workspaceName: ctx?.getWorkspaceName() ?? '',
            workspaceFolders: ctx?.getWorkspaceFolders() ?? [],
            hasWorkspace: ctx?.hasWorkspace() ?? false,
            globalButtonCount: ctx?.getGlobalButtonCount() ?? 0,
            localButtonCount: ctx?.getLocalButtonCount() ?? 0,
            globalNoteCount: ctx?.getGlobalNoteCount() ?? 0,
            localNoteCount: ctx?.getLocalNoteCount() ?? 0
        };
    }

    /** Methods whose results should include bridge context for clarity. */
    private static readonly ENRICHABLE_METHODS = new Set([
        'buttonfu.api.createButton',
        'buttonfu.api.updateButton',
        'buttonfu.api.deleteButton',
        'buttonfu.api.createNote',
        'buttonfu.api.updateNote',
        'buttonfu.api.deleteNote'
    ]);

    /** Attach bridgeContext to mutation results so callers know which window was modified. */
    private enrichResult(method: string, result: unknown): unknown {
        if (!AgentBridge.ENRICHABLE_METHODS.has(method)) {
            return result;
        }
        if (!result || typeof result !== 'object') {
            return result;
        }
        const ctx = this.buildBridgeContext();
        if (Array.isArray(result)) {
            return result.map(item =>
                (item && typeof item === 'object')
                    ? { ...item, bridgeContext: ctx }
                    : item
            );
        }
        return { ...result, bridgeContext: ctx };
    }

    // ------------------------------------------------------------------
    // Response helpers
    // ------------------------------------------------------------------

    private sendResult(socket: net.Socket, id: number | string | null, result: unknown): void {
        if (socket.destroyed) {
            return;
        }
        try {
            const response: JsonRpcResponse = { jsonrpc: '2.0', id, result };
            socket.write(JSON.stringify(response) + '\n');
        } catch {
            this.sendError(socket, id, INTERNAL_ERROR, 'Response serialisation failed.');
        }
    }

    private sendError(socket: net.Socket, id: number | string | null, code: number, message: string): void {
        if (socket.destroyed) {
            return;
        }
        const response: JsonRpcResponse = { jsonrpc: '2.0', id, error: { code, message } };
        socket.write(JSON.stringify(response) + '\n');
    }
}