import * as vscode from 'vscode';
import { ButtonConfig, TerminalTab, SYSTEM_TOKENS } from './types';
import { detectShellKind, shellEscape, ShellKind } from './utils';
import { PromptActionService } from './promptActionService';
import {
    captureSystemTokens as captureSystemTokensCore,
    findTokensInText as findTokensInTextCore,
    replaceTokens as replaceTokensCore,
} from './tokenResolver';
export type { TokenSnapshot } from './tokenResolver';
import type { TokenSnapshot } from './tokenResolver';

const SHELL_INTEGRATION_DISCOVERY_TIMEOUT_MS = 3000;
const TERMINAL_EXECUTION_LISTENER_TIMEOUT_MS = 30 * 60 * 1000;
const TASK_STATUS_MESSAGE_TIMEOUT_MS = 5000;
const DRIVE_NET_SMOKE_TASK_NAME = 'Drive.NET: manifest smoke - buttonfu-extension';

/**
 * Executes button actions based on their type.
 */
export class ButtonExecutor {
    private readonly promptActions = new PromptActionService();

    /** Capture all system token values right now (at button click time). */
    captureSystemTokens(button: ButtonConfig): TokenSnapshot {
        return captureSystemTokensCore(new Map([
            ['$buttonname$', button.name],
            ['$buttontype$', button.type]
        ]));
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

    /** Find all tokens used in the execution text. */
    findTokensInText(text: string): string[] {
        return findTokensInTextCore(text);
    }

    /** Replace all tokens in text using snapshot + user values. */
    replaceTokens(text: string, systemSnap: TokenSnapshot, userValues: TokenSnapshot): string {
        return replaceTokensCore(text, systemSnap, userValues);
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
            let settled = false;

            const settle = (ok: boolean): void => {
                if (settled) {
                    return;
                }
                settled = true;
                resolve(ok);
            };

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
                        const safetyTimer = setTimeout(() => {
                            disp.dispose();
                            settle(true);
                        }, TERMINAL_EXECUTION_LISTENER_TIMEOUT_MS);
                        const disp = vscode.window.onDidEndTerminalShellExecution((e) => {
                            if (e.execution === exec) {
                                disp.dispose();
                                clearTimeout(safetyTimer);
                                settle((e.exitCode ?? 0) === 0);
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
                                        settle(true);
                                    }
                                });
                                // Safety: dispose listener after 30 minutes to prevent indefinite leak
                                const safetyTimer = setTimeout(() => {
                                    closeDisp.dispose();
                                    settle(true);
                                }, TERMINAL_EXECUTION_LISTENER_TIMEOUT_MS);
                            }
                        }, SHELL_INTEGRATION_DISCOVERY_TIMEOUT_MS);
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
                        settle(true);
                    }
                });
                // Safety: dispose listener after 30 minutes to prevent indefinite leak
                const safetyTimer = setTimeout(() => {
                    closeDisp.dispose();
                    settle(true);
                }, TERMINAL_EXECUTION_LISTENER_TIMEOUT_MS);
            }
        });
    }

    /** Execute a VS Code command palette action */
    private async executePaletteAction(button: ButtonConfig): Promise<void> {
        try {
            // Support passing arguments as JSON after the command ID
            // Format: "commandId" or "commandId|{\"arg1\":\"value\"}"
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
                    if (Array.isArray(args)) {
                        await vscode.commands.executeCommand(commandId, ...args);
                    } else {
                        await vscode.commands.executeCommand(commandId, args);
                    }
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
        try {
            const tasks = await vscode.tasks.fetchTasks();
            const taskName = button.executionText.trim();

            const task = tasks.find(t =>
                t.name === taskName ||
                `${t.source}: ${t.name}` === taskName ||
                t.name.toLowerCase() === taskName.toLowerCase()
            );

            if (!task) {
                const availableNames = tasks.map(t => t.name).join(', ');
                vscode.window.showErrorMessage(
                    `Task "${taskName}" not found. Available tasks: ${availableNames || 'none'}`
                );
                return;
            }

            if (task.name === DRIVE_NET_SMOKE_TASK_NAME || taskName === DRIVE_NET_SMOKE_TASK_NAME) {
                await vscode.window.showInformationMessage(
                    'ButtonFu: starting Drive.NET smoke tests. This requires the "Run ButtonFu Extension (Isolated Smoke Test)" Extension Development Host to already be running.'
                );
            }

            vscode.window.setStatusBarMessage(`ButtonFu: starting task "${task.name}"...`, TASK_STATUS_MESSAGE_TIMEOUT_MS);
            await vscode.tasks.executeTask(task);
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to execute task: ${err}`);
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

}
