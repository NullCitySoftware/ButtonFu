# ButtonFu - Copilot Instructions

## Project Overview

ButtonFu is a Visual Studio Code extension that provides customizable, clickable buttons in the VS Code sidebar. Users can create buttons that execute terminal commands, PowerShell scripts, VS Code command palette actions, project tasks, and GitHub Copilot prompts - all with a single click.

## Repository Structure

```
ButtonFu/
├── ButtonFu.sln                    # Solution file for Visual Studio
├── copilot-instructions.md         # This file
├── .vscode/
│   ├── launch.json                 # F5 debug configurations (Extension Host)
│   └── tasks.json                  # Build tasks (compile, watch, package)
├── buttonfu-extension/             # VS Code extension source
│   ├── package.json                # Extension manifest, commands, contributes
│   ├── tsconfig.json               # TypeScript configuration
│   ├── esbuild.js                  # Build script with version injection
│   ├── buttonfu-extension.esproj   # Visual Studio JS project
│   ├── .vscodeignore               # What stays out of the VSIX: sources, tests, scripts, notes
│   ├── scripts/
│   │   ├── preflight-release.js    # Pre-release gate: version, changelog, what the public already has
│   │   ├── verify-package.js       # Opens the built VSIX and checks it says and holds the right things
│   │   └── publish-release.js      # Publishes that exact verified file, by path
│   ├── resources/
│   │   └── icon.svg                # Activity bar icon
│   └── src/
│       ├── extension.ts            # Extension entry point, command registration
│       ├── types.ts                # Shared types: ButtonConfig, ButtonType, icon list
│       ├── buttonStore.ts          # Persistence: global settings + workspace state
│       ├── buttonExecutor.ts       # Execution logic for all 5 button types
│       ├── buttonTreeProvider.ts   # Sidebar tree view provider with categories
│       ├── editorPanel.ts          # Webview-based button editor UI
│       └── buildInfo.ts            # Build metadata injected by esbuild
└── Installer/
    ├── Build-Installer.ps1         # PowerShell build/package script using buttonfu-extension/package.json version
    ├── ButtonFu.iss                # Inno Setup installer script
    ├── ButtonFu.Installer.proj      # MSBuild project for Solution Explorer
    ├── License.rtf                 # MIT license for installer wizard
    ├── Deployment.md               # Build & deployment guide
    └── Version.Build.txt           # Build number, claimed by each production build and stamped into the setup
```

## Architecture

### Data Model

Each button has these properties:
- **id** - unique identifier (generated)
- **name** - display name
- **locality** - `Global` (user settings) or `Local` (workspace state)
- **description** - tooltip text
- **type** - one of: `TerminalCommand`, `PaletteAction`, `TaskExecution`, `CopilotCommand`, `ClaudeCommand`. `BUTTON_TYPES` in `types.ts` is the single source of truth; do not write a fourth copy of the list
- **executionText** - the command/script/prompt to execute
- **category** - grouping label for the sidebar tree
- **icon** - codicon name (e.g. `play`, `terminal`, `rocket`)
- **colour** - hex colour string
- **copilotModel** - for CopilotCommand: model ID (e.g. `claude-opus-4.6`)
- **copilotMode** - for CopilotCommand: `agent`, `ask`, `edit`, or `plan`
- **copilotAttachFiles** - for CopilotCommand: array of file paths to attach
- **claudeDestination** - for ClaudeCommand: `terminalHere`, `terminalNewWindow`, `externalTerminal`, `newVsCodeWindow`, `backgroundAgent`, `headlessThenPanel` or `panelPrefill`
- **claudeModel**, **claudeEffort**, **claudePermissionMode** - for ClaudeCommand: passed to the CLI. `bypassPermissions` is the default for a new button
- **claudeCwd**, **claudeTargetFolder**, **claudeAddDirs** - for ClaudeCommand: directories, all token-resolved. `claudeTargetFolder` is required for `newVsCodeWindow` only
- **claudeSessionName**, **claudeWorktree**, **claudeWorktreeName**, **claudeNewWindow** - for ClaudeCommand: session naming, git worktree, and whether a panel destination opens in its own window
- **claudeExtraArgs** - for ClaudeCommand: extra CLI arguments as argv entries. Nothing splits them on spaces, so a flag and its value are two entries

