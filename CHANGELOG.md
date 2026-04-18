# Changelog

All notable changes to ButtonFu are documented here.

## [1.1.2] - 2026-04-18
### Changed
- Improvements to agent Bridge and agent discovery.

## [1.1.1] - 2026-04-14

### Added
- **Notes in the main sidebar** — ButtonFu now supports Global and Workspace notes directly in the main sidebar, grouped alongside buttons and supporting plain-text or Markdown content, preview/open, copy, insert, send-to-Copilot, and edit actions
- **Show Notes option** — the Options page now includes a `Show Notes` toggle that hides or reveals notes while preserving stored note data
- Hidden button and note CRUD commands for agent-driven automation, including batch operations and structured results

### Fixed
- Copilot prompt submission now restores the clipboard after successful sends and resolves attached files correctly in multi-root workspaces
- JSONC comment stripping in keybindings parsing now respects quoted strings
- Button API writes now ignore unexpected input fields instead of persisting them into user settings or workspace state

## [1.1.0] - 2026-04-02

### Added 
- Added support for confirmation boxes when deleting buttons from anywhere on the UI you can delete them.
- Added cog-icon buttons that open the settings at the given section in the settings.

## [1.0.7] - 2026-03-28

### Fixed
- Sequential multi-terminal execution now correctly runs all tabs — the final tab's promise was never awaited, causing the second (and any subsequent) tab to silently not execute even when the previous tab completed successfully

## [1.0.6] - 2026-03-28

### Added
- Checked-in VS Code launch configuration at `.vscode/launch.json` so pressing F5 from the repository root compiles `buttonfu-extension` and starts an Extension Development Host in one step

### Changed
- Development documentation now reflects the checked-in F5 workflow and the VS Code 1.93 minimum required by the current extension typings and shell integration API usage
- Package-local README, changelog, license, and screenshot copies are now synced and hash-verified from the repository root before packaging, keeping the root files as the canonical source
- Audit-driven refactoring extracted shared webview helpers into `src/utils.ts`, moved the editor webview JavaScript out of the giant inline template into `resources/editor.js`, and switched sidebar refreshes to message-based DOM updates instead of rebuilding the whole webview
- Extension internals were modernised around the VS Code 1.93 toolchain: typed `vscode.lm` and shell-integration APIs replaced older `any`-based access, button IDs now use `crypto.randomUUID()`, dynamic button commands are disposed cleanly, and the ESLint/TypeScript toolchain was upgraded to current major versions
- Button colours now accept 8-digit hex values with alpha in the editor text field, the pastel preset row is further saturated at the same 75%-opacity level, and the colour controls now keep the base picker, alpha slider, and effective preview in sync

### Fixed
- `npm run compile` and packaging now syntax-check `resources/editor.js` so webview JS parse errors are caught before build output is produced
- The editor now confirms destructive button deletes before removing them from the list or detail view
- Host-side validation now rejects malformed or oversized button payloads from the editor webview, keybinding parsing is more robust against JSONC comments, and terminal completion listeners now clean themselves up when fallback terminals stay open

### Security
- Terminal-command token replacement now shell-escapes untrusted token values, clipboard text is only read when `$Clipboard$` is actually referenced, Copilot prompt pasting restores the previous clipboard contents afterward, and sensitive system-token descriptions now call out when values may be sent to external services

## [1.0.5] - 2026-03-26

- Fixed pastel colour activation.

## [1.0.4] - 2026-03-26

### Added
- **Keyboard shortcuts** — every button registers a unique VS Code command (`buttonfu.run.<id>`) so it can be targeted by keybindings; the editor shows a **Set Keyboard Shortcut** button (visible when editing an existing button) that opens the VS Code keybindings editor pre-filtered to that button's command; any assigned shortcut is read from `keybindings.json` and displayed on the button's card in the editor list
- **Multi-terminal execution** — Terminal Command buttons can define multiple named tabs, each with its own command text; tabs run in **parallel** by default, or switch to **sequential** mode when any tab has the *Dependent On Previous Terminal Success* flag set — a dependent tab only runs if its predecessor exits with code 0, and the chain halts on the first failure; each tab opens in its own VS Code terminal named `ButtonFu: <button> — <tab>`; uses VS Code shell integration (1.93+) for accurate exit-code detection with a three-second fallback to close-detection for older environments; the tab bar supports add, rename (double-click or F2), delete, and left/right reorder
- **Pastel colour presets** — a second row of ten soft pastel swatches (Pastel Blue, Green, Peach, Coral, Lavender, Yellow, Teal, Rose, Periwinkle, Taupe) has been added beneath the existing vivid colour row in the button editor colour picker

