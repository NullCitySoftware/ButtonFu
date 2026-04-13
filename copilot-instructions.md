# ButtonFu — Copilot Instructions

## Project Overview

ButtonFu is a Visual Studio Code extension that provides customizable, clickable buttons in the VS Code sidebar. Users can create buttons that execute terminal commands, PowerShell scripts, VS Code command palette actions, project tasks, and GitHub Copilot prompts — all with a single click.

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
    ├── Version.Base.txt            # Legacy installer version file (not used by current build)
    ├── Version.Build.txt           # Legacy installer version file (not used by current build)
    └── Version.Moniker.txt         # Legacy installer version file (not used by current build)
```

## Architecture

### Data Model

Each button has these properties:
- **id** — unique identifier (generated)
- **name** — display name
- **locality** — `Global` (user settings) or `Local` (workspace state)
- **description** — tooltip text
- **type** — one of: `TerminalCommand`, `PowerShellCommand`, `PaletteAction`, `TaskExecution`, `CopilotCommand`
- **executionText** — the command/script/prompt to execute
- **category** — grouping label for the sidebar tree
- **icon** — codicon name (e.g. `play`, `terminal`, `rocket`)
- **colour** — hex colour string
- **copilotModel** — for CopilotCommand: model ID (e.g. `claude-opus-4.6`)
- **copilotMode** — for CopilotCommand: `agent`, `ask`, `edit`, or `plan`
- **copilotAttachFiles** — for CopilotCommand: array of file paths to attach

### Storage

- **Global buttons** are stored in VS Code user settings under `buttonfu.globalButtons` (available in all workspaces)
- **Local buttons** are stored in workspace state via `context.workspaceState` (specific to the current workspace/project)

### Key Components

| File | Responsibility |
|------|----------------|
| `extension.ts` | Activation, command registration, wiring up store/executor/tree |
| `types.ts` | TypeScript interfaces, enums, icon catalogue, default factories |
| `buttonStore.ts` | CRUD operations for buttons, dual storage (settings + workspace state) |
| `buttonExecutor.ts` | Executes buttons by type — terminal, PowerShell, commands, tasks, Copilot |
| `buttonTreeProvider.ts` | TreeDataProvider for the sidebar, groups buttons by category |
| `editorPanel.ts` | Webview panel for the button editor with icon picker, autocomplete, colour picker |

### Copilot Integration

The `CopilotCommand` button type follows proven patterns for Copilot Chat integration:
1. Focus the Copilot Chat panel
2. Start a new chat session
3. Set the mode (agent/ask/edit/plan) via `workbench.action.chat.setMode.*` commands
4. Set the model via `workbench.action.chat.changeModel` with vendor/id/family from `vscode.lm.selectChatModels()`
5. Attach files via `workbench.action.chat.attachFile`
6. Paste the prompt text and submit via `workbench.action.chat.submit`

Multiple fallback command variants are tried for each step to ensure compatibility across VS Code versions.

## Build & Debug

- **F5** launches the Extension Development Host with the extension loaded
- `npm run compile` — one-shot build
- `npm run watch` — watch mode for development
- `npm run vsce-package` — create VSIX for distribution
- `Installer\Build-Installer.ps1` — full installer build (compile + package + Inno Setup)

## Agent Bridge API

ButtonFu exposes a **named-pipe JSON-RPC 2.0 bridge** that external agents can use to create, read, update, and delete buttons and notes programmatically.

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
- No external runtime dependencies — the extension is self-contained

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
- Drive.NET MCP and CLI may **not be installed** on the development machine. Do **not** assume availability — check first (e.g. `tool_search_tool_regex` for `mcp_drive_net_*` tools, or `Get-Command DriveNet.Cli` in terminal). If unavailable, skip live testing and note the gap.
- Live smoke tests are **never run by default**. They are only executed when the user explicitly requests them.
- The standard simulated test suite (`npm test`) must **always** pass before any live smoke test is attempted.
- Review the checked-in Drive.NET manifests under `buttonfu-extension/tests/drive-net` before extending live smoke coverage so new flows stay aligned with the existing suites.

## Note to Copilot and AI changes

ALWAYS:
- Whenever you are finished fixing code or creating new features, always update the CHANGELOG.md and README.md files with a clear, concise summary of the changes and new features, following the existing format and style.
- Always put new changes in the most recent version section at the top of CHANGELOG, assume that the top section will be the next release version, and update the date to the current date if it is not already set.