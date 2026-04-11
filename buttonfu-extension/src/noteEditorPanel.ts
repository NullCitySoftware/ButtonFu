import * as vscode from 'vscode';
import * as fs from 'fs';
import { buildInfo, getBuildInfoString } from './buildInfo';
import { AVAILABLE_ICONS, ButtonLocality, COPILOT_MODES, NOTE_DEFAULT_ACTIONS, NoteConfig, createDefaultNote } from './types';
import { NoteStore } from './noteStore';
import {
    getAutocompleteStyles,
    getAvailableCopilotModels,
    getCollapsibleCardStyles,
    getColourFieldStyles,
    getIconPickerStyles,
    getNonce,
    getSharedWebviewControlScript,
    renderCollapsibleCardMarkup,
    renderColourFieldMarkup,
    renderIconPickerMarkup,
    renderModelAutocompleteMarkup
} from './webviewControls';

interface NoteEditorRequest {
    mode: 'new' | 'edit';
    nodeId?: string;
    locality: ButtonLocality;
}

/** Focused note editor panel for creating and editing a single note at a time. */
export class NoteEditorPanel {
    public static currentPanel: NoteEditorPanel | undefined;
    private static _globalState: vscode.Memento | undefined;
    private static readonly uiStateKey = 'noteEditor.uiState';

    private readonly panel: vscode.WebviewPanel;
    private readonly disposables: vscode.Disposable[] = [];

    private currentRequest: NoteEditorRequest = {
        mode: 'new',
        locality: 'Global'
    };

    public static configure(globalState: vscode.Memento): void {
        NoteEditorPanel._globalState = globalState;
    }

    private constructor(panel: vscode.WebviewPanel, private readonly store: NoteStore, private readonly extensionUri: vscode.Uri) {
        this.panel = panel;
        this.panel.webview.html = this.getHtmlContent();

        this.panel.webview.onDidReceiveMessage((message) => this.handleMessage(message), null, this.disposables);
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.onDidChangeViewState((event) => {
            if (event.webviewPanel.visible) {
                this.postState();
            }
        }, null, this.disposables);
        this.disposables.push(this.store.onDidChange(() => this.postState()));
        vscode.workspace.onDidChangeWorkspaceFolders(() => this.postState(), null, this.disposables);
    }

