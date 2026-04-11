import * as vscode from 'vscode';
import { NoteConfig, getDefaultNoteIcon } from './types';
import {
    PromptActionService,
    PromptTokenAlias,
    TokenSnapshot
} from './promptActionService';
import { PromptTokenInputPanel } from './promptTokenInputPanel';
import { NoteEditorPanel } from './noteEditorPanel';
import { NotePreviewProvider } from './notePreviewProvider';
import { NoteStore } from './noteStore';

type NoteTextAction = 'copy' | 'insert' | 'copilot';
type NoteMenuAction = NoteConfig['defaultAction'] | 'edit';

/** Coordinates user-facing note actions such as preview, copy, insert, and send-to-Copilot. */
export class NoteActionService {
    private readonly promptActions = new PromptActionService();

    constructor(
        private readonly store: NoteStore,
        private readonly extensionUri: vscode.Uri,
        private readonly previewProvider: NotePreviewProvider
    ) {}

    /** Open the ordered note action menu for a note item. */
    async openNoteActions(arg: unknown): Promise<void> {
        const note = this.resolveNote(arg);
        if (!note) {
            vscode.window.showErrorMessage('Note not found.');
            return;
        }

        const quickPickItems: Array<vscode.QuickPickItem & { action: NoteMenuAction }> = [
            {
                label: note.format === 'Markdown' ? 'Preview' : 'Open',
                description: note.format === 'Markdown' ? 'Rendered preview' : 'Open in a read-only note document',
                action: 'open'
            },
            {
                label: 'Insert into Active Editor',
                description: 'Insert the note content at the current cursor or replace selections',
                action: 'insert'
            },
            {
                label: 'Send to Copilot Chat',
                description: 'Open a fresh Copilot chat and submit the note content (with any configured attachments)',
                action: 'copilot'
            },
            {
                label: 'Copy to Clipboard',
                description: 'Copy the note content without opening it',
                action: 'copy'
            },
            {
                label: 'Edit',
                description: 'Open the note in the Note editor panel',
                action: 'edit'
            }
        ];

        const picked = await vscode.window.showQuickPick(quickPickItems, {
            title: `ButtonFu Notes · ${note.name}`,
            placeHolder: 'Choose an action'
        });
        if (!picked) {
            return;
        }

        await this.executeMenuAction(note, picked.action);
    }

    /** Execute the configured default action for a note. */
    async executeDefaultAction(arg: unknown): Promise<void> {
        const note = this.resolveNote(arg);
        if (!note) {
            vscode.window.showErrorMessage('Note not found.');
            return;
        }

        await this.executeMenuAction(note, note.defaultAction || 'open');
    }

