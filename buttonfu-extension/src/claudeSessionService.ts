/**
 * Starts Claude Code sessions for `ClaudeCommand` buttons.
 *
 * The button is already token-resolved by the time it arrives. This class turns it into a launch
 * request, finds the Claude executable, and hands the request to whichever destination the button
 * chose. Every argument list is built by `claudeCommandBuilder`, so no prompt text is ever
 * concatenated onto a command line.
 */

import { execFile, spawn, type ChildProcess } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    buildClaudeArgs,
    describeArgsForLog,
    LAUNCHER_DIRECTORY,
    writeLauncherScript,
    type ClaudeRunSpec
} from './claudeCommandBuilder';
import {
    describeMissingClaude,
    findWindowIdeLock,
    resolveClaudeExecutableDetailed,
    type ClaudeExecutableProbes,
    type ClaudeIdeLock,
    type ResolvedClaudeExecutable
} from './claudeExecutable';
import { SHOW_AGENTS_COMMAND } from './claudeAgentsView';
import { logPanelIgnoredFields, openPanel, type OpenPanelOptions } from './claudePanelBridge';
import { DEFAULT_HANDOFF_TIMEOUT_SECONDS, writeHandoffJob } from './claudeHandoff';
import { logClaude } from './claudeOutput';
import { ButtonConfig, DEFAULT_CLAUDE_DESTINATION } from './types';

/** How long to wait for a terminal's shell integration before falling back to `sendText`. */
const SHELL_INTEGRATION_TIMEOUT_MS = 3000;

/** Stands for the launcher path in `buttonfu.claude.externalTerminalCommand`. */
const SCRIPT_PLACEHOLDER = '${script}';

/** Stands for the working directory in `buttonfu.claude.externalTerminalCommand`. */
const CWD_PLACEHOLDER = '${cwd}';

/** A resolved launch, ready to hand to a destination. */
export interface ClaudeLaunchRequest extends ClaudeRunSpec {
    /** The button's name, used in terminal titles and messages. */
    buttonName: string;
    /** The folder a new VS Code window should open. Only meaningful for `newVsCodeWindow`. */
    targetFolder?: string;
    /** Move the Claude panel into its own window. Only meaningful for the panel destinations. */
    newWindow?: boolean;
}

export class ClaudeSessionService {
    /**
     * @param globalStorage Path the queued new-window launches are written into. Without it, that
     *   one destination cannot work; every other destination is unaffected.
     */
    constructor(private readonly globalStorage?: string) {}

    /**
     * Starts a session for the given button, or shows one actionable message and starts nothing.
     */
    public async launch(button: ButtonConfig): Promise<void> {
        let request: ClaudeLaunchRequest;
        try {
            request = this.buildRequest(button);
        } catch (error) {
            void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
            return;
        }

        const executable = this.resolveExecutable();
        if (!executable) {
            void vscode.window.showErrorMessage(describeMissingClaude());
            logClaude(`No Claude executable found for "${request.buttonName}".`);
            return;
        }

        const args = buildClaudeArgs(request);
        logClaude(
            `${request.destination} | ${executable.path} (${executable.source}) | cwd=${request.cwd} | `
            + `session=${request.sessionId} | args: ${describeArgsForLog(args, request.prompt)}`
        );

        try {
            await this.dispatch(request, executable, args);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logClaude(`Launch failed: ${message}`);
            void vscode.window.showErrorMessage(`ButtonFu could not start Claude: ${message}`);
        }
    }

    /**
     * Starts a session from a request that did not come from a button.
     *
     * A queued new-window launch arrives this way: the spec was built in another window, so it
     * skips `buildRequest` and keeps the session id it was minted with.
     */
    public async launchSpec(spec: ClaudeRunSpec, buttonName: string): Promise<void> {
        const request: ClaudeLaunchRequest = { ...spec, buttonName };

        const executable = this.resolveExecutable();
        if (!executable) {
            void vscode.window.showErrorMessage(describeMissingClaude());
            return;
        }

        const args = buildClaudeArgs(request);
        logClaude(
            `${request.destination} (queued) | ${executable.path} | cwd=${request.cwd} | `
            + `session=${request.sessionId} | args: ${describeArgsForLog(args, request.prompt)}`
        );

        try {
            await this.dispatch(request, executable, args);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logClaude(`Queued launch failed: ${message}`);
            void vscode.window.showErrorMessage(`ButtonFu could not start Claude: ${message}`);
        }
    }

