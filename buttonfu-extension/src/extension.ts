import * as vscode from 'vscode';
import { ButtonStore } from './buttonStore';
import { ButtonExecutor } from './buttonExecutor';
import { ButtonPanelProvider } from './buttonPanelProvider';
import { ButtonEditorPanel } from './editorPanel';
import { TokenInputPanel } from './tokenInputPanel';
import { buildInfo } from './buildInfo';

let store: ButtonStore;
let executor: ButtonExecutor;
let panelProvider: ButtonPanelProvider;
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

    await initializeOptionDefaults(context.globalState);

    // Initialise core services
    store = new ButtonStore(context);
    executor = new ButtonExecutor();

    // Register dynamic commands for all existing buttons
    registerButtonCommands(context);

    // Re-register when buttons change
    store.onDidChange(() => registerButtonCommands(context));

    // Register the sidebar webview provider
    panelProvider = new ButtonPanelProvider(context.extensionUri, store, context.globalState);
    ButtonEditorPanel.configure(context.globalState, () => panelProvider.refresh());
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ButtonPanelProvider.viewType, panelProvider)
    );

    // Refresh sidebar when workspace folders change (updates the workspace name label)
    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => panelProvider.refresh())
    );

    // Command: Open the button editor
    context.subscriptions.push(
        vscode.commands.registerCommand('buttonfu.openEditor', () => {
            ButtonEditorPanel.createOrShow(store, context.extensionUri);
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
            ButtonEditorPanel.createOrShowWithNew(store, context.extensionUri, 'Global');
        })
    );

    // Command: Edit a button (from tree context menu)
    context.subscriptions.push(
        vscode.commands.registerCommand('buttonfu.editButton', (item: any) => {
            if (item?.buttonId) {
                ButtonEditorPanel.createOrShowWithButton(store, context.extensionUri, item.buttonId);
            }
        })
    );

    // Command: Delete a button (from tree context menu)
    context.subscriptions.push(
        vscode.commands.registerCommand('buttonfu.deleteButton', async (item: any) => {
            if (item?.buttonId) {
                await store.deleteButton(item.buttonId);
            }
        })
    );

    // Command: Refresh the button panel
    context.subscriptions.push(
        vscode.commands.registerCommand('buttonfu.refreshButtons', () => {
            panelProvider.refresh();
        })
    );
}

export function deactivate() {
    for (const d of buttonCommandDisposables.values()) {
        d.dispose();
    }
    buttonCommandDisposables.clear();
}
