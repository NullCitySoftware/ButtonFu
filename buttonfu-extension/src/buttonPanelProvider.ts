import * as vscode from 'vscode';
import { ButtonConfig, ButtonLocality, NoteNode, getDefaultNoteIcon } from './types';
import { ButtonStore } from './buttonStore';
import { NoteStore } from './noteStore';
import { buildInfo } from './buildInfo';
import { getNonce, escapeHtml, escapeAttribute } from './webviewControls';

function getHexBase(hex: string): string {
    return hex.slice(0, 7);
}

function getHexAlpha(hex: string): string {
    return hex.length >= 9 ? hex.slice(7, 9) : '';
}

/** Normalise hex colour: expand shorthand (#rgb / #rgba) to full form and validate hex digits. Returns null if invalid. */
function normaliseHex(raw: string): string | null {
    if (!raw || raw[0] !== '#') { return null; }
    let hex = raw;
    if (hex.length === 4) {
        hex = `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
    } else if (hex.length === 5) {
        hex = `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}${hex[4]}${hex[4]}`;
    }
    if (hex.length !== 7 && hex.length !== 9) { return null; }
    if (!/^#[0-9a-fA-F]+$/.test(hex)) { return null; }
    return hex;
}

/** Returns #000000 or #ffffff for best contrast against a hex background colour */
function getContrastColour(hex: string): string {
    const base = getHexBase(hex);
    const r = parseInt(base.slice(1, 3), 16);
    const g = parseInt(base.slice(3, 5), 16);
    const b = parseInt(base.slice(5, 7), 16);
    // Perceived luminance
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.55 ? '#000000' : '#ffffff';
}

function lightenHex(hex: string, amount: number): string {
    const clamp = (v: number) => Math.max(0, Math.min(255, v));
    const base = getHexBase(hex);
    const alphaSuffix = getHexAlpha(hex);
    const r = parseInt(base.slice(1, 3), 16);
    const g = parseInt(base.slice(3, 5), 16);
    const b = parseInt(base.slice(5, 7), 16);

    const nr = clamp(Math.round(r + (255 - r) * amount));
    const ng = clamp(Math.round(g + (255 - g) * amount));
    const nb = clamp(Math.round(b + (255 - b) * amount));

    return `#${nr.toString(16).padStart(2, '0')}${ng.toString(16).padStart(2, '0')}${nb.toString(16).padStart(2, '0')}${alphaSuffix}`;
}