    /** Carries an existing session on in a terminal in this window. */
    public async resumeInTerminal(sessionId: string, cwd: string): Promise<void> {
        const executable = this.resolveExecutable();
        if (!executable) {
            void vscode.window.showErrorMessage(describeMissingClaude());
            return;
        }

        const workingDirectory = this.directoryExists(cwd)
            ? cwd
            : (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir());
        const request: ClaudeLaunchRequest = {
            destination: 'terminalHere',
            prompt: '',
            cwd: workingDirectory,
            buttonName: 'resumed session'
        };

        logClaude(`Resuming session ${sessionId} in a terminal.`);
        await this.launchInTerminal(request, executable, ['--resume', sessionId], false);
    }

    /** The resolved Claude executable path, or undefined when there is none. */
    public resolveExecutablePath(): string | undefined {
        return this.resolveExecutable()?.path;
    }

    /** Routes a request to the destination it asked for. */
    protected async dispatch(
        request: ClaudeLaunchRequest,
        executable: ResolvedClaudeExecutable,
        args: string[]
    ): Promise<void> {
        switch (request.destination) {
            case 'terminalHere':
                await this.launchInTerminal(request, executable, args, false);
                break;
            case 'terminalNewWindow':
                await this.launchInTerminal(request, executable, args, true);
                break;
            case 'externalTerminal':
                this.launchInExternalTerminal(request, executable, args);
                break;
            case 'backgroundAgent':
                this.launchBackgroundAgent(request, executable, args);
                break;
            case 'panelPrefill':
                await this.launchPanelPrefill(request);
                break;
            case 'headlessThenPanel':
                await this.launchHeadlessThenPanel(request, executable, args);
                break;
            case 'newVsCodeWindow':
                await this.launchInNewVsCodeWindow(request);
                break;
            default:
                throw new Error(`The "${request.destination}" destination is not built yet.`);
        }
    }

    /** Turns a stored button into a launch request, or throws with a message worth showing. */
    public buildRequest(button: ButtonConfig): ClaudeLaunchRequest {
        const cwd = this.resolveCwd(button);
        if (!this.directoryExists(cwd)) {
            throw new Error(`ButtonFu could not start Claude: the working directory does not exist: ${cwd}`);
        }

        return {
            destination: button.claudeDestination ?? DEFAULT_CLAUDE_DESTINATION,
            prompt: button.executionText ?? '',
            cwd,
            sessionId: crypto.randomUUID(),
            sessionName: (button.claudeSessionName || '').trim() || button.name,
            model: button.claudeModel,
            effort: button.claudeEffort,
            permissionMode: button.claudePermissionMode,
            addDirs: button.claudeAddDirs,
            worktree: button.claudeWorktree,
            worktreeName: button.claudeWorktreeName,
            extraArgs: button.claudeExtraArgs,
            buttonName: button.name,
            targetFolder: (button.claudeTargetFolder || '').trim() || undefined,
            newWindow: button.claudeNewWindow
        };
    }

    /** The working directory: the button's own, else the first workspace folder, else home. */
    private resolveCwd(button: ButtonConfig): string {
        const configured = (button.claudeCwd || '').trim();
        if (configured) {
            return configured;
        }

        const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        return folder || os.homedir();
    }

    /** True when the path is a directory that exists. */
    protected directoryExists(target: string): boolean {
        try {
            return fs.statSync(target).isDirectory();
        } catch {
            return false;
        }
    }

    /** Finds the Claude executable using the real machine as the probe source. */
    protected resolveExecutable(): ResolvedClaudeExecutable | undefined {
        return resolveClaudeExecutableDetailed(this.createProbes());
    }

