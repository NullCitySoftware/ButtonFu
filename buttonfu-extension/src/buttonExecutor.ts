import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { ButtonConfig, TerminalTab, SYSTEM_TOKENS } from './types';

/** Snapshot of all resolvable values captured at invocation time */
export interface TokenSnapshot {
    [tokenName: string]: string;
}

/**
 * Executes button actions based on their type.
 */
export class ButtonExecutor {

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

    /** Capture clipboard asynchronously and merge into snapshot */
    async captureClipboard(snap: TokenSnapshot): Promise<void> {
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

        const replacedTerminals = button.terminals?.map(t => ({
            ...t,
            commands: this.replaceTokens(t.commands, systemSnap, allUserValues)
        }));
        const replaced = {
            ...button,
            executionText: this.replaceTokens(button.executionText || '', systemSnap, allUserValues),
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
            case 'PowerShellCommand' as any:
                // Legacy: treat old PowerShellCommand as TerminalCommand
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

        const hasAnyDependency = tabs.some(t => t.dependantOnPrevious);

        if (hasAnyDependency) {
            // Mixed sequential/parallel: each tab that is marked dependantOnPrevious waits
            // for the previous tab to succeed before starting.
            let previousPromise: Promise<boolean> = Promise.resolve(true);
            for (const tab of tabs) {
                if (tab.dependantOnPrevious) {
                    const ok = await previousPromise;
                    if (!ok) {
                        vscode.window.showErrorMessage(`ButtonFu: Terminal "${tab.name}" skipped because the previous terminal failed.`);
                        return;
                    }
                }
                previousPromise = this.runTerminalTabAndWait(button, tab);
            }
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
            const win = vscode.window as any;
            if (typeof win.onDidEndTerminalShellExecution === 'function') {
                const tryExecute = () => {
                    const si = (terminal as any).shellIntegration;
                    if (si) {
                        const lines = tab.commands.split(/\r?\n/).filter((l: string) => l.trim());
                        const cmd = lines.join(' && ');
                        const exec = si.executeCommand(cmd);
                        const disp = win.onDidEndTerminalShellExecution((e: any) => {
                            if (e.execution === exec) {
                                disp.dispose();
                                resolve((e.exitCode ?? 0) === 0);
                            }
                        });
                    } else {
                        // Wait for shell integration to become available
                        const siDisp = win.onDidChangeTerminalShellIntegration?.((e: any) => {
                            if (e.terminal === terminal) {
                                siDisp?.dispose();
                                tryExecute();
                            }
                        });
                        // Fallback timeout — if shell integration never arrives, just send lines
                        setTimeout(() => {
                            if (!(terminal as any).shellIntegration) {
                                siDisp?.dispose();
                                sendLines();
                                // Wait for terminal close as a proxy for completion
                                const closeDisp = vscode.window.onDidCloseTerminal(t => {
                                    if (t === terminal) {
                                        closeDisp.dispose();
                                        resolve(true);
                                    }
                                });
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
                        resolve(true);
                    }
                });
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
                try {
                    const args = JSON.parse(parts.slice(1).join('|'));
                    await vscode.commands.executeCommand(commandId, args);
                } catch {
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
        try {
            const availableCommands = new Set(await vscode.commands.getCommands(true));

            const executeFirstAvailable = async (commandIds: string[], ...args: any[]): Promise<string | undefined> => {
                for (const commandId of commandIds) {
                    if (!availableCommands.has(commandId)) {
                        continue;
                    }
                    try {
                        await vscode.commands.executeCommand(commandId, ...args);
                        return commandId;
                    } catch {
                        // try next
                    }
                }
                return undefined;
            };

            // Focus the chat panel first
            await executeFirstAvailable([
                'workbench.panel.chat.view.copilot.focus',
                'workbench.action.chat.focus',
                'workbench.action.chat.open'
            ]);
            await new Promise(resolve => setTimeout(resolve, 200));

            // Start a new chat session — try directly (not via pre-filtered list) as
            // some chat commands are lazily registered after the panel opens.
            const newChatCmds = [
                'workbench.action.chat.newChat',
                'workbench.action.chat.new',
                'workbench.action.chat.startNewChat',
                'workbench.action.chat.newSession',
                'github.copilot.chat.newChat'
            ];
            for (const cmd of newChatCmds) {
                try { await vscode.commands.executeCommand(cmd); break; } catch { /* try next */ }
            }
            await new Promise(resolve => setTimeout(resolve, 350));

            // Set the mode if specified (mode FIRST — setting mode can reset the model)
            const mode = button.copilotMode?.toLowerCase().trim();
            if (mode && ['agent', 'ask', 'edit', 'plan'].includes(mode)) {
                const modeCommands: Record<string, string[]> = {
                    'agent': ['workbench.action.chat.setMode.agent', 'workbench.action.chat.openAgent'],
                    'ask': ['workbench.action.chat.setMode.ask', 'workbench.action.chat.openAsk'],
                    'edit': ['workbench.action.chat.setMode.edit', 'workbench.action.chat.openEdit'],
                    'plan': ['workbench.action.chat.setMode.plan', 'workbench.action.chat.openPlan']
                };
                
                let set = await executeFirstAvailable(modeCommands[mode] || []);
                if (!set) {
                    set = await executeFirstAvailable([
                        'workbench.action.chat.setMode',
                        'workbench.action.chat.changeMode'
                    ], mode);
                }
                // Always wait after mode change — mode can asynchronously reset the model
                await new Promise(resolve => setTimeout(resolve, 300));
            }

            // Set the model AFTER mode (mode change may have reset it to default)
            const model = button.copilotModel?.trim();
            if (model && model !== 'auto' && model !== '') {
                await this.trySelectCopilotModel(model, availableCommands, executeFirstAvailable);
                await new Promise(resolve => setTimeout(resolve, 200));
            }

            // Attach active file if requested
            if (button.copilotAttachActiveFile) {
                const activeEditor = vscode.window.activeTextEditor;
                if (activeEditor) {
                    try {
                        await vscode.commands.executeCommand('workbench.action.chat.attachFile', activeEditor.document.uri);
                        await new Promise(resolve => setTimeout(resolve, 100));
                    } catch { /* ignore */ }
                }
            }

            // Attach files if specified
            if (button.copilotAttachFiles && button.copilotAttachFiles.length > 0) {
                for (const filePath of button.copilotAttachFiles) {
                    try {
                        const resolvedPath = this.resolveFilePath(filePath);
                        if (resolvedPath && fs.existsSync(resolvedPath)) {
                            const fileUri = vscode.Uri.file(resolvedPath);
                            await vscode.commands.executeCommand('workbench.action.chat.attachFile', fileUri);
                            await new Promise(resolve => setTimeout(resolve, 100));
                        }
                    } catch {
                        // Continue with remaining files
                    }
                }
            }

            // Copy prompt to clipboard and paste into chat
            await vscode.env.clipboard.writeText(button.executionText);
            await executeFirstAvailable([
                'workbench.action.chat.focusInput',
                'workbench.panel.chat.view.copilot.focus'
            ]);
            await new Promise(resolve => setTimeout(resolve, 50));
            await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
            await new Promise(resolve => setTimeout(resolve, 100));

            // Submit
            await vscode.commands.executeCommand('workbench.action.chat.submit');
        } catch (err) {
            console.error('ButtonFu: Failed to execute Copilot command:', err);
            await vscode.env.clipboard.writeText(button.executionText);
            vscode.window.showWarningMessage(
                'Could not automatically send to Copilot Chat. Prompt copied to clipboard.'
            );
        }
    }

    /** Select a Copilot model */
    private async trySelectCopilotModel(
        requestedModel: string,
        availableCommands: Set<string>,
        executeFirstAvailable: (commandIds: string[], ...args: any[]) => Promise<string | undefined>
    ): Promise<boolean> {
        if (!requestedModel || requestedModel === 'auto' || requestedModel.trim() === '') {
            return false;
        }

        interface LMChatModel {
            id: string;
            name: string;
            vendor: string;
            family: string;
        }

        // Try to find via VS Code Language Model API
        let modelInfo: { vendor: string; id: string; family: string } | undefined;
        try {
            const lm = (vscode as any).lm;
            if (lm?.selectChatModels) {
                const models: LMChatModel[] = await lm.selectChatModels();
                const modelLower = requestedModel.toLowerCase();
                const match = models.find((m: LMChatModel) =>
                    m.id.toLowerCase() === modelLower ||
                    m.family.toLowerCase() === modelLower
                );
                if (match) {
                    modelInfo = { vendor: match.vendor, id: match.id, family: match.family };
                }
            }
        } catch {
            // API not available
        }

        // Primary path: use changeModel with full { vendor, id, family } object
        if (modelInfo && availableCommands.has('workbench.action.chat.changeModel')) {
            try {
                await vscode.commands.executeCommand('workbench.action.chat.changeModel', {
                    vendor: modelInfo.vendor,
                    id: modelInfo.id,
                    family: modelInfo.family
                });
                return true;
            } catch {
                // fall through to fallbacks
            }
        }

        // Fallback: try various commands with the resolved ID or raw input
        const modelId = modelInfo?.id ?? requestedModel;
        const modelCommands = [
            'workbench.action.chat.changeModel',
            'workbench.action.chat.selectModel',
            'workbench.action.chat.setModel'
        ];

        const argVariants: any[] = [];
        if (modelInfo) {
            argVariants.push({ vendor: modelInfo.vendor, id: modelInfo.id, family: modelInfo.family });
        }
        argVariants.push(
            { id: modelId },
            { modelId: modelId },
            modelId
        );

        for (const args of argVariants) {
            for (const cmd of modelCommands) {
                if (!availableCommands.has(cmd)) { continue; }
                try {
                    await vscode.commands.executeCommand(cmd, args);
                    return true;
                } catch {
                    // try next
                }
            }
        }

        return false;
    }

    /** Resolve a file path, supporting workspace-relative paths */
    private resolveFilePath(filePath: string): string | undefined {
        if (path.isAbsolute(filePath)) {
            return filePath;
        }
        const folders = vscode.workspace.workspaceFolders;
        if (folders && folders.length > 0) {
            return path.join(folders[0].uri.fsPath, filePath);
        }
        return undefined;
    }

    /** Try to read current git branch from HEAD */
    private getGitBranch(workspacePath?: string): string {
        if (!workspacePath) { return ''; }
        try {
            const headFile = path.join(workspacePath, '.git', 'HEAD');
            if (!fs.existsSync(headFile)) { return ''; }
            const head = fs.readFileSync(headFile, 'utf8').trim();
            const match = head.match(/^ref:\s+refs\/heads\/(.+)$/);
            return match ? match[1] : head.slice(0, 8);
        } catch {
            return '';
        }
    }
}