/**
 * Sidebar webview provider — renders ButtonFu buttons as actual clickable
 * buttons in categorised flow panels, using a WebviewViewProvider instead
 * of a TreeDataProvider.
 */
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
        store.onDidChange(() => this.refresh());
        noteStore.onDidChange(() => this.refresh());
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
                case 'edit':
                    await vscode.commands.executeCommand('buttonfu.editButton', { buttonId: msg.id });
                    break;
                case 'delete':
                    await vscode.commands.executeCommand('buttonfu.deleteButton', { buttonId: msg.id });
                    break;
                case 'openEditor':
                    await vscode.commands.executeCommand('buttonfu.openEditor');
                    break;
                case 'addButton':
                    await vscode.commands.executeCommand('buttonfu.addButton');
                    break;
                case 'openEditorTab':
                    await vscode.commands.executeCommand('buttonfu.openEditorOnTab', msg.tab);
                    break;
                case 'addButtonWithLocality':
                    await vscode.commands.executeCommand('buttonfu.addButtonWithLocality', msg.locality);
                    break;
                case 'openNoteEditor':
                    await vscode.commands.executeCommand('buttonfu.openNoteEditor');
                    break;
                case 'openNoteActions':
                    await vscode.commands.executeCommand('buttonfu.openNoteActions', msg.id);
                    break;
                case 'editNoteNode':
                    await vscode.commands.executeCommand('buttonfu.editNoteNode', msg.id);
                    break;
                case 'addNote':
                    await vscode.commands.executeCommand('buttonfu.addNote', msg.target);
                    break;
                case 'addNoteFolder':
                    await vscode.commands.executeCommand('buttonfu.addNoteFolder', msg.target);
                    break;
                case 'deleteNoteNode':
                    await vscode.commands.executeCommand('buttonfu.deleteNoteNode', msg.id);
                    break;
                case 'moveNoteNode':
                    {
                        const node = this.noteStore.getNode(msg.id);
                        const targetParentId = msg.parentId ?? null;
                        if (!node) {
                            break;
                        }

                        if (node.locality === msg.locality && (node.parentId ?? null) === targetParentId) {
                            break;
                        }

                        const moved = await this.noteStore.moveNode(msg.id, msg.locality, targetParentId);
                        if (!moved) {
                            void vscode.window.showWarningMessage('That drop target is not valid for this note or folder.');
                        }
                    }
                    break;
                case 'toggleNoteFolder':
                {
                    const collapsed = this.globalState.get<string[]>('notes.collapsedFolders', []);
                    const idx = collapsed.indexOf(msg.id);
                    if (idx >= 0) {
                        collapsed.splice(idx, 1);
                    } else {
                        collapsed.push(msg.id);
                    }
                    await this.globalState.update('notes.collapsedFolders', collapsed);
                    this.refresh();
                }
                    break;
            }
        });
    }

    public refresh(): void {
        if (this._view) {
            const nextShellState = this._getShellState();
            if (this._lastShellState !== nextShellState) {
                this._view.webview.html = this._getHtmlContent(this._view.webview);
                this._lastShellState = nextShellState;
                return;
            }

            const allButtons = this.store.getAllButtons();
            const globalButtons = allButtons.filter(b => b.locality === 'Global');
            const localButtons = allButtons.filter(b => b.locality === 'Local');
            const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name ?? vscode.workspace.name ?? null;
            const columns = Math.max(1, Math.min(12, this.globalState.get<number>('options.columns', 1)));
            const showNotes = vscode.workspace.getConfiguration('buttonfu').get<boolean>('showNotes', true);
            const buttonsBody = this._renderSections(globalButtons, localButtons, columns, workspaceName);
            const notesBody = showNotes ? this._renderNotesSection(workspaceName) : '';
            const body = `${buttonsBody}${notesBody}`;

            this._view.webview.postMessage({ type: 'refreshContent', html: body });
        }
    }

    private _getShellState(): string {
        const showBuildInfo = this.globalState.get<boolean>('options.showBuildInformation', false);
        const showFooter = this.globalState.get<boolean>('options.showAddAndEditorButtons', true);
        return JSON.stringify({ showBuildInfo, showFooter });
    }

    private _getHtmlContent(webview: vscode.Webview): string {
        const nonce = getNonce();
        const renderStamp = `SIDEBAR ${buildInfo.version} #${buildInfo.buildNumber} ${buildInfo.buildTime}`;
        const showBuildInfo = this.globalState.get<boolean>('options.showBuildInformation', false);
        const showFooter = this.globalState.get<boolean>('options.showAddAndEditorButtons', true);
        const columns = Math.max(1, Math.min(12, this.globalState.get<number>('options.columns', 1)));
        const debugStampHtml = showBuildInfo
            ? `<div class="debug-stamp">RUNNING BUILD: ${renderStamp}</div>`
            : '';
        const footerHtml = showFooter
            ? `<div class="footer">
        <div class="footer-row">
            <button class="footer-btn primary" id="addBtn">
                <span class="codicon codicon-add"></span> Add Button
            </button>
            <button class="footer-btn primary note-accent" id="addNoteFooterBtn">
                <span class="codicon codicon-add"></span> Add Note
            </button>
        </div>
        <button class="footer-btn secondary" id="editAllBtn">
            <span class="codicon codicon-gear"></span> Editor
        </button>
    </div>`
            : '';
        const bodyPadding = showFooter ? '8px 6px 90px' : '8px 6px 8px';

        const codiconsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css')
        );

        const allButtons = this.store.getAllButtons();
        const globalButtons = allButtons.filter(b => b.locality === 'Global');
        const localButtons = allButtons.filter(b => b.locality === 'Local');
        const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name ?? vscode.workspace.name ?? null;
        const showNotes = vscode.workspace.getConfiguration('buttonfu').get<boolean>('showNotes', true);

        const buttonsBody = this._renderSections(globalButtons, localButtons, columns, workspaceName);
        const notesBody = showNotes ? this._renderNotesSection(workspaceName) : '';
        const body = `${buttonsBody}${notesBody}`;

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

        /* ── Locality section divider ───────────────────── */
        .locality-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
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
        .header-with-actions {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
        }
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

        /* ── Category label ─────────────────────────────── */
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

        /* ── Button flow panel ──────────────────────────── */
        .button-flow {
            display: flex;
            flex-wrap: wrap;
            gap: 4px;
            margin-bottom: 10px;
        }

        /* ── Individual button ──────────────────────────── */
        .fu-btn {
            display: inline-flex;
            align-items: center;
            gap: 5px;
            padding: 4px 10px 4px 8px;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid transparent;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            font-family: var(--vscode-font-family);
            white-space: nowrap;
            max-width: 200px;
            transition: background 0.1s, border-color 0.1s;
        }
        .fu-btn:hover {
            background: var(--fu-btn-hover-bg, var(--vscode-button-secondaryHoverBackground));
            border-color: var(--vscode-focusBorder);
        }
        .fu-btn .btn-icon { font-size: 13px; flex-shrink: 0; }
        .fu-btn .btn-label {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        /* ── Grid mode (columns > 1) ───────────────────── */
        .button-grid {
            display: grid;
            gap: 4px;
            margin-bottom: 10px;
        }
        .button-grid .fu-btn {
            max-width: none;
            min-width: 0;
            width: 100%;
        }

        /* ── Empty state ────────────────────────────────── */
        .empty-state {
            text-align: center;
            padding: 32px 12px;
            color: var(--vscode-descriptionForeground);
        }
        .empty-icon { font-size: 36px; opacity: 0.4; margin-bottom: 10px; }
        .empty-state p { font-size: 12px; line-height: 1.5; }
        .empty-state .hint { font-size: 11px; margin-top: 6px; opacity: 0.7; }

        .section-header {
            font-size: 10px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.8px;
            color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-descriptionForeground));
            border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
            padding: 5px 4px 4px;
            margin: 16px 0 6px;
        }
        .notes-root {
            margin-bottom: 10px;
        }
        .notes-scope-label {
            font-size: 10px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.6px;
            color: var(--vscode-descriptionForeground);
            padding: 2px 4px 6px;
            margin-top: 6px;
        }
        .inline-empty {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            padding: 4px 2px 8px;
        }
        .note-row {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 4px 6px;
            border-radius: 4px;
                cursor: default;
            min-width: 0;
            margin-bottom: 2px;
        }
        .note-row:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .note-row.folder-row {
            cursor: default;
        }
        .note-row.folder-row:focus {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: -1px;
        }
        .note-icon {
            font-size: 14px;
            flex-shrink: 0;
        }
        .note-label {
            flex: 1;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            font-size: 12px;
        }
        .note-badges {
            display: flex;
            align-items: center;
            gap: 4px;
            flex-shrink: 0;
        }
        .note-badge {
            font-size: 10px;
            line-height: 1.2;
            padding: 1px 5px;
            border-radius: 999px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            text-transform: uppercase;
        }
        .note-folder-actions {
            display: flex;
            align-items: center;
            gap: 4px;
            flex-shrink: 0;
            opacity: 0;
            visibility: hidden;
            pointer-events: none;
            transition: opacity 0.12s ease;
        }
        .note-row.folder-row:hover .note-folder-actions,
        .note-row.folder-row:focus .note-folder-actions,
        .note-row.folder-row:focus-within .note-folder-actions {
            opacity: 1;
            visibility: visible;
            pointer-events: auto;
        }
        .note-folder-action {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 20px;
            height: 20px;
            border: none;
            border-radius: 4px;
            background: transparent;
            color: var(--vscode-descriptionForeground);
            cursor: pointer;
        }
        .note-folder-action:hover {
            background: var(--vscode-list-hoverBackground);
            color: var(--vscode-foreground);
        }
        .note-children {
            margin-left: 16px;
            padding-left: 6px;
            border-left: 1px dashed var(--vscode-panel-border);
        }
        .note-context-menu {
            position: fixed;
            z-index: 1000;
            display: none;
            min-width: 164px;
            padding: 4px;
            border-radius: 6px;
            border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border));
            background: var(--vscode-menu-background, var(--vscode-sideBar-background));
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
        }
        .note-context-menu.visible {
            display: block;
        }
        .note-context-menu-item {
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
        .note-context-menu-item:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .note-context-menu-item[hidden] {
            display: none;
        }

        /* ── Folder chevron (expand/collapse) ────────────── */
        .note-folder-chevron {
            font-size: 12px;
            flex-shrink: 0;
            cursor: pointer;
            color: var(--vscode-foreground);
            opacity: 0.6;
            width: 16px;
            text-align: center;
        }
        .note-folder-chevron:hover {
            opacity: 1;
        }

        /* ── Drag-and-drop feedback ──────────────────────── */
        .note-row.drag-over,
        .notes-scope-label.drag-over {
            background: var(--vscode-list-dropBackground, rgba(0, 120, 212, 0.18));
            outline: 1px dashed var(--vscode-focusBorder);
            outline-offset: -1px;
            border-radius: 4px;
        }
        .note-row.dragging {
            opacity: 0.4;
        }

        /* ── Sticky footer toolbar ──────────────────────── */
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
        .footer-btn.secondary {
            background: color-mix(in srgb, var(--vscode-sideBar-background) 78%, var(--vscode-button-secondaryBackground) 22%);
            color: var(--vscode-foreground);
        }
    </style>
</head>
<body>
    ${debugStampHtml}
    <div id="content">${body}</div>

    <div class="note-context-menu" id="noteContextMenu">
        <button class="note-context-menu-item" id="noteContextAddNote" data-note-context-action="addNote">
            <span class="codicon codicon-add"></span>
            <span>Add Note Here</span>
        </button>
        <button class="note-context-menu-item" id="noteContextAddFolder" data-note-context-action="addNoteFolder">
            <span class="codicon codicon-new-folder"></span>
            <span>Add Folder Here</span>
        </button>
        <button class="note-context-menu-item" id="noteContextEdit" data-note-context-action="editNoteNode">
            <span class="codicon codicon-edit"></span>
            <span>Edit Folder</span>
        </button>
        <button class="note-context-menu-item" id="noteContextDelete" data-note-context-action="deleteNoteNode">
            <span class="codicon codicon-trash"></span>
            <span>Delete Folder</span>
        </button>
    </div>

    ${footerHtml}

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        let contextMenuTarget = null;
        const noteContextMenu = document.getElementById('noteContextMenu');
        const noteContextEdit = document.getElementById('noteContextEdit');
        const noteContextDelete = document.getElementById('noteContextDelete');

        function getCreateTargetPayload(target) {
            if (!target) {
                return null;
            }

            if (target.kind === 'folder') {
                return { id: target.id, locality: target.locality, kind: 'folder' };
            }

            return {
                id: target.id,
                locality: target.locality,
                kind: 'scopeRoot',
                label: target.label || ''
            };
        }

        function getFolderTargetFromElement(element) {
            if (!element) {
                return null;
            }

            const locality = element.dataset.noteFolderLocality;
            const id = element.dataset.noteFolderId;
            const label = element.dataset.noteFolderLabel;
            if (!locality || !id) {
                return null;
            }

            return {
                kind: 'folder',
                locality,
                id,
                label: label || ''
            };
        }

        function closeNoteContextMenu() {
            contextMenuTarget = null;
            if (noteContextMenu) {
                noteContextMenu.classList.remove('visible');
            }
        }

        function postNoteCreate(messageType, overrideTarget) {
            const payload = getCreateTargetPayload(overrideTarget || null);
            if (payload) {
                vscode.postMessage({ type: messageType, target: payload });
                return;
            }

            vscode.postMessage({ type: messageType });
        }

        function openNoteContextMenu(target, x, y) {
            if (!noteContextMenu || !target) {
                return;
            }

            contextMenuTarget = target;

            const isFolder = target.kind === 'folder';
            noteContextEdit.hidden = !isFolder;
            noteContextDelete.hidden = !isFolder;
            noteContextMenu.style.left = Math.max(8, Number(x) || 8) + 'px';
            noteContextMenu.style.top = Math.max(8, Number(y) || 8) + 'px';
            noteContextMenu.classList.add('visible');
        }

        document.addEventListener('contextmenu', e => {
            const folderRow = e.target.closest('[data-note-folder-id]');
            if (!folderRow) {
                closeNoteContextMenu();
                return;
            }

            e.preventDefault();
            openNoteContextMenu(getFolderTargetFromElement(folderRow), e.clientX, e.clientY);
        });

        document.addEventListener('dblclick', e => {
            if (e.target.closest('[data-note-chevron]')) {
                return;
            }

            const noteRow = e.target.closest('[data-note-action]');
            if (noteRow) {
                closeNoteContextMenu();
                vscode.postMessage({ type: 'editNoteNode', id: noteRow.dataset.noteAction });
                return;
            }

            const noteFolder = e.target.closest('[data-note-folder-id]');
            if (!noteFolder) {
                return;
            }

            closeNoteContextMenu();
            vscode.postMessage({ type: 'editNoteNode', id: noteFolder.dataset.noteFolderId });
        });

        window.addEventListener('message', e => {
            if (e.data.type === 'refreshContent') {
                document.getElementById('content').innerHTML = e.data.html;
            }
        });

        document.addEventListener('click', e => {
            const chevron = e.target.closest('[data-note-chevron]');
            if (chevron) {
                closeNoteContextMenu();
                vscode.postMessage({ type: 'toggleNoteFolder', id: chevron.dataset.noteChevron });
                return;
            }

            const noteContextAction = e.target.closest('[data-note-context-action]');
            if (noteContextAction && contextMenuTarget) {
                const action = noteContextAction.dataset.noteContextAction;
                if (action === 'addNote' || action === 'addNoteFolder') {
                    postNoteCreate(action, contextMenuTarget);
                } else if (action === 'editNoteNode') {
                    vscode.postMessage({ type: 'editNoteNode', id: contextMenuTarget.id });
                } else if (action === 'deleteNoteNode') {
                    vscode.postMessage({ type: 'deleteNoteNode', id: contextMenuTarget.id });
                }
                closeNoteContextMenu();
                return;
            }
            const folderAddAction = e.target.closest('[data-note-folder-add]');
            if (folderAddAction) {
                closeNoteContextMenu();
                postNoteCreate('addNote', {
                    kind: 'folder',
                    id: folderAddAction.dataset.noteFolderAdd,
                    locality: folderAddAction.dataset.noteFolderLocality,
                    label: folderAddAction.dataset.noteFolderLabel || ''
                });
                return;
            }
            const exec = e.target.closest('[data-execute]');
            const cogBtn = e.target.closest('[data-open-editor-tab]');
            if (exec) {
                closeNoteContextMenu();
                vscode.postMessage({ type: 'execute', id: exec.dataset.execute });
                return;
            }
            if (cogBtn) {
                closeNoteContextMenu();
                vscode.postMessage({ type: 'openEditorTab', tab: cogBtn.dataset.openEditorTab });
                return;
            }
            const addLocality = e.target.closest('[data-add-locality]');
            if (addLocality) {
                closeNoteContextMenu();
                vscode.postMessage({ type: 'addButtonWithLocality', locality: addLocality.dataset.addLocality });
                return;
            }
            const noteAction = e.target.closest('[data-note-action]');
            if (noteAction) {
                closeNoteContextMenu();
                vscode.postMessage({ type: 'openNoteActions', id: noteAction.dataset.noteAction });
                return;
            }
            const noteEdit = e.target.closest('[data-note-edit]');
            if (noteEdit) {
                closeNoteContextMenu();
                vscode.postMessage({ type: 'editNoteNode', id: noteEdit.dataset.noteEdit });
                return;
            }
            if (e.target.closest('#addNoteBtn') || e.target.closest('#addNoteFooterBtn')) {
                closeNoteContextMenu();
                postNoteCreate('addNote');
                return;
            }
            if (e.target.closest('#addBtn')) {
                closeNoteContextMenu();
                vscode.postMessage({ type: 'addButton' });
                return;
            }
            if (e.target.closest('#openNoteEditorBtn')) {
                closeNoteContextMenu();
                vscode.postMessage({ type: 'openNoteEditor' });
                return;
            }
            if (e.target.closest('[data-open-editor]')) {
                closeNoteContextMenu();
                vscode.postMessage({ type: 'openEditor' });
                return;
            }
            if (e.target.closest('#editAllBtn')) {
                closeNoteContextMenu();
                vscode.postMessage({ type: 'openEditor' });
                return;
            }

            closeNoteContextMenu();
        });

        let dragSourceId = null;
        let currentDropTarget = null;

        document.addEventListener('dragstart', e => {
                if (e.target.closest('[data-note-folder-add]') || e.target.closest('[data-note-chevron]')) {
                    return;
                }

            const row = e.target.closest('[data-note-drag-id]');
            if (!row) { return; }
            dragSourceId = row.dataset.noteDragId;
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', dragSourceId);
            row.classList.add('dragging');
        });

        document.addEventListener('dragover', e => {
            if (!dragSourceId) { return; }
            const folder = e.target.closest('[data-note-folder-id]');
            const scope = e.target.closest('[data-note-drop-scope]');
            const target = (folder && folder.dataset.noteFolderId !== dragSourceId) ? folder : (scope || null);

            if (target) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                if (target !== currentDropTarget) {
                    if (currentDropTarget) { currentDropTarget.classList.remove('drag-over'); }
                    target.classList.add('drag-over');
                    currentDropTarget = target;
                }
            } else if (currentDropTarget) {
                currentDropTarget.classList.remove('drag-over');
                currentDropTarget = null;
            }
        });

        document.addEventListener('drop', e => {
            e.preventDefault();
                const target = currentDropTarget;
                if (target) { target.classList.remove('drag-over'); }

                if (dragSourceId && target) {
                    if (target.dataset.noteFolderId && target.dataset.noteFolderId !== dragSourceId) {
                    vscode.postMessage({
                        type: 'moveNoteNode',
                        id: dragSourceId,
                            locality: target.dataset.noteFolderLocality,
                            parentId: target.dataset.noteFolderId
                    });
                    } else if (target.dataset.noteDropScope) {
                    vscode.postMessage({
                        type: 'moveNoteNode',
                        id: dragSourceId,
                            locality: target.dataset.noteDropScope,
                        parentId: null
                    });
                }
            }

            dragSourceId = null;
            currentDropTarget = null;
        });

        document.addEventListener('dragend', e => {
            const row = e.target.closest('[data-note-drag-id]');
            if (row) { row.classList.remove('dragging'); }
            if (currentDropTarget) { currentDropTarget.classList.remove('drag-over'); }
            dragSourceId = null;
            currentDropTarget = null;
        });

        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') {
                closeNoteContextMenu();
            }
        });
    </script>
