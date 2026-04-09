import * as vscode from 'vscode';
import * as fs from 'fs';
import {
    ResolvedPromptToken,
    TokenSnapshot,
    UnresolvedPromptToken,
    UsedSystemPromptToken
} from './promptActionService';
import { getNonce, escapeHtml } from './webviewControls';

/** Request payload for the reusable prompt token input panel */
export interface PromptTokenInputRequest {
    title: string;
    subtitle: string;
    description?: string;
    icon?: string;
    previewLabel: string;
    previewText: string;
    executeLabel?: string;
    unresolvedTokens: UnresolvedPromptToken[];
    resolvedUserTokens: ResolvedPromptToken[];
    usedSystemTokens: UsedSystemPromptToken[];
    extensionUri: vscode.Uri;
    onExecute: (userValues: TokenSnapshot) => Promise<void>;
}

/** Webview panel that requests user input for unresolved prompt tokens */
export class PromptTokenInputPanel {
    private readonly panel: vscode.WebviewPanel;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(private readonly request: PromptTokenInputRequest) {
        this.panel = vscode.window.createWebviewPanel(
            'buttonfu.promptTokenInput',
            `ButtonFu - ${request.title}`,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: false,
                localResourceRoots: [
                    request.extensionUri,
                    vscode.Uri.joinPath(request.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist')
                ]
            }
        );

        this.panel.webview.html = this.getHtmlContent();
        this.panel.webview.onDidReceiveMessage(async (message) => this.handleMessage(message), null, this.disposables);
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    }

    private dispose(): void {
        while (this.disposables.length > 0) {
            const disposable = this.disposables.pop();
            if (disposable) { disposable.dispose(); }
        }
    }

    private async handleMessage(message: any): Promise<void> {
        switch (message.type) {
            case 'execute': {
                const userValues: TokenSnapshot = {};
                const values = message.values as Record<string, string>;
                for (const [key, value] of Object.entries(values)) {
                    userValues[key.toLowerCase()] = value;
                }
                for (const token of this.request.resolvedUserTokens) {
                    userValues[token.token.toLowerCase()] = token.value;
                }
                await this.request.onExecute(userValues);
                this.panel.dispose();
                break;
            }
            case 'cancel':
                this.panel.dispose();
                break;
        }
    }

    private getHtmlContent(): string {
        const nonce = getNonce();
        const webview = this.panel.webview;

        const codiconsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.request.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css')
        );
        const iconSvgPath = vscode.Uri.joinPath(this.request.extensionUri, 'resources', 'icon.svg').fsPath;
        const iconSvg = fs.readFileSync(iconSvgPath, 'utf8')
            .replace('<svg ', '<svg width="20" height="20" style="flex-shrink:0;vertical-align:middle" ');

        const unresolvedJson = JSON.stringify(this.request.unresolvedTokens);
        const resolvedUserJson = JSON.stringify(this.request.resolvedUserTokens);
        const usedSystemJson = JSON.stringify(this.request.usedSystemTokens);
        const previewText = escapeHtml(this.request.previewText);
        const icon = escapeHtml(this.request.icon || 'symbol-string');
        const executeLabel = escapeHtml(this.request.executeLabel || 'Continue');