    /** The production probes: the setting, `PATH`, and the Claude extension's bundled binary. */
    private createProbes(): ClaudeExecutableProbes {
        return {
            settingPath: () => vscode.workspace.getConfiguration('buttonfu').get<string>('claude.executablePath'),
            pathLookup: name => this.findOnPath(name),
            extensionPath: id => vscode.extensions.getExtension(id)?.extensionPath,
            fileExists: target => {
                try {
                    return fs.statSync(target).isFile();
                } catch {
                    return false;
                }
            }
        };
    }

    /** Walks `PATH` for an executable, honouring `PATHEXT` on Windows. */
    private findOnPath(name: string): string | undefined {
        const entries = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
        const extensions = process.platform === 'win32'
            ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
            : [''];

        for (const entry of entries) {
            for (const extension of extensions) {
                const candidate = path.join(entry, name + extension);
                try {
                    if (fs.statSync(candidate).isFile()) {
                        return candidate;
                    }
                } catch {
                    // Not there, or not readable. Try the next one.
                }
            }
        }

        return undefined;
    }

    /** Where the generated launcher scripts are written. */
    protected launcherDirectory(): string {
        return LAUNCHER_DIRECTORY;
    }

    /** The launcher-script flavour this machine's terminals run. */
    protected shellKind(): 'powershell' | 'posix' {
        return process.platform === 'win32' ? 'powershell' : 'posix';
    }

    /** True when `pwsh` is on `PATH`, deciding which host the launcher command names. */
    protected pwshAvailable(): boolean {
        return this.findOnPath('pwsh') !== undefined;
    }

    /**
     * Opens a terminal and runs the launcher in it.
     *
     * `ownWindow` makes it an editor terminal first, because only an editor terminal can be torn
     * off with `moveEditorToNewWindow`; a panel terminal cannot.
     *
     * Neither call passes `env` or `strictEnv`. The Claude Code extension publishes
     * `CLAUDE_CODE_SSE_PORT` through its environment variable collection, which VS Code applies to
     * every terminal in the window whoever created it, and that variable is what makes the session
     * a real VS Code session: diffs open in the editor and Claude can see the selection.
     * `strictEnv` would drop it silently, leaving a session that works but is blind to the editor.
     */
    private async launchInTerminal(
        request: ClaudeLaunchRequest,
        executable: ResolvedClaudeExecutable,
        args: string[],
        ownWindow: boolean
    ): Promise<void> {
        const launcher = writeLauncherScript(
            executable.path, args, request.cwd, this.shellKind(), this.pwshAvailable(),
            this.launcherDirectory());

        const terminal = vscode.window.createTerminal({
            name: `Claude: ${request.buttonName}`,
            cwd: request.cwd,
            isTransient: true,
            iconPath: new vscode.ThemeIcon('sparkle'),
            ...(ownWindow ? { location: { viewColumn: vscode.ViewColumn.One } } : {})
        });
        terminal.show();

        await this.runInTerminal(terminal, launcher.shellCommand);

        if (ownWindow) {
            // After the command, not before: moving first can leave the terminal without shell
            // integration and the fallback then types into a terminal that is no longer here.
            await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
        }
    }

    /**
     * Opens a terminal outside VS Code and runs the launcher in it.
     *
     * The process is detached and unref'd so the window outlives the extension host: reloading VS
     * Code must not take the session with it. The IDE port is passed explicitly, because a process
     * spawned from the extension host does not inherit the window's environment collection, and
     * the window that launched it is still the one its diffs belong in.
     */
    private launchInExternalTerminal(
        request: ClaudeLaunchRequest,
        executable: ResolvedClaudeExecutable,
        args: string[]
    ): void {
        const launcher = writeLauncherScript(
            executable.path, args, request.cwd, this.shellKind(), this.pwshAvailable(),
            this.launcherDirectory());

        const command = this.buildExternalTerminalCommand(launcher.path, request.cwd);
        if (!command) {
            throw new Error(
                'no terminal program could be found. Set "buttonfu.claude.externalTerminalCommand" '
                + 'to the command that opens one on this machine.');
        }

        const env = { ...process.env };
        const lock = this.findIdeLock();
        if (lock) {
            env.CLAUDE_CODE_SSE_PORT = String(lock.port);
        }

        const child = this.spawnDetached(command[0], command.slice(1), request.cwd, env);
        // On Windows a spawn failure arrives asynchronously, and a silent one looks exactly like a
        // button that did nothing at all.
        child.on('error', error => {
            logClaude(`External terminal failed: ${error.message}`);
            void vscode.window.showErrorMessage(`ButtonFu could not open a terminal: ${error.message}`);
        });
    }

