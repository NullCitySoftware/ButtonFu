/**
 * Shared token capture and replacement engine.
 *
 * Both ButtonExecutor (button actions) and PromptActionService (note actions)
 * use the same underlying token resolution logic. Keeping it here prevents
 * drift between the two code paths and ensures consistent behaviour for
 * system tokens like $GitBranch$ across buttons and notes.
 */

import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { SYSTEM_TOKENS } from './types';

/** Snapshot of all resolvable token values captured at invocation time. */
export interface TokenSnapshot {
    [tokenName: string]: string;
}

/**
 * Capture all system token values right now (at invocation time).
 *
 * @param aliasMap  Optional overrides keyed by lower-cased token name (e.g. `'$buttonname$'`).
 *                  Entries whose keys match a SYSTEM_TOKEN override the computed value.
 *                  Entries whose keys do NOT match any SYSTEM_TOKEN are injected verbatim
 *                  (e.g. `$NoteName$`, `$NoteScope$`).
 */
export function captureSystemTokens(aliasMap?: ReadonlyMap<string, string>): TokenSnapshot {
    const snap: TokenSnapshot = {};
    const editor = vscode.window.activeTextEditor;
    const wsFolder = vscode.workspace.workspaceFolders?.[0];

    for (const def of SYSTEM_TOKENS) {
        const key = def.token.toLowerCase();

        if (aliasMap?.has(key)) {
            snap[key] = aliasMap.get(key)!;
            continue;
        }

        let value = '';
        try {
            switch (def.token) {
                case '$WorkspacePath$':
                    value = wsFolder?.uri.fsPath ?? '';
                    break;
                case '$WorkspaceName$':
                    value = wsFolder?.name ?? vscode.workspace.name ?? '';
                    break;
                case '$FullActiveFilePath$':
                    value = editor?.document.uri.fsPath ?? '';
                    break;
                case '$ActiveFileName$':
                    value = editor ? path.basename(editor.document.uri.fsPath) : '';
                    break;
                case '$ActiveFileExtension$':
                    value = editor ? path.extname(editor.document.uri.fsPath) : '';
                    break;
                case '$ActiveFileDirectory$':
                    value = editor ? path.dirname(editor.document.uri.fsPath) : '';
                    break;
                case '$ActiveFileRelativePath$':
                    value = editor ? vscode.workspace.asRelativePath(editor.document.uri, false) : '';
                    break;
                case '$SelectedText$':
                    value = editor ? editor.document.getText(editor.selection) : '';
                    break;
                case '$CurrentLineNumber$':
                    value = editor ? String(editor.selection.active.line + 1) : '';
                    break;
                case '$CurrentColumnNumber$':
                    value = editor ? String(editor.selection.active.character + 1) : '';
                    break;
                case '$CurrentLineText$':
                    value = editor ? editor.document.lineAt(editor.selection.active.line).text : '';
                    break;
                case '$DateTime$':
                    value = new Date().toISOString();
                    break;
                case '$Date$':
                    value = new Date().toISOString().slice(0, 10);
                    break;
                case '$Time$':
                    value = new Date().toTimeString().slice(0, 8);
                    break;
                case '$Platform$':
                    value = process.platform;
                    break;
                case '$Hostname$':
                    value = os.hostname();
                    break;
                case '$Username$':
                    value = os.userInfo().username;
                    break;
                case '$HomeDirectory$':
                    value = os.homedir();
                    break;
                case '$TempDirectory$':
                    value = os.tmpdir();
                    break;
                case '$Clipboard$':
                    // Clipboard is async — callers must await captureClipboard() separately.
                    value = '';
                    break;
                case '$GitBranch$':
                    value = getGitBranch(wsFolder?.uri.fsPath);
                    break;
                case '$PathSeparator$':
                    value = path.sep;
                    break;
                case '$EOL$':
                    value = os.EOL;
                    break;
                case '$RandomUUID$':
                    value = crypto.randomUUID();
                    break;
                // $ButtonName$ and $ButtonType$ fall through to '' unless overridden via aliasMap.
            }
        } catch {
            value = '';
        }
        snap[key] = value;
    }

    // Inject alias entries that are not SYSTEM_TOKENS (e.g. $NoteName$, $NoteScope$).
    if (aliasMap) {
        for (const [key, value] of aliasMap) {
            snap[key] = value;
        }
    }

    return snap;
}