### Storage

- **Global buttons** are stored in VS Code user settings under `buttonfu.globalButtons` (available in all workspaces)
- **Local buttons** are stored in workspace state via `context.workspaceState` (specific to the current workspace/project)

### Key Components

| File | Responsibility |
|------|----------------|
| `extension.ts` | Activation, command registration, wiring up store/executor/tree |
| `types.ts` | TypeScript interfaces, enums, icon catalogue, default factories |
| `buttonStore.ts` | CRUD operations for buttons, dual storage (settings + workspace state) |
| `buttonExecutor.ts` | Executes buttons by type - terminal, PowerShell, commands, tasks, Copilot |
| `buttonTreeProvider.ts` | TreeDataProvider for the sidebar, groups buttons by category |
| `editorPanel.ts` | Webview panel for the button editor with icon picker, autocomplete, colour picker |
| `claudeCommandBuilder.ts` | Pure argv building and the launcher scripts. No `vscode` import, and it must stay that way |
| `claudeExecutable.ts` | Finds the Claude CLI, and finds this window's IDE lock file |
| `claudeSessionService.ts` | Every Claude launch: request assembly, and one method per destination |
| `claudePanelBridge.ts` | The only file that knows the Claude Code extension's command names and deep link |
| `claudeHandoff.ts` | The job file that gets a session running in a brand new VS Code window |
| `claudeAgentsView.ts` | The background-agents quick pick |

### Copilot Integration

The `CopilotCommand` button type follows proven patterns for Copilot Chat integration:
1. Focus the Copilot Chat panel
2. Start a new chat session
3. Set the mode (agent/ask/edit/plan) via `workbench.action.chat.setMode.*` commands
4. Set the model via `workbench.action.chat.changeModel` with vendor/id/family from `vscode.lm.selectChatModels()`
5. Attach files via `workbench.action.chat.attachFile`
6. Paste the prompt text and submit via `workbench.action.chat.submit`

Multiple fallback command variants are tried for each step to ensure compatibility across VS Code versions.

### Claude Integration

Three facts about Claude Code that are expensive to rediscover:

1. **A prompt seeded into the Claude panel is typed, never sent.** `claude-vscode.editor.open`, `claude-vscode.primaryEditor.open` and the `vscode://anthropic.claude-code/open` deep link all reach the webview as its initial text, which it types into the box and stops. There is no auto-submit path and no way for another extension to press Enter inside a webview, so the `panelPrefill` destination says so in its own notification. Only the CLI runs a prompt: `claude "prompt"` sends the positional argument as the first turn.

2. **A prompt never goes on a command line.** Every destination builds an argv array. Where a shell is unavoidable, because a VS Code terminal takes a string rather than an argument list, the argv is written into a generated launcher script and the terminal only ever receives an invocation of that script. Prompts are prose full of quotes, dollars, backticks and newlines, and PowerShell would eat them.

3. **`code.exe` cannot run a command in the window it opens**, and neither can `vscode.openFolder`. That is why `newVsCodeWindow` writes a job file into global storage and the new window claims it at startup, with the claim being a rename because a rename is atomic and the loser of a race is told so.

One more, easy to break by accident: **never pass `env` or `strictEnv` when creating a terminal for Claude.** The Claude extension publishes `CLAUDE_CODE_SSE_PORT` through its environment variable collection, which VS Code applies to every terminal in the window whoever created it, and that variable is what makes the session a real VS Code session. `strictEnv` drops it silently, leaving a session that works but cannot see the editor. The Claude extension's own terminal code does pass it, because it supplies the environment itself; that one line must not be copied.

