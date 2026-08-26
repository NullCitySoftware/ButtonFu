# Stage 07: the Claude section in the button editor

> **Status: done 2026-08-26.**

**Repo:** `C:\GIT\ButtonFu` (`buttonfu-extension/`)
**Prerequisites:** stage 01 done. Does **not** need 02 to 06.
**Block:** 2, alongside stage 02. Disjoint files, safe to run at the same time.

Everything a person sees when configuring a Claude button. The editor is a webview split across
two files that must be edited together: the HTML and host-side normalisation live in
`src/editorPanel.ts`, the form logic in `resources/editor.js`.

## Touch points

| File | Line | Change |
|---|---|---|
| `src/editorPanel.ts` | 248 | import-validation type list becomes `BUTTON_TYPES` from stage 01 |
| | 465 | the second local `validTypes` list becomes `BUTTON_TYPES` |
| | 485-490 | normalise the twelve `claude*` fields alongside the `copilot*` ones |
| | 568 | serialise the Claude constant tables into the webview beside `modesJson` |
| | 1031-1041 | `.claude-section` styles beside `.copilot-section` |
| | 1810 | `<option value="ClaudeCommand">Claude Command</option>` |
| | 1918-1956 | the new `<div class="claude-section" id="claudeSection">` block, after the Copilot block |
| | 2589-2591 | button-list meta tag for Claude buttons |
| | 2731-2734 | the blank-button defaults object |
| `resources/editor.js` | 253, 307, 335, 405, 440, 488, 521, 539 | the matching seven edits, listed below |
| `src/types.ts` | beside `CLAUDE_DESTINATION_INFO` | add `CLAUDE_FIELD_APPLICABILITY` |
| `src/test/editorPanelClaude.test.ts` | | **new file.** Normalisation, save round-trip, test-button passthrough and the destination-driven field visibility. Kept separate from `editorPanel.test.ts` so two sessions are less likely to collide in one file |

The sidebar (`src/buttonPanelProvider.ts`) renders name, icon, colour and category only and is
type-agnostic. It needs **no** change; do not go looking for one.

## Design

### Field applicability

Not every field means something for every destination. Put the table in `types.ts` so the host
and the webview cannot drift:

```ts
/** Which claude* fields the editor shows for each destination. */
export const CLAUDE_FIELD_APPLICABILITY: Record<ClaudeDestination, readonly string[]>;
```

- `terminalHere`, `terminalNewWindow`, `externalTerminal`, `newVsCodeWindow`, `backgroundAgent`,
  `headlessThenPanel`: model, effort, permission mode, cwd, session name, add dirs, worktree,
  worktree name, extra args.
- `newVsCodeWindow` additionally: target folder, and it is **required**.
- `panelPrefill`: nothing but the prompt, plus new window. The panel takes a session id and a
  prompt and nothing else, so showing a model picker there would be a lie.
- `headlessThenPanel` additionally: new window.

The webview hides what does not apply rather than disabling it. A greyed-out field invites the
question "why can I not set this"; an absent one does not.

### The Claude section

Mirror the Copilot block's structure at `src/editorPanel.ts:1918-1956` so the file stays legible:

| Control | Id | Notes |
|---|---|---|
| Destination | `btn-claudeDestination` | `<select>` built from `CLAUDE_DESTINATION_INFO`, in the order stage 01 fixed |
| Destination help | `claudeDestinationHelp` | the selected entry's description, replaced on change |
| Prefill warning | `claudeNoRunWarning` | shown only when `runsPrompt` is false: *"This only types the prompt into the Claude panel. You still press Enter to send it."* |
| Model | `btn-claudeModel` | free text with suggestions. Reuse the autocomplete already wired for `btn-copilotModel` (`editorPanel.ts:586`, `resources/editor.js:813`) |
| Effort | `btn-claudeEffort` | `<select>` from `CLAUDE_EFFORTS`, first entry blank meaning "CLI default" |
| Permission mode | `btn-claudePermissionMode` | `<select>` from `CLAUDE_PERMISSION_MODES` |
| Working directory | `btn-claudeCwd` | text plus a folder-browse button. Placeholder: the first workspace folder |
| Folder to open | `btn-claudeTargetFolder` | text plus folder browse. Only for `newVsCodeWindow`, and marked required |
| Session name | `btn-claudeSessionName` | text. Placeholder: the button name |
| Extra directories | `btn-claudeAddDirs` | list editor, same shape as the Copilot attach-files list at `editorPanel.ts:1956` |
| Git worktree | `btn-claudeWorktree` + `btn-claudeWorktreeName` | checkbox; the name field appears only when it is ticked |
| Extra arguments | `btn-claudeExtraArgs` | textarea, **one argument per line** |
| Open in a new window | `btn-claudeNewWindow` | checkbox, panel destinations only |

