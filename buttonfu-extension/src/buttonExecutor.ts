import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { ButtonConfig, TerminalTab, SYSTEM_TOKENS } from './types';
import { detectShellKind, shellEscape, ShellKind } from './utils';
import { PromptActionService } from './promptActionService';

/** Snapshot of all resolvable values captured at invocation time */
export interface TokenSnapshot {
    [tokenName: string]: string;
}

/**
 * Executes button actions based on their type.
 */
export class ButtonExecutor {
    private readonly promptActions = new PromptActionService();

    /** Capture all system token values right now (at button click time) */
    captureSystemTokens(button: ButtonConfig): TokenSnapshot {
        const snap: TokenSnapshot = {};
        const editor = vscode.window.activeTextEditor;
        const wsFolder = vscode.workspace.workspaceFolders?.[0];

        for (const def of SYSTEM_TOKENS) {
            const key = def.token.toLowerCase();
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
                    case '$ButtonName$':
                        value = button.name;
                        break;
                    case '$ButtonType$':
                        value = button.type;
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
                        // clipboard is async — we pre-populate empty; callers should await separately
                        value = '';
                        break;
                    case '$GitBranch$':
                        value = this.getGitBranch(wsFolder?.uri.fsPath);
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
                }
            } catch {
                value = '';
            }
            snap[key] = value;
        }

        return snap;
    }

    /** Capture clipboard asynchronously and merge into snapshot — only if $Clipboard$ is used */
    async captureClipboard(button: ButtonConfig, snap: TokenSnapshot): Promise<void> {
        const commandText = this.getAllCommandText(button);
        if (!/\$Clipboard\$/i.test(commandText)) {
            snap['$clipboard$'] = '';
            return;
        }
        try {
            snap['$clipboard$'] = await vscode.env.clipboard.readText();
        } catch {
            snap['$clipboard$'] = '';
        }
    }

    /** Get all command text from a button (covers both legacy executionText and new terminals array) */
    private getAllCommandText(button: ButtonConfig): string {
        if (button.terminals && button.terminals.length > 0) {
            return button.terminals.map(t => t.commands).join('\n');
        }
        return button.executionText || '';
    }

    /** Find all tokens used in the execution text */
    findTokensInText(text: string): string[] {
        const regex = /\$[A-Za-z_][A-Za-z0-9_]*\$/gi;
        const matches = text.match(regex);
        if (!matches) { return []; }
        // Deduplicate (case-insensitive)
        const seen = new Set<string>();
        const result: string[] = [];
        for (const m of matches) {
            const lower = m.toLowerCase();
            if (!seen.has(lower)) {
                seen.add(lower);
                result.push(m);
            }
        }
        return result;
    }

    /** Replace all tokens in text using snapshot + user values */
    replaceTokens(text: string, systemSnap: TokenSnapshot, userValues: TokenSnapshot): string {
        return text.replace(/\$[A-Za-z_][A-Za-z0-9_]*\$/gi, (match) => {
            const lower = match.toLowerCase();
            if (lower in systemSnap) { return systemSnap[lower]; }
            if (lower in userValues) { return userValues[lower]; }
            return match; // leave unreplaced if unknown
        });
    }

    /**
     * System tokens whose values may contain arbitrary external content
     * and must be shell-escaped when injected into terminal commands.
     *
     * Security note: ButtonFu buttons are user-authored and equivalent to
     * shell scripts. However, when buttons are shared (e.g. committed to
     * workspace settings), tokens like $SelectedText$ and $Clipboard$ can
     * carry content from untrusted sources. Shell-escaping these values
     * prevents accidental command injection via crafted editor selections
     * or clipboard contents.
     */
    private static readonly SHELL_ESCAPE_TOKENS = new Set([
        '$selectedtext$',
        '$clipboard$',
        '$currentlinetext$',
    ]);

    /** Replace tokens with shell-escaping for values injected into terminal commands */
    replaceTokensForTerminal(text: string, systemSnap: TokenSnapshot, userValues: TokenSnapshot, shellKind: ShellKind): string {
        return text.replace(/\$[A-Za-z_][A-Za-z0-9_]*\$/gi, (match) => {
            const lower = match.toLowerCase();
            const needsEscape = ButtonExecutor.SHELL_ESCAPE_TOKENS.has(lower);
            if (lower in systemSnap) {
                return needsEscape ? shellEscape(systemSnap[lower], shellKind) : systemSnap[lower];
            }
            if (lower in userValues) {
                // All user-provided token values are shell-escaped for terminal safety
                return shellEscape(userValues[lower], shellKind);
            }
            return match;
        });
    }

    private getTerminalShellKind(): ShellKind {
        return detectShellKind(vscode.env.shell);
    }

    /** Determine which user tokens need input (used in text and have no default value) */
    getUnresolvedUserTokens(button: ButtonConfig, systemSnap: TokenSnapshot): { token: string; label: string; description: string; dataType: string; required: boolean }[] {
        const usedTokens = this.findTokensInText(this.getAllCommandText(button));
        const usedLower = new Set(usedTokens.map(t => t.toLowerCase()));
        const result: { token: string; label: string; description: string; dataType: string; required: boolean }[] = [];

        for (const ut of (button.userTokens || [])) {
            const tokLower = ut.token.toLowerCase();
            if (!usedLower.has(tokLower)) { continue; }
            if (tokLower in systemSnap) { continue; } // system token takes priority
            if (ut.defaultValue !== undefined && ut.defaultValue !== '') {
                // Has a default — resolved
                continue;
            }
            result.push({
                token: ut.token,
                label: ut.label || ut.token,
                description: ut.description || '',
                dataType: ut.dataType || 'String',
                required: ut.required ?? false
            });
        }
        return result;
    }

    /** Get resolved user tokens (ones that have default values) that are used in text */
    getResolvedUserTokens(button: ButtonConfig, systemSnap: TokenSnapshot): { token: string; label: string; value: string; dataType: string }[] {
        const usedTokens = this.findTokensInText(this.getAllCommandText(button));
        const usedLower = new Set(usedTokens.map(t => t.toLowerCase()));
        const result: { token: string; label: string; value: string; dataType: string }[] = [];

        for (const ut of (button.userTokens || [])) {
            const tokLower = ut.token.toLowerCase();
            if (!usedLower.has(tokLower)) { continue; }
            if (tokLower in systemSnap) { continue; }
            if (ut.defaultValue !== undefined && ut.defaultValue !== '') {
                result.push({
                    token: ut.token,
                    label: ut.label || ut.token,
                    value: ut.defaultValue,
                    dataType: ut.dataType || 'String'
                });
            }
        }
        return result;
    }

    /** Get system tokens that are actually used in the text */
    getUsedSystemTokens(button: ButtonConfig, systemSnap: TokenSnapshot): { token: string; value: string; description: string }[] {
        const usedTokens = this.findTokensInText(this.getAllCommandText(button));
        const usedLower = new Set(usedTokens.map(t => t.toLowerCase()));
        const result: { token: string; value: string; description: string }[] = [];

        for (const def of SYSTEM_TOKENS) {
            const tokLower = def.token.toLowerCase();
            if (usedLower.has(tokLower)) {
                result.push({
                    token: def.token,
                    value: systemSnap[tokLower] ?? '',
                    description: def.description
                });
            }
        }
        return result;
    }

    /** Execute a button's configured action with full token replacement */
    async executeWithTokens(button: ButtonConfig, systemSnap: TokenSnapshot, userValues: TokenSnapshot): Promise<void> {
        const allUserValues = { ...userValues };
        // Add resolved user tokens (those with defaults)
        for (const ut of (button.userTokens || [])) {
            const tokLower = ut.token.toLowerCase();
            if (!(tokLower in allUserValues) && ut.defaultValue !== undefined && ut.defaultValue !== '') {
                allUserValues[tokLower] = ut.defaultValue;
            }
        }

        // Use shell-escaped replacement for terminal commands to prevent injection
        const isTerminal = button.type === 'TerminalCommand';
        const terminalShellKind = isTerminal ? this.getTerminalShellKind() : undefined;
        const replaceFn = isTerminal
            ? (text: string) => this.replaceTokensForTerminal(text, systemSnap, allUserValues, terminalShellKind!)
            : (text: string) => this.replaceTokens(text, systemSnap, allUserValues);

        const replacedTerminals = button.terminals?.map(t => ({
            ...t,
            commands: replaceFn(t.commands)
        }));
        const replaced = {
            ...button,
            executionText: replaceFn(button.executionText || ''),
            terminals: replacedTerminals
        };
        await this.executeInternal(replaced);
    }

    /** Execute a button's configured action */
    async execute(button: ButtonConfig): Promise<void> {
        await this.executeInternal(button);
    }

    private async executeInternal(button: ButtonConfig): Promise<void> {
        switch (button.type) {
            case 'TerminalCommand':
                await this.executeTerminalCommand(button);
                break;
            case 'PaletteAction':
                await this.executePaletteAction(button);
                break;
            case 'TaskExecution':
                await this.executeTask(button);
                break;
            case 'CopilotCommand':
                await this.executeCopilotCommand(button);
                break;
            default:
                console.error(`ButtonFu: unexpected button type "${button.type}" — this may indicate an unmigrated legacy button`);
                vscode.window.showErrorMessage(`Unknown button type: ${button.type}`);
        }
    }

    /** Run a command in the default terminal */
    private async executeTerminalCommand(button: ButtonConfig): Promise<void> {
        const tabs = button.terminals;

        // Legacy path: no tabs defined, use raw executionText
        if (!tabs || tabs.length === 0) {
            const terminal = vscode.window.createTerminal(`ButtonFu: ${button.name}`);
            terminal.show();
            const lines = (button.executionText || '').split(/\r?\n/);
            for (const line of lines) {
                terminal.sendText(line);
            }
            return;
        }

        const hasAnyDependency = tabs.some(t => t.dependentOnPrevious);

        if (hasAnyDependency) {
            // Mixed sequential/parallel: each tab that is marked dependentOnPrevious waits
            // for the previous tab to succeed before starting.
            let previousPromise: Promise<boolean> = Promise.resolve(true);
            for (const tab of tabs) {
                if (tab.dependentOnPrevious) {
                    const ok = await previousPromise;
                    if (!ok) {
                        vscode.window.showErrorMessage(`ButtonFu: Terminal "${tab.name}" skipped because the previous terminal failed.`);
                        return;
                    }
                }
                previousPromise = this.runTerminalTabAndWait(button, tab);
            }
            await previousPromise;
        } else {
            // All independent: fire all terminals at once
            for (const tab of tabs) {
                const terminal = vscode.window.createTerminal(`ButtonFu: ${button.name} — ${tab.name}`);
                terminal.show();
                const lines = tab.commands.split(/\r?\n/);
                for (const line of lines) {
                    terminal.sendText(line);
                }
            }
        }
    }

    /** Run a single terminal tab and wait for it to finish. Returns true on success, false on failure. */
    private runTerminalTabAndWait(button: ButtonConfig, tab: TerminalTab): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            const terminal = vscode.window.createTerminal(`ButtonFu: ${button.name} — ${tab.name}`);
            terminal.show();

            const sendLines = () => {
                const lines = tab.commands.split(/\r?\n/);
                for (const line of lines) {
                    terminal.sendText(line);
                }
            };

            // Use shell integration API (VS Code 1.93+) if available; otherwise fall back to
            // waiting for the terminal to close (best effort, assumes success).
            if (typeof vscode.window.onDidEndTerminalShellExecution === 'function') {
                const tryExecute = () => {
                    const si = terminal.shellIntegration;
                    if (si) {
                        const lines = tab.commands.split(/\r?\n/).filter((l: string) => l.trim());
                        const cmd = lines.join(' && ');
                        const exec = si.executeCommand(cmd);
                        const disp = vscode.window.onDidEndTerminalShellExecution((e) => {
                            if (e.execution === exec) {
                                disp.dispose();
                                resolve((e.exitCode ?? 0) === 0);
                            }
                        });
                    } else {
                        // Wait for shell integration to become available
                        const siDisp = vscode.window.onDidChangeTerminalShellIntegration?.((e) => {
                            if (e.terminal === terminal) {
                                siDisp?.dispose();
                                tryExecute();
                            }
                        });
                        // Fallback timeout — if shell integration never arrives, just send lines
                        setTimeout(() => {
                            if (!terminal.shellIntegration) {
                                siDisp?.dispose();
                                sendLines();
                                // Wait for terminal close as a proxy for completion
                                const closeDisp = vscode.window.onDidCloseTerminal(t => {
                                    if (t === terminal) {
                                        closeDisp.dispose();
                                        clearTimeout(safetyTimer);
                                        resolve(true);
                                    }
                                });
                                // Safety: dispose listener after 30 minutes to prevent indefinite leak
                                const safetyTimer = setTimeout(() => {
                                    closeDisp.dispose();
                                    resolve(true);
                                }, 30 * 60 * 1000);
                            }
                        }, 3000);
                    }
                };
                tryExecute();
            } else {
                // Older VS Code: send the lines and wait for the terminal to close
                sendLines();
                const closeDisp = vscode.window.onDidCloseTerminal(t => {
                    if (t === terminal) {
                        closeDisp.dispose();
                        clearTimeout(safetyTimer);
                        resolve(true);
                    }
                });
                // Safety: dispose listener after 30 minutes to prevent indefinite leak
                const safetyTimer = setTimeout(() => {
                    closeDisp.dispose();
                    resolve(true);
                }, 30 * 60 * 1000);
            }
        });
    }

    /** Execute a VS Code command palette action */
    private async executePaletteAction(button: ButtonConfig): Promise<void> {
        try {
            // Support passing arguments as JSON after the command ID
            // Format: "commandId" or "commandId|{arg1: value}"
            const parts = button.executionText.split('|');
            const commandId = parts[0].trim();
            
            if (parts.length > 1) {
                const rawArgs = parts.slice(1).join('|').trim();
                if (!rawArgs) {
                    await vscode.commands.executeCommand(commandId);
                    return;
                }

                try {
                    const args = JSON.parse(rawArgs);
                    await vscode.commands.executeCommand(commandId, args);
                } catch {
                    await vscode.window.showWarningMessage(
                        `ButtonFu: Invalid JSON arguments for command "${commandId}". Executing without arguments.`
                    );
                    await vscode.commands.executeCommand(commandId);
                }
            } else {
                await vscode.commands.executeCommand(commandId);
            }
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to execute command: ${err}`);
        }
    }

    /** Execute a task from tasks.json */
    private async executeTask(button: ButtonConfig): Promise<void> {
        const tasks = await vscode.tasks.fetchTasks();
        const taskName = button.executionText.trim();
        
        const task = tasks.find(t => 
            t.name === taskName || 
            `${t.source}: ${t.name}` === taskName ||
            t.name.toLowerCase() === taskName.toLowerCase()
        );
        
        if (task) {
            await vscode.tasks.executeTask(task);
        } else {
            const availableNames = tasks.map(t => t.name).join(', ');
            vscode.window.showErrorMessage(
                `Task "${taskName}" not found. Available tasks: ${availableNames || 'none'}`
            );
        }
    }

    /** Send a prompt to Copilot Chat */
    private async executeCopilotCommand(button: ButtonConfig): Promise<void> {
        await this.promptActions.sendToCopilot({
            prompt: button.executionText,
            model: button.copilotModel,
            mode: button.copilotMode,
            attachFiles: button.copilotAttachFiles,
            attachActiveFile: button.copilotAttachActiveFile
        });
    }

    /** Try to get the current git branch using the VS Code Git extension API */
    private getGitBranch(workspacePath?: string): string {
        if (!workspacePath) { return ''; }
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

        if (!vscode.workspace.isTrusted) {
            return '';
        }

        try {
            const headFile = this.resolveGitHeadFile(workspacePath);
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

    /** Resolve the HEAD file for normal repos and worktrees. */
    private resolveGitHeadFile(workspacePath: string): string {
        const gitPath = path.join(workspacePath, '.git');
        if (!fs.existsSync(gitPath)) {
            return '';
        }

        const stat = fs.statSync(gitPath);
        if (stat.isDirectory()) {
            const headFile = path.resolve(gitPath, 'HEAD');
            return this.isSupportedGitHeadFile(headFile) ? headFile : '';
        }
        if (!stat.isFile()) {
            return '';
        }

        const gitRef = fs.readFileSync(gitPath, 'utf8').trim();
        const match = gitRef.match(/^gitdir:\s*(.+)$/i);
        if (!match) {
            return '';
        }

        const headFile = path.resolve(workspacePath, match[1], 'HEAD');
        return this.isSupportedGitHeadFile(headFile) ? headFile : '';
    }

    private isSupportedGitHeadFile(headFile: string): boolean {
        const normalized = path.resolve(headFile).replace(/\\/g, '/');
        return /\/\.git\/HEAD$/i.test(normalized)
            || /\/\.git\/(?:worktrees|modules)\/.+\/HEAD$/i.test(normalized);
    }
}