/** Find all distinct token references in text (case-insensitive deduplication). */
export function findTokensInText(text: string): string[] {
    const matches = text.match(/\$[A-Za-z_][A-Za-z0-9_]*\$/gi);
    if (!matches) { return []; }

    const seen = new Set<string>();
    const result: string[] = [];
    for (const match of matches) {
        const lower = match.toLowerCase();
        if (!seen.has(lower)) {
            seen.add(lower);
            result.push(match);
        }
    }
    return result;
}

/** Replace all token references in text using system-snapshot and user-provided values. */
export function replaceTokens(text: string, systemSnap: TokenSnapshot, userValues: TokenSnapshot): string {
    return text.replace(/\$[A-Za-z_][A-Za-z0-9_]*\$/gi, (match) => {
        const lower = match.toLowerCase();
        if (lower in systemSnap) { return systemSnap[lower]; }
        if (lower in userValues) { return userValues[lower]; }
        return match;
    });
}

/**
 * Resolve the current git branch for the given workspace path.
 *
 * Tries the VS Code git extension API first (most accurate), then falls back
 * to reading the .git/HEAD file directly.  The filesystem fallback is skipped
 * in untrusted workspaces as a security measure.
 */
export function getGitBranch(workspacePath?: string): string {
    if (!workspacePath) { return ''; }

    // Prefer the VS Code git extension — it handles complex repo layouts better.
    try {
        const gitExtension = vscode.extensions.getExtension<{ getAPI(version: number): any }>('vscode.git');
        if (gitExtension?.isActive) {
            const git = gitExtension.exports.getAPI(1);
            const repo = git.repositories.find((r: any) => {
                const repoRoot = r.rootUri?.fsPath;
                return repoRoot && path.normalize(repoRoot).toLowerCase() === path.normalize(workspacePath).toLowerCase();
            }) ?? git.repositories[0];
            if (repo?.state?.HEAD?.name) {
                return repo.state.HEAD.name;
            }
        }
    } catch { /* fall through to filesystem fallback */ }

    // Filesystem fallback — skip in untrusted workspaces.
    if (!vscode.workspace.isTrusted) {
        return '';
    }

    try {
        const headFile = resolveGitHeadFile(workspacePath);
        if (!headFile || !fs.existsSync(headFile)) { return ''; }
        const headStats = fs.lstatSync(headFile);
        if (!headStats.isFile() || headStats.isSymbolicLink()) { return ''; }
        const head = fs.readFileSync(headFile, 'utf8').trim();
        const match = head.match(/^ref:\s+refs\/heads\/(.+)$/);
        return match ? match[1] : head.slice(0, 8);
    } catch {
        return '';
    }
}

/** Resolve the path to the HEAD file, handling both normal repos and git worktrees. */
export function resolveGitHeadFile(workspacePath: string): string {
    const gitPath = path.join(workspacePath, '.git');
    if (!fs.existsSync(gitPath)) { return ''; }

    const stat = fs.statSync(gitPath);
    if (stat.isDirectory()) {
        const headFile = path.resolve(gitPath, 'HEAD');
        return isSupportedGitHeadFile(headFile) ? headFile : '';
    }
    if (!stat.isFile()) { return ''; }

    // Worktree: .git is a file containing "gitdir: <path>"
    const gitRef = fs.readFileSync(gitPath, 'utf8').trim();
    const match = gitRef.match(/^gitdir:\s*(.+)$/i);
    if (!match) { return ''; }

    const headFile = path.resolve(workspacePath, match[1], 'HEAD');
    return isSupportedGitHeadFile(headFile) ? headFile : '';
}

/**
 * Validate that a resolved HEAD file path sits inside an expected .git directory.
 * Prevents path-traversal attacks via crafted gitdir redirect values.
 */
export function isSupportedGitHeadFile(headFile: string): boolean {
    const normalized = path.resolve(headFile).replace(/\\/g, '/');
    return /\/\.git\/HEAD$/i.test(normalized)
        || /\/\.git\/(?:worktrees|modules)\/.+\/HEAD$/i.test(normalized);
}
