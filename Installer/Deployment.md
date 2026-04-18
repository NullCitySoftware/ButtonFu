# ButtonFu - Deployment Guide

This guide explains how to build the installer for ButtonFu using the Inno Setup build system.

## Prerequisites

- **Inno Setup 6.x** - Install via winget:
  ```powershell
  winget install JRSoftware.InnoSetup
  ```
  Default installation path: `%LOCALAPPDATA%\Programs\Inno Setup 6\`

- **Node.js and npm** - Required for building the VS Code extension

- **VS Code Extension Tools** - Install globally:
  ```powershell
  npm install -g @vscode/vsce
  ```

## Building the Installer

### Quick Build

Run the PowerShell build script (version info is read from files in Installer/):
```powershell
cd c:\GIT\ButtonFu
powershell -ExecutionPolicy Bypass -File "Installer\Build-Installer.ps1"
```

### Using VS Code Task

1. Open the Command Palette (`Ctrl+Shift+P`)
2. Select **Tasks: Run Task**
3. Choose **build-installer**
4. The script reads the installer version from `buttonfu-extension/package.json`

### Output Location

The built installer is placed at:
```
bin\publish\ButtonFu_{version}.exe
```

For example: `bin\publish\ButtonFu_1.1.2.exe`

## Versioning

### Setting the Version

The installer version is sourced from:

- `buttonfu-extension/package.json` → Extension and installer version (for example `1.1.2`)

Update it before packaging with:

```
npm version patch --no-git-tag-version --prefix buttonfu-extension
```

### Version Format

Use semantic versioning: `MAJOR.MINOR.PATCH[-PRERELEASE]`

- **MAJOR** - Breaking changes or major new features
- **MINOR** - New features, backward compatible
- **PATCH** - Bug fixes, backward compatible
- **PRERELEASE** - Optional suffix for pre-release versions (alpha, beta, rc)

### Version in Installer

The version appears in:
- Installer filename: `ButtonFu_{version}.exe`
- Windows Add/Remove Programs
- Application properties in Windows Explorer
- Installer wizard title

## What Gets Built

The build script performs these steps in order:

| Step | Description | Output |
|------|-------------|--------|
| 1. Clean | Removes previous staging directories | - |
| 2. Build Extension | Compiles TypeScript and packages VSIX | `Installer\staging\extension\*.vsix` |
| 3. Build Installer | Compiles Inno Setup script | `bin\publish\ButtonFu_{version}.exe` |

## Build Configuration

### Inno Setup Script

The installer script is located at:
```
Installer\ButtonFu.iss
```

Key configuration:
- **Install location**: `%LOCALAPPDATA%\Programs\ButtonFu`
- **Components**: VS Code Extension
- **License**: MIT License (displayed during install)
- **Privileges**: Per-user install; no elevation required

## Installer Components

The installer installs the ButtonFu VS Code extension.

| Component | Description | Default |
|-----------|-------------|---------|
| VS Code Extension | ButtonFu button panel extension | Required |

## Troubleshooting

### "ISCC.exe not found"

Inno Setup is not installed or not in the expected location. Install it:
```powershell
winget install JRSoftware.InnoSetup
```

Or update the path in `Build-Installer.ps1` if installed elsewhere.

### "npm/vsce not found"

Install Node.js and the VS Code extension tools:
```powershell
npm install -g @vscode/vsce
```

### VS Code Extension Not Installing

The extension installation runs in the original user context (not elevated). Ensure:
- VS Code is installed for the current user
- The `code` command is available in PATH

Check the installation log at: `%TEMP%\ButtonFu_Install.log`

## File Structure

```
Installer/
├── Build-Installer.ps1           # PowerShell build orchestration script
├── Deployment.md                 # This file
├── License.rtf                   # MIT license for installer display
├── ButtonFu.iss                  # Inno Setup script
├── ButtonFu.Installer.proj       # Dummy project for Solution Explorer
└── staging/                      # Temporary build artifacts (git-ignored)
    └── extension/                # Packaged VS Code extension
```

## Automated Builds

For CI/CD pipelines, run the build non-interactively:

```powershell
# Set execution policy for the session
Set-ExecutionPolicy -ExecutionPolicy Bypass -Scope Process

# Run build
& ".\Installer\Build-Installer.ps1"
```

Exit code 0 indicates success; non-zero indicates failure.

## Silent Installation

The installer supports Inno Setup's standard command-line parameters for silent/unattended installation.

### Silent Install Commands

```powershell
# Silent install - shows progress bar but no dialogs
.\ButtonFu_{version}.exe /SILENT

# Very silent install - no UI at all (fully unattended)
.\ButtonFu_{version}.exe /VERYSILENT

# Silent install with custom installation directory
.\ButtonFu_{version}.exe /VERYSILENT /DIR="C:\MyApps\ButtonFu"

# Full silent install with all options (recommended for automation)
.\ButtonFu_{version}.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /COMPONENTS="extension"
```

### Command-Line Parameters

| Parameter | Description |
|-----------|-------------|
| `/SILENT` | Silent install with progress bar, no user interaction |
| `/VERYSILENT` | Fully silent, no UI whatsoever |
| `/SUPPRESSMSGBOXES` | Suppress message boxes (use with `/SILENT` or `/VERYSILENT`) |
| `/NORESTART` | Prevent automatic restart (if needed) |
| `/DIR="path"` | Custom installation directory |
| `/COMPONENTS="extension"` | Select components to install |
| `/LOG="path"` | Create a log file at the specified path |

### Available Components

- `extension` - ButtonFu VS Code Extension (required)

### Silent Uninstall

```powershell
# Silent uninstall
"$env:LOCALAPPDATA\Programs\ButtonFu\unins000.exe" /VERYSILENT /SUPPRESSMSGBOXES
```
