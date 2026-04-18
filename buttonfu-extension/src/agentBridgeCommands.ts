import * as fs from 'fs';
import * as net from 'net';
import * as vscode from 'vscode';
import { AUTOMATION_GUIDANCE } from './apiSchema';
import { getBridgeDirectory, getBridgeFilePath, listBridgeFiles, STALE_BRIDGE_AGE_MS } from './agentBridge';
const COPY_INSTRUCTIONS_COMMAND = 'buttonfu.copyAgentBridgeInstructions';
const BRIDGE_STATUS_COMMAND = 'buttonfu.agentBridgeStatus';
const BRIDGE_DOCTOR_COMMAND = 'buttonfu.agentBridgeDoctor';
const COPY_QUICK_START_COMMAND = 'buttonfu.agentBridgeCopyQuickStart';
const BRIDGE_SELF_TEST_COMMAND = 'buttonfu.agentBridgeSelfTest';
const BRIDGE_CONTEXT_COMMAND = 'buttonfu.agentBridgeShowContext';

type BridgeSummary = ReturnType<typeof listBridgeFiles>[number];

function formatIsoAge(ms: number): string {
    if (ms < 0) {
        return 'in the future';
    }

    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) {
        return `${seconds}s ago`;
    }

    const minutes = Math.floor(seconds / 60);
    const remSeconds = seconds % 60;
    return `${minutes}m ${remSeconds}s ago`;
}

function getCurrentBridge(bridges: BridgeSummary[]): BridgeSummary | undefined {
    return bridges.find((bridge) => bridge.vscodePid === process.pid);
}

function getWorkspacePathMatches(bridges: BridgeSummary[], currentBridge: BridgeSummary | undefined): BridgeSummary[] {
    const workspaceFolders = currentBridge?.workspaceFolders ?? [];
    if (workspaceFolders.length === 0) {
        return [];
    }

    const normalizedTargets = workspaceFolders.map((folder) => folder.toLowerCase());
    return bridges.filter((bridge) => (bridge.workspaceFolders ?? []).some((folder) => normalizedTargets.includes(folder.toLowerCase())));
}

function buildBridgeSelfTestChecks(bridgeEnabled: boolean, bridgeRunning: boolean, bridges: BridgeSummary[], currentBridge: BridgeSummary | undefined): Array<{ name: string; ok: boolean; detail: string }> {
    const workspaceMatches = getWorkspacePathMatches(bridges, currentBridge);
    const checks: Array<{ name: string; ok: boolean; detail: string }> = [
        {
            name: 'Setting buttonfu.enableAgentBridge',
            ok: bridgeEnabled,
            detail: bridgeEnabled ? 'enabled' : 'disabled'
        },
        {
            name: 'Bridge runtime active',
            ok: bridgeRunning,
            detail: bridgeRunning ? 'running' : 'not running'
        },
        {
            name: 'Current-window bridge discovered',
            ok: !!currentBridge,
            detail: currentBridge
                ? `windowId=${currentBridge.windowId} file=${getBridgeFilePath(currentBridge.pid)}`
                : 'no bridge file for this VS Code window'
        }
    ];

    if (currentBridge) {
        checks.push({
            name: 'Workspace path selector resolves uniquely',
            ok: workspaceMatches.length === 1,
            detail: workspaceMatches.length === 0
                ? 'no live bridge matched this workspace path'
                : workspaceMatches.length === 1
                    ? currentBridge.workspaceFolders[0] || '(none)'
                    : `${workspaceMatches.length} live bridges share this workspace path; prefer bridge file or targetWindowId`
        });

        checks.push({
            name: 'Window-targeted mutations available',
            ok: !!currentBridge.windowId,
            detail: currentBridge.windowId
                ? `use targetWindowId=${currentBridge.windowId}`
                : 'windowId missing from bridge metadata'
        });
    }

    return checks;
}

