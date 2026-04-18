param(
    [string]$DriveNetExe = 'DriveNet.Cli.exe',
    [string]$ResultJson,
    [string]$SettingsPath = (Join-Path $env:APPDATA 'Code\User\settings.json'),
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$AdditionalArgs
)

$scriptRoot = Split-Path -Parent $PSCommandPath
$manifestPath = Join-Path $scriptRoot 'manifest.yaml'
$repoRoot = (Resolve-Path (Join-Path $scriptRoot '..\..\..')).Path

$driveNetSmokeButtonCommand = 'echo ButtonFu DriveNet smoke test'
$driveNetSmokeNoteContent = 'This note was created by a Drive.NET automation test.'
$driveNetResultNoteName = '3. Smoke Last Result'
$driveNetLegacyResultNoteNames = @(
    '3. Drive.NET Smoke Last Result',
    'Drive.NET Smoke Last Result'
)
$driveNetStep1ButtonName = '1. Launch Isolated Smoke Host'
$driveNetStep2ButtonName = '2. Smoke Tests'
$driveNetLegacyStep2ButtonNames = @(
    '2. Drive.NET Smoke Tests',
    'Drive.NET Smoke Tests'
)
$driveNetSmokeCategory = 'Development Smoke'
$driveNetStep1Colour = '#b45309'
$driveNetStep2Colour = '#556b2f'
$driveNetStep3Colour = '#7f1d1d'

function Get-DriveNetResultSummary {
    param(
        [string]$ResultJsonPath,
        [int]$ExitCode
    )

    $summary = [ordered]@{
        status = if ($ExitCode -eq 0) { 'PASS' } else { 'FAIL' }
        exitCode = $ExitCode
        total = $null
        passed = $null
        failed = $null
        skipped = $null
        failedSuiteCount = $null
        lifecycleFailureCount = $null
        setupFailedCount = $null
        teardownFailedCount = $null
        finallyFailedCount = $null
        failedTests = @()
        guidance = @()
    }

    if (-not (Test-Path $ResultJsonPath)) {
        return $summary
    }

    try {
        $json = Get-Content -Path $ResultJsonPath -Raw -ErrorAction Stop | ConvertFrom-Json -Depth 100

        $candidates = @(
            $json.summary,
            $json.totals,
            $json.result,
            $json
        )

        foreach ($candidate in $candidates) {
            if ($null -eq $candidate) {
                continue
            }

            if ($null -ne $candidate.total -and $null -eq $summary.total) { $summary.total = [int]$candidate.total }
            if ($null -ne $candidate.passed -and $null -eq $summary.passed) { $summary.passed = [int]$candidate.passed }
            if ($null -ne $candidate.failed -and $null -eq $summary.failed) { $summary.failed = [int]$candidate.failed }
            if ($null -ne $candidate.skipped -and $null -eq $summary.skipped) { $summary.skipped = [int]$candidate.skipped }
            if ($null -ne $candidate.failedSuiteCount -and $null -eq $summary.failedSuiteCount) { $summary.failedSuiteCount = [int]$candidate.failedSuiteCount }
            if ($null -ne $candidate.lifecycleFailureCount -and $null -eq $summary.lifecycleFailureCount) { $summary.lifecycleFailureCount = [int]$candidate.lifecycleFailureCount }
            if ($null -ne $candidate.setupFailedCount -and $null -eq $summary.setupFailedCount) { $summary.setupFailedCount = [int]$candidate.setupFailedCount }
            if ($null -ne $candidate.teardownFailedCount -and $null -eq $summary.teardownFailedCount) { $summary.teardownFailedCount = [int]$candidate.teardownFailedCount }
            if ($null -ne $candidate.finallyFailedCount -and $null -eq $summary.finallyFailedCount) { $summary.finallyFailedCount = [int]$candidate.finallyFailedCount }
        }

        foreach ($suite in @($json.suites)) {
            if ($null -eq $suite) {
                continue
            }

            $suiteName = [string]$suite.name
            if ([string]::IsNullOrWhiteSpace($suiteName)) {
                $suiteName = '(unnamed suite)'
            }

            foreach ($test in @($suite.tests)) {
                if ($null -eq $test -or $test.passed) {
                    continue
                }

                $reason = [string]$test.failureReason
                if ([string]::IsNullOrWhiteSpace($reason)) {
                    $reason = [string]$test.commandError
                }

                if ([string]::IsNullOrWhiteSpace($reason)) {
                    $failedStep = @($test.steps | Where-Object { $_ -and $_.passed -eq $false } | Select-Object -First 1)
                    if ($failedStep.Count -gt 0) {
                        $reason = [string]$failedStep[0].failureReason
                        if ([string]::IsNullOrWhiteSpace($reason)) {
                            $reason = [string]$failedStep[0].commandError
                        }
                    }
                }

                if ([string]::IsNullOrWhiteSpace($reason)) {
                    $reason = 'No detailed failureReason was provided by the runner.'
                }

                $summary.failedTests += [ordered]@{
                    suite = $suiteName
                    test = [string]$test.name
                    reason = $reason
                }
            }
        }

        $guidance = @()
        if ($ExitCode -ne 0) {
            $guidance += 'Open the Result JSON path and inspect the first failed suite/test block.'
        }

        if (@($summary.failedTests).Count -eq 0 -and $ExitCode -ne 0) {
            $guidance += 'The runner failed before reporting test-level failures; confirm DriveNet.Cli is available and rerun Step 2.'
        }

        $allReasons = @($summary.failedTests | ForEach-Object { [string]$_.reason })
        if ($allReasons | Where-Object { $_ -like '*No running visible-window process matched*' } | Select-Object -First 1) {
            $guidance += 'Extension Development Host was not visible. Run Step 1 first, wait for the host window to open, then rerun Step 2.'
        }

        if ($allReasons | Where-Object { $_ -like '*Expected count*' -or $_ -like '*Cannot save variable*' -or $_ -like '*Step result preview:*"items":[]*' } | Select-Object -First 1) {
            $guidance += 'A UI selector likely did not match. Reopen the target UI surface, rerun the suite, and compare current UI automation names/paths in the failing query step.'
        }

        $summary.guidance = @($guidance | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)
    }
    catch {
        Write-Warning "ButtonFu Drive.NET summary parse warning: $($_.Exception.Message)"
    }

    return $summary
}

