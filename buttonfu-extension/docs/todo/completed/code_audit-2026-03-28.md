# ButtonFu Code Audit - 2026-03-28

Comprehensive audit of the ButtonFu VS Code extension codebase across four lenses: Senior Engineer, AppSec Specialist, UX/UI Designer, and VS Code Extension Expert.

---

## 1. Senior Engineer - Code Quality & Architecture

### 1.1 - Duplicated `getNonce()` and `escapeHtml()` across three files

**Severity:** Medium  
**Files:** `src/editorPanel.ts`, `src/buttonPanelProvider.ts`, `src/tokenInputPanel.ts`  
**Issue:** `getNonce()` is defined identically in all three files. `escapeHtml()` is defined identically in `editorPanel.ts`, `buttonPanelProvider.ts`, and `tokenInputPanel.ts`. DRY violation.  
**Action:** Extract both into a shared `src/utils.ts` module and import from there.

### 1.2 - `ButtonTreeProvider` is imported but never used at runtime

**Severity:** Low  
**File:** `src/buttonTreeProvider.ts`  
**Issue:** `ButtonTreeProvider` exists as a full `TreeDataProvider` implementation but the extension actually uses `ButtonPanelProvider` (a `WebviewViewProvider`) for the sidebar. The tree provider is dead code imported nowhere.  
**Action:** Delete `src/buttonTreeProvider.ts` or confirm it's intentionally kept for future use and add a comment.

### 1.3 - Massive inline HTML in `editorPanel.ts` - 3000+ line file

**Severity:** Medium  
**File:** `src/editorPanel.ts`  
**Issue:** The entire button editor UI (HTML, CSS, and JavaScript) is embedded as a single template literal string. This makes the file ~3000+ lines, is hard to maintain, difficult to lint the JS inside, and impossible to get editor support (syntax highlighting, type checking) for the embedded code.  
**Action:** Consider extracting the webview HTML/CSS/JS into separate files under `resources/` (e.g. `editor.html`, `editor.css`, `editor.js`) and loading them at runtime, or at minimum split the JS into a separate file that gets bundled.

### 1.4 - `buttonPanelProvider.ts` rebuilds entire HTML on every refresh

**Severity:** Medium  
**File:** `src/buttonPanelProvider.ts` - `refresh()` method  
**Issue:** `refresh()` replaces the entire `webview.html`, which causes a full page reload, losing scroll position and any transient UI state. For a sidebar panel that refreshes on every button change, this is wasteful.  
**Action:** Switch to a message-based approach where `refresh()` posts a message to the existing webview with updated button data, and the webview JS handles DOM diffing/replacement.

### 1.5 - `executeCopilotCommand` relies on fragile clipboard hijacking

**Severity:** High  
**File:** `src/buttonExecutor.ts` - `executeCopilotCommand()`  
**Issue:** The method copies the prompt to the clipboard, then simulates a paste action (`editor.action.clipboardPasteAction`). This overwrites the user's clipboard contents without warning and is inherently racy - another clipboard operation between the copy and paste could inject unintended content.  
**Action:** Document this limitation visibly. Ideally, explore using `workbench.action.chat.submit` with a text argument directly if the API supports it, or restore the clipboard after pasting.

### 1.6 - Magic sleep timers throughout Copilot command execution

**Severity:** Medium  
**File:** `src/buttonExecutor.ts` - `executeCopilotCommand()`  
**Issue:** Hardcoded `setTimeout` delays (50ms, 100ms, 200ms, 300ms, 350ms) are used between commands. These are fragile and may be too short on slow machines or unnecessarily long on fast ones.  
**Action:** At minimum, centralise these as named constants with comments explaining why each delay exists. Ideally, await observable state changes instead of sleeping.

### 1.7 - `reorderButton` fires `_onDidChange` via `saveGlobalButtons`/`saveLocalButtons` AND doesn't fire it

**Severity:** Low  
**File:** `src/buttonStore.ts` - `reorderButton()`  
**Issue:** `reorderButton` calls `saveGlobalButtons()` or `saveLocalButtons()`, both of which already fire `_onDidChange.fire()`. However, the method doesn't explicitly fire the event if the button isn't found in either list (silent no-op). This is correct but inconsistent - `deleteButton()` also has this no-op path.  
**Action:** Add a return value or log when a reorder/delete targets a non-existent ID to aid debugging.

### 1.8 - Event listener leak in `ButtonEditorPanel` constructor