function buildBridgeSelfTestText(bridgeEnabled: boolean, bridgeRunning: boolean, bridges: BridgeSummary[], currentBridge: BridgeSummary | undefined): string {
    const checks = buildBridgeSelfTestChecks(bridgeEnabled, bridgeRunning, bridges, currentBridge);
    const failing = checks.filter((check) => !check.ok);
    const lines = [
        '# ButtonFu Agent Bridge Self-Test',
        '',
        `Overall: ${failing.length === 0 ? 'PASS' : 'FAIL'} (${checks.length - failing.length}/${checks.length} checks passed)`,
        ''
    ];

    for (const check of checks) {
        lines.push(`- ${check.ok ? 'PASS' : 'FAIL'}: ${check.name} — ${check.detail}`);
    }

    if (currentBridge) {
        lines.push(
            '',
            'Recommended selectors for this window:',
            `- bridge file: ${getBridgeFilePath(currentBridge.pid)}`,
            `- targetWindowId: ${currentBridge.windowId}`,
            `- workspace path: ${currentBridge.workspaceFolders[0] || '(none)'}`
        );
    }

    if (failing.length > 0) {
        lines.push(
            '',
            'Suggested fixes:',
            '- Enable buttonfu.enableAgentBridge in settings.',
            '- Confirm the current VS Code window is the one you intend to automate.',
            '- Prefer bridge file or targetWindowId when multiple windows are open.'
        );
    }

    return lines.join('\n');
}

function buildBridgeContextLines(currentBridge: BridgeSummary | undefined): string[] {
    if (!currentBridge) {
        return [
            'No bridge file for this VS Code window was found.'
        ];
    }

    const heartbeatText = currentBridge.lastHeartbeatAt
        ? `${currentBridge.lastHeartbeatAt} (${formatIsoAge(Date.now() - Date.parse(currentBridge.lastHeartbeatAt))})`
        : 'unknown';

    return [
        `Window ID: ${currentBridge.windowId}`,
        `PID: ${currentBridge.pid}`,
        `Bridge file: ${getBridgeFilePath(currentBridge.pid)}`,
        `Pipe: ${currentBridge.pipeName}`,
        `Workspace: ${currentBridge.workspaceName || '(none)'}`,
        `Workspace folders: ${currentBridge.workspaceFolders.length > 0 ? currentBridge.workspaceFolders.join(', ') : '(none)'}`,
        `Last heartbeat: ${heartbeatText}`
    ];
}

function buildBridgeContextText(bridges: BridgeSummary[], currentBridge: BridgeSummary | undefined): string {
    const lines: string[] = [
        '# ButtonFu Agent Bridge Context',
        '',
        `Active bridges discovered: ${bridges.length}`,
        ...buildBridgeContextLines(currentBridge)
    ];

    if (currentBridge && currentBridge.workspaceFolders.length === 0) {
        lines.push(
            '',
            '⚠️  This window has no workspace folders attached.',
            'Local ButtonFu buttons/notes in this window are isolated to this profile/window and may differ from your project workspace window.',
            'Use `ButtonFu: Agent Bridge Self-Test` and prefer `targetWindowId` or `-WorkspacePath` selectors before local mutations.'
        );
    }

    return lines.join('\n');
}