    /**
     * Chooses the argument list that opens a terminal window, or undefined when nothing here can.
     *
     * The setting is an array of argv entries rather than a command line, with the launcher path
     * and the working directory substituted into it. `-NoExit` is what keeps the window open after
     * the session ends, so the transcript is still there to read.
     */
    protected buildExternalTerminalCommand(scriptPath: string, cwd: string): string[] | undefined {
        const configured = vscode.workspace.getConfiguration('buttonfu')
            .get<string[]>('claude.externalTerminalCommand');
        if (Array.isArray(configured) && configured.length > 0) {
            return configured.map(entry => String(entry)
                .split(SCRIPT_PLACEHOLDER).join(scriptPath)
                .split(CWD_PLACEHOLDER).join(cwd));
        }

        const platform = process.platform;
        if (platform === 'win32') {
            const host = this.pwshAvailable() ? 'pwsh' : 'powershell';
            const hostArgs = [host, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-File', scriptPath];
            return this.commandExists('wt.exe')
                ? ['wt.exe', '-d', cwd, ...hostArgs]
                : ['cmd.exe', '/c', 'start', 'Claude', ...hostArgs];
        }

        if (platform === 'darwin') {
            return ['open', '-a', 'Terminal', scriptPath];
        }

        if (this.commandExists('x-terminal-emulator')) {
            return ['x-terminal-emulator', '-e', 'sh', scriptPath];
        }

        return undefined;
    }

    /**
     * Starts a background agent and returns straight away.
     *
     * No launcher script and no shell: `spawn` takes the argument list directly, which is the
     * plainest form of the rule that a prompt never touches a command line. The IDE port is
     * deliberately not passed, because the agent is meant to outlive the window that started it,
     * and a port that dies with that window is worse than no connection at all.
     */
    private launchBackgroundAgent(
        request: ClaudeLaunchRequest,
        executable: ResolvedClaudeExecutable,
        args: string[]
    ): void {
        const child = this.spawnDetached(executable.path, args, request.cwd, { ...process.env }, 'pipe');

        let stderr = '';
        child.stdout?.on('data', (chunk: Buffer) => logClaude(`agent out: ${chunk.toString().trimEnd()}`));
        child.stderr?.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
            logClaude(`agent err: ${chunk.toString().trimEnd()}`);
        });
        child.on('error', error => {
            logClaude(`Background agent failed: ${error.message}`);
            void vscode.window.showErrorMessage(`ButtonFu could not start a background agent: ${error.message}`);
        });
        child.on('exit', code => {
            if (code !== null && code !== 0) {
                const detail = stderr.trim() || `exit code ${code}`;
                logClaude(`Background agent exited early: ${detail}`);
                void vscode.window.showErrorMessage(`Claude's background agent stopped: ${detail}`);
            }
        });

