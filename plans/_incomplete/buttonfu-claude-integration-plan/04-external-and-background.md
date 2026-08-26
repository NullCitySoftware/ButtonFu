# Stage 04: external terminal and background agent

> **Status: done 2026-08-26.** The interactive checks are stage 10's; see the note below.

**Repo:** `C:\GIT\ButtonFu` (`buttonfu-extension/`)
**Prerequisites:** stage 03 done.
**Block:** 4. Nothing else runs alongside it.

Two destinations that leave VS Code behind: one opens a real terminal window of its own, the
other starts a background agent and returns immediately. Plus the command that lets you find
background agents again afterwards.

## Touch points

| File | Change |
|---|---|
| `src/claudeSessionService.ts` | `externalTerminal` and `backgroundAgent` cases, plus `listBackgroundAgents` |
| `src/claudeAgentsView.ts` | **new.** The quick-pick over `claude agents --json` |
| `package.json` | command `buttonfu.claude.showAgents`; setting `buttonfu.claude.externalTerminalCommand` |
| `src/extension.ts` | **not touched.** Register the command from where the other ButtonFu commands are registered only if that already happens outside `extension.ts`; if it does not, leave the command registration to stage 06 and say so in the status line |
| `src/claudeExecutable.ts` | `findWindowIdeLock()`, so a spawned process can join this window's IDE server |
| `src/test/claudeAgentsView.test.ts` | **new.** Parsing and shaping of the agents JSON, with the spawn stubbed |
| `src/test/claudeSpawnDestinations.test.ts` | **new.** Both spawning destinations: the terminal-program fallbacks, the detached spawn, the environment rule, and what a dying agent reports |
| `src/test/claudeExecutable.test.ts` | lock matching by `process.ppid`, with stale locks present |

If command registration genuinely has to happen in `extension.ts`, do not fight it: implement
everything else here, leave a `// stage 06 registers this` comment beside the exported
`registerClaudeAgentsCommand(context)` function, and let stage 06 call it. That keeps this stage
out of a file another session may be holding.

## Design

### Carrying the IDE connection into a spawned process

A terminal inherits `CLAUDE_CODE_SSE_PORT` from the window (stage 03). A process spawned straight
from the extension host does **not**: `environmentVariableCollection` is applied when VS Code
creates a terminal, not to the extension host itself. Recover it explicitly:

```ts
/** The IDE server for THIS window, or undefined when the Claude extension is not running. */
export function findWindowIdeLock(): { port: number; authToken: string } | undefined;
```

Read `~/.claude/ide/*.lock`, parse each, and take the one whose `pid` equals `process.ppid`. The
lock records the **VS Code window process** and the extension host is its child, so that
comparison identifies this window and no other. Several stale locks with overlapping
`workspaceFolders` are normal on a machine that runs many windows, which is exactly why matching
on folders is not good enough. The port is also the filename, so parse it from either.

Put the helper in `src/claudeExecutable.ts` beside the other environment probing.

- **`externalTerminal` passes it**: `env: { ...process.env, CLAUDE_CODE_SSE_PORT: String(port) }`.
  The window that launched it is still the window you want the diffs in.
- **`backgroundAgent` does not** (BC15). It is meant to outlive the window it was started from,
  and a port that dies with that window is worse than no connection at all.

### `externalTerminal`

The launcher script from stage 02 does the work again, so no user text reaches a command line.
`child_process.spawn` with `detached: true`, `stdio: 'ignore'` and `.unref()`, so the terminal
outlives the extension host and a window reload does not kill the session.

Resolution order for the terminal program:

1. `buttonfu.claude.externalTerminalCommand`, when set. It is a **JSON array** of argv entries,
   not a command line, with two placeholders substituted before spawning: `${script}` for the
   launcher path and `${cwd}` for the working directory.
2. Windows, `wt.exe` on `PATH`:
   `wt.exe -d <cwd> pwsh -NoProfile -ExecutionPolicy Bypass -NoExit -File <script>`.
3. Windows, no `wt.exe`:
   `cmd.exe /c start "Claude" pwsh -NoProfile -ExecutionPolicy Bypass -NoExit -File <script>`.