function Write-DriveNetResultSummary {
    param(
        [hashtable]$Summary,
        [string]$ResultJsonPath
    )

    $counts = @()
    if ($null -ne $Summary.total) { $counts += "total=$($Summary.total)" }
    if ($null -ne $Summary.passed) { $counts += "passed=$($Summary.passed)" }
    if ($null -ne $Summary.failed) { $counts += "failed=$($Summary.failed)" }
    if ($null -ne $Summary.skipped) { $counts += "skipped=$($Summary.skipped)" }
    if ($null -ne $Summary.failedSuiteCount) { $counts += "failedSuites=$($Summary.failedSuiteCount)" }
    if ($null -ne $Summary.setupFailedCount) { $counts += "setupFailed=$($Summary.setupFailedCount)" }
    if ($null -ne $Summary.teardownFailedCount) { $counts += "teardownFailed=$($Summary.teardownFailedCount)" }
    if ($null -ne $Summary.finallyFailedCount) { $counts += "finallyFailed=$($Summary.finallyFailedCount)" }

    $countText = if ($counts.Count -gt 0) { ' (' + ($counts -join ', ') + ')' } else { '' }
    Write-Host ("[ButtonFu] Drive.NET Smoke Result: {0}{1}" -f $Summary.status, $countText)
    Write-Host ("[ButtonFu] Result JSON: {0}" -f $ResultJsonPath)

    if ([string]$Summary.status -eq 'FAIL') {
        $topFailures = @($Summary.failedTests | Select-Object -First 3)
        if ($topFailures.Count -gt 0) {
            Write-Host '[ButtonFu] Top failures:'
            foreach ($failure in $topFailures) {
                $reason = [string]$failure.reason
                if ($reason.Length -gt 260) {
                    $reason = $reason.Substring(0, 257) + '...'
                }

                Write-Host ("[ButtonFu] - {0} > {1}: {2}" -f [string]$failure.suite, [string]$failure.test, $reason)
            }
        }

        foreach ($hint in @($Summary.guidance | Select-Object -First 4)) {
            Write-Host ("[ButtonFu] Guidance: {0}" -f [string]$hint)
        }
    }
}