## Build & Debug

- **F5** launches the Extension Development Host with the extension loaded
- `npm run compile` - one-shot build
- `npm run watch` - watch mode for development
- `npm run vsce-package` - create a VSIX without the release gates, for a hand install
- `Installer\Build-Installer.ps1` - full installer build (compile + package + verify + Inno Setup)

## Releasing

**`npm run publish-extension` is the only way a version reaches the public.** It runs, in order:
preflight, the full test suite, a production build, package verification, and then publishes the
exact file it just verified.

- `npm run preflight` - refuses to go on unless `package.json` names a plain `major.minor.patch`
  version, `CHANGELOG.md` has a `## [version]` section for it, and the Marketplace is currently
  serving something older. It warns, without blocking, when the extension has uncommitted changes,
  because the published build then matches no commit.
- `npm run verify-package` - opens the built VSIX and checks the version in its manifest and its
  inner `package.json` agree with this tree, that everything the extension needs at runtime is
  present, and that no sources, tests, scripts, notes, source maps or nested packages rode along.
  CI and the installer run this same script, so there is one definition of a good package.
- `npm run release` - everything above except the publish, for a dry run.

Publishing uses the stored `nullcity` publisher credential. `npx vsce ls-publishers` lists it, but
that only proves a token was saved, not that it still works: an Azure DevOps Personal Access Token
expires after at most a year, and an expired one fails at the publish step with
`TF400813: The user ... is not authorized`. To restore it, mint a new token on
<https://dev.azure.com> for **all accessible organizations** with the **Marketplace: Manage** scope,
then `npx vsce login nullcity` and paste it at the prompt. Nothing else in the release path needs
the token, so a package can always be built and verified without one.

Do **not** reach for `vsce publish` directly. On its own it rebuilds from the working tree, so what
reaches the public is not the artifact anything was checked against, and it skips every gate above.
The Marketplace once sat on 1.1.3 while the repo had moved through 1.2.0 and 1.3.0, precisely
because packaging and publishing were separate hand-run steps with nothing comparing the two.

## Agent Bridge API

ButtonFu exposes a **named-pipe JSON-RPC 2.0 bridge** that external agents can use to create, read, update, and delete buttons and notes programmatically.

### ⚠️ Hard rule for automation

> **All button and note mutations MUST go through the ButtonFu Agent Bridge or the registered `buttonfu.api.*` VS Code commands.**
>
> **Do NOT mutate ButtonFu data by editing VS Code storage directly.** This includes:
> - VS Code workspace storage (`state.vscdb` / `context.workspaceState`)
> - The `nullcity.buttonfu` workspace memento
> - VS Code user/machine settings keys `buttonfu.globalButtons` and `buttonfu.globalNotes`
> - Direct file writes to any `.vscdb` or SQLite database
> - Any mechanism that bypasses the ButtonFu API command handlers
>
> Direct writes bypass validation, provenance tracking, UI refresh, and may corrupt or silently lose data. The internal storage format is not a stable API and may change between versions without notice.
>
> **`buttonfu.api.runButton` is the one method that executes anything.** It is off unless `buttonfu.claude.allowBridgeRun` is `true`, and it runs `ClaudeCommand` buttons and nothing else: every other type is refused by type, whatever that setting says. Do not widen it, and do not add a way to run a terminal button over the bridge.

### Helper CLI

The repo includes ready-to-use helper scripts for bridge communication in `buttonfu-extension/scripts/`:

```powershell
# PowerShell - list all buttons
.\buttonfu-extension\scripts\buttonfu-bridge.ps1 -Method listButtons

# PowerShell - create a button
.\buttonfu-extension\scripts\buttonfu-bridge.ps1 -Method createButton -Params '{"name":"Run Tests","locality":"Global","type":"TerminalCommand","executionText":"npm test"}'
```

