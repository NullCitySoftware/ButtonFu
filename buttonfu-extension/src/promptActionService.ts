import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { SYSTEM_TOKENS, UserToken } from './types';

/** Snapshot of all resolvable values captured at invocation time */
export interface TokenSnapshot {
    [tokenName: string]: string;
}

/** Additional alias token made available to prompt actions */
export interface PromptTokenAlias {
    token: string;
    value: string;
    description: string;
}

/** A user token that still requires input before execution */
export interface UnresolvedPromptToken {
    token: string;
    label: string;
    description: string;
    dataType: string;
    required: boolean;
}

/** A user token resolved from its default value */
export interface ResolvedPromptToken {
    token: string;
    label: string;
    value: string;
    dataType: string;
}

/** A system token used by the prompt text */
export interface UsedSystemPromptToken {
    token: string;
    value: string;
    description: string;
}

/** Copilot prompt submission settings */
export interface CopilotPromptRequest {
    prompt: string;
    model?: string;
    mode?: string;
    attachFiles?: string[];
    attachActiveFile?: boolean;
}

/** Shared prompt/token logic used by ButtonFu buttons and notes */
export class PromptActionService {
    /** Capture all system token values right now */
    captureSystemTokens(aliasDefinitions: PromptTokenAlias[] = []): TokenSnapshot {
        const snap: TokenSnapshot = {};
        const editor = vscode.window.activeTextEditor;
        const wsFolder = vscode.workspace.workspaceFolders?.[0];
        const aliasMap = new Map(aliasDefinitions.map(def => [def.token.toLowerCase(), def.value]));

        for (const def of SYSTEM_TOKENS) {
            const key = def.token.toLowerCase();
            if (aliasMap.has(key)) {
                snap[key] = aliasMap.get(key) ?? '';
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

        for (const alias of aliasDefinitions) {
            snap[alias.token.toLowerCase()] = alias.value;
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

    /** Find all tokens used in the provided text */
    findTokensInText(text: string): string[] {
        const regex = /\$[A-Za-z_][A-Za-z0-9_]*\$/gi;
        const matches = text.match(regex);
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

    /** Replace tokens in text using system and user values */
    replaceTokens(text: string, systemSnap: TokenSnapshot, userValues: TokenSnapshot): string {
        return text.replace(/\$[A-Za-z_][A-Za-z0-9_]*\$/gi, (match) => {
            const lower = match.toLowerCase();
            if (lower in systemSnap) { return systemSnap[lower]; }
            if (lower in userValues) { return userValues[lower]; }
            return match;
        });
    }

    /** Determine which user tokens need input */
    getUnresolvedUserTokens(text: string, userTokens: UserToken[], systemSnap: TokenSnapshot): UnresolvedPromptToken[] {
        const usedLower = new Set(this.findTokensInText(text).map(token => token.toLowerCase()));
        const result: UnresolvedPromptToken[] = [];
        const handledLower = new Set<string>();

        for (const token of userTokens) {
            const lower = token.token.toLowerCase();
            handledLower.add(lower);
            if (!usedLower.has(lower)) { continue; }
            if (lower in systemSnap) { continue; }
            if (token.defaultValue !== undefined && token.defaultValue !== '') { continue; }

            result.push({
                token: token.token,
                label: token.label || token.token,
                description: token.description || '',
                dataType: token.dataType || 'String',
                required: token.required ?? false
            });
        }

        // Catch ad-hoc tokens in the text that are neither system tokens nor registered user tokens
        for (const tokenStr of this.findTokensInText(text)) {
            const lower = tokenStr.toLowerCase();
            if (lower in systemSnap) { continue; }
            if (handledLower.has(lower)) { continue; }
            result.push({
                token: tokenStr,
                label: tokenStr,
                description: '',
                dataType: 'String',
                required: false
            });
        }

        return result;
    }

    /** Get user tokens resolved from defaults */
    getResolvedUserTokens(text: string, userTokens: UserToken[], systemSnap: TokenSnapshot): ResolvedPromptToken[] {
        const usedLower = new Set(this.findTokensInText(text).map(token => token.toLowerCase()));
        const result: ResolvedPromptToken[] = [];

        for (const token of userTokens) {
            const lower = token.token.toLowerCase();
            if (!usedLower.has(lower)) { continue; }
            if (lower in systemSnap) { continue; }
            if (token.defaultValue === undefined || token.defaultValue === '') { continue; }

            result.push({
                token: token.token,
                label: token.label || token.token,
                value: token.defaultValue,
                dataType: token.dataType || 'String'
            });
        }

        return result;
    }

    /** Get system and alias tokens used by the current text */
    getUsedSystemTokens(text: string, systemSnap: TokenSnapshot, aliasDefinitions: PromptTokenAlias[] = []): UsedSystemPromptToken[] {
        const usedLower = new Set(this.findTokensInText(text).map(token => token.toLowerCase()));
        const definitions = new Map<string, { token: string; description: string }>();

        for (const def of SYSTEM_TOKENS) {
            definitions.set(def.token.toLowerCase(), {
                token: def.token,
                description: def.description
            });
        }

        for (const alias of aliasDefinitions) {
            definitions.set(alias.token.toLowerCase(), {
                token: alias.token,
                description: alias.description
            });
        }

        const result: UsedSystemPromptToken[] = [];
        for (const [key, def] of definitions) {
            if (!usedLower.has(key)) { continue; }
            result.push({
                token: def.token,
                value: systemSnap[key] ?? '',
                description: def.description
            });
        }

        return result;
    }

    /** Resolve prompt text using the provided values and default user-token values */
    resolveText(text: string, systemSnap: TokenSnapshot, userValues: TokenSnapshot, userTokens: UserToken[] = []): string {
        const loweredUserValues: TokenSnapshot = {};
        for (const [key, value] of Object.entries(userValues)) {
            loweredUserValues[key.toLowerCase()] = value;
        }

        for (const token of userTokens) {
            const lower = token.token.toLowerCase();
            if (!(lower in loweredUserValues) && token.defaultValue !== undefined && token.defaultValue !== '') {
                loweredUserValues[lower] = token.defaultValue;
            }
        }

        return this.replaceTokens(text, systemSnap, loweredUserValues);
    }

    /** Send a prompt to Copilot Chat */
    async sendToCopilot(request: CopilotPromptRequest): Promise<void> {
        let originalClipboard = '';
        let shouldRestoreClipboard = false;

        try {
            const availableCommands = new Set(await vscode.commands.getCommands(true));

            try {
                originalClipboard = await vscode.env.clipboard.readText();
                shouldRestoreClipboard = true;
            } catch {
                shouldRestoreClipboard = false;
            }

            const executeFirstAvailable = async (commandIds: string[], ...args: any[]): Promise<string | undefined> => {
                for (const commandId of commandIds) {
                    if (!availableCommands.has(commandId)) {
                        continue;
                    }
                    try {
                        await vscode.commands.executeCommand(commandId, ...args);
                        return commandId;
                    } catch {
                        // try next command
                    }
                }
                return undefined;
            };

            const focusCmd = await executeFirstAvailable([
                'workbench.panel.chat.view.copilot.focus',
                'workbench.action.chat.focus',
                'workbench.action.chat.open'
            ]);
            if (!focusCmd) {
                await vscode.env.clipboard.writeText(request.prompt);
                vscode.window.showWarningMessage('Could not open Copilot Chat. Prompt copied to clipboard.');
                shouldRestoreClipboard = false;
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 200));

            const newChatCmds = [
                'workbench.action.chat.newChat',
                'workbench.action.chat.new',
                'workbench.action.chat.startNewChat',
                'workbench.action.chat.newSession',
                'github.copilot.chat.newChat'
            ];
            for (const commandId of newChatCmds) {
                try {
                    await vscode.commands.executeCommand(commandId);
                    break;
                } catch {
                    // try next command
                }
            }
            await new Promise(resolve => setTimeout(resolve, 350));

            const mode = request.mode?.toLowerCase().trim();
            if (mode && ['agent', 'ask', 'edit', 'plan'].includes(mode)) {
                const modeCommands: Record<string, string[]> = {
                    agent: ['workbench.action.chat.setMode.agent', 'workbench.action.chat.openAgent'],
                    ask: ['workbench.action.chat.setMode.ask', 'workbench.action.chat.openAsk'],
                    edit: ['workbench.action.chat.setMode.edit', 'workbench.action.chat.openEdit'],
                    plan: ['workbench.action.chat.setMode.plan', 'workbench.action.chat.openPlan']
                };

                let set = await executeFirstAvailable(modeCommands[mode] || []);
                if (!set) {
                    set = await executeFirstAvailable([
                        'workbench.action.chat.setMode',
                        'workbench.action.chat.changeMode'
                    ], mode);
                }
                await new Promise(resolve => setTimeout(resolve, 300));
            }

            const model = request.model?.trim();
            if (model && model !== 'auto') {
                await this.trySelectCopilotModel(model, availableCommands, executeFirstAvailable);
                await new Promise(resolve => setTimeout(resolve, 200));
            }

            if (request.attachActiveFile) {
                const activeEditor = vscode.window.activeTextEditor;
                if (activeEditor) {
                    try {
                        await vscode.commands.executeCommand('workbench.action.chat.attachFile', activeEditor.document.uri);
                        await new Promise(resolve => setTimeout(resolve, 100));
                    } catch {
                        // ignore attach failures
                    }
                }
            }

            if (request.attachFiles && request.attachFiles.length > 0) {
                for (const filePath of request.attachFiles) {
                    try {
                        const resolvedPath = this.resolveFilePath(filePath);
                        if (resolvedPath && fs.existsSync(resolvedPath)) {
                            await vscode.commands.executeCommand('workbench.action.chat.attachFile', vscode.Uri.file(resolvedPath));
                            await new Promise(resolve => setTimeout(resolve, 100));
                        }
                    } catch {
                        // continue with remaining files
                    }
                }
            }

            await vscode.env.clipboard.writeText(request.prompt);
            await executeFirstAvailable([
                'workbench.action.chat.focusInput',
                'workbench.panel.chat.view.copilot.focus'
            ]);
            await new Promise(resolve => setTimeout(resolve, 50));
            await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
            await new Promise(resolve => setTimeout(resolve, 100));
            await vscode.commands.executeCommand('workbench.action.chat.submit');
        } catch (err) {
            console.error('ButtonFu: Failed to execute Copilot prompt:', err);
            shouldRestoreClipboard = false;
            await vscode.env.clipboard.writeText(request.prompt);
            vscode.window.showWarningMessage('Could not automatically send to Copilot Chat. Prompt copied to clipboard.');
        } finally {
            if (shouldRestoreClipboard) {
                try {
                    await vscode.env.clipboard.writeText(originalClipboard);
                } catch {
                    // Ignore clipboard restore failures after a successful send.
                }
            }
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

        let modelInfo: { vendor: string; id: string; family: string } | undefined;
        try {
            const lm = (vscode as any).lm;
            if (lm?.selectChatModels) {
                const models: LMChatModel[] = await lm.selectChatModels();
                const lowered = requestedModel.toLowerCase();
                const match = models.find((model) =>
                    model.id.toLowerCase() === lowered ||
                    model.family.toLowerCase() === lowered
                );
                if (match) {
                    modelInfo = { vendor: match.vendor, id: match.id, family: match.family };
                }
            }
        } catch {
            // API not available
        }

        if (modelInfo && availableCommands.has('workbench.action.chat.changeModel')) {
            try {
                await vscode.commands.executeCommand('workbench.action.chat.changeModel', {
                    vendor: modelInfo.vendor,
                    id: modelInfo.id,
                    family: modelInfo.family
                });
                return true;
            } catch {
                // fall through to command variants
            }
        }

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
        argVariants.push({ id: modelId }, { modelId }, modelId);

        for (const args of argVariants) {
            const result = await executeFirstAvailable(modelCommands, args);
            if (result) {
                return true;
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
        if (!folders || folders.length === 0) {
            return undefined;
        }

        const normalizedPath = filePath.replace(/[\\/]+/g, path.sep);
        for (const folder of folders) {
            const folderPrefix = `${folder.name}${path.sep}`;
            if (normalizedPath.startsWith(folderPrefix)) {
                return path.join(folder.uri.fsPath, normalizedPath.slice(folderPrefix.length));
            }
        }

        for (const folder of folders) {
            const candidate = path.join(folder.uri.fsPath, normalizedPath);
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }

        return path.join(folders[0].uri.fsPath, normalizedPath);
    }

    /** Try to read the current git branch from HEAD */
    private getGitBranch(workspacePath?: string): string {
        if (!workspacePath) { return ''; }
        try {
            const headFile = this.resolveGitHeadFile(workspacePath);
            if (!headFile || !fs.existsSync(headFile)) { return ''; }
            const head = fs.readFileSync(headFile, 'utf8').trim();
            const match = head.match(/^ref:\s+refs\/heads\/(.+)$/);
            return match ? match[1] : head.slice(0, 8);
        } catch {
            return '';
        }
    }

    /** Resolve the HEAD file for normal repos and worktrees. */
    private resolveGitHeadFile(workspacePath: string): string | undefined {
        const gitPath = path.join(workspacePath, '.git');
        if (!fs.existsSync(gitPath)) {
            return undefined;
        }

        const stat = fs.statSync(gitPath);
        if (stat.isDirectory()) {
            return path.join(gitPath, 'HEAD');
        }
        if (!stat.isFile()) {
            return undefined;
        }

        const gitRef = fs.readFileSync(gitPath, 'utf8').trim();
        const match = gitRef.match(/^gitdir:\s*(.+)$/i);
        if (!match) {
            return undefined;
        }

        return path.resolve(workspacePath, match[1], 'HEAD');
    }
}