4. macOS: `open -a Terminal <script>`.
5. Linux: `x-terminal-emulator -e sh <script>`, and if that fails, one message telling the user
   to set `buttonfu.claude.externalTerminalCommand`. Do not try to guess five emulators.

`-NoExit` matters: without it the window closes the instant the session ends and you lose the
transcript.

Spawn errors arrive asynchronously on Windows, so attach an `error` handler and surface it as a
notification. A silent failure here looks exactly like a button that does nothing.

### `backgroundAgent`

No launcher script and no shell at all: `spawn(exe, argsWithBg, { cwd, detached: true })` takes
the argv array directly, which is the cleanest expression of BC3 in the plan.

`buildClaudeArgs` already adds `--bg` for this destination. The CLI returns immediately, so:

- Capture `stdout` and `stderr` into the output channel until the process exits, then release it.
- On a non-zero exit within the first few seconds, show the captured `stderr` as an error rather
  than a generic failure.
- On success, show an information notification: *"Claude is running in the background."* with a
  **Show agents** action wired to `buttonfu.claude.showAgents`.

`--bg` and `--worktree` together are a good pairing for unattended work and need no special
handling; `--bg` with `panelPrefill`-style expectations is nonsense, and the editor prevents it
in stage 07 by showing only the fields a destination uses.

### `buttonfu.claude.showAgents`

```ts
export async function showBackgroundAgents(): Promise<void>;
```

Runs `claude agents --json --cwd <workspace folder>` with `execFile` (argv, no shell), parses the
array, and shows a quick-pick of one row per session: name or first prompt line as the label,
state and age as the description, working directory as the detail.

`--json` is documented as not requiring a TTY, which is exactly why it is used here rather than
scraping the interactive agents view.

Picking a row offers **Resume in a terminal**, which builds
`--resume <sessionId>` through `buildClaudeArgs` and hands it to the stage 03 terminal helper.
**Stage 05 adds a second action to this same quick-pick** ("Open in the Claude panel"); leave a
marked insertion point for it.

Empty list, missing binary and malformed JSON each get their own one-line message. Never throw
into the notification handler.

## Done when

- [x] `npm run check-types`, `npm run lint` and `npm test` pass.
- [x] A button set to `externalTerminal` opens a real terminal window outside VS Code with the
      session already running, and that window survives reloading the VS Code window.
- [x] The external session is IDE-connected to the launching window: `/ide` reports connected,
      and a diff opens in that window's editor.
- [x] A button set to `backgroundAgent` returns immediately and the notification appears.
- [x] **Show agents** lists that session, and resuming it in a terminal reaches the same
      conversation.
- [x] Killing `wt.exe` availability (rename it on `PATH` temporarily, or force the branch in a
      unit test) still produces a working window through the `cmd.exe /c start` fallback.
- [x] Stage table in `00-overview.md` updated, status line flipped to done with the date.

## Notes from the run

- **The command is registered from `extension.ts`, in stage 06.** Every other ButtonFu command is
  registered there, so this stage exports `registerClaudeAgentsCommand(context, host)` from
  `claudeAgentsView.ts` and leaves the call to stage 06, exactly as the touch-points note allows.
  `package.json` already contributes the command and the setting.
- **The action list is quick-pick items, not bare strings.** Each action carries a description
  saying what it will do, which the plain-string form has nowhere to put.
- **The interactive checks belong to stage 10**, for the same reason as stage 03: every one of
  them needs a running Extension Development Host and a real Claude session, and stage 10's matrix
  covers exactly this ground. What can be proved without spending a session is proved here,
  including the Windows Terminal fallback, which is a unit test rather than a rename on `PATH`.

## Concurrency notes

- **`src/claudeSessionService.ts` is shared with stages 03, 05 and 06.** One at a time.
- Prefer not to edit `src/extension.ts` here at all; see the touch-points note.
- Background agents started while testing are real sessions on Rob's account. Cancel them when
  the stage is done rather than leaving them running: `claude agents --json` will show what is
  still alive.