**The extra-arguments field is the one users will get wrong.** Its help text says: one argument
per line, values on their own line, nothing is shell-parsed. Show the worked example
`--append-system-prompt` on one line and the prompt text on the next.

Permission mode help text, under the select, in plain words rather than flag names: bypass runs
everything without asking, accept-edits writes files but asks before running commands, manual
asks every time. New buttons start on bypass (BC4); say so rather than leaving the user to infer
it from the pre-selected value.

### `resources/editor.js`, edit by edit

1. **253**: the meta-tag block currently special-cases `CopilotCommand` to show the model. Add a
   `ClaudeCommand` arm showing the destination label and, when set, the model.
2. **307-310**: the blank-button object gains the twelve `claude*` defaults, matching
   `createDefaultButton`.
3. **335-340**: populate every new control from the loaded button.
4. **405-408**: collect every new control back into the saved object. `claudeExtraArgs` and
   `claudeAddDirs` split on newlines with blank lines dropped and each entry trimmed.
5. **440**: the duplicate-button path copies arrays with `.slice()`, exactly as
   `copilotAttachFiles` does. A shared array reference between two buttons is a real bug.
6. **488, 521**: `claudeSection.classList.toggle('visible', type === 'ClaudeCommand')`, plus a
   new `applyClaudeDestination()` that runs on load and on destination change, driving field
   visibility from `CLAUDE_FIELD_APPLICABILITY` and the warning from `runsPrompt`.
7. **539-542**: the execution-text help for `ClaudeCommand` reads *"The prompt to send to Claude
   Code."* and the field label becomes "Prompt". It is the same textarea the other types use.

### Host-side normalisation

`src/editorPanel.ts:485-490` coerces incoming values from the webview. Give the Claude fields the
same treatment: strings default to `''`, arrays are filtered to strings, `claudeDestination`
falls back to `terminalNewWindow` when it is not a known member, `claudePermissionMode` falls
back to the `buttonfu.claude.defaultPermissionMode` setting. The webview is not a trust boundary
in the security sense, but it is a version boundary: an older stored button can arrive with
fields missing.

## Done when

- [x] `npm run check-types`, `npm run lint` and `npm run check-webview-js` all pass. That last
      one is `node --check resources/editor.js` and it catches the parse error that otherwise
      shows up as a silently blank editor.
- [x] `npm test` passes with the new normalisation cases.
- [x] In an Extension Development Host: creating a Claude button shows the section; switching
      destination shows and hides the right fields; picking `panelPrefill` shows the warning;
      picking `newVsCodeWindow` marks the folder field required.
- [x] Save, close, reopen: every field round-trips.
- [x] Duplicating a Claude button produces independent arrays, verified by editing one copy.
- [x] The other four button types are visually unchanged.
- [x] Stage table in `00-overview.md` updated, status line flipped to done with the date.

## What the stage found on the way

**`resources/editor.js` never runs.** The inline script in `editorPanel.ts` opens with
`const vscode = acquireVsCodeApi();`, and a classic script's top-level `const` goes into the
global lexical environment shared by every script on the page. `resources/editor.js` opens with
`const vscode = globalThis.vscode;`, so it dies at instantiation with *"Identifier 'vscode' has
already been declared"* before a line of it executes. Proved with two scripts in one `vm` context.
The inline copy is therefore the live code and the external file is a stale duplicate.

Both were edited here, as the plan asked, and both parse. Which one to keep is a question for
Rob rather than a decision for this stage, so it is carved into
[`plans/_future/buttonfu-editor-script-duplication-plan/`](../../_future/buttonfu-editor-script-duplication-plan/00-overview.md),
which names this plan and lays out the two options.

**A newline inside the inline script needs doubling.** The inline script lives in a TypeScript
template literal, so `'
'` written there reaches the browser as a real newline inside a string
literal and the whole webview fails to parse. It has to be `'\n'`. `npm run check-webview-js`
cannot catch this, because it only checks the external file; the webview runtime tests do.

**Each `claude-field` wrapper carries an id** as well as its `data-claude-field` attribute. The
test harness's fake DOM only registers elements that have one, so field visibility would have been
untestable otherwise.

## Concurrency notes

- Stage 02 runs alongside this one and owns `src/claudeCommandBuilder.ts`,
  `src/claudeExecutable.ts` and `package.json`. Do not edit any of them; in particular, do not
  add a setting here.
- `src/editorPanel.ts` is 4,310 lines and its HTML is a template literal. A stray backtick or
  `${` will compile and then break at runtime, which is what `check-webview-js` and the manual
  open are for. Run both before ticking anything.
