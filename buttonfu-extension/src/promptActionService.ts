import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { UserToken, SYSTEM_TOKENS } from './types';
import {
    captureSystemTokens as captureSystemTokensCore,
    findTokensInText as findTokensInTextCore,
    replaceTokens as replaceTokensCore,
} from './tokenResolver';
export type { TokenSnapshot } from './tokenResolver';
import type { TokenSnapshot } from './tokenResolver';

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
    /** Capture all system token values right now. */
    captureSystemTokens(aliasDefinitions: PromptTokenAlias[] = []): TokenSnapshot {
        const aliasMap = new Map(aliasDefinitions.map(def => [def.token.toLowerCase(), def.value]));
        return captureSystemTokensCore(aliasMap);
    }

    /** Capture clipboard asynchronously and merge into snapshot */
    async captureClipboard(snap: TokenSnapshot): Promise<void> {
        try {
            snap['$clipboard$'] = await vscode.env.clipboard.readText();
        } catch {
            snap['$clipboard$'] = '';
        }
    }

    /** Find all tokens used in the provided text. */
    findTokensInText(text: string): string[] {
        return findTokensInTextCore(text);
    }

    /** Replace tokens in text using system and user values. */
    replaceTokens(text: string, systemSnap: TokenSnapshot, userValues: TokenSnapshot): string {
        return replaceTokensCore(text, systemSnap, userValues);
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

}