function buildQuickStartText(bridgeEnabled: boolean, currentBridge: BridgeSummary | undefined): string {
    const lines: string[] = [
        '# ButtonFu Agent Bridge Quick Start',
        '',
        `Bridge enabled: ${bridgeEnabled}`,
    ];

    if (!currentBridge) {
        lines.push(
            '',
            'No live bridge was found for this VS Code window.',
            'Enable `buttonfu.enableAgentBridge`, then run `ButtonFu: Agent Bridge Status`.'
        );
        return lines.join('\n');
    }

    lines.push(
        `Window ID: ${currentBridge.windowId}`,
        `Bridge file: ${getBridgeFilePath(currentBridge.pid)}`,
        `Pipe: ${currentBridge.pipeName}`,
        '',
            'Run `ButtonFu: Agent Bridge Self-Test` if you need to confirm this is the correct target window before mutating ButtonFu data.',
            '',
        '## Preferred helper (multi-window safe)',
        '```powershell',
        `.\\scripts\\buttonfu-bridge.ps1 -WorkspacePath "${(currentBridge.workspaceFolders[0] || '').replace(/"/g, '""')}" -Method listButtons`,
        '```',
        '',
            '## Preferred helper (create task button without raw JSON)',
            '```powershell',
            `.\\scripts\\buttonfu-bridge.ps1 -WorkspacePath "${(currentBridge.workspaceFolders[0] || '').replace(/"/g, '""')}" -Method createButton -Name "Run Tests" -Locality Local -Type TaskExecution -ExecutionText "npm: npm: compile - buttonfu-extension" -Category Build -Icon tools`,
            '```',
            '',
        '## PowerShell example (describe)',
        '```powershell',
        '$bridgePath = Join-Path $HOME ".buttonfu" "bridge-' + currentBridge.pid + '.json"',
        '$bridge = Get-Content $bridgePath -Raw | ConvertFrom-Json',
        '$body = @{',
        '    jsonrpc = "2.0"; id = 1',
        '    method  = "buttonfu.api.describe"',
        '    auth    = $bridge.authToken',
        '} | ConvertTo-Json -Depth 20 -Compress',
        '$pipe = New-Object System.IO.Pipes.NamedPipeClientStream(".", $bridge.pipeName.Replace("\\\\.\\pipe\\",""), "InOut")',
        '$pipe.Connect(5000)',
        '$writer = New-Object System.IO.StreamWriter($pipe)',
        '$reader = New-Object System.IO.StreamReader($pipe)',
        '$writer.WriteLine($body)',
        '$writer.Flush()',
        '$response = $reader.ReadLine()',
        '$pipe.Dispose()',
        '$response | ConvertFrom-Json | ConvertTo-Json -Depth 20',
        '```',
        '',
        '## PowerShell example (targeted createButton)',
        '```powershell',
        '$bridgePath = Join-Path $HOME ".buttonfu" "bridge-' + currentBridge.pid + '.json"',
        '$bridge = Get-Content $bridgePath -Raw | ConvertFrom-Json',
        '$body = @{',
        '    jsonrpc = "2.0"; id = 2',
        '    method  = "buttonfu.api.createButton"',
        '    auth    = $bridge.authToken',
        '    params  = @{',
        '        targetWindowId = "' + currentBridge.windowId + '"',
        '        name = "Example Button"',
        '        locality = "Global"',
        '        type = "TerminalCommand"',
        '        executionText = "echo hello"',
        '    }',
        '} | ConvertTo-Json -Depth 20 -Compress',
        '$pipe = New-Object System.IO.Pipes.NamedPipeClientStream(".", $bridge.pipeName.Replace("\\\\.\\pipe\\",""), "InOut")',
        '$pipe.Connect(5000)',
        '$writer = New-Object System.IO.StreamWriter($pipe)',
        '$reader = New-Object System.IO.StreamReader($pipe)',
        '$writer.WriteLine($body)',
        '$writer.Flush()',
        '$response = $reader.ReadLine()',
        '$pipe.Dispose()',
        '$response | ConvertFrom-Json | ConvertTo-Json -Depth 20',
        '```'
    );

    return lines.join('\n');
}

async function probePipe(pipeName: string, timeoutMs: number): Promise<{ ok: boolean; detail: string }> {
    return new Promise((resolve) => {
        const started = Date.now();
        let finished = false;

        const socket = net.createConnection(pipeName);

        const finish = (ok: boolean, detail: string): void => {
            if (finished) {
                return;
            }
            finished = true;
            socket.destroy();
            resolve({ ok, detail });
        };

        socket.setTimeout(timeoutMs);

        socket.once('connect', () => {
            const elapsed = Date.now() - started;
            finish(true, `connect ok (${elapsed}ms)`);
        });

        socket.once('timeout', () => {
            finish(false, `connect timed out after ${timeoutMs}ms`);
        });

        socket.once('error', (error) => {
            const message = error instanceof Error ? error.message : String(error);
            finish(false, `connect error: ${message}`);
        });
    });
}

