# Stage 01: data model, defaults, validation

> **Status: done 2026-08-26.**

**Repo:** `C:\GIT\ButtonFu` (`buttonfu-extension/`)
**Prerequisites:** none. This is the first stage.
**Block:** 1.

Adds the `ClaudeCommand` button type and everything a stored button needs to describe a Claude
launch. No UI, no execution: the deliverable is that a Claude button can be created, validated,
round-tripped through storage and the agent API, and read back unchanged.

## Touch points

| File | Change |
|---|---|
| `src/types.ts` | `ClaudeCommand` in `ButtonType`; new `ClaudeDestination` type; 12 `claude*` fields on `ButtonConfig`; `BUTTON_TYPES` export; four constant tables; `BUTTON_TYPE_INFO` entry; `createDefaultButton` defaults |
| `src/buttonApiService.ts` | `ALLOWED_FIELDS` (line 18) gains all twelve `claude*` fields; the two `VALID_TYPES` checks (72, 103) import `BUTTON_TYPES` instead of a local list |
| `src/apiSchema.ts` | `type` enum (line 78) gains `ClaudeCommand`; new field rows after `copilotAttachActiveFile` (line 85); one example in the examples block |
| `package.json` | new setting `buttonfu.claude.defaultPermissionMode` |
| `src/test/buttonStore.test.ts`, `src/test/buttonApiService.test.ts`, `src/test/apiSchema.test.ts` | round-trip and validation coverage for the new type (the suite lives in `src/test/`, not `tests/`) |
| `src/buttonStore.ts` | `migrateButton` and the workspace-button normaliser both enumerate fields explicitly, so both had to carry the twelve `claude*` fields or a round-trip silently dropped them; `VALID_BUTTON_TYPES` now points at `BUTTON_TYPES` |
| `src/extension.ts` | the `buttonfu.api.createButton` handler reads the new setting and passes it to `createButton`, so `buttonApiService` stays free of `vscode` |

## Design

### `ButtonType` and `BUTTON_TYPES`

`src/types.ts:8` becomes a five-member union. Export the runtime list beside it, because three
files currently hardcode their own copy:

```ts
export type ButtonType =
    | 'TerminalCommand'
    | 'PaletteAction'
    | 'TaskExecution'
    | 'CopilotCommand'
    | 'ClaudeCommand';

/** Every valid button type, in editor display order. The single source of truth. */
export const BUTTON_TYPES: readonly ButtonType[] =
    ['TerminalCommand', 'PaletteAction', 'TaskExecution', 'CopilotCommand', 'ClaudeCommand'];
```

`src/buttonApiService.ts:72` and `:103` currently test against a local `VALID_TYPES`. Point that
constant at `BUTTON_TYPES` rather than maintaining a second list. `src/editorPanel.ts:248` and
`:465` hold two more copies; **leave those to stage 07**, which owns that file.

### `ClaudeDestination`

```ts
/** Where a ClaudeCommand button starts its session. */
export type ClaudeDestination =
    | 'terminalHere'        // integrated terminal in this window
    | 'terminalNewWindow'   // editor terminal, torn off into its own window
    | 'externalTerminal'    // a terminal outside VS Code entirely
    | 'newVsCodeWindow'     // a new VS Code window on another folder, seeded on startup
    | 'panelPrefill'        // the native Claude panel, prompt typed but NOT sent
    | 'headlessThenPanel'   // run with no UI, then open the finished session in the panel
    | 'backgroundAgent';    // claude --bg, managed from the agents list
```

### New `ButtonConfig` fields

Append after `copilotAttachActiveFile` (`src/types.ts:158`), each with a doc comment naming the
destinations it applies to:

```ts
/** For ClaudeCommand: where the session starts. */
claudeDestination?: ClaudeDestination;
/** For ClaudeCommand: model alias or full name. Empty means the CLI default. */
claudeModel?: string;
/** For ClaudeCommand: effort level. Empty means the CLI default. */
claudeEffort?: string;
/** For ClaudeCommand: permission mode passed to --permission-mode. */
claudePermissionMode?: string;
/** For ClaudeCommand: working directory. Empty means the first workspace folder. Token-resolved. */
claudeCwd?: string;
/** For ClaudeCommand, newVsCodeWindow only: the folder the new window opens. Token-resolved. */
claudeTargetFolder?: string;
/** For ClaudeCommand: session display name passed to -n. Empty means the button name. */
claudeSessionName?: string;
/** For ClaudeCommand: extra directories passed as repeated --add-dir. Token-resolved. */
claudeAddDirs?: string[];
/** For ClaudeCommand: run the session in a fresh git worktree (--worktree). */
claudeWorktree?: boolean;
/** For ClaudeCommand: optional name for that worktree. Ignored unless claudeWorktree is true. */
claudeWorktreeName?: string;
/** For ClaudeCommand: extra CLI arguments, already split into argv entries. Not shell-parsed. */
claudeExtraArgs?: string[];
/** For ClaudeCommand, panel destinations only: move the Claude panel into its own window. */
claudeNewWindow?: boolean;
```

Every field is optional, so existing stored buttons deserialise untouched (BC1).

`claudeExtraArgs` is an **argv array, not a command line**. Nothing splits it on spaces and
nothing passes it through a shell, so `--append-system-prompt` and its value are two entries.
Say that in the doc comment and again in the editor help text in stage 07.

### Constant tables

Beside `COPILOT_MODES` (`src/types.ts:487`):

