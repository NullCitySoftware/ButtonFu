import * as vscode from 'vscode';
import { ButtonConfig, ButtonLocality, NoteConfig, getDefaultNoteIcon } from './types';
import { ButtonStore } from './buttonStore';
import { NoteStore } from './noteStore';
import { buildInfo } from './buildInfo';
import { escapeAttribute, escapeHtml, getNonce } from './webviewControls';

interface SidebarItem {
    kind: 'button' | 'note';
    id: string;
    name: string;
    category: string;
    sortOrder?: number;
    icon: string;
    colour: string;
    tooltip: string;
    data: ButtonConfig | NoteConfig;
}

function getHexBase(hex: string): string {
    return hex.slice(0, 7);
}

function getHexAlpha(hex: string): string {
    return hex.length >= 9 ? hex.slice(7, 9) : '';
}

/** Normalise hex colour: expand shorthand (#rgb / #rgba) to full form and validate hex digits. Returns null if invalid. */
function normaliseHex(raw: string): string | null {
    if (!raw || raw[0] !== '#') {
        return null;
    }

    let hex = raw;
    if (hex.length === 4) {
        hex = `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
    } else if (hex.length === 5) {
        hex = `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}${hex[4]}${hex[4]}`;
    }

    if (hex.length !== 7 && hex.length !== 9) {
        return null;
    }
    if (!/^#[0-9a-fA-F]+$/.test(hex)) {
        return null;
    }

    return hex;
}

/** Returns #000000 or #ffffff for best contrast against a hex background colour. */
function getContrastColour(hex: string): string {
    const base = getHexBase(hex);
    const red = parseInt(base.slice(1, 3), 16);
    const green = parseInt(base.slice(3, 5), 16);
    const blue = parseInt(base.slice(5, 7), 16);
    return (0.299 * red + 0.587 * green + 0.114 * blue) / 255 > 0.55 ? '#000000' : '#ffffff';
}

function lightenHex(hex: string, amount: number): string {
    const clamp = (value: number) => Math.max(0, Math.min(255, value));
    const base = getHexBase(hex);
    const alphaSuffix = getHexAlpha(hex);
    const red = parseInt(base.slice(1, 3), 16);
    const green = parseInt(base.slice(3, 5), 16);
    const blue = parseInt(base.slice(5, 7), 16);

    const nextRed = clamp(Math.round(red + (255 - red) * amount));
    const nextGreen = clamp(Math.round(green + (255 - green) * amount));
    const nextBlue = clamp(Math.round(blue + (255 - blue) * amount));

    return `#${nextRed.toString(16).padStart(2, '0')}${nextGreen.toString(16).padStart(2, '0')}${nextBlue.toString(16).padStart(2, '0')}${alphaSuffix}`;
}

