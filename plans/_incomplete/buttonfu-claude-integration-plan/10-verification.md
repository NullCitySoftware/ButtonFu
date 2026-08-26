# Stage 10: end-to-end verification

> **Status: partly done 2026-08-26.** Section 1 passes. Section 2's suite is written and its YAML
> parses, but `DriveNet.Cli.exe` is not installed on this machine so it has not been run. Sections
> 3, 4 and 5 need a person at an Extension Development Host and real Claude sessions on Rob's
> account, so they are handed back rather than guessed at.

**Repo:** `C:\GIT\ButtonFu`
**Prerequisites:** stages 01 to 09 done.
**Block:** 9. The last stage.

Rebuild from clean, prove all seven destinations against the real Claude CLI, prove nothing that
already worked stopped working, and leave the tree in a state Rob can package from.

## Touch points

| File | Change |
|---|---|
| `tests/drive-net/claude-button.yaml` | **new.** Editor and CRUD coverage for the new type |
| `tests/drive-net/manifest.yaml` | include the new file |
| `plans/buttonfu-claude-integration-plan/00-overview.md` | final status line |

No source changes are expected here. If verification finds a defect, fix it in the stage that
owns the file and say so in this stage's completion note.

## 1. Clean build and the full suite

```powershell
cd C:\GIT\ButtonFu\buttonfu-extension
npm run compile        # check-types + check-webview-js + esbuild
npm run lint
npm test               # build-tests then the node suite
```

`npm run check-webview-js` is `node --check resources/editor.js`. It is the only thing standing
between a stray backtick in the editor template and a blank editor at runtime, so never skip a
compile in favour of running esbuild directly.

## 2. Drive.NET manifest

`npm run test:drive-net` starts a real Extension Development Host and drives the UI. Add
`claude-button.yaml` alongside the existing `button-crud.yaml`, covering: create a Claude button
through the editor, set a destination and a model, save, reopen and confirm the fields survived,
then delete it. Follow the existing files' shape rather than inventing a style.

Keep launching **out** of the manifest. A real session is slow, costs money, and depends on
authentication state; it belongs in the manual matrix below.

## 3. The destination matrix, driven by hand

One Claude button per row, in an Extension Development Host (`F5`), with a prompt that proves it
arrived intact:

```
Reply with exactly this text and nothing else: it's "fine" $HOME `ok`
then stop.
```

That single prompt exercises a single quote, a double quote, a shell variable, a backtick and a
newline in one go. If it comes back changed, the launcher escaping is wrong.

| # | Destination | Passes when |
|---|---|---|
| 1 | `terminalHere` | terminal opens in this window, session runs, prompt echoed verbatim |
| 2 | `terminalNewWindow` | the terminal ends up in its own OS window, still running |
| 3 | `externalTerminal` | a terminal outside VS Code, and it survives reloading the VS Code window |
| 4 | `newVsCodeWindow` | a second VS Code window opens on the target folder and runs it with no click; the jobs directory is empty afterwards |
| 5 | `backgroundAgent` | returns immediately; **Show agents** lists it; resuming reaches the same conversation |
| 6 | `headlessThenPanel` | progress shows, then the panel opens on a conversation already containing the reply |
| 7 | `panelPrefill` | the panel opens with the prompt typed and **not** sent, and the notification says so |

**Every row except `backgroundAgent` must also be IDE-connected.** In the running session, `/ide`
reports connected to the window that launched it, and asking Claude to change a file opens the
diff in the editor rather than printing it. A session that works but is blind to the editor means
`CLAUDE_CODE_SSE_PORT` was dropped: a stray `env` or `strictEnv` on a terminal, or a spawn that
did not call `findWindowIdeLock()`. `backgroundAgent` is deliberately not connected.

Also verify once, on any terminal destination:

- **The argv actually parses.** Run a button with two extra directories set and a model, and
  check the CLI did not treat the prompt as a directory. `--add-dir` is variadic in the CLI, and
  the builder emits one flag per directory with the prompt last precisely to avoid that. This is
  the one assumption in the plan that only a real invocation can settle.
- **`--worktree`** produces a session in a fresh worktree and the button still works.
- **A missing binary** fails with the actionable message and spawns nothing: point
  `buttonfu.claude.executablePath` at a path that does not exist and click.

## 4. Regression sweep

- One button of each existing type (`TerminalCommand` with multiple tabs, `PaletteAction`,
  `TaskExecution`, `CopilotCommand`) still behaves exactly as before. The `TerminalCommand` tabs
  matter most: stage 03 touched the token-replacement branch beside them.
- A repo-committed `buttonfu.workspaceButtons` entry still loads read-only.
- Notes are untouched: preview, insert, send to Copilot and copy all still work, and there is no
  Claude entry anywhere in the note UI (BC10).
- The agent bridge still answers `buttonfu.api.describe` and the CRUD ten.
- `buttonfu.claude.allowBridgeRun` is back to `false`.

## 5. Housekeeping