```ts
export const CLAUDE_PERMISSION_MODES =
    ['bypassPermissions', 'acceptEdits', 'auto', 'plan', 'manual', 'dontAsk'];

export const CLAUDE_EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];

/** Suggestions only. The field stays free text so a full model name works. */
export const CLAUDE_MODEL_SUGGESTIONS = ['opus', 'sonnet', 'haiku', 'fable'];

export const CLAUDE_DESTINATION_INFO: Record<ClaudeDestination,
    { label: string; description: string; runsPrompt: boolean; needsFolder: boolean }> = { ... };
```

`CLAUDE_DESTINATION_INFO` is what the editor renders and what the run-time notifications quote,
so write the descriptions as user-facing copy, in one line each. Two flags carry real behaviour:

- `runsPrompt` is `false` for `panelPrefill` alone. The editor uses it to warn, and stage 05 uses
  it to word its notification (BC5).
- `needsFolder` is `true` for `newVsCodeWindow` alone, which is the only destination where
  `claudeTargetFolder` is required.

Order the record the way the editor should list it: `terminalHere`, `terminalNewWindow`,
`externalTerminal`, `newVsCodeWindow`, `backgroundAgent`, `headlessThenPanel`, `panelPrefill`.
Everyday first, oddest last.

### `BUTTON_TYPE_INFO` entry

At `src/types.ts:490`:

```ts
ClaudeCommand: {
    label: 'Claude Command',
    description: 'Starts a Claude Code session with the prompt already running',
    icon: 'sparkle'
}
```

Check `sparkle` is in the repo's codicon catalogue in `types.ts`; if it is not, use `robot`.

### Defaults

`createDefaultButton` (`src/types.ts:295`) sets, for every new button regardless of type:

```ts
claudeDestination: 'terminalNewWindow',
claudeModel: '',
claudeEffort: '',
claudePermissionMode: <the buttonfu.claude.defaultPermissionMode setting, or 'bypassPermissions'>,
claudeCwd: '',
claudeTargetFolder: '',
claudeSessionName: '',
claudeAddDirs: [],
claudeWorktree: false,
claudeWorktreeName: '',
claudeExtraArgs: [],
claudeNewWindow: false
```

`createDefaultButton` is a pure function in `types.ts` and must **not** import `vscode`. Read the
setting where the button is created (`buttonApiService.ts:133` and the editor panel) and pass it
in as an optional second parameter: `createDefaultButton(locality, defaultPermissionMode?)`.

> **Superseded by Rob's ruling, 2026-08-26.** The default destination is **`panelPrefill`**, not
> `terminalNewWindow`. Reason: the permission default is unattended, so a running destination means
> the first click on a freshly written button sets an agent loose on files before its author has
> read the prompt back. The panel types the prompt and waits, which makes that first click a
> review step. It lives in `DEFAULT_CLAUDE_DESTINATION` in `types.ts` alongside
> `DEFAULT_CLAUDE_PERMISSION_MODE`, and the same constant is the fallback for an unrecognised
> destination. The editor warns on it and hides the fields the panel cannot take, and the README
> and changelog say which destination a new button starts on.
>
> This does **not** change `bypassPermissions`, which stays the permission default:

**`bypassPermissions` is the shipped default and that is deliberate** (BC4): a button that stops
on the first permission prompt is not automation. Do not add a confirmation dialog of your own;
`warnBeforeExecution` already exists for buttons that want one.

### New setting

In `package.json` under `contributes.configuration.properties`:

```jsonc
"buttonfu.claude.defaultPermissionMode": {
  "type": "string",
  "enum": ["bypassPermissions", "acceptEdits", "auto", "plan", "manual", "dontAsk"],
  "default": "bypassPermissions",
  "scope": "machine",
  "description": "Permission mode a newly created Claude button starts with. Existing buttons keep whatever they were saved with."
}
```

### Agent API surface

`src/buttonApiService.ts:18` `ALLOWED_FIELDS` gains all twelve `claude*` names, or every field an
agent sets through the bridge is silently dropped. Add per-field validation next to the existing
checks: `claudeDestination` must be a member of the destination union, `claudePermissionMode` a
member of `CLAUDE_PERMISSION_MODES`, `claudeAddDirs` and `claudeExtraArgs` arrays of strings.
Reject with the same message shape the file already uses.

`src/apiSchema.ts` gets the matching rows so an agent reading `buttonfu.api.describe` learns the
fields exist, plus one worked example under the existing examples:

```
{ name: 'Plan this repo', locality: 'Global', type: 'ClaudeCommand',
  executionText: 'Read AGENTS.md and summarise what this repo does.',
  claudeDestination: 'terminalNewWindow', claudeModel: 'opus', category: 'Claude', icon: 'sparkle' }
```

## Done when

- [x] `npm run check-types` passes.
- [x] `npm run lint` passes.
- [x] `npm test` passes, including new cases: a `ClaudeCommand` button survives a store
      round-trip with every `claude*` field intact; an unknown `claudeDestination` is rejected by
      `buttonApiService`; an existing four-type button still loads with no `claude*` keys.
- [x] `BUTTON_TYPES` is exported and `buttonApiService` uses it rather than a local list.
- [x] `git diff --stat` shows no change to `editorPanel.ts`, `resources/editor.js`,
      `buttonExecutor.ts` or `agentBridge.ts`. Those belong to later stages.
- [x] Stage table in `00-overview.md` updated, status line above flipped to done with the date.

## Concurrency notes

- Another session may be editing this repo. If `npm test` fails inside a file you did not touch,
  wait 20 to 90 seconds and re-run rather than fixing it.
- `src/apiSchema.ts` and `src/buttonApiService.ts` are touched again by stage 08. They are in
  different blocks for exactly that reason; do not pull stage 08's work forward.
