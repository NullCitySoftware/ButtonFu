import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

const runtimeRequire = createRequire(__filename);

const bridgeDiscovery = runtimeRequire(path.resolve(__dirname, '..', '..', 'scripts', 'bridge-discovery.js')) as {
    listLiveBridges(options?: Record<string, unknown>): Array<Record<string, unknown>>;
    resolveBridge(options?: Record<string, unknown>): Record<string, unknown>;
};

function createFakeFs(files: Record<string, string>) {
    const normalizedFiles = new Map<string, string>();
    const directories = new Set<string>();

    for (const [filePath, content] of Object.entries(files)) {
        const resolved = path.resolve(filePath);
        normalizedFiles.set(resolved, content);
        let current = path.dirname(resolved);
        directories.add(current);
        while (current !== path.dirname(current)) {
            current = path.dirname(current);
            directories.add(current);
        }
    }

    return {
        existsSync(targetPath: string): boolean {
            const resolved = path.resolve(targetPath);
            return normalizedFiles.has(resolved) || directories.has(resolved);
        },
        readdirSync(targetPath: string): string[] {
            const resolved = path.resolve(targetPath);
            const children = new Set<string>();
            for (const filePath of normalizedFiles.keys()) {
                if (path.dirname(filePath) === resolved) {
                    children.add(path.basename(filePath));
                }
            }
            return [...children];
        },
        readFileSync(targetPath: string): string {
            const resolved = path.resolve(targetPath);
            const value = normalizedFiles.get(resolved);
            if (value === undefined) {
                throw new Error(`ENOENT: ${resolved}`);
            }
            return value;
        },
        statSync(targetPath: string): { mtimeMs: number } {
            const resolved = path.resolve(targetPath);
            if (!normalizedFiles.has(resolved)) {
                throw new Error(`ENOENT: ${resolved}`);
            }
            const match = /bridge-(\d+)\.json$/i.exec(resolved);
            return { mtimeMs: match ? Number(match[1]) : 0 };
        }
    };
}

function createBridgeFile(bridgeDirectory: string, bridge: {
    pid: number;
    windowId: string;
    workspaceName: string;
    workspaceFolders: string[];
}): [string, string] {
    const filePath = path.join(bridgeDirectory, `bridge-${bridge.pid}.json`);
    return [filePath, JSON.stringify({
        pid: bridge.pid,
        pipeName: `\\\\.\\pipe\\buttonfu-vscode-${bridge.pid}`,
        authToken: `token-${bridge.pid}`,
        windowId: bridge.windowId,
        vscodePid: bridge.pid,
        workspaceName: bridge.workspaceName,
        workspaceFolders: bridge.workspaceFolders
    })];
}

test('resolveBridge returns the sole live bridge', () => {
    const bridgeDirectory = path.resolve('/bridges');
    const fsImpl = createFakeFs(Object.fromEntries([
        createBridgeFile(bridgeDirectory, {
            pid: 101,
            windowId: 'window-101',
            workspaceName: 'ButtonFu',
            workspaceFolders: ['p:/Source/DotNet/_Other/ButtonFu']
        })
    ]));

    const bridge = bridgeDiscovery.resolveBridge({
        bridgeDirectory,
        fsImpl,
        isPidAlive: () => true
    });

    assert.equal(bridge.pid, 101);
});

test('resolveBridge prefers a unique current-working-directory workspace match', () => {
    const bridgeDirectory = path.resolve('/bridges');
    const fsImpl = createFakeFs(Object.fromEntries([
        createBridgeFile(bridgeDirectory, {
            pid: 101,
            windowId: 'window-101',
            workspaceName: 'FluidBars',
            workspaceFolders: ['p:/Source/DotNet/FluidBars']
        }),
        createBridgeFile(bridgeDirectory, {
            pid: 202,
            windowId: 'window-202',
            workspaceName: 'ButtonFu',
            workspaceFolders: ['p:/Source/DotNet/_Other/ButtonFu']
        })
    ]));

    const bridge = bridgeDiscovery.resolveBridge({
        bridgeDirectory,
        cwdPath: 'p:/Source/DotNet/_Other/ButtonFu/buttonfu-extension',
        fsImpl,
        isPidAlive: () => true
    });

    assert.equal(bridge.pid, 202);
});

