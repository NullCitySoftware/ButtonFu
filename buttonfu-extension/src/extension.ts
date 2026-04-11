import * as vscode from 'vscode';
import { ButtonStore } from './buttonStore';
import { ButtonExecutor } from './buttonExecutor';
import { ButtonPanelProvider } from './buttonPanelProvider';
import { ButtonEditorPanel } from './editorPanel';
import { TokenInputPanel } from './tokenInputPanel';
import { buildInfo } from './buildInfo';
import { ButtonLocality } from './types';
import { NoteStore } from './noteStore';
import { NotePreviewProvider } from './notePreviewProvider';
import { NoteActionService } from './noteActionService';
import { NoteEditorPanel } from './noteEditorPanel';
import * as buttonApi from './buttonApiService';
import * as noteApi from './noteApiService';
import {
    clearDevApiSmokeData,
    clearDriveNetSmokeData,
    DEV_CLEAR_API_SMOKE_COMMAND,
    DEV_CLEAR_DRIVE_NET_SMOKE_COMMAND,
    DEV_MODE_CONTEXT_KEY,
    DEV_RESET_API_SMOKE_COMMAND,
    resetDevApiSmokeData
} from './devApiSmoke';

let store: ButtonStore;
let executor: ButtonExecutor;
let panelProvider: ButtonPanelProvider;
let noteStore: NoteStore;
let noteActionService: NoteActionService;
const buttonCommandDisposables = new Map<string, vscode.Disposable>();

async function initializeOptionDefaults(globalState: vscode.Memento): Promise<void> {
    if (globalState.get<boolean>('options.showAddAndEditorButtons') === undefined) {
        await globalState.update('options.showAddAndEditorButtons', true);
    }
}

/** Execute a button with warn-before-execution and token input support */
async function executeButtonWithFlow(button: import('./types').ButtonConfig, extensionUri: vscode.Uri): Promise<void> {
    // 1. Warn before execution
    if (button.warnBeforeExecution) {
        const answer = await vscode.window.showWarningMessage(
            `Are you sure you want to run "${button.name}"?`,
            { modal: true },
            'Yes'
        );
        if (answer !== 'Yes') { return; }
    }

    // 2. Capture system tokens NOW (at click time)
    const systemSnap = executor.captureSystemTokens(button);
    await executor.captureClipboard(button, systemSnap);

    // 3. Check for unresolved user tokens
    const unresolved = executor.getUnresolvedUserTokens(button, systemSnap);

    if (unresolved.length > 0) {
        // Show the token input questionnaire
        const resolvedUser = executor.getResolvedUserTokens(button, systemSnap);
        const usedSystem = executor.getUsedSystemTokens(button, systemSnap);
        new TokenInputPanel(button, systemSnap, unresolved, resolvedUser, usedSystem, executor, extensionUri);
    } else {
        // No unresolved tokens — execute directly (still replace any system/default tokens)
        await executor.executeWithTokens(button, systemSnap, {});
    }
}

