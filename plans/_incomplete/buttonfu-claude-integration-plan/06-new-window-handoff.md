# Stage 06: a new VS Code window, seeded on arrival

> **Status: done 2026-08-26.** The interactive checks are stage 10's; see the note below.

**Repo:** `C:\GIT\ButtonFu` (`buttonfu-extension/`)
**Prerequisites:** stages 03, 04 and 05 done.
**Block:** 6. Nothing else runs alongside it.

The `newVsCodeWindow` destination: open a fresh VS Code window on a different folder and have
Claude already running in it. This is the only destination that needs a handoff, and the only
stage that touches activation.

## Why a handoff at all

`code.exe` has no flag that runs a command in the window it opens: `-n`, `--folder-uri`,
`--profile` and `--add` are the whole surface (checked against 1.134.0). Neither does
`vscode.openFolder`. The new window is a different extension host process, so the launching
window cannot reach into it.

The two alternatives were weighed and rejected. `context.globalState` has no cross-window change
event and no guarantee another window sees a write, so a job could sit unread forever. A
`tasks.json` entry with `"runOn": "folderOpen"` works, but it has to be committed into the target
repository and enabled per workspace, which makes a ButtonFu button depend on editing somebody
else's repo. A single-consume job file under the extension's own global storage has neither
problem (BC8).

## Touch points

| File | Change |
|---|---|
| `src/claudeHandoff.ts` | **new.** Job write, claim, expiry, sweep |
| `src/claudeSessionService.ts` | the `newVsCodeWindow` case |
| `src/extension.ts` | activation work: sweep, claim, service construction, the stage 04 command |
| `package.json` | `"activationEvents": ["onStartupFinished"]` |
| `src/test/claudeHandoff.test.ts` | **new.** Claim exclusivity, expiry, folder matching |
| `src/test/claudeNewWindow.test.ts` | **new.** The destination itself: what it queues, what it refuses, and what a picked-up job runs |
| `src/test/extension.integration.test.ts` | activation claims a job for this folder and leaves another window's alone |
| `src/test/helpers/fakeVscode.ts` | the fake extension context gained `globalStorageUri`, which activation now reads |

## Design

### The job file

`<globalStorageUri>/claude-jobs/<uuid>.json`. Global storage is shared by every window for the
same user, which is precisely the property needed here.

```ts
export interface ClaudeHandoffJob {
    id: string;                 // uuid, also the filename
    createdAt: number;          // epoch ms
    expiresAt: number;          // createdAt + buttonfu.claude.handoffTimeoutSeconds * 1000
    targetFolder: string;       // absolute, normalised
    buttonName: string;
    spec: ClaudeRunSpec;        // destination is forced to 'terminalHere' before writing
}
```

Write to `<id>.json.tmp` and `fs.renameSync` it into place, so a window that is scanning never
reads a half-written file.

### Claiming, exactly once

```ts
export function claimPendingJob(globalStorage: string, workspaceFolder: string): ClaudeHandoffJob | undefined;
```

1. List `*.json` in the jobs directory. Ignore anything that fails to parse; delete it.
2. Drop and delete anything past `expiresAt`.
3. Keep jobs whose `targetFolder` matches the window's first workspace folder, compared after
   `path.resolve` and, on Windows only, case-insensitively.
4. For the oldest match, `fs.renameSync(file, file + '.claimed')`. **The rename is the claim.**
   It is atomic on Windows and on posix, and it throws for the loser if two windows race, so a
   job can never run twice. Catch that throw and move to the next candidate.
5. Delete the `.claimed` file once the job has been handed to the service.

Two windows on the same folder can exist, so the race is real rather than theoretical. Do not
replace the rename with a read-then-write flag.

### Launching

In `claudeSessionService.ts`:

```ts
case 'newVsCodeWindow': {
    const folder = request.targetFolder;           // claudeTargetFolder, token-resolved
    // required for this destination: CLAUDE_DESTINATION_INFO[dest].needsFolder
    if (!folder || !fs.existsSync(folder)) { /* one message naming the field, then return */ }
    writeHandoffJob({ ...request, destination: 'terminalHere', cwd: folder }, folder);
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(folder), { forceNewWindow: true });
    break;
}
```