test('resolveBridge uses explicit workspacePath selector', () => {
    const bridgeDirectory = path.resolve('/bridges');
    const fsImpl = createFakeFs(Object.fromEntries([
        createBridgeFile(bridgeDirectory, {
            pid: 101,
            windowId: 'window-101',
            workspaceName: 'FluidBars',
            workspaceFolders: ['p:/Source/DotNet/FluidBars']
        }),
        createBridgeFile(bridgeDirectory, {
            pid: 202,
            windowId: 'window-202',
            workspaceName: 'ButtonFu',
            workspaceFolders: ['p:/Source/DotNet/_Other/ButtonFu']
        })
    ]));

    const bridge = bridgeDiscovery.resolveBridge({
        bridgeDirectory,
        workspacePath: 'p:/Source/DotNet/_Other/ButtonFu',
        fsImpl,
        isPidAlive: () => true
    });

    assert.equal(bridge.pid, 202);
});

test('resolveBridge uses explicit windowId selector', () => {
    const bridgeDirectory = path.resolve('/bridges');
    const fsImpl = createFakeFs(Object.fromEntries([
        createBridgeFile(bridgeDirectory, {
            pid: 101,
            windowId: 'window-101',
            workspaceName: 'FluidBars',
            workspaceFolders: ['p:/Source/DotNet/FluidBars']
        }),
        createBridgeFile(bridgeDirectory, {
            pid: 202,
            windowId: 'window-202',
            workspaceName: 'ButtonFu',
            workspaceFolders: ['p:/Source/DotNet/_Other/ButtonFu']
        })
    ]));

    const bridge = bridgeDiscovery.resolveBridge({
        bridgeDirectory,
        windowId: 'window-202',
        fsImpl,
        isPidAlive: () => true
    });

    assert.equal(bridge.pid, 202);
});

test('resolveBridge ignores dead processes during discovery', () => {
    const bridgeDirectory = path.resolve('/bridges');
    const fsImpl = createFakeFs(Object.fromEntries([
        createBridgeFile(bridgeDirectory, {
            pid: 101,
            windowId: 'window-101',
            workspaceName: 'Dead Workspace',
            workspaceFolders: ['p:/dead']
        }),
        createBridgeFile(bridgeDirectory, {
            pid: 202,
            windowId: 'window-202',
            workspaceName: 'ButtonFu',
            workspaceFolders: ['p:/Source/DotNet/_Other/ButtonFu']
        })
    ]));

    const bridges = bridgeDiscovery.listLiveBridges({
        bridgeDirectory,
        fsImpl,
        isPidAlive: (pid: number) => pid === 202
    });

    assert.deepEqual(bridges.map((bridge) => bridge.pid), [202]);
});

test('resolveBridge fails closed when multiple live bridges remain ambiguous', () => {
    const bridgeDirectory = path.resolve('/bridges');
    const fsImpl = createFakeFs(Object.fromEntries([
        createBridgeFile(bridgeDirectory, {
            pid: 101,
            windowId: 'window-101',
            workspaceName: 'FluidBars',
            workspaceFolders: ['p:/Source/DotNet/FluidBars']
        }),
        createBridgeFile(bridgeDirectory, {
            pid: 202,
            windowId: 'window-202',
            workspaceName: 'SpectraWrite',
            workspaceFolders: ['p:/Source/DotNet/SpectraWrite']
        })
    ]));

    assert.throws(() => bridgeDiscovery.resolveBridge({
        bridgeDirectory,
        cwdPath: 'p:/Source/DotNet/_Other/ButtonFu/buttonfu-extension',
        fsImpl,
        isPidAlive: () => true
    }), /Multiple live bridges were found/);
});

test('resolveBridge fails when workspace name matches multiple bridges', () => {
    const bridgeDirectory = path.resolve('/bridges');
    const fsImpl = createFakeFs(Object.fromEntries([
        createBridgeFile(bridgeDirectory, {
            pid: 101,
            windowId: 'window-101',
            workspaceName: 'ButtonFu',
            workspaceFolders: ['p:/Source/DotNet/_Other/ButtonFu']
        }),
        createBridgeFile(bridgeDirectory, {
            pid: 202,
            windowId: 'window-202',
            workspaceName: 'ButtonFu',
            workspaceFolders: ['p:/Source/DotNet/_Other/ButtonFu-Second']
        })
    ]));

    assert.throws(() => bridgeDiscovery.resolveBridge({
        bridgeDirectory,
        workspaceName: 'ButtonFu',
        fsImpl,
        isPidAlive: () => true
    }), /Multiple live bridges matched workspace name ButtonFu/);
});
