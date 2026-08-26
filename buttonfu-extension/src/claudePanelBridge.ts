/**
 * Everything ButtonFu assumes about the Claude Code extension's own UI.
 *
 * One module owns those assumptions - the command names, the deep link, the fact that a seeded
 * prompt is typed but never sent - so that when Anthropic changes any of it there is a single file
 * to fix rather than a search across the repo.
 */

import * as vscode from 'vscode';
import { CLAUDE_EXTENSION_ID } from './claudeExecutable';
import { logClaude } from './claudeOutput';

export { CLAUDE_EXTENSION_ID };

/** The command that opens a Claude panel beside the current editor. */
export const CLAUDE_EDITOR_OPEN_COMMAND = 'claude-vscode.editor.open';

/** What `openPanel` needs to know. */
export interface OpenPanelOptions {
    /** The session to open. Omit to start a fresh one. */
    sessionId?: string;
    /** Text to type into the prompt box. It is typed, never sent. */
    prompt?: string;
    /** Move the panel into a window of its own once it is open. */
    newWindow?: boolean;
}

/** True when the Claude Code extension is installed in this window. */
export function isClaudeExtensionInstalled(): boolean {
    return vscode.extensions.getExtension(CLAUDE_EXTENSION_ID) !== undefined;
}

/**
 * Builds the deep link that opens a Claude panel.
 *
 * The extension's URI handler reads `session` and `prompt` off the query string and forwards them
 * to its own panel command, so the link and the command are the same code path with different
 * plumbing. The link is the sturdier of the two, because following it activates the extension on
 * the way in.
 */
export function buildDeepLink(options: OpenPanelOptions): vscode.Uri {
    const parts: string[] = [];
    if (options.sessionId) {
        parts.push(`session=${encodeURIComponent(options.sessionId)}`);
    }
    if (options.prompt) {
        parts.push(`prompt=${encodeURIComponent(options.prompt)}`);
    }

    return vscode.Uri.parse(
        `vscode://${CLAUDE_EXTENSION_ID}/open${parts.length > 0 ? `?${parts.join('&')}` : ''}`);
}

/**
 * Opens the Claude panel, by command where possible and by deep link otherwise.
 *
 * Returns false when the Claude Code extension is not installed, so the caller can offer something
 * the user can actually do instead of failing silently.
 */
export async function openPanel(options: OpenPanelOptions): Promise<boolean> {
    if (!isClaudeExtensionInstalled()) {
        return false;
    }

    const commands = await vscode.commands.getCommands(true);
    if (commands.includes(CLAUDE_EDITOR_OPEN_COMMAND)) {
        await vscode.commands.executeCommand(
            CLAUDE_EDITOR_OPEN_COMMAND, options.sessionId, options.prompt, vscode.ViewColumn.Active);
    } else {
        // The command is missing on this version, but the URI handler has been there throughout.
        await vscode.env.openExternal(buildDeepLink(options));
    }

    if (options.newWindow) {
        await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
    }

    return true;
}

/** The fields the panel has nowhere to put, so that a launch can say which it dropped. */
export const PANEL_IGNORED_FIELDS: readonly string[] = ['model', 'effort', 'permission mode'];

/**
 * Notes in the log which settings the panel could not carry.
 *
 * The panel takes a session id and a prompt and nothing else, so a button that sets a model for a
 * panel destination is asking for something that cannot happen. It is a log line rather than a
 * notification because the editor already hides those fields for these destinations.
 */
export function logPanelIgnoredFields(buttonName: string, ignored: string[]): void {
    if (ignored.length > 0) {
        logClaude(`Panel launch for "${buttonName}" ignored: ${ignored.join(', ')}. `
            + 'The Claude panel accepts a session and a prompt only.');
    }
}