```bash
# Node.js - list all buttons
node buttonfu-extension/scripts/buttonfu-bridge.js listButtons

# Node.js - create a button
node buttonfu-extension/scripts/buttonfu-bridge.js createButton '{"name":"Run Tests","locality":"Global","type":"TerminalCommand","executionText":"npm test"}'
```

### In-product help command

Run **ButtonFu: Copy Agent Bridge Instructions** from the Command Palette (`buttonfu.copyAgentBridgeInstructions`) to copy the current bridge status, connection details, automation rules, and a ready-to-use example to the clipboard.

### Enabling the bridge

Set `buttonfu.enableAgentBridge` to `true` in VS Code settings. When enabled, the extension starts a named-pipe server and writes a discovery file.

### Discovering the bridge

The bridge writes a JSON file to `~/.buttonfu/bridge-{pid}.json` with:

```json
{
  "discoveryVersion": 3,
  "bridgeName": "ButtonFu Agent Bridge",
  "extensionVersion": "{version}",
  "pipeName": "\\\\.\\pipe\\buttonfu-vscode-{pid}",
  "authToken": "<256-bit hex token>",
  "protocol": "jsonrpc-2.0",
  "framing": "newline-delimited",
  "transportKind": "named-pipe",
  "describeMethod": "buttonfu.api.describe",
  "schemaVersion": 2,
  "capabilities": ["buttons", "notes", "introspection", "batch-operations"],
  "limits": {
    "maxMessageBytes": 1048576,
    "maxConnections": 3,
    "rateLimitWindowMs": 60000,
    "rateLimitMaxRequests": 60
  },
  "pid": 12345,
  "startedAt": "2026-04-12T10:00:00.000Z"
}
```

On Unix, `pipeName` is `~/.buttonfu/buttonfu-vscode-{pid}.sock`. Scan `~/.buttonfu/bridge-*.json` to find active instances.

### Authentication

Every JSON-RPC request must include an `"auth"` field with the `authToken` from the discovery file:

```json
{ "jsonrpc": "2.0", "id": 1, "method": "buttonfu.api.listButtons", "auth": "<token>" }
```

### Self-describing schema

Call `buttonfu.api.describe` to get the full API schema at runtime:

```json
{ "jsonrpc": "2.0", "id": 1, "method": "buttonfu.api.describe", "auth": "<token>" }
```

This returns all available methods, parameter schemas, type definitions, examples, and error codes.

### Available methods

| Method | Description |
|--------|-------------|
| `buttonfu.api.describe` | Returns full API schema (introspection) |
| `buttonfu.api.createButton` | Create one or more buttons |
| `buttonfu.api.getButton` | Get a button by ID |
| `buttonfu.api.listButtons` | List all buttons (optional locality filter) |
| `buttonfu.api.updateButton` | Update a button's fields |
| `buttonfu.api.deleteButton` | Delete one or more buttons |
| `buttonfu.api.createNote` | Create one or more notes |
| `buttonfu.api.getNote` | Get a note by ID |
| `buttonfu.api.listNotes` | List all notes (optional locality filter) |
| `buttonfu.api.updateNote` | Update a note's fields |
| `buttonfu.api.deleteNote` | Delete one or more notes |
| `buttonfu.api.runButton` | Run a Claude button. Off by default, and refuses every other button type |

### Quick example: create a button

```json
→ { "jsonrpc": "2.0", "id": 1, "method": "buttonfu.api.createButton", "auth": "<token>",
    "params": { "name": "Run Tests", "locality": "Global", "type": "TerminalCommand", "executionText": "npm test" } }

← { "jsonrpc": "2.0", "id": 1, "result": { "success": true, "data": { "id": "...", "name": "Run Tests", ... } } }
```

### Error codes

| Code | Meaning |
|------|---------|
| -32000 | Authentication failed |
| -32001 | Rate limited (60 req/60s) |
| -32002 | Message too large (>1 MB) |
| -32600 | Invalid JSON-RPC request |
| -32601 | Method not in allowlist |
| -32603 | Internal error |
| -32700 | JSON parse error |

