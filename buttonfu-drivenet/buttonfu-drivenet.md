# Drive.NET Friction Report For ButtonFu Testing

Date: 2026-04-10

Context: I was using Drive.NET CLI to test the ButtonFu VS Code extension against the checked-in manifest at `buttonfu-extension/tests/drive-net/manifest.yaml`.

All relative paths below are relative to this handoff folder.

Most useful outcome so far:

1. The best manifest run was `.drive-net/test-results-manifest-current-ui-v5.json`.
2. That run reached 18 passed / 1 failed.
3. The remaining failure in that run was not a ButtonFu product failure. The note insert worked, and the inserted untitled editor is visible in `.drive-net/note-crud-03-inserted-into-new-editor.png`.
4. The hard problems were mostly Drive.NET ergonomics, selector support, lifecycle handling, and repeat-run stability when targeting VS Code.

Below is the actionable list I would hand to an agent working on the Drive.NET codebase.

Update:

See the 2026-04-11 addendum at the end. Drive.NET 0.60.0 improved some of the issues below, and the current checked-in manifest now passes 19/19 on a reused Extension Development Host.

## 1. Add hard validation or backward compatibility for the old `by: '{...}'` selector syntax

Observed:

The manifest originally used selectors like:

`by: '{"automationId":"openNoteEditorBtn"}'`

Those steps failed with zero matches until I rewrote them to the current first-class form such as:

`automation_id: openNoteEditorBtn`

Impact:

This made a large number of steps look like product failures even though the UI elements were present and reachable.

Requested Drive.NET change:

1. Either keep supporting the JSON-in-string `by` selector format.
2. Or fail fast with an explicit validation error that says the selector format is deprecated and shows the current replacement syntax.

Why this matters:

The current behavior is too silent. It burns time in triage because the manifest appears valid but many steps just return zero elements.

Evidence:

1. Early failing manifest runs before selector conversion.
2. Working converted manifests in `buttonfu-extension/tests/drive-net/activation.yaml`, `buttonfu-extension/tests/drive-net/button-crud.yaml`, and `buttonfu-extension/tests/drive-net/note-crud.yaml`.

## 2. Let `interact` actions target elements directly by selector, not only by `element_id`

Observed:

When I tried to make a manifest step do a direct click by selector, Drive.NET failed with:

`'elementId' is required for the 'click' action.`

Impact:

Every interaction requires a separate `find` step plus a saved variable, even when the selector is unique and obvious.

Requested Drive.NET change:

Support the same selector fields on `interact` that already work on `find`, for example:

1. `automation_id`
2. `name`
3. `control_type`
4. `class_name`
5. `path`

Why this matters:

It would simplify manifests substantially and reduce the amount of fragile variable plumbing.

Evidence:

I hit this directly while trying to make the activation suite idempotent by clicking the Explorer activity item before clicking ButtonFu.

## 3. Add suite-scoped variable persistence or an explicit suite/global variable scope option

Observed:

Variables saved in one test were not available in later tests. Example: the note menu toggle variable had to be re-resolved in each later note test because the saved value from the earlier test was out of scope.

Impact:

Manifest authors are forced to repeat the same lookup logic in multiple tests, even when the tests are a single flow split into logical sections.

Requested Drive.NET change:

Add one of these:

1. Suite-scoped saved variables.
2. An explicit `scope: suite` or `scope: global` option on `save`.
3. Clear documentation and schema messaging if per-test scope is intentional and permanent.

Why this matters:

This is a very common end-to-end testing need. The current behavior makes multi-step flows more repetitive and more brittle.

Evidence:

The failures around `note_menu_toggle` becoming undefined between note tests during the manifest iterations.

## 4. Support `helpText` / accessible description selectors

Observed:

Some VS Code webview controls expose a useless accessible name and only put the human-readable label in help text. The ButtonFu note split-menu toggle was one of those cases.

Example:

1. Accessible name: ``
2. Useful label: `More note actions for DriveNet Smoke Note`

I attempted to target help text in a path selector and Drive.NET returned:

`Unsupported selector path criterion 'helpText'`

Impact:

Selectors become much more brittle because I had to target icon-glyph buttons or shared class names instead of the actual semantic label.

Requested Drive.NET change:

Support `help_text` selectors in both:

1. Flat selectors
2. Hierarchical/path selectors

Why this matters:

This is especially important for Electron apps and custom webviews that do not always put the friendly label into `name`.

## 5. Add explicit `contains` / `starts_with` / regex string matching for names

Observed:

Drive.NET name matching appears to behave as exact matching. That caused problems with VS Code tab labels and other long strings that get truncated in accessibility output.

Example:

The inserted untitled note tab appeared as:

`This note was created by a Drive.NET aut • Untitled-1`

not the full original content string.

Impact:

Tests become much more brittle when they have to guess the exact truncated accessible label.

Requested Drive.NET change:

Add first-class string operators such as:

1. `name_contains`
2. `name_starts_with`
3. `name_regex`

Why this matters:

This would remove a lot of trial-and-error when targeting editor tabs, long labels, and virtualized UI content.

