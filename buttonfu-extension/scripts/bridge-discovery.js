'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function getDefaultBridgeDirectory() {
    return path.join(os.homedir(), '.buttonfu');
}

function canonicalizePath(filePath) {
    const resolved = path.resolve(filePath);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function normalizePathSeparators(filePath) {
    return filePath.replace(/[\\/]+/g, path.sep);
}

function isSameOrDescendantPath(candidatePath, rootPath) {
    const relative = path.relative(rootPath, candidatePath);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function describeBridge(bridge) {
    const workspaceLabel = bridge.workspaceName || '(none)';
    const folders = Array.isArray(bridge.workspaceFolders) && bridge.workspaceFolders.length > 0
        ? bridge.workspaceFolders.join(', ')
        : '(none)';
    return `pid=${bridge.pid} windowId=${bridge.windowId || '(none)'} workspace=${workspaceLabel} folders=${folders}`;
}

function parseBridgeInfo(filePath, fsImpl) {
    const raw = fsImpl.readFileSync(filePath, 'utf-8');
    const info = JSON.parse(raw);
    return { ...info, __filePath: filePath };
}

function listLiveBridges(options = {}) {
    const fsImpl = options.fsImpl || fs;
    const bridgeDirectory = options.bridgeDirectory || getDefaultBridgeDirectory();
    const isPidAlive = options.isPidAlive || ((pid) => {
        process.kill(pid, 0);
        return true;
    });

    if (!fsImpl.existsSync(bridgeDirectory)) {
        return [];
    }

    const files = fsImpl.readdirSync(bridgeDirectory)
        .filter((fileName) => fileName.startsWith('bridge-') && fileName.endsWith('.json'))
        .map((fileName) => path.join(bridgeDirectory, fileName));

    const bridges = [];
    for (const filePath of files) {
        try {
            const bridge = parseBridgeInfo(filePath, fsImpl);
            if (typeof bridge.pid !== 'number') {
                continue;
            }
            if (!isPidAlive(bridge.pid)) {
                continue;
            }
            const stats = fsImpl.statSync(filePath);
            bridges.push({ ...bridge, __mtimeMs: stats.mtimeMs });
        } catch {
            // Skip corrupt or dead bridge files.
        }
    }

    bridges.sort((left, right) => right.__mtimeMs - left.__mtimeMs);
    return bridges;
}

function filterByWorkspacePath(bridges, workspacePath) {
    const canonicalTarget = canonicalizePath(normalizePathSeparators(workspacePath));
    return bridges.filter((bridge) => Array.isArray(bridge.workspaceFolders) && bridge.workspaceFolders.some((folder) => {
        const canonicalFolder = canonicalizePath(normalizePathSeparators(folder));
        return isSameOrDescendantPath(canonicalTarget, canonicalFolder) || isSameOrDescendantPath(canonicalFolder, canonicalTarget);
    }));
}

function requireSingleBridge(candidates, reason) {
    if (candidates.length === 1) {
        return candidates[0];
    }

    if (candidates.length === 0) {
        throw new Error(`No live bridge matched ${reason}.`);
    }

    const details = candidates.map((bridge) => `- ${describeBridge(bridge)}`).join('\n');
    throw new Error(`Multiple live bridges matched ${reason}. Use an explicit selector.\n${details}`);
}

function resolveBridge(options = {}) {
    const fsImpl = options.fsImpl || fs;
    const bridgeDirectory = options.bridgeDirectory || getDefaultBridgeDirectory();
    const bridges = listLiveBridges({
        bridgeDirectory,
        fsImpl,
        isPidAlive: options.isPidAlive
    });

    if (options.bridgeFile) {
        if (!fsImpl.existsSync(options.bridgeFile)) {
            throw new Error(`Bridge file not found: ${options.bridgeFile}`);
        }
        return parseBridgeInfo(options.bridgeFile, fsImpl);
    }

    if (typeof options.bridgePid === 'number' && Number.isFinite(options.bridgePid)) {
        return requireSingleBridge(bridges.filter((bridge) => bridge.pid === options.bridgePid), `bridge pid ${options.bridgePid}`);
    }

    if (options.windowId) {
        return requireSingleBridge(bridges.filter((bridge) => bridge.windowId === options.windowId), `window id ${options.windowId}`);
    }

    if (options.workspacePath) {
        return requireSingleBridge(filterByWorkspacePath(bridges, options.workspacePath), `workspace path ${options.workspacePath}`);
    }

    if (options.workspaceName) {
        return requireSingleBridge(bridges.filter((bridge) => bridge.workspaceName === options.workspaceName), `workspace name ${options.workspaceName}`);
    }

    if (options.cwdPath) {
        const workspaceMatches = filterByWorkspacePath(bridges, options.cwdPath);
        if (workspaceMatches.length === 1) {
            return workspaceMatches[0];
        }
        if (workspaceMatches.length > 1) {
            return requireSingleBridge(workspaceMatches, `current working directory ${options.cwdPath}`);
        }
    }

    if (bridges.length === 1) {
        return bridges[0];
    }

    if (bridges.length === 0) {
        throw new Error(`No live bridge found in ${bridgeDirectory}. Enable the Agent Bridge in ButtonFu settings.`);
    }

    const details = bridges.map((bridge) => `- ${describeBridge(bridge)}`).join('\n');
    throw new Error(
        `Multiple live bridges were found and none matched the current working directory. ` +
        `Use --bridge-pid, --bridge-file, --window-id, --workspace-path, or --workspace-name.\n${details}`
    );
}

module.exports = {
    canonicalizePath,
    describeBridge,
    getDefaultBridgeDirectory,
    listLiveBridges,
    resolveBridge
};
