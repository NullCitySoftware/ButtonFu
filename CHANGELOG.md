# Changelog

All notable changes to ButtonFu are documented here.

## [1.0.4] - 2026-03-26

### Added
- **Keyboard shortcuts** — every button registers a unique VS Code command (`buttonfu.run.<id>`) so it can be targeted by keybindings; the editor shows a **Set Keyboard Shortcut** button (visible when editing an existing button) that opens the VS Code keybindings editor pre-filtered to that button's command; any assigned shortcut is read from `keybindings.json` and displayed on the button's card in the editor list
- **Multi-terminal execution** — Terminal Command buttons can define multiple named tabs, each with its own command text; tabs run in **parallel** by default, or switch to **sequential** mode when any tab has the *Dependant On Previous Terminal Success* flag set — a dependent tab only runs if its predecessor exits with code 0, and the chain halts on the first failure; each tab opens in its own VS Code terminal named `ButtonFu: <button> — <tab>`; uses VS Code shell integration (1.93+) for accurate exit-code detection with a three-second fallback to close-detection for older environments; the tab bar supports add, rename (double-click or F2), delete, and left/right reorder
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
