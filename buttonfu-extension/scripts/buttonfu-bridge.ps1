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

.PARAMETER WindowId
    Exact ButtonFu bridge windowId to target.

.PARAMETER WorkspacePath
    Workspace path to match against bridge workspaceFolders.
    If omitted during auto-discovery, the current working directory is used
    as an implicit workspace hint.

.PARAMETER WorkspaceName
    Workspace name to match against bridge metadata.

.PARAMETER TimeoutMs
    Pipe connection timeout in milliseconds. Default: 5000.

.PARAMETER Id
    Common helper field for updateButton/deleteButton operations.

.PARAMETER Name
    Common helper field for createButton/updateButton.

.PARAMETER Locality
    Common helper field for createButton/updateButton.

.PARAMETER Type
    Common helper field for createButton/updateButton.

.PARAMETER ExecutionText
    Common helper field for createButton/updateButton.

.PARAMETER Description
    Common helper field for createButton/updateButton.

.PARAMETER Category
    Common helper field for createButton/updateButton.

.PARAMETER Icon
    Common helper field for createButton/updateButton.

.PARAMETER Colour
    Common helper field for createButton/updateButton.

.PARAMETER SortOrder
    Common helper field for createButton/updateButton.

.PARAMETER WarnBeforeExecution
    Common helper field for createButton/updateButton.

.PARAMETER OpenEditor
    Common helper field for createButton/updateButton.

.PARAMETER TargetWindowId
    Common helper field to pin bridge mutations to a specific window.

.PARAMETER AllowNoWorkspaceLocalMutation
    Allows local create/update mutations even when the selected bridge has no workspace folders.
    By default, local mutations in no-workspace windows are blocked to prevent writing data
    into the wrong profile/window store.

.EXAMPLE
    # List all buttons via auto-discovered bridge
    .\buttonfu-bridge.ps1 -Method listButtons

.EXAMPLE
    # Create a button
    .\buttonfu-bridge.ps1 -Method createButton -Params '{"name":"Run Tests","locality":"Global","type":"TerminalCommand","executionText":"npm test"}'

.EXAMPLE
    # Target the ButtonFu workspace explicitly when multiple VS Code windows are open
    .\buttonfu-bridge.ps1 -WorkspacePath 'p:\Source\DotNet\_Other\ButtonFu' -Method listButtons

.EXAMPLE
    # Create a task button without writing raw JSON
    .\buttonfu-bridge.ps1 -WorkspacePath 'p:\Source\DotNet\_Other\ButtonFu' -Method createButton -Name 'Drive.NET Smoke Tests' -Locality Local -Type TaskExecution -ExecutionText 'Drive.NET: manifest smoke - buttonfu-extension' -Category Testing -Icon beaker -WarnBeforeExecution

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
    [string]$WindowId,

    [Parameter()]
    [string]$WorkspacePath,

    [Parameter()]
    [string]$WorkspaceName,

    [Parameter()]
    [int]$TimeoutMs = 5000

    ,[Parameter()]
    [string]$Id

    ,[Parameter()]
    [string]$Name

    ,[Parameter()]
    [string]$Locality

    ,[Parameter()]
    [string]$Type

    ,[Parameter()]
    [string]$ExecutionText

    ,[Parameter()]
    [string]$Description

    ,[Parameter()]
    [string]$Category

    ,[Parameter()]
    [string]$Icon

    ,[Parameter()]
    [string]$Colour

    ,[Parameter()]
    [int]$SortOrder

    ,[Parameter()]
    [switch]$WarnBeforeExecution

    ,[Parameter()]
    [switch]$OpenEditor

    ,[Parameter()]
    [string]$TargetWindowId

    ,[Parameter()]
    [switch]$AllowNoWorkspaceLocalMutation
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Resolve bridge file ──────────────────────────────────────────────────

function Get-CanonicalPath {
    param([Parameter(Mandatory)][string]$PathValue)

    $resolved = [System.IO.Path]::GetFullPath($PathValue)
    if ($IsWindows) {
        return $resolved.ToLowerInvariant()
    }

    return $resolved
}

function Test-IsSameOrDescendantPath {
    param(
        [Parameter(Mandatory)][string]$CandidatePath,
        [Parameter(Mandatory)][string]$RootPath
    )

    $candidate = Get-CanonicalPath -PathValue $CandidatePath
    $root = Get-CanonicalPath -PathValue $RootPath
    $relative = [System.IO.Path]::GetRelativePath($root, $candidate)
    return [string]::IsNullOrEmpty($relative) -or (-not $relative.StartsWith('..') -and -not [System.IO.Path]::IsPathRooted($relative))
}

