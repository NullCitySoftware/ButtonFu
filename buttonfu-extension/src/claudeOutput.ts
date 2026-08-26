/**
 * The "ButtonFu Claude" output channel, created on first use.
 *
 * Every Claude launch writes one line here: the destination, the resolved executable, the working
 * directory, the full argument list with the prompt reduced to a character count, and the session
 * id. Prompt text is never logged, because a prompt can contain anything the user typed.
 */

import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

/** Gets the shared output channel, creating it on first use. */
export function getClaudeOutputChannel(): vscode.OutputChannel {
    if (!channel) {
        channel = vscode.window.createOutputChannel('ButtonFu Claude');
    }
    return channel;
}

/** Writes one timestamped line to the channel. */
export function logClaude(message: string): void {
    getClaudeOutputChannel().appendLine(`[${new Date().toISOString()}] ${message}`);
}

/** Disposes the channel, if one was ever created. */
export function disposeClaudeOutputChannel(): void {
    channel?.dispose();
    channel = undefined;
}
