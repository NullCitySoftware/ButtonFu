/**
 * The "Claude: Show Background Agents" quick pick.
 *
 * `claude agents --json` lists background sessions without needing a terminal, which is why it is
 * used here rather than scraping the interactive agents view. Every failure gets its own one-line
 * message: this runs from a notification action and must never throw back into one.
 */

import { execFile } from 'child_process';
import * as os from 'os';
import * as vscode from 'vscode';
import { describeMissingClaude } from './claudeExecutable';
import { logClaude } from './claudeOutput';
import { openPanel } from './claudePanelBridge';

/** The command id the notification action and the palette both use. */
export const SHOW_AGENTS_COMMAND = 'buttonfu.claude.showAgents';

/** The action that carries a background session on in a terminal in this window. */
export const RESUME_IN_TERMINAL = 'Resume in a terminal';

/** The action that carries a background session on in Claude's own panel. */
export const OPEN_IN_PANEL = 'Open in the Claude panel';

/** One background session as `claude agents --json` reports it. */
export interface ClaudeAgentSummary {
    sessionId: string;
    name: string;
    state: string;
    cwd: string;
    /** When the session started, as an ISO string, when the CLI reports one. */
    startedAt?: string;
    /** The opening prompt, used as a label when the session has no name. */
    prompt?: string;
}

/** What the quick pick needs from the outside world, injected so it can be tested. */
export interface ClaudeAgentsHost {
    /** Resolves the Claude executable, or undefined when there is none. */
    resolveExecutable(): string | undefined;
    /** The directory to list agents for. */
    cwd(): string;
    /** Runs the CLI and returns its stdout. */
    run(exe: string, args: string[], cwd: string): Promise<string>;
    /** Resumes a session in a terminal in this window. */
    resumeInTerminal(agent: ClaudeAgentSummary): Promise<void>;
}

/** Turns whatever the CLI printed into a list this view can render. */
export function parseAgents(stdout: string): ClaudeAgentSummary[] {
    const trimmed = (stdout || '').trim();
    if (!trimmed) {
        return [];
    }

    const parsed = JSON.parse(trimmed) as unknown;
    const rows = Array.isArray(parsed)
        ? parsed
        : (parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).agents)
            ? (parsed as Record<string, unknown>).agents as unknown[]
            : []);

    return rows
        .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
        .map(row => ({
            sessionId: String(row.sessionId ?? row.session_id ?? row.id ?? ''),
            name: String(row.name ?? ''),
            state: String(row.state ?? row.status ?? 'unknown'),
            cwd: String(row.cwd ?? row.workingDirectory ?? ''),
            startedAt: typeof row.startedAt === 'string' ? row.startedAt : undefined,
            prompt: typeof row.prompt === 'string' ? row.prompt : undefined
        }))
        .filter(agent => agent.sessionId.length > 0);
}

/** The label for one row: its name, else its opening line, else the session id. */
export function describeAgent(agent: ClaudeAgentSummary): string {
    const name = agent.name.trim();
    if (name) {
        return name;
    }

    const firstLine = (agent.prompt || '').split('\n')[0].trim();
    return firstLine || agent.sessionId;
}

/** How long ago the session started, in words. Empty when the CLI reported no time. */
export function describeAge(agent: ClaudeAgentSummary, now: number = Date.now()): string {
    if (!agent.startedAt) {
        return '';
    }

    const started = Date.parse(agent.startedAt);
    if (Number.isNaN(started)) {
        return '';
    }

    const minutes = Math.max(0, Math.round((now - started) / 60000));
    if (minutes < 1) {
        return 'just now';
    }
    if (minutes < 60) {
        return `${minutes} min ago`;
    }

    const hours = Math.round(minutes / 60);
    return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

/** Builds the quick-pick rows for a list of agents. */
export function buildAgentItems(agents: ClaudeAgentSummary[], now: number = Date.now()): Array<vscode.QuickPickItem & { agent: ClaudeAgentSummary }> {
    return agents.map(agent => {
        const age = describeAge(agent, now);
        return {
            label: describeAgent(agent),
            description: age ? `${agent.state} · ${age}` : agent.state,
            detail: agent.cwd,
            agent
        };
    });
}

/** Shows the background agents, and offers what can be done with the one that is picked. */
export async function showBackgroundAgents(host: ClaudeAgentsHost): Promise<void> {
    const exe = host.resolveExecutable();
    if (!exe) {
        void vscode.window.showErrorMessage(describeMissingClaude());
        return;
    }

    const cwd = host.cwd();
    let agents: ClaudeAgentSummary[];
    try {
        agents = parseAgents(await host.run(exe, ['agents', '--json'], cwd));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logClaude(`Listing background agents failed: ${message}`);
        void vscode.window.showErrorMessage(`ButtonFu could not list Claude's background agents: ${message}`);
        return;
    }

    if (agents.length === 0) {
        void vscode.window.showInformationMessage('No Claude background agents are running.');
        return;
    }

    const picked = await vscode.window.showQuickPick(buildAgentItems(agents), {
        title: 'Claude background agents',
        placeHolder: 'Pick a session'
    });
    if (!picked) {
        return;
    }

    const actions: vscode.QuickPickItem[] = [
        { label: RESUME_IN_TERMINAL, description: 'Carry on the conversation in a terminal in this window' },
        { label: OPEN_IN_PANEL, description: 'Carry on the conversation in the Claude panel' }
    ];
    const action = await vscode.window.showQuickPick(actions, {
        title: describeAgent(picked.agent),
        placeHolder: 'What would you like to do with it?'
    });

    if (action?.label === RESUME_IN_TERMINAL) {
        await host.resumeInTerminal(picked.agent);
    } else if (action?.label === OPEN_IN_PANEL) {
        if (!await openPanel({ sessionId: picked.agent.sessionId })) {
            void vscode.window.showWarningMessage(
                'The Claude Code extension is not installed, so its panel cannot be opened.');
        }
    }
}

/** Runs the CLI without a shell, so nothing in an argument is ever re-parsed. */
export function runClaudeCli(exe: string, args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(exe, args, { cwd, windowsHide: true }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error((stderr || '').trim() || error.message));
                return;
            }
            resolve(stdout);
        });
    });
}

/**
 * Registers the show-agents command.
 *
 * Called from `extension.ts`, which is where every other ButtonFu command is registered.
 */
export function registerClaudeAgentsCommand(
    context: vscode.ExtensionContext,
    host: () => ClaudeAgentsHost
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand(SHOW_AGENTS_COMMAND, () => showBackgroundAgents(host()))
    );
}

/** The working directory the agents list is taken from. */
export function defaultAgentsCwd(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
}