function Get-BridgeDescription {
    param($Bridge)

    $workspaceName = if ([string]::IsNullOrWhiteSpace([string]$Bridge.workspaceName)) { '(none)' } else { [string]$Bridge.workspaceName }
    $folders = if ($null -ne $Bridge.workspaceFolders -and @($Bridge.workspaceFolders).Count -gt 0) {
        (@($Bridge.workspaceFolders) | ForEach-Object { [string]$_ }) -join ', '
    } else {
        '(none)'
    }

    return "pid=$($Bridge.pid) windowId=$($Bridge.windowId) workspace=$workspaceName folders=$folders"
}

function Get-LiveBridges {
    param([Parameter(Mandatory)][string]$BridgeDirectory)

    if (-not (Test-Path $BridgeDirectory)) {
        return @()
    }

    $results = @()
    foreach ($file in @(Get-ChildItem -Path $BridgeDirectory -Filter 'bridge-*.json' -File | Sort-Object LastWriteTime -Descending)) {
        try {
            $info = Get-Content $file.FullName -Raw | ConvertFrom-Json
            if (-not $info.pid) {
                continue
            }

            $proc = Get-Process -Id $info.pid -ErrorAction SilentlyContinue
            if (-not $proc) {
                continue
            }

            $info | Add-Member -NotePropertyName __filePath -NotePropertyValue $file.FullName -Force
            $results += $info
        } catch {
            # Ignore corrupt bridge files during discovery.
        }
    }

    return @($results)
}

function Select-SingleBridge {
    param(
        [Parameter(Mandatory)]$Candidates,
        [Parameter(Mandatory)][string]$Reason
    )

    if (@($Candidates).Count -eq 1) {
        return @($Candidates)[0]
    }

    if (@($Candidates).Count -eq 0) {
        throw "No live bridge matched $Reason."
    }

    $details = (@($Candidates) | ForEach-Object { "- $(Get-BridgeDescription $_)" }) -join [Environment]::NewLine
    throw "Multiple live bridges matched $Reason. Use an explicit selector.`n$details"
}

function Find-WorkspaceMatchingBridges {
    param(
        [Parameter(Mandatory)]$Bridges,
        [Parameter(Mandatory)][string]$TargetPath
    )

    return @(
        @($Bridges) | Where-Object {
            $bridge = $_
            @($bridge.workspaceFolders) | Where-Object {
                $folder = [string]$_
                (Test-IsSameOrDescendantPath -CandidatePath $TargetPath -RootPath $folder) -or
                (Test-IsSameOrDescendantPath -CandidatePath $folder -RootPath $TargetPath)
            }
        }
    )
}

function Find-BridgeFile {
    param(
        [int]$RequestedPid,
        [string]$RequestedWindowId,
        [string]$RequestedWorkspacePath,
        [string]$RequestedWorkspaceName
    )

    $dir = Join-Path $HOME '.buttonfu'
    if (-not (Test-Path $dir)) {
        throw "Bridge directory not found: $dir. Is buttonfu.enableAgentBridge set to true?"
    }

    $bridges = Get-LiveBridges -BridgeDirectory $dir
    if ($bridges.Count -eq 0) {
        throw "No live bridge found in $dir. Enable the Agent Bridge in ButtonFu settings."
    }

    if ($RequestedPid) {
        return (Select-SingleBridge -Candidates @($bridges | Where-Object { $_.pid -eq $RequestedPid }) -Reason "bridge pid $RequestedPid").__filePath
    }

    if (-not [string]::IsNullOrWhiteSpace($RequestedWindowId)) {
        return (Select-SingleBridge -Candidates @($bridges | Where-Object { $_.windowId -eq $RequestedWindowId }) -Reason "window id $RequestedWindowId").__filePath
    }

    if (-not [string]::IsNullOrWhiteSpace($RequestedWorkspacePath)) {
        return (Select-SingleBridge -Candidates (Find-WorkspaceMatchingBridges -Bridges $bridges -TargetPath $RequestedWorkspacePath) -Reason "workspace path $RequestedWorkspacePath").__filePath
    }

    if (-not [string]::IsNullOrWhiteSpace($RequestedWorkspaceName)) {
        return (Select-SingleBridge -Candidates @($bridges | Where-Object { $_.workspaceName -eq $RequestedWorkspaceName }) -Reason "workspace name $RequestedWorkspaceName").__filePath
    }

    $cwdMatches = Find-WorkspaceMatchingBridges -Bridges $bridges -TargetPath (Get-Location).Path
    if ($cwdMatches.Count -eq 1) {
        return $cwdMatches[0].__filePath
    }

    if ($cwdMatches.Count -gt 1) {
        return (Select-SingleBridge -Candidates $cwdMatches -Reason "current working directory $((Get-Location).Path)").__filePath
    }

    if ($bridges.Count -eq 1) {
        return $bridges[0].__filePath
    }

    $details = (@($bridges) | ForEach-Object { "- $(Get-BridgeDescription $_)" }) -join [Environment]::NewLine
    throw "Multiple live bridges were found and none matched the current working directory. Use -BridgePid, -BridgeFile, -WindowId, -WorkspacePath, or -WorkspaceName.`n$details"
}