/** Sidebar webview provider — renders ButtonFu buttons and notes as clickable buttons in grouped flow panels. */
export class ButtonPanelProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'buttonfu.buttonsView';

    private _view?: vscode.WebviewView;
    private _lastShellState?: string;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly store: ButtonStore,
        private readonly noteStore: NoteStore,
        private readonly globalState: vscode.Memento
    ) {
        this.store.onDidChange(() => this.refresh());
        this.noteStore.onDidChange(() => this.refresh());
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this._view = webviewView;

        webviewView.onDidDispose(() => {
            this._view = undefined;
        });

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                this.extensionUri,
                vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist')
            ]
        };

        webviewView.webview.html = this._getHtmlContent(webviewView.webview);
        this._lastShellState = this._getShellState();

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                case 'execute':
                    await vscode.commands.executeCommand('buttonfu.executeButton', msg.id);
                    break;
                case 'executeNote':
                    await vscode.commands.executeCommand('buttonfu.executeNote', msg.id);
                    break;
                case 'previewNote':
                    await vscode.commands.executeCommand('buttonfu.previewNote', msg.id);
                    break;
                case 'copyNote':
                    await vscode.commands.executeCommand('buttonfu.copyNote', msg.id);
                    break;
                case 'insertNote':
                    await vscode.commands.executeCommand('buttonfu.insertNote', msg.id);
                    break;
                case 'sendNoteToCopilot':
                    await vscode.commands.executeCommand('buttonfu.sendNoteToCopilot', msg.id);
                    break;
                case 'openEditor':
                    await vscode.commands.executeCommand('buttonfu.openEditor');
                    break;
                case 'addButton':
                    await vscode.commands.executeCommand('buttonfu.addButton');
                    break;
                case 'addButtonWithLocality':
                    await vscode.commands.executeCommand('buttonfu.addButtonWithLocality', msg.locality);
                    break;
                case 'openNoteEditor':
                    await vscode.commands.executeCommand('buttonfu.openNoteEditor');
                    break;
                case 'addNote':
                    await vscode.commands.executeCommand('buttonfu.addNote', msg.locality);
                    break;
                case 'editNoteNode':
                    await vscode.commands.executeCommand('buttonfu.editNoteNode', msg.id);
                    break;
                case 'deleteNoteNode':
                    await vscode.commands.executeCommand('buttonfu.deleteNoteNode', msg.id);
                    break;
            }
        });
    }

    public refresh(): void {
        if (!this._view) {
            return;
        }

        const nextShellState = this._getShellState();
        if (this._lastShellState !== nextShellState) {
            this._view.webview.html = this._getHtmlContent(this._view.webview);
            this._lastShellState = nextShellState;
            return;
        }

        this._view.webview.postMessage({
            type: 'refreshContent',
            html: this._renderContent()
        });
    }

    private _getShellState(): string {
        const showBuildInfo = this.globalState.get<boolean>('options.showBuildInformation', false);
        const showFooter = this.globalState.get<boolean>('options.showAddAndEditorButtons', true);
        const showNotes = vscode.workspace.getConfiguration('buttonfu').get<boolean>('showNotes', true);
        return JSON.stringify({ showBuildInfo, showFooter, showNotes });
    }

    private _getHtmlContent(webview: vscode.Webview): string {
        const nonce = getNonce();
        const renderStamp = `SIDEBAR ${buildInfo.version} #${buildInfo.buildNumber} ${buildInfo.buildTime}`;
        const showBuildInfo = this.globalState.get<boolean>('options.showBuildInformation', false);
        const showFooter = this.globalState.get<boolean>('options.showAddAndEditorButtons', true);
        const showNotes = vscode.workspace.getConfiguration('buttonfu').get<boolean>('showNotes', true);
        const bodyPadding = showFooter ? '8px 6px 120px' : '8px 6px 8px';
        const debugStampHtml = showBuildInfo
            ? `<div class="debug-stamp">RUNNING BUILD: ${renderStamp}</div>`
            : '';
        const footerHtml = showFooter
            ? this._renderFooter(showNotes)
            : '';
        const codiconsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css')
        );

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${webview.cspSource}; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}';">
    <link rel="stylesheet" href="${codiconsUri}">
    <style nonce="${nonce}">
        * { box-sizing: border-box; margin: 0; padding: 0; }

        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background: var(--vscode-sideBar-background);
            padding: ${bodyPadding};
        }

        .debug-stamp {
            font-size: 10px;
            line-height: 1.3;
            color: var(--vscode-descriptionForeground);
            opacity: 0.9;
            border: 1px dashed var(--vscode-input-border);
            border-radius: 4px;
            padding: 4px 6px;
            margin: 0 0 8px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .locality-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            font-size: 10px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.8px;
            color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-descriptionForeground));
            background: var(--vscode-sideBarSectionHeader-background, transparent);
            border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
            padding: 5px 4px 4px;
            margin: 10px 0 6px;
        }
        .locality-header:first-child { margin-top: 0; }
        .header-actions {
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .header-action-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 20px;
            height: 20px;
            border: none;
            border-radius: 4px;
            background: transparent;
            color: inherit;
            cursor: pointer;
        }
        .header-action-btn:hover {
            background: var(--vscode-list-hoverBackground);
            color: var(--vscode-foreground);
        }

        .category-label {
            display: flex;
            align-items: center;
            gap: 10px;
            font-size: 11px;
            font-weight: 700;
            color: var(--vscode-descriptionForeground);
            margin: 8px 0 14px 2px;
            text-transform: uppercase;
            letter-spacing: 0.6px;
            line-height: 1;
        }
        .category-label .codicon {
            font-size: 14px;
            line-height: 1;
        }

        .button-flow {
            display: flex;
            flex-wrap: wrap;
            gap: 4px;
            margin-bottom: 10px;
        }

        .button-grid {
            display: grid;
            gap: 4px;
            margin-bottom: 10px;
        }

        .fu-btn,
        .fu-note-split {
            --fu-item-bg: var(--vscode-button-secondaryBackground);
            --fu-item-fg: var(--vscode-button-secondaryForeground);
            --fu-item-hover-bg: var(--vscode-button-secondaryHoverBackground);
        }

        .fu-btn {
            display: inline-flex;
            align-items: center;
            gap: 5px;
            padding: 4px 10px 4px 8px;
            background: var(--fu-item-bg);
            color: var(--fu-item-fg);
            border: 1px solid transparent;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            font-family: var(--vscode-font-family);
            white-space: nowrap;
            max-width: 220px;
            transition: background 0.1s, border-color 0.1s;
        }
        .fu-btn:hover {
            background: var(--fu-item-hover-bg);
            border-color: var(--vscode-focusBorder);
        }

        .fu-note-split {
            display: inline-grid;
            grid-template-columns: minmax(0, 1fr) 28px;
            max-width: 240px;
            border: 1px solid transparent;
            border-radius: 4px;
            overflow: hidden;
            background: var(--fu-item-bg);
            color: var(--fu-item-fg);
            transition: background 0.1s, border-color 0.1s;
        }
        .fu-note-split:hover,
        .fu-note-split.menu-open {
            background: var(--fu-item-hover-bg);
            border-color: var(--vscode-focusBorder);
        }

        .fu-note-main,
        .fu-note-toggle {
            border: none;
            background: transparent;
            color: inherit;
            font: inherit;
            cursor: pointer;
        }
        .fu-note-main {
            display: inline-flex;
            align-items: center;
            gap: 5px;
            min-width: 0;
            padding: 4px 8px;
            text-align: left;
        }
        .fu-note-toggle {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            border-left: 1px solid color-mix(in srgb, currentColor 18%, transparent 82%);
        }
        .fu-note-toggle .codicon {
            font-size: 12px;
        }

        .button-grid .fu-btn,
        .button-grid .fu-note-split {
            max-width: none;
            min-width: 0;
            width: 100%;
        }

        .btn-icon { font-size: 13px; flex-shrink: 0; }
        .btn-label {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            min-width: 0;
        }

        .empty-state {
            text-align: center;
            padding: 32px 12px;
            color: var(--vscode-descriptionForeground);
        }
        .empty-icon { font-size: 36px; opacity: 0.4; margin-bottom: 10px; }
        .empty-state p { font-size: 12px; line-height: 1.5; }
        .empty-state .hint { font-size: 11px; margin-top: 6px; opacity: 0.7; }
        .inline-empty {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            padding: 4px 2px 8px;
        }

        .note-action-menu {
            position: fixed;
            z-index: 1000;
            display: none;
            min-width: 200px;
            padding: 4px;
            border-radius: 6px;
            border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border));
            background: var(--vscode-menu-background, var(--vscode-sideBar-background));
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
        }
        .note-action-menu.visible {
            display: block;
        }
        .note-action-menu-item {
            width: 100%;
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 6px 8px;
            border: none;
            border-radius: 4px;
            background: transparent;
            color: var(--vscode-menu-foreground, var(--vscode-foreground));
            font: inherit;
            font-size: 12px;
            text-align: left;
            cursor: pointer;
        }
        .note-action-menu-item:hover {
            background: var(--vscode-list-hoverBackground);
        }

        .footer {
            position: fixed;
            bottom: 0;
            left: 0;
            right: 0;
            padding: 6px;
            background: var(--vscode-sideBar-background);
            border-top: 1px solid var(--vscode-panel-border);
            display: flex;
            flex-direction: column;
            gap: 4px;
        }
        .footer-row {
            display: flex;
            gap: 4px;
        }
        .footer-btn {
            flex: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 5px;
            padding: 6px 8px;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-foreground);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 3px;
            cursor: pointer;
            font-size: 11px;
            font-weight: 600;
            font-family: var(--vscode-font-family);
            transition: background 0.12s, border-color 0.12s, color 0.12s;
        }
        .footer-btn:hover {
            background: var(--vscode-list-hoverBackground);
            border-color: var(--vscode-focusBorder);
        }
        .footer-btn.primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border-color: transparent;
        }
        .footer-btn.primary:hover { background: var(--vscode-button-hoverBackground); }
        .footer-btn.primary.note-accent {
            background: color-mix(in srgb, var(--vscode-button-background) 76%, #d4a017 24%);
        }
        .footer-btn.primary.note-accent:hover {
            background: color-mix(in srgb, var(--vscode-button-hoverBackground) 76%, #d4a017 24%);
        }
    </style>
</head>
<body>
    ${debugStampHtml}
    <div id="content">${this._renderContent()}</div>

    <div class="note-action-menu" id="noteActionMenu" role="menu">
        <button class="note-action-menu-item" id="noteActionOpen" data-note-menu-action="open" type="button">
            <span class="codicon codicon-preview"></span>
            <span id="noteMenuOpenLabel">Open</span>
        </button>
        <button class="note-action-menu-item" id="noteActionInsert" data-note-menu-action="insert" type="button">
            <span class="codicon codicon-insert"></span>
            <span>Insert into Active Editor</span>
        </button>
        <button class="note-action-menu-item" id="noteActionCopilot" data-note-menu-action="copilot" type="button">
            <span class="codicon codicon-copilot"></span>
            <span>Send to Copilot Chat</span>
        </button>
        <button class="note-action-menu-item" id="noteActionCopy" data-note-menu-action="copy" type="button">
            <span class="codicon codicon-copy"></span>
            <span>Copy to Clipboard</span>
        </button>
        <button class="note-action-menu-item" id="noteActionEdit" data-note-menu-action="edit" type="button">
            <span class="codicon codicon-edit"></span>
            <span>Edit</span>
        </button>
    </div>

    ${footerHtml}

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const noteActionMenu = document.getElementById('noteActionMenu');
        const noteMenuOpenLabel = document.getElementById('noteMenuOpenLabel');
        let activeNoteId = null;
        let activeNoteToggle = null;

        function closeNoteActionMenu() {
            if (activeNoteToggle) {
                if (typeof activeNoteToggle.setAttribute === 'function') {
                    activeNoteToggle.setAttribute('aria-expanded', 'false');
                }
                const split = activeNoteToggle.closest('.fu-note-split');
                if (split) {
                    split.classList.remove('menu-open');
                }
            }
            activeNoteId = null;
            activeNoteToggle = null;
            noteActionMenu.classList.remove('visible');
        }

        function openNoteActionMenu(toggleButton) {
            if (!toggleButton) {
                return;
            }

            if (activeNoteToggle === toggleButton && noteActionMenu.classList.contains('visible')) {
                closeNoteActionMenu();
                return;
            }

            closeNoteActionMenu();
            activeNoteId = toggleButton.dataset.noteMenuToggle;
            activeNoteToggle = toggleButton;
            if (typeof toggleButton.setAttribute === 'function') {
                toggleButton.setAttribute('aria-expanded', 'true');
            }
            const split = toggleButton.closest('.fu-note-split');
            if (split) {
                split.classList.add('menu-open');
            }

            noteMenuOpenLabel.textContent = toggleButton.dataset.noteFormat === 'Markdown' ? 'Preview' : 'Open';
            const rect = typeof toggleButton.getBoundingClientRect === 'function'
                ? toggleButton.getBoundingClientRect()
                : { left: 8, right: window.innerWidth - 8, bottom: 32 };
            const menuWidth = 200;
            const maxLeft = window.innerWidth - menuWidth - 8;
            const left = Math.max(8, Math.min(rect.right - menuWidth, maxLeft));
            const top = Math.min(rect.bottom + 4, window.innerHeight - 180);
            noteActionMenu.style.left = left + 'px';
            noteActionMenu.style.top = Math.max(8, top) + 'px';
            noteActionMenu.classList.add('visible');
        }

        function dispatchNoteMenuAction(action) {
            if (!activeNoteId) {
                return;
            }

            switch (action) {
                case 'open':
                    vscode.postMessage({ type: 'previewNote', id: activeNoteId });
                    break;
                case 'insert':
                    vscode.postMessage({ type: 'insertNote', id: activeNoteId });
                    break;
                case 'copilot':
                    vscode.postMessage({ type: 'sendNoteToCopilot', id: activeNoteId });
                    break;
                case 'copy':
                    vscode.postMessage({ type: 'copyNote', id: activeNoteId });
                    break;
                case 'edit':
                    vscode.postMessage({ type: 'editNoteNode', id: activeNoteId });
                    break;
            }
        }

        window.addEventListener('message', (event) => {
            if (event.data.type === 'refreshContent') {
                closeNoteActionMenu();
                document.getElementById('content').innerHTML = event.data.html;
            }
        });

        document.addEventListener('click', (event) => {
            const noteToggle = event.target.closest('[data-note-menu-toggle]');
            if (noteToggle) {
                openNoteActionMenu(noteToggle);
                return;
            }

            const noteMenuAction = event.target.closest('[data-note-menu-action]');
            if (noteMenuAction) {
                dispatchNoteMenuAction(noteMenuAction.dataset.noteMenuAction);
                closeNoteActionMenu();
                return;
            }

            if (noteActionMenu.contains(event.target)) {
                return;
            }

            const noteExecute = event.target.closest('[data-note-execute]');
            if (noteExecute) {
                closeNoteActionMenu();
                vscode.postMessage({ type: 'executeNote', id: noteExecute.dataset.noteExecute });
                return;
            }

            const execute = event.target.closest('[data-execute]');
            if (execute) {
                closeNoteActionMenu();
                vscode.postMessage({ type: 'execute', id: execute.dataset.execute });
                return;
            }

            const addLocality = event.target.closest('[data-add-locality]');
            if (addLocality) {
                closeNoteActionMenu();
                vscode.postMessage({ type: 'addButtonWithLocality', locality: addLocality.dataset.addLocality });
                return;
            }

            const addNoteLocality = event.target.closest('[data-add-note-locality]');
            if (addNoteLocality) {
                closeNoteActionMenu();
                vscode.postMessage({ type: 'addNote', locality: addNoteLocality.dataset.addNoteLocality });
                return;
            }

            if (event.target.closest('#addBtn')) {
                closeNoteActionMenu();
                vscode.postMessage({ type: 'addButton' });
                return;
            }

            if (event.target.closest('#addNoteFooterBtn')) {
                closeNoteActionMenu();
                vscode.postMessage({ type: 'addNote' });
                return;
            }

            if (event.target.closest('#editAllBtn') || event.target.closest('[data-open-editor]')) {
                closeNoteActionMenu();
                vscode.postMessage({ type: 'openEditor' });
                return;
            }

            if (event.target.closest('#openNoteEditorBtn')) {
                closeNoteActionMenu();
                vscode.postMessage({ type: 'openNoteEditor' });
                return;
            }

            closeNoteActionMenu();
        });

        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                closeNoteActionMenu();
            }
        });

        document.addEventListener('scroll', () => {
            if (noteActionMenu.classList.contains('visible')) {
                closeNoteActionMenu();
            }
        }, true);
    </script>