**Severity:** Medium  
**File:** `src/editorPanel.ts` - constructor  
**Issue:** `this.store.onDidChange(...)` and `vscode.workspace.onDidChangeWorkspaceFolders(...)` are registered in the constructor. The workspace folders listener is pushed to `this.disposables` and cleaned up on panel close, but the `store.onDidChange` listener is not tracked in `this.disposables`, meaning it will leak if the store outlives the panel (which it does).  
**Action:** Push the `store.onDidChange` subscription into `this.disposables`.

### 1.9 - `generateId()` uses `Date.now()` + weak random

**Severity:** Low  
**File:** `src/types.ts` - `generateId()`  
**Issue:** `Date.now().toString(36) + Math.random().toString(36).substring(2, 9)` produces IDs that could theoretically collide under rapid creation. Not a real problem at human interaction speed, but `crypto.randomUUID()` is already imported elsewhere and would be more robust.  
**Action:** Replace with `crypto.randomUUID()` for consistency with `$RandomUUID$` token.

### 1.10 - `PowerShellCommand` legacy type handled via `as any` cast

**Severity:** Low  
**File:** `src/buttonExecutor.ts` - `executeInternal()`  
**Issue:** `case 'PowerShellCommand' as any:` is a code smell. The migration in `buttonStore.ts` should ensure no `PowerShellCommand` buttons reach the executor.  
**Action:** Remove the `PowerShellCommand` case from the executor since migration handles it in the store layer. Add a debug assertion or log if an unmigrated type somehow leaks through.

### 1.11 - `editorPanel.ts` webview JS duplicates `generateId()` logic

**Severity:** Low  
**File:** `src/editorPanel.ts` - inline JS in `addButton()` function  
**Issue:** The webview JavaScript reimplements `Date.now().toString(36) + Math.random().toString(36).substring(2, 9)` independently of `types.ts`. If the ID generation strategy changes, this copy won't be updated.  
**Action:** Have the webview request a new ID from the extension host via message, or accept this as an acceptable trade-off for webview isolation.

---

## 2. AppSec Specialist - Security

### 2.1 - Command injection via token replacement in terminal commands

**Severity:** Critical  
**File:** `src/buttonExecutor.ts` - `replaceTokens()`, `executeTerminalCommand()`  
**Issue:** User-defined token values are substituted directly into terminal command strings via `replaceTokens()`, then sent to a terminal via `terminal.sendText()`. There is no escaping or sanitisation of the token values. A user token value containing `; rm -rf /` or `&& malicious_command` will execute arbitrary commands. While users are constructing their own buttons, the risk increases if buttons are shared (e.g. committed to a `.vscode/settings.json` in a repo).  
**Action:** Document the security model clearly - that buttons are user-authored and equivalent to shell scripts. Consider warning when importing buttons from workspace-scoped settings. For system tokens like `$SelectedText$` or `$Clipboard$`, consider shell-escaping the values before terminal injection.

### 2.2 - Clipboard content read without consent indicator

**Severity:** Medium  
**File:** `src/buttonExecutor.ts` - `captureClipboard()`  
**Issue:** The extension silently reads clipboard contents on every button click (for the `$Clipboard$` system token capture). The user has no indication this is happening. Clipboard data could contain sensitive information (passwords, secrets, PII).  
**Action:** Only read the clipboard when `$Clipboard$` token is actually used in the button's command text. Currently it's read eagerly for all buttons.

### 2.3 - `$Username$`, `$Hostname$` tokens leak system identity

**Severity:** Low  
**File:** `src/types.ts`, `src/buttonExecutor.ts`  
**Issue:** System tokens expose `os.userInfo().username` and `os.hostname()`. If these are injected into commands that send data externally (e.g. a Copilot prompt), system identity is leaked to third-party services.  
**Action:** Document that these tokens may be injected into external-facing commands. Consider marking tokens as "sensitive" in the UI.

### 2.4 - Keybindings file read uses manual JSON parsing with comment stripping

**Severity:** Medium  
**File:** `src/editorPanel.ts` - `getButtonKeybindings()`  
**Issue:** The method reads the user's `keybindings.json` directly from the filesystem and strips comments with regex (`/\/\*[\s\S]*?\*\//g` and `/\/\/[^\n]*/g`). This is fragile: it can't handle strings containing `//` or `/*`, edge cases in JSONC. A malformed file could cause `JSON.parse` to throw, which is caught but silently swallowed.  
**Action:** Use `jsonc-parser` (already a transitive dependency of VS Code) or use the VS Code settings API to read keybindings if available. At minimum, add a more robust JSONC parser.