function Get-HelperParamsFromBoundParameters {
    $helperParams = [ordered]@{}

    foreach ($entry in @(
        @{ Key = 'id'; Value = $Id },
        @{ Key = 'name'; Value = $Name },
        @{ Key = 'locality'; Value = $Locality },
        @{ Key = 'type'; Value = $Type },
        @{ Key = 'executionText'; Value = $ExecutionText },
        @{ Key = 'description'; Value = $Description },
        @{ Key = 'category'; Value = $Category },
        @{ Key = 'icon'; Value = $Icon },
        @{ Key = 'colour'; Value = $Colour },
        @{ Key = 'targetWindowId'; Value = $TargetWindowId }
    )) {
        if (-not [string]::IsNullOrWhiteSpace([string]$entry.Value)) {
            $helperParams[$entry.Key] = $entry.Value
        }
    }

    if ($PSBoundParameters.ContainsKey('SortOrder')) {
        $helperParams['sortOrder'] = $SortOrder
    }
    if ($WarnBeforeExecution.IsPresent) {
        $helperParams['warnBeforeExecution'] = $true
    }
    if ($OpenEditor.IsPresent) {
        $helperParams['openEditor'] = $true
    }

    if ($helperParams.Count -eq 0) {
        return $null
    }

    return $helperParams
}

function Get-ParamValue {
    param(
        [Parameter(Mandatory)]$Object,
        [Parameter(Mandatory)][string]$Name
    )

    if ($null -eq $Object) {
        return $null
    }

    if ($Object -is [hashtable]) {
        if ($Object.ContainsKey($Name)) {
            return $Object[$Name]
        }
        return $null
    }

    $property = $Object.PSObject.Properties[$Name]
    if ($null -ne $property) {
        return $property.Value
    }

    return $null
}

function Test-IsLocalMutationWithoutWorkspace {
    param(
        [Parameter(Mandatory)][string]$MethodName,
        [Parameter(Mandatory)]$BridgeInfo,
        $ParamsObject
    )

    $workspaceFolders = @($BridgeInfo.workspaceFolders)
    if ($workspaceFolders.Count -gt 0) {
        return $false
    }

    if ($MethodName -notin @('buttonfu.api.createButton', 'buttonfu.api.updateButton', 'buttonfu.api.deleteButton', 'buttonfu.api.createNote', 'buttonfu.api.updateNote', 'buttonfu.api.deleteNote')) {
        return $false
    }

    $locality = Get-ParamValue -Object $ParamsObject -Name 'locality'
    if ($null -eq $locality) {
        return $false
    }

    return ([string]$locality).Equals('Local', [System.StringComparison]::OrdinalIgnoreCase)
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
    $bridgePath = Find-BridgeFile -RequestedWindowId $WindowId -RequestedWorkspacePath $WorkspacePath -RequestedWorkspaceName $WorkspaceName
}

$bridge = Get-Content $bridgePath -Raw | ConvertFrom-Json
Write-Verbose "Using bridge: $(Get-BridgeDescription $bridge) file=$bridgePath"

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
} else {
    $helperParams = Get-HelperParamsFromBoundParameters
    if ($null -ne $helperParams) {
        $rpc['params'] = $helperParams
    }
}

if (-not $AllowNoWorkspaceLocalMutation.IsPresent -and (Test-IsLocalMutationWithoutWorkspace -MethodName $fullMethod -BridgeInfo $bridge -ParamsObject $rpc['params'])) {
    $window = if ([string]::IsNullOrWhiteSpace([string]$bridge.windowId)) { '(unknown)' } else { [string]$bridge.windowId }
    throw "Refusing local mutation on bridge window $window because it has no workspace folders. Use -WorkspacePath or -WindowId for the intended workspace window, or pass -AllowNoWorkspaceLocalMutation to override intentionally."
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
