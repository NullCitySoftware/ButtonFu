/**
 * Shared utility functions for ButtonFu webview providers.
 */

import * as crypto from 'crypto';

export type ShellKind = 'cmd' | 'powershell' | 'posix';

/** Generate a cryptographic nonce for CSP script/style tags */
export function getNonce(): string {
    return crypto.randomBytes(16).toString('hex');
}

/** Escape a string for safe insertion into HTML */
export function escapeHtml(s: string): string {
    if (!s) { return ''; }
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function detectShellKind(shellPath: string): ShellKind {
    const normalized = shellPath.toLowerCase();
    if (normalized.includes('pwsh') || normalized.includes('powershell')) {
        return 'powershell';
    }
    if (normalized.includes('bash') || normalized.includes('zsh') || normalized.includes('fish') || normalized.includes('wsl') || normalized.includes('sh.exe')) {
        return 'posix';
    }
    return process.platform === 'win32' ? 'cmd' : 'posix';
}

/**
 * Escape a value for interpolation into a shell command.
 * PowerShell and POSIX use single-quoted literals; cmd.exe uses a best-effort quoted form.
 */
export function shellEscape(value: string, shellKind: ShellKind): string {
    if (shellKind === 'powershell') {
        return value === '' ? "''" : "'" + value.replace(/'/g, "''") + "'";
    }
    if (shellKind === 'cmd') {
        if (value === '') { return '""'; }
        return '"' + value.replace(/"/g, '\\"').replace(/%/g, '%%') + '"';
    }
    return value === '' ? "''" : "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * Strip JSONC (JSON with Comments) comments from a string, respecting quoted strings.
 * Handles line comments (//) and block comments without breaking on
 * comment-like sequences inside string literals.
 */
export function stripJsoncComments(text: string): string {
    let result = '';
    let i = 0;
    const len = text.length;
    while (i < len) {
        const ch = text[i];
        // String literal — copy verbatim including escapes
        if (ch === '"') {
            let j = i + 1;
            while (j < len) {
                if (text[j] === '\\') { j += 2; continue; }
                if (text[j] === '"') { j++; break; }
                j++;
            }
            result += text.slice(i, j);
            i = j;
            continue;
        }
        // Line comment
        if (ch === '/' && i + 1 < len && text[i + 1] === '/') {
            i += 2;
            while (i < len && text[i] !== '\n') { i++; }
            continue;
        }
        // Block comment
        if (ch === '/' && i + 1 < len && text[i + 1] === '*') {
            i += 2;
            while (i + 1 < len && !(text[i] === '*' && text[i + 1] === '/')) { i++; }
            i += 2; // skip */
            continue;
        }
        result += ch;
        i++;
    }
    return result;
}