## [1.0.3] - 2026-03-24

### Added
- **Warn Before Execution** — optional confirmation dialog per button; enable the toggle in the editor to require a click-through before the command runs
- **Token system** — embed `$TokenName$` placeholders anywhere in a command or Copilot prompt; tokens are resolved at execution time
  - **System tokens** (26 built-in, auto-resolved): workspace path/name, active file (full path, name, extension, directory, relative path), selected text, line/column number, current line text, button name/type, date/time (ISO, date-only, time-only), platform, hostname, username, home directory, temp directory, clipboard contents, git branch, path separator, EOL, and a random UUID
  - **User tokens** — define custom tokens per button with name, data type (String, Multi-Line String, Integer, Boolean), display label, description, optional default value, and a Required toggle
  - **Token questionnaire panel** — when a button is executed and unresolved user tokens exist, a dedicated panel collects their values before running; shows a live preview of all resolved tokens
  - **Drag-and-drop** — drag any token row from the token table directly into the command/prompt field; token is inserted at the caret position
- **Two-column editor layout** — the button editor is now split into a left column (all existing fields) and a right column (tokens panel), keeping the form compact
- **Token table UI** — section headers (`System Tokens` / `User Tokens`) with vertically centred icon and text; separate Value and DataType columns; edit/delete actions appear as a hover overlay floating over the right side of the row (hidden by default, page-background fill so text doesn't bleed through)
- **Card meta line enhancements**
  - `Tokenised [n]` badge — shows the count of unique tokens used in the command/prompt; only shown when at least one token is present
  - Copilot model name displayed for Copilot Command buttons (falls back to `auto` if none set)
- Up/down reorder arrows are now correctly disabled when a button is the only item in its category group
- Button list cards are constrained to the same max-width as the Options page and centred, keeping lines readable at large panel widths
- Workspace Buttons section header now shows the current workspace name, e.g. `Workspace Buttons [MyProject]`; updates automatically when the workspace changes

### Fixed
- Duplicating a button now correctly carries over all fields (colour, locality, icon, Copilot settings) into the editor and persists them on save
- Colour swatch selection is now synced when the editor opens, so the active swatch is highlighted for both new and duplicated buttons
- Token name input normalises `$` wrapping on save — any combination of leading/trailing `$` signs is corrected to exactly one on each side, so `$$MyToken$$`, `MyToken`, and `$MyToken` all save as `$MyToken$`
- Newly added or edited user tokens scroll into view in the token table after saving

## [1.0.2] - 2026-03-24

### Added
- **Attach active file** toggle on Copilot buttons — when enabled, the currently open editor file is automatically attached to the chat when the button is executed

### Fixed
- Autocomplete and icon picker dropdowns no longer open automatically when background data (tasks, commands, models) finishes loading; they only appear when the relevant field has focus
- All open dropdowns are now closed when the button type is changed
- All popup lists call `scrollIntoView` to ensure they are fully visible when opened
- Browse button in the Attach Files row now matches the height of the adjacent search input
- Editor panel header now renders the extension icon from `resources/icon.svg` directly, keeping it in sync with any future icon changes

## [1.0.1] - 2026-03-23

### Fixed
- Codicon icons missing in published extension (font assets excluded from package)

## [1.0.0] - 2026-03-23

### Added
- Sidebar button panel with categorised, icon-rich buttons
- Global buttons available in every workspace
- Workspace-scoped buttons specific to each project
- Visual editor for creating and configuring buttons
- **Terminal Command** button type — run shell commands in the integrated terminal
- **Command Palette Action** button type — execute any VS Code command by ID
- **Task Execution** button type — run tasks defined in `tasks.json`
- **Copilot Command** button type — send prompts to GitHub Copilot Chat with model and mode control
- Codicon icon picker for all buttons