        void vscode.window.showInformationMessage('Claude is running in the background.', 'Show agents')
            .then(choice => {
                if (choice === 'Show agents') {
                    void vscode.commands.executeCommand(SHOW_AGENTS_COMMAND);
                }
            });
    }

    /**
     * Opens a new VS Code window on another folder and leaves a job for it to pick up.
     *
     * Nothing here can reach into the new window: it is a separate extension host, and no `code`
     * flag runs a command in the window it opens. The job file in global storage is the whole
     * mechanism, and the new window claims it on startup.
     */
    private async launchInNewVsCodeWindow(request: ClaudeLaunchRequest): Promise<void> {
        const folder = request.targetFolder;
        if (!folder) {
            throw new Error('this button opens a new VS Code window, so it needs a folder to open. '
                + 'Set "Folder To Open" on the button.');
        }
        if (!this.directoryExists(folder)) {
            throw new Error(`the folder to open does not exist: ${folder}`);
        }
        if (!this.globalStorage) {
            throw new Error('ButtonFu has no storage to queue the launch in.');
        }

        const timeoutSeconds = vscode.workspace.getConfiguration('buttonfu')
            .get<number>('claude.handoffTimeoutSeconds') ?? DEFAULT_HANDOFF_TIMEOUT_SECONDS;
        const job = writeHandoffJob(this.globalStorage, folder, request.buttonName, request, timeoutSeconds);
        logClaude(`Queued job ${job.id} for a new window on ${job.targetFolder}.`);

        // forceNewWindow even when the folder is already open somewhere: the button means
        // "give me another one".
        await vscode.commands.executeCommand(
            'vscode.openFolder', vscode.Uri.file(folder), { forceNewWindow: true });
    }

    /**
     * Opens the Claude panel with the prompt typed into it, and says that it stopped there.
     *
     * The prompt reaches the panel's webview as its initial text and the webview types it into the
     * box. There is no auto-submit anywhere in that extension, no message that sends, and no way
     * for another extension to press Enter inside a webview. Someone who expects the button to run
     * the prompt will read the silence as a broken button, so the notification says it plainly.
     */
    private async launchPanelPrefill(request: ClaudeLaunchRequest): Promise<void> {
        logPanelIgnoredFields(request.buttonName, this.panelIgnoredFields(request));

        const opened = await this.openPanel({
            sessionId: request.sessionId,
            prompt: request.prompt,
            newWindow: request.newWindow
        });
        if (!opened) {
            await this.offerTerminalInstead(request);
            return;
        }

        void vscode.window.showInformationMessage('Prompt is ready in the Claude panel. Press Enter to send it.');
    }

    /**
     * Runs the whole prompt with no interface, then opens the finished conversation.
     *
     * The session id ButtonFu minted is the one the run is written under, which is what lets the
     * panel pick the same conversation up afterwards.
     */
    private async launchHeadlessThenPanel(
        request: ClaudeLaunchRequest,
        executable: ResolvedClaudeExecutable,
        args: string[]
    ): Promise<void> {
        const result = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Claude: ${request.buttonName}`,
                cancellable: true
            },
            (progress, token) => this.runHeadless(executable.path, args, request.cwd, progress, token));

        if (result.cancelled) {
            void vscode.window.showInformationMessage('The Claude run was cancelled.');
            return;
        }

        if (result.code !== 0) {
            const lastLine = result.stderr.trim().split('\n').pop() || `exit code ${result.code}`;
            logClaude(`Headless run failed (${result.code}): ${result.stderr.trim()}`);
            void vscode.window.showErrorMessage(`Claude stopped: ${lastLine}`);
            return;
        }

        logClaude(`Headless run finished for session ${request.sessionId}.`);
        const opened = await this.openPanel({ sessionId: request.sessionId, newWindow: request.newWindow });
        if (!opened) {
            await this.offerTerminalInstead(request);
            return;
        }

        const OPEN_IN_PANEL = 'Open in panel';
        const COPY_RESUME = 'Copy resume command';
        void vscode.window
            .showInformationMessage(`Claude finished "${request.buttonName}".`, OPEN_IN_PANEL, COPY_RESUME)
            .then(async choice => {
                if (choice === OPEN_IN_PANEL) {
                    await this.openPanel({ sessionId: request.sessionId, newWindow: request.newWindow });
                } else if (choice === COPY_RESUME) {
                    await vscode.env.clipboard.writeText(`claude --resume ${request.sessionId}`);
                }
            });
    }

    /** Runs the CLI to completion, reporting elapsed time so a long run does not look hung. */
    protected runHeadless(
        exe: string,
        args: string[],
        cwd: string,
        progress: vscode.Progress<{ message?: string }>,
        token: vscode.CancellationToken
    ): Promise<{ code: number; stderr: string; cancelled: boolean }> {
        return new Promise(resolve => {
            const child = execFile(exe, args, { cwd, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
            const started = Date.now();
            let stderr = '';
            let cancelled = false;

            const ticker = setInterval(
                () => progress.report({ message: `${Math.round((Date.now() - started) / 1000)}s` }), 1000);

            const cancellation = token.onCancellationRequested(() => {
                cancelled = true;
                child.kill();
            });

            child.stdout?.on('data', (chunk: string) => logClaude(`headless out: ${String(chunk).trimEnd()}`));
            child.stderr?.on('data', (chunk: string) => { stderr += String(chunk); });

            const finish = (code: number): void => {
                clearInterval(ticker);
                cancellation.dispose();
                resolve({ code, stderr, cancelled });
            };

            child.on('error', error => {
                stderr += error.message;
                finish(-1);
            });
            child.on('close', code => finish(code ?? -1));
        });
    }

    /** Which of the button's settings the Claude panel has nowhere to put. */
    private panelIgnoredFields(request: ClaudeLaunchRequest): string[] {
        const ignored: string[] = [];
        if (request.model?.trim()) { ignored.push('model'); }
        if (request.effort?.trim()) { ignored.push('effort'); }
        if (request.permissionMode?.trim()) { ignored.push('permission mode'); }
        return ignored;
    }

    /** Opens the Claude panel. Split out so tests do not need the other extension installed. */
    protected openPanel(options: OpenPanelOptions): Promise<boolean> {
        return openPanel(options);
    }

    /** The Claude Code extension is not installed, so offer the one thing that still works. */
    private async offerTerminalInstead(request: ClaudeLaunchRequest): Promise<void> {
        const OPEN_TERMINAL = 'Open a terminal instead';
        const choice = await vscode.window.showWarningMessage(
            'The Claude Code extension is not installed, so its panel cannot be opened.', OPEN_TERMINAL);

        if (choice !== OPEN_TERMINAL) {
            return;
        }

        const executable = this.resolveExecutable();
        if (!executable) {
            void vscode.window.showErrorMessage(describeMissingClaude());
            return;
        }

        const terminalRequest: ClaudeLaunchRequest = { ...request, destination: 'terminalHere' };
        await this.launchInTerminal(terminalRequest, executable, buildClaudeArgs(terminalRequest), false);
    }

    /** Starts a process that outlives this extension host. */
    protected spawnDetached(
        exe: string,
        args: string[],
        cwd: string,
        env: NodeJS.ProcessEnv,
        stdio: 'ignore' | 'pipe' = 'ignore'
    ): ChildProcess {
        const child = spawn(exe, args, { cwd, env, detached: true, stdio, windowsHide: false });
        child.unref();
        return child;
    }

    /** This window's Claude IDE server, when the Claude Code extension is running. */
    protected findIdeLock(): ClaudeIdeLock | undefined {
        return findWindowIdeLock();
    }

    /** True when a bare command name resolves on `PATH`. */
    protected commandExists(name: string): boolean {
        return this.findOnPath(name) !== undefined;
    }

    /**
     * Sends one command to a terminal, preferring shell integration.
     *
     * `sendText` on a shell that has not finished starting loses the first characters, which shows
     * up as a mangled path and no session. Waiting for shell integration avoids that; the timeout
     * is there because some shells never report it at all.
     */
    protected runInTerminal(terminal: vscode.Terminal, command: string): Promise<void> {
        return new Promise<void>(resolve => {
            let settled = false;
            let subscription: vscode.Disposable | undefined;
            let timer: NodeJS.Timeout | undefined;

            const settle = (useShellIntegration: boolean): void => {
                if (settled) {
                    return;
                }
                settled = true;
                subscription?.dispose();
                if (timer) {
                    clearTimeout(timer);
                }

                const integration = useShellIntegration ? terminal.shellIntegration : undefined;
                if (integration) {
                    integration.executeCommand(command);
                } else {
                    terminal.sendText(command);
                }
                resolve();
            };

            if (terminal.shellIntegration) {
                settle(true);
                return;
            }

            subscription = vscode.window.onDidChangeTerminalShellIntegration?.(event => {
                if (event.terminal === terminal) {
                    settle(true);
                }
            });

            timer = setTimeout(() => settle(false), SHELL_INTEGRATION_TIMEOUT_MS);
        });
    }
}
