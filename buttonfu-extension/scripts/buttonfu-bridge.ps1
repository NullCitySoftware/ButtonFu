<#
.SYNOPSIS
    ButtonFu Agent Bridge CLI helper.

.DESCRIPTION
    Discovers a running ButtonFu Agent Bridge, connects to its named pipe,
    and sends a JSON-RPC 2.0 request. Supports describe, listButtons,
    createButton, updateButton, and deleteButton (plus note equivalents).

    This script exists so that humans and AI agents can talk to the bridge
    without hand-building named-pipe connections or JSON-RPC payloads.

    IMPORTANT — Automation rule
    ─────────────────────────────
    All button and note mutations MUST go through the ButtonFu Agent Bridge
    or the registered buttonfu.api.* VS Code commands.
    Do NOT mutate ButtonFu data by editing VS Code storage, state.vscdb,
    the nullcity.buttonfu workspace memento, or buttonfu.globalButtons
    settings directly. Direct writes bypass validation, provenance tracking,
    UI refresh, and may corrupt or lose data.

.PARAMETER Method
    The API method to call. Common values:
      describe, listButtons, createButton, updateButton, deleteButton,
      listNotes, createNote, updateNote, deleteNote, getBridgeContext, listBridges

.PARAMETER Params
    A JSON string or hashtable of parameters for the method.
    For createButton: '{"name":"My Button","locality":"Global","type":"TerminalCommand","executionText":"echo hi"}'

.PARAMETER BridgePid
    PID of the VS Code instance whose bridge to use.
    If omitted, uses the first discovered bridge file.

.PARAMETER BridgeFile
    Path to a specific bridge-{pid}.json file.
    Overrides BridgePid and auto-discovery.

.PARAMETER TimeoutMs
    Pipe connection timeout in milliseconds. Default: 5000.

.EXAMPLE
    # List all buttons via auto-discovered bridge
    .\buttonfu-bridge.ps1 -Method listButtons

.EXAMPLE
    # Create a button
    .\buttonfu-bridge.ps1 -Method createButton -Params '{"name":"Run Tests","locality":"Global","type":"TerminalCommand","executionText":"npm test"}'

.EXAMPLE
    # Describe the full API schema
    .\buttonfu-bridge.ps1 -Method describe
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$Method,

    [Parameter()]
    [object]$Params,

    [Parameter()]
    [int]$BridgePid,

    [Parameter()]
    [string]$BridgeFile,

    [Parameter()]
    [int]$TimeoutMs = 5000
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Resolve bridge file ──────────────────────────────────────────────────

function Find-BridgeFile {
    $dir = Join-Path $HOME '.buttonfu'
    if (-not (Test-Path $dir)) {
        throw "Bridge directory not found: $dir. Is buttonfu.enableAgentBridge set to true?"
    }

    # Ensure this is always an array. With a single file, PowerShell can return
    # a scalar FileInfo object that does not expose a Count property.
    $files = @(
        Get-ChildItem -Path $dir -Filter 'bridge-*.json' -File |
            Sort-Object LastWriteTime -Descending
    )

    if ($files.Count -eq 0) {
        throw "No bridge files found in $dir. Enable the Agent Bridge in ButtonFu settings."
    }

    foreach ($f in $files) {
        try {
            $info = Get-Content $f.FullName -Raw | ConvertFrom-Json
            if (-not $info.pid) {
                continue
            }

            $proc = Get-Process -Id $info.pid -ErrorAction SilentlyContinue
            if ($proc) { return $f.FullName }
        } catch { }
    }

    throw "No live bridge found. All bridge files in $dir belong to dead processes."
}

if ($BridgeFile) {
    if (-not (Test-Path $BridgeFile)) {
        throw "Bridge file not found: $BridgeFile"
    }
    $bridgePath = $BridgeFile
} elseif ($BridgePid) {
    $bridgePath = Join-Path $HOME ".buttonfu" "bridge-$BridgePid.json"
    if (-not (Test-Path $bridgePath)) {
        throw "Bridge file not found for PID $BridgePid at: $bridgePath"
    }
} else {
    $bridgePath = Find-BridgeFile
}

$bridge = Get-Content $bridgePath -Raw | ConvertFrom-Json
Write-Verbose "Using bridge: PID=$($bridge.pid) Pipe=$($bridge.pipeName) Window=$($bridge.windowId)"

# ── Normalise method name ────────────────────────────────────────────────

$fullMethod = if ($Method -match '^buttonfu\.api\.') { $Method } else { "buttonfu.api.$Method" }

# ── Build JSON-RPC request ──────────────────────────────────────────────

$rpc = @{
    jsonrpc = '2.0'
    id      = 1
    method  = $fullMethod
    auth    = $bridge.authToken
}

if ($PSBoundParameters.ContainsKey('Params')) {
    if ($Params -is [string]) {
        if (-not [string]::IsNullOrWhiteSpace($Params)) {
            $rpc['params'] = $Params | ConvertFrom-Json
        }
    } else {
        $rpc['params'] = $Params
    }
}

$body = $rpc | ConvertTo-Json -Depth 20 -Compress

# ── Connect and send ─────────────────────────────────────────────────────

$pipeName = $bridge.pipeName -replace '^\\\\.\\pipe\\', ''

$pipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', $pipeName, 'InOut')
try {
    $pipe.Connect($TimeoutMs)
    $writer = New-Object System.IO.StreamWriter($pipe)
    $reader = New-Object System.IO.StreamReader($pipe)

    $writer.AutoFlush = $false
    $writer.WriteLine($body)
    $writer.Flush()

    $response = $reader.ReadLine()

    if (-not $response) {
        throw 'Bridge returned an empty response.'
    }

    # Pretty-print the result
    $parsed = $response | ConvertFrom-Json
    $parsed | ConvertTo-Json -Depth 20
} finally {
    $pipe.Dispose()
}