### 2.5 - Git HEAD file read traverses based on workspace path

**Severity:** Low  
**File:** `src/buttonExecutor.ts` - `getGitBranch()`  
**Issue:** Reads `.git/HEAD` via `fs.readFileSync()` using the workspace path. If a malicious workspace manipulates the path (e.g. symlinks), this could read unexpected files. The impact is limited since it only reads one specific file, and the result is used as a token value.  
**Action:** Low priority. Consider using VS Code's built-in git extension API (`vscode.extensions.getExtension('vscode.git')`) instead of raw filesystem access.

### 2.6 - Webview CSP allows `'unsafe-inline'` for styles

**Severity:** Low  
**Files:** `src/editorPanel.ts`, `src/buttonPanelProvider.ts`, `src/tokenInputPanel.ts`  
**Issue:** All three webviews use `style-src 'unsafe-inline'` in their CSP. While styles are less dangerous than scripts, this weakens the CSP unnecessarily.  
**Action:** Use nonce-based style-src to match the existing nonce-based script-src. The `<style nonce="${nonce}">` is already present but `'unsafe-inline'` overrides the nonce requirement for styles.

### 2.7 - `resolveFilePath` allows absolute paths for Copilot file attachments

**Severity:** Low  
**File:** `src/buttonExecutor.ts` - `resolveFilePath()`  
**Issue:** If a button configuration specifies an absolute path in `copilotAttachFiles`, it can reference any file on the filesystem. This is by design (buttons are user-authored) but could be exploited if workspace-scoped buttons are not trusted.  
**Action:** Consider restricting file attachments to workspace-relative paths when the button source is `Local` (workspace-scoped).

### 2.8 - No input validation on `message.button` from webview

**Severity:** Medium  
**File:** `src/editorPanel.ts` - `handleMessage()` case `saveButton`  
**Issue:** `message.button` from the webview is cast directly to `ButtonConfig` and passed to `store.saveButton()` with no server-side validation. A compromised or manipulated webview could send malformed data (wrong types, missing fields, excessively long strings).  
**Action:** Add validation in `handleMessage` before saving: check required fields, validate types, enforce length limits on strings.

---

## 3. UX/UI Designer - User Experience

### 3.1 - No visual feedback after button execution

**Severity:** Medium  
**File:** `src/buttonPanelProvider.ts`  
**Issue:** When a user clicks a sidebar button, there's no visual feedback (no loading spinner, no success/failure indicator, no brief highlight animation). The button just sits there. For Copilot commands in particular, there's a multi-second delay with no indication anything is happening.  
**Action:** Add a brief visual state change on click (e.g. temporary opacity change, a checkmark flash, or a loading spinner for Copilot commands).

### 3.2 - Delete button in editor has no confirmation dialog

**Severity:** Medium  
**File:** `src/editorPanel.ts` - webview JS `deleteCurrentButton()`  
**Issue:** Clicking "Delete" in the button editor immediately deletes the button via `confirmDelete()` with no confirmation dialog. The sidebar delete command has a confirmation (in `extension.ts`), creating inconsistent behaviour.  
**Action:** Add a confirmation prompt before deletion in the editor panel, consistent with the sidebar delete flow.

### 3.3 - Editor save doesn't validate command content

**Severity:** Low  
**File:** `src/editorPanel.ts` - webview JS `saveButton()`  
**Issue:** The only validation is checking that the button has a name. A user can save a button with an empty command, an invalid task name, or an empty Copilot prompt. These will silently fail at execution time.  
**Action:** Add validation warnings (not hard blocks) for empty execution text, unknown task names, etc. At minimum, warn if `executionText` is empty for non-TerminalCommand types, or if all terminal tabs have empty commands.

### 3.4 - Terminal tab rename minimum length of 2 is undiscoverable

**Severity:** Low  
**File:** `src/editorPanel.ts` - webview JS `commitTabRename()`  
**Issue:** If the user types a single character as a tab name, the rename is silently rejected and the old name is kept. There's no visual feedback or tooltip explaining the 2-character minimum.  
**Action:** Either show an inline validation message, or lower the minimum to 1 character.

### 3.5 - No keyboard accessibility for sidebar buttons

**Severity:** Medium  
**File:** `src/buttonPanelProvider.ts`  
**Issue:** The sidebar buttons are `<button>` elements (good), but there are no `aria-label` attributes, no keyboard shortcut hints in tooltips, and no focus-visible styling. Users relying on keyboard navigation or screen readers will have a degraded experience.  
**Action:** Add `aria-label` attributes to buttons, include keyboard shortcut info in tooltips when available, and ensure focus-visible styling is present.

