<#
.SYNOPSIS
    Builds the ButtonFu installer package.
    
.DESCRIPTION
    This script performs a release build:
    1. Cleans staging directories
    2. Builds and packages the VS Code extension
    3. Compiles the Inno Setup installer
    
#>

param()

$ErrorActionPreference = "Stop"

# Define paths
$ScriptRoot = $PSScriptRoot
$ProjectRoot = Split-Path -Parent $ScriptRoot
$InstallerDir = $ScriptRoot
$StagingDir = Join-Path $InstallerDir "staging"
$ExtensionStagingDir = Join-Path $StagingDir "extension"
$PublishDir = Join-Path $ProjectRoot "bin\publish"
$ExtensionDir = Join-Path $ProjectRoot "buttonfu-extension"
$InnoScript = Join-Path $InstallerDir "ButtonFu.iss"
$ExtensionPackageJson = Join-Path $ExtensionDir "package.json"

# Installer metadata follows the extension package manifest so release artifacts stay aligned.
$PackageManifest = Get-Content $ExtensionPackageJson -Raw | ConvertFrom-Json
$Version = $PackageManifest.version
$RepositoryUrl = if ($PackageManifest.repository -is [string]) {
    [string]$PackageManifest.repository
}
elseif ($PackageManifest.repository -and $PackageManifest.repository.url) {
    [string]$PackageManifest.repository.url
}
else {
    'https://github.com/NullCitySoftware/buttonfu'
}

if ($RepositoryUrl.EndsWith('.git')) {
    $RepositoryUrl = $RepositoryUrl.Substring(0, $RepositoryUrl.Length - 4)
}

# Find Inno Setup compiler
$InnoSetupPaths = @(
    "${env:LOCALAPPDATA}\Programs\Inno Setup 6\ISCC.exe",
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "${env:ProgramFiles}\Inno Setup 6\ISCC.exe",
    "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
    "C:\Program Files\Inno Setup 6\ISCC.exe"
)

$ISCC = $null
foreach ($path in $InnoSetupPaths) {
    if (Test-Path $path) {
        $ISCC = $path
        break
    }
}

if (-not $ISCC) {
    throw "Inno Setup compiler (ISCC.exe) not found. Please install Inno Setup 6."
}

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "ButtonFu Installer Build" -ForegroundColor Cyan
Write-Host "Version: $Version" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Step 1: Clean staging directories
Write-Host "[1/3] Cleaning staging directories..." -ForegroundColor Yellow
if (Test-Path $StagingDir) {
    Remove-Item -Path $StagingDir -Recurse -Force
}
New-Item -ItemType Directory -Path $ExtensionStagingDir -Force | Out-Null

# Ensure publish output directory exists
if (-not (Test-Path $PublishDir)) {
    New-Item -ItemType Directory -Path $PublishDir -Force | Out-Null
}

Write-Host "  Staging directories prepared." -ForegroundColor Green
Write-Host ""

# Step 2: Build VS Code extension
Write-Host "[2/3] Building VS Code extension..." -ForegroundColor Yellow

# Install npm dependencies if needed
Push-Location $ExtensionDir
try {
    if (-not (Test-Path "node_modules")) {
        Write-Host "  Installing npm dependencies..." -ForegroundColor Gray
        & npm install
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to install npm dependencies."
        }
    }
    
    # Compile TypeScript
    Write-Host "  Compiling TypeScript..." -ForegroundColor Gray
    & npm run compile
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to compile VS Code extension."
    }
    
    Write-Host "  Extension compiled successfully." -ForegroundColor Green
    
    # Package the extension using vsce
    Write-Host "  Packaging extension..." -ForegroundColor Gray
    & npx vsce package --out "$ExtensionStagingDir"
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to package VS Code extension."
    }
    Write-Host "  Extension packaged successfully." -ForegroundColor Green
}
finally {
    Pop-Location
}
Write-Host ""

$vsixFile = Get-ChildItem -Path $ExtensionStagingDir -Filter "*.vsix" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $vsixFile) {
    throw "No VSIX package found in staging directory: $ExtensionStagingDir"
}

# Step 3: Build Inno Setup installer
Write-Host "[3/3] Building Inno Setup installer..." -ForegroundColor Yellow

# Compile the installer
$IsccArgs = @(
    "/DMyAppVersion=$Version"
    "/DMyAppURL=$RepositoryUrl"
    "/DMyVsixFileName=$($vsixFile.Name)"
    $InnoScript
)

& $ISCC @IsccArgs
if ($LASTEXITCODE -ne 0) {
    throw "Failed to build Inno Setup installer."
}
Write-Host "  Installer built successfully." -ForegroundColor Green
Write-Host ""

# Final summary
$InstallerPath = Join-Path $PublishDir "ButtonFu_$Version.exe"
if (Test-Path $InstallerPath) {
    $InstallerSize = (Get-Item $InstallerPath).Length / 1MB
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "Build Complete!" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "Installer: $InstallerPath" -ForegroundColor White
    Write-Host "Size: $([math]::Round($InstallerSize, 2)) MB" -ForegroundColor White
    Write-Host ""
}
else {
    throw "Installer was not created at expected location: $InstallerPath"
}