## 6. Improve debugging when `save` JSONPath resolution fails

Observed:

When a `save` path like `$.items[1].elementId` was out of range, the failure message was useful, but debugging still required a second manual query to understand what the command actually returned in that moment.

Impact:

This slows down manifest authoring and triage.

Requested Drive.NET change:

When a `save` JSONPath fails:

1. Always keep the raw result payload in the structured JSON.
2. Include a compact preview of the actual matched items directly in the failure summary.
3. Optionally emit a message like `save path failed, but query returned N items`.

Why this matters:

It shortens the feedback loop for debugging selector and indexing problems.

Note:

Some runs already preserved raw results, which was helpful. The request here is to make that guaranteed and prominent.

## 7. Provide a more reliable lifecycle strategy for launching fresh VS Code / Electron instances

Observed:

I tried to launch isolated VS Code instances using both:

1. `--user-data-dir`
2. `--transient`

Both attempts failed with a singleton/mutex error instead of producing a stable, independently testable instance.

The relevant log showed:

`Error: Error mutex already exists`

and then:

`CodeWindow: renderer process gone (reason: launch-failed, code: 4)`

Impact:

Because I could not reliably get a fresh host, I had to attach manifests to a reused Extension Development Host window. That made reruns stateful and flaky.

Requested Drive.NET change:

Add a more robust lifecycle story for VS Code / Electron testing. Possible directions:

1. First-class support for starting a VS Code Extension Development Host from a `launch.json` configuration.
2. Better attach-to-debug-host support when the host was launched outside Drive.NET.
3. Optional cleanup / state-reset helpers for reused sessions when true clean launch is not available.

Why this matters:

Testing VS Code extensions is a major scenario where attach-only flows are not enough.

Evidence:

`vscode-transient-main.log`

## 8. Add idempotent state-reset helpers for reused sessions

Observed:

When reusing the same VS Code host, clicking the ButtonFu activity icon behaved like a toggle. If ButtonFu was already selected, clicking it hid the sidebar instead of opening it.

Impact:

The exact same manifest could pass or fail depending on the leftover activity-bar state from the previous run.

Requested Drive.NET change:

Add one or more of these capabilities:

1. Query whether a `TabItem` is currently selected or active.
2. A `click_if_not_selected` style interaction.
3. A lightweight condition or branch so manifests can say `if ButtonFu is not selected, click it`.

Why this matters:

This would make repeated reruns against the same app session much more stable.

## 9. Add richer support for reading Monaco / VS Code editor content

Observed:

The note insert action worked. The editor visibly contained the inserted text, and the tab title reflected it. But a query for the inserted content as a `Text` control returned zero matches.

Impact:

Text verification inside editors is weaker than it should be for VS Code scenarios.

Requested Drive.NET change:

Add a VS Code / Monaco-oriented content helper, for example:

1. Read the active editor text.
2. Read the current line text.
3. Snapshot editor text without relying entirely on UIA `Text` nodes.

Why this matters:

Editor automation is central to VS Code extension testing. Relying only on standard UIA text exposure misses real successful behavior.

Evidence:

1. `.drive-net/note-crud-03-inserted-into-new-editor.png`
2. `.drive-net/test-results-manifest-current-ui-v5.json`

## 10. Improve documentation around test authoring for reused sessions versus fresh sessions

Observed:

Several failures were not product bugs. They were differences between:

1. Running against a truly fresh host
2. Running against a reused host with persisted sidebar/editor state

Impact:

It is easy to write a manifest that works only once or only on a clean profile.

Requested Drive.NET change:

Improve the docs with explicit guidance for:

1. Per-test variable scope
2. Reused-session pitfalls
3. Toggle UI patterns like VS Code activity icons
4. Recommended selector strategies for Electron/webview apps
5. How to verify Monaco editor content reliably

Why this matters:

Clear docs would have saved a lot of trial-and-error.

## Suggested priority order

1. Selector schema validation / backward compatibility for `by: '{...}'`
2. Selector-based `interact`
3. Suite-scoped variables
4. `helpText` selector support
5. Better VS Code / Electron lifecycle support
6. Monaco editor text helpers
7. Idempotent state-reset helpers for reused sessions

## Useful evidence files

1. Best near-pass run: `.drive-net/test-results-manifest-current-ui-v5.json`
2. Later flaky rerun against reused host: `.drive-net/test-results-manifest-current-ui-v9.json`
3. Insert succeeded visually: `.drive-net/note-crud-03-inserted-into-new-editor.png`
4. Current split-button notes host sanity capture: `.drive-net/current-host-selector-sanity.png`
5. VS Code transient-launch mutex failure: `vscode-transient-main.log`

## Bottom line

Drive.NET was usable enough to get ButtonFu to 18/19 on a real live manifest run, so this is not a general failure report. The main request is to reduce the amount of harness-specific workaround work needed for VS Code extension testing, especially around selector ergonomics, variable scoping, reused-session stability, and fresh-host lifecycle support.

## Addendum: 2026-04-11 retest on Drive.NET 0.60.0