### 3.6 - Options changes on "Sidebar Columns" fire on every keystroke

**Severity:** Low  
**File:** `src/editorPanel.ts` - webview JS `onOptionChanged()`  
**Issue:** The `opt-columns` input has both `change` and `input` event listeners calling `onOptionChanged()`, which sends a message to the extension host on every keystroke. This causes rapid re-renders of the sidebar panel.  
**Action:** Debounce the `input` event handler, or only react to `change` events for the number input.

### 3.7 - Category sorting is purely alphabetical with no user control

**Severity:** Low  
**Files:** `src/buttonPanelProvider.ts`, `src/editorPanel.ts`  
**Issue:** Categories are always sorted alphabetically. Users cannot control the display order of categories.  
**Action:** Consider adding a category sort order mechanism, or at minimum use the order in which categories first appear based on button sort order.

### 3.8 - Button colour picker has no "clear/reset" option in the picker row

**Severity:** Low  
**File:** `src/editorPanel.ts`  
**Issue:** The colour row has a native `<input type="color">` picker and a text input. To remove a colour, the user must manually clear the text input. The white "Default (no colour)" swatch at the end of the first preset row handles this, but it's not obvious.  
**Action:** Add a small "clear" button (`×`) next to the colour text input when a colour is set, or label the white swatch more clearly.

---

## 4. VS Code Extension Expert - Extension API & Patterns

### 4.1 - `onStartupFinished` activation may be unnecessary

**Severity:** Low  
**File:** `package.json` - `activationEvents`  
**Issue:** The extension activates on `onStartupFinished`, meaning it loads on every VS Code startup even if the user never interacts with the ButtonFu sidebar. Since the extension contributes a view container, VS Code will activate it when the view is first shown via `onView:buttonfu.buttonsView`.  
**Action:** Replace `onStartupFinished` with `onView:buttonfu.buttonsView` to defer activation until the user actually opens the ButtonFu panel, thus improving VS Code startup performance.

### 4.2 - Dynamic command registration via `buttonfu.run.{id}` grows unboundedly

