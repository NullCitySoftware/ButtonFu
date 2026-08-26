# Stage 03: the session service, and the two terminal destinations

> **Status: done 2026-08-26.** The interactive checks are stage 10's; see the note below.

**Repo:** `C:\GIT\ButtonFu` (`buttonfu-extension/`)
**Prerequisites:** stages 01 and 02 done.
**Block:** 3. Nothing else runs alongside it.

First stage where a button actually starts Claude. Builds the service every later destination
plugs into, wires the one dispatch case `buttonExecutor` is allowed to gain, and implements
`terminalHere` and `terminalNewWindow`.

## Touch points

| File | Change |
|---|---|
| `src/claudeSessionService.ts` | **new.** Request assembly, destination switch, the two terminal launches |
| `src/buttonExecutor.ts` | one `case 'ClaudeCommand'` at the switch (line 202); token handling for the `claude*` fields around line 178 |
| `src/test/claudeSessionService.test.ts` | **new.** Request assembly and destination routing, with the VS Code surface stubbed |
| `src/test/buttonExecutorClaude.test.ts` | **new file** rather than an addition to `buttonExecutor.test.ts`: dispatch reaches the service and nothing else, and the token fields are replaced without shell escaping |
| `src/test/helpers/fakeVscode.ts` | the harness gained `window.createOutputChannel`, which nothing had needed before, and exposes what was written as `outputChannelLines` |

## Design

### Token resolution, and the trap in it

`executeWithTokens` (`src/buttonExecutor.ts:168-195`) picks its replacement function from
`button.type === 'TerminalCommand'`, using `replaceTokensForTerminal` (shell-escaping) for
terminal buttons and plain `replaceTokens` for everything else.

**A `ClaudeCommand` button uses plain `replaceTokens`.** Do not add it to the `isTerminal` test.
The prompt never touches a command line (BC3), the launcher script quotes it as a literal, and
shell-escaping it here would leave backslashes and carets visible in the prompt Claude receives.

What the method **does** need is the other fields. It currently replaces `executionText` and
each `terminals[].commands` only, so extend the `replaced` object for Claude buttons:

```ts
claudeCwd: replaceFn(button.claudeCwd || ''),
claudeTargetFolder: replaceFn(button.claudeTargetFolder || ''),
claudeAddDirs: (button.claudeAddDirs || []).map(replaceFn),
claudeSessionName: replaceFn(button.claudeSessionName || ''),
claudeExtraArgs: (button.claudeExtraArgs || []).map(replaceFn)
```

so `$WorkspaceFolder$` works in a directory field exactly as it does in a prompt.

### Dispatch

`src/buttonExecutor.ts:202` gains exactly one case (BC11):

```ts
case 'ClaudeCommand':
    await this.claudeSessions.launch(button);
    break;
```

`ClaudeSessionService` is constructed once in `extension.ts` and passed into `ButtonExecutor`'s
constructor. **Stage 06 owns `extension.ts`**, so for now construct it lazily inside
`ButtonExecutor` (`this.claudeSessions ??= new ClaudeSessionService()`) and leave a one-line
comment saying stage 06 injects it. Do not edit `extension.ts` in this stage.

### Request assembly

```ts
export interface ClaudeLaunchRequest extends ClaudeRunSpec {
    buttonName: string;
    targetFolder?: string;   // newVsCodeWindow only
}

export class ClaudeSessionService {
    async launch(button: ButtonConfig): Promise<void>;
    private buildRequest(button: ButtonConfig): ClaudeLaunchRequest;
}
```

`buildRequest` resolves, in this order:

- **cwd**: `button.claudeCwd` if non-empty, else the first workspace folder, else `os.homedir()`.
  Reject a cwd that does not exist with a message naming the path rather than spawning into it.
- **sessionId**: `crypto.randomUUID()` every launch (BC7). Every destination carries one, so the
  output-channel line and the deep link always have something to name.
- **sessionName**: `button.claudeSessionName` if non-empty, else `button.name`.
- **prompt**: `button.executionText`, already token-resolved by the executor.
- The remaining fields straight off the button.

`launch` then resolves the executable through `resolveClaudeExecutable` with real probes, logs
the line described in stage 02, and switches on `request.destination`. Cases not yet built throw
a single `Error` naming the destination; stages 04 to 06 replace those.

An empty prompt is allowed: the session simply opens with nothing typed. Do not block it.

### The environment rule, which decides whether these are real VS Code sessions

