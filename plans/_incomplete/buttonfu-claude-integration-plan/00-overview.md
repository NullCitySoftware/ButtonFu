# ButtonFu: Claude Code integration - overview

> **Status: built, awaiting hands-on verification. Parked 2026-08-26.**
>
> **What shipped:** stages 01 to 09, complete. The `ClaudeCommand` button type exists end to end -
> data model, editor UI, all seven destinations, the background-agents view, the new-window
> handoff, the opt-in bridge run method, and the docs. 374 unit tests pass from a clean build,
> lint is clean, and the version reads 1.3.0. Nothing is committed and nothing is published.
>
> **What is left:** stage 10 sections 2 to 5. The Drive.NET UI suite is written but has never run,
> because `DriveNet.Cli.exe` is not installed on this machine. The seven-row destination matrix,
> the regression sweep and the housekeeping all need a person driving an Extension Development
> Host, and every matrix row is a real Claude session billed to Rob's account.
>
> **Settled since:** the argument-order assumption, which was the one thing only a real invocation
> could answer. The real CLI confirms that a prompt placed anywhere but last is swallowed by
> `--add-dir` and the run ends up with no prompt at all, and that the builder's order gets through
> cleanly. See [10-verification.md](10-verification.md).
>
> **What unblocks the rest:** installing the Drive.NET CLI unblocks section 2. Sections 3 to 5 need
> a person at an Extension Development Host. Rob authorised the paid sessions on 2026-08-26, but an
> agent shell here cannot complete one - the CLI reaches argument parsing and then cannot reach the
> API - and in any case the remaining rows are about which window a session lands in, which cannot
> be observed from outside that window.

## What this adds

A **`ClaudeCommand`** button type beside the existing `CopilotCommand`. Clicking it starts a
Claude Code session, in a place you choose, with the prompt already sent and running. Seven
destinations are supported: a terminal in this window, a terminal torn off into its own window,
an external terminal outside VS Code, a brand new VS Code window on another folder, the native
Claude panel (prefilled), a headless run you then attach the panel to, and a background agent.
The prompt goes through ButtonFu's existing token system, so `$WorkspaceFolder$` and user tokens
work exactly as they do for terminal and Copilot buttons.

## Grounding: what the Claude Code tooling actually offers

Read this once; do not re-derive it. Verified 2026-08-26 against the shipped extension
`~/.vscode/extensions/anthropic.claude-code-2.1.246-win32-x64/extension.js` and CLI 2.1.209.

**Extension commands that take arguments** (call with `vscode.commands.executeCommand`):

| Command | Signature |
|---|---|
| `claude-vscode.editor.open` | `(sessionId?: string, prompt?: string, viewColumn?: vscode.ViewColumn)` |
| `claude-vscode.primaryEditor.open` | `(sessionId?: string, prompt?: string)` |
| `claude-vscode.terminal.open` | `(command?: string, args?: string[], location?: 'beside' or 'window')` |
| `claude-vscode.window.open` | no arguments: opens an empty panel, then moves it to a new window |

**URI handler**, usable from anywhere on the machine:

```
vscode://anthropic.claude-code/open?session=<uuid>&prompt=<urlencoded>
```

It forwards to `primaryEditor.open(session, prompt)`.

**The prompt argument does not run.** It reaches the webview as `dataset.initialPrompt` and the
webview calls `setInputText` with it. There is no auto-submit path, no host-to-webview message
that sends, and no way for a third-party extension to press Enter inside a webview. The
clipboard-plus-`workbench.action.chat.submit` trick used for Copilot in
`src/promptActionService.ts:303-309` has no equivalent here. Any UI copy that implies otherwise
is a bug.

`createPanel` also refuses to re-seed a live session, with a visible message: *"Session is
already open. Your prompt was not applied, enter it manually."*

**The extension's own new-window terminal recipe.** Stage 03 copies its shape, with one
deliberate difference marked below and explained under "How a terminal session becomes a real VS
Code session":

```js
const location = { viewColumn: vscode.ViewColumn.One };
const term = vscode.window.createTerminal({ name, cwd, location, isTransient: true });
// the extension also passes { env, strictEnv: true } here. ButtonFu must NOT: see below.
term.show();
// prefer shellIntegration.executeCommand(cmd) once integration arrives;
// fall back to term.sendText(cmd) after a 3s timeout
await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
```

