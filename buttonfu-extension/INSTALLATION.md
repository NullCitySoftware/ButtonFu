# ButtonFu — Installation Guide

## Prerequisites

- **Visual Studio Code** 1.93.0 or later
- **Node.js** 18+ and npm (for development builds)

## Installation Methods

### Method 1: VSIX Package

1. Obtain the `buttonfu-{version}.vsix` file
2. Open VS Code
3. Press `Ctrl+Shift+P` → **Extensions: Install from VSIX...**
4. Select the `.vsix` file
5. Reload VS Code when prompted

### Method 2: Development Install

```bash
git clone <repository-url>
cd ButtonFu/buttonfu-extension
npm install
cd ..
```

Open the repository root in VS Code, then press `F5` to run the checked-in `Run ButtonFu Extension` launch configuration. It compiles `buttonfu-extension` and starts an Extension Development Host automatically.

## Getting Started

1. After installation, you'll see the **ButtonFu** icon in the Activity Bar
2. Click it to open the Buttons sidebar
3. Click the **gear** (⚙) icon to open the Button Editor
4. Create your first button:
   - Give it a name
   - Choose a type (Terminal Command, Command Palette Action, Task Execution, or Copilot Command)
   - Enter the command, task, or prompt to execute
   - Pick an icon and colour
   - Save

## Button Types

| Type | Description | Example |
|------|-------------|---------|
| Terminal Command | Runs shell commands in the integrated terminal, including PowerShell when that is your configured shell | `npm run build` |
| Command Palette Action | Executes a VS Code command | `workbench.action.toggleSidebarVisibility` |
| Task Execution | Runs a task from tasks.json | `build` |
| Copilot Command | Sends a prompt to Copilot Chat | `Explain this code` |

## Troubleshooting

| Issue | Solution |
|-------|----------|
| ButtonFu icon not visible | Check Extensions view → ensure ButtonFu is enabled |
| Buttons not appearing | Click the refresh icon in the sidebar title |
| Copilot commands fail | Ensure GitHub Copilot Chat extension is installed and active |
| Task not found | Verify the task name matches exactly what's in `tasks.json` |