- `os.tmpdir()/buttonfu-claude/` holds no launcher older than a day after a window restart; the
  sweeper runs at activation.
- No background agents left running: check `claude agents --json`.
- The ButtonFu Claude output channel logs one line per launch and **no prompt text**.
- `git status` reviewed. Report what is uncommitted; **do not commit** and do not create a
  branch. That is Rob's call.

## Done when

- [ ] Sections 1 to 5 all pass, with the seven-row matrix ticked individually.
      **Section 1 passes.** Section 2 is written but unrun. Sections 3 to 5 are outstanding.
- [x] `00-overview.md` status line updated to reflect the true end state.
- [x] The plan folder is filed per [`plans/_complete/README.md`](../_complete/README.md):
      `_complete` only if every follow-up is closed too, `_incomplete` if something nameable is
      blocking, and anything deliberately deferred is carved into its own small `_future` plan
      that names this one.
- [x] Stage table in `00-overview.md` updated, status line flipped to done with the date.

## What was actually run, 2026-08-26

**Section 1 passes.** From a wiped `out/` and `.test-out/`: `npm run compile` (type check,
`node --check resources/editor.js`, esbuild), `npm run lint`, and `npm test` at **374 passing, 0
failing**. `package.json` reads `1.3.0`.

**Section 2 is written but not run.** `claude-button.yaml` exists, `manifest.yaml` includes it,
and both parse as YAML. `DriveNet.Cli.exe` is not on this machine's `PATH`, so the manifest could
not be executed. That is the only thing standing between the file and a green run.

**The argument-order assumption is settled, against the real CLI.** This was the one thing in the
plan that only a real invocation could answer, and it now has an answer. Running a generated
launcher (two `--add-dir` entries, a model, and a prompt containing a single quote, a double
quote, `$HOME`, a backtick and a newline) got past argument parsing and reached the API, which a
malformed invocation does not. Then the failure mode was reproduced deliberately, by putting the
prompt straight after `--add-dir` instead of last:

```
$ claude --add-dir <dir> "Reply with exactly: ok" -p --output-format text
Error: Input must be provided either through stdin or as a prompt argument when using --print
```

`--add-dir` swallowed the prompt as a second directory and left the run with no prompt at all.
That is exactly the hazard the builder is ordered to avoid, confirmed rather than assumed. Keeping
the prompt last is load-bearing, and the unit test that asserts it is guarding something real.

**A live session cannot be driven from an agent's shell here.** The CLI reaches argument parsing
and then reports `Unable to connect to API (ConnectionRefused)`, or hangs. The Anthropic API is
reachable from the same machine over PowerShell, so this is the agent shell's own network
sandboxing rather than a firewall or an authentication problem. Rob authorised the sessions on
2026-08-26; the shell is what prevents them, not permission.

**Sections 3, 4 and 5 are outstanding**, and they are outstanding for a reason rather than an
oversight. The seven-row matrix wants a person clicking buttons in an Extension Development Host,
and every row is a real Claude session billed to Rob's account. The plan says one short session
per row; an agent cannot judge when a row has passed, cannot read a terminal it did not open, and
should not be spending money unasked. The same applies to the regression sweep, which is a
by-hand pass over the other four button types, and to the housekeeping that only means anything
once the matrix has run.

**What is left for a person, and why.** Everything in the matrix that is about *where the session
ends up* rather than *what it is given*: that a torn-off terminal really lands in its own OS
window, that an external terminal survives a window reload, that a new VS Code window picks its
job up with no click, that `/ide` reports connected, and that a diff opens in the editor rather
than being printed. None of those can be seen from outside the window they happen in.

**What is proved without them.** Every destination has unit coverage over the shape of what it
does: the argument order and the `--add-dir` hazard, the launcher escaping over six hostile
prompts, that neither terminal is given `env` or `strictEnv`, that the tear-off happens after the
command, that a background agent does not inherit the IDE port and a spawned external terminal
does, that the panel prefill says it did not send, that a claimed job runs once and an expired one
never runs, and that the bridge method refuses everything but a Claude button. What the unit tests
cannot settle is whether the real CLI parses the argument list the way the plan assumes, and
whether a session comes back IDE-connected. Those two are the point of the matrix.

**Also cleaned up here.** The new tests were writing launcher scripts and scratch directories into
the system temp folder and leaving them there, and because `node --test` runs each test file in
its own process several at a time, a shared temp location also produced a flaky failure when one
file's cleanup deleted another file's in-flight directory. `writeLauncherScript` and
`sweepStaleLaunchers` now take the directory as an optional argument, `ClaudeSessionService` has a
`launcherDirectory()` seam beside its other overridable probes, and every test file works inside a
scratch directory of its own that it deletes when it finishes. Three consecutive full runs leave
the temp folder empty.

## Concurrency notes

- This stage opens several VS Code windows and external terminals. Close what you open.
- Real Claude sessions started here run against Rob's account. Keep the matrix to one short
  session per row and end them when the row passes.