A terminal created with `location: { viewColumn }` is an editor terminal, which is why
`moveEditorToNewWindow` can tear it off. A terminal created with no location cannot be.

**CLI facts that matter here.** The positional argument is the first turn: `claude "prompt"`
starts an interactive session with that prompt already sent. Relevant flags:
`--session-id <uuid>`, `--resume <uuid>`,
`--permission-mode <acceptEdits|auto|bypassPermissions|manual|dontAsk|plan>`,
`--dangerously-skip-permissions`, `--model`, `--effort <low|medium|high|xhigh|max>`,
`-n <name>` (names the session in the prompt box, the picker and the terminal title),
`--add-dir`, `--worktree [name]`, `--bg` (start as a background agent and return immediately),
`-p/--print` with `--output-format text|json|stream-json`, `--max-budget-usd`.
`claude agents --json` lists background sessions without needing a TTY.

Sessions live on disk as `~/.claude/projects/<slugified-cwd>/<uuid>.jsonl`, which is why a uuid
minted by ButtonFu, passed to `--session-id`, is the same uuid the deep link's `?session=` wants.

**Settings the Claude extension honours**, relevant because a button may want to leave them
alone: `claudeCode.useTerminal`, `claudeCode.initialPermissionMode`,
`claudeCode.allowDangerouslySkipPermissions`, `claudeCode.claudeProcessWrapper`,
`claudeCode.preferredLocation`. ButtonFu reads them for defaults where sensible and never writes
them.

**How a terminal session becomes a real VS Code session, and how to lose it by accident.** On
activation the Claude extension starts an IDE server on a random localhost port, writes
`~/.claude/ide/<port>.lock` (carrying `pid`, `workspaceFolders`, `authToken`), and then calls
`context.environmentVariableCollection.replace('CLAUDE_CODE_SSE_PORT', String(port))`. That
collection is applied by VS Code to **every terminal in the window, whoever creates it**, so a
terminal ButtonFu opens inherits the variable and the CLI connects to that window: diffs open in
the editor, the selection is visible to Claude, `/ide` reports connected.

Two consequences the stages depend on:

- **Never pass `strictEnv: true`, and never pass a custom `env`, when creating a terminal for
  Claude.** `strictEnv` tells VS Code to use exactly the environment given and inherit nothing,
  which drops `CLAUDE_CODE_SSE_PORT` and silently produces a session with no IDE connection. The
  Claude extension's own `openTerminal` does pass it, because it supplies the environment itself.
  Copy its shape, not that flag.
- **A process spawned straight from the extension host does not get the variable**, because the
  collection is applied at terminal creation, not to the extension host process. Such a spawn can
  recover it by reading the lock files: the entry whose `pid` equals `process.ppid` is this
  window's, since the lock records the VS Code window process and the extension host is its
  child. Verified on this machine: lock `48622.lock` names pid 26388, which is `Code.exe`.

**`code.exe` has no way to run a command in a new window.** Checked against 1.134.0: there is
`-n/--new-window`, `--folder-uri`, `--profile`, `--add`, and nothing that executes anything. A
new VS Code window therefore needs a handoff (stage 06), not a cleverer command line.

## Locked decisions

Do not re-litigate these. If one proves impossible, stop and say so rather than redesigning
around it.

- **BC1** `ClaudeCommand` is a **new** button type beside `CopilotCommand`. Nothing is migrated,
  renamed or deprecated, and no existing button changes behaviour.
- **BC2** One destination enum covers every launch route:
  `terminalHere`, `terminalNewWindow`, `externalTerminal`, `newVsCodeWindow`, `panelPrefill`,
  `headlessThenPanel`, `backgroundAgent`. No hidden eighth route, no boolean pairs.
- **BC3** **The prompt is never concatenated onto a command line.** Every destination builds an
  `argv` array. Where a shell is genuinely unavoidable (VS Code terminal `sendText`, an external
  terminal), the prompt is written to a temp file and the command reads it back. Prompts are
  prose full of quotes, `$`, backticks and newlines, and PowerShell will eat them.
- **BC4** The default permission mode for a new Claude button is **`bypassPermissions`**
  (unattended), and every mode is offered per button in the editor. Rob's ruling, 2026-08-26.
  The per-button `warnBeforeExecution` flag stays the only confirmation gate; do not add a
  second one, and do not quietly downgrade the default.
