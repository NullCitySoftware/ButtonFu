# Stage 02: executable resolution and the argv builder

> **Status: done 2026-08-26.**

**Repo:** `C:\GIT\ButtonFu` (`buttonfu-extension/`)
**Prerequisites:** stage 01 done (its status line reads done).
**Block:** 2, alongside stage 07. Disjoint files, safe to run at the same time.

The pure half of the feature: turn a stored button into an exact `argv` array, find the Claude
executable, and write the launcher script that lets a terminal run that argv without a single
character of the prompt touching a command line. Nothing here spawns anything.

## Touch points

| File | Change |
|---|---|
| `src/claudeCommandBuilder.ts` | **new.** Pure. No `vscode` import. Spec type, `buildClaudeArgs`, launcher-script writer, stale-launcher sweeper |
| `src/claudeExecutable.ts` | **new.** Resolves the Claude binary through the three-step order in BC6 |
| `package.json` | new setting `buttonfu.claude.executablePath` |
| `src/test/claudeCommandBuilder.test.ts` | **new.** The bulk of this stage's proof (the suite lives in `src/test/`) |
| `src/test/claudeExecutable.test.ts` | **new.** Resolution order, with probes injected |
| `src/claudeOutput.ts` | **new.** The output channel needs `vscode`, and the builder must not import it, so the channel got its own small file rather than being folded into either |

## Design

### `ClaudeRunSpec`

```ts
export interface ClaudeRunSpec {
    destination: ClaudeDestination;
    /** Fully token-resolved prompt text. May contain quotes, newlines, anything. */
    prompt: string;
    /** Absolute working directory. */
    cwd: string;
    /** uuid minted by the caller (BC7). Omitted only where a session id is meaningless. */
    sessionId?: string;
    sessionName?: string;
    model?: string;
    effort?: string;
    permissionMode?: string;
    addDirs?: string[];
    worktree?: boolean;
    worktreeName?: string;
    extraArgs?: string[];
}
```

### `buildClaudeArgs(spec): string[]`

Returns the argument list **after** the executable. Rules, in this order:

1. `--session-id <uuid>` when `sessionId` is set.
2. `-n <sessionName>` when set and non-empty.
3. `--model <model>` when set and non-empty.
4. `--effort <effort>` when set and non-empty.
5. Permission mode. **`bypassPermissions` is not passed through `--permission-mode`**: the CLI
   spells that one `--dangerously-skip-permissions`. Every other mode goes as
   `--permission-mode <mode>`. An empty or unrecognised mode emits nothing.
6. `--worktree` when `worktree` is true, followed by `worktreeName` when that is non-empty.
7. `--add-dir <dir>` **repeated once per directory**. See the hazard below.
8. Destination extras: `headlessThenPanel` adds `-p` and `--output-format text`;
   `backgroundAgent` adds `--bg`. Every other destination adds nothing.
9. `extraArgs` verbatim, in order, never split and never shell-parsed.
10. The prompt, **last**, as a single positional entry. Omitted only when it is empty.

**The variadic hazard, and why the prompt goes last.** `--add-dir` is declared variadic in the
CLI (`--add-dir <directories...>`), so it swallows every following bare word until the next
flag. A prompt sitting between `--add-dir` and the end of the line would be parsed as another
directory. Emitting one `--add-dir` per directory and keeping the prompt as the final entry
avoids it. Do not reorder these for tidiness, and add a unit test that asserts the last entry is
the prompt and that two directories produce two separate `--add-dir` pairs. Stage 10 proves the
parse with one real invocation.

### Launcher scripts: how the prompt reaches a terminal

A VS Code terminal takes a **string**, not an argv array, so BC3 needs a way through. The answer
is that **the terminal line contains no user text at all**: it invokes a generated script whose
contents carry the argv.

```ts
export interface LauncherScript { path: string; shellCommand: string; }

export function writeLauncherScript(
    exe: string, args: string[], cwd: string, shell: 'powershell' | 'posix'): LauncherScript;
```

- Files land in `os.tmpdir()/buttonfu-claude/` as `launch-<uuid>.ps1` or `launch-<uuid>.sh`,
  written with mode `0o700` on posix.
