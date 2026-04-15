import * as vscode from 'vscode';
import { ButtonConfig } from './types';
import { ButtonExecutor, TokenSnapshot } from './buttonExecutor';
import { getNonce, escapeHtml } from './utils';

interface UnresolvedToken {
    token: string;
    label: string;
    description: string;
    dataType: string;
    required: boolean;
}

interface ResolvedToken {
    token: string;
    label: string;
    value: string;
    dataType: string;
}

interface UsedSystemToken {
    token: string;
    value: string;
    description: string;
}

/**
 * Webview panel that requests user input for unresolved tokens before executing a button.
 */
export class TokenInputPanel {
    private readonly panel: vscode.WebviewPanel;
    private readonly disposables: vscode.Disposable[] = [];
    private isDisposed = false;

    constructor(
        private readonly button: ButtonConfig,
        private readonly systemSnap: TokenSnapshot,
        private readonly unresolvedTokens: UnresolvedToken[],
        private readonly resolvedUserTokens: ResolvedToken[],
        private readonly usedSystemTokens: UsedSystemToken[],
        private readonly executor: ButtonExecutor,
        private readonly extensionUri: vscode.Uri
    ) {
        this.panel = vscode.window.createWebviewPanel(
            'buttonfu.tokenInput',
            `ButtonFu - ${button.name}`,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: false,
                localResourceRoots: [
                    extensionUri,
                    vscode.Uri.joinPath(extensionUri, 'node_modules', '@vscode', 'codicons', 'dist')
                ]
            }
        );

        this.panel.webview.html = this.getHtmlContent();

        this.panel.webview.onDidReceiveMessage(
            async (message) => await this.handleMessage(message),
            null,
            this.disposables
        );

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    }

    private dispose(): void {
        if (this.isDisposed) {
            return;
        }
        this.isDisposed = true;
        while (this.disposables.length) {
            const d = this.disposables.pop();
            if (d) { d.dispose(); }
        }
    }

    private async handleMessage(message: any): Promise<void> {
        switch (message.type) {
            case 'execute': {
                const userValues: TokenSnapshot = {};
                const values = message.values as Record<string, string>;
                for (const [key, val] of Object.entries(values)) {
                    userValues[key.toLowerCase()] = val;
                }
                // Add resolved user token defaults
                for (const rt of this.resolvedUserTokens) {
                    userValues[rt.token.toLowerCase()] = rt.value;
                }
                try {
                    await this.executor.executeWithTokens(this.button, this.systemSnap, userValues);
                    this.panel.dispose();
                } catch (err) {
                    vscode.window.showErrorMessage(`ButtonFu: Failed to execute button — ${err}`);
                }
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
            vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css')
        );
        const iconUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'resources', 'icon.svg')
        );
        const iconImg = `<img src="${iconUri}" width="20" height="20" style="flex-shrink:0;vertical-align:middle" alt="">`;

        const unresolvedJson = JSON.stringify(this.unresolvedTokens);
        const resolvedUserJson = JSON.stringify(this.resolvedUserTokens);
        const usedSystemJson = JSON.stringify(this.usedSystemTokens);

        const commandPreview = escapeHtml(this.button.executionText);

        return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; font-src ${webview.cspSource}; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}';">
    <link rel="stylesheet" href="${codiconsUri}">
    <title>ButtonFu - ${escapeHtml(this.button.name)}</title>
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

        /* Header */
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

        /* Description */
        .description-block {
            background: var(--vscode-textBlockQuote-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            padding: 12px 16px;
            margin-bottom: 20px;
            font-size: 13px;
            line-height: 1.5;
        }

        /* Command preview */
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

        /* Sections */
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

        /* Resolved tokens table */
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

        /* Input fields */
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

        /* Toggle switch */
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

        /* Footer buttons */
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
            <span class="header-icon codicon codicon-${escapeHtml(this.button.icon || 'play')}"></span>
            <div>
                <h1>${iconImg} ${escapeHtml(this.button.name)}</h1>
                <div class="subtitle">${escapeHtml(this.button.type)} · Provide the required input to execute this button</div>
            </div>
        </div>

        ${this.button.description ? `<div class="description-block">${escapeHtml(this.button.description)}</div>` : ''}

        <div class="command-preview">
            <label><span class="codicon codicon-code"></span> ${this.button.type === 'CopilotCommand' ? 'Prompt' : 'Command'}</label>
            <textarea readonly>${commandPreview}</textarea>
        </div>

        <div id="resolvedSection"></div>
        <div id="inputSection"></div>

        <div class="footer-actions">
            <button class="btn btn-secondary" id="cancelBtn">
                <span class="codicon codicon-chrome-close"></span> Cancel
            </button>
            <button class="btn btn-primary" id="executeBtn">
                <span class="codicon codicon-play"></span> Execute
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

        // Render resolved tokens (system + user with defaults)
        function renderResolved() {
            const section = document.getElementById('resolvedSection');
            const allResolved = [...usedSystemTokens.map(t => ({
                token: t.token, label: t.description, value: t.value, source: 'System'
            })), ...resolvedUserTokens.map(t => ({
                token: t.token, label: t.label, value: t.value, source: 'Default'
            }))];

            if (allResolved.length === 0) { section.innerHTML = ''; return; }

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

        // Render input fields for unresolved tokens
        function renderInputs() {
            const section = document.getElementById('inputSection');
            if (unresolvedTokens.length === 0) {
                section.innerHTML = '<p style="color:var(--vscode-descriptionForeground);padding:12px 0">All tokens have been resolved. Click Execute to proceed.</p>';
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

        // Execute button
        document.getElementById('executeBtn').addEventListener('click', () => {
            // Validate required fields
            let valid = true;
            const values = {};
            unresolvedTokens.forEach((t, i) => {
                const input = document.getElementById('token-input-' + i);
                const group = document.getElementById('group-' + i);
                const error = document.getElementById('error-' + i);
                let val = '';
                if (t.dataType === 'Boolean') {
                    val = input.checked ? 'true' : 'false';
                } else {
                    val = (input.value || '').trim();
                }
                if (t.required && (val === '' || val === undefined)) {
                    group.classList.add('error');
                    error.style.display = 'block';
                    valid = false;
                } else {
                    group.classList.remove('error');
                    error.style.display = 'none';
                }
                values[t.token] = val;
            });
            if (!valid) return;
            vscode.postMessage({ type: 'execute', values });
        });

        // Cancel button
        document.getElementById('cancelBtn').addEventListener('click', () => {
            vscode.postMessage({ type: 'cancel' });
        });
    </script>
</body>
</html>`;
    }
}