- **BC5a** Rob's ruling, 2026-08-26, after the build: **`panelPrefill` is the default destination
  for a new button**, because the permission default is unattended and a running default would
  mean a freshly written button's first click acts on files unreviewed. The panel makes that first
  click a read-back. `DEFAULT_CLAUDE_DESTINATION` in `types.ts` holds it. Also confirmed the same
  day, against the shipped extension 2.1.246: there is **no** way to send from the panel or set its
  model - no submit command among its 24, the deep link takes `session` and `prompt` only, and the
  webview calls `setInputText` and stops. `headlessThenPanel` is the only route to "panel, with a
  model, prompt sent".
- **BC5** `panelPrefill` **prefills and stops**. Its label, help text and any notification say
  so plainly. No attempt to synthesise Enter, no clipboard trickery, no polling the webview.
- **BC6** Claude is located in this order and never hardcoded:
  `buttonfu.claude.executablePath` setting, then `claude` on `PATH`, then the Claude Code
  extension's bundled binary at `<claude ext>/resources/native-binary/claude.exe` (`claude` on
  non-Windows), resolved through
  `vscode.extensions.getExtension('anthropic.claude-code')?.extensionPath`. If none resolve, the
  button fails with one actionable message and does not spawn anything.
- **BC7** Sessions are addressed by a uuid **ButtonFu mints** and passes as `--session-id`.
  Never parse stdout to discover a session id, never guess the newest `.jsonl`.
- **BC8** The cross-window handoff is a **single-consume job file** under
  `context.globalStorageUri`, with a hard expiry and an owning workspace path. Not `globalState`
  (no cross-window change event, no reliable visibility), not the agent bridge, not a socket.
- **BC9** The agent bridge gains exactly one run method, `buttonfu.api.runButton`. It refuses
  any button whose type is not `ClaudeCommand`, and it is inert unless
  `buttonfu.claude.allowBridgeRun` is `true` (default `false`). Rob's ruling, 2026-08-26.
- **BC10** **Notes are out of scope.** Rob's ruling, 2026-08-26. No Claude note action, no note
  editor fields, no `NoteDefaultAction` member. Do not "while I am here" this.
- **BC11** `buttonExecutor.ts` stays a dispatcher: it gains **one** `case 'ClaudeCommand'` and
  nothing else. All Claude logic lives in `src/claudeCommandBuilder.ts` (pure) and
  `src/claudeSessionService.ts` (effects).
- **BC12** **No new runtime dependencies.** Node's `child_process`, `crypto`, `fs`, `os`, `path`
  and the VS Code API only. A new devDependency needs Rob's say-so like anything else.
- **BC13** This plan does not publish. It bumps `buttonfu-extension/package.json` to **1.3.0**
  and writes the changelog entry. The marketplace push, the VSIX and the Inno Setup installer
  build are Rob's to run.
- **BC14** No em dash (U+2014) in any new string, comment, doc or commit message. The repo has
  pre-existing ones in older code and copy; leave those alone, do not add more.
- **BC15** **A launched session must be a real VS Code session wherever it can be.** Terminal
  destinations inherit `CLAUDE_CODE_SSE_PORT` and must not break that inheritance (no
  `strictEnv`, no custom `env`). Destinations that spawn outside a terminal look the port up from
  this window's lock file and pass it explicitly. `backgroundAgent` is the one deliberate
  exception, because it outlives the window it was started from.

## Stage map

Every stage lands in **`C:\GIT\ButtonFu`**, under `buttonfu-extension/` unless stated.