**Severity:** Medium  
**File:** `src/extension.ts` - `registerButtonCommands()`  
**Issue:** Each button gets a persistent command registered via `vscode.commands.registerCommand()` pushed to `context.subscriptions`. Deleted button commands are disposed from the map but remain in `context.subscriptions` (the array doesn't remove disposed items). Over a long session with many create/delete cycles, this array accumulates dead disposables.  
**Action:** Track button command disposables separately and don't push them to `context.subscriptions`. Manage their lifecycle entirely through `buttonCommandDisposables`.

### 4.3 - `retainContextWhenHidden: true` on the editor panel consumes memory

**Severity:** Low  
**File:** `src/editorPanel.ts` - `createOrShow()`  
**Issue:** The editor panel uses `retainContextWhenHidden: true`, which keeps the webview's full JS context alive even when the tab is not visible. For a complex editor with cached data (commands, tasks, models, workspace files), this can consume significant memory.  
**Action:** This is a deliberate trade-off (avoids re-loading data when switching tabs). Document the decision. Consider releasing caches when the panel becomes hidden via `onDidChangeViewState`.

### 4.4 - `vscode.lm` API accessed via `any` cast

**Severity:** Medium  
**Files:** `src/buttonExecutor.ts`, `src/editorPanel.ts`  
**Issue:** `(vscode as any).lm` is used to access the Language Model API. This bypasses type checking entirely. The API is now stable in recent VS Code versions and has proper TypeScript typings in `@types/vscode`.  
**Action:** Update `@types/vscode` to a version that includes the `vscode.lm` types (1.90+), then remove the `any` casts and use the proper typed API.

### 4.5 - Shell integration API accessed via `any` casts

**Severity:** Low  
**File:** `src/buttonExecutor.ts` - `runTerminalTabAndWait()`  
**Issue:** `(terminal as any).shellIntegration` and `(vscode.window as any).onDidEndTerminalShellExecution` use `any` casts. These APIs are available in `@types/vscode` 1.93+.  
**Action:** Bump the minimum VS Code version or use conditional typing to access these APIs properly.

### 4.6 - No `when` clause filtering on extension commands

**Severity:** Low  
**File:** `package.json` - `commands`  
**Issue:** Commands like `buttonfu.editButton` and `buttonfu.deleteButton` are registered globally with no `when` clause. They appear in the command palette even though they require a tree item argument (`item.buttonId`). Running them from the palette will fail silently.  
**Action:** Add `when` clauses to hide context-only commands from the palette, or add a proper `when` context key. Alternatively, mark them with `"enablement": "false"` to hide from the palette while keeping tree context menu availability.

### 4.7 - `view/item/context` is empty in menus contribution

**Severity:** Low  
**File:** `package.json` - `menus.view/item/context`  
**Issue:** The `view/item/context` array is empty (`[]`). Since the sidebar is a webview (not a tree view), context menus for tree items don't apply. However, `buttonfu.editButton` and `buttonfu.deleteButton` commands exist but are unreachable from menus - they can only be triggered programmatically.  
**Action:** Either remove the empty `view/item/context` to avoid confusion, or if tree view support is planned, add the context menu items.

### 4.8 - Settings scope for `globalButtons` should be `machine` not `application`

**Severity:** Medium  
**File:** `package.json` - `configuration.properties.buttonfu.globalButtons`  
**Issue:** The `scope` is `application`, meaning it syncs across machines if Settings Sync is enabled. For buttons containing machine-specific paths, hostnames, or commands, this could cause broken buttons on synced machines.  
**Action:** Consider changing scope to `machine` to prevent Settings Sync from propagating buttons to other machines, or make this configurable. At minimum, document that buttons with absolute paths may break on synced machines.

### 4.9 - Copilot command execution doesn't check for Copilot extension availability

**Severity:** Medium  
**File:** `src/buttonExecutor.ts` - `executeCopilotCommand()`  
**Issue:** If the GitHub Copilot Chat extension is not installed, the method will fail through multiple catch blocks before showing a generic warning. There's no upfront check.  
**Action:** Check for the Copilot Chat extension via `vscode.extensions.getExtension('GitHub.copilot-chat')` at the start and show a clear error message if it's not installed.

### 4.10 - Disposable leak: `onDidCloseTerminal` listeners in `runTerminalTabAndWait`

**Severity:** Medium  
**File:** `src/buttonExecutor.ts` - `runTerminalTabAndWait()`  
**Issue:** In the fallback path, `vscode.window.onDidCloseTerminal` registers a listener that's only disposed when the specific terminal closes. If the terminal is never closed (user leaves it open), this listener leaks indefinitely. The `setTimeout` fallback at 3000ms also creates a potential for dangling listeners.  
**Action:** Add a timeout to the `onDidCloseTerminal` listener as well, and ensure all code paths dispose the listener.

### 4.11 - ESLint and TypeScript versions are outdated

**Severity:** Low  
**File:** `package.json` - `devDependencies`  
**Issue:** `eslint@^8.54.0` (ESLint 8 is EOL), `@typescript-eslint/*@^6.13.0` (v6 is outdated, v8 is current), and `typescript@^5.3.2` (5.3 is old, 5.7+ is current). These packages may have known bugs or missing features.  
**Action:** Update to ESLint 9+ with the new flat config, `@typescript-eslint` v8+, and TypeScript 5.7+.

### 4.12 - `buttonStore.ts` migration runs on every read

**Severity:** Low  
**File:** `src/buttonStore.ts` - `migrateButton()`  
**Issue:** The `migrateButton()` method runs on every call to `getGlobalButtons()` and `getLocalButtons()`. While the migration is lightweight (no I/O), it processes all buttons on every access. It also never writes the migrated data back, so the legacy format persists in storage indefinitely.  
**Action:** Run migration once at activation time and persist the migrated data back to storage, then simplify the read path.

---

## Summary

| Lens | Critical | High | Medium | Low |
|------|----------|------|--------|-----|
| Senior Engineer | 0 | 1 | 4 | 6 |
| AppSec | 1 | 0 | 3 | 4 |
| UX/UI | 0 | 0 | 3 | 5 |
| VS Code Expert | 0 | 0 | 5 | 7 |
| **Total** | **1** | **1** | **15** | **22** |

**Top priority items:**
1. **§2.1** - Token injection in terminal commands (Critical)
2. **§1.5** - Clipboard hijacking in Copilot commands (High)
3. **§2.8** - No input validation on webview messages (Medium)
4. **§1.8** - Event listener leak in editor panel (Medium)
5. **§4.2** - Unbounded dynamic command registration (Medium)
6. **§4.9** - No Copilot extension availability check (Medium)
