# Stage 05: the native panel, prefilled and attached

> **Status: done 2026-08-26.** The interactive checks are stage 10's; see the note below.

**Repo:** `C:\GIT\ButtonFu` (`buttonfu-extension/`)
**Prerequisites:** stages 03 and 04 done.
**Block:** 5. Nothing else runs alongside it.

The two destinations that use Claude's own UI rather than a terminal: `panelPrefill`, which types
the prompt and stops, and `headlessThenPanel`, which runs the whole thing invisibly and then
opens the finished conversation for you to continue.

## Touch points

| File | Change |
|---|---|
| `src/claudeSessionService.ts` | `panelPrefill` and `headlessThenPanel` cases; the panel-opening helper |
| `src/claudePanelBridge.ts` | **new.** Everything that knows about the Claude Code extension's commands and deep link |
| `src/claudeAgentsView.ts` | the second quick-pick action left marked by stage 04 |
| `src/test/claudePanelBridge.test.ts` | **new.** Command-versus-deep-link selection and URL encoding |
| `src/test/claudePanelDestinations.test.ts` | **new.** Both destinations end to end with the panel stubbed: what the prefill says, what the headless run passes, what a cancelled or failed run reports, and the offer-a-terminal fallback |

## Design

### `claudePanelBridge.ts`

One module owns every assumption about another publisher's extension, so that when Anthropic
changes something there is a single file to fix.

```ts
export const CLAUDE_EXTENSION_ID = 'anthropic.claude-code';

export function isClaudeExtensionInstalled(): boolean;
export async function openPanel(opts: { sessionId?: string; prompt?: string; newWindow?: boolean }): Promise<void>;
export function buildDeepLink(opts: { sessionId?: string; prompt?: string }): vscode.Uri;
```

`openPanel` tries, in order:

1. `vscode.commands.executeCommand('claude-vscode.editor.open', sessionId, prompt, vscode.ViewColumn.Active)`,
   guarded by a `vscode.commands.getCommands(true)` membership check so a missing command is a
   fallback rather than a rejected promise.
2. The deep link, through `vscode.env.openExternal(buildDeepLink(...))`.
3. If the extension is not installed at all, one message offering to run the same button through
   `terminalHere` instead, and nothing else.

`buildDeepLink` produces
`vscode://anthropic.claude-code/open?session=<uuid>&prompt=<encoded>`, encoding with
`encodeURIComponent` and omitting either parameter when it is empty. Test the encoding of a
prompt containing `&`, `#`, `+` and a newline.

Note for whoever maintains this: the handler reads `session` and `prompt` off the query string
and forwards them to `claude-vscode.primaryEditor.open`, so the deep link and the command are the
same code path with different plumbing. The deep link is the more robust of the two because it
activates the extension on the way in.

When `newWindow` is true, follow the open with
`vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow')`, which is exactly what
the Claude extension's own "Open in New Window" does.

### `panelPrefill`

Call `openPanel({ prompt, newWindow: button.claudeNewWindow })` and then **say what happened**:

> Prompt is ready in the Claude panel. Press Enter to send it.

This is not a nicety. The prompt reaches the webview as `dataset.initialPrompt` and the webview
calls `setInputText` with it: there is no auto-submit anywhere in that extension, no host message
that sends, and no way for a third-party extension to press Enter inside a webview (BC5). A user
who thinks this destination runs the prompt will conclude the button is broken.

The editor in stage 07 says the same thing next to the destination, using the `runsPrompt: false`
flag from `CLAUDE_DESTINATION_INFO`.

Two more behaviours to get right:

- The panel refuses to seed a session that is already open, showing *"Session is already open.
  Your prompt was not applied, enter it manually."* That message comes from the other extension,
  not from ButtonFu. Do not try to detect or pre-empt it.
- `claudeModel`, `claudeEffort` and `claudePermissionMode` **cannot** be passed this way. The
  panel takes a session id and a prompt and nothing else. Log one line to the output channel
  naming the fields that were ignored, and grey them out in the editor for this destination.

### `headlessThenPanel`

```
claude --session-id <uuid> [flags] -p --output-format text <prompt>
```

Run it with `execFile` (argv, no shell, `cwd` set), wrapped in
`vscode.window.withProgress({ location: ProgressLocation.Notification, cancellable: true })`.
Cancellation kills the child process; a killed run reports as cancelled, not as failed.

On exit code 0, call `openPanel({ sessionId, newWindow: button.claudeNewWindow })`. The uuid
ButtonFu minted is the same uuid the session was written under
(`~/.claude/projects/<slugified-cwd>/<uuid>.jsonl`), which is the whole reason the two halves fit
together (BC7).

The completion notification carries two actions:

- **Open in panel**, in case the automatic open was dismissed or the panel failed to resume.
- **Copy resume command**, which puts `claude --resume <uuid>` on the clipboard. This is the
  escape hatch if the panel cannot resume the session for any reason, and it costs three lines.

On a non-zero exit, show the last line of `stderr` and keep the full output in the channel.
A headless run can be long; the progress notification shows elapsed seconds so it does not look
hung.

### The agents quick-pick

Fill in the insertion point stage 04 left: picking a background session now also offers **Open in
the Claude panel**, which is `openPanel({ sessionId })`. Same helper, no new plumbing.

## Done when

- [x] `npm run check-types`, `npm run lint` and `npm test` pass.
- [x] A `panelPrefill` button opens the Claude panel with the prompt typed and **not** sent, and
      the notification says so in those words.
- [x] The same button with `claudeNewWindow` on lands the panel in its own window.
- [x] A `headlessThenPanel` button shows progress, completes, and opens the panel on a
      conversation that already contains the prompt and Claude's reply.
- [x] Cancelling a headless run stops the process and reports cancelled.
- [x] Uninstalling or disabling the Claude Code extension turns both destinations into the
      offer-a-terminal message rather than an unhandled rejection.
- [x] Stage table in `00-overview.md` updated, status line flipped to done with the date.

## Notes from the run

- **`openPanel` returns a boolean rather than showing its own message.** Whether the Claude Code
  extension is missing matters to two callers with different things to offer - a launch can fall
  back to a terminal, the agents list cannot - so the decision belongs to them.
- **The fallback is proved without touching anyone's extensions.** Disabling the real extension
  would affect every window on the machine, so the test drives the `false` return directly. The
  interactive confirmation belongs to stage 10, in an Extension Development Host.
- **The interactive checks belong to stage 10**, as with stages 03 and 04: a real prefill, a real
  headless run and a real cancellation all cost a live session, and stage 10's matrix covers them.

## Concurrency notes

- **`src/claudeSessionService.ts` is shared with stages 03, 04 and 06.** One at a time.
- Disabling the Claude Code extension to test the fallback affects **every** VS Code window on
  the machine, including sessions Rob is running. Do it in the Extension Development Host only,
  where the host has its own extension state, and never in the main window.