function Publish-DriveNetResultToWorkspaceNote {
    param(
        [hashtable]$Summary,
        [string]$ResultJsonPath,
        [string]$RepoRoot
    )

    $bridgeScriptPath = Join-Path $RepoRoot 'buttonfu-extension\scripts\buttonfu-bridge.ps1'
    if (-not (Test-Path $bridgeScriptPath)) {
        return
    }

    try {
        $bridgeListRaw = & pwsh -NoProfile -ExecutionPolicy Bypass -File $bridgeScriptPath -Method listBridges
        if ([string]::IsNullOrWhiteSpace($bridgeListRaw)) {
            return
        }

        $bridgeList = $bridgeListRaw | ConvertFrom-Json -Depth 100
        $bridges = @($bridgeList.result.bridges)
        if ($bridges.Count -eq 0) {
            return
        }

        $targetBridge = $null
        $repoRootCanonical = [System.IO.Path]::GetFullPath($RepoRoot).ToLowerInvariant()

        foreach ($bridge in $bridges) {
            $folders = @($bridge.workspaceFolders)
            if ($folders.Count -eq 0) {
                continue
            }

            $matchesWorkspace = $false
            foreach ($folder in $folders) {
                if ([string]::IsNullOrWhiteSpace([string]$folder)) {
                    continue
                }

                $folderCanonical = [System.IO.Path]::GetFullPath([string]$folder).ToLowerInvariant()
                if ($folderCanonical -eq $repoRootCanonical) {
                    $matchesWorkspace = $true
                    break
                }
            }

            if (-not $matchesWorkspace) {
                continue
            }

            $isDevHost = $false
            try {
                $utilityProcess = Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f [int]$bridge.pid) -ErrorAction SilentlyContinue
                if ($null -ne $utilityProcess) {
                    $windowProcess = Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f [int]$utilityProcess.ParentProcessId) -ErrorAction SilentlyContinue
                    if ($null -ne $windowProcess -and -not [string]::IsNullOrWhiteSpace([string]$windowProcess.CommandLine)) {
                        $isDevHost = [string]$windowProcess.CommandLine -like '*--extensionDevelopmentPath=*'
                    }
                }
            }
            catch {
            }

            if ($isDevHost) {
                continue
            }

            $targetBridge = $bridge
            break
        }

        if ($null -eq $targetBridge) {
            return
        }

        $timestamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss zzz')
        $counts = @()
        if ($null -ne $Summary.total) { $counts += "- Total: $($Summary.total)" }
        if ($null -ne $Summary.passed) { $counts += "- Passed: $($Summary.passed)" }
        if ($null -ne $Summary.failed) { $counts += "- Failed: $($Summary.failed)" }
        if ($null -ne $Summary.skipped) { $counts += "- Skipped: $($Summary.skipped)" }
        if ($null -ne $Summary.failedSuiteCount) { $counts += "- Failed Suites: $($Summary.failedSuiteCount)" }
        if ($null -ne $Summary.setupFailedCount) { $counts += "- Setup Failures: $($Summary.setupFailedCount)" }
        if ($null -ne $Summary.teardownFailedCount) { $counts += "- Teardown Failures: $($Summary.teardownFailedCount)" }
        if ($null -ne $Summary.finallyFailedCount) { $counts += "- Finally Failures: $($Summary.finallyFailedCount)" }

        $contentLines = @(
            "# Drive.NET Smoke Result",
            '',
            "- Status: **$($Summary.status)**",
            "- Exit Code: $($Summary.exitCode)",
            "- Timestamp: $timestamp",
            "- Result JSON: $ResultJsonPath"
        )
        if ($counts.Count -gt 0) {
            $contentLines += ''
            $contentLines += '## Counts'
            $contentLines += $counts
        }

        if ([string]$Summary.status -eq 'FAIL') {
            $topFailures = @($Summary.failedTests | Select-Object -First 5)
            if ($topFailures.Count -gt 0) {
                $contentLines += ''
                $contentLines += '## Top Failures'
                foreach ($failure in $topFailures) {
                    $reason = [string]$failure.reason
                    if ($reason.Length -gt 360) {
                        $reason = $reason.Substring(0, 357) + '...'
                    }

                    $contentLines += "- **$([string]$failure.suite) > $([string]$failure.test)**"
                    $contentLines += "  - $reason"
                }
            }

            $guidance = @($Summary.guidance | Select-Object -First 6)
            if ($guidance.Count -gt 0) {
                $contentLines += ''
                $contentLines += '## Guidance'
                foreach ($hint in $guidance) {
                    $contentLines += "- $([string]$hint)"
                }
            }
        }

        $content = $contentLines -join [Environment]::NewLine
        $windowId = [string]$targetBridge.windowId

        $notesRaw = & pwsh -NoProfile -ExecutionPolicy Bypass -File $bridgeScriptPath -WindowId $windowId -Method listNotes -Params '{"locality":"Local"}'
        $existing = $null
        if (-not [string]::IsNullOrWhiteSpace($notesRaw)) {
            $existingNotes = @((($notesRaw | ConvertFrom-Json -Depth 100).result.data))
            $existing = $existingNotes | Where-Object { $_.name -in @($driveNetResultNoteName) + $driveNetLegacyResultNoteNames } | Select-Object -First 1
        }

        if ($null -ne $existing) {
            $updatePayload = @{
                id = $existing.id
                name = $driveNetResultNoteName
                locality = $existing.locality
                content = $content
                format = 'Markdown'
                defaultAction = $existing.defaultAction
                category = if ([string]::IsNullOrWhiteSpace([string]$existing.category)) { $driveNetSmokeCategory } else { $existing.category }
                icon = if ([string]::IsNullOrWhiteSpace([string]$existing.icon)) { 'beaker' } else { $existing.icon }
                colour = $driveNetStep3Colour
                sortOrder = 3
            } | ConvertTo-Json -Depth 40 -Compress

            & pwsh -NoProfile -ExecutionPolicy Bypass -File $bridgeScriptPath -WindowId $windowId -Method updateNote -Params $updatePayload | Out-Null
        }
        else {
            $createPayload = @{
                name = $driveNetResultNoteName
                locality = 'Local'
                content = $content
                format = 'Markdown'
                defaultAction = 'open'
                category = $driveNetSmokeCategory
                icon = 'beaker'
                colour = $driveNetStep3Colour
                sortOrder = 3
            } | ConvertTo-Json -Depth 40 -Compress

            & pwsh -NoProfile -ExecutionPolicy Bypass -File $bridgeScriptPath -WindowId $windowId -Method createNote -Params $createPayload | Out-Null
        }

        Write-Host ("[ButtonFu] Posted smoke result to workspace window {0} note '{1}'." -f $windowId, $driveNetResultNoteName)
    }
    catch {
        Write-Warning "ButtonFu Drive.NET result propagation skipped: $($_.Exception.Message)"
    }
}