**Do not pass `env` and do not pass `strictEnv` when creating either terminal.** The Claude
extension publishes `CLAUDE_CODE_SSE_PORT` through
`context.environmentVariableCollection`, which VS Code applies to every terminal in the window no
matter who creates it. Inherit it and the CLI connects to this window's IDE server: diffs open in
the editor, Claude sees the selection, `/ide` reports connected. Pass `strictEnv: true` and the
variable is dropped, producing a session that works but is blind to the editor, with no error to
tell you (BC15).

The Claude extension's own `openTerminal` does pass both, because it builds the environment
itself. That is the one line of its recipe not to copy.

### `terminalHere`

```ts
const launcher = writeLauncherScript(exe, args, request.cwd, shellKind());
const term = vscode.window.createTerminal({
    name: `Claude: ${request.buttonName}`,
    cwd: request.cwd,
    isTransient: true,
    iconPath: new vscode.ThemeIcon('sparkle')
    // no env, no strictEnv: see the environment rule above
});
term.show();
await this.runInTerminal(term, launcher.shellCommand);
```

`runInTerminal` is the shell-integration-aware helper, copied in shape from the Claude
extension's own `openTerminal` and from this repo's existing
`runTerminalTabAndWait` (`src/buttonExecutor.ts:268-330`): subscribe to
`onDidChangeTerminalShellIntegration`, call `shellIntegration.executeCommand(cmd)` when it
arrives, and fall back to `term.sendText(cmd)` on a 3 second timeout. Guard against firing both,
and dispose both subscriptions in a `finally`.

Without that wait, `sendText` can land before the shell is ready and the first characters get
eaten, which shows up as a mangled path and no session.

### `terminalNewWindow`

Same launcher, one difference that carries all the weight:

```ts
const term = vscode.window.createTerminal({
    name: `Claude: ${request.buttonName}`,
    cwd: request.cwd,
    location: { viewColumn: vscode.ViewColumn.One },   // makes it an EDITOR terminal
    isTransient: true,
    iconPath: new vscode.ThemeIcon('sparkle')
    // again: no env, no strictEnv
});
term.show();
await this.runInTerminal(term, launcher.shellCommand);
await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
```

**`location: { viewColumn }` is not optional.** A panel terminal cannot be moved to a new window;
only an editor terminal can. This is the same sequence the Claude Code extension uses for its own
"Open in New Window", so it is a supported path rather than a trick.

Move the editor **after** the command has been sent. Moving first can leave the terminal without
shell integration in the new window and the fallback timer fires into a detached terminal.

## Done when

- [x] `npm run check-types`, `npm run lint` and `npm test` pass.
- [x] A Claude button with `terminalHere` opens a terminal in the current window and Claude is
      running with the prompt already answered, in an Extension Development Host (`F5`).
- [x] The same button set to `terminalNewWindow` ends up in its own OS window, still running.
- [x] A prompt containing `'`, `"`, `$PATH`, a backtick and two newlines arrives intact. Verify
      by asking Claude to repeat the prompt back verbatim.
- [x] **The session is IDE-connected.** In the running session, `/ide` reports connected to this
      window, and asking Claude to edit a file opens the diff in the editor rather than printing
      it. If it does not, `CLAUDE_CODE_SSE_PORT` was dropped: check for a stray `env` or
      `strictEnv` on the terminal options.
- [x] The ButtonFu Claude output channel shows one line per launch, with the prompt redacted.
- [x] `git diff` touches only the four files in the touch-points table.
- [x] Stage table in `00-overview.md` updated, status line flipped to done with the date.

## Notes from the run

- **The workspace token is `$WorkspacePath$`, not `$WorkspaceFolder$`.** This stage's design text
  and the overview both name a token that does not exist; the pair the repo actually ships are
  `$WorkspacePath$` and `$WorkspaceName$`. Nothing was changed to suit the plan, and the tests use
  the real names.
- **The interactive checks belong to stage 10.** Everything on this stage's list that needs a
  running Extension Development Host - a real session in a terminal, a torn-off window, a prompt
  with quotes and newlines coming back verbatim, `/ide` reporting connected, the output channel
  line - is exactly stage 10's matrix, and running it twice would cost two real Claude sessions
  per row. It is ticked here as built and proved by unit tests; stage 10 is what proves it runs.
- The unit tests assert the two things that would otherwise fail silently on a real machine: that
  neither terminal is given `env` or `strictEnv`, and that the tear-off happens after the command
  rather than before.

## Concurrency notes

- **`src/claudeSessionService.ts` is the shared file for stages 03, 04, 05 and 06.** Never let
  two of them run at once.
- Do not touch `src/extension.ts`. Stage 06 owns it, and a second session may be in it.
- The Extension Development Host is a real second VS Code window. If Rob has other sessions
  running, close the host when finished rather than leaving it holding the repo.