</body>
</html>`;
    }

    private _renderFooter(showNotes: boolean): string {
        return `<div class="footer">
        <div class="footer-row">
            <button class="footer-btn primary" id="addBtn">
                <span class="codicon codicon-add"></span> Add Button
            </button>
            ${showNotes ? `<button class="footer-btn primary note-accent" id="addNoteFooterBtn">
                <span class="codicon codicon-add"></span> Add Note
            </button>` : ''}
        </div>
        <div class="footer-row">
            <button class="footer-btn" id="editAllBtn">
                <span class="codicon codicon-gear"></span> Button Editor
            </button>
            ${showNotes ? `<button class="footer-btn" id="openNoteEditorBtn">
                <span class="codicon codicon-edit"></span> Note Editor
            </button>` : ''}
        </div>
    </div>`;
    }

    private _renderContent(): string {
        const allButtons = this.store.getAllButtons();
        const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name ?? vscode.workspace.name ?? null;
        const columns = Math.max(1, Math.min(12, this.globalState.get<number>('options.columns', 1)));
        const showNotes = vscode.workspace.getConfiguration('buttonfu').get<boolean>('showNotes', true);

        const globalItems = this._getSidebarItems(allButtons.filter((button) => button.locality === 'Global'), 'Global', showNotes);
        const localItems = this._getSidebarItems(allButtons.filter((button) => button.locality === 'Local'), 'Local', showNotes);

        if (globalItems.length === 0 && localItems.length === 0) {
            return this._renderEmpty();
        }

        return this._renderSections(globalItems, localItems, columns, workspaceName, showNotes);
    }

    private _renderEmpty(): string {
        return `<div class="empty-state">
            <div class="empty-icon"><span class="codicon codicon-layout"></span></div>
            <p>No buttons or notes configured yet.</p>
            <p class="hint">Use the action buttons below<br>or click the gear icons above.</p>
        </div>`;
    }

    private _renderSections(
        globalItems: SidebarItem[],
        localItems: SidebarItem[],
        columns: number,
        workspaceName: string | null,
        showNotes: boolean
    ): string {
        let html = '';
        const workspaceLabel = workspaceName ? `Workspace [${workspaceName}]` : 'Workspace';

        if (globalItems.length > 0) {
            html += this._renderLocalityHeader('Global', 'Global', showNotes);
            html += this._renderGrouped(globalItems, columns);
        }

        html += this._renderLocalityHeader(workspaceLabel, 'Local', showNotes);
        html += localItems.length > 0
            ? this._renderGrouped(localItems, columns)
            : `<div class="inline-empty">No workspace buttons or notes. Add one via the editor.</div>`;

        return html;
    }

    private _renderLocalityHeader(label: string, locality: ButtonLocality, showNotes: boolean): string {
        const escapedLabel = escapeHtml(label);
        const escapedLocality = escapeAttribute(locality);
        const noteAction = showNotes
            ? `<button class="header-action-btn" id="addNote${escapedLocality}Btn" data-add-note-locality="${escapedLocality}" title="Add ${escapedLabel} note">
                    <span class="codicon codicon-note"></span>
                </button>`
            : '';

        return `<div class="locality-header">
            <span>${escapedLabel}</span>
            <div class="header-actions">
                <button class="header-action-btn" data-add-locality="${escapedLocality}" title="Add ${escapedLabel} button">
                    <span class="codicon codicon-add"></span>
                </button>
                ${noteAction}
                <button class="header-action-btn" data-open-editor="true" title="Open Button Editor">
                    <span class="codicon codicon-gear"></span>
                </button>
            </div>
        </div>`;
    }

    private _renderGrouped(items: SidebarItem[], columns: number): string {
        const sorted = [...items].sort((left, right) => {
            const order = (left.sortOrder ?? 99999) - (right.sortOrder ?? 99999);
            if (order !== 0) {
                return order;
            }

            return left.name.localeCompare(right.name);
        });

        const categories = new Map<string, SidebarItem[]>();
        for (const item of sorted) {
            const category = item.category || 'General';
            if (!categories.has(category)) {
                categories.set(category, []);
            }
            categories.get(category)!.push(item);
        }

        const sortedCategories = Array.from(categories.keys()).sort();
        const showLabels = sortedCategories.length > 1;
        const useGrid = columns > 1;
        const flowClass = useGrid ? 'button-grid' : 'button-flow';
        const flowStyle = useGrid ? ` style="grid-template-columns:repeat(${columns},1fr)"` : '';
        let html = '';

        for (const category of sortedCategories) {
            if (showLabels) {
                html += `<div class="category-label"><span class="codicon codicon-folder"></span><span>${escapeHtml(category)}</span></div>`;
            }
            html += `<div class="${flowClass}"${flowStyle}>`;
            for (const item of categories.get(category)!) {
                html += item.kind === 'button'
                    ? this._renderButton(item.data as ButtonConfig)
                    : this._renderNoteButton(item.data as NoteConfig);
            }
            html += '</div>';
        }

        return html;
    }

    private _renderButton(button: ButtonConfig): string {
        const icon = button.icon || 'play';
        const tooltip = escapeHtml(button.description || button.name);
        const style = this._buildItemStyle(button.colour);

        return `<button class="fu-btn" data-execute="${escapeAttribute(button.id)}" title="${tooltip}" aria-label="${tooltip}"${style ? ` style="${style}"` : ''}>
                <span class="codicon codicon-${escapeHtml(icon)} btn-icon"></span>
                <span class="btn-label">${escapeHtml(button.name)}</span>
            </button>`;
    }

    private _renderNoteButton(note: NoteConfig): string {
        const escapedId = escapeAttribute(note.id);
        const icon = note.icon || getDefaultNoteIcon();
        const tooltip = escapeAttribute(this._buildNoteTooltip(note));
        const style = this._buildItemStyle(note.colour);
        const menuTitle = escapeAttribute(`More note actions for ${note.name}`);

        return `<div class="fu-note-split" id="note-split-${escapedId}"${style ? ` style="${style}"` : ''}>
                <button class="fu-note-main" id="note-run-${escapedId}" data-note-execute="${escapedId}" title="${tooltip}" aria-label="${tooltip}">
                    <span class="codicon codicon-${escapeHtml(icon)} btn-icon"></span>
                    <span class="btn-label">${escapeHtml(note.name)}</span>
                </button>
                <button class="fu-note-toggle" id="note-menu-${escapedId}" data-note-menu-toggle="${escapedId}" data-note-format="${escapeAttribute(note.format)}" aria-haspopup="menu" aria-expanded="false" title="${menuTitle}">
                    <span class="codicon codicon-chevron-down"></span>
                </button>
            </div>`;
    }

    private _getSidebarItems(buttons: ButtonConfig[], locality: ButtonLocality, showNotes: boolean): SidebarItem[] {
        const items: SidebarItem[] = buttons.map((button) => ({
            kind: 'button',
            id: button.id,
            name: button.name,
            category: button.category || 'General',
            sortOrder: button.sortOrder,
            icon: button.icon,
            colour: button.colour,
            tooltip: button.description || button.name,
            data: button
        }));

        if (!showNotes) {
            return items;
        }

        const notes = this.noteStore.getAllNodes().filter((note) => note.locality === locality);
        items.push(...notes.map((note): SidebarItem => ({
            kind: 'note',
            id: note.id,
            name: note.name,
            category: note.category || 'General',
            sortOrder: note.sortOrder,
            icon: note.icon,
            colour: note.colour,
            tooltip: this._buildNoteTooltip(note),
            data: note
        })));

        return items;
    }

    private _buildNoteTooltip(note: NoteConfig): string {
        const preview = note.content.split(/\r?\n/).slice(0, 4).join('\n').trim();
        if (!preview) {
            return note.name;
        }

        return `${note.name}\n\n${preview}`;
    }

    private _buildItemStyle(colour: string): string {
        const validHex = normaliseHex(colour);
        if (!validHex) {
            return '';
        }

        const foreground = getContrastColour(validHex);
        const hover = lightenHex(validHex, 0.18);
        return `--fu-item-bg:${validHex};--fu-item-fg:${foreground};--fu-item-hover-bg:${hover};`;
    }
}