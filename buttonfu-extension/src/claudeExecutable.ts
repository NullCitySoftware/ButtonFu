/**
 * Locates the Claude Code CLI.
 *
 * Resolution order is fixed: the `buttonfu.claude.executablePath` setting, then `claude` on
 * `PATH`, then the binary bundled with the Claude Code extension. The probes are injected so the
 * order can be tested without a real machine; the session service supplies real ones at run time.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** The lookups executable resolution needs, injected so the order is testable. */
export interface ClaudeExecutableProbes {
    /** The configured `buttonfu.claude.executablePath`, or undefined when it is unset. */
    settingPath: () => string | undefined;
    /** Looks a bare command name up on `PATH`, returning its full path. */
    pathLookup: (name: string) => string | undefined;
    /** Returns an installed extension's directory, or undefined when it is not installed. */
    extensionPath: (id: string) => string | undefined;
    /** True when the given path exists on disk. */
    fileExists: (p: string) => boolean;
    /** Platform identifier. Defaults to the host's. */
    platform?: () => string;
}

/** The extension whose bundled binary is the last resort. */
export const CLAUDE_EXTENSION_ID = 'anthropic.claude-code';

/** Which of the three sources answered. */
export type ClaudeExecutableSource = 'setting' | 'path' | 'extension';

/** A resolved executable and where it came from. */
export interface ResolvedClaudeExecutable {
    path: string;
    source: ClaudeExecutableSource;
}

/**
 * Resolves the Claude executable, or returns undefined when none of the three sources answer.
 *
 * The bundled binary and a `claude` on `PATH` are frequently different versions, which is why the
 * source travels with the path: the caller logs it.
 */
export function resolveClaudeExecutableDetailed(
    probes: ClaudeExecutableProbes
): ResolvedClaudeExecutable | undefined {
    const configured = probes.settingPath()?.trim();
    if (configured) {
        return { path: configured, source: 'setting' };
    }

    const onPath = probes.pathLookup('claude');
    if (onPath) {
        return { path: onPath, source: 'path' };
    }

    const extensionDirectory = probes.extensionPath(CLAUDE_EXTENSION_ID);
    if (extensionDirectory) {
        const platform = probes.platform ? probes.platform() : process.platform;
        const binary = platform === 'win32' ? 'claude.exe' : 'claude';
        const bundled = path.join(extensionDirectory, 'resources', 'native-binary', binary);
        if (probes.fileExists(bundled)) {
            return { path: bundled, source: 'extension' };
        }
    }

    return undefined;
}

/** Resolves the Claude executable path, or undefined when none of the three sources answer. */
export function resolveClaudeExecutable(probes: ClaudeExecutableProbes): string | undefined {
    return resolveClaudeExecutableDetailed(probes)?.path;
}

/** The message shown when no Claude executable can be found. Names both fixes. */
export function describeMissingClaude(): string {
    return 'Claude Code was not found. Install the CLI so that "claude" is on your PATH, '
        + 'or set "buttonfu.claude.executablePath" to the full path of the Claude executable.';
}

/** The IDE server a Claude Code extension published for one VS Code window. */
export interface ClaudeIdeLock {
    /** The localhost port the IDE server listens on. */
    port: number;
    /** The token a client presents to that server. */
    authToken: string;
}

/** Where the Claude Code extension writes its per-window IDE lock files. */
export function claudeIdeLockDirectory(): string {
    return path.join(os.homedir(), '.claude', 'ide');
}

/**
 * Finds the IDE server belonging to the VS Code window this extension host runs in.
 *
 * A terminal picks the port up from the window's environment variable collection, but a process
 * spawned straight from the extension host does not, because that collection is applied when VS
 * Code creates a terminal rather than to the host itself. The lock file records the **window**
 * process, and the extension host is its child, so the entry whose `pid` matches `process.ppid`
 * is this window's and no other. Matching on workspace folders instead would be wrong: a machine
 * running several windows over the same folders leaves overlapping and stale locks behind.
 */
export function findWindowIdeLock(
    windowPid: number = process.ppid,
    directory: string = claudeIdeLockDirectory()
): ClaudeIdeLock | undefined {
    let entries: string[];
    try {
        entries = fs.readdirSync(directory);
    } catch {
        return undefined;
    }

    for (const entry of entries) {
        if (!entry.endsWith('.lock')) {
            continue;
        }

        try {
            const parsed = JSON.parse(fs.readFileSync(path.join(directory, entry), 'utf8')) as Record<string, unknown>;
            if (parsed.pid !== windowPid) {
                continue;
            }

            // The port is the file name; the body carries it too on some versions.
            const port = Number(typeof parsed.port === 'number' ? parsed.port : entry.slice(0, -'.lock'.length));
            if (!Number.isInteger(port) || port <= 0) {
                continue;
            }

            return { port, authToken: typeof parsed.authToken === 'string' ? parsed.authToken : '' };
        } catch {
            // A half-written or abandoned lock. Skip it.
        }
    }

    return undefined;
}