        return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${webview.cspSource}; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}';">
    <link rel="stylesheet" href="${codiconsUri}">
    <title>ButtonFu - ${escapeHtml(this.request.title)}</title>
    <style nonce="${nonce}">
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            padding: 0;
            height: 100vh;
            overflow-y: auto;
        }
        .container {
            max-width: 800px;
            margin: 0 auto;
            padding: 24px 20px 40px;
        }
        .page-header {
            display: flex;
            align-items: center;
            gap: 12px;
            padding-bottom: 16px;
            border-bottom: 1px solid var(--vscode-panel-border);
            margin-bottom: 20px;
        }
        .page-header .header-icon {
            font-size: 28px;
            flex-shrink: 0;
        }
        .page-header h1 {
            font-size: 18px;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .page-header .subtitle {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin-top: 2px;
        }
        .description-block {
            background: var(--vscode-textBlockQuote-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            padding: 12px 16px;
            margin-bottom: 20px;
            font-size: 13px;
            line-height: 1.5;
        }
        .command-preview {
            margin-bottom: 24px;
        }
        .command-preview label {
            display: block;
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 6px;
        }
        .command-preview textarea {
            width: 100%;
            min-height: 80px;
            padding: 8px 10px;
            font-family: var(--vscode-editor-font-family), monospace;
            font-size: var(--vscode-font-size);
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            resize: vertical;
            opacity: 0.8;
        }
        .section-title {
            font-size: 13px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 12px;
            display: flex;
            align-items: center;
            gap: 6px;
            padding-bottom: 6px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .resolved-table {
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 24px;
            font-size: 12px;
        }
        .resolved-table th {
            text-align: left;
            padding: 6px 10px;
            font-weight: 600;
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--vscode-descriptionForeground);
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .resolved-table td {
            padding: 6px 10px;
            border-bottom: 1px solid var(--vscode-panel-border);
            vertical-align: top;
        }
        .resolved-table .token-name {
            font-family: var(--vscode-editor-font-family), monospace;
            color: var(--vscode-textLink-foreground);
            white-space: nowrap;
        }
        .resolved-table .token-value {
            font-family: var(--vscode-editor-font-family), monospace;
            color: var(--vscode-foreground);
            max-width: 400px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .token-input-group {
            margin-bottom: 18px;
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 6px;
            padding: 14px 16px;
        }
        .token-input-group.error {
            border-color: #c72e2e;
        }
        .token-input-label {
            font-size: 13px;
            font-weight: 600;
            margin-bottom: 2px;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .token-input-label .token-name-badge {
            font-family: var(--vscode-editor-font-family), monospace;
            font-size: 11px;
            color: var(--vscode-textLink-foreground);
            background: var(--vscode-badge-background);
            padding: 1px 6px;
            border-radius: 3px;
        }
        .token-input-label .required-star {
            color: #c72e2e;
            font-weight: bold;
        }
        .token-input-desc {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 8px;
            line-height: 1.4;
        }
        .token-input-group input[type="text"],
        .token-input-group input[type="number"],
        .token-input-group textarea {
            width: 100%;
            padding: 6px 10px;
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            background: var(--vscode-editor-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            outline: none;
        }
        .token-input-group input:focus,
        .token-input-group textarea:focus {
            border-color: var(--vscode-focusBorder);
        }
        .token-input-group textarea {
            min-height: 80px;
            resize: vertical;
        }
        .error-msg {
            font-size: 11px;
            color: #c72e2e;
            margin-top: 4px;
            display: none;
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
        .bool-row {
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .footer-actions {
            display: flex;
            gap: 10px;
            justify-content: flex-end;
            padding-top: 20px;
            border-top: 1px solid var(--vscode-panel-border);
            margin-top: 24px;
        }
        .btn {
            padding: 8px 20px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            font-family: var(--vscode-font-family);
            font-weight: 600;
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
    </style>
</head>
<body>
    <div class="container">
        <div class="page-header">
            <span class="header-icon codicon codicon-${icon}"></span>
            <div>
                <h1>${iconSvg} ${escapeHtml(this.request.title)}</h1>
                <div class="subtitle">${escapeHtml(this.request.subtitle)}</div>
            </div>
        </div>

        ${this.request.description ? `<div class="description-block">${escapeHtml(this.request.description)}</div>` : ''}

        <div class="command-preview">
            <label><span class="codicon codicon-code"></span> ${escapeHtml(this.request.previewLabel)}</label>
            <textarea readonly>${previewText}</textarea>
        </div>

        <div id="resolvedSection"></div>
        <div id="inputSection"></div>

        <div class="footer-actions">
            <button class="btn btn-secondary" id="cancelBtn">
                <span class="codicon codicon-chrome-close"></span> Cancel
            </button>
            <button class="btn btn-primary" id="executeBtn">
                <span class="codicon codicon-play"></span> ${executeLabel}
            </button>
        </div>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const unresolvedTokens = ${unresolvedJson};
        const resolvedUserTokens = ${resolvedUserJson};
        const usedSystemTokens = ${usedSystemJson};

        function escapeHtml(s) {
            if (!s) return '';
            return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        }

        function renderResolved() {
            const section = document.getElementById('resolvedSection');
            const allResolved = [...usedSystemTokens.map(t => ({
                token: t.token, label: t.description, value: t.value, source: 'System'
            })), ...resolvedUserTokens.map(t => ({
                token: t.token, label: t.label, value: t.value, source: 'Default'
            }))];

            if (allResolved.length === 0) {
                section.innerHTML = '';
                return;
            }

            let html = '<div class="section-title"><span class="codicon codicon-check"></span> Resolved Tokens</div>';
            html += '<table class="resolved-table"><thead><tr><th>Token</th><th>Value</th><th>Source</th></tr></thead><tbody>';
            allResolved.forEach(t => {
                html += '<tr><td class="token-name">' + escapeHtml(t.token) + '</td>' +
                    '<td class="token-value" title="' + escapeHtml(t.value) + '">' + escapeHtml(t.value) + '</td>' +
                    '<td>' + escapeHtml(t.source) + '</td></tr>';
            });
            html += '</tbody></table>';
            section.innerHTML = html;
        }

        function renderInputs() {
            const section = document.getElementById('inputSection');
            if (unresolvedTokens.length === 0) {
                section.innerHTML = '<p style="color:var(--vscode-descriptionForeground);padding:12px 0">All tokens have been resolved. Click Continue to proceed.</p>';
                return;
            }

            let html = '<div class="section-title"><span class="codicon codicon-edit"></span> Input Required</div>';
            unresolvedTokens.forEach((t, i) => {
                const inputId = 'token-input-' + i;
                const requiredStar = t.required ? '<span class="required-star">*</span>' : '';
                html += '<div class="token-input-group" id="group-' + i + '">';
                html += '<div class="token-input-label">' + escapeHtml(t.label) + ' ' + requiredStar +
                    '<span class="token-name-badge">' + escapeHtml(t.token) + '</span></div>';
                if (t.description) {
                    html += '<div class="token-input-desc">' + escapeHtml(t.description) + '</div>';
                }

                switch (t.dataType) {
                    case 'Boolean':
                        html += '<div class="bool-row"><label class="toggle-switch"><input type="checkbox" id="' + inputId + '" data-token="' + escapeHtml(t.token) + '" data-type="Boolean"><span class="toggle-slider"></span></label><span>Enable</span></div>';
                        break;
                    case 'Integer':
                        html += '<input type="number" id="' + inputId + '" data-token="' + escapeHtml(t.token) + '" data-type="Integer" placeholder="Enter integer value..." />';
                        break;
                    case 'MultiLineString':
                        html += '<textarea id="' + inputId + '" data-token="' + escapeHtml(t.token) + '" data-type="MultiLineString" placeholder="Enter text..." rows="4"></textarea>';
                        break;
                    default:
                        html += '<input type="text" id="' + inputId + '" data-token="' + escapeHtml(t.token) + '" data-type="String" placeholder="Enter value..." />';
                        break;
                }
                html += '<div class="error-msg" id="error-' + i + '">This field is required</div>';
                html += '</div>';
            });
            section.innerHTML = html;
        }

        renderResolved();
        renderInputs();

        document.getElementById('executeBtn').addEventListener('click', () => {
            let valid = true;
            const values = {};

            unresolvedTokens.forEach((token, index) => {
                const input = document.getElementById('token-input-' + index);
                const group = document.getElementById('group-' + index);
                const error = document.getElementById('error-' + index);
                let value = '';

                if (token.dataType === 'Boolean') {
                    value = input.checked ? 'true' : 'false';
                } else {
                    value = input.value || '';
                }

                const isEmpty = token.dataType !== 'Boolean' && value.trim() === '';
                if (token.required && isEmpty) {
                    valid = false;
                    group.classList.add('error');
                    error.style.display = 'block';
                } else {
                    group.classList.remove('error');
                    error.style.display = 'none';
                }

                values[token.token] = value;
            });

            if (!valid) {
                return;
            }

            vscode.postMessage({ type: 'execute', values });
        });

        document.getElementById('cancelBtn').addEventListener('click', () => {
            vscode.postMessage({ type: 'cancel' });
        });
    </script>
</body>
</html>`;
    }
}