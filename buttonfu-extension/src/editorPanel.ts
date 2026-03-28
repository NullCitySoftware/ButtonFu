import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { ButtonConfig, ButtonLocality, AVAILABLE_ICONS, COPILOT_MODES, BUTTON_TYPE_INFO, SYSTEM_TOKENS } from './types';
import { ButtonStore } from './buttonStore';
import { buildInfo, getBuildInfoString } from './buildInfo';
import { getNonce, stripJsoncComments } from './utils';

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
    private disposables: vscode.Disposable[] = [];

    private constructor(panel: vscode.WebviewPanel, store: ButtonStore, extensionUri: vscode.Uri) {
        this.panel = panel;
        this.store = store;
        this.extensionUri = extensionUri;

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
                this.panel.webview.postMessage({
                    type: 'refreshButtons',
                    buttons: this.store.getAllButtons(),
                    keybindings: this.getButtonKeybindings(),
                    workspaceName: vscode.workspace.workspaceFolders?.[0]?.name ?? vscode.workspace.name ?? null
                });
            }
        });
        this.disposables.push(storeChangeDisposable);

        // Update workspace name if folders change
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            this.panel.webview.postMessage({
                type: 'workspaceNameChanged',
                workspaceName: vscode.workspace.workspaceFolders?.[0]?.name ?? vscode.workspace.name ?? null
            });
        }, null, this.disposables);
    }

    /** Show the editor panel, or focus it if already open */
    public static createOrShow(store: ButtonStore, extensionUri: vscode.Uri): void {
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

        ButtonEditorPanel.currentPanel = new ButtonEditorPanel(panel, store, extensionUri);
    }

    /** Open the editor and immediately launch the new-button modal */
    public static createOrShowWithNew(store: ButtonStore, extensionUri: vscode.Uri, locality: ButtonLocality = 'Global'): void {
        ButtonEditorPanel.createOrShow(store, extensionUri);
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
    public static createOrShowWithButton(store: ButtonStore, extensionUri: vscode.Uri, buttonId: string): void {
        ButtonEditorPanel.createOrShow(store, extensionUri);
        if (ButtonEditorPanel.currentPanel) {
            setTimeout(() => {
                ButtonEditorPanel.currentPanel?.panel.webview.postMessage({
                    type: 'editButton',
                    buttonId
                });
            }, 300);
        }
    }

    private dispose(): void {
        ButtonEditorPanel.currentPanel = undefined;
        this.panel.dispose();
        while (this.disposables.length) {
            const d = this.disposables.pop();
            if (d) { d.dispose(); }
        }
    }

    private async handleMessage(message: any): Promise<void> {
        switch (message.type) {
            case 'getButtons':
                this.panel.webview.postMessage({
                    type: 'refreshButtons',
                    buttons: this.store.getAllButtons(),
                    keybindings: this.getButtonKeybindings(),
                    workspaceName: vscode.workspace.workspaceFolders?.[0]?.name ?? vscode.workspace.name ?? null
                });
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
            case 'deleteButton':
                await this.store.deleteButton(message.id);
                break;
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
                const models = await this.getAvailableModels();
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
                    if (typeof opts.showBuildInformation === 'boolean') {
                        await ButtonEditorPanel._globalState?.update('options.showBuildInformation', opts.showBuildInformation);
                    }
                    if (typeof opts.showAddAndEditorButtons === 'boolean') {
                        await ButtonEditorPanel._globalState?.update('options.showAddAndEditorButtons', opts.showAddAndEditorButtons);
                    }
                    if (typeof opts.columns === 'number' && opts.columns >= 1 && opts.columns <= 12) {
                        await ButtonEditorPanel._globalState?.update('options.columns', Math.round(opts.columns));
                    }
                    ButtonEditorPanel._onOptionsChanged?.();
                }
                break;
            }
            case 'reorderButton': {
                await this.store.reorderButton(message.id as string, message.direction as 'up' | 'down');
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

    private async getAvailableModels(): Promise<Array<{ id: string; name: string; vendor: string; family: string; maxInputTokens: number }>> {
        try {
            const models = await vscode.lm.selectChatModels();
            return models.map(m => ({
                id: m.id,
                name: m.name || m.id,
                vendor: m.vendor || '',
                family: m.family || '',
                maxInputTokens: m.maxInputTokens || 0
            }));
        } catch {
            // API not available
        }
        return [];
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
        const buildInfoStr = getBuildInfoString();
        const renderStamp = `EDITOR ${buildInfo.version} #${buildInfo.buildNumber} ${buildInfo.buildTime}`;
        const showBuildInfo = ButtonEditorPanel._globalState?.get<boolean>('options.showBuildInformation', false) ?? false;
        const showAddEditorButtons = ButtonEditorPanel._globalState?.get<boolean>('options.showAddAndEditorButtons', true) ?? true;
        const columns = ButtonEditorPanel._globalState?.get<number>('options.columns', 1) ?? 1;
        const webview = this.panel.webview;

        const codiconsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css')
        );
        const editorJsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'resources', 'editor.js')
        );
        const iconUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'resources', 'icon.svg')
        );
        const iconImg = `<img src="${iconUri}" width="16" height="16" style="flex-shrink:0;vertical-align:middle" alt="">`;

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

        /* ─── Icon Picker ─── */
        .icon-picker-trigger {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 6px 10px;
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            cursor: pointer;
            font-size: var(--vscode-font-size);
            color: var(--vscode-input-foreground);
        }
        .icon-picker-trigger:hover { border-color: var(--vscode-focusBorder); }
        .icon-picker-trigger .preview-icon {
            font-size: 16px;
        }

        .icon-picker-dropdown {
            display: none;
            position: absolute;
            z-index: 50;
            background: var(--vscode-dropdown-background);
            border: 1px solid var(--vscode-dropdown-border);
            border-radius: 6px;
            box-shadow: 0 4px 16px rgba(0,0,0,0.3);
            width: 320px;
            max-height: 300px;
            overflow: hidden;
        }
        .icon-picker-dropdown.visible { display: block; }
        .icon-picker-search {
            padding: 8px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .icon-picker-search input {
            width: 100%;
            padding: 4px 8px;
            border: 1px solid var(--vscode-input-border);
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border-radius: 3px;
            font-size: 12px;
            outline: none;
        }
        .icon-picker-grid {
            display: grid;
            grid-template-columns: repeat(8, 1fr);
            gap: 2px;
            padding: 8px;
            max-height: 240px;
            overflow-y: auto;
        }
        .icon-picker-item {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 32px;
            height: 32px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 16px;
            color: var(--vscode-foreground);
        }
        .icon-picker-item:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .icon-picker-item.selected {
            background: var(--vscode-list-activeSelectionBackground);
            color: var(--vscode-list-activeSelectionForeground);
        }

        /* ─── Colour Picker ─── */
        .colour-row {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .colour-alpha-row {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-top: 8px;
        }
        .colour-alpha-label {
            width: 40px;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            flex-shrink: 0;
        }
        .colour-alpha-range {
            flex: 1;
        }
        .colour-alpha-number {
            width: 64px;
        }
        .colour-alpha-value {
            min-width: 42px;
            text-align: right;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            flex-shrink: 0;
        }
        .colour-preview {
            width: 28px;
            height: 28px;
            border-radius: 4px;
            border: 1px solid var(--vscode-input-border);
            cursor: pointer;
        }
        .colour-effective-preview {
            width: 28px;
            height: 28px;
            border-radius: 4px;
            border: 1px solid var(--vscode-input-border);
            background-color: transparent;
            background-image:
                linear-gradient(45deg, rgba(0,0,0,0.12) 25%, transparent 25%),
                linear-gradient(-45deg, rgba(0,0,0,0.12) 25%, transparent 25%),
                linear-gradient(45deg, transparent 75%, rgba(0,0,0,0.12) 75%),
                linear-gradient(-45deg, transparent 75%, rgba(0,0,0,0.12) 75%);
            background-size: 10px 10px;
            background-position: 0 0, 0 5px, 5px -5px, -5px 0;
            flex-shrink: 0;
        }
        .colour-clear {
            flex-shrink: 0;
        }
        .colour-presets {
            display: flex;
            gap: 4px;
            flex-wrap: wrap;
            margin-top: 6px;
        }
        .colour-swatch {
            width: 20px;
            height: 20px;
            border-radius: 3px;
            cursor: pointer;
            border: 1px solid transparent;
            transition: transform 0.1s;
        }
        .colour-swatch:hover { transform: scale(1.2); }
        .colour-swatch.selected { border-color: var(--vscode-focusBorder); }

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

        /* ─── Autocomplete ─── */
        .autocomplete-container { position: relative; }
        .autocomplete-list {
            display: none;
            position: absolute;
            top: 100%;
            left: 0;
            right: 0;
            z-index: 50;
            background: var(--vscode-dropdown-background);
            border: 1px solid var(--vscode-dropdown-border);
            border-radius: 4px;
            max-height: 200px;
            overflow-y: auto;
            box-shadow: 0 4px 12px rgba(0,0,0,0.2);
        }
        .autocomplete-list.visible { display: block; }
        .autocomplete-item {
            padding: 6px 10px;
            cursor: pointer;
            font-size: 12px;
        }
        .autocomplete-item:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .autocomplete-item .item-label { font-weight: 500; }
        .autocomplete-item .item-source {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            margin-left: 8px;
        }

        /* ─── Model list ─── */
        .model-group-header {
            padding: 4px 10px 2px;
            font-size: 10px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--vscode-descriptionForeground);
            background: var(--vscode-sideBar-background);
            border-bottom: 1px solid var(--vscode-panel-border);
            position: sticky;
            top: 0;
        }
        .model-item {
            display: flex !important;
            flex-direction: column !important;
            align-items: stretch !important;
            gap: 1px;
            padding: 5px 10px !important;
        }
        .model-item .item-label {
            font-weight: 500;
            font-size: 12px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .model-item .model-details {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            display: flex;
            gap: 6px;
            align-items: center;
        }
        .model-ctx {
            padding: 0 4px;
            border-radius: 3px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
        }

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
            <div class="tab active" data-tab="global">
                <span class="codicon codicon-globe"></span>
                Global Buttons
                <span class="badge" id="globalCount">0</span>
            </div>
            <div class="tab" data-tab="local">
                <span class="codicon codicon-home"></span>
                Workspace Buttons
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
                    <h2>Global Buttons</h2>
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
                        <div class="option-item-desc">When enabled, shows the "Add Button" and "Editor" buttons at the bottom of the sidebar. Buttons can still be edited via the gear icon in the titlebar.</div>
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
                                <label for="terminal-tab-dependent" style="cursor:pointer;margin:0;font-size:13px;font-weight:600;text-transform:none;letter-spacing:0;color:var(--vscode-foreground)">Dependant On Previous Terminal Success</label>
                            </div>
                            <div class="field-help">When all terminals have this enabled, each one waits for the previous to succeed before running</div>
                        </div>
                    </div>
                </div>
            </div>

            <div class="form-row">
                <div class="form-group" style="position:relative">
                    <label>Icon</label>
                    <div class="icon-picker-trigger" id="iconTrigger">
                        <span class="preview-icon codicon" id="iconPreview"></span>
                        <span id="iconLabel">Select icon...</span>
                    </div>
                    <input type="hidden" id="btn-icon" />
                    <div class="icon-picker-dropdown" id="iconDropdown">
                        <div class="icon-picker-search">
                            <input type="text" id="iconSearch" placeholder="Search icons..." />
                        </div>
                        <div class="icon-picker-grid" id="iconGrid"></div>
                    </div>
                </div>
                <div class="form-group">
                    <label>Colour</label>
                    <div class="colour-row">
                        <input type="color" class="colour-preview" id="btn-colour-picker" />
                        <div class="colour-effective-preview" id="btn-colour-effective-preview" title="Default sidebar colour"></div>
                        <input type="text" id="btn-colour" placeholder="#ffffff, #ffffffbf, or theme token" style="flex:1" />
                        <button type="button" class="btn-icon colour-clear" id="btn-colour-clear" title="Clear colour" aria-label="Clear colour">
                            <span class="codicon codicon-close"></span>
                        </button>
                    </div>
                    <div class="colour-alpha-row">
                        <label class="colour-alpha-label" for="btn-colour-alpha">Alpha</label>
                        <input type="range" class="colour-alpha-range" id="btn-colour-alpha" min="0" max="100" value="100" />
                        <input type="number" class="colour-alpha-number" id="btn-colour-alpha-number" min="0" max="100" value="100" />
                        <span class="colour-alpha-value" id="btn-colour-alpha-value">100%</span>
                    </div>
                    <div class="colour-presets">
                        <div class="colour-swatch" style="background:#4fc3f7" data-colour="#4fc3f7" title="Blue"></div>
                        <div class="colour-swatch" style="background:#4caf50" data-colour="#4caf50" title="Green"></div>
                        <div class="colour-swatch" style="background:#ff9800" data-colour="#ff9800" title="Orange"></div>
                        <div class="colour-swatch" style="background:#f44336" data-colour="#f44336" title="Red"></div>
                        <div class="colour-swatch" style="background:#9c27b0" data-colour="#9c27b0" title="Purple"></div>
                        <div class="colour-swatch" style="background:#ffeb3b" data-colour="#ffeb3b" title="Yellow"></div>
                        <div class="colour-swatch" style="background:#00bcd4" data-colour="#00bcd4" title="Cyan"></div>
                        <div class="colour-swatch" style="background:#e91e63" data-colour="#e91e63" title="Pink"></div>
                        <div class="colour-swatch" style="background:#607d8b" data-colour="#607d8b" title="Grey"></div>
                        <div class="colour-swatch" style="background:#ffffff" data-colour="" title="Default (no colour)"></div>
                    </div>
                    <div class="colour-presets">
                        <div class="colour-swatch" style="background:#a4d8fbbf" data-colour="#a4d8fbbf" title="Pastel Blue"></div>
                        <div class="colour-swatch" style="background:#a0e8bdbf" data-colour="#a0e8bdbf" title="Pastel Green"></div>
                        <div class="colour-swatch" style="background:#ffd89bbf" data-colour="#ffd89bbf" title="Pastel Peach"></div>
                        <div class="colour-swatch" style="background:#ffaea7bf" data-colour="#ffaea7bf" title="Pastel Coral"></div>
                        <div class="colour-swatch" style="background:#dab7e8bf" data-colour="#dab7e8bf" title="Pastel Lavender"></div>
                        <div class="colour-swatch" style="background:#fffac2bf" data-colour="#fffac2bf" title="Pastel Yellow"></div>
                        <div class="colour-swatch" style="background:#99eee2bf" data-colour="#99eee2bf" title="Pastel Teal"></div>
                        <div class="colour-swatch" style="background:#ffadc5bf" data-colour="#ffadc5bf" title="Pastel Rose"></div>
                        <div class="colour-swatch" style="background:#bfc6efbf" data-colour="#bfc6efbf" title="Pastel Periwinkle"></div>
                        <div class="colour-swatch" style="background:#dacbc5bf" data-colour="#dacbc5bf" title="Pastel Taupe"></div>
                    </div>
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
                        <div class="autocomplete-container">
                            <input type="text" id="btn-copilotModel" placeholder="auto" />
                            <div class="autocomplete-list" id="modelAutocomplete"></div>
                        </div>
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
        globalThis.vscode = acquireVsCodeApi();
        globalThis.ICONS = ${iconsJson};
        globalThis.MODES = ${modesJson};
        globalThis.TYPE_INFO = ${typeInfoJson};
        globalThis.SYSTEM_TOKENS = ${systemTokensJson};
    </script>
    <script src="${editorJsUri}" nonce="${nonce}"></script>
</body>
</html>`;
    }
}