</body>
</html>`;
    }

    private _renderEmpty(): string {
        return `<div class="empty-state">
            <div class="empty-icon"><span class="codicon codicon-layout"></span></div>
            <p>No buttons configured yet.</p>
            <p class="hint">Use the <strong>Add Button</strong> button below<br>or click the gear icon above.</p>
        </div>`;
    }

    private _renderSections(globals: ButtonConfig[], locals: ButtonConfig[], columns: number, workspaceName: string | null): string {
        let html = '';
        const wsLabel = workspaceName ? `Workspace [${workspaceName}]` : 'Workspace';

        if (globals.length > 0) {
            html += this._renderLocalityHeader('Global', 'Global');
            html += this._renderGrouped(globals, columns);
        }

        html += this._renderLocalityHeader(wsLabel, 'Local');
        html += locals.length > 0
            ? this._renderGrouped(locals, columns)
            : `<div style="font-size:11px;color:var(--vscode-descriptionForeground);padding:4px 2px 8px;">No workspace buttons. Add one via the editor.</div>`;

        return html;
    }

    private _renderLocalityHeader(label: string, locality: ButtonLocality): string {
        const escapedLabel = escapeHtml(label);
        const escapedLocality = escapeAttribute(locality);

        return `<div class="locality-header header-with-actions">
            <span>${escapedLabel}</span>
            <div class="header-actions">
                <button class="header-action-btn" data-add-locality="${escapedLocality}" title="Add ${escapedLabel} button">
                    <span class="codicon codicon-add"></span>
                </button>
                <button class="header-action-btn" data-open-editor="true" title="Open Button Editor">
                    <span class="codicon codicon-gear"></span>
                </button>
            </div>
        </div>`;
    }

    private _renderNotesSection(workspaceName: string | null): string {
        const wsLabel = workspaceName ? `Workspace Notes [${workspaceName}]` : 'Workspace Notes';
        const globalNotes = this.noteStore.getChildren('Global', null);
        const localNotes = this.noteStore.getChildren('Local', null);
        const collapsedIds = new Set(this.globalState.get<string[]>('notes.collapsedFolders', []));

        let html = `<div class="section-header header-with-actions">
            <span>Notes</span>
            <div class="header-actions">
                <button class="header-action-btn" id="addNoteBtn" title="Add note">
                    <span class="codicon codicon-add"></span>
                </button>
                <button class="header-action-btn" id="openNoteEditorBtn" title="Open Note Editor">
                    <span class="codicon codicon-gear"></span>
                </button>
            </div>
        </div>`;

        html += this._renderNoteScope('Global Notes', 'Global', globalNotes, collapsedIds);
        html += this._renderNoteScope(wsLabel, 'Local', localNotes, collapsedIds);

        return html;
    }

    private _renderNoteScope(label: string, locality: ButtonLocality, nodes: NoteNode[], collapsedIds: Set<string>): string {
        const escapedLabel = escapeHtml(label);
        const escapedLocality = escapeAttribute(locality);
        let html = `<div class="notes-scope-label" id="note-scope-${escapedLocality.toLowerCase()}" data-note-drop-scope="${escapedLocality}">${escapedLabel}</div>`;

        html += nodes.length > 0
            ? `<div class="notes-root">${this._renderNoteNodes(nodes, 0, collapsedIds)}</div>`
            : `<div class="inline-empty">No ${escapedLabel.toLowerCase()}. Add one via the editor.</div>`;

        return html;
    }

    private _renderNoteNodes(nodes: NoteNode[], depth: number, collapsedIds: Set<string>): string {
        const sortedNodes = [...nodes].sort((left, right) => {
            const order = (left.sortOrder ?? 99999) - (right.sortOrder ?? 99999);
            if (order !== 0) {
                return order;
            }
            if (left.kind !== right.kind) {
                return left.kind === 'folder' ? -1 : 1;
            }
            return left.name.localeCompare(right.name);
        });

        let html = '';
        for (const node of sortedNodes) {
            const indent = 4 + depth * 14;
            const icon = node.icon || getDefaultNoteIcon(node.kind);
            const colourStyle = node.colour ? ` style="color:${escapeAttribute(node.colour)}"` : '';
            const escapedId = escapeAttribute(node.id);

            if (node.kind === 'folder') {
                const children = this.noteStore.getChildren(node.locality, node.id);
                const hasChildren = children.length > 0;
                const isCollapsed = hasChildren && collapsedIds.has(node.id);

                const chevronHtml = hasChildren
                    ? `<span class="codicon codicon-${isCollapsed ? 'chevron-right' : 'chevron-down'} note-folder-chevron" id="note-chevron-${escapedId}" draggable="false" data-note-chevron="${escapedId}"></span>`
                    : `<span class="note-folder-chevron"></span>`;

                html += `<div class="note-row folder-row" id="note-folder-row-${escapedId}" tabindex="0" draggable="true" data-note-folder-id="${escapedId}" data-note-folder-locality="${escapeAttribute(node.locality)}" data-note-folder-label="${escapeAttribute(node.name || 'Untitled Folder')}" data-note-drag-id="${escapedId}" data-note-drag-locality="${escapeAttribute(node.locality)}" title="Hover to add a note, double-click to edit, or right-click for more actions." style="padding-left:${indent}px">
                    ${chevronHtml}
                    <span class="codicon codicon-${escapeHtml(icon)} note-icon"${colourStyle}></span>
                    <span class="note-label">${escapeHtml(node.name || 'Untitled Folder')}</span>
                    <span class="note-folder-actions">
                        <button class="note-folder-action" id="note-folder-add-${escapedId}" draggable="false" data-note-folder-add="${escapedId}" data-note-folder-locality="${escapeAttribute(node.locality)}" data-note-folder-label="${escapeAttribute(node.name || 'Untitled Folder')}" title="Add note to ${escapeAttribute(node.name || 'Untitled Folder')}">
                            <span class="codicon codicon-add"></span>
                        </button>
                    </span>
                </div>`;

                if (hasChildren && !isCollapsed) {
                    html += `<div class="note-children">${this._renderNoteNodes(children, depth + 1, collapsedIds)}</div>`;
                }
                continue;
            }

            const badges: string[] = [];
            if (node.format === 'Markdown') {
                badges.push('<span class="note-badge">md</span>');
            }
            if (node.promptEnabled) {
                badges.push('<span class="note-badge">prompt</span>');
            }

            html += `<div class="note-row" id="note-row-${escapedId}" draggable="true" data-note-action="${escapedId}" data-note-drag-id="${escapedId}" data-note-drag-locality="${escapeAttribute(node.locality)}" style="padding-left:${indent}px">
                <span class="codicon codicon-${escapeHtml(icon)} note-icon"${colourStyle}></span>
                <span class="note-label">${escapeHtml(node.name || 'Untitled Note')}</span>
                <span class="note-badges">${badges.join('')}</span>
            </div>`;
        }

        return html;
    }

    private _renderGrouped(buttons: ButtonConfig[], columns: number): string {
        // Sort by sortOrder
        const sorted = [...buttons].sort((a, b) => (a.sortOrder ?? 99999) - (b.sortOrder ?? 99999));

        // Group by category
        const cats = new Map<string, ButtonConfig[]>();
        for (const b of sorted) {
            const cat = b.category || 'General';
            if (!cats.has(cat)) { cats.set(cat, []); }
            cats.get(cat)!.push(b);
        }

        const sortedCats = Array.from(cats.keys()).sort();
        const showLabels = sortedCats.length > 1;
        const useGrid = columns > 1;
        const flowClass = useGrid ? 'button-grid' : 'button-flow';
        const flowStyle = useGrid ? ` style="grid-template-columns:repeat(${columns},1fr)"` : '';
        let html = '';

        for (const cat of sortedCats) {
            if (showLabels) {
                html += `<div class="category-label"><span class="codicon codicon-folder"></span><span>${escapeHtml(cat)}</span></div>`;
            }
            html += `<div class="${flowClass}"${flowStyle}>`;
            for (const btn of cats.get(cat)!) {
                html += this._renderButton(btn);
            }
            html += `</div>`;
        }

        return html;
    }

    private _renderButton(btn: ButtonConfig): string {
        const icon = btn.icon || 'play';
        const colour = btn.colour;
        const tooltip = escapeHtml(btn.description || btn.name);

        let colourStyle = '';
        const validHex = normaliseHex(colour);
        if (validHex) {
            const fg = getContrastColour(validHex);
            const hover = lightenHex(validHex, 0.18);
            colourStyle = `background:${validHex};color:${fg};--fu-btn-hover-bg:${hover};`;
        }

        return `<button class="fu-btn" data-execute="${escapeHtml(btn.id)}" title="${tooltip}" aria-label="${tooltip}"${colourStyle ? ` style="${colourStyle}"` : ''}>
                <span class="codicon codicon-${escapeHtml(icon)} btn-icon"></span>
                <span class="btn-label">${escapeHtml(btn.name)}</span>
            </button>`;
    }
}