/** Register a dynamic command for each button so keybindings can target it */
function registerButtonCommands(context: vscode.ExtensionContext): void {
    const buttons = store.getAllButtons();
    const currentIds = new Set(buttons.map(b => b.id));

    // Remove commands for deleted buttons
    for (const [id, disposable] of buttonCommandDisposables) {
        if (!currentIds.has(id)) {
            disposable.dispose();
            buttonCommandDisposables.delete(id);
        }
    }

    // Register commands for new buttons
    for (const button of buttons) {
        if (!buttonCommandDisposables.has(button.id)) {
            const commandId = `buttonfu.run.${button.id}`;
            const disposable = vscode.commands.registerCommand(commandId, async () => {
                const btn = store.getButton(button.id);
                if (btn) {
                    await executeButtonWithFlow(btn, context.extensionUri);
                }
            });
            buttonCommandDisposables.set(button.id, disposable);
        }
    }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    console.log(`ButtonFu extension active | v${buildInfo.version} #${buildInfo.buildNumber} @ ${buildInfo.buildTimeIso}`);

    const optionDefaultsPromise = initializeOptionDefaults(context.globalState);
    const isDevelopmentMode = context.extensionMode === vscode.ExtensionMode.Development
        || context.extensionMode === vscode.ExtensionMode.Test;

    void vscode.commands.executeCommand('setContext', DEV_MODE_CONTEXT_KEY, isDevelopmentMode);

    // Initialise core services
    store = new ButtonStore(context);
    executor = new ButtonExecutor();
    noteStore = new NoteStore(context);

    const notePreviewProvider = new NotePreviewProvider(noteStore);
    noteActionService = new NoteActionService(noteStore, context.extensionUri, notePreviewProvider);

    // Register dynamic commands for all existing buttons
    registerButtonCommands(context);

    // Re-register when buttons change
    store.onDidChange(() => registerButtonCommands(context));

    // Register the sidebar webview provider
    panelProvider = new ButtonPanelProvider(context.extensionUri, store, noteStore, context.globalState);
    ButtonEditorPanel.configure(context.globalState, () => panelProvider.refresh());
    (NoteEditorPanel as typeof NoteEditorPanel & { configure?: (globalState: vscode.Memento) => void }).configure?.(context.globalState);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ButtonPanelProvider.viewType, panelProvider)
    );
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(NotePreviewProvider.scheme, notePreviewProvider)
    );

    // Refresh sidebar when workspace folders change (updates the workspace name label)
    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            panelProvider.refresh();
        })
    );
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('buttonfu.showNotes')) {
                panelProvider.refresh();
                if (!areNotesEnabled()) {
                    NoteEditorPanel.closeCurrent();
                }
            }
        })
    );

    // Command: Open the button editor
    context.subscriptions.push(
        vscode.commands.registerCommand('buttonfu.openEditor', () => {
            ButtonEditorPanel.createOrShow(store, context.extensionUri, noteStore);
        })
    );

    // Command: Execute a button by ID
    context.subscriptions.push(
        vscode.commands.registerCommand('buttonfu.executeButton', async (buttonId: string) => {
            const button = store.getButton(buttonId);
            if (button) {
                await executeButtonWithFlow(button, context.extensionUri);
            } else {
                vscode.window.showErrorMessage(`Button not found: ${buttonId}`);
            }
        })
    );

    // Command: Add a new button (opens editor in create mode)
    context.subscriptions.push(
        vscode.commands.registerCommand('buttonfu.addButton', () => {
            ButtonEditorPanel.createOrShowWithNew(store, context.extensionUri, 'Global', noteStore);
        })
    );

    // Command: Add a new button with a specific locality
    context.subscriptions.push(
        vscode.commands.registerCommand('buttonfu.addButtonWithLocality', (locality?: string) => {
            const resolved: ButtonLocality = locality === 'Local' ? 'Local' : 'Global';
            ButtonEditorPanel.createOrShowWithNew(store, context.extensionUri, resolved, noteStore);
        })
    );

    // Command: Edit a button (from tree context menu)
    context.subscriptions.push(
        vscode.commands.registerCommand('buttonfu.editButton', (item: any) => {
            if (item?.buttonId) {
                ButtonEditorPanel.createOrShowWithButton(store, context.extensionUri, item.buttonId, noteStore);
            }
        })
    );

    // Command: Delete a button (from tree context menu)
    context.subscriptions.push(
        vscode.commands.registerCommand('buttonfu.deleteButton', async (item: any) => {
            if (item?.buttonId) {
                const btn = store.getButton(item.buttonId);
                const name = btn?.name || 'this button';
                const answer = await vscode.window.showWarningMessage(
                    `Delete "${name}"? This cannot be undone.`,
                    { modal: true },
                    'Delete'
                );
                if (answer === 'Delete') {
                    await store.deleteButton(item.buttonId);
                }
            }
        })
    );

    // Command: Open the button editor on a specific tab
    context.subscriptions.push(
        vscode.commands.registerCommand('buttonfu.openEditorOnTab', (tab: string) => {
            ButtonEditorPanel.createOrShowWithTab(store, context.extensionUri, tab, noteStore);
        })
    );

    // Command: Refresh the button panel
    context.subscriptions.push(
        vscode.commands.registerCommand('buttonfu.refreshButtons', () => {
            panelProvider.refresh();
        })
    );

    // Command: Open the note editor
    context.subscriptions.push(
        vscode.commands.registerCommand('buttonfu.openNoteEditor', () => {
            if (!ensureNotesEnabled()) {
                return;
            }
            NoteEditorPanel.createOrShow(noteStore, context.extensionUri);
        })
    );

    // Command: Add a new note
    context.subscriptions.push(
        vscode.commands.registerCommand('buttonfu.addNote', async (arg?: unknown) => {
            if (!ensureNotesEnabled()) {
                return;
            }
            const locality = await resolveNoteCreationLocality(arg);
            if (!locality) {
                return;
            }
            NoteEditorPanel.createOrShowWithNew(noteStore, context.extensionUri, locality);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('buttonfu.executeNote', async (arg?: unknown) => {
            if (!ensureNotesEnabled()) {
                return;
            }
            await noteActionService.executeDefaultAction(arg);
        })
    );

    // Command: Primary note activation action menu
    context.subscriptions.push(
        vscode.commands.registerCommand('buttonfu.openNoteActions', async (arg?: unknown) => {
            if (!ensureNotesEnabled()) {
                return;
            }
            await noteActionService.openNoteActions(arg);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('buttonfu.previewNote', async (arg?: unknown) => {
            if (!ensureNotesEnabled()) {
                return;
            }
            await noteActionService.previewNote(arg);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('buttonfu.copyNote', async (arg?: unknown) => {
            if (!ensureNotesEnabled()) {
                return;
            }
            await noteActionService.copyNote(arg);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('buttonfu.insertNote', async (arg?: unknown) => {
            if (!ensureNotesEnabled()) {
                return;
            }
            await noteActionService.insertNote(arg);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('buttonfu.sendNoteToCopilot', async (arg?: unknown) => {
            if (!ensureNotesEnabled()) {
                return;
            }
            await noteActionService.sendNoteToCopilot(arg);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('buttonfu.editNoteNode', (arg?: unknown) => {
            if (!ensureNotesEnabled()) {
                return;
            }
            const nodeId = resolveNoteNodeId(arg);
            if (nodeId) {
                NoteEditorPanel.createOrShowWithNode(noteStore, context.extensionUri, nodeId);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('buttonfu.deleteNoteNode', async (arg?: unknown) => {
            if (!ensureNotesEnabled()) {
                return;
            }
            const nodeId = resolveNoteNodeId(arg);
            if (!nodeId) {
                return;
            }

            const node = noteStore.getNode(nodeId);
            if (!node) {
                vscode.window.showErrorMessage(`Note item not found: ${nodeId}`);
                return;
            }

            const confirmed = await vscode.window.showWarningMessage(
                `Delete note "${node.name}"?`,
                { modal: true },
                'Delete'
            );
            if (confirmed !== 'Delete') {
                return;
            }

            await noteStore.deleteNode(nodeId);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('buttonfu.refreshNotes', () => {
            if (!ensureNotesEnabled()) {
                return;
            }
            panelProvider.refresh();
        })
    );

    // -----------------------------------------------------------------------
    // Programmatic API commands (buttonfu.api.*)
    // -----------------------------------------------------------------------

    context.subscriptions.push(
        vscode.commands.registerCommand('buttonfu.api.createButton', async (input: unknown) => {
            const result = await buttonApi.createButton(store, input);
            if (!Array.isArray(result) && result.success && (input as Record<string, unknown>)?.openEditor) {
                ButtonEditorPanel.createOrShowWithButton(store, context.extensionUri, result.data!.id, noteStore);
            }
            return result;
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('buttonfu.api.getButton', (input: unknown) => {
            return buttonApi.getButton(store, input);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('buttonfu.api.listButtons', (input?: unknown) => {
            return buttonApi.listButtons(store, input);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('buttonfu.api.updateButton', async (input: unknown) => {
            const result = await buttonApi.updateButton(store, input);
            if (result.success && (input as Record<string, unknown>)?.openEditor) {
                ButtonEditorPanel.createOrShowWithButton(store, context.extensionUri, result.data!.id, noteStore);
            }
            return result;
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('buttonfu.api.deleteButton', async (input: unknown) => {
            return buttonApi.deleteButton(store, input);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('buttonfu.api.createNote', async (input: unknown) => {
            const result = await noteApi.createNote(noteStore, input);
            if (!Array.isArray(result) && result.success && (input as Record<string, unknown>)?.openEditor) {
                NoteEditorPanel.createOrShowWithNode(noteStore, context.extensionUri, result.data!.id);
            }
            return result;
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('buttonfu.api.getNote', (input: unknown) => {
            return noteApi.getNote(noteStore, input);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('buttonfu.api.listNotes', (input?: unknown) => {
            return noteApi.listNotes(noteStore, input);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('buttonfu.api.updateNote', async (input: unknown) => {
            const result = await noteApi.updateNote(noteStore, input);
            if (result.success && (input as Record<string, unknown>)?.openEditor) {
                NoteEditorPanel.createOrShowWithNode(noteStore, context.extensionUri, result.data!.id);
            }
            return result;
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('buttonfu.api.deleteNote', async (input: unknown) => {
            return noteApi.deleteNote(noteStore, input);
        })
    );

    if (isDevelopmentMode) {
        context.subscriptions.push(
            vscode.commands.registerCommand(DEV_RESET_API_SMOKE_COMMAND, async (input?: { openEditors?: boolean }) => {
                return resetDevApiSmokeData(context, input);
            })
        );

        context.subscriptions.push(
            vscode.commands.registerCommand(DEV_CLEAR_API_SMOKE_COMMAND, async () => {
                return clearDevApiSmokeData(context);
            })
        );

        context.subscriptions.push(
            vscode.commands.registerCommand(DEV_CLEAR_DRIVE_NET_SMOKE_COMMAND, async () => {
                return clearDriveNetSmokeData();
            })
        );
    }

    await optionDefaultsPromise;
}

export function deactivate() {
    for (const d of buttonCommandDisposables.values()) {
        d.dispose();
    }
    buttonCommandDisposables.clear();
}

async function resolveNoteCreationLocality(arg?: unknown): Promise<ButtonLocality | undefined> {
    if (arg === 'Global' || arg === 'Local') {
        return arg;
    }

    const candidate = arg as { locality?: string } | undefined;
    if (candidate?.locality === 'Global' || candidate?.locality === 'Local') {
        return candidate.locality;
    }

    const hasWorkspace = !!(vscode.workspace.workspaceFolders?.length || vscode.workspace.name);
    if (!hasWorkspace) {
        return 'Global';
    }

    const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name ?? vscode.workspace.name ?? 'Workspace';
    const picked = await vscode.window.showQuickPick([
        {
            label: 'Global',
            description: 'Available in every workspace',
            locality: 'Global' as ButtonLocality
        },
        {
            label: `Workspace [${workspaceName}]`,
            description: 'Stored with the current workspace',
            locality: 'Local' as ButtonLocality
        }
    ], {
        title: 'Create Note',
        placeHolder: 'Choose where to create the note'
    });

    if (!picked) {
        return undefined;
    }

    return picked.locality;
}

function resolveNoteNodeId(arg?: unknown): string {
    if (typeof arg === 'string') {
        return arg;
    }
    const candidate = arg as { id?: string; noteId?: string; nodeId?: string } | undefined;
    return candidate?.id || candidate?.noteId || candidate?.nodeId || '';
}

function areNotesEnabled(): boolean {
    return vscode.workspace.getConfiguration('buttonfu').get<boolean>('showNotes', true);
}

function ensureNotesEnabled(): boolean {
    if (areNotesEnabled()) {
        return true;
    }

    void vscode.window.showInformationMessage('ButtonFu Notes are disabled. Enable "Show Notes" in ButtonFu Options to use the Notes feature.');
    return false;
}