    /** Show the note editor, or focus it if already open. */
    public static createOrShow(store: NoteStore, extensionUri: vscode.Uri): void {
        if (NoteEditorPanel.currentPanel) {
            NoteEditorPanel.currentPanel.panel.reveal(vscode.ViewColumn.One);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'buttonfu.noteEditor',
            'ButtonFu - Note Editor',
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

        NoteEditorPanel.currentPanel = new NoteEditorPanel(panel, store, extensionUri);
    }

    /** Open the editor in new-note mode. */
    public static createOrShowWithNew(
        store: NoteStore,
        extensionUri: vscode.Uri,
        locality: ButtonLocality = 'Global'
    ): void {
        NoteEditorPanel.createOrShow(store, extensionUri);
        NoteEditorPanel.currentPanel?.setRequest({
            mode: 'new',
            locality
        });
    }

    /** Open the editor for an existing note. */
    public static createOrShowWithNode(store: NoteStore, extensionUri: vscode.Uri, nodeId: string): void {
        const node = store.getNode(nodeId);
        if (!node) {
            vscode.window.showErrorMessage(`Note item not found: ${nodeId}`);
            return;
        }

        NoteEditorPanel.createOrShow(store, extensionUri);
        NoteEditorPanel.currentPanel?.setRequest({
            mode: 'edit',
            nodeId: node.id,
            locality: node.locality
        });
    }

    /** Close the current note editor panel if it is open. */
    public static closeCurrent(): void {
        NoteEditorPanel.currentPanel?.panel.dispose();
    }

    private setRequest(request: NoteEditorRequest): void {
        this.currentRequest = request;
        this.postState();
        this.panel.reveal(vscode.ViewColumn.One);
    }

    private dispose(): void {
        NoteEditorPanel.currentPanel = undefined;
        while (this.disposables.length > 0) {
            const disposable = this.disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }

    private async handleMessage(message: any): Promise<void> {
        switch (message.type) {
            case 'requestData':
                this.postState();
                break;
            case 'saveNode': {
                try {
                    const saved = await this.store.saveNode((message.note ?? message.node) as NoteConfig);
                    this.currentRequest = {
                        mode: 'edit',
                        nodeId: saved.id,
                        locality: saved.locality
                    };
                    this.postState();
                } catch (error) {
                    const messageText = error instanceof Error ? error.message : 'Failed to save the note.';
                    void vscode.window.showErrorMessage(messageText);
                }
                break;
            }
            case 'deleteNode': {
                const nodeId = String(message.id || '');
                if (!nodeId) {
                    break;
                }
                const node = this.store.getNode(nodeId);
                if (!node) {
                    break;
                }
                await vscode.commands.executeCommand('buttonfu.deleteNoteNode', nodeId);
                if (!this.store.getNode(nodeId)) {
                    this.currentRequest = {
                        mode: 'new',
                        locality: node.locality
                    };
                    this.postState();
                }
                break;
            }
            case 'pickFiles': {
                const uris = await vscode.window.showOpenDialog({
                    canSelectFiles: true,
                    canSelectFolders: false,
                    canSelectMany: true,
                    openLabel: 'Attach Files'
                });
                if (uris && uris.length > 0) {
                    const files = uris.map((uri) => {
                        const relative = vscode.workspace.asRelativePath(uri, false);
                        return relative !== uri.fsPath ? relative : uri.fsPath;
                    });
                    this.panel.webview.postMessage({ type: 'filesPicked', files });
                }
                break;
            }
            case 'getModels': {
                const models = await getAvailableCopilotModels();
                this.panel.webview.postMessage({ type: 'modelsResult', models });
                break;
            }
            case 'saveUiState': {
                const key = typeof message.key === 'string' ? message.key.trim() : '';
                if (!key) {
                    break;
                }
                const current = NoteEditorPanel._globalState?.get<Record<string, boolean>>(NoteEditorPanel.uiStateKey, {}) ?? {};
                current[key] = !!message.value;
                await NoteEditorPanel._globalState?.update(NoteEditorPanel.uiStateKey, current);
                break;
            }
            case 'close':
                this.panel.dispose();
                break;
        }
    }

    private postState(): void {
        const resolvedRequest = this.resolveRequest();
        this.panel.webview.postMessage({
            type: 'setState',
            nodes: this.store.getAllNodes(),
            request: resolvedRequest,
            workspaceName: vscode.workspace.workspaceFolders?.[0]?.name ?? vscode.workspace.name ?? null,
            hasWorkspace: !!(vscode.workspace.workspaceFolders?.length || vscode.workspace.name)
        });
    }

    private resolveRequest(): NoteEditorRequest {
        if (this.currentRequest.mode === 'edit' && this.currentRequest.nodeId) {
            const node = this.store.getNode(this.currentRequest.nodeId);
            if (node) {
                return {
                    mode: 'edit',
                    nodeId: node.id,
                    locality: node.locality
                };
            }

            return {
                mode: 'new',
                locality: this.currentRequest.locality
            };
        }

        return this.currentRequest;
    }

    private getHtmlContent(): string {
        const nonce = getNonce();
        const iconsJson = JSON.stringify(AVAILABLE_ICONS);
        const modesJson = JSON.stringify(COPILOT_MODES);
        const defaultActionsJson = JSON.stringify(NOTE_DEFAULT_ACTIONS);
        const defaultNoteJson = JSON.stringify(createDefaultNote());
        const autocompleteStyles = getAutocompleteStyles();
        const collapsibleCardStyles = getCollapsibleCardStyles();
        const colourFieldStyles = getColourFieldStyles();
        const iconPickerStyles = getIconPickerStyles();
        const sharedControlScript = getSharedWebviewControlScript();
        const noteIconPickerMarkup = renderIconPickerMarkup({
            triggerId: 'nodeIconTrigger',
            previewId: 'nodeIconPreview',
            labelId: 'nodeIconLabel',
            inputId: 'nodeIcon',
            dropdownId: 'nodeIconDropdown',
            searchId: 'nodeIconSearch',
            gridId: 'nodeIconGrid',
            defaultLabel: 'Select icon...'
        });
        const noteModelAutocompleteMarkup = renderModelAutocompleteMarkup({
            inputId: 'noteCopilotModel',
            listId: 'noteModelAutocomplete',
            triggerId: 'noteModelAutocompleteTrigger',
            placeholder: 'auto'
        });
        const noteColourFieldMarkup = renderColourFieldMarkup({
            wrapperId: 'noteColourField',
            pickerId: 'nodeColourPicker',
            inputId: 'nodeColour',
            alphaId: 'nodeColour-alpha',
            placeholder: '#ffffff or theme token'
        });
        const initialUiStateJson = JSON.stringify(NoteEditorPanel._globalState?.get<Record<string, boolean>>(NoteEditorPanel.uiStateKey, {}) ?? {});
        const buildInfoStr = getBuildInfoString();
        const renderStamp = `NOTE EDITOR ${buildInfo.version} #${buildInfo.buildNumber} ${buildInfo.buildTime}`;
        const showBuildInfo = NoteEditorPanel._globalState?.get<boolean>('options.showBuildInformation', false) ?? false;
        const userTokensCardMarkup = renderCollapsibleCardMarkup({
            cardId: 'userTokensCard',
            toggleId: 'userTokensCardToggle',
            iconId: 'userTokensCardIcon',
            bodyId: 'userTokensCardBody',
            title: 'User Tokens',
            description: 'Optional tokens like $PromptTopic$ that can be filled at action time.',
            content: `                    <div id="tokenTableWrap"></div>
                    <div style="padding-top:12px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;">
                        <div class="field">
                            <label for="tokenName">Token</label>
                            <input type="text" id="tokenName" placeholder="$MyToken$" />
                        </div>
                        <div class="field">
                            <label for="tokenLabel">Label</label>
                            <input type="text" id="tokenLabel" placeholder="Prompt topic" />
                        </div>
                        <div class="field full">
                            <label for="tokenDescription">Description</label>
                            <input type="text" id="tokenDescription" placeholder="What the user should enter" />
                        </div>
                        <div class="field">
                            <label for="tokenType">Data Type</label>
                            <select id="tokenType">
                                <option value="String">String</option>
                                <option value="MultiLineString">Multi-line String</option>
                                <option value="Integer">Integer</option>
                                <option value="Boolean">Boolean</option>
                            </select>
                        </div>
                        <div class="field">
                            <label for="tokenDefault">Default Value</label>
                            <input type="text" id="tokenDefault" placeholder="Leave blank to ask at runtime" />
                        </div>
                        <div class="field full setting-row">
                            <div class="setting-row-copy">
                                <div class="setting-row-title">Required token</div>
                                <div class="setting-row-desc">Require a runtime value when no default value is supplied.</div>
                            </div>
                            <input type="checkbox" class="setting-checkbox" id="tokenRequired" />
                        </div>
                        <div class="field full">
                            <div class="token-actions">
                                <button class="btn btn-primary" id="saveTokenBtn"><span class="codicon codicon-save"></span> Save Token</button>
                                <button class="btn btn-secondary" id="clearTokenBtn">Clear Token Editor</button>
                            </div>
                        </div>
                    </div>`
        });
        const webview = this.panel.webview;

        const codiconsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css')
        );
        const iconSvgPath = vscode.Uri.joinPath(this.extensionUri, 'resources', 'icon.svg').fsPath;
        const iconSvg = fs.readFileSync(iconSvgPath, 'utf8')
            .replace('<svg ', '<svg width="16" height="16" style="flex-shrink:0;vertical-align:middle" ');

        return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${webview.cspSource}; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}';">
    <link rel="stylesheet" href="${codiconsUri}">
    <title>ButtonFu - Note Editor</title>
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
        .editor-shell {
            flex: 1 1 auto;
            overflow-y: auto;
        }
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
        }
        .layout {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 14px 16px;
        }
        .field {
            display: flex;
            flex-direction: column;
            gap: 6px;
        }
        .field.full {
            grid-column: 1 / -1;
        }
        label {
            font-size: 12px;
            font-weight: 600;
            color: var(--vscode-descriptionForeground);
            text-transform: uppercase;
            letter-spacing: 0.4px;
        }
        input[type="text"],
        select,
        textarea {
            width: 100%;
            padding: 8px 10px;
            font: inherit;
            color: var(--vscode-input-foreground);
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
        }
        textarea {
            min-height: 120px;
            resize: vertical;
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
${autocompleteStyles}
${collapsibleCardStyles}
${colourFieldStyles}
${iconPickerStyles}
        input[type="checkbox"] {
            accent-color: var(--vscode-button-background);
        }
        .field-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
        }
        .field-help {
            font-size: 11px;
            line-height: 1.5;
            color: var(--vscode-descriptionForeground);
        }
        .note-section {
            margin-top: 18px;
            padding-top: 18px;
            border-top: 1px solid var(--vscode-panel-border);
        }
        .setting-row {
            grid-column: 1 / -1;
            display: flex;
            align-items: flex-start;
            justify-content: space-between;
            gap: 14px;
            padding: 12px 14px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            background: var(--vscode-input-background);
        }
        .setting-row-copy {
            display: flex;
            flex-direction: column;
            gap: 4px;
            flex: 1 1 auto;
            min-width: 0;
        }
        .setting-row-title {
            font-size: 13px;
            font-weight: 600;
            color: var(--vscode-foreground);
        }
        .setting-row-desc {
            font-size: 11px;
            line-height: 1.5;
            color: var(--vscode-descriptionForeground);
        }
        .setting-checkbox {
            width: 16px;
            height: 16px;
            flex-shrink: 0;
            margin-top: 2px;
        }
        .token-table {
            width: 100%;
            border-collapse: collapse;
        }
        .token-table th,
        .token-table td {
            padding: 8px 10px;
            border-bottom: 1px solid var(--vscode-panel-border);
            vertical-align: top;
            text-align: left;
        }
        .token-table th {
            font-size: 11px;
            text-transform: uppercase;
            color: var(--vscode-descriptionForeground);
        }
        .token-table td code {
            font-family: var(--vscode-editor-font-family), monospace;
        }
        .token-empty {
            padding: 14px 12px;
            color: var(--vscode-descriptionForeground);
        }
        .token-actions {
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
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
        @media (max-width: 900px) {
            .layout {
                grid-template-columns: 1fr;
            }
        }
    </style>
</head>
<body>
    <div class="app-container">
        <div class="header">
            <h1>
                ${iconSvg}
                ButtonFu
                <span class="version">${buildInfoStr}</span>
                <span class="debug-stamp" id="headerDebugStamp"${showBuildInfo ? '' : ' style="display:none"'}>RUNNING BUILD: ${renderStamp}</span>
            </h1>
        </div>

        <div class="editor-shell">
            <div class="editor-header">
                <h2>
                    <span class="codicon codicon-edit"></span>
                    <span id="editorTitle">Create Note</span>
                </h2>
                <div class="actions">
                    <button class="btn btn-danger" id="deleteBtn">
                        <span class="codicon codicon-trash"></span> Delete
                    </button>
                    <button class="btn btn-primary" id="saveBtn">
                        <span class="codicon codicon-save"></span> Save
                    </button>
                    <button class="btn btn-secondary" id="closeBtn">
                        <span class="codicon codicon-chrome-close"></span> Cancel
                    </button>
                </div>
            </div>

            <div class="editor-body">
                <div class="layout">
                    <div class="field">
                        <label for="nodeName">Name</label>
                        <input type="text" id="nodeName" placeholder="Enter a name" />
                        <span class="field-error" id="nodeNameError"></span>
                    </div>
                    <div class="field">
                        <label for="noteCategory">Category</label>
                        <input type="text" id="noteCategory" placeholder="General" />
                    </div>
                    <div class="field">
                        <label for="nodeLocality">Scope</label>
                        <select id="nodeLocality"></select>
                    </div>
                    <div class="field">
                        <label for="noteDefaultAction">Default Click Action</label>
                        <select id="noteDefaultAction"></select>
                        <div class="field-help">The main split-button click in the sidebar uses this action.</div>
                    </div>
                    <div class="field" style="position:relative">
                        <label for="nodeIcon">Icon</label>
${noteIconPickerMarkup}
                    </div>
                    <div class="field">
                        <label for="nodeColour">Colour</label>
${noteColourFieldMarkup}
                    </div>
                </div>

                <div class="note-section">
                    <div class="layout">
                        <div class="field">
                            <label for="noteFormat">Format</label>
                            <select id="noteFormat">
                                <option value="PlainText">Plain Text</option>
                                <option value="Markdown">Markdown</option>
                            </select>
                        </div>
                        <div class="field">
                            <label for="noteCopilotMode">Copilot Mode</label>
                            <select id="noteCopilotMode"></select>
                        </div>
                        <div class="field">
                            <label for="noteCopilotModel">Copilot Model</label>
${noteModelAutocompleteMarkup}
                        </div>
                        <div class="field full setting-row">
                            <div class="setting-row-copy">
                                <div class="setting-row-title">Enable token resolution</div>
                                <div class="setting-row-desc">Resolve ButtonFu tokens before Copy, Insert, and Send to Copilot.</div>
                            </div>
                            <input type="checkbox" class="setting-checkbox" id="notePromptEnabled" />
                        </div>
                        <div class="field full">
                            <label for="noteContent">Content</label>
                            <textarea id="noteContent" rows="12" placeholder="Write the note content here"></textarea>
                        </div>
                        <div class="field full setting-row">
                            <div class="setting-row-copy">
                                <div class="setting-row-title">Attach active editor file</div>
                                <div class="setting-row-desc">Include the current editor file automatically when sending this note to Copilot.</div>
                            </div>
                            <input type="checkbox" class="setting-checkbox" id="noteAttachActiveFile" />
                        </div>
                        <div class="field full">
                            <div class="field-header">
                                <label for="noteAttachFiles">Attached Files</label>
                                <button class="btn btn-secondary" id="pickFilesBtn"><span class="codicon codicon-files"></span> Pick Attachments</button>
                            </div>
                            <textarea id="noteAttachFiles" rows="4" placeholder="One file path per line"></textarea>
                            <div class="field-help">Use one workspace-relative or absolute file path per line.</div>
                        </div>
                    </div>

${userTokensCardMarkup}
                </div>
            </div>
        </div>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const availableIcons = ${iconsJson};
        const copilotModes = ${modesJson};
        const noteDefaultActions = ${defaultActionsJson};
        const defaultNote = ${defaultNoteJson};
${sharedControlScript}

        let currentNodes = [];
        let currentRequest = null;
        let workspaceName = null;
        let hasWorkspace = false;
        let currentNode = null;
        let currentUserTokens = [];
        let editingTokenIndex = -1;
        let cachedModels = null;
        let lastRequestKey = '';
        let draftLocality = null;
        let uiState = Object.assign({}, ${initialUiStateJson}, typeof vscode.getState === 'function' ? (vscode.getState() || {}) : {});
        const iconPicker = createButtonFuIconPicker({
            icons: availableIcons,
            triggerId: 'nodeIconTrigger',
            previewId: 'nodeIconPreview',
            labelId: 'nodeIconLabel',
            inputId: 'nodeIcon',
            dropdownId: 'nodeIconDropdown',
            searchId: 'nodeIconSearch',
            gridId: 'nodeIconGrid',
            defaultLabel: 'Select icon...'
        });
        const modelAutocomplete = createButtonFuModelAutocomplete({
            inputId: 'noteCopilotModel',
            listId: 'noteModelAutocomplete',
            triggerId: 'noteModelAutocompleteTrigger',
            requestModels: () => {
                if (!cachedModels) {
                    vscode.postMessage({ type: 'getModels' });
                }
            }
        });
        const colourField = createButtonFuColourField({
            wrapperId: 'noteColourField',
            inputId: 'nodeColour',
            pickerId: 'nodeColourPicker',
            alphaId: 'nodeColour-alpha'
        });
        const userTokensCard = createButtonFuCollapsibleCard({
            cardId: 'userTokensCard',
            toggleId: 'userTokensCardToggle',
            bodyId: 'userTokensCardBody',
            iconId: 'userTokensCardIcon',
            initialCollapsed: !!uiState.userTokensCollapsed,
            onToggle: (collapsed) => {
                uiState.userTokensCollapsed = collapsed;
                if (typeof vscode.setState === 'function') {
                    vscode.setState(uiState);
                }
                vscode.postMessage({ type: 'saveUiState', key: 'userTokensCollapsed', value: collapsed });
            }
        });
        modelAutocomplete.prefetch();

        function escapeHtml(value) {
            if (!value) return '';
            return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        }

        function clone(value) {
            return JSON.parse(JSON.stringify(value));
        }

        function getDefaultActionLabel(action) {
            switch (action) {
                case 'insert': return 'Insert into Active Editor';
                case 'copilot': return 'Send to Copilot Chat';
                case 'copy': return 'Copy to Clipboard';
                default: return 'Open / Preview';
            }
        }

        function getRequestKey(request) {
            if (!request) {
                return '';
            }

            if (request.mode === 'edit') {
                return 'edit:' + (request.nodeId || '');
            }

            return 'new:' + (request.locality || 'Global');
        }

        function focusNameFieldIfNeeded(requestKey) {
            if (!currentRequest || currentRequest.mode !== 'new' || requestKey === lastRequestKey) {
                return;
            }

            const nameInput = document.getElementById('nodeName');
            requestAnimationFrame(() => {
                nameInput.focus();
                const valueLength = nameInput.value.length;
                if (typeof nameInput.setSelectionRange === 'function') {
                    nameInput.setSelectionRange(valueLength, valueLength);
                }
            });
        }

        function renderStaticLists() {
            const modeSelect = document.getElementById('noteCopilotMode');
            modeSelect.innerHTML = copilotModes.map(mode => {
                const label = mode.charAt(0).toUpperCase() + mode.slice(1);
                return '<option value="' + escapeHtml(mode) + '">' + escapeHtml(label) + '</option>';
            }).join('');

            const defaultActionSelect = document.getElementById('noteDefaultAction');
            defaultActionSelect.innerHTML = noteDefaultActions.map(action => {
                return '<option value="' + escapeHtml(action) + '">' + escapeHtml(getDefaultActionLabel(action)) + '</option>';
            }).join('');
        }

        function renderLocalityOptions(selectedLocality) {
            const localitySelect = document.getElementById('nodeLocality');
            const workspaceLabel = workspaceName ? 'Workspace [' + workspaceName + ']' : 'Workspace';
            localitySelect.innerHTML = '<option value="Global">Global</option><option value="Local">' + escapeHtml(workspaceLabel) + '</option>';
            localitySelect.value = selectedLocality === 'Local' ? 'Local' : 'Global';
            localitySelect.disabled = false;
        }

        function renderTokenTable() {
            const wrap = document.getElementById('tokenTableWrap');
            if (currentUserTokens.length === 0) {
                wrap.innerHTML = '<div class="token-empty">No user tokens configured.</div>';
                return;
            }

            let html = '<table class="token-table"><thead><tr><th>Token</th><th>Type</th><th>Default</th><th>Required</th><th>Actions</th></tr></thead><tbody>';
            currentUserTokens.forEach((token, index) => {
                html += '<tr>' +
                    '<td><code>' + escapeHtml(token.token) + '</code><div class="subtle">' + escapeHtml(token.label || '') + '</div></td>' +
                    '<td>' + escapeHtml(token.dataType || 'String') + '</td>' +
                    '<td>' + escapeHtml(token.defaultValue || '') + '</td>' +
                    '<td>' + (token.required ? 'Yes' : 'No') + '</td>' +
                    '<td><div class="token-actions">' +
                    '<button class="btn btn-secondary" data-token-edit="' + index + '">Edit</button>' +
                    '<button class="btn btn-secondary" data-token-delete="' + index + '">Delete</button>' +
                    '</div></td>' +
                    '</tr>';
            });
            html += '</tbody></table>';
            wrap.innerHTML = html;
        }

        function clearTokenEditor() {
            editingTokenIndex = -1;
            document.getElementById('tokenName').value = '';
            document.getElementById('tokenLabel').value = '';
            document.getElementById('tokenDescription').value = '';
            document.getElementById('tokenType').value = 'String';
            document.getElementById('tokenDefault').value = '';
            document.getElementById('tokenRequired').checked = false;
        }

        function editToken(index) {
            const token = currentUserTokens[index];
            if (!token) {
                return;
            }

            editingTokenIndex = index;
            document.getElementById('tokenName').value = token.token || '';
            document.getElementById('tokenLabel').value = token.label || '';
            document.getElementById('tokenDescription').value = token.description || '';
            document.getElementById('tokenType').value = token.dataType || 'String';
            document.getElementById('tokenDefault').value = token.defaultValue || '';
            document.getElementById('tokenRequired').checked = !!token.required;
        }

        function saveToken() {
            const token = document.getElementById('tokenName').value.trim();
            const label = document.getElementById('tokenLabel').value.trim();
            const description = document.getElementById('tokenDescription').value.trim();
            const dataType = document.getElementById('tokenType').value;
            const defaultValue = document.getElementById('tokenDefault').value;
            const required = document.getElementById('tokenRequired').checked;

            if (!/^\$[A-Za-z_][A-Za-z0-9_]*\$$/.test(token)) {
                window.alert('Token names must look like $MyToken$.');
                return;
            }

            const duplicateIndex = currentUserTokens.findIndex((entry, index) => entry.token.toLowerCase() === token.toLowerCase() && index !== editingTokenIndex);
            if (duplicateIndex >= 0) {
                window.alert('That token name is already in use.');
                return;
            }

            const payload = { token, label, description, dataType, defaultValue, required };
            if (editingTokenIndex >= 0) {
                currentUserTokens[editingTokenIndex] = payload;
            } else {
                currentUserTokens.push(payload);
            }

            renderTokenTable();
            clearTokenEditor();
        }

        function clearNameValidation() {
            const nameInput = document.getElementById('nodeName');
            const nameError = document.getElementById('nodeNameError');
            nameInput.classList.remove('input-error');
            nameError.textContent = '';
            nameError.classList.remove('visible');
        }

        function showNameValidationError() {
            const nameInput = document.getElementById('nodeName');
            const nameError = document.getElementById('nodeNameError');
            nameInput.classList.add('input-error');
            nameError.textContent = 'A name is required.';
            nameError.classList.add('visible');
        }

        function syncNameValidation() {
            if (document.getElementById('nodeName').value.trim().length > 0) {
                clearNameValidation();
                return true;
            }

            const nameError = document.getElementById('nodeNameError');
            if (nameError.classList.contains('visible')) {
                nameError.textContent = 'A name is required.';
            }
            return false;
        }

        function buildSavePayload() {
            const name = document.getElementById('nodeName').value.trim();
            if (!name) {
                showNameValidationError();
                document.getElementById('nodeName').focus();
                return null;
            }

            return {
                id: currentNode ? currentNode.id : '',
                name,
                locality: document.getElementById('nodeLocality').value,
                category: document.getElementById('noteCategory').value.trim() || 'General',
                icon: document.getElementById('nodeIcon').value.trim() || defaultNote.icon || 'note',
                colour: document.getElementById('nodeColour').value.trim(),
                sortOrder: currentNode ? currentNode.sortOrder : undefined,
                content: document.getElementById('noteContent').value,
                format: document.getElementById('noteFormat').value,
                defaultAction: document.getElementById('noteDefaultAction').value,
                promptEnabled: document.getElementById('notePromptEnabled').checked,
                copilotModel: document.getElementById('noteCopilotModel').value.trim(),
                copilotMode: document.getElementById('noteCopilotMode').value,
                copilotAttachFiles: document.getElementById('noteAttachFiles').value.split(/\\r?\\n/).map(line => line.trim()).filter(Boolean),
                copilotAttachActiveFile: document.getElementById('noteAttachActiveFile').checked,
                userTokens: currentUserTokens.map(token => Object.assign({}, token)),
                updatedAt: currentNode ? currentNode.updatedAt : Date.now()
            };
        }

        function applyState(payload) {
            currentNodes = payload.nodes || [];
            currentRequest = payload.request;
            workspaceName = payload.workspaceName || null;
            hasWorkspace = !!payload.hasWorkspace;
            const requestKey = getRequestKey(currentRequest);
            if (requestKey !== lastRequestKey) {
                draftLocality = null;
            }
            currentNode = currentRequest.mode === 'edit'
                ? currentNodes.find(node => node.id === currentRequest.nodeId) || null
                : null;

            const workingNote = currentNode ? clone(currentNode) : Object.assign({}, clone(defaultNote), { locality: currentRequest.locality || 'Global' });
            if (draftLocality === 'Global' || draftLocality === 'Local') {
                workingNote.locality = draftLocality;
            }
            document.getElementById('editorTitle').textContent = currentRequest.mode === 'edit' ? 'Edit Note' : 'Create Note';
            document.getElementById('nodeName').value = workingNote.name || '';
            document.getElementById('noteCategory').value = workingNote.category || 'General';
            clearNameValidation();
            renderLocalityOptions(workingNote.locality);
            iconPicker.setValue(workingNote.icon || defaultNote.icon || 'note');
            colourField.setValue(workingNote.colour || '');
            document.getElementById('noteFormat').value = workingNote.format || 'PlainText';
            document.getElementById('noteDefaultAction').value = workingNote.defaultAction || 'open';
            document.getElementById('notePromptEnabled').checked = !!workingNote.promptEnabled;
            document.getElementById('noteCopilotModel').value = workingNote.copilotModel || '';
            document.getElementById('noteCopilotMode').value = workingNote.copilotMode || 'agent';
            document.getElementById('noteAttachFiles').value = (workingNote.copilotAttachFiles || []).join('\\n');
            document.getElementById('noteAttachActiveFile').checked = !!workingNote.copilotAttachActiveFile;
            document.getElementById('noteContent').value = workingNote.content || '';
            currentUserTokens = (workingNote.userTokens || []).map(token => Object.assign({}, token));
            renderTokenTable();
            clearTokenEditor();
            userTokensCard.setCollapsed(!!uiState.userTokensCollapsed);
            document.getElementById('deleteBtn').style.visibility = currentRequest.mode === 'edit' ? 'visible' : 'hidden';
            focusNameFieldIfNeeded(requestKey);
            lastRequestKey = requestKey;
        }

        window.addEventListener('message', (event) => {
            const message = event.data;
            switch (message.type) {
                case 'setState':
                    applyState(message);
                    break;
                case 'modelsResult':
                    cachedModels = message.models || [];
                    modelAutocomplete.setModels(cachedModels);
                    break;
                case 'filesPicked': {
                    const existing = document.getElementById('noteAttachFiles').value.split(/\\r?\\n/).map(line => line.trim()).filter(Boolean);
                    const merged = [...new Set(existing.concat(message.files || []))];
                    document.getElementById('noteAttachFiles').value = merged.join('\\n');
                    break;
                }
            }
        });

        document.getElementById('saveTokenBtn').addEventListener('click', saveToken);
        document.getElementById('clearTokenBtn').addEventListener('click', clearTokenEditor);
        document.getElementById('pickFilesBtn').addEventListener('click', () => vscode.postMessage({ type: 'pickFiles' }));
        document.getElementById('closeBtn').addEventListener('click', () => vscode.postMessage({ type: 'close' }));
        document.getElementById('deleteBtn').addEventListener('click', () => {
            if (currentNode) {
                vscode.postMessage({ type: 'deleteNode', id: currentNode.id });
            }
        });
        document.getElementById('saveBtn').addEventListener('click', () => {
            const payload = buildSavePayload();
            if (payload) {
                vscode.postMessage({ type: 'saveNode', note: payload });
            }
        });
        document.getElementById('nodeName').addEventListener('input', () => {
            syncNameValidation();
        });
        document.getElementById('nodeLocality').addEventListener('change', (event) => {
            draftLocality = event.target.value === 'Local' ? 'Local' : 'Global';
        });
        document.getElementById('tokenTableWrap').addEventListener('click', (event) => {
            const editButton = event.target.closest('[data-token-edit]');
            if (editButton) {
                editToken(Number(editButton.dataset.tokenEdit));
                return;
            }

            const deleteButton = event.target.closest('[data-token-delete]');
            if (deleteButton) {
                currentUserTokens.splice(Number(deleteButton.dataset.tokenDelete), 1);
                renderTokenTable();
                clearTokenEditor();
            }
        });

        renderStaticLists();
        vscode.postMessage({ type: 'requestData' });
    </script>
</body>
</html>`;
    }
}