# ButtonFu Claude integration plan - AI seed

Paste the block below into a fresh Claude Code session to execute this plan end to end.

---

You are implementing a staged plan in **`C:\GIT\ButtonFu`**, a VS Code extension that puts
customisable buttons in the sidebar. All of the work lands in that one repo, mostly under
`buttonfu-extension/`. The plan folder is
**`C:\GIT\ButtonFu\plans\buttonfu-claude-integration-plan\`**. The feature is a new
`ClaudeCommand` button type that starts a Claude Code session with the prompt already running,
across seven launch destinations.

**Read `00-overview.md` first, all of it.** It carries grounding you must not re-derive: the
Claude Code extension's command signatures and deep link, the fact that a seeded prompt in the
native panel is typed but never sent, the CLI flags in play, and why a new VS Code window needs a
handoff file. Its locked decisions **BC1 to BC15 are LOCKED**: do not re-litigate them, do not
redesign around them. If one turns out to be impossible, stop and say so.

**Execute every stage in order, 01 through 10.** Stage 10 is the end-to-end verification. Run
them in these blocks, strictly sequential, with stages inside a block order-independent:
`01` then `02 + 07` then `03` then `04` then `05` then `06` then `08` then `09` then `10`.
Stages 03, 04, 05 and 06 all extend `src/claudeSessionService.ts`, and 06 and 08 both edit
`src/extension.ts`: never overlap those.

For each stage: read the stage file, do exactly what it says, run its Done-when checks, tick its
checkboxes, flip its status line to done with today's date, update the stage table in
`00-overview.md`, then move straight on to the next stage without waiting to be told.
**Never commit and never branch.** Say what is uncommitted at the end and let Rob run `/commit`.

Watch-outs, one line each:

- All stages: build with `npm run compile` from `buttonfu-extension` (it chains `check-types`,
  `check-webview-js` and esbuild). Never run esbuild alone.
- All stages: no em dash (U+2014) in any string, comment or doc. The repo has old ones; add none.
- 01: `createDefaultButton` in `types.ts` is pure and must not import `vscode`; pass the setting
  in as a parameter.
- 02: `bypassPermissions` is spelled `--dangerously-skip-permissions` on the CLI, not
  `--permission-mode bypassPermissions`.
- 02: `--add-dir` is variadic, so the prompt must be the last argv entry or it gets parsed as a
  directory. Stage 10 proves this with one real run.
- 03: a `ClaudeCommand` button uses plain `replaceTokens`, **not** the shell-escaping terminal
  variant. The launcher script handles literal safety.
- 03: a terminal can only be torn off into a new window if it was created with
  `location: { viewColumn }`. A panel terminal cannot.
- 03: **never pass `env` or `strictEnv` on a terminal you create for Claude.** The window
  publishes `CLAUDE_CODE_SSE_PORT` through `environmentVariableCollection` and that is what makes
  the session a real VS Code session; `strictEnv` silently drops it. The Claude extension's own
  recipe passes it, and that one line must not be copied.
- 04: a process spawned from the extension host does not inherit that variable. Find this
  window's port by matching `pid === process.ppid` in `~/.claude/ide/*.lock` and pass it
  explicitly, except for background agents, which are meant to outlive the window.
- 03 and 04: do not edit `src/extension.ts`; stage 06 owns it and wires up what you leave behind.
- 05: never claim `panelPrefill` sends the prompt. There is no auto-submit path in that webview
  and no way for an extension to press Enter in it.
- 06: `package.json` has no `activationEvents` today; adding `onStartupFinished` changes when
  ButtonFu loads in **every** window.
- 06: the claim is an `fs.renameSync`, because it is atomic and the loser throws. Do not replace
  it with a read-then-write flag.
- 07: `resources/editor.js` and the template literal in `editorPanel.ts` must be edited together,
  and `npm run check-webview-js` is what catches a parse error that otherwise shows as a blank
  editor.
- 08: turn `buttonfu.claude.allowBridgeRun` back off when you finish, and say so.
- 09: edit the **repo-root** README and CHANGELOG, then run
  `npm run sync-package-files --prefix buttonfu-extension`, or packaging fails a hash check.
- 09 and 10: do not publish, do not run `vsce package`, do not run the Inno Setup installer.
- 10: real Claude sessions cost Rob money. One short session per matrix row, ended when it passes.

**Other agent sessions may be working these repos at the same time.** If a build error, a type
error or a missing symbol points at code you did not touch, assume someone else is mid-edit: back
off 20 to 90 seconds and retry rather than fixing their file. Never kill a dev server or a window
you did not start, and never `git add -A`.

Run the plan as far as you can **without my intervention**. Do not stop to check in between
stages, do not ask permission to continue, and do not ask me to confirm work the plan already
decided. If something blocks you, first do every remaining piece of work that does not depend on
the answer, then come back to me. Only stop for: a locked decision that proves impossible; a
secret, credential or account you do not have; a production deploy, a publish, or anything else
outward-facing; or a genuine judgement call that is mine to make. Everything else, including
build failures, design detail and ordinary ambiguity, you resolve yourself and note.

When the plan is done, or as done as it can get: report a short table of stages with what
actually happened, state plainly anything that is not finished and why, file the plan folder per
`plans/_complete/README.md` (`_complete` only if follow-ups are closed too, and carve any
deliberately deferred item into its own small `_future` plan that names this one), then ask me,
in one go, every question that accumulated along the way.