| No. | File | Gist | Status |
|---|---|---|---|
| 01 | [01-data-model.md](01-data-model.md) | `ClaudeCommand` type, config fields, defaults, API validation and schema | **done 2026-08-26** |
| 02 | [02-command-builder.md](02-command-builder.md) | Executable resolution and pure argv building, with unit tests | **done 2026-08-26** |
| 03 | [03-terminal-destinations.md](03-terminal-destinations.md) | `terminalHere` and `terminalNewWindow`, plus the service skeleton | **done 2026-08-26** |
| 04 | [04-external-and-background.md](04-external-and-background.md) | `externalTerminal` and `backgroundAgent`, plus the agents status command | **done 2026-08-26** |
| 05 | [05-panel-destinations.md](05-panel-destinations.md) | `panelPrefill` and `headlessThenPanel` via commands and the deep link | **done 2026-08-26** |
| 06 | [06-new-window-handoff.md](06-new-window-handoff.md) | `newVsCodeWindow`: job queue, startup activation, single-consume pickup | **done 2026-08-26** |
| 07 | [07-editor-ui.md](07-editor-ui.md) | Claude section in the button editor webview and its script | **done 2026-08-26** |
| 08 | [08-agent-bridge-run.md](08-agent-bridge-run.md) | `buttonfu.api.runButton`, Claude-only, setting-gated | **done 2026-08-26** |
| 09 | [09-docs.md](09-docs.md) | README, changelog, agent instructions, version bump | **done 2026-08-26** |
| 10 | [10-verification.md](10-verification.md) | Clean build, unit tests, Drive.NET manifest, all seven destinations driven | **partly done 2026-08-26** |

## Parallelisation

**Blocks run strictly in order. Stages inside a block are order-independent.**

| Block | Stages | Why |
|---|---|---|
| 1 | 01 | Every other stage reads the types this stage adds. |
| 2 | 02, 07 | Disjoint files: 02 owns two new source files, 07 owns the editor webview. Both need only 01. |
| 3 | 03 | Creates `claudeSessionService.ts`. |
| 4 | 04 | Extends `claudeSessionService.ts`. |
| 5 | 05 | Extends `claudeSessionService.ts`. |
| 6 | 06 | Extends `claudeSessionService.ts`, and is the only stage that touches `extension.ts` activation and adds `activationEvents`. |
| 7 | 08 | Touches `agentBridge.ts`, `apiSchema.ts`, `extension.ts`. Serial with 06 on `extension.ts`. |
| 8 | 09 | Documents what the earlier stages actually built. |
| 9 | 10 | Verifies everything against a clean build. |

**Serial-only, named by the shared file:**

- **03, 04, 05, 06** all extend `src/claudeSessionService.ts`. Never run two of them at once.
- **06 and 08** both edit `src/extension.ts`. Never run them at once.
- **01 and 08** both edit `src/apiSchema.ts` and `src/buttonApiService.ts`, which is why 08 sits
  at the far end of the plan rather than beside 01.

Genuine parallelism here is thin: one fan-out (block 2) and a straight lane after it. That is the
honest shape, not a shortcoming.

## Reference list

**Files this plan sits on** (all under `C:\GIT\ButtonFu\buttonfu-extension\`):

| Path | What it is |
|---|---|
| `src/types.ts` | `ButtonType` union (line 8), `TerminalTab` (121), `ButtonConfig` (131), `SYSTEM_TOKENS` (278), `createDefaultButton` (295), `BUTTON_TYPE_INFO` (490) |
| `src/buttonExecutor.ts` | shell-escape gate (178), dispatch switch (202), terminal run and shell integration (223-350), Copilot handoff (429) |
| `src/promptActionService.ts` | token capture and replacement, and the Copilot submit pattern (303-309) |
| `src/tokenResolver.ts` | `captureSystemTokens`, `findTokensInText`, `replaceTokens` |
| `src/buttonApiService.ts` | `ALLOWED_FIELDS` (18), `VALID_TYPES` checks (72, 103), create defaults (133) |
| `src/apiSchema.ts` | agent-facing field documentation (78-105) |
| `src/agentBridge.ts` | named-pipe JSON-RPC server, `ALLOWED_METHODS`, `targetWindowId` check |
| `src/extension.ts` | `activate` (101), bridge wiring (447-520) |
| `src/editorPanel.ts` | editor webview HTML and normalisation (248, 465-490, 1031, 1810, 1918-1956, 2589, 2731) |
| `resources/editor.js` | editor webview script (253, 307, 335, 405, 440, 488, 521, 539) |
| `src/buttonPanelProvider.ts` | sidebar webview. Type-agnostic: it renders name, icon, colour and category only, and needs **no** change |
| `package.json` | no `activationEvents` key today (stage 06 adds one), settings under `contributes.configuration` |
| `tests/*.test.ts` | node test suite, run with `npm test` |
| `tests/drive-net/*.yaml` | live Extension Development Host manifest, run with `npm run test:drive-net` |

**Outside the repo, read-only references:** the Claude Code extension at
`~/.vscode/extensions/anthropic.claude-code-2.1.246-win32-x64/`, and `claude --help`.