export function registerAgentBridgeCommands(context: vscode.ExtensionContext, getBridgeRunning: () => boolean): void {
    context.subscriptions.push(
        vscode.commands.registerCommand(COPY_INSTRUCTIONS_COMMAND, async () => {
            const bridgeEnabled = vscode.workspace.getConfiguration('buttonfu').get<boolean>('enableAgentBridge', false);
            const bridges = listBridgeFiles();
            const bridgeDirectory = getBridgeDirectory();
            const currentBridge = getCurrentBridge(bridges);

            const lines: string[] = [
                '# ButtonFu Agent Bridge — Automation Instructions',
                '',
                '## Rule: use the bridge, never edit storage directly',
                '',
                ...AUTOMATION_GUIDANCE.automationWarnings.map((warning) => `⚠️  ${warning}`),
                '',
                '## Preferred automation surface',
                '',
                AUTOMATION_GUIDANCE.preferredAutomationSurface,
                '',
                '## Supported mutation surface',
                '',
                AUTOMATION_GUIDANCE.supportedMutationSurface,
                '',
                '## Unsupported mutation targets (DO NOT USE)',
                '',
                ...AUTOMATION_GUIDANCE.unsupportedAutomationMutationSurfaces.map((surface) => `- ${surface}`),
                '',
                '## Bridge status',
                '',
                `Enabled: ${bridgeEnabled}`,
                `Bridge runtime running: ${getBridgeRunning()}`,
                `Bridge discovery directory: ${bridgeDirectory}`,
                `Active bridges found: ${bridges.length}`,
                ...buildBridgeContextLines(currentBridge)
            ];

            if (currentBridge) {
                lines.push(
                    '',
                    '## Ready-to-use example (PowerShell)',
                    '',
                    '```powershell',
                    '$bridgeDir = Join-Path $HOME ".buttonfu"',
                    `$bridgePath = Join-Path $bridgeDir "bridge-${currentBridge.pid}.json"`,
                    '$bridge = Get-Content $bridgePath -Raw | ConvertFrom-Json',
                    '$body = @{',
                    '    jsonrpc = "2.0"; id = 1',
                    '    method  = "buttonfu.api.listButtons"',
                    '    auth    = $bridge.authToken',
                    '} | ConvertTo-Json -Depth 20 -Compress',
                    '',
                    '# Connect to the named pipe and send the request',
                    '$pipe = New-Object System.IO.Pipes.NamedPipeClientStream(".", $bridge.pipeName.Replace("\\\\.\\pipe\\",""), "InOut")',
                    '$pipe.Connect(5000)',
                    '$writer = New-Object System.IO.StreamWriter($pipe)',
                    '$reader = New-Object System.IO.StreamReader($pipe)',
                    '$writer.WriteLine($body)',
                    '$writer.Flush()',
                    '$response = $reader.ReadLine()',
                    '$pipe.Dispose()',
                    '$response | ConvertFrom-Json | ConvertTo-Json -Depth 10',
                    '```'
                );
            }

            if (!currentBridge && !bridgeEnabled) {
                lines.push(
                    '',
                    '## How to enable',
                    '',
                    'Set `buttonfu.enableAgentBridge` to `true` in VS Code settings.',
                    'Then run `ButtonFu: Agent Bridge Status` to confirm this window has an active bridge.'
                );
            }

            const text = lines.join('\n');
            await vscode.env.clipboard.writeText(text);
            void vscode.window.showInformationMessage('ButtonFu Agent Bridge instructions copied to clipboard.');
            return text;
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(BRIDGE_STATUS_COMMAND, async () => {
            const bridgeEnabled = vscode.workspace.getConfiguration('buttonfu').get<boolean>('enableAgentBridge', false);
            const bridges = listBridgeFiles();
            const currentBridge = getCurrentBridge(bridges);
            const bridgeDirectory = getBridgeDirectory();

            const lines = [
                '# ButtonFu Agent Bridge Status',
                '',
                `Enabled setting: ${bridgeEnabled}`,
                `Runtime running: ${getBridgeRunning()}`,
                `Bridge directory: ${bridgeDirectory}`,
                `Active bridges discovered: ${bridges.length}`,
                ...buildBridgeContextLines(currentBridge),
                '',
                'Next commands:',
                '- ButtonFu: Agent Bridge Doctor',
                '- ButtonFu: Agent Bridge Self-Test',
                '- ButtonFu: Copy Agent Bridge Quick Start',
                '- ButtonFu: Copy Agent Bridge Instructions'
            ];

            const text = lines.join('\n');
            await vscode.env.clipboard.writeText(text);
            void vscode.window.showInformationMessage('ButtonFu Agent Bridge status copied to clipboard.');
            return text;
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(BRIDGE_DOCTOR_COMMAND, async () => {
            const bridgeEnabled = vscode.workspace.getConfiguration('buttonfu').get<boolean>('enableAgentBridge', false);
            const bridges = listBridgeFiles();
            const currentBridge = getCurrentBridge(bridges);
            const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

            checks.push({
                name: 'Setting buttonfu.enableAgentBridge',
                ok: bridgeEnabled,
                detail: bridgeEnabled ? 'enabled' : 'disabled'
            });

            checks.push({
                name: 'Bridge runtime active',
                ok: getBridgeRunning(),
                detail: getBridgeRunning() ? 'running' : 'not running'
            });

            const bridgeDir = getBridgeDirectory();
            checks.push({
                name: 'Bridge directory exists',
                ok: fs.existsSync(bridgeDir),
                detail: bridgeDir
            });

            checks.push({
                name: 'Current-window bridge discovered',
                ok: !!currentBridge,
                detail: currentBridge ? `${currentBridge.windowId} (pid ${currentBridge.pid})` : 'no bridge file for this window'
            });

            if (currentBridge) {
                const hasHeartbeat = !!currentBridge.lastHeartbeatAt;
                const heartbeatMs = hasHeartbeat
                    ? Date.now() - Date.parse(currentBridge.lastHeartbeatAt)
                    : Number.NaN;
                checks.push({
                    name: 'Heartbeat freshness',
                    ok: Number.isFinite(heartbeatMs) && heartbeatMs <= STALE_BRIDGE_AGE_MS,
                    detail: hasHeartbeat
                        ? `${currentBridge.lastHeartbeatAt} (${formatIsoAge(heartbeatMs)})`
                        : 'missing from bridge metadata'
                });

                const probe = await probePipe(currentBridge.pipeName, 2000);
                checks.push({
                    name: 'Named-pipe connectivity',
                    ok: probe.ok,
                    detail: probe.detail
                });
            }

            const failing = checks.filter((check) => !check.ok);
            const lines = [
                '# ButtonFu Agent Bridge Doctor',
                '',
                `Overall: ${failing.length === 0 ? 'PASS' : 'FAIL'} (${checks.length - failing.length}/${checks.length} checks passed)`,
                ''
            ];

            for (const check of checks) {
                lines.push(`- ${check.ok ? 'PASS' : 'FAIL'}: ${check.name} — ${check.detail}`);
            }

            if (failing.length > 0) {
                lines.push(
                    '',
                    'Suggested fixes:',
                    '- Enable buttonfu.enableAgentBridge in settings.',
                    '- Run ButtonFu: Agent Bridge Status and verify this VS Code window is targeted.',
                    '- If heartbeat is stale, reload the window or toggle the bridge setting off/on.'
                );
            }

            const text = lines.join('\n');
            await vscode.env.clipboard.writeText(text);
            void vscode.window.showInformationMessage(`ButtonFu Agent Bridge doctor copied to clipboard (${failing.length === 0 ? 'pass' : 'issues found'}).`);
            return text;
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(BRIDGE_SELF_TEST_COMMAND, async () => {
            const bridgeEnabled = vscode.workspace.getConfiguration('buttonfu').get<boolean>('enableAgentBridge', false);
            const bridges = listBridgeFiles();
            const currentBridge = getCurrentBridge(bridges);
            const text = buildBridgeSelfTestText(bridgeEnabled, getBridgeRunning(), bridges, currentBridge);

            await vscode.env.clipboard.writeText(text);
            void vscode.window.showInformationMessage('ButtonFu Agent Bridge self-test copied to clipboard.');
            return text;
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(BRIDGE_CONTEXT_COMMAND, async () => {
            const bridges = listBridgeFiles();
            const currentBridge = getCurrentBridge(bridges);
            const text = buildBridgeContextText(bridges, currentBridge);

            await vscode.env.clipboard.writeText(text);

            if (currentBridge && currentBridge.workspaceFolders.length === 0) {
                void vscode.window.showWarningMessage('ButtonFu bridge context copied: this window has no workspace folders, so local items are window-scoped.');
            } else {
                void vscode.window.showInformationMessage('ButtonFu bridge context copied to clipboard.');
            }

            return text;
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(COPY_QUICK_START_COMMAND, async () => {
            const bridgeEnabled = vscode.workspace.getConfiguration('buttonfu').get<boolean>('enableAgentBridge', false);
            const currentBridge = getCurrentBridge(listBridgeFiles());
            const text = buildQuickStartText(bridgeEnabled, currentBridge);
            await vscode.env.clipboard.writeText(text);
            void vscode.window.showInformationMessage('ButtonFu Agent Bridge quick start copied to clipboard.');
            return text;
        })
    );

}