function Sync-DriveNetSmokeWorkflowStyle {
    param([string]$RepoRoot)

    $bridgeScriptPath = Join-Path $RepoRoot 'buttonfu-extension\scripts\buttonfu-bridge.ps1'
    if (-not (Test-Path $bridgeScriptPath)) {
        return
    }

    try {
        $bridgeListRaw = & pwsh -NoProfile -ExecutionPolicy Bypass -File $bridgeScriptPath -Method listBridges
        if ([string]::IsNullOrWhiteSpace($bridgeListRaw)) {
            return
        }

        $bridges = @((($bridgeListRaw | ConvertFrom-Json -Depth 100).result.bridges))
        foreach ($bridge in $bridges) {
            $windowId = [string]$bridge.windowId
            if ([string]::IsNullOrWhiteSpace($windowId)) {
                continue
            }

            $isDevHost = $false
            try {
                $utilityProcess = Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f [int]$bridge.pid) -ErrorAction SilentlyContinue
                if ($null -ne $utilityProcess) {
                    $windowProcess = Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f [int]$utilityProcess.ParentProcessId) -ErrorAction SilentlyContinue
                    if ($null -ne $windowProcess -and -not [string]::IsNullOrWhiteSpace([string]$windowProcess.CommandLine)) {
                        $isDevHost = [string]$windowProcess.CommandLine -like '*--extensionDevelopmentPath=*'
                    }
                }
            }
            catch {
            }

            $allowNoWorkspace = @()
            $hasWorkspace = @($bridge.workspaceFolders).Count -gt 0
            if (-not $hasWorkspace) {
                $allowNoWorkspace = @('-AllowNoWorkspaceLocalMutation')
            }

            $buttonsRaw = & pwsh -NoProfile -ExecutionPolicy Bypass -File $bridgeScriptPath -WindowId $windowId -Method listButtons -Params '{"locality":"Local"}'
            $foundStep2 = $false
            if (-not [string]::IsNullOrWhiteSpace($buttonsRaw)) {
                $buttons = @((($buttonsRaw | ConvertFrom-Json -Depth 100).result.data))
                foreach ($button in $buttons) {
                    if ($null -eq $button) {
                        continue
                    }

                    $targetColour = $null
                    if ([string]$button.name -eq $driveNetStep1ButtonName) {
                        if ($isDevHost -or -not $hasWorkspace) {
                            & pwsh -NoProfile -ExecutionPolicy Bypass -File $bridgeScriptPath @allowNoWorkspace -WindowId $windowId -Method deleteButton -Params (@{ id = [string]$button.id } | ConvertTo-Json -Compress) | Out-Null
                            continue
                        }

                        $targetColour = $driveNetStep1Colour
                    }
                    elseif ([string]$button.name -eq $driveNetStep2ButtonName -or [string]$button.name -in $driveNetLegacyStep2ButtonNames) {
                        $foundStep2 = $true
                        $targetColour = $driveNetStep2Colour
                    }

                    if ($null -eq $targetColour) {
                        continue
                    }

                    $buttonPayload = @{
                        id = $button.id
                        name = if ([string]$button.name -eq $driveNetStep1ButtonName) { $driveNetStep1ButtonName } else { $driveNetStep2ButtonName }
                        locality = $button.locality
                        description = $button.description
                        type = $button.type
                        executionText = $button.executionText
                        terminals = $button.terminals
                        category = if ([string]::IsNullOrWhiteSpace([string]$button.category)) { $driveNetSmokeCategory } else { $button.category }
                        icon = if ([string]::IsNullOrWhiteSpace([string]$button.icon)) { 'beaker' } else { $button.icon }
                        colour = $targetColour
                        sortOrder = $button.sortOrder
                        warnBeforeExecution = $false
                    } | ConvertTo-Json -Depth 40 -Compress

                    & pwsh -NoProfile -ExecutionPolicy Bypass -File $bridgeScriptPath @allowNoWorkspace -WindowId $windowId -Method updateButton -Params $buttonPayload | Out-Null
                }
            }

            if (-not $foundStep2 -and $hasWorkspace) {
                $step2Payload = @{
                    name = $driveNetStep2ButtonName
                    locality = 'Local'
                    description = 'Runs the full Drive.NET manifest smoke suite. Warning: this takes over the PC while it runs.'
                    type = 'TaskExecution'
                    executionText = 'Drive.NET: manifest smoke - buttonfu-extension'
                    category = $driveNetSmokeCategory
                    icon = 'beaker'
                    colour = $driveNetStep2Colour
                    sortOrder = 2
                    warnBeforeExecution = $false
                } | ConvertTo-Json -Depth 40 -Compress

                & pwsh -NoProfile -ExecutionPolicy Bypass -File $bridgeScriptPath @allowNoWorkspace -WindowId $windowId -Method createButton -Params $step2Payload | Out-Null
            }

            $notesRaw = & pwsh -NoProfile -ExecutionPolicy Bypass -File $bridgeScriptPath -WindowId $windowId -Method listNotes -Params '{"locality":"Local"}'
            if ([string]::IsNullOrWhiteSpace($notesRaw)) {
                continue
            }

            $notes = @((($notesRaw | ConvertFrom-Json -Depth 100).result.data))
            $resultNote = $notes | Where-Object { $_.name -in @($driveNetResultNoteName) + $driveNetLegacyResultNoteNames } | Select-Object -First 1
            if ($null -eq $resultNote) {
                continue
            }

            if ($isDevHost -or -not $hasWorkspace) {
                & pwsh -NoProfile -ExecutionPolicy Bypass -File $bridgeScriptPath @allowNoWorkspace -WindowId $windowId -Method deleteNote -Params (@{ id = [string]$resultNote.id } | ConvertTo-Json -Compress) | Out-Null
                continue
            }

            $notePayload = @{
                id = $resultNote.id
                name = $driveNetResultNoteName
                locality = $resultNote.locality
                content = $resultNote.content
                format = $resultNote.format
                defaultAction = $resultNote.defaultAction
                category = if ([string]::IsNullOrWhiteSpace([string]$resultNote.category)) { $driveNetSmokeCategory } else { $resultNote.category }
                icon = if ([string]::IsNullOrWhiteSpace([string]$resultNote.icon)) { 'beaker' } else { $resultNote.icon }
                colour = $driveNetStep3Colour
                sortOrder = 3
            } | ConvertTo-Json -Depth 40 -Compress

            & pwsh -NoProfile -ExecutionPolicy Bypass -File $bridgeScriptPath @allowNoWorkspace -WindowId $windowId -Method updateNote -Params $notePayload | Out-Null
        }
    }
    catch {
        Write-Warning "ButtonFu Drive.NET style sync skipped: $($_.Exception.Message)"
    }
}