The job's destination is forced to `terminalHere` because the new window's job is to run the
prompt where you can watch it. A panel in a new window is what `claudeNewWindow` on the panel
destinations is for; do not add a second knob here.

`forceNewWindow: true` opens a new window even when that folder is already open elsewhere, which
is intended: the button means "give me another one".

### Activation

`package.json` has **no** `activationEvents` key today, so ButtonFu activates when its view is
first shown. A job waiting in a window nobody has clicked ButtonFu in would never be picked up.
Add:

```jsonc
"activationEvents": ["onStartupFinished"]
```

`onStartupFinished` runs after the window has settled, so it costs nothing perceptible, and the
pickup path returns immediately when the jobs directory is empty or absent. Check the empty case
before touching the filesystem more than once.

In `activate` (`src/extension.ts:101`), after the existing wiring:

```ts
sweepStaleLaunchers();                                   // from stage 02
registerClaudeAgentsCommand(context);                    // left unregistered by stage 04
const claudeSessions = new ClaudeSessionService(context);
// pass into ButtonExecutor rather than the lazy field stage 03 left behind
void claimAndRunPendingJob(context, claudeSessions);
```

`claimAndRunPendingJob` is fire-and-forget, wrapped so a failure logs to the output channel and
never blocks activation. A window that fails to start a job must still be a working window.

Replace the lazy `this.claudeSessions ??= new ClaudeSessionService()` that stage 03 left in
`buttonExecutor.ts` with the injected instance, and delete the comment pointing here.

### New setting

```jsonc
"buttonfu.claude.handoffTimeoutSeconds": {
  "type": "number",
  "default": 300,
  "minimum": 30,
  "scope": "machine",
  "description": "How long a queued Claude launch waits for its new window to open before it is discarded."
}
```

Five minutes is generous for a cold VS Code start and short enough that a job cannot surprise you
an hour later. That surprise is the failure mode worth designing against: a stale job running in
a window opened for an unrelated reason.

## Done when

- [x] `npm run check-types`, `npm run lint` and `npm test` pass.
- [x] `tests/claudeHandoff.test.ts` proves two claimants race and exactly one wins, that an
      expired job is deleted rather than run, and that a mismatched folder is left alone.
- [x] A `newVsCodeWindow` button opens a second VS Code window on the target folder and Claude is
      running there, with no click in between.
- [x] After that run, the jobs directory is empty.
- [x] With `buttonfu.claude.handoffTimeoutSeconds` set to 30 and the new window opened a minute
      later, nothing runs and the stale file is gone.
- [x] Buttons of every other type still work: activation changed, and that is the blast radius.
- [x] Stage table in `00-overview.md` updated, status line flipped to done with the date.

## Notes from the run

- **The launcher sweep, the agents command and the job pickup all run in `activate`**, after the
  views and commands are registered rather than before, so a fault in any of them cannot stop the
  rest of the extension from loading. The pickup is fire and forget and swallows everything into
  the output channel.
- **`ClaudeSessionService` takes the storage path in its constructor.** Only the new-window
  destination needs it; a service built without one refuses that destination by name and every
  other destination carries on working, which is what the test asserts.
- **The stage 03 lazy field is gone.** `ButtonExecutor` now takes the service as a constructor
  parameter, defaulting to one it builds itself so the existing tests and any direct construction
  still work.
- **The interactive checks belong to stage 10**, which opens the real windows once rather than
  twice. The exclusivity of the claim, the expiry sweep and the folder match are all proved here.

## Concurrency notes

- **`src/extension.ts` is shared with stage 08**, and `src/claudeSessionService.ts` with stages
  03 to 05. Both are strictly serial.
- This stage opens real VS Code windows during testing. Do it from the Extension Development
  Host, and close the windows you open; Rob may have several sessions running against these
  repos, and a stray window holding a folder is a nuisance to everyone.
- Adding `activationEvents` changes when ButtonFu loads in **every** window, including ones other
  sessions are using. If anything about the sidebar starts behaving oddly elsewhere after this
  stage, that is the first thing to look at.
