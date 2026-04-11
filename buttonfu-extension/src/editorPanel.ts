import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import {
    AVAILABLE_ICONS,
    BUTTON_TYPE_INFO,
    ButtonConfig,
    ButtonLocality,
    COPILOT_MODES,
    NoteConfig,
    SYSTEM_TOKENS,
    getDefaultNoteIcon
} from './types';
import { ButtonStore } from './buttonStore';
import { NoteStore } from './noteStore';
import { buildInfo, getBuildInfoString } from './buildInfo';
import { getNonce, stripJsoncComments } from './utils';
import {
    getAutocompleteStyles,
    getAvailableCopilotModels,
    getColourFieldStyles,
    getIconPickerStyles,
    getSharedWebviewControlScript,
    renderColourFieldMarkup,
    renderIconPickerMarkup,
    renderModelAutocompleteMarkup
} from './webviewControls';

/**
 * Manages the button editor webview panel.
 * Ensures only one editor panel is open at a time.
 */
export class ButtonEditorPanel {
    public static currentPanel: ButtonEditorPanel | undefined;
    private static _globalState: vscode.Memento | undefined;
    private static _onOptionsChanged: (() => void) | undefined;

    /** Call once from activate() to wire up global state and sidebar refresh */
    public static configure(globalState: vscode.Memento, onOptionsChanged: () => void): void {
        ButtonEditorPanel._globalState = globalState;
        ButtonEditorPanel._onOptionsChanged = onOptionsChanged;
    }

    private readonly panel: vscode.WebviewPanel;
    private readonly store: ButtonStore;
    private readonly extensionUri: vscode.Uri;
    private readonly noteStore?: NoteStore;
    private disposables: vscode.Disposable[] = [];