- PowerShell body: `Set-Location -LiteralPath '<cwd>'` then `& '<exe>' '<arg1>' '<arg2>' ...`,
  every literal single-quoted with each embedded `'` doubled to `''`. Single-quoted PowerShell
  strings do not interpolate, so `$`, backticks and `"` are inert.
- Posix body: `#!/bin/sh`, `cd '<cwd>'`, then `exec '<exe>' '<arg>' ...` with each embedded `'`
  rendered as `'\''`.
- `shellCommand` is what the caller sends to the terminal, and it is chosen so that **any**
  shell can run it: on Windows,
  `pwsh -NoProfile -ExecutionPolicy Bypass -File "<path>"` (falling back to `powershell` when
  `pwsh` is not on `PATH`), which works identically from PowerShell, `cmd.exe` and Git Bash; on
  posix, `sh '<path>'`. Nothing else goes on that line, so there are two shell shapes to reason
  about rather than one per terminal profile.

The escaping functions are the highest-value unit tests in the plan. Cover at minimum: a prompt
containing `'`, one containing `"` and `$HOME`, one containing a backtick, one spanning three
lines, one containing `; rm -rf /`, and an empty prompt. Assert the generated file, when parsed
back, yields exactly the original argv.

```ts
/** Delete launcher scripts older than 24 hours. Called once at activation (stage 06). */
export function sweepStaleLaunchers(): void;
```

A launcher cannot delete itself reliably, because an interrupted session never reaches the last
line. Sweeping on a timer of age is the honest fix.

### `claudeExecutable.ts`

```ts
export interface ClaudeExecutableProbes {
    settingPath: () => string | undefined;
    pathLookup: (name: string) => string | undefined;
    extensionPath: (id: string) => string | undefined;
    fileExists: (p: string) => boolean;
}
export function resolveClaudeExecutable(probes: ClaudeExecutableProbes): string | undefined;
export function describeMissingClaude(): string;
```

Order is BC6 exactly: the `buttonfu.claude.executablePath` setting, then `claude` on `PATH`,
then `<extensionPath('anthropic.claude-code')>/resources/native-binary/claude.exe` on Windows or
`.../claude` elsewhere. Injecting the probes is what makes this testable without a real machine;
the production wiring passes real implementations from the service in stage 03.

`describeMissingClaude()` returns one actionable sentence naming both fixes: install the CLI so
`claude` is on `PATH`, or set `buttonfu.claude.executablePath`. It is what the user sees when
resolution fails, and the button must fail with it rather than spawning anything.

**Version note worth surfacing in the log line, not the UI:** the bundled binary inside the
Claude Code extension and a `claude` on `PATH` are frequently different versions (2.1.246 and
2.1.209 on this machine on 2026-08-26). Log which one was chosen.

### Diagnostics

Add a shared `getClaudeOutputChannel()` returning a lazily created
`vscode.window.createOutputChannel('ButtonFu Claude')`. Every launch logs one line: destination,
resolved executable, cwd, the full argv with the prompt replaced by `<prompt: N chars>`, and the
session id. Do not log prompt text; a prompt can contain anything the user typed.

This channel is the debugging surface every later stage leans on, so build it here.

### New setting

```jsonc
"buttonfu.claude.executablePath": {
  "type": "string",
  "default": "",
  "scope": "machine",
  "description": "Full path to the Claude Code CLI. Leave empty to use claude from PATH, falling back to the binary bundled with the Claude Code extension."
}
```

## Done when

- [x] `npm run check-types` and `npm run lint` pass.
- [x] `npm test` passes with the two new test files, including every escaping case listed above.
- [x] `buildClaudeArgs` has a test asserting `bypassPermissions` becomes
      `--dangerously-skip-permissions` and never `--permission-mode bypassPermissions`.
- [x] `claudeCommandBuilder.ts` contains no `import * as vscode`.
- [x] Nothing under `src/` outside the two new files changed, apart from `package.json`.
- [x] Stage table in `00-overview.md` updated, status line flipped to done with the date.

## Concurrency notes

- Stage 07 runs alongside this one and owns `src/editorPanel.ts` and `resources/editor.js`. Do
  not touch either. If a build breaks in those files, that is stage 07 mid-edit: wait and re-run.
- `sweepStaleLaunchers()` is written here but **called** from `extension.ts` in stage 06. Leave
  `extension.ts` alone.
