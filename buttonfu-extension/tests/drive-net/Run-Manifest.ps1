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

exit $exitCode