    private constructor(panel: vscode.WebviewPanel, store: ButtonStore, extensionUri: vscode.Uri, noteStore?: NoteStore) {
        this.panel = panel;
        this.store = store;
        this.extensionUri = extensionUri;
        this.noteStore = noteStore;

        this.panel.webview.html = this.getHtmlContent();

        // Handle messages from the webview
        this.panel.webview.onDidReceiveMessage(
            async (message) => await this.handleMessage(message),
            null,
            this.disposables
        );

        // When the panel is closed, clean up
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        // Refresh when buttons change externally
        const storeChangeDisposable = this.store.onDidChange(() => {
            if (this.panel.visible) {
                this.postRefreshMessage();
            }
        });
        this.disposables.push(storeChangeDisposable);

        if (this.noteStore) {
            const noteStoreChangeDisposable = this.noteStore.onDidChange(() => {
                if (this.panel.visible) {
                    this.postRefreshMessage();
                }
            });
            this.disposables.push(noteStoreChangeDisposable);
        }

        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('buttonfu.showNotes') && this.panel.visible) {
                this.postRefreshMessage();
            }
        }, null, this.disposables);

        // Update workspace name if folders change
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            this.panel.webview.postMessage({
                type: 'workspaceNameChanged',
                workspaceName: this.getWorkspaceName()
            });
        }, null, this.disposables);
    }

    /** Show the editor panel, or focus it if already open */
    public static createOrShow(store: ButtonStore, extensionUri: vscode.Uri, noteStore?: NoteStore): void {
        if (ButtonEditorPanel.currentPanel) {
            ButtonEditorPanel.currentPanel.panel.reveal(vscode.ViewColumn.One);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'buttonfu.editor',
            'ButtonFu - Button Editor',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    extensionUri,
                    vscode.Uri.joinPath(extensionUri, 'node_modules', '@vscode', 'codicons', 'dist')
                ]
            }
        );

        ButtonEditorPanel.currentPanel = new ButtonEditorPanel(panel, store, extensionUri, noteStore);
    }

    /** Open the editor and immediately launch the new-button modal */
    public static createOrShowWithNew(store: ButtonStore, extensionUri: vscode.Uri, locality: ButtonLocality = 'Global', noteStore?: NoteStore): void {
        ButtonEditorPanel.createOrShow(store, extensionUri, noteStore);
        if (ButtonEditorPanel.currentPanel) {
            setTimeout(() => {
                ButtonEditorPanel.currentPanel?.panel.webview.postMessage({
                    type: 'addButton',
                    locality
                });
            }, 300);
        }
    }

    /** Open the editor and immediately start editing a specific button */
    public static createOrShowWithButton(store: ButtonStore, extensionUri: vscode.Uri, buttonId: string, noteStore?: NoteStore): void {
        ButtonEditorPanel.createOrShow(store, extensionUri, noteStore);
        if (ButtonEditorPanel.currentPanel) {
            setTimeout(() => {
                ButtonEditorPanel.currentPanel?.panel.webview.postMessage({
                    type: 'editButton',
                    buttonId
                });
            }, 300);
        }
    }

    /** Open the editor and switch to a specific tab (e.g. 'global', 'local', 'options') */
    public static createOrShowWithTab(store: ButtonStore, extensionUri: vscode.Uri, tab: string, noteStore?: NoteStore): void {
        ButtonEditorPanel.createOrShow(store, extensionUri, noteStore);
        if (ButtonEditorPanel.currentPanel) {
            setTimeout(() => {
                ButtonEditorPanel.currentPanel?.panel.webview.postMessage({
                    type: 'switchTab',
                    tab
                });
            }, 300);
        }
    }

    private dispose(): void {
        ButtonEditorPanel.currentPanel = undefined;
        while (this.disposables.length) {
            const d = this.disposables.pop();
            if (d) { d.dispose(); }
        }
    }

    private getWorkspaceName(): string | null {
        return vscode.workspace.workspaceFolders?.[0]?.name ?? vscode.workspace.name ?? null;
    }

    private areNotesEnabled(): boolean {
        return vscode.workspace.getConfiguration('buttonfu').get<boolean>('showNotes', true);
    }

    private getRefreshMessage(): {
        type: 'refreshButtons';
        buttons: ButtonConfig[];
        notes: NoteConfig[];
        showNotes: boolean;
        keybindings: Record<string, string>;
        workspaceName: string | null;
    } {
        const showNotes = this.areNotesEnabled();
        return {
            type: 'refreshButtons',
            buttons: this.store.getAllButtons(),
            notes: showNotes ? this.noteStore?.getAllNodes() ?? [] : [],
            showNotes,
            keybindings: this.getButtonKeybindings(),
            workspaceName: this.getWorkspaceName()
        };
    }

    private postRefreshMessage(): void {
        void this.panel.webview.postMessage(this.getRefreshMessage());
    }

    private async handleMessage(message: any): Promise<void> {
        switch (message.type) {
            case 'getButtons':
                this.postRefreshMessage();
                break;
            case 'saveButton': {
                const btn = message.button;
                if (!btn || typeof btn !== 'object'
                    || typeof btn.id !== 'string' || !btn.id
                    || typeof btn.name !== 'string' || !btn.name
                    || typeof btn.type !== 'string'
                    || !['TerminalCommand', 'PaletteAction', 'TaskExecution', 'CopilotCommand'].includes(btn.type)
                    || typeof btn.locality !== 'string'
                    || !['Global', 'Local'].includes(btn.locality)
                ) {
                    console.warn('ButtonFu: saveButton rejected — invalid button data from webview');
                    break;
                }
                // Enforce reasonable string lengths
                const MAX_LEN = 100_000;
                if ((btn.name as string).length > 500
                    || ((btn.executionText ?? '') as string).length > MAX_LEN
                    || ((btn.description ?? '') as string).length > 5000
                    || ((btn.category ?? '') as string).length > 200
                ) {
                    console.warn('ButtonFu: saveButton rejected — field length exceeded');
                    break;
                }
                await this.store.saveButton(btn as ButtonConfig);
                break;
            }
            case 'deleteButton': {
                const btn = this.store.getButton(message.id as string);
                const name = btn?.name || 'this button';
                const answer = await vscode.window.showWarningMessage(
                    `Delete "${name}"? This cannot be undone.`,
                    { modal: true },
                    'Delete'
                );
                if (answer === 'Delete') {
                    await this.store.deleteButton(message.id as string);
                    this.panel.webview.postMessage({ type: 'closeEditorOverlay' });
                }
                break;
            }
            case 'getTasks': {
                const tasks = await vscode.tasks.fetchTasks();
                const taskNames = tasks.map(t => {
                    const source = String(t.source ?? 'task');
                    return {
                        value: `${source}: ${t.name}`,
                        label: t.name,
                        source
                    };
                });
                this.panel.webview.postMessage({ type: 'tasksResult', tasks: taskNames });
                break;
            }
            case 'getCommands': {
                const commands = await this.getAvailableCommands();
                this.panel.webview.postMessage({ type: 'commandsResult', commands });
                break;
            }
            case 'getModels': {
                const models = await getAvailableCopilotModels();
                this.panel.webview.postMessage({ type: 'modelsResult', models });
                break;
            }
            case 'getWorkspaceFiles': {
                const exclude = '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/build/**}';
                const wsFiles = await vscode.workspace.findFiles('**/*', exclude, 2000);
                const wsFolders = vscode.workspace.workspaceFolders;
                const wsPaths = wsFiles.map(u => {
                    if (wsFolders && wsFolders.length > 0) {
                        const rel = vscode.workspace.asRelativePath(u, false);
                        if (rel !== u.fsPath) { return rel; }
                    }
                    return u.fsPath;
                }).sort();
                this.panel.webview.postMessage({ type: 'workspaceFilesResult', files: wsPaths });
                break;
            }
            case 'pickFiles': {
                const uris = await vscode.window.showOpenDialog({
                    canSelectFiles: true,
                    canSelectFolders: false,
                    canSelectMany: true,
                    openLabel: 'Attach Files'
                });
                if (uris) {
                    const paths = uris.map(u => {
                        const folders = vscode.workspace.workspaceFolders;
                        if (folders && folders.length > 0) {
                            const rel = vscode.workspace.asRelativePath(u, false);
                            if (rel !== u.fsPath) { return rel; }
                        }
                        return u.fsPath;
                    });
                    this.panel.webview.postMessage({ type: 'filesResult', files: paths });
                }
                break;
            }
            case 'openKeybinding': {
                const buttonId = message.buttonId;
                if (buttonId) {
                    await vscode.commands.executeCommand(
                        'workbench.action.openGlobalKeybindings',
                        `buttonfu.run.${buttonId}`
                    );
                }
                break;
            }
            case 'saveOptions': {
                const opts = message.options;
                if (opts && typeof opts === 'object') {
                    const updates: Array<Thenable<void>> = [];
                    if (typeof opts.showBuildInformation === 'boolean') {
                        updates.push(ButtonEditorPanel._globalState?.update('options.showBuildInformation', opts.showBuildInformation) ?? Promise.resolve());
                    }
                    if (typeof opts.showAddAndEditorButtons === 'boolean') {
                        updates.push(ButtonEditorPanel._globalState?.update('options.showAddAndEditorButtons', opts.showAddAndEditorButtons) ?? Promise.resolve());
                    }
                    if (typeof opts.showNotes === 'boolean') {
                        updates.push(vscode.workspace.getConfiguration('buttonfu').update('showNotes', opts.showNotes, vscode.ConfigurationTarget.Global));
                    }
                    if (typeof opts.columns === 'number' && opts.columns >= 1 && opts.columns <= 12) {
                        updates.push(ButtonEditorPanel._globalState?.update('options.columns', Math.round(opts.columns)) ?? Promise.resolve());
                    }
                    if (updates.length > 0) {
                        await Promise.all(updates);
                    }
                    ButtonEditorPanel._onOptionsChanged?.();
                }
                break;
            }
            case 'reorderButton': {
                await this.store.reorderButton(message.id as string, message.direction as 'up' | 'down');
                break;
            }
            case 'editNoteNode': {
                if (typeof message.id === 'string' && message.id) {
                    await vscode.commands.executeCommand('buttonfu.editNoteNode', message.id);
                }
                break;
            }
            case 'deleteNoteNode': {
                if (typeof message.id === 'string' && message.id) {
                    await vscode.commands.executeCommand('buttonfu.deleteNoteNode', message.id);
                }
                break;
            }
            case 'reorderNote': {
                if (this.noteStore) {
                    await this.noteStore.reorderNode(message.id as string, message.direction as 'up' | 'down');
                }
                break;
            }
        }
    }

    private getButtonKeybindings(): Record<string, string> {
        try {
            let kbPath: string;
            if (process.platform === 'win32') {
                kbPath = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Code', 'User', 'keybindings.json');
            } else if (process.platform === 'darwin') {
                kbPath = path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'keybindings.json');
            } else {
                kbPath = path.join(os.homedir(), '.config', 'Code', 'User', 'keybindings.json');
            }
            if (!fs.existsSync(kbPath)) { return {}; }
            const raw = fs.readFileSync(kbPath, 'utf8');
            // Strip JSONC comments while respecting quoted strings
            const stripped = stripJsoncComments(raw);
            const bindings: Array<{ command: string; key: string }> = JSON.parse(stripped);
            const result: Record<string, string> = {};
            for (const b of bindings) {
                const m = b.command?.match(/^buttonfu\.run\.(.+)$/);
                if (m && b.key) { result[m[1]] = b.key; }
            }
            return result;
        } catch {
            return {};
        }
    }

    private async getAvailableCommands(): Promise<Array<{ value: string; label: string; source: string }>> {
        const commandIds = await vscode.commands.getCommands(false);
        const commandInfo = new Map<string, { title: string; source: string }>();

        for (const ext of vscode.extensions.all) {
            const contributed = (ext.packageJSON as any)?.contributes?.commands;
            if (!Array.isArray(contributed)) {
                continue;
            }

            for (const cmd of contributed) {
                const command = typeof cmd?.command === 'string' ? cmd.command : '';
                if (!command || commandInfo.has(command)) {
                    continue;
                }

                const category = typeof cmd?.category === 'string' ? cmd.category : '';
                const title = typeof cmd?.title === 'string' ? cmd.title : '';
                const label = [category, title].filter(Boolean).join(': ') || command;

                commandInfo.set(command, {
                    title: label,
                    source: ext.id
                });
            }
        }

        return commandIds
            .sort((a, b) => a.localeCompare(b))
            .map(id => {
                const info = commandInfo.get(id);
                return {
                    value: id,
                    label: info?.title || id,
                    source: info?.source || 'VS Code'
                };
            });
    }

    private getHtmlContent(): string {
        const nonce = getNonce();
        const iconsJson = JSON.stringify(AVAILABLE_ICONS);
        const modesJson = JSON.stringify(COPILOT_MODES);
        const typeInfoJson = JSON.stringify(BUTTON_TYPE_INFO);
        const systemTokensJson = JSON.stringify(SYSTEM_TOKENS);
        const autocompleteStyles = getAutocompleteStyles();
        const colourFieldStyles = getColourFieldStyles();
        const iconPickerStyles = getIconPickerStyles();
        const sharedControlScript = getSharedWebviewControlScript();
        const buttonIconPickerMarkup = renderIconPickerMarkup({
            triggerId: 'iconTrigger',
            previewId: 'iconPreview',
            labelId: 'iconLabel',
            inputId: 'btn-icon',
            dropdownId: 'iconDropdown',
            searchId: 'iconSearch',
            gridId: 'iconGrid',
            defaultLabel: 'Select icon...'
        });
        const modelAutocompleteMarkup = renderModelAutocompleteMarkup({
            inputId: 'btn-copilotModel',
            listId: 'modelAutocomplete',
            triggerId: 'modelAutocompleteTrigger',
            placeholder: 'auto'
        });
        const buttonColourFieldMarkup = renderColourFieldMarkup({
            wrapperId: 'buttonColourField',
            pickerId: 'btn-colour-picker',
            inputId: 'btn-colour',
            alphaId: 'btn-colour-alpha',
            placeholder: '#ffffff or theme token'
        });
        const buildInfoStr = getBuildInfoString();
        const renderStamp = `EDITOR ${buildInfo.version} #${buildInfo.buildNumber} ${buildInfo.buildTime}`;
        const showBuildInfo = ButtonEditorPanel._globalState?.get<boolean>('options.showBuildInformation', false) ?? false;
        const showAddEditorButtons = ButtonEditorPanel._globalState?.get<boolean>('options.showAddAndEditorButtons', true) ?? true;
        const showNotes = vscode.workspace.getConfiguration('buttonfu').get<boolean>('showNotes', true);
        const columns = ButtonEditorPanel._globalState?.get<number>('options.columns', 1) ?? 1;
        const workspaceName = this.getWorkspaceName();
        const webview = this.panel.webview;

        const codiconsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css')
        );
        const editorJsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'resources', 'editor.js')
        );
        const iconImg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;vertical-align:middle" aria-hidden="true"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M3 14a6 2 0 1 0 12 0a6 2 0 1 0 -12 0" /><path d="M3 14v5c0 1.105 2.686 2 6 2s6 -.895 6 -2v-5" /><path d="M9 5a6 2 0 1 0 12 0a6 2 0 1 0 -12 0" /><path d="M9 5v3" /><path d="M18.365 11.656c1.59 -.36 2.635 -.966 2.635 -1.656v-5" /></svg>`;

        return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; font-src ${webview.cspSource}; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};">
    <link rel="stylesheet" href="${codiconsUri}">
    <title>ButtonFu - Button Editor</title>
    <style nonce="${nonce}">
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            padding: 0;
            overflow: hidden;
            height: 100vh;
        }
        
        .app-container {
            display: flex;
            flex-direction: column;
            height: 100vh;
        }

        /* ─── Header ─── */
        .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 12px 20px;
            background: var(--vscode-sideBar-background);
            border-bottom: 1px solid var(--vscode-panel-border);
            flex-shrink: 0;
        }
        .header h1 {
            font-size: 16px;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .header .version {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            font-weight: normal;
        }
        .header .debug-stamp {
            margin-left: 8px;
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            border: 1px dashed var(--vscode-input-border);
            border-radius: 3px;
            padding: 1px 6px;
            line-height: 1.2;
        }
        
        /* ─── Tabs ─── */
        .tabs {
            display: flex;
            background: var(--vscode-sideBar-background);
            border-bottom: 1px solid var(--vscode-panel-border);
            flex-shrink: 0;
        }
        .tab {
            padding: 8px 20px;
            cursor: pointer;
            font-size: 13px;
            color: var(--vscode-descriptionForeground);
            border-bottom: 2px solid transparent;
            transition: color 0.15s, border-color 0.15s;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .tab:hover { color: var(--vscode-foreground); }
        .tab.active {
            color: var(--vscode-foreground);
            border-bottom-color: var(--vscode-focusBorder);
        }
        .tab .badge {
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            font-size: 11px;
            padding: 1px 6px;
            border-radius: 8px;
            min-width: 18px;
            text-align: center;
        }
        
        /* ─── Content ─── */
        .content {
            flex: 1;
            overflow-y: auto;
            padding: 24px 20px 16px;
        }
        
        .section { display: none; }
        .section.active { display: block; }
        
        /* ─── Button List ─── */
        .button-list-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 16px;
        }
        .button-list-header h2 {
            font-size: 14px;
            font-weight: 600;
        }

        .btn {
            padding: 6px 14px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            font-family: var(--vscode-font-family);
            display: inline-flex;
            align-items: center;
            gap: 6px;
            transition: background 0.15s;
        }
        .btn-primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
        .btn-secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
        .btn-danger {
            background: #c72e2e;
            color: #fff;
        }
        .btn-danger:hover { background: #a82020; }
        .btn-sm { padding: 4px 8px; font-size: 11px; }
        .btn-icon {
            background: transparent;
            border: none;
            color: var(--vscode-foreground);
            cursor: pointer;
            padding: 4px;
            border-radius: 4px;
            font-size: 16px;
            line-height: 1;
        }
        .btn-icon:hover { background: var(--vscode-toolbar-hoverBackground); }

        /* ─── Button cards ─── */
        .button-card {
            background: var(--vscode-input-background);
            color: var(--vscode-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 6px;
            padding: 12px 16px;
            margin-bottom: 8px;
            display: flex;
            align-items: center;
            gap: 12px;
            cursor: pointer;
            transition: border-color 0.15s, background 0.15s;
        }
        .button-card:hover {
            background: var(--vscode-list-hoverBackground, var(--vscode-input-background));
            border-color: var(--vscode-focusBorder);
        }
        .button-card .card-icon {
            font-size: 20px;
            width: 32px;
            text-align: center;
            flex-shrink: 0;
        }
        .button-card .card-body {
            flex: 1;
            min-width: 0;
        }
        .button-card .card-name {
            font-weight: 600;
            font-size: 13px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .button-card .card-meta {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            display: flex;
            align-items: center;
            gap: 4px;
            margin-top: 4px;
        }
        .button-card .card-meta .meta-tag {
            display: inline-flex;
            align-items: center;
            gap: 3px;
        }
        .button-card .card-meta .meta-colour {
            width: 10px;
            height: 10px;
            border-radius: 2px;
            border: 1px solid rgba(255,255,255,0.25);
            margin-left: 4px;
        }
        .button-card .card-actions {
            display: flex;
            gap: 4px;
            flex-shrink: 0;
        }
        .empty-state {
            text-align: center;
            padding: 40px 20px;
            color: var(--vscode-descriptionForeground);
        }
        .empty-state .codicon {
            font-size: 48px;
            margin-bottom: 12px;
            opacity: 0.5;
        }
        .empty-state p { margin-bottom: 12px; }

        /* ─── Editor Form ─── */
        .editor-overlay {
            display: none;
            position: fixed;
            inset: 0;
            background: var(--vscode-editor-background);
            z-index: 100;
            overflow-y: auto;
        }
        .editor-overlay.visible { display: block; }

        .editor-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 12px 20px;
            background: var(--vscode-sideBar-background);
            border-bottom: 1px solid var(--vscode-panel-border);
            position: sticky;
            top: 0;
            z-index: 10;
        }
        .editor-header h2 {
            font-size: 14px;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .editor-header .actions { display: flex; gap: 8px; }

        .editor-body {
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
            display: flex;
            gap: 24px;
            flex-wrap: wrap;
        }
        .editor-col-left {
            flex: 1 1 400px;
            min-width: 320px;
        }
        .editor-col-right {
            flex: 1 1 340px;
            min-width: 300px;
        }
        
        .form-group {
            margin-bottom: 16px;
        }
        .form-group label {
            display: block;
            font-size: 12px;
            font-weight: 600;
            margin-bottom: 4px;
            text-transform: uppercase;
            color: var(--vscode-descriptionForeground);
            letter-spacing: 0.5px;
        }
        .form-group .field-help {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-top: 3px;
        }
        .form-row {
            display: flex;
            gap: 12px;
        }
        .form-row .form-group { flex: 1; }

        input[type="text"], textarea, select {
            width: 100%;
            padding: 6px 10px;
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            outline: none;
        }
        .field-error {
            display: none;
            font-size: 11px;
            color: var(--vscode-errorForeground, #f44747);
            margin-top: 3px;
        }
        .field-error.visible { display: block; }
        input.input-error {
            border-color: var(--vscode-inputValidation-errorBorder, #f44747);
        }
        input.input-error:focus {
            border-color: var(--vscode-inputValidation-errorBorder, #f44747);
        }
        input[type="text"]:focus, textarea:focus, select:focus {
            border-color: var(--vscode-focusBorder);
        }
        textarea {
            min-height: 80px;
            resize: vertical;
            font-family: var(--vscode-editor-font-family), monospace;
        }
        select {
            cursor: pointer;
        }
        .provenance-grid {
            display: grid;
            grid-template-columns: repeat(3, minmax(0, 1fr));
            gap: 10px;
            padding: 12px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            background: var(--vscode-textBlockQuote-background);
        }
        .provenance-item {
            min-width: 0;
        }
        .provenance-item-label {
            display: block;
            margin-bottom: 4px;
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            color: var(--vscode-descriptionForeground);
            letter-spacing: 0.4px;
        }
        .provenance-item-value {
            padding: 8px 10px;
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            min-height: 34px;
            display: flex;
            align-items: center;
        }

${iconPickerStyles}
${colourFieldStyles}

        /* ─── File chips ─── */
        .file-chips {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            margin-top: 6px;
        }
        .file-chip {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 3px 8px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            border-radius: 12px;
            font-size: 11px;
        }
        .file-chip .remove-file {
            cursor: pointer;
            font-weight: bold;
            opacity: 0.7;
        }
        .file-chip .remove-file:hover { opacity: 1; }

        /* ─── Copilot section ─── */
        .copilot-section {
            display: none;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            padding: 16px;
            margin-top: 8px;
            background: var(--vscode-textBlockQuote-background);
        }
        .copilot-section.visible { display: block; }
        .copilot-section h3 {
            font-size: 13px;
            font-weight: 600;
            margin-bottom: 12px;
            display: flex;
            align-items: center;
            gap: 6px;
            color: var(--vscode-textLink-foreground);
        }

${autocompleteStyles}

        /* ─── Card meta ─── */
        .meta-sep {
            color: var(--vscode-foreground);
            opacity: 0.35;
            font-size: 14px;
            line-height: 1;
            user-select: none;
        }
        @media (prefers-color-scheme: dark) {
            .meta-sep { opacity: 0.55; }
        }
        .meta-hex {
            margin-left: 3px;
        }

        /* ─── Options ─── */
        #section-options, #section-global, #section-local { max-width: 792px; margin: 0 auto; }
        .options-list { display: flex; flex-direction: column; gap: 10px; }
        .option-item {
            padding: 14px 16px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            background: var(--vscode-input-background);
        }
        .option-item-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            margin-bottom: 6px;
        }
        .option-item-label { font-size: 13px; font-weight: 600; }
        .option-item-desc {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            line-height: 1.5;
        }
        .toggle-switch {
            position: relative;
            display: inline-block;
            width: 38px;
            height: 22px;
            flex-shrink: 0;
        }
        .toggle-switch input { opacity: 0; width: 0; height: 0; }
        .toggle-slider {
            position: absolute;
            cursor: pointer;
            inset: 0;
            background: var(--vscode-titleBar-inactiveForeground, #555);
            border-radius: 22px;
            transition: background 0.2s;
            opacity: 0.5;
        }
        .toggle-slider::before {
            content: '';
            position: absolute;
            width: 16px;
            height: 16px;
            left: 3px;
            top: 3px;
            background: white;
            border-radius: 50%;
            transition: transform 0.2s;
        }
        .toggle-switch input:checked + .toggle-slider {
            background: var(--vscode-button-background);
            opacity: 1;
        }
        .toggle-switch input:checked + .toggle-slider::before {
            transform: translateX(16px);
        }

        /* ─── Attach files row ─── */
        .attach-files-row {
            display: flex;
            gap: 8px;
            align-items: stretch;
            margin-bottom: 6px;
        }
        .attach-files-row .autocomplete-container { flex: 1; }

        /* ─── Card reorder ─── */
        .btn-icon-xs {
            background: transparent;
            border: none;
            color: var(--vscode-foreground);
            cursor: pointer;
            padding: 2px 3px;
            border-radius: 3px;
            font-size: 13px;
            line-height: 1;
            opacity: 0.55;
        }
        .btn-icon-xs:hover { background: var(--vscode-toolbar-hoverBackground); opacity: 1; }
        .btn-icon-xs:disabled { cursor: default; opacity: 0.2 !important; }
        @keyframes cardFlash {
            0%   { border-color: var(--vscode-focusBorder); background: var(--vscode-list-activeSelectionBackground); }
            100% { border-color: var(--vscode-input-border); background: var(--vscode-input-background); }
        }
        .card-flash { animation: cardFlash 0.35s ease-out; }

        /* ─── Options columns input ─── */
        input[type="number"].opt-number {
            width: 64px;
            padding: 4px 8px;
            text-align: center;
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            outline: none;
        }
        input[type="number"].opt-number:focus {
            border-color: var(--vscode-focusBorder);
        }
        input[type="number"].opt-number::-webkit-inner-spin-button,
        input[type="number"].opt-number::-webkit-outer-spin-button {
            opacity: 0.6;
        }

        /* ─── Tokens ─── */
        .tokens-panel {
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            background: var(--vscode-textBlockQuote-background);
            padding: 16px;
        }
        .tokens-panel h3 {
            font-size: 13px;
            font-weight: 600;
            margin-bottom: 12px;
            display: flex;
            align-items: center;
            gap: 6px;
            color: var(--vscode-textLink-foreground);
        }
        .token-table-wrap {
            max-height: 260px;
            overflow-y: auto;
            margin-bottom: 12px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
        }
        .token-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 11px;
        }
        .token-table th {
            position: sticky;
            top: 0;
            text-align: left;
            padding: 5px 8px;
            font-weight: 600;
            font-size: 10px;
            text-transform: uppercase;
            letter-spacing: 0.4px;
            color: var(--vscode-descriptionForeground);
            background: var(--vscode-sideBar-background);
            border-bottom: 1px solid var(--vscode-panel-border);
            z-index: 1;
        }
        .token-table td {
            padding: 4px 8px;
            border-bottom: 1px solid var(--vscode-panel-border);
            vertical-align: middle;
            font-family: var(--vscode-editor-font-family), monospace;
        }
        .token-table tr[draggable="true"] {
            cursor: grab;
            user-select: none;
        }
        .token-table tr[draggable="true"]:hover td {
            background: var(--vscode-list-hoverBackground);
        }
        .token-table tr.drag-over-row td {
            background: var(--vscode-list-activeSelectionBackground);
            opacity: 0.7;
        }
        textarea.drop-target-active {
            border-color: var(--vscode-focusBorder) !important;
            box-shadow: 0 0 0 1px var(--vscode-focusBorder);
        }
        .token-table tr:last-child td { border-bottom: none; }
        .token-table .sys-label { color: var(--vscode-descriptionForeground); font-family: var(--vscode-font-family); }
        .token-section-header td {
            display: flex;
            align-items: center;
            gap: 6px;
            font-weight: 700;
            font-size: 10px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--vscode-descriptionForeground);
            background: var(--vscode-sideBar-background);
            padding: 6px 8px;
        }
        .token-section-header .codicon {
            font-size: 12px;
            line-height: 1;
        }

        /* User token editor */
        .user-token-form {
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            background: var(--vscode-input-background);
            padding: 12px;
            margin-top: 12px;
        }
        .user-token-form h4 {
            font-size: 12px;
            font-weight: 600;
            margin-bottom: 10px;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .ut-form-row {
            display: flex;
            gap: 8px;
            margin-bottom: 8px;
        }
        .ut-form-row .ut-field { flex: 1; }
        .ut-form-row .ut-field label {
            display: block;
            font-size: 10px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.4px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 3px;
        }
        .ut-form-row .ut-field input,
        .ut-form-row .ut-field select,
        .ut-form-row .ut-field textarea {
            width: 100%;
            padding: 4px 8px;
            font-size: 12px;
            font-family: var(--vscode-font-family);
            background: var(--vscode-editor-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 3px;
            outline: none;
        }
        .ut-form-row .ut-field input:focus,
        .ut-form-row .ut-field select:focus,
        .ut-form-row .ut-field textarea:focus {
            border-color: var(--vscode-focusBorder);
        }
        .ut-form-row .ut-field textarea {
            min-height: 40px;
            resize: vertical;
        }
        .ut-inline-check {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 12px;
            margin-bottom: 8px;
        }
        .ut-inline-check input[type="checkbox"] {
            width: 16px;
            height: 16px;
        }
        .user-token-actions {
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
            margin-top: 4px;
        }
        .user-token-table td:last-child {
            position: relative;
            padding-right: 78px;
        }
        .user-token-table .ut-actions {
            white-space: nowrap;
            position: absolute;
            right: 6px;
            top: 50%;
            transform: translateY(-50%);
            display: inline-flex;
            gap: 4px;
            padding: 2px 4px;
            border-radius: 4px;
            background: var(--vscode-editor-background);
            opacity: 0;
            pointer-events: none;
            transition: opacity 120ms ease;
        }
        .user-token-table:hover .ut-actions,
        .user-token-table:focus-within .ut-actions {
            opacity: 1;
            pointer-events: auto;
        }
        .user-token-table .btn-icon-xs {
            background: transparent;
            border: none;
            color: var(--vscode-foreground);
            cursor: pointer;
            padding: 2px 4px;
            border-radius: 3px;
            font-size: 13px;
            line-height: 1;
            opacity: 0.55;
        }
        .user-token-table .btn-icon-xs:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }

        /* ─── Terminal Tabs ─── */
        .terminal-tabs-container {
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            overflow: hidden;
        }
        .terminal-tabs-bar {
            display: flex;
            align-items: center;
            background: var(--vscode-sideBar-background);
            border-bottom: 1px solid var(--vscode-panel-border);
            overflow-x: auto;
            min-height: 34px;
        }
        .terminal-tab {
            display: flex;
            align-items: center;
            gap: 4px;
            padding: 6px 10px;
            cursor: pointer;
            font-size: 12px;
            white-space: nowrap;
            border-right: 1px solid var(--vscode-panel-border);
            background: transparent;
            color: var(--vscode-foreground);
            user-select: none;
            min-width: 0;
            flex-shrink: 0;
        }
        .terminal-tab:hover { background: var(--vscode-list-hoverBackground); }
        .terminal-tab.active {
            background: var(--vscode-editor-background);
            border-bottom: 2px solid var(--vscode-button-background);
            color: var(--vscode-textLink-foreground);
            font-weight: 600;
        }
        .terminal-tab-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
        .terminal-tab-actions {
            display: flex;
            gap: 2px;
            align-items: center;
            opacity: 0;
            pointer-events: none;
            transition: opacity 120ms ease;
        }
        .terminal-tab:hover .terminal-tab-actions,
        .terminal-tab.active .terminal-tab-actions {
            opacity: 1;
            pointer-events: auto;
        }
        .terminal-tab-add {
            padding: 4px 10px;
            font-size: 16px;
            line-height: 1;
            background: transparent;
            border: none;
            color: var(--vscode-foreground);
            cursor: pointer;
            border-radius: 3px;
            margin-left: 2px;
            opacity: 0.6;
            flex-shrink: 0;
        }
        .terminal-tab-add:hover { background: var(--vscode-toolbar-hoverBackground); opacity: 1; }
        .terminal-tab-body {
            background: var(--vscode-editor-background);
            padding: 12px;
            display: flex;
            flex-direction: column;
            gap: 10px;
        }
        .terminal-tab-rename-input {
            position: absolute;
            top: 0; left: 0;
            min-width: 90px;
            width: 100%;
            height: 100%;
            padding: 0 6px;
            font-size: 12px;
            font-family: var(--vscode-font-family);
            font-weight: 600;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 2px solid var(--vscode-focusBorder);
            border-radius: 3px;
            outline: none;
            box-sizing: border-box;
            z-index: 10;
        }
        #terminal-tab-commands {
            width: 100%;
            min-height: 100px;
            padding: 6px 8px;
            font-size: 12px;
            font-family: var(--vscode-editor-font-family), monospace;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            outline: none;
            resize: vertical;
            box-sizing: border-box;
        }
        #terminal-tab-commands:focus { border-color: var(--vscode-focusBorder); }
        .terminal-dep-row {
            display: flex;
            align-items: center;
            gap: 8px;
        }
    </style>
</head>
<body>
    <div class="app-container">
        <div class="header">
            <h1>
                ${iconImg}
                ButtonFu
                <span class="version">${buildInfoStr}</span>
                <span class="debug-stamp" id="headerDebugStamp"${showBuildInfo ? '' : ' style="display:none"'}>RUNNING BUILD: ${renderStamp}</span>
            </h1>
        </div>

        <div class="tabs">
            <div class="tab active" id="globalTab" data-tab="global">
                <span class="codicon codicon-globe"></span>
                <span id="globalTabLabel">Global Buttons</span>
                <span class="badge" id="globalCount">0</span>
            </div>
            <div class="tab" id="localTab" data-tab="local">
                <span class="codicon codicon-home"></span>
                <span id="localTabLabel">Workspace Buttons</span>
                <span class="badge" id="localCount">0</span>
            </div>
            <div class="tab" data-tab="options">
                <span class="codicon codicon-settings-gear"></span>
                Options
            </div>
        </div>

        <div class="content">
            <div class="section active" id="section-global">
                <div class="button-list-header">
                    <h2 id="globalSectionTitle">Global Buttons</h2>
                    <button class="btn btn-primary" id="addGlobalBtn">
                        <span class="codicon codicon-add"></span> Add Button
                    </button>
                </div>
                <div id="globalButtonList"></div>
            </div>

            <div class="section" id="section-local">
                <div class="button-list-header">
                    <h2 id="workspaceSectionTitle">Workspace Buttons</h2>
                    <button class="btn btn-primary" id="addLocalBtn">
                        <span class="codicon codicon-add"></span> Add Button
                    </button>
                </div>
                <div id="localButtonList"></div>
            </div>

            <div class="section" id="section-options">
                <div class="button-list-header">
                    <h2>Options</h2>
                </div>
                <div class="options-list">
                    <div class="option-item">
                        <div class="option-item-row">
                            <span class="option-item-label">Show Build Information</span>
                            <label class="toggle-switch">
                                <input type="checkbox" id="opt-showBuildInfo"${showBuildInfo ? ' checked' : ''}>
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                        <div class="option-item-desc">When enabled, shows the running build stamp in the editor header and sidebar pane. Disabled by default.</div>
                    </div>
                    <div class="option-item">
                        <div class="option-item-row">
                            <span class="option-item-label">Show Add &amp; Editor Buttons</span>
                            <label class="toggle-switch">
                                <input type="checkbox" id="opt-showAddEditorBtns"${showAddEditorButtons ? ' checked' : ''}>
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                        <div class="option-item-desc">When enabled, shows the "Add Button" and "Editor" buttons at the bottom of the sidebar. Buttons can still be added via the + icon and edited via the gear icon in the titlebar.</div>
                    </div>
                    <div class="option-item">
                        <div class="option-item-row">
                            <span class="option-item-label">Show Notes</span>
                            <label class="toggle-switch">
                                <input type="checkbox" id="opt-showNotes"${showNotes ? ' checked' : ''}>
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                        <div class="option-item-desc">When enabled, shows the Notes view and keeps Notes commands available. Existing notes are preserved when the feature is hidden.</div>
                    </div>
                    <div class="option-item">
                        <div class="option-item-row">
                            <span class="option-item-label">Sidebar Columns</span>
                            <input type="number" class="opt-number" id="opt-columns" min="1" max="12" value="${columns}">
                        </div>
                        <div class="option-item-desc">Number of columns for the sidebar button panel (1–12). <strong>Columns = 1</strong> uses a flow panel where buttons wrap naturally to fit available space.</div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <!-- Editor overlay -->
    <div class="editor-overlay" id="editorOverlay">
        <div class="editor-header">
            <h2>
                <span class="codicon codicon-edit"></span>
                <span id="editorTitle">Edit Button</span>
            </h2>
            <div class="actions">
                <button type="button" class="btn btn-danger" id="deleteBtn">
                    <span class="codicon codicon-trash"></span> Delete
                </button>
                <button type="button" class="btn btn-primary" id="saveBtn">
                    <span class="codicon codicon-save"></span> Save
                </button>
                <button type="button" class="btn btn-secondary" id="cancelBtn">
                    <span class="codicon codicon-chrome-close"></span> Cancel
                </button>
            </div>
        </div>
        <div class="editor-body">
            <div class="editor-col-left">
            <input type="hidden" id="btn-id" />

            <div class="form-row">
                <div class="form-group" style="flex:2">
                    <label>Name</label>
                    <input type="text" id="btn-name" placeholder="My Button" />
                    <span class="field-error" id="btn-name-error"></span>
                </div>
                <div class="form-group" style="flex:1">
                    <label>Locality</label>
                    <select id="btn-locality">
                        <option value="Global">Global</option>
                        <option value="Local">Workspace</option>
                    </select>
                </div>
            </div>

            <div class="form-group">
                <label>Description</label>
                <input type="text" id="btn-description" placeholder="What does this button do?" />
            </div>

            <div class="form-row">
                <div class="form-group">
                    <label>Type</label>
                    <select id="btn-type">
                        <option value="TerminalCommand">Terminal Command</option>
                        <option value="PaletteAction">Command Palette Action</option>
                        <option value="TaskExecution">Task Execution</option>
                        <option value="CopilotCommand">Copilot Command</option>
                    </select>
                    <div class="field-help" id="typeHelp"></div>
                </div>
                <div class="form-group">
                    <label>Category</label>
                    <input type="text" id="btn-category" placeholder="General" />
                    <div class="field-help">Group buttons by category in the sidebar</div>
                </div>
            </div>

            <div class="form-group">
                <label>Provenance</label>
                <div class="provenance-grid">
                    <div class="provenance-item">
                        <span class="provenance-item-label">Source Summary</span>
                        <div class="provenance-item-value" id="btn-source-summary">User</div>
                    </div>
                    <div class="provenance-item">
                        <span class="provenance-item-label">Created By</span>
                        <div class="provenance-item-value" id="btn-created-by">User</div>
                    </div>
                    <div class="provenance-item">
                        <span class="provenance-item-label">Last Modified By</span>
                        <div class="provenance-item-value" id="btn-last-modified-by">User</div>
                    </div>
                </div>
                <div class="field-help" id="btn-provenance-help">ButtonFu fills these values automatically based on whether the change came from the editor or the ButtonFu API.</div>
            </div>

            <div class="form-group" id="executionGroup">
                <label id="executionLabel">Command</label>
                <div class="autocomplete-container">
                    <textarea id="btn-executionText" placeholder="Enter command..."></textarea>
                    <input type="text" id="btn-executionPicker" placeholder="Search and select..." style="display:none" />
                    <div class="autocomplete-list" id="autocompleteList"></div>
                </div>
                <div class="field-help" id="executionHelp"></div>
            </div>

            <!-- Terminal tabs (shown for TerminalCommand type) -->
            <div class="form-group" id="terminalTabsGroup" style="display:none">
                <div class="terminal-tabs-container">
                    <div class="terminal-tabs-bar" id="terminalTabsBar">
                        <!-- rendered dynamically -->
                    </div>
                    <div class="terminal-tab-body" id="terminalTabBody">
                        <div>
                            <label style="display:block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.4px;color:var(--vscode-descriptionForeground);margin-bottom:4px">Commands</label>
                            <textarea id="terminal-tab-commands" placeholder="npm run build&#10;echo done"></textarea>
                            <div class="field-help">Commands to run in this terminal, one per line</div>
                        </div>
                        <div>
                            <div class="terminal-dep-row">
                                <label class="toggle-switch" style="margin:0">
                                    <input type="checkbox" id="terminal-tab-dependent" />
                                    <span class="toggle-slider"></span>
                                </label>
                                <label for="terminal-tab-dependent" style="cursor:pointer;margin:0;font-size:13px;font-weight:600;text-transform:none;letter-spacing:0;color:var(--vscode-foreground)">Dependent On Previous Terminal Success</label>
                            </div>
                            <div class="field-help">When all terminals have this enabled, each one waits for the previous to succeed before running</div>
                        </div>
                    </div>
                </div>
            </div>

            <div class="form-row">
                <div class="form-group" style="position:relative">
                    <label>Icon</label>
${buttonIconPickerMarkup}
                </div>
                <div class="form-group">
                    <label>Colour</label>
${buttonColourFieldMarkup}
                </div>
            </div>

            <!-- Keyboard Shortcut -->
            <div class="form-group" id="shortcutGroup" style="display:none">
                <label>Keyboard Shortcut</label>
                <div style="display:flex;align-items:center;gap:8px">
                    <button class="btn btn-secondary btn-sm" id="setShortcutBtn">
                        <span class="codicon codicon-record-keys"></span> Set Keyboard Shortcut
                    </button>
                    <span class="field-help" style="margin:0">Opens the VS Code keybinding editor for this button's command</span>
                </div>
            </div>

            <!-- Warn before execution -->
            <div class="form-group">
                <div style="display:flex;align-items:center;gap:8px">
                    <label class="toggle-switch" style="margin:0">
                        <input type="checkbox" id="btn-warnBeforeExecution" />
                        <span class="toggle-slider"></span>
                    </label>
                    <label for="btn-warnBeforeExecution" style="cursor:pointer;margin:0;font-size:13px;font-weight:600;text-transform:none;letter-spacing:0;color:var(--vscode-foreground)">Warn Before Execution</label>
                </div>
                <div class="field-help">Show a confirmation dialog before running this button. Useful for dangerous operations.</div>
            </div>

            <!-- Copilot-specific fields -->
            <div class="copilot-section" id="copilotSection">
                <h3><span class="codicon codicon-copilot"></span> Copilot Settings</h3>
                <div class="form-row">
                    <div class="form-group">
                        <label>Model</label>
${modelAutocompleteMarkup}
                        <div class="field-help">Leave empty or "auto" for default model</div>
                    </div>
                    <div class="form-group">
                        <label>Mode</label>
                        <select id="btn-copilotMode">
                            <option value="agent">Agent</option>
                            <option value="ask">Ask</option>
                            <option value="edit">Edit</option>
                            <option value="plan">Plan</option>
                        </select>
                    </div>
                </div>
                <div class="form-group">
                    <label>Attach Files</label>
                    <div style="display:flex;align-items:center;gap:8px;margin-top:6px;margin-bottom:8px">
                        <label class="toggle-switch" style="margin:0">
                            <input type="checkbox" id="btn-copilotAttachActiveFile" />
                            <span class="toggle-slider"></span>
                        </label>
                        <label for="btn-copilotAttachActiveFile" style="margin:0;cursor:pointer">Attach active file</label>
                    </div>
                    <div class="attach-files-row">
                        <button class="btn btn-secondary btn-sm" id="pickFilesBtn">
                            <span class="codicon codicon-add"></span> Browse...
                        </button>
                        <div class="autocomplete-container">
                            <input type="text" id="workspaceFileSearch" placeholder="Search workspace files..." />
                            <div class="autocomplete-list" id="workspaceFileList"></div>
                        </div>
                    </div>
                    <div class="file-chips" id="fileChips"></div>
                    <div class="field-help">Browse for files or search workspace files to attach to the Copilot chat context</div>
                </div>
            </div>
            </div><!-- end editor-col-left -->

            <div class="editor-col-right">
                <div class="tokens-panel">
                    <h3><span class="codicon codicon-symbol-variable"></span> Tokens</h3>
                    <p style="font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:10px;line-height:1.4">
                        Use <code style="background:var(--vscode-badge-background);padding:1px 4px;border-radius:3px">$TokenName$</code> in your command or prompt text. System tokens are resolved automatically. User tokens can have default values or request input at execution time.
                    </p>

                    <div class="token-table-wrap" id="tokenTableWrap">
                        <table class="token-table" id="tokenTable">
                            <thead><tr><th>Token</th><th>Value</th><th>DataType</th></tr></thead>
                            <tbody id="tokenTableBody"></tbody>
                        </table>
                    </div>

                    <button class="btn btn-secondary btn-sm" id="addUserTokenBtn" style="margin-bottom:8px;">
                        <span class="codicon codicon-add"></span> Add User Token
                    </button>

                    <div class="user-token-form" id="userTokenForm" style="display:none">
                        <h4><span class="codicon codicon-edit"></span> <span id="utFormTitle">New User Token</span></h4>
                        <div class="ut-form-row">
                            <div class="ut-field" style="flex:1">
                                <label>Token Name</label>
                                <input type="text" id="ut-token" placeholder="$MyToken$" />
                                <div id="ut-token-error" style="display:none;color:#c72e2e;font-size:11px;margin-top:3px"></div>
                            </div>
                            <div class="ut-field" style="flex:1">
                                <label>DataType</label>
                                <select id="ut-datatype">
                                    <option value="String">String</option>
                                    <option value="MultiLineString">Multi-Line String</option>
                                    <option value="Integer">Integer</option>
                                    <option value="Boolean">Boolean</option>
                                </select>
                            </div>
                        </div>
                        <div class="ut-form-row">
                            <div class="ut-field">
                                <label>Display Label</label>
                                <input type="text" id="ut-label" placeholder="My Token" />
                            </div>
                        </div>
                        <div class="ut-form-row">
                            <div class="ut-field">
                                <label>Description</label>
                                <textarea id="ut-description" placeholder="Describe what this token is for..." rows="2"></textarea>
                            </div>
                        </div>
                        <div class="ut-form-row">
                            <div class="ut-field">
                                <label>Default Value <span style="font-weight:400;text-transform:none">(leave empty for user-requested at runtime)</span></label>
                                <input type="text" id="ut-defaultValue" placeholder="Leave empty to request at runtime" />
                            </div>
                        </div>
                        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
                            <label class="toggle-switch" style="margin:0">
                                <input type="checkbox" id="ut-required" />
                                <span class="toggle-slider"></span>
                            </label>
                            <label for="ut-required" style="margin:0;cursor:pointer;font-size:12px">Required</label>
                        </div>
                        <div class="user-token-actions">
                            <button class="btn btn-primary btn-sm" id="utSaveBtn"><span class="codicon codicon-check"></span> Save Token</button>
                            <button class="btn btn-secondary btn-sm" id="utCancelBtn"><span class="codicon codicon-chrome-close"></span> Cancel</button>
                        </div>
                    </div>
                </div>
            </div><!-- end editor-col-right -->
        </div>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const ICONS = ${iconsJson};
        const MODES = ${modesJson};
        const TYPE_INFO = ${typeInfoJson};
        const SYSTEM_TOKENS = ${systemTokensJson};
        const DEFAULT_NOTE_ICON = ${JSON.stringify(getDefaultNoteIcon())};
${sharedControlScript}

        let allButtons = [];
        let allNotes = [];
        let buttonKeybindings = {};
        let notesEnabled = ${JSON.stringify(showNotes)};
        let currentWorkspaceName = ${JSON.stringify(workspaceName)};
        let currentButton = null;
        let isNewButton = false;
        let cachedTasks = null;
        let cachedCommands = null;
        let cachedModels = null;
        let cachedWorkspaceFiles = null;
        let currentAttachFiles = [];
        let currentUserTokens = [];
        let editingTokenIndex = -1; // -1 = adding new, >= 0 = editing existing
        let currentTerminals = []; // Array of {name, commands, dependentOnPrevious}
        let activeTerminalTab = 0;
        const iconPicker = createButtonFuIconPicker({
            icons: ICONS,
            triggerId: 'iconTrigger',
            previewId: 'iconPreview',
            labelId: 'iconLabel',
            inputId: 'btn-icon',
            dropdownId: 'iconDropdown',
            searchId: 'iconSearch',
            gridId: 'iconGrid',
            defaultLabel: 'Select icon...'
        });
        const modelAutocomplete = createButtonFuModelAutocomplete({
            inputId: 'btn-copilotModel',
            listId: 'modelAutocomplete',
            triggerId: 'modelAutocompleteTrigger',
            requestModels: () => {
                if (!cachedModels) {
                    vscode.postMessage({ type: 'getModels' });
                }
            }
        });
        const colourField = createButtonFuColourField({
            wrapperId: 'buttonColourField',
            inputId: 'btn-colour',
            pickerId: 'btn-colour-picker',
            alphaId: 'btn-colour-alpha'
        });
        modelAutocomplete.prefetch();

        function getExecutionInput() {
            const type = document.getElementById('btn-type').value;
            return (type === 'TaskExecution' || type === 'PaletteAction')
                ? document.getElementById('btn-executionPicker')
                : document.getElementById('btn-executionText');
        }

        // ─── Initialisation ───
        vscode.postMessage({ type: 'getButtons' });

        // Tabs
        document.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
                tab.classList.add('active');
                document.getElementById('section-' + tab.dataset.tab).classList.add('active');
            });
        });

        // ─── Message handling ───
        window.addEventListener('message', (event) => {
            const msg = event.data;
            switch (msg.type) {
                case 'refreshButtons':
                    allButtons = msg.buttons || [];
                    allNotes = Array.isArray(msg.notes) ? msg.notes : [];
                    buttonKeybindings = msg.keybindings || {};
                    if (typeof msg.showNotes === 'boolean') { notesEnabled = msg.showNotes; }
                    if (msg.workspaceName !== undefined) { currentWorkspaceName = msg.workspaceName; }
                    renderButtonLists();
                    break;
                case 'editButton':
                    const btn = allButtons.find(b => b.id === msg.buttonId);
                    if (btn) openEditor(btn);
                    break;
                case 'addButton':
                    addButton(msg.locality === 'Local' ? 'Local' : 'Global');
                    break;
                case 'workspaceNameChanged':
                    updateWorkspaceSectionTitle(msg.workspaceName);
                    break;
                case 'tasksResult':
                    cachedTasks = msg.tasks;
                    showTaskAutocomplete(msg.tasks);
                    break;
                case 'commandsResult':
                    cachedCommands = msg.commands;
                    showCommandAutocomplete(msg.commands);
                    break;
                case 'modelsResult':
                    cachedModels = msg.models;
                    modelAutocomplete.setModels(msg.models || []);
                    break;
                case 'filesResult':
                    if (msg.files) {
                        currentAttachFiles.push(...msg.files);
                        renderFileChips();
                    }
                    break;
                case 'workspaceFilesResult':
                    cachedWorkspaceFiles = msg.files || [];
                    renderWorkspaceFileList(cachedWorkspaceFiles, document.getElementById('workspaceFileSearch').value);
                    break;
            }
        });

        function getScopeNoun() {
            return notesEnabled ? 'Items' : 'Buttons';
        }

        function updateScopeLabels() {
            const globalLabel = 'Global ' + getScopeNoun();
            const workspaceLabel = 'Workspace ' + getScopeNoun();
            const globalTab = document.getElementById('globalTabLabel');
            const localTab = document.getElementById('localTabLabel');
            const globalSection = document.getElementById('globalSectionTitle');

            if (globalTab) { globalTab.textContent = globalLabel; }
            if (localTab) { localTab.textContent = workspaceLabel; }
            if (globalSection) { globalSection.textContent = globalLabel; }

            updateWorkspaceSectionTitle(currentWorkspaceName);
        }

        function updateWorkspaceSectionTitle(name) {
            currentWorkspaceName = name ?? null;
            const el = document.getElementById('workspaceSectionTitle');
            const baseLabel = 'Workspace ' + getScopeNoun();
            if (el) { el.textContent = currentWorkspaceName ? baseLabel + ' [' + currentWorkspaceName + ']' : baseLabel; }
        }

        function compareListItems(left, right) {
            const order = (left.sortOrder ?? 99999) - (right.sortOrder ?? 99999);
            if (order !== 0) {
                return order;
            }

            const kindPriority = {
                button: 0,
                note: 1
            };
            const kindOrder = (kindPriority[left.kind] ?? 99999) - (kindPriority[right.kind] ?? 99999);
            if (kindOrder !== 0) {
                return kindOrder;
            }

            return (left.name || '').localeCompare(right.name || '');
        }

        function getListItems(locality) {
            const items = allButtons
                .filter(button => button.locality === locality)
                .map(button => ({
                    kind: 'button',
                    id: button.id,
                    name: button.name || '',
                    category: button.category || 'General',
                    sortOrder: button.sortOrder,
                    data: button
                }));

            if (notesEnabled) {
                items.push(...allNotes
                    .filter(note => note.locality === locality)
                    .map(note => ({
                        kind: 'note',
                        id: note.id,
                        name: note.name || '',
                        category: note.category || 'General',
                        sortOrder: note.sortOrder,
                        data: note
                    })));
            }

            return items.sort(compareListItems);
        }

        // ─── Render ───
        function renderButtonLists() {
            updateScopeLabels();

            const globals = getListItems('Global');
            const locals = getListItems('Local');
            const globalEmptyTitle = notesEnabled ? 'No global items yet' : 'No global buttons yet';
            const localEmptyTitle = notesEnabled ? 'No workspace items yet' : 'No workspace buttons yet';
            const globalEmptyDesc = notesEnabled
                ? 'Saved buttons and notes appear in every workspace.'
                : 'Global buttons appear in every workspace.';
            const localEmptyDesc = notesEnabled
                ? 'Workspace buttons and notes are specific to this project.'
                : 'Workspace buttons are specific to this project.';
            
            document.getElementById('globalCount').textContent = globals.length;
            document.getElementById('localCount').textContent = locals.length;

            document.getElementById('globalButtonList').innerHTML = 
                globals.length ? renderCards(globals) : emptyState(globalEmptyTitle, globalEmptyDesc);
            document.getElementById('localButtonList').innerHTML = 
                locals.length ? renderCards(locals) : emptyState(localEmptyTitle, localEmptyDesc);
        }

        function renderCards(items) {
            const moveStateById = {};
            const buttonIds = items.filter(item => item.kind === 'button').map(item => item.id);
            const noteIds = items.filter(item => item.kind === 'note').map(item => item.id);

            buttonIds.forEach((id, index) => {
                moveStateById[id] = { isFirst: index === 0, isLast: index === buttonIds.length - 1 };
            });
            noteIds.forEach((id, index) => {
                moveStateById[id] = { isFirst: index === 0, isLast: index === noteIds.length - 1 };
            });

            const cats = {};
            items.forEach((item) => {
                const cat = item.category || 'Uncategorised';
                if (!cats[cat]) cats[cat] = [];
                cats[cat].push(item);
            });
            
            let html = '';
            const sortedCats = Object.keys(cats).sort();
            
            if (sortedCats.length > 1) {
                sortedCats.forEach(cat => {
                    const catItems = cats[cat];
                    html += '<div style="margin-bottom:20px">';
                    html += '<div style="display:flex;align-items:center;gap:10px;font-size:11px;font-weight:700;color:var(--vscode-descriptionForeground);margin-bottom:18px;text-transform:uppercase;letter-spacing:0.6px;line-height:1">' +
                        '<span class="codicon codicon-folder" style="font-size:14px;line-height:1"></span><span>' + escapeHtml(cat) + '</span></div>';
                    catItems.forEach((item) => { html += renderCard(item, moveStateById[item.id]); });
                    html += '</div>';
                });
            } else {
                items.forEach((item) => { html += renderCard(item, moveStateById[item.id]); });
            }
            
            return html;
        }

        function getUsedUniqueTokenCount(text) {
            const matches = String(text || '').match(/\\$[A-Za-z_][A-Za-z0-9_]*\\$/g) || [];
            return new Set(matches.map(t => t.toLowerCase())).size;
        }

        function getButtonAllText(b) {
            if (b.type === 'TerminalCommand' && b.terminals && b.terminals.length > 0) {
                return b.terminals.map(t => t.commands || '').join('\\n');
            }
            return b.executionText || '';
        }

        function renderCard(item, moveState) {
            return item.kind === 'note'
                ? renderNoteCard(item.data, moveState)
                : renderButtonCard(item.data, moveState);
        }

        function renderButtonCard(b, moveState) {
            const typeInfo = TYPE_INFO[b.type] || {};
            const colour = (b.colour || '').trim();
            const hasHex = /^#[0-9a-fA-F]{6}$/.test(colour);
            const category = b.category || 'General';
            const shortcut = buttonKeybindings[b.id];
            const tokenCount = getUsedUniqueTokenCount(getButtonAllText(b));
            const isFirst = moveState?.isFirst ?? true;
            const isLast  = moveState?.isLast ?? true;

            const colourPart = hasHex
                ? '<span class="meta-sep">·</span>' +
                  '<span class="meta-colour" style="background:' + escapeAttr(colour) + '"></span>' +
                  '<span class="meta-hex">' + escapeHtml(colour) + '</span>'
                : '';

            const shortcutPart = shortcut
                ? '<span class="meta-sep">·</span>' +
                  '<span class="meta-tag"><span class="codicon codicon-record-keys"></span> ' + escapeHtml(shortcut) + '</span>'
                : '';

                        const tokenPart = tokenCount > 0
                                ? '<span class="meta-sep">·</span>' +
                                    '<span class="meta-tag"><span class="codicon codicon-symbol-variable"></span> Tokenised [' + tokenCount + ']</span>'
                                : '';

                        const modelPart = b.type === 'CopilotCommand'
                                ? '<span class="meta-sep">·</span>' +
                                    '<span class="meta-tag"><span class="codicon codicon-hubot"></span> ' + escapeHtml((b.copilotModel || '').trim() || 'auto') + '</span>'
                                : '';

            return '<div class="button-card" data-button-id="' + escapeAttr(b.id) + '" role="group" aria-label="' + escapeAttr(b.name || 'Untitled') + '">' +
                '<div class="card-icon"><span class="codicon codicon-' + escapeHtml(b.icon || 'play') + '"></span></div>' +
                '<div class="card-body">' +
                '<div class="card-name">' + escapeHtml(b.name || 'Untitled') + '</div>' +
                '<div class="card-meta">' +
                '<span class="meta-tag"><span class="codicon codicon-' + escapeHtml(typeInfo.icon || 'play') + '"></span> ' + escapeHtml(typeInfo.label || b.type) + '</span>' +
                '<span class="meta-sep">·</span>' +
                '<span class="meta-tag"><span class="codicon codicon-tag"></span> ' + escapeHtml(category) + colourPart + '</span>' +
                tokenPart +
                modelPart +
                shortcutPart +
                '</div>' +
                '</div>' +
                '<div class="card-actions">' +
                '<button class="btn-icon btn-icon-xs" data-move-up-id="' + escapeAttr(b.id) + '" title="Move Up"' + (isFirst ? ' disabled' : '') + '>' +
                '<span class="codicon codicon-chevron-up"></span></button>' +
                '<button class="btn-icon btn-icon-xs" data-move-down-id="' + escapeAttr(b.id) + '" title="Move Down"' + (isLast ? ' disabled' : '') + '>' +
                '<span class="codicon codicon-chevron-down"></span></button>' +
                '<button class="btn-icon" data-duplicate-id="' + escapeAttr(b.id) + '" title="Duplicate">' +
                '<span class="codicon codicon-copy"></span></button>' +
                '<button class="btn-icon" data-edit-id="' + escapeAttr(b.id) + '" title="Edit">' +
                '<span class="codicon codicon-edit"></span></button>' +
                '<button class="btn-icon" data-delete-id="' + escapeAttr(b.id) + '" title="Delete">' +
                '<span class="codicon codicon-trash"></span></button>' +
                '</div></div>';
        }

        function getNote(id) { return allNotes.find(note => note.id === id); }

        function getNoteFormatLabel(note) {
            return note.format === 'Markdown' ? 'Markdown' : 'Plain Text';
        }

        function getNoteDefaultActionLabel(note) {
            switch (note.defaultAction) {
                case 'insert':
                    return 'Insert';
                case 'copilot':
                    return 'Send to Copilot';
                case 'copy':
                    return 'Copy';
                default:
                    return note.format === 'Markdown' ? 'Preview' : 'Open';
            }
        }

        function renderNoteCard(note, moveState) {
            const colour = (note.colour || '').trim();
            const hasHex = /^#[0-9a-fA-F]{6}$/.test(colour);
            const category = note.category || 'General';
            const tokenCount = getUsedUniqueTokenCount(note.content || '');
            const isFirst = moveState?.isFirst ?? true;
            const isLast  = moveState?.isLast ?? true;

            const colourPart = hasHex
                ? '<span class="meta-sep">·</span>' +
                  '<span class="meta-colour" style="background:' + escapeAttr(colour) + '"></span>' +
                  '<span class="meta-hex">' + escapeHtml(colour) + '</span>'
                : '';

            const tokenPart = tokenCount > 0
                ? '<span class="meta-sep">·</span>' +
                  '<span class="meta-tag"><span class="codicon codicon-symbol-variable"></span> Tokenised [' + tokenCount + ']</span>'
                : '';

            return '<div class="button-card note-card" data-note-id="' + escapeAttr(note.id) + '" role="group" aria-label="' + escapeAttr(note.name || 'Untitled Note') + '">' +
                '<div class="card-icon"><span class="codicon codicon-' + escapeHtml(note.icon || DEFAULT_NOTE_ICON) + '"></span></div>' +
                '<div class="card-body">' +
                '<div class="card-name">' + escapeHtml(note.name || 'Untitled Note') + '</div>' +
                '<div class="card-meta">' +
                '<span class="meta-tag"><span class="codicon codicon-' + escapeHtml(DEFAULT_NOTE_ICON) + '"></span> Note</span>' +
                '<span class="meta-sep">·</span>' +
                '<span class="meta-tag">' + escapeHtml(getNoteFormatLabel(note)) + '</span>' +
                '<span class="meta-sep">·</span>' +
                '<span class="meta-tag">' + escapeHtml(getNoteDefaultActionLabel(note)) + '</span>' +
                '<span class="meta-sep">·</span>' +
                '<span class="meta-tag"><span class="codicon codicon-tag"></span> ' + escapeHtml(category) + colourPart + '</span>' +
                tokenPart +
                '</div>' +
                '</div>' +
                '<div class="card-actions">' +
                '<button class="btn-icon btn-icon-xs" data-note-move-up-id="' + escapeAttr(note.id) + '" title="Move Up"' + (isFirst ? ' disabled' : '') + '>' +
                '<span class="codicon codicon-chevron-up"></span></button>' +
                '<button class="btn-icon btn-icon-xs" data-note-move-down-id="' + escapeAttr(note.id) + '" title="Move Down"' + (isLast ? ' disabled' : '') + '>' +
                '<span class="codicon codicon-chevron-down"></span></button>' +
                '<button class="btn-icon" data-note-edit-id="' + escapeAttr(note.id) + '" title="Edit Note">' +
                '<span class="codicon codicon-edit"></span></button>' +
                '<button class="btn-icon" data-note-delete-id="' + escapeAttr(note.id) + '" title="Delete Note">' +
                '<span class="codicon codicon-trash"></span></button>' +
                '</div></div>';
        }

        function emptyState(title, desc) {
            return '<div class="empty-state">' +
                '<div class="codicon codicon-add" style="font-size:40px;opacity:0.3;margin-bottom:12px"></div>' +
                '<p style="font-weight:600">' + escapeHtml(title) + '</p>' +
                '<p>' + escapeHtml(desc) + '</p>' +
                '</div>';
        }

        function getButton(id) { return allButtons.find(b => b.id === id); }

        // ─── Editor ───
        function addButton(locality) {
            const btn = {
                id: Date.now().toString(36) + Math.random().toString(36).substring(2, 9),
                name: '',
                locality: locality,
                description: '',
                type: 'TerminalCommand',
                executionText: '',
                category: 'General',
                icon: 'play',
                colour: '',
                copilotModel: '',
                copilotMode: 'agent',
                copilotAttachFiles: [],
                copilotAttachActiveFile: false,
                warnBeforeExecution: false,
                userTokens: [],
                createdBy: 'User',
                lastModifiedBy: 'User',
                source: 'User'
            };
            isNewButton = true;
            openEditor(btn);
        }

        function clearNameValidation() {
            const nameInput = document.getElementById('btn-name');
            const nameError = document.getElementById('btn-name-error');
            nameInput.classList.remove('input-error');
            nameError.textContent = '';
            nameError.classList.remove('visible');
        }

        function showNameValidationError() {
            const nameInput = document.getElementById('btn-name');
            const nameError = document.getElementById('btn-name-error');
            nameInput.classList.add('input-error');
            nameError.textContent = 'A name is required.';
            nameError.classList.add('visible');
        }

        function syncNameValidation() {
            if (document.getElementById('btn-name').value.trim().length > 0) {
                clearNameValidation();
                return true;
            }

            const nameError = document.getElementById('btn-name-error');
            if (nameError.classList.contains('visible')) {
                nameError.textContent = 'A name is required.';
            }
            return false;
        }

        function deriveButtonProvenanceSummary(btn) {
            const createdBy = btn && (btn.createdBy === 'Agent' || btn.createdBy === 'User') ? btn.createdBy : '';
            const lastModifiedBy = btn && (btn.lastModifiedBy === 'Agent' || btn.lastModifiedBy === 'User') ? btn.lastModifiedBy : '';
            const legacySummary = btn && (btn.source === 'Agent' || btn.source === 'AgentAndUser') ? btn.source : 'User';

            if (createdBy && lastModifiedBy) {
                return createdBy === lastModifiedBy ? createdBy : 'AgentAndUser';
            }
            if (legacySummary === 'AgentAndUser' && (createdBy || lastModifiedBy)) {
                return 'AgentAndUser';
            }
            return createdBy || lastModifiedBy || legacySummary;
        }

        function getButtonProvenanceActorDisplay(actor, summary) {
            if (actor === 'Agent' || actor === 'User') {
                return actor;
            }
            return summary === 'AgentAndUser' ? 'Unknown' : summary;
        }

        function renderButtonProvenance(btn) {
            const summary = deriveButtonProvenanceSummary(btn || {});
            const createdBy = getButtonProvenanceActorDisplay(btn && btn.createdBy, summary);
            const lastModifiedBy = getButtonProvenanceActorDisplay(btn && btn.lastModifiedBy, summary);
            const hasLegacyGap = summary === 'AgentAndUser' && ((!btn || !btn.createdBy) || (!btn || !btn.lastModifiedBy));

            document.getElementById('btn-source-summary').textContent = summary;
            document.getElementById('btn-created-by').textContent = createdBy;
            document.getElementById('btn-last-modified-by').textContent = lastModifiedBy;
            document.getElementById('btn-provenance-help').textContent = hasLegacyGap
                ? 'This item has legacy mixed provenance, so the exact creator or last editor may be unavailable.'
                : 'ButtonFu fills these values automatically based on whether the change came from the editor or the ButtonFu API.';
        }

        function openEditor(btn) {
            if (!btn) return;
            currentButton = btn;

            document.getElementById('editorTitle').textContent = isNewButton ? 'New Button' : 'Edit Button';
            document.getElementById('deleteBtn').style.display = isNewButton ? 'none' : '';

            document.getElementById('btn-id').value = btn.id || '';
            document.getElementById('btn-name').value = btn.name || '';
            clearNameValidation();
            document.getElementById('btn-locality').value = btn.locality || 'Global';
            document.getElementById('btn-description').value = btn.description || '';
            document.getElementById('btn-type').value = btn.type || 'TerminalCommand';
            document.getElementById('btn-executionText').value = btn.executionText || '';
            document.getElementById('btn-executionPicker').value = btn.executionText || '';
            document.getElementById('btn-category').value = btn.category || 'General';
            renderButtonProvenance(btn);
            colourField.setValue(btn.colour || '');
            document.getElementById('btn-copilotModel').value = btn.copilotModel || '';
            document.getElementById('btn-copilotMode').value = btn.copilotMode || 'agent';
            
            currentAttachFiles = (btn.copilotAttachFiles || []).slice();
            renderFileChips();
            document.getElementById('btn-copilotAttachActiveFile').checked = btn.copilotAttachActiveFile ?? false;
            document.getElementById('btn-warnBeforeExecution').checked = btn.warnBeforeExecution ?? false;

            currentUserTokens = (btn.userTokens || []).map(t => Object.assign({}, t));
            editingTokenIndex = -1;
            renderTokenTable();
            setupTokenDragDrop();
            hideUserTokenForm();

            // Load terminal tabs
            if (btn.type === 'TerminalCommand') {
                if (btn.terminals && btn.terminals.length > 0) {
                    currentTerminals = btn.terminals.map(t => Object.assign({}, t));
                } else if (btn.executionText) {
                    // Migrate legacy executionText into a single default tab
                    currentTerminals = [{ name: 'Terminal 1', commands: btn.executionText, dependentOnPrevious: false }];
                } else {
                    currentTerminals = [{ name: 'Terminal 1', commands: '', dependentOnPrevious: false }];
                }
                activeTerminalTab = 0;
            }

            iconPicker.setValue(btn.icon || 'play');

            onTypeChanged();
            document.getElementById('editorOverlay').classList.add('visible');
            // Show shortcut button only when editing existing buttons (command exists)
            document.getElementById('shortcutGroup').style.display = isNewButton ? 'none' : '';
            document.getElementById('btn-name').focus();
        }

        function closeEditor() {
            document.getElementById('editorOverlay').classList.remove('visible');
            currentButton = null;
            isNewButton = false;
        }

        function saveButton() {
            const type = document.getElementById('btn-type').value;
            let executionText = '';
            let terminals = undefined;

            if (type === 'TerminalCommand') {
                // Flush the active tab's current UI values before collecting
                saveCurrentTerminalTab();
                terminals = currentTerminals.map(t => Object.assign({}, t));
            } else {
                executionText = getExecutionInput().value.trim();
            }

            const btn = {
                id: document.getElementById('btn-id').value,
                name: document.getElementById('btn-name').value.trim(),
                locality: document.getElementById('btn-locality').value,
                description: document.getElementById('btn-description').value.trim(),
                type: type,
                executionText: executionText,
                terminals: terminals,
                category: document.getElementById('btn-category').value.trim() || 'General',
                icon: document.getElementById('btn-icon').value || 'play',
                colour: document.getElementById('btn-colour').value.trim(),
                copilotModel: document.getElementById('btn-copilotModel').value.trim(),
                copilotMode: document.getElementById('btn-copilotMode').value,
                copilotAttachFiles: currentAttachFiles.slice(),
                copilotAttachActiveFile: document.getElementById('btn-copilotAttachActiveFile').checked,
                warnBeforeExecution: document.getElementById('btn-warnBeforeExecution').checked,
                userTokens: currentUserTokens.map(t => Object.assign({}, t))
            };

            if (!btn.name) {
                showNameValidationError();
                document.getElementById('btn-name').focus();
                return;
            }

            vscode.postMessage({ type: 'saveButton', button: btn });
            closeEditor();
        }

        function deleteCurrentButton() {
            if (currentButton && currentButton.id) {
                vscode.postMessage({ type: 'deleteButton', id: currentButton.id });
                closeEditor();
            }
        }

        function confirmDelete(id) {
            vscode.postMessage({ type: 'deleteButton', id: id });
        }

        function confirmDeleteNote(id) {
            vscode.postMessage({ type: 'deleteNoteNode', id: id });
        }

        function editNote(id) {
            vscode.postMessage({ type: 'editNoteNode', id: id });
        }

        function duplicateButton(id) {
            const src = getButton(id);
            if (!src) return;
            const copy = Object.assign({}, src, {
                id: Date.now().toString(36) + Math.random().toString(36).substring(2, 9),
                name: src.name + ' (Copy)',
                sortOrder: undefined,
                copilotAttachFiles: (src.copilotAttachFiles || []).slice(),
                userTokens: (src.userTokens || []).map(t => Object.assign({}, t))
            });
            isNewButton = true;
            openEditor(copy);
        }

        function flashMovedCard(selector) {
            requestAnimationFrame(() => {
                const card = document.querySelector(selector);
                if (card) {
                    card.classList.add('card-flash');
                    setTimeout(() => card.classList.remove('card-flash'), 380);
                }
            });
        }

        function reorderButtonLocal(id, direction) {
            const btn = getButton(id);
            if (!btn) return;
            const group = allButtons.filter(b => b.locality === btn.locality)
                .sort((a, b) => (a.sortOrder ?? 99999) - (b.sortOrder ?? 99999));
            const idx = group.findIndex(b => b.id === id);
            const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
            if (swapIdx < 0 || swapIdx >= group.length) { return; }
            // Ensure sortOrders are numeric
            group.forEach((b, i) => { if (b.sortOrder === undefined) { b.sortOrder = i * 10; } });
            const tmp = group[idx].sortOrder;
            group[idx].sortOrder = group[swapIdx].sortOrder;
            group[swapIdx].sortOrder = tmp;
            // Propagate back to allButtons
            group.forEach(b => {
                const ab = allButtons.find(x => x.id === b.id);
                if (ab) { ab.sortOrder = b.sortOrder; }
            });
            renderButtonLists();
            flashMovedCard('[data-button-id="' + id + '"]');
            vscode.postMessage({ type: 'reorderButton', id, direction });
        }

        function reorderNoteLocal(id, direction) {
            const note = getNote(id);
            if (!note) return;
            const group = allNotes.filter(n => n.locality === note.locality)
                .sort((a, b) => (a.sortOrder ?? 99999) - (b.sortOrder ?? 99999));
            const idx = group.findIndex(n => n.id === id);
            const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
            if (swapIdx < 0 || swapIdx >= group.length) { return; }
            group.forEach((n, index) => { if (n.sortOrder === undefined) { n.sortOrder = index * 10; } });
            const tmp = group[idx].sortOrder;
            group[idx].sortOrder = group[swapIdx].sortOrder;
            group[swapIdx].sortOrder = tmp;
            group.forEach(n => {
                const current = allNotes.find(x => x.id === n.id);
                if (current) { current.sortOrder = n.sortOrder; }
            });
            renderButtonLists();
            flashMovedCard('[data-note-id="' + id + '"]');
            vscode.postMessage({ type: 'reorderNote', id, direction });
        }

        // ─── Type changed ───
        function onTypeChanged() {
            const type = document.getElementById('btn-type').value;
            const info = TYPE_INFO[type] || {};
            document.getElementById('typeHelp').textContent = info.description || '';
            // Close any open dropdowns when type changes
            ['autocompleteList', 'modelAutocomplete', 'workspaceFileList'].forEach(id => {
                document.getElementById(id).classList.remove('visible');
            });
            iconPicker.close();
            modelAutocomplete.close();

            const copilotSection = document.getElementById('copilotSection');
            const execLabel = document.getElementById('executionLabel');
            const execHelp = document.getElementById('executionHelp');
            const execField = document.getElementById('btn-executionText');
            const execPicker = document.getElementById('btn-executionPicker');
            const executionGroup = document.getElementById('executionGroup');
            const terminalTabsGroup = document.getElementById('terminalTabsGroup');

            if (type === 'TerminalCommand') {
                if (!currentTerminals || currentTerminals.length === 0) {
                    currentTerminals = [{ name: 'Terminal 1', commands: '', dependentOnPrevious: false }];
                    activeTerminalTab = 0;
                }
                // Show terminal tabs UI, hide the plain execution group
                executionGroup.style.display = 'none';
                terminalTabsGroup.style.display = '';
                renderTerminalTabs();
            } else {
                terminalTabsGroup.style.display = 'none';
                executionGroup.style.display = '';

                const usePicker = type === 'TaskExecution' || type === 'PaletteAction';
                if (usePicker) {
                    execPicker.value = execField.value;
                    execField.style.display = 'none';
                    execPicker.style.display = '';
                } else {
                    execField.value = execPicker.value;
                    execPicker.style.display = 'none';
                    execField.style.display = '';
                }
            }

            copilotSection.classList.toggle('visible', type === 'CopilotCommand');

            switch (type) {
                case 'TerminalCommand':
                    // no execLabel/execHelp needed — tabs UI handles it
                    break;
                case 'PaletteAction':
                    execLabel.textContent = 'Palette Action';
                    execPicker.placeholder = 'Search and select a VS Code command';
                    execHelp.textContent = 'Pick a command from the list. Advanced: append |{"arg":"value"} manually for command arguments.';
                    if (!cachedCommands) vscode.postMessage({ type: 'getCommands' });
                    break;
                case 'TaskExecution':
                    execLabel.textContent = 'Task';
                    execPicker.placeholder = 'Search and select a task';
                    execHelp.textContent = 'Pick a task discovered from your workspace and extensions.';
                    if (!cachedTasks) vscode.postMessage({ type: 'getTasks' });
                    break;
                case 'CopilotCommand':
                    execLabel.textContent = 'Prompt';
                    execField.placeholder = 'Explain this code and suggest improvements...';
                    execHelp.textContent = 'The prompt text to send to GitHub Copilot Chat';
                    if (!cachedModels) vscode.postMessage({ type: 'getModels' });
                    break;
            }

            // Set up autocomplete for applicable types
            setupAutocomplete(type);
        }

        // ─── Terminal Tabs ───
        function saveCurrentTerminalTab() {
            if (currentTerminals.length === 0) { return; }
            const tab = currentTerminals[activeTerminalTab];
            const cmdsEl = document.getElementById('terminal-tab-commands');
            const depEl  = document.getElementById('terminal-tab-dependent');
            if (cmdsEl) { tab.commands = cmdsEl.value; }
            if (depEl)  { tab.dependentOnPrevious = depEl.checked; }
        }

        function renderTerminalTabs() {
            const bar = document.getElementById('terminalTabsBar');
            if (!bar) { return; }
            if (!currentTerminals || currentTerminals.length === 0) {
                currentTerminals = [{ name: 'Terminal 1', commands: '', dependentOnPrevious: false }];
                activeTerminalTab = 0;
            }
            let html = '';
            currentTerminals.forEach((tab, i) => {
                const active = i === activeTerminalTab ? ' active' : '';
                const isFirst = i === 0;
                const isLast = i === currentTerminals.length - 1;
                html += '<div class="terminal-tab' + active + '" data-terminal-tab-index="' + i + '">' +
                    '<span class="terminal-tab-label">' + escapeHtml(tab.name || ('Terminal ' + (i + 1))) + '</span>' +
                    '<span class="terminal-tab-actions">' +
                    '<button class="btn-icon btn-icon-xs" data-terminal-move-left="' + i + '" title="Move Left"' + (isFirst ? ' disabled' : '') + '>' +
                    '<span class="codicon codicon-chevron-left"></span></button>' +
                    '<button class="btn-icon btn-icon-xs" data-terminal-move-right="' + i + '" title="Move Right"' + (isLast ? ' disabled' : '') + '>' +
                    '<span class="codicon codicon-chevron-right"></span></button>' +
                    '<button class="btn-icon btn-icon-xs" data-terminal-delete="' + i + '" title="Remove Tab"' + (currentTerminals.length === 1 ? ' disabled' : '') + '>' +
                    '<span class="codicon codicon-close"></span></button>' +
                    '</span>' +
                    '</div>';
            });
            html += '<button class="terminal-tab-add" id="terminalTabAdd" title="Add Terminal">+</button>';
            bar.innerHTML = html;
            updateTerminalTabContent();
        }

        function updateTerminalTabContent() {
            if (currentTerminals.length === 0) { return; }
            const tab = currentTerminals[activeTerminalTab];
            const cmdsEl = document.getElementById('terminal-tab-commands');
            const depEl  = document.getElementById('terminal-tab-dependent');
            if (cmdsEl) { cmdsEl.value = tab.commands || ''; }
            if (depEl)  { depEl.checked = tab.dependentOnPrevious || false; }
        }

        function switchTerminalTab(index) {
            saveCurrentTerminalTab();
            activeTerminalTab = index;
            renderTerminalTabs();
        }

        function addTerminalTab() {
            saveCurrentTerminalTab();
            const newName = 'Terminal ' + (currentTerminals.length + 1);
            currentTerminals.push({ name: newName, commands: '', dependentOnPrevious: false });
            activeTerminalTab = currentTerminals.length - 1;
            renderTerminalTabs();
        }

        function moveTerminalTab(index, direction) {
            saveCurrentTerminalTab();
            const swapIdx = direction === 'left' ? index - 1 : index + 1;
            if (swapIdx < 0 || swapIdx >= currentTerminals.length) { return; }
            const tmp = currentTerminals[index];
            currentTerminals[index] = currentTerminals[swapIdx];
            currentTerminals[swapIdx] = tmp;
            activeTerminalTab = swapIdx;
            renderTerminalTabs();
        }

        function deleteTerminalTab(index) {
            if (currentTerminals.length <= 1) { return; }
            saveCurrentTerminalTab();
            currentTerminals.splice(index, 1);
            if (activeTerminalTab >= currentTerminals.length) {
                activeTerminalTab = currentTerminals.length - 1;
            }
            renderTerminalTabs();
        }

        // ─── Tab inline rename ───
        let renamingTabIndex = -1;

        function startTabRename(index) {
            if (renamingTabIndex === index) { return; }
            commitTabRename(); // close any existing rename first
            renamingTabIndex = index;
            const tabEl = document.querySelector('#terminalTabsBar [data-terminal-tab-index="' + index + '"]');
            if (!tabEl) { return; }
            const labelEl = tabEl.querySelector('.terminal-tab-label');
            if (!labelEl) { return; }
            // Position the input over the label
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'terminal-tab-rename-input';
            input.value = currentTerminals[index].name || '';
            input.setAttribute('data-rename-for', String(index));
            // Make label's parent position:relative so the input can overlay it
            tabEl.style.position = 'relative';
            tabEl.appendChild(input);
            labelEl.style.visibility = 'hidden';
            input.focus();
            input.select();

            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { commitTabRename(); e.preventDefault(); }
                if (e.key === 'Escape') { abortTabRename(); e.preventDefault(); }
                e.stopPropagation();
            });
            input.addEventListener('blur', () => {
                // Small delay so that a click on a button (delete, move) can fire first
                setTimeout(() => commitTabRename(), 80);
            });
        }

        function commitTabRename() {
            if (renamingTabIndex < 0) { return; }
            const index = renamingTabIndex;
            renamingTabIndex = -1;
            const tabEl = document.querySelector('#terminalTabsBar [data-terminal-tab-index="' + index + '"]');
            if (!tabEl) { return; }
            const input = tabEl.querySelector('.terminal-tab-rename-input');
            const labelEl = tabEl.querySelector('.terminal-tab-label');
            if (input) {
                const val = input.value.trim();
                if (val.length >= 2) {
                    currentTerminals[index].name = val;
                }
                // val < 2 chars: just keep existing name
                input.remove();
            }
            if (labelEl) {
                labelEl.textContent = currentTerminals[index].name || ('Terminal ' + (index + 1));
                labelEl.style.visibility = '';
            }
            tabEl.style.position = '';
        }

        function abortTabRename() {
            if (renamingTabIndex < 0) { return; }
            const index = renamingTabIndex;
            renamingTabIndex = -1;
            const tabEl = document.querySelector('#terminalTabsBar [data-terminal-tab-index="' + index + '"]');
            if (!tabEl) { return; }
            const input = tabEl.querySelector('.terminal-tab-rename-input');
            const labelEl = tabEl.querySelector('.terminal-tab-label');
            if (input) { input.remove(); }
            if (labelEl) { labelEl.style.visibility = ''; }
            tabEl.style.position = '';
        }

        // Terminal tab bar — event delegation
        document.getElementById('terminalTabsBar').addEventListener('click', (e) => {
            if (!(e.target instanceof Element)) { return; }
            const moveLeft  = e.target.closest('[data-terminal-move-left]');
            const moveRight = e.target.closest('[data-terminal-move-right]');
            const del       = e.target.closest('[data-terminal-delete]');
            const add       = e.target.closest('#terminalTabAdd');
            const tab       = e.target.closest('[data-terminal-tab-index]');
            // Ignore clicks inside the rename input itself
            if (e.target.classList.contains('terminal-tab-rename-input')) { return; }

            if (moveLeft && !moveLeft.disabled) {
                e.stopPropagation();
                commitTabRename();
                moveTerminalTab(parseInt(moveLeft.dataset.terminalMoveLeft), 'left');
            } else if (moveRight && !moveRight.disabled) {
                e.stopPropagation();
                commitTabRename();
                moveTerminalTab(parseInt(moveRight.dataset.terminalMoveRight), 'right');
            } else if (del && !del.disabled) {
                e.stopPropagation();
                commitTabRename();
                deleteTerminalTab(parseInt(del.dataset.terminalDelete));
            } else if (add) {
                commitTabRename();
                addTerminalTab();
            } else if (tab && !e.target.closest('[data-terminal-move-left],[data-terminal-move-right],[data-terminal-delete]')) {
                const idx = parseInt(tab.dataset.terminalTabIndex);
                if (idx !== activeTerminalTab) {
                    switchTerminalTab(idx);
                }
            }
        });

        // Double-click on a tab label → start rename
        document.getElementById('terminalTabsBar').addEventListener('dblclick', (e) => {
            if (!(e.target instanceof Element)) { return; }
            if (e.target.classList.contains('terminal-tab-rename-input')) { return; }
            const tab = e.target.closest('[data-terminal-tab-index]');
            if (tab && !e.target.closest('[data-terminal-move-left],[data-terminal-move-right],[data-terminal-delete],#terminalTabAdd')) {
                e.preventDefault();
                startTabRename(parseInt(tab.dataset.terminalTabIndex));
            }
        });

        // F2 anywhere in the editor overlay while TerminalCommand is active → start rename
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'F2') { return; }
            const overlay = document.getElementById('editorOverlay');
            if (!overlay || !overlay.classList.contains('visible')) { return; }
            const typeEl = document.getElementById('btn-type');
            if (!typeEl || typeEl.value !== 'TerminalCommand') { return; }
            if (e.target instanceof Element && e.target.classList.contains('terminal-tab-rename-input')) { return; }
            startTabRename(activeTerminalTab);
            e.preventDefault();
            e.stopPropagation();
        });

        // ─── Autocomplete ───
        function setupAutocomplete(type) {
            const execField = getExecutionInput();
            const list = document.getElementById('autocompleteList');

            execField.onfocus = null;
            execField.oninput = null;
            execField.onblur = null;
            
            if (type === 'TaskExecution') {
                execField.onfocus = () => {
                    if (cachedTasks) showTaskAutocomplete(cachedTasks);
                    else vscode.postMessage({ type: 'getTasks' });
                };
                execField.oninput = () => {
                    if (cachedTasks) renderAutocomplete(cachedTasks, execField.value);
                };
                execField.onblur = () => {
                    setTimeout(() => { list.classList.remove('visible'); }, 200);
                };
            } else if (type === 'PaletteAction') {
                execField.onfocus = () => {
                    if (cachedCommands) showCommandAutocomplete(cachedCommands);
                    else vscode.postMessage({ type: 'getCommands' });
                };
                execField.oninput = () => {
                    if (cachedCommands) renderAutocomplete(cachedCommands, execField.value);
                };
                execField.onblur = () => {
                    setTimeout(() => { list.classList.remove('visible'); }, 200);
                };
            }
        }

        function showTaskAutocomplete(tasks) {
            if (document.getElementById('btn-type').value !== 'TaskExecution') return;
            const input = getExecutionInput();
            if (document.activeElement !== input) return;
            renderAutocomplete(tasks, input.value);
        }

        function showCommandAutocomplete(commands) {
            if (document.getElementById('btn-type').value !== 'PaletteAction') return;
            const input = getExecutionInput();
            if (document.activeElement !== input) return;
            renderAutocomplete(commands, input.value);
        }

        function renderAutocomplete(items, filter) {
            const list = document.getElementById('autocompleteList');
            const lower = (filter || '').toLowerCase();
            const normalized = items.map(i => typeof i === 'string'
                ? { value: i, label: i, source: '' }
                : { value: i.value, label: i.label || i.value, source: i.source || '' });
            const filtered = normalized.filter(i => {
                if (!lower) { return true; }
                return i.value.toLowerCase().includes(lower)
                    || i.label.toLowerCase().includes(lower)
                    || i.source.toLowerCase().includes(lower);
            }).slice(0, 40);
            
            if (filtered.length === 0) { list.classList.remove('visible'); return; }
            
            list.innerHTML = filtered.map(i => 
                '<div class="autocomplete-item" data-autocomplete-value="' + escapeAttr(i.value) + '">' +
                '<span class="item-label">' + escapeHtml(i.label) + '</span>' +
                (i.source ? '<span class="item-source">' + escapeHtml(i.source) + '</span>' : '') +
                (i.label !== i.value ? '<span class="item-source">' + escapeHtml(i.value) + '</span>' : '') +
                '</div>'
            ).join('');
            list.classList.add('visible');
            list.scrollIntoView({ block: 'nearest' });
        }

        function selectAutocomplete(value) {
            getExecutionInput().value = value;
            document.getElementById('autocompleteList').classList.remove('visible');
        }

        // ─── Files ───
        function pickFiles() {
            vscode.postMessage({ type: 'pickFiles' });
        }

        function onWorkspaceFileSearch() {
            const q = document.getElementById('workspaceFileSearch').value;
            if (!q) { document.getElementById('workspaceFileList').classList.remove('visible'); return; }
            if (!cachedWorkspaceFiles) {
                vscode.postMessage({ type: 'getWorkspaceFiles' });
            } else {
                renderWorkspaceFileList(cachedWorkspaceFiles, q);
            }
        }

        function renderWorkspaceFileList(files, filter) {
            const list = document.getElementById('workspaceFileList');
            const lower = (filter || '').toLowerCase();
            if (!lower) { list.classList.remove('visible'); return; }
            const filtered = files.filter(f => f.toLowerCase().includes(lower)).slice(0, 60);
            if (!filtered.length) { list.classList.remove('visible'); return; }
            list.innerHTML = filtered.map(f =>
                '<div class="autocomplete-item" data-workspace-file="' + escapeAttr(f) + '">' +
                '<span class="item-label">' + escapeHtml(f) + '</span></div>'
            ).join('');
            list.classList.add('visible');
            list.scrollIntoView({ block: 'nearest' });
        }

        function addWorkspaceFile(filePath) {
            if (!currentAttachFiles.includes(filePath)) {
                currentAttachFiles.push(filePath);
                renderFileChips();
            }
            document.getElementById('workspaceFileSearch').value = '';
            document.getElementById('workspaceFileList').classList.remove('visible');
        }

        function renderFileChips() {
            const container = document.getElementById('fileChips');
            container.innerHTML = currentAttachFiles.map((f, i) => 
                '<span class="file-chip">' +
                '<span class="codicon codicon-file"></span> ' + escapeHtml(f) +
                ' <span class="remove-file" data-file-index="' + i + '">\u00d7</span></span>'
            ).join('');
        }

        function removeFile(idx) {
            currentAttachFiles.splice(idx, 1);
            renderFileChips();
        }

        // ─── Utilities ───
        function escapeHtml(s) {
            if (!s) return '';
            return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        }

        function escapeAttr(s) {
            return escapeHtml(s).replace(/'/g, '&#39;');
        }

        // ─── Event Listeners ───
        document.getElementById('addGlobalBtn').addEventListener('click', () => addButton('Global'));
        document.getElementById('addLocalBtn').addEventListener('click', () => addButton('Local'));
        document.getElementById('deleteBtn').addEventListener('click', () => deleteCurrentButton());
        document.getElementById('cancelBtn').addEventListener('click', () => closeEditor());
        document.getElementById('saveBtn').addEventListener('click', () => saveButton());
        document.getElementById('btn-name').addEventListener('input', () => {
            syncNameValidation();
        });
        document.getElementById('btn-type').addEventListener('change', () => onTypeChanged());
        document.getElementById('pickFilesBtn').addEventListener('click', () => pickFiles());
        document.getElementById('setShortcutBtn').addEventListener('click', () => {
            if (currentButton && currentButton.id) {
                vscode.postMessage({ type: 'openKeybinding', buttonId: currentButton.id });
            }
        });

        // Button cards — document-level delegation (covers dynamically rendered content)
        document.addEventListener('click', (e) => {
            const del = e.target.closest('[data-delete-id]');
            if (del) { e.stopPropagation(); confirmDelete(del.dataset.deleteId); return; }
            const noteDel = e.target.closest('[data-note-delete-id]');
            if (noteDel) { e.stopPropagation(); confirmDeleteNote(noteDel.dataset.noteDeleteId); return; }
            const dup = e.target.closest('[data-duplicate-id]');
            if (dup) { e.stopPropagation(); duplicateButton(dup.dataset.duplicateId); return; }
            const moveUp = e.target.closest('[data-move-up-id]');
            if (moveUp && !moveUp.disabled) { e.stopPropagation(); reorderButtonLocal(moveUp.dataset.moveUpId, 'up'); return; }
            const moveDown = e.target.closest('[data-move-down-id]');
            if (moveDown && !moveDown.disabled) { e.stopPropagation(); reorderButtonLocal(moveDown.dataset.moveDownId, 'down'); return; }
            const noteMoveUp = e.target.closest('[data-note-move-up-id]');
            if (noteMoveUp && !noteMoveUp.disabled) { e.stopPropagation(); reorderNoteLocal(noteMoveUp.dataset.noteMoveUpId, 'up'); return; }
            const noteMoveDown = e.target.closest('[data-note-move-down-id]');
            if (noteMoveDown && !noteMoveDown.disabled) { e.stopPropagation(); reorderNoteLocal(noteMoveDown.dataset.noteMoveDownId, 'down'); return; }
            const edit = e.target.closest('[data-edit-id]');
            if (edit) { e.stopPropagation(); isNewButton = false; openEditor(getButton(edit.dataset.editId)); return; }
            const noteEdit = e.target.closest('[data-note-edit-id]');
            if (noteEdit) { e.stopPropagation(); editNote(noteEdit.dataset.noteEditId); return; }
            const card = e.target.closest('[data-button-id]');
            if (card && !e.target.closest('[data-delete-id],[data-duplicate-id],[data-move-up-id],[data-move-down-id],[data-edit-id]')) { isNewButton = false; openEditor(getButton(card.dataset.buttonId)); }
            const noteCard = e.target.closest('[data-note-id]');
            if (noteCard && !e.target.closest('[data-note-delete-id],[data-note-move-up-id],[data-note-move-down-id],[data-note-edit-id]')) { editNote(noteCard.dataset.noteId); }
        });

        // Autocomplete — event delegation
        document.getElementById('autocompleteList').addEventListener('mousedown', (e) => {
            const item = e.target.closest('[data-autocomplete-value]');
            if (item) selectAutocomplete(item.dataset.autocompleteValue);
        });

        // File chips — event delegation
        document.getElementById('fileChips').addEventListener('click', (e) => {
            const remove = e.target.closest('[data-file-index]');
            if (remove) removeFile(parseInt(remove.dataset.fileIndex));
        });

        // Workspace file search
        document.getElementById('workspaceFileSearch').addEventListener('input', onWorkspaceFileSearch);
        document.getElementById('workspaceFileSearch').addEventListener('focus', onWorkspaceFileSearch);
        document.getElementById('workspaceFileSearch').addEventListener('blur', () => {
            setTimeout(() => document.getElementById('workspaceFileList').classList.remove('visible'), 200);
        });

        // Workspace file autocomplete — event delegation
        document.getElementById('workspaceFileList').addEventListener('mousedown', (e) => {
            const item = e.target.closest('[data-workspace-file]');
            if (item) addWorkspaceFile(item.dataset.workspaceFile);
        });

        // ─── Token Table ───
        function renderTokenTable() {
            const tbody = document.getElementById('tokenTableBody');
            let html = '';

            // System tokens section
            html += '<tr class="token-section-header"><td colspan="3"><span class="codicon codicon-server"></span><span>System Tokens</span></td></tr>';
            SYSTEM_TOKENS.forEach(st => {
                html += '<tr draggable="true" data-drag-token="' + escapeAttr(st.token) + '">' +
                    '<td style="color:var(--vscode-textLink-foreground)">' + escapeHtml(st.token) + '</td>' +
                    '<td class="sys-label">' + escapeHtml(st.description) + '</td>' +
                    '<td>' + escapeHtml(st.dataType) + '</td></tr>';
            });

            // User tokens section
            html += '<tr class="token-section-header"><td colspan="3"><span class="codicon codicon-account"></span><span>User Tokens</span></td></tr>';
            if (currentUserTokens.length === 0) {
                html += '<tr><td colspan="3" style="color:var(--vscode-descriptionForeground);font-family:var(--vscode-font-family)">No user tokens defined. Click "Add User Token" to create one.</td></tr>';
            } else {
                currentUserTokens.forEach((ut, i) => {
                    const valDisplay = ut.defaultValue ? escapeHtml(ut.defaultValue) : '<span style="color:var(--vscode-descriptionForeground);font-family:var(--vscode-font-family);font-style:italic">[User Requested]</span>';
                    const reqBadge = ut.required ? ' <span style="color:#c72e2e;font-weight:bold" title="Required">*</span>' : '';
                    html += '<tr class="user-token-table" draggable="true" data-drag-token="' + escapeAttr(ut.token) + '">' +
                        '<td style="color:var(--vscode-textLink-foreground)">' + escapeHtml(ut.token) + reqBadge + '</td>' +
                        '<td style="font-family:var(--vscode-font-family)">' + valDisplay + '</td>' +
                        '<td>' + escapeHtml(ut.dataType) +
                        '<span class="ut-actions">' +
                        '<button class="btn-icon-xs" data-edit-token="' + i + '" title="Edit"><span class="codicon codicon-edit"></span></button>' +
                        '<button class="btn-icon-xs" data-delete-token="' + i + '" title="Delete"><span class="codicon codicon-trash"></span></button>' +
                        '</span></td></tr>';
                });
            }
            tbody.innerHTML = html;
        }

        function scrollUserTokenIntoView(tokenName) {
            if (!tokenName) return;
            const tbody = document.getElementById('tokenTableBody');
            if (!tbody) return;
            const tokenLower = tokenName.toLowerCase();
            const row = Array.from(tbody.querySelectorAll('tr.user-token-table'))
                .find(r => (r.dataset.dragToken || '').toLowerCase() === tokenLower);
            if (row) {
                row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
        }

        function showUserTokenForm(index) {
            const form = document.getElementById('userTokenForm');
            form.style.display = 'block';
            // Clear any prior validation error
            const errEl = document.getElementById('ut-token-error');
            if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
            document.getElementById('ut-token').style.borderColor = '';

            editingTokenIndex = index;
            if (index >= 0 && index < currentUserTokens.length) {
                const t = currentUserTokens[index];
                document.getElementById('utFormTitle').textContent = 'Edit User Token';
                document.getElementById('ut-token').value = t.token || '';
                document.getElementById('ut-datatype').value = t.dataType || 'String';
                document.getElementById('ut-label').value = t.label || '';
                document.getElementById('ut-description').value = t.description || '';
                document.getElementById('ut-defaultValue').value = t.defaultValue || '';
                document.getElementById('ut-required').checked = t.required || false;
            } else {
                document.getElementById('utFormTitle').textContent = 'New User Token';
                document.getElementById('ut-token').value = '';
                document.getElementById('ut-datatype').value = 'String';
                document.getElementById('ut-label').value = '';
                document.getElementById('ut-description').value = '';
                document.getElementById('ut-defaultValue').value = '';
                document.getElementById('ut-required').checked = false;
            }
            document.getElementById('ut-token').focus();
        }

        function hideUserTokenForm() {
            document.getElementById('userTokenForm').style.display = 'none';
            editingTokenIndex = -1;
        }

        function setTokenError(msg) {
            const errEl = document.getElementById('ut-token-error');
            const inp = document.getElementById('ut-token');
            if (msg) {
                errEl.textContent = msg;
                errEl.style.display = 'block';
                inp.style.borderColor = '#c72e2e';
                inp.focus();
            } else {
                errEl.style.display = 'none';
                errEl.textContent = '';
                inp.style.borderColor = '';
            }
        }

        function saveUserToken() {
            let token = (document.getElementById('ut-token').value || '').trim();
            if (!token) {
                setTokenError('Token name is required');
                return;
            }
            // Normalize to exactly one leading and one trailing $.
            token = '$' + token.replace(/^\\$+/, '').replace(/\\$+$/, '') + '$';
            // Validate format: $Identifier$
            if (!/^\\$[A-Za-z_][A-Za-z0-9_]*\\$$/.test(token)) {
                setTokenError('Must be $Identifier$ — letters, digits, underscores only (e.g. $MyToken$)');
                return;
            }
            // Check for system token collision (case-insensitive)
            if (SYSTEM_TOKENS.some(st => st.token.toLowerCase() === token.toLowerCase())) {
                setTokenError('This name conflicts with a system token — choose a different name');
                return;
            }
            // Check for duplicate user token (except when editing the same index)
            const dupIdx = currentUserTokens.findIndex(ut => ut.token.toLowerCase() === token.toLowerCase());
            if (dupIdx >= 0 && dupIdx !== editingTokenIndex) {
                setTokenError('A user token with this name already exists');
                return;
            }
            setTokenError('');

            const ut = {
                token: token,
                label: (document.getElementById('ut-label').value || '').trim(),
                description: (document.getElementById('ut-description').value || '').trim(),
                dataType: document.getElementById('ut-datatype').value,
                defaultValue: (document.getElementById('ut-defaultValue').value || '').trim(),
                required: document.getElementById('ut-required').checked
            };

            if (editingTokenIndex >= 0 && editingTokenIndex < currentUserTokens.length) {
                currentUserTokens[editingTokenIndex] = ut;
            } else {
                currentUserTokens.push(ut);
            }

            renderTokenTable();
            setupTokenDragDrop();
            scrollUserTokenIntoView(token);
            hideUserTokenForm();
        }

        function deleteUserToken(index) {
            if (index >= 0 && index < currentUserTokens.length) {
                currentUserTokens.splice(index, 1);
                renderTokenTable();
                setupTokenDragDrop();
            }
        }

        // ─── Token Drag-Drop ───
        let tokenDragDropInit = false;
        function setupTokenDragDrop() {
            const execText = document.getElementById('btn-executionText');
            const execPicker = document.getElementById('btn-executionPicker');

            if (!tokenDragDropInit) {
                tokenDragDropInit = true;
                // Drag start/end via delegation on the whole table body
                const tbody = document.getElementById('tokenTableBody');
                tbody.addEventListener('dragstart', onTokenDragStart);
                tbody.addEventListener('dragend', onTokenDragEnd);

                // Drop targets — wire once on both exec fields + terminal commands textarea
                const termCmds = document.getElementById('terminal-tab-commands');
                [execText, execPicker, termCmds].forEach(target => {
                    if (!target) { return; }
                    target.addEventListener('dragover', onExecDragOver);
                    target.addEventListener('dragleave', onExecDragLeave);
                    target.addEventListener('drop', onExecDrop);
                });
            }
        }

        function onTokenDragStart(e) {
            const row = e.target.closest('tr[data-drag-token]');
            if (!row) return;
            e.dataTransfer.effectAllowed = 'copy';
            e.dataTransfer.setData('text/plain', row.dataset.dragToken);
            row.classList.add('drag-over-row');
        }

        function onTokenDragEnd(e) {
            document.querySelectorAll('tr.drag-over-row').forEach(r => r.classList.remove('drag-over-row'));
        }

        function onExecDragOver(e) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            e.target.classList.add('drop-target-active');
        }

        function onExecDragLeave(e) {
            e.target.classList.remove('drop-target-active');
        }

        function onExecDrop(e) {
            e.preventDefault();
            e.target.classList.remove('drop-target-active');
            const token = e.dataTransfer.getData('text/plain');
            if (!token) return;
            const el = e.target;
            // For textarea: insert at caret
            if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
                const start = el.selectionStart ?? el.value.length;
                const end = el.selectionEnd ?? el.value.length;
                el.value = el.value.slice(0, start) + token + el.value.slice(end);
                const newPos = start + token.length;
                el.setSelectionRange(newPos, newPos);
                el.focus();
            }
        }

        // Token button events — use delegation on the form container to avoid null issues
        document.getElementById('userTokenForm').addEventListener('click', (e) => {
            if (e.target.closest('#utSaveBtn')) { saveUserToken(); return; }
            if (e.target.closest('#utCancelBtn')) { hideUserTokenForm(); return; }
        });
        document.getElementById('addUserTokenBtn').addEventListener('click', () => showUserTokenForm(-1));

        // Token table event delegation
        document.getElementById('tokenTableBody').addEventListener('click', (e) => {
            const editBtn = e.target.closest('[data-edit-token]');
            if (editBtn) { showUserTokenForm(parseInt(editBtn.dataset.editToken)); return; }
            const delBtn = e.target.closest('[data-delete-token]');
            if (delBtn) { deleteUserToken(parseInt(delBtn.dataset.deleteToken)); return; }
        });

        // Setup drag-drop initially (no user tokens yet, but sets up exec textarea targets)
        setupTokenDragDrop();

        // ─── Options ───
        function onOptionChanged() {
            const colVal = parseInt(document.getElementById('opt-columns').value) || 1;
            const opts = {
                showBuildInformation: document.getElementById('opt-showBuildInfo').checked,
                showAddAndEditorButtons: document.getElementById('opt-showAddEditorBtns').checked,
                showNotes: document.getElementById('opt-showNotes').checked,
                columns: Math.max(1, Math.min(12, colVal))
            };
            const stamp = document.getElementById('headerDebugStamp');
            if (stamp) { stamp.style.display = opts.showBuildInformation ? '' : 'none'; }
            vscode.postMessage({ type: 'saveOptions', options: opts });
        }
        document.getElementById('opt-showBuildInfo').addEventListener('change', onOptionChanged);
        document.getElementById('opt-showAddEditorBtns').addEventListener('change', onOptionChanged);
        document.getElementById('opt-showNotes').addEventListener('change', onOptionChanged);
        document.getElementById('opt-columns').addEventListener('change', onOptionChanged);
        document.getElementById('opt-columns').addEventListener('input', onOptionChanged);
    </script>
    <script src="${editorJsUri}" nonce="${nonce}"></script>
</body>
</html>`;
    }
}