### Security model

- **Transport**: OS named pipes / Unix domain sockets (no network exposure). On Windows, named pipes are inherently same-user. On Unix, the bridge directory is enforced to `0o700`, and both the socket and discovery file are written with `0o600` permissions.
- **Auth**: Per-session 256-bit random token, timing-safe comparison
- **Allowlist**: The bridge permits the 10 CRUD methods, `describe`, `getBridgeContext`, and `listBridges`
- **Rate limiting**: 60 requests per 60 seconds per connection
- **Size cap**: 1 MB max message
- **Concurrency**: 3 max simultaneous connections
- **Sanitization**: UI side-effect flags such as `openEditor` are stripped from all bridge request params, including objects nested inside arrays

## Coding Conventions

- TypeScript strict mode enabled
- esbuild for bundling (CJS format, external: vscode)
- VS Code Webview API for the editor UI (CSP with nonce)
- Codicons for all iconography
- VS Code theme CSS variables for consistent styling
- No external runtime dependencies - the extension is self-contained

## Testing Strategy

### Standard Testing (always run)

Run `npm test` from the `buttonfu-extension` directory. npm runs the `pretest` hook first, then the test script itself. The full sequence is:

1. **Compile prep** via `pretest`
2. **Type checking + webview JS parse check + extension build** via `compile` (`npm run check-types`, `npm run check-webview-js`, `node esbuild.js`)
3. **Linting** (`eslint src`)
4. **Test compilation** (`tsc -p tsconfig.test.json` → `.test-out/`)
5. **Node test runner** (`node scripts/run-node-tests.js`)

Tests use a custom harness (`src/test/helpers/fakeVscode.ts`) that mocks the entire `vscode` API in-process, and a webview runtime simulator (`src/test/helpers/webviewRuntime.ts`) that uses `vm.createContext()` with `FakeDocument`/`FakeElement`/`FakeWindow` to exercise webview `<script>` blocks outside a browser.

**Limitation:** These tests verify *the extension's own logic* against a simulated VS Code API surface. They do not detect breaking changes in VS Code itself (renamed commands, altered webview lifecycle, changed message delivery semantics, etc.).

### Live Smoke Testing (on request only)

When explicitly requested (e.g. "run a live smoke test"), use the **Drive.NET** MCP tools or CLI to perform end-to-end validation inside a real VS Code Extension Development Host:

1. Launch the Extension Development Host via F5 / the `launch.json` configuration.
2. Use Drive.NET `session` → `discover` / `connectWait` to attach to the Extension Host process.
3. Use Drive.NET `query`, `interact`, `assert`, `capture`, and `wait_for` to exercise the real sidebar panel, button editor webview, note editor, colour picker, alpha slider, etc.
4. `capture` screenshots for visual verification if needed.

**Important caveats:**
- Drive.NET MCP and CLI may **not be installed** on the development machine. Do **not** assume availability - check first (e.g. `tool_search_tool_regex` for `mcp_drive_net_*` tools, or `Get-Command DriveNet.Cli` in terminal). If unavailable, skip live testing and note the gap.
- Live smoke tests are **never run by default**. They are only executed when the user explicitly requests them.
- The standard simulated test suite (`npm test`) must **always** pass before any live smoke test is attempted.
- Review the checked-in Drive.NET manifests under `buttonfu-extension/tests/drive-net` before extending live smoke coverage so new flows stay aligned with the existing suites.

## Note to Copilot and AI changes

ALWAYS:
- Whenever you are finished fixing code or creating new features, always update the CHANGELOG.md and README.md files with a clear, concise summary of the changes and new features, following the existing format and style.
- Always put new changes in the most recent version section at the top of CHANGELOG, assume that the top section will be the next release version, and update the date to the current date if it is not already set.