    /** Open a preview/read-only view for a note. */
    async previewNote(arg: unknown): Promise<void> {
        const note = this.resolveNote(arg);
        if (!note) {
            vscode.window.showErrorMessage('Note not found.');
            return;
        }

        const uri = this.previewProvider.getUri(note);
        if (note.format === 'Markdown') {
            try {
                await vscode.commands.executeCommand('markdown.showPreviewToSide', uri);
                return;
            } catch {
                // Fall back to a read-only text document if markdown preview is unavailable.
            }
        }

        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document, {
            preview: true,
            preserveFocus: false,
            viewColumn: vscode.ViewColumn.Beside
        });
    }

    /** Copy a note's content to the clipboard. */
    async copyNote(arg: unknown): Promise<void> {
        await this.executeTextAction(arg, 'copy');
    }

    /** Insert a note's content into the active editor. */
    async insertNote(arg: unknown): Promise<void> {
        await this.executeTextAction(arg, 'insert');
    }

    /** Send a note's content to Copilot Chat. */
    async sendNoteToCopilot(arg: unknown): Promise<void> {
        await this.executeTextAction(arg, 'copilot');
    }

    private async executeMenuAction(note: NoteConfig, action: NoteMenuAction): Promise<void> {
        switch (action) {
            case 'open':
                await this.previewNote(note.id);
                break;
            case 'insert':
                await this.insertNote(note.id);
                break;
            case 'copilot':
                await this.sendNoteToCopilot(note.id);
                break;
            case 'copy':
                await this.copyNote(note.id);
                break;
            case 'edit':
                NoteEditorPanel.createOrShowWithNode(this.store, this.extensionUri, note.id);
                break;
        }
    }

    /** Apply a note's prompt/content text to one of the supported actions. */
    private async executeTextAction(arg: unknown, action: NoteTextAction): Promise<void> {
        const note = this.resolveNote(arg);
        if (!note) {
            vscode.window.showErrorMessage('Note not found.');
            return;
        }

        const applyText = async (text: string): Promise<void> => {
            switch (action) {
                case 'copy':
                    await vscode.env.clipboard.writeText(text);
                    vscode.window.setStatusBarMessage(`ButtonFu: Copied note "${note.name}"`, 2000);
                    break;
                case 'insert': {
                    const editor = vscode.window.activeTextEditor;
                    if (!editor) {
                        const document = await vscode.workspace.openTextDocument({
                            content: text,
                            language: note.format === 'Markdown' ? 'markdown' : 'plaintext'
                        });
                        await vscode.window.showTextDocument(document, {
                            preview: false,
                            preserveFocus: false
                        });
                        return;
                    }
                    await editor.edit((editBuilder) => {
                        for (const selection of editor.selections) {
                            editBuilder.replace(selection, text);
                        }
                    });
                    break;
                }
                case 'copilot':
                    await this.promptActions.sendToCopilot({
                        prompt: text,
                        model: note.copilotModel,
                        mode: note.copilotMode,
                        attachFiles: note.copilotAttachFiles,
                        attachActiveFile: note.copilotAttachActiveFile
                    });
                    break;
            }
        };

        if (!note.promptEnabled) {
            await applyText(note.content);
            return;
        }

        const aliases = this.getPromptAliases(note);
        const systemSnap = this.promptActions.captureSystemTokens(aliases);
        await this.promptActions.captureClipboard(systemSnap);

        const unresolved = this.promptActions.getUnresolvedUserTokens(note.content, note.userTokens || [], systemSnap);
        if (unresolved.length === 0) {
            const resolvedText = this.promptActions.resolveText(note.content, systemSnap, {}, note.userTokens || []);
            await applyText(resolvedText);
            return;
        }

        const resolvedUser = this.promptActions.getResolvedUserTokens(note.content, note.userTokens || [], systemSnap);
        const usedSystem = this.promptActions.getUsedSystemTokens(note.content, systemSnap, aliases);
        new PromptTokenInputPanel({
            title: note.name,
            subtitle: `${this.describeAction(action)} · ${note.locality === 'Global' ? 'Global' : 'Workspace'} note prompt`,
            description: 'Provide values for the prompt tokens used by this note.',
            icon: note.icon || getDefaultNoteIcon(),
            previewLabel: note.format === 'Markdown' ? 'Markdown Note' : 'Note Content',
            previewText: note.content,
            executeLabel: this.describeAction(action),
            unresolvedTokens: unresolved,
            resolvedUserTokens: resolvedUser,
            usedSystemTokens: usedSystem,
            extensionUri: this.extensionUri,
            onExecute: async (userValues: TokenSnapshot) => {
                const resolvedText = this.promptActions.resolveText(note.content, systemSnap, userValues, note.userTokens || []);
                await applyText(resolvedText);
            }
        });
    }

    /** Build additional note-specific token aliases. */
    private getPromptAliases(note: NoteConfig): PromptTokenAlias[] {
        return [
            {
                token: '$NoteName$',
                value: note.name,
                description: 'Name of the current note'
            },
            {
                token: '$NoteScope$',
                value: note.locality === 'Global' ? 'Global' : 'Workspace',
                description: 'Scope of the current note'
            },
            {
                token: '$NoteCategory$',
                value: note.category,
                description: 'Category of the current note'
            }
        ];
    }

    /** Create a stable display label for action buttons and token panels. */
    private describeAction(action: NoteTextAction): string {
        switch (action) {
            case 'copy': return 'Copy';
            case 'insert': return 'Insert';
            case 'copilot': return 'Send to Copilot';
        }
    }

    /** Resolve a note from the supported command argument shapes. */
    private resolveNote(arg: unknown): NoteConfig | undefined {
        const noteId = this.getNodeId(arg);
        return noteId ? this.store.getNote(noteId) : undefined;
    }

    /** Extract a note ID from command arguments. */
    private getNodeId(arg: unknown): string {
        if (typeof arg === 'string') {
            return arg;
        }
        const candidate = arg as { id?: string; noteId?: string; nodeId?: string } | undefined;
        return candidate?.id || candidate?.noteId || candidate?.nodeId || '';
    }
}