function Test-IsDriveNetGuidName {
    param([AllowNull()][string]$Name)

    if ([string]::IsNullOrWhiteSpace($Name)) {
        return $false
    }

    return $Name -match '^[0-9a-f]{32}$' -or $Name -match '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
}

function Test-IsDriveNetSmokeButton {
    param($Button)

    if ($null -eq $Button -or -not (Test-IsDriveNetGuidName -Name ([string]$Button.name))) {
        return $false
    }

    if (([string]$Button.executionText).Trim() -eq $driveNetSmokeButtonCommand) {
        return $true
    }

    foreach ($terminal in @($Button.terminals)) {
        if ($null -ne $terminal -and ([string]$terminal.commands).Trim() -eq $driveNetSmokeButtonCommand) {
            return $true
        }
    }

    return $false
}

function Test-IsDriveNetSmokeNote {
    param($Note)

    if ($null -eq $Note -or -not (Test-IsDriveNetGuidName -Name ([string]$Note.name))) {
        return $false
    }

    return ([string]$Note.content).Trim() -eq $driveNetSmokeNoteContent
}

function Clear-DriveNetSmokeSettings {
    param([string]$Path)

    if (-not (Test-Path $Path)) {
        return
    }

    try {
        $raw = Get-Content -Path $Path -Raw -ErrorAction Stop
        if ([string]::IsNullOrWhiteSpace($raw)) {
            return
        }

        $settings = $raw | ConvertFrom-Json -AsHashtable -Depth 100 -ErrorAction Stop
    }
    catch {
        Write-Warning "ButtonFu Drive.NET cleanup skipped: failed to parse $Path. $($_.Exception.Message)"
        return
    }

    $updated = $false

    if ($settings.ContainsKey('buttonfu.globalButtons')) {
        $existingButtons = @($settings['buttonfu.globalButtons'])
        $filteredButtons = @($existingButtons | Where-Object { -not (Test-IsDriveNetSmokeButton $_) })
        if ($filteredButtons.Count -ne $existingButtons.Count) {
            $settings['buttonfu.globalButtons'] = $filteredButtons
            $updated = $true
            Write-Host ("Removed {0} Drive.NET smoke button(s) from {1}" -f ($existingButtons.Count - $filteredButtons.Count), $Path)
        }
    }

    if ($settings.ContainsKey('buttonfu.globalNotes')) {
        $existingNotes = @($settings['buttonfu.globalNotes'])
        $filteredNotes = @($existingNotes | Where-Object { -not (Test-IsDriveNetSmokeNote $_) })
        if ($filteredNotes.Count -ne $existingNotes.Count) {
            $settings['buttonfu.globalNotes'] = $filteredNotes
            $updated = $true
            Write-Host ("Removed {0} Drive.NET smoke note(s) from {1}" -f ($existingNotes.Count - $filteredNotes.Count), $Path)
        }
    }

    if (-not $updated) {
        return
    }

    $settings | ConvertTo-Json -Depth 100 | Set-Content -Path $Path -Encoding utf8
}

if (-not $ResultJson) {
    $ResultJson = Join-Path $repoRoot '.drive-net\test-results.json'
}

$exitCode = 1

Push-Location $repoRoot
try {
    & $DriveNetExe test --manifest $manifestPath --result-json $ResultJson @AdditionalArgs
    $exitCode = $LASTEXITCODE
}
finally {
    Clear-DriveNetSmokeSettings -Path $SettingsPath
    Pop-Location
}

$summary = Get-DriveNetResultSummary -ResultJsonPath $ResultJson -ExitCode $exitCode
Write-DriveNetResultSummary -Summary $summary -ResultJsonPath $ResultJson
Publish-DriveNetResultToWorkspaceNote -Summary $summary -ResultJsonPath $ResultJson -RepoRoot $repoRoot
Sync-DriveNetSmokeWorkflowStyle -RepoRoot $repoRoot

exit $exitCode