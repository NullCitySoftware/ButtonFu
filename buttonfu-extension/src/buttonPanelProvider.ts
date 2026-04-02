import * as vscode from 'vscode';
import { ButtonConfig } from './types';
import { ButtonStore } from './buttonStore';
import { buildInfo } from './buildInfo';
import { getNonce, escapeHtml } from './utils';

const HEX_COLOUR_PATTERN = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;

function getHexBase(hex: string): string {
    return hex.slice(0, 7);
}

function getHexAlpha(hex: string): string {
    return hex.length >= 9 ? hex.slice(7, 9) : '';
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
    const alpha = getHexAlpha(hex);
    const r = parseInt(base.slice(1, 3), 16);
    const g = parseInt(base.slice(3, 5), 16);
    const b = parseInt(base.slice(5, 7), 16);

    const nr = clamp(Math.round(r + (255 - r) * amount));
    const ng = clamp(Math.round(g + (255 - g) * amount));
    const nb = clamp(Math.round(b + (255 - b) * amount));

    return `#${nr.toString(16).padStart(2, '0')}${ng.toString(16).padStart(2, '0')}${nb.toString(16).padStart(2, '0')}${alpha}`;
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
        private readonly globalState: vscode.Memento
    ) {
        store.onDidChange(() => this.refresh());
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
            const hasWorkspace = !!(vscode.workspace.workspaceFolders?.length);
            const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name ?? vscode.workspace.name ?? null;
            const columns = Math.max(1, Math.min(12, this.globalState.get<number>('options.columns', 1)));

            const body = allButtons.length === 0
                ? this._renderEmpty()
                : this._renderSections(globalButtons, localButtons, hasWorkspace, columns, workspaceName);

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
        <button class="footer-btn primary" id="addBtn">
            <span class="codicon codicon-add"></span> Add Button
        </button>
        <button class="footer-btn secondary" id="editAllBtn">
            <span class="codicon codicon-gear"></span> Editor
        </button>
    </div>`
            : '';
        const bodyPadding = showFooter ? '8px 6px 60px' : '8px 6px 8px';

        const codiconsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css')
        );

        const allButtons = this.store.getAllButtons();
        const globalButtons = allButtons.filter(b => b.locality === 'Global');
        const localButtons = allButtons.filter(b => b.locality === 'Local');
        const hasWorkspace = !!(vscode.workspace.workspaceFolders?.length);
        const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name ?? vscode.workspace.name ?? null;

        const body = allButtons.length === 0
            ? this._renderEmpty()
            : this._renderSections(globalButtons, localButtons, hasWorkspace, columns, workspaceName);

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
        .locality-cog-btn {
            background: transparent;
            border: none;
            color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-descriptionForeground));
            cursor: pointer;
            padding: 0 2px;
            border-radius: 3px;
            line-height: 1;
            font-size: 13px;
            opacity: 0.6;
            flex-shrink: 0;
        }
        .locality-cog-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }

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
        .footer-btn.secondary {
            background: color-mix(in srgb, var(--vscode-sideBar-background) 78%, var(--vscode-button-secondaryBackground) 22%);
            color: var(--vscode-foreground);
        }
    </style>
</head>
<body>
    ${debugStampHtml}
    <div id="content">${body}</div>

    ${footerHtml}

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();

        window.addEventListener('message', e => {
            if (e.data.type === 'refreshContent') {
                document.getElementById('content').innerHTML = e.data.html;
            }
        });

        document.addEventListener('click', e => {
            const exec = e.target.closest('[data-execute]');
            if (exec) { vscode.postMessage({ type: 'execute', id: exec.dataset.execute }); return; }
            const cogBtn = e.target.closest('[data-open-editor-tab]');
            if (cogBtn) { vscode.postMessage({ type: 'openEditorTab', tab: cogBtn.dataset.openEditorTab }); return; }
            if (e.target.closest('#addBtn')) {
                vscode.postMessage({ type: 'addButton' });
                return;
            }
            if (e.target.closest('#editAllBtn')) {
                vscode.postMessage({ type: 'openEditor' });
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

    private _renderSections(globals: ButtonConfig[], locals: ButtonConfig[], hasWorkspace: boolean, columns: number, workspaceName: string | null): string {
        let html = '';
        const wsLabel = workspaceName ? `Workspace [${workspaceName}]` : 'Workspace';

        if (globals.length > 0) {
            html += `<div class="locality-header"><span>Global</span><button class="locality-cog-btn" data-open-editor-tab="global" title="Open editor \u2014 Global tab"><span class="codicon codicon-settings-gear"></span></button></div>`;
            html += this._renderGrouped(globals, columns);
        }

        if (hasWorkspace) {
            if (locals.length > 0) {
                html += `<div class="locality-header"><span>${escapeHtml(wsLabel)}</span><button class="locality-cog-btn" data-open-editor-tab="local" title="Open editor \u2014 Workspace tab"><span class="codicon codicon-settings-gear"></span></button></div>`;
                html += this._renderGrouped(locals, columns);
            } else if (globals.length > 0) {
                html += `<div class="locality-header"><span>${escapeHtml(wsLabel)}</span><button class="locality-cog-btn" data-open-editor-tab="local" title="Open editor \u2014 Workspace tab"><span class="codicon codicon-settings-gear"></span></button></div>`;
                html += `<div style="font-size:11px;color:var(--vscode-descriptionForeground);padding:4px 2px 8px;">No workspace buttons. Add one via the editor.</div>`;
            }
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
        if (colour && HEX_COLOUR_PATTERN.test(colour)) {
            const fg = getContrastColour(colour);
            const hover = lightenHex(colour, 0.18);
            colourStyle = `background:${colour};color:${fg};--fu-btn-hover-bg:${hover};`;
        }

        return `<button class="fu-btn" data-execute="${escapeHtml(btn.id)}" title="${tooltip}" aria-label="${tooltip}"${colourStyle ? ` style="${colourStyle}"` : ''}>
                <span class="codicon codicon-${escapeHtml(icon)} btn-icon"></span>
                <span class="btn-label">${escapeHtml(btn.name)}</span>
            </button>`;
    }
}