Retest summary:

1. The current checked-in manifest now passes 19/19 against a reused Extension Development Host in `.drive-net/test-results-manifest-retest-20260411-same-host-v5.json`.
2. The fresh-host retest earlier in the same cycle reached 17/19 in `.drive-net/test-results-manifest-retest-20260411-fresh.json` before the note-suite dialog handling and selector fixes were completed.
3. Direct fresh isolated VS Code launch with a custom user-data directory still fails with a mutex and renderer-launch error; see `vscode-retest-20260411-main.log`.
4. The most important remaining Drive.NET asks after this retest are exact-selector fallback guardrails and better VS Code lifecycle support.

### Confirmed improvements since the original report

1. `dismissBlocker` now works usefully against VS Code's `Save modified changes?` dialogs. During the note-suite reruns it was able to find the modal blocker and dismiss it via `Don't Save`, which materially improved same-host stability.
2. Suite-scoped saved variables appear to persist across tests now. In the updated note suite, later tests still had access to values such as the saved note menu automation ID from earlier note tests. That means item 3 in the original report should be downgraded from a current bug to a historical limitation.

### New issue found during the retest

#### 11. Guard exact selectors from overly broad fallback matches

Observed:

When the final note-removal check queried the exact deleted note automation ID with `fallback: true`, the primary selector correctly matched zero elements, but Drive.NET then fell back to a generic `ControlTypeAndName` search and returned the window `Minimize` button.

In other words, the original exact selector had already proved the note was gone, but the fallback system manufactured a false positive from an unrelated button.

Impact:

This created a misleading test failure that looked like a product-side stale note row, when the real problem was fallback broadening the query far beyond the user's requested selector.

Requested Drive.NET change:

1. If the primary selector includes an exact identifier such as `automation_id`, do not run heuristic fallback automatically after a zero-match result.
2. If fallback is still attempted, return it as low-confidence diagnostic output rather than a normal match that can satisfy or fail a test assertion.
3. Make the result shape and CLI summary explicitly say that the primary selector matched zero elements and that any fallback candidate is not semantically equivalent.

Why this matters:

Fallback is useful for exploratory queries, but it is dangerous for exact-match verification steps. The current behavior can turn a successful absence check into a false failure.

Evidence:

1. `.drive-net/test-results-manifest-retest-20260411-same-host-v4.json`
2. `.drive-net/test-results-manifest-retest-20260411-same-host-v5.json`

### Revised priority order after the 2026-04-11 retest

1. Exact-selector fallback guardrails for `fallback: true`
2. Better fresh VS Code / Electron lifecycle support
3. `helpText` / accessible-description selector support
4. Selector-based `interact`
5. Name contains / starts-with / regex selector operators
6. Monaco / VS Code editor text helpers

### Updated evidence set

1. Current passing same-host run: `.drive-net/test-results-manifest-retest-20260411-same-host-v5.json`
2. Last false-positive fallback run before the fix: `.drive-net/test-results-manifest-retest-20260411-same-host-v4.json`
3. Earlier fresh-host retest: `.drive-net/test-results-manifest-retest-20260411-fresh.json`
4. Insert succeeded visually: `.drive-net/note-crud-03-inserted-into-new-editor.png`
5. Fresh isolated VS Code lifecycle failure: `vscode-retest-20260411-main.log`

## Addendum: 2026-04-11 F5-based host launch and teardown

Follow-up summary:

1. Launching the checked-in debug configuration from the existing ButtonFu workspace window succeeds even though direct `Code.exe` and `code.cmd` isolated launches still fail with the mutex and renderer crash noted above.
2. In this environment, pressing `F5` in the live workspace produced `[Extension Development Host] Visual Studio Code` as an additional top-level window in the already-running Code process.
3. After adding a dedicated `cleanup.yaml` suite plus broader save-dialog dismissal in the CRUD suite teardowns, the current checked-in manifest passes 20/20 in `.drive-net/test-results-manifest-f5-cleanup.json`.
4. The cleanup suite now closes the Extension Development Host automatically at the end of the run. A post-run desktop window snapshot confirmed that only the main VS Code windows remained and the host window was gone.

Why this matters:

The earlier lifecycle issue is still real for direct isolated launches, but it no longer blocks a deterministic local smoke path for ButtonFu. The practical workflow on this machine is:

1. Start the host from the existing ButtonFu workspace via `F5`.
2. Run the Drive.NET manifest against the resulting `[Extension Development Host]` window.
3. Let the cleanup suite dismiss any save prompt when present and close the host when the run completes.

Additional cleanup finding:

The first version of the cleanup suite assumed that closing the host would always produce a `Save modified changes?` modal. That was too strict. In the passing 20/20 run, the host closed cleanly without surfacing that dialog, so cleanup logic now treats the modal as conditional rather than mandatory.

Evidence:

1. `.drive-net/test-results-manifest-f5-cleanup.json`
2. `.drive-net/buttonfu-window-command-palette-open.png`
3. Desktop window inventory after the final run showing no remaining `[Extension Development Host]` window