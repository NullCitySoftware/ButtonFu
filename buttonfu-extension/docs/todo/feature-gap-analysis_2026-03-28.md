# ButtonFu Feature Gap Analysis - 2026-03-28

## Executive Summary

ButtonFu already covers the core launcher workflow well. It can run terminal commands, VS Code commands, tasks, and Copilot prompts; supports global and workspace scopes; has categories, icons, colours, keyboard shortcuts, user/system tokens, warn-before-run, and multi-terminal execution.

The main product gap is that ButtonFu still behaves like a strong personal launcher, not yet like a governed automation layer for individual users, teams, and companies. The current implementation makes it easy to create and run a button, but much harder to:

- distribute approved button sets from a central source
- keep team or company defaults aligned while still allowing sensible local overrides
- share button sets across machines or repositories
- manage a large library of buttons efficiently
- compose multi-step workflows
- collect richer runtime input
- understand what happened after a button ran
- roll out shared automation safely across a team

If the goal is to add features that provide genuine user value rather than surface novelty, the highest-leverage areas are:

1. managed button catalogs and central repository support
2. layered configuration, overrides, and governance
3. search, quick-run, favourites, and large-library navigation
4. multi-step workflow buttons
5. richer input types, secret references, and dependency checks
6. execution visibility, status, and history

## Scope and Evidence Base

This analysis is grounded in the current extension code and shipped documentation.

Reviewed areas:

- `buttonfu-extension/package.json`
- `buttonfu-extension/README.md`
- `CHANGELOG.md`
- `buttonfu-extension/src/extension.ts`
- `buttonfu-extension/src/types.ts`
- `buttonfu-extension/src/buttonStore.ts`
- `buttonfu-extension/src/buttonExecutor.ts`
- `buttonfu-extension/src/buttonPanelProvider.ts`
- `buttonfu-extension/src/editorPanel.ts`
- `buttonfu-extension/src/tokenInputPanel.ts`
- `buttonfu-extension/resources/editor.js`

Current evidence that shapes the gap analysis:

- `src/types.ts` supports only four executable button types: `TerminalCommand`, `PaletteAction`, `TaskExecution`, and `CopilotCommand`.
- `src/buttonStore.ts` stores global buttons in the `buttonfu.globalButtons` setting and local buttons in `workspaceState`, with no repo-backed storage, import/export format, or pack abstraction.
- `src/extension.ts` exposes only the core lifecycle commands: open editor, execute, add, edit, delete, refresh, plus dynamic per-button run commands.
- `src/buttonPanelProvider.ts` groups buttons only by locality and category; there is no search, favourite, recent, filter, or visibility system.
- `resources/editor.js` supports CRUD, duplicate, reorder, token editing, and option toggles, but not bulk edit, import/export, templates, or pack management.
- `src/buttonPanelProvider.ts` and `src/editorPanel.ts` only persist a small set of local UI options in `globalState`; there is no shared ButtonFu settings profile or managed policy layer.
- `src/types.ts` limits user token input types to `String`, `MultiLineString`, `Integer`, and `Boolean`.
- `src/buttonExecutor.ts` executes actions but does not persist structured execution history or expose a first-class output/result view.
- `src/buttonExecutor.ts` attaches Copilot files from an explicit list only; there is no pattern-based or context-derived attachment model.
- `src/buttonExecutor.ts` has no concept of prerequisites, managed secret references, or centrally defined environment profiles for shared buttons.
- Multiple host paths still assume the first workspace folder, which limits multi-root value.

## What ButtonFu Already Does Well

ButtonFu is already strong in these areas:

- One-click execution of the four most useful VS Code automation targets: shell, command palette, tasks, and Copilot.
- Lightweight personal customization: icon, colour, category, locality, confirmation, shortcut.
- Token-driven parameterization with a reasonably mature questionnaire flow.
- Multi-terminal orchestration for shell commands.
- A full-screen editor that is good enough for day-to-day authoring.

That matters because the next features should extend those strengths rather than pull the product into unrelated territory.

## Where The Current Product Tops Out

The current design starts to strain in seven situations:

### 1. When a user wants to reuse or share buttons

Workspace buttons are stored in `workspaceState`, which makes them easy to keep local but hard to review, version, back up, or share with a team.

### 2. When a user has more than a small button library

The sidebar currently scales through categories and columns only. That is fine for a dozen buttons, but much weaker once the library becomes broad enough that search, favourites, or contextual filtering would matter.

### 3. When a workflow spans more than one action

Each button maps to one primary action type. Multi-terminal support helps only within terminal execution. Real workflows often combine save, task, terminal, prompt, and follow-up actions.

### 4. When a button needs richer runtime input

Primitive input types are present, but many practical workflows need choices, file picks, folder picks, secret values, remembered defaults, or data pulled from the selected files.

### 5. When the user needs confidence in outcomes

ButtonFu triggers actions well, but it provides little durable insight into whether a run succeeded, failed, produced useful output, or should be repeated.

### 6. When a team or company wants one approved source of truth

A central catalog, shared settings profile, pinned versions, layered overrides, and safe update flow do not exist yet.

### 7. When shared buttons depend on approved tools, secrets, or environment setup

The extension has no prerequisite diagnostics, managed secret references, or organization environment profiles, so shared automation will accumulate setup drift and support burden.

## Prioritized Opportunity List

The table below ranks gaps by likely user value, fit with ButtonFu's current architecture, and practical implementation leverage.

| Rank | Feature Area | User Value | Build Cost | Recommendation |
| --- | --- | --- | --- | --- |
| 1 | Managed button catalogs, central repositories, and import/export | Very high | Medium-high | Build next |
| 2 | Layered configuration, locked fields, and local overrides | Very high | Medium | Build next |
| 3 | Searchable quick-run, sidebar filtering, favourites, recents | Very high | Medium | Build next |
| 4 | Governance, trust, versioning, and rollout controls | Very high | Medium-high | Build soon |
| 5 | Workflow buttons for multi-step automation | Very high | High | Build soon |
| 6 | Rich token input types and secret storage | High | Medium | Build soon |
| 7 | Organization secrets, environment profiles, and dependency diagnostics | High | Medium-high | Build soon |
| 8 | Execution status, history, and result visibility | High | Medium-high | Build soon |
| 9 | Visibility and enablement rules | High | Medium | Build soon |
| 10 | Terminal execution context controls | High | Medium | Build soon |
| 11 | Ownership metadata, support links, and onboarding flows | Medium-high | Medium | Build after catalog support |
| 12 | Copilot attachment patterns and response destinations | High | Medium-high | Build after core workflow features |
| 13 | Templates, starter packs, and reusable presets | Medium-high | Medium | Build after pack support |
| 14 | Multi-root workspace awareness | Medium-high | Medium-high | Build progressively |
| 15 | Extra launch surfaces beyond the sidebar | Medium | Medium | Useful follow-on |
| 16 | Bulk management and archive flows | Medium | Medium | Important after adoption scales |
| 17 | Optional admin reporting and adoption insights | Low-medium | Medium | Only after trust and privacy model exist |

## Detailed Gap Analysis

## 1. Managed Button Catalogs, Central Repositories, And Import/Export

### Why this is a genuine gap

ButtonFu is already useful for personal automation, but its current storage model blocks one of the highest-value outcomes: centrally managed, reusable button libraries.

Today:

- global buttons live in user settings
- workspace buttons live in `workspaceState`
- neither model is a clean team-sharing story or a workable company distribution channel

That means users cannot easily:

- point the extension at a team-owned catalog repository or manifest
- commit project-specific buttons to source control
- review button changes in pull requests
- move a curated library between machines
- publish starter packs for a language or workflow
- roll out a shared button and settings baseline to everyone in a group

### Recommended feature shape

Add a formal catalog model with these capabilities:

- import/export JSON for ad hoc sharing
- repo-backed pack files such as `.buttonfu/buttons.json` or `.vscode/buttonfu.json`
- central catalog sources: local file path, workspace file, Git repository URL or path, or raw HTTPS endpoint
- pinned refs such as branch, tag, or commit
- shared ButtonFu settings profiles stored beside the catalog so teams can standardize layout, defaults, and policy knobs
- merge modes: add only, update matching IDs, replace existing set
- manual refresh plus background update checks with local caching

For team safety, loading repo-backed buttons should include a trust prompt because shell and Copilot buttons can execute meaningful actions.

### Why it should rank first

This is the clearest leap from "nice launcher" to "automation asset". It improves onboarding, backup, collaboration, migration, long-term retention, and creates the foundation for almost every serious team or company feature.

### Primary code touchpoints

- `src/buttonStore.ts`
- `src/extension.ts`
- `src/editorPanel.ts`
- `resources/editor.js`
- `package.json` command contributions

## 1A. Layered Configuration, Locked Fields, And Local Overrides

### Why this is a genuine gap

A central catalog is not enough on its own. Teams usually need multiple layers:

- company baseline
- team baseline
- repository-specific additions
- user-specific local overrides

Without layering, shared libraries either become too rigid to adopt or drift into local forks.

### Recommended feature shape

Add a precedence model such as:

- company pack
- team pack
- repository pack
- user local pack

Then add:

- per-field lock state for execution text, category, icon, tokens, warnings, and other managed properties
- explicit local override markers and a reset-to-managed action
- ability to add personal buttons alongside managed ones without editing the source pack
- a diff view showing where a managed button has been overridden locally

### Why it matters

This balances control and autonomy. It is the difference between something a company can roll out and something every developer eventually forks.

### Primary code touchpoints

- `src/buttonStore.ts`
- `src/types.ts`
- `src/editorPanel.ts`
- `resources/editor.js`

## 1B. Governance, Trust, Versioning, And Rollout Controls

### Why this is a genuine gap

Shared automation can execute destructive commands or exfiltrate data. A company-scale rollout needs governance primitives, not just file sync.

### Recommended feature shape

Add governance and release management features such as:

- pack schema versioning and compatibility checks
- trusted source allowlists, checksums, signatures, or publisher identity checks
- pinned versions plus upgrade diff and changelog prompts
- rollout channels such as stable and canary
- pack-level policy controls that can restrict unmanaged button types or risky execution modes
- safe versus privileged button classification with stronger confirmation for sensitive actions
- a CI-friendly validator or linter for managed catalog repositories

### Why it matters

This is what turns a shared repository into a maintainable internal platform rather than an informal collection of scripts.

### Primary code touchpoints

- `src/buttonStore.ts`
- `src/extension.ts`
- `src/buttonExecutor.ts`
- `package.json`

## 1C. Organization Secrets, Environment Profiles, And Dependency Diagnostics

### Why this is a genuine gap

Team-shared buttons usually depend on more than text. They often require secrets, terminal profiles, CLI tools, extensions, environment variables, or approved execution contexts.

### Recommended feature shape

Add organization-scale execution support such as:

- secret reference tokens resolved at run time, backed by `ExtensionContext.secrets` first and pluggable providers later
- environment profiles like `dev`, `qa`, and `prod` attached to packs or workspaces
- per-button prerequisites: extension IDs, commands, tasks, shells, operating systems, environment variables, or files
- readiness checks when a pack is installed or updated
- one-click guidance for missing dependencies
- dry-run or validation mode for managed buttons before wide rollout

### Why it matters

This dramatically lowers support burden for centrally managed button libraries and reduces "works on my machine" drift.

### Primary code touchpoints

- `src/types.ts`
- `src/tokenInputPanel.ts`
- `src/buttonExecutor.ts`
- `src/extension.ts`
- `src/editorPanel.ts`
- `resources/editor.js`

## 1D. Ownership Metadata, Support Links, And Onboarding Flows

### Why this is a genuine gap

Once buttons are shared widely, users need to know who owns them, where the docs live, and what to do when something breaks.

### Recommended feature shape

Add supportability features such as:

- per-button or per-pack metadata: owner, team, docs URL, runbook URL, last reviewed date, tags, deprecation status, and replacement button
- sidebar and editor affordances to open docs or jump to the owning team
- onboarding commands that connect a user to the organization catalog, install prerequisites, and sync required packs or settings
- pack changelog and migration notes surfaced in the extension UI
- optional, privacy-conscious adoption reporting or health exports for maintainers after the trust model is mature

### Why it matters

Shared automation without ownership becomes orphaned automation. This feature turns button packs into supportable internal tooling.

### Primary code touchpoints

- `src/types.ts`
- `src/buttonStore.ts`
- `src/buttonPanelProvider.ts`
- `src/editorPanel.ts`
- `resources/editor.js`
- `package.json`

## 2. Searchable Quick-Run, Sidebar Filtering, Favourites, And Recents

### Why this is a genuine gap

The current sidebar renders buttons by locality and category only. That is simple, but it does not scale gracefully.

Users with larger libraries will want to:

- find a button by name instantly
- pin a small favourite set
- rerun recent buttons quickly
- use ButtonFu without opening the sidebar first

### Recommended feature shape

Start with a single discovery layer rather than multiple disconnected features:

- `ButtonFu: Run Button...` command powered by `QuickPick`
- sidebar search/filter box
- optional `Favourites` and `Recent` sections

This is likely more valuable than nested menu structures as a first scale feature. Search and quick-run reduce friction for both mouse-first and keyboard-first users.

### Why it should still rank near the top

It directly improves everyday usability without requiring major data model changes.

### Primary code touchpoints

- `src/extension.ts`
- `src/buttonPanelProvider.ts`
- `src/editorPanel.ts`
- `resources/editor.js`

## 3. Workflow Buttons For Multi-Step Automation

### Why this is a genuine gap

Real developer workflows are rarely one action long. Common examples:

- save all files, run tests, then open a Copilot prompt with the failing output
- run a task, open a URL, then copy a deployment link
- run one terminal command, then execute a VS Code command

Current ButtonFu only supports one primary action type per button. Multi-terminal execution is useful but limited to shell commands.

### Recommended feature shape

Add a new workflow model made of ordered steps. Reuse the existing action handlers instead of inventing a separate runtime.

Good first version:

- linear sequence only
- stop on failure toggle
- per-step type: terminal, command, task, Copilot, open URL/file, notification
- optional per-step name for readability

Good second version:

- success/failure branches
- captured outputs as tokens for later steps

### Why it should rank this high

This turns ButtonFu from a launcher into a small automation orchestrator while still staying inside its natural product boundary.

### Primary code touchpoints

- `src/types.ts`
- `src/buttonExecutor.ts`
- `src/tokenInputPanel.ts`
- `resources/editor.js`

## 4. Rich Token Input Types And Secret Storage

### Why this is a genuine gap

The existing token system is good, but many practical workflows need inputs beyond free text, integers, booleans, and multiline text.

High-value missing token/input types:

- single-select choice
- multi-select choice
- file picker
- folder picker
- workspace folder picker
- secret or password
- remembered last value

Examples where this matters:

- pick environment: `dev`, `qa`, `prod`
- choose which service to deploy
- select a file or folder target without typing a path
- enter an API key without storing it in plain text

### Recommended feature shape

Extend `TokenDataType` and use `ExtensionContext.secrets` for secret-backed values rather than storing them in button config.

### Why it should rank above templates

It removes friction from workflows users already want to run today. It is a stronger value multiplier than adding more ways to duplicate configurations.

### Primary code touchpoints

- `src/types.ts`
- `src/tokenInputPanel.ts`
- `src/extension.ts`
- `resources/editor.js`

## 5. Execution Status, History, And Result Visibility

### Why this is a genuine gap

Today ButtonFu triggers actions but does not become the place where the user understands what happened.

Practical missing capabilities:

- visible running state for long operations
- last-run success/failure marker
- duration and timestamp
- per-button history
- easy jump to terminal/output/result location

Without this, ButtonFu is good at starting actions but weak at building trust.

### Recommended feature shape

Stage 1:

- ephemeral running indicator in the sidebar/editor
- last result metadata per button
- lightweight run history list in the editor

Stage 2:

- optional output capture for supported execution modes
- output panel or dedicated result viewer

### Caveat

Streaming full terminal output is more complex than logging metadata because terminal execution currently uses the integrated terminal rather than a process owned entirely by the extension. That should not block Stage 1.

### Primary code touchpoints

- `src/buttonExecutor.ts`
- `src/buttonPanelProvider.ts`
- `src/buttonStore.ts` or a dedicated history store
- `src/editorPanel.ts`
- `resources/editor.js`

## 6. Visibility And Enablement Rules

### Why this is a genuine gap

Every button currently appears whenever its locality is active. That creates clutter and increases the chance of running the wrong thing.

High-value rule examples:

- show only for certain file extensions or languages
- show only when text is selected
- show only in a matching workspace or folder
- disable when Copilot Chat is unavailable
- show only on a given git branch pattern

### Recommended feature shape

Use simple, safe rules rather than a full scripting language. The product value is contextual relevance, not user-authored logic engines.

Support two modes:

- hidden when rule fails
- visible but disabled with a reason tooltip

### Why it should rank highly

This is one of the cleanest ways to keep the UI useful as the library grows.

### Primary code touchpoints

- `src/types.ts`
- `src/buttonPanelProvider.ts`
- `src/extension.ts`
- `src/buttonExecutor.ts`

## 7. Terminal Execution Context Controls

### Why this is a genuine gap

Terminal buttons are powerful, but the runtime model is still minimal. Users frequently need explicit execution context rather than embedding boilerplate into every command.

Valuable missing controls:

- working directory
- terminal profile or shell selection
- environment variables
- terminal reuse versus always create new
- focus or preserve-focus behaviour

These settings reduce repeated `cd` and environment setup commands, make buttons more portable, and better align ButtonFu with how tasks are usually configured.

### Recommended feature shape

Add execution context fields at the button level, with per-tab overrides only if necessary later.

### Why it should be prioritized

This is a practical productivity feature that improves existing workflows without changing the core mental model.

### Primary code touchpoints

- `src/types.ts`
- `src/buttonExecutor.ts`
- `resources/editor.js`

## 8. Copilot Attachment Patterns And Response Destinations

### Why this is a genuine gap

Copilot buttons are already one of ButtonFu's differentiators, but the current shape is static:

- explicit file paths only
- always starts with a fresh chat flow
- no first-class response destination

Users will want more reusable prompt automation, for example:

- attach all changed files
- attach all tests in a folder
- attach files matching a glob
- send result to a new markdown note or scratch file
- choose whether to reuse current chat or start fresh

### Recommended feature shape

Best near-term additions:

- glob-based attachment patterns
- attach active selection set where the invocation surface supports it
- output destination choices: chat only, clipboard, new untitled file
- new chat versus current chat mode

### Caveat

This area is constrained by VS Code and Copilot APIs. The extension should avoid over-investing in fragile UI automation if a stable API is unavailable.

### Primary code touchpoints

- `src/types.ts`
- `src/buttonExecutor.ts`
- `resources/editor.js`

## 9. Templates, Starter Packs, And Reusable Presets

### Why this is a genuine gap

The editor supports duplication, which is useful, but duplication is not the same as reuse.

Valuable additions:

- user-defined templates
- built-in starter packs for common stacks
- "new from template" flow
- preset execution profiles for common button shapes

### Why this is not ranked higher

Templates become much more valuable once import/export or repo-backed packs exist. Without that foundation, template value is narrower and mostly local.

### Primary code touchpoints

- `src/types.ts`
- `src/buttonStore.ts`
- `resources/editor.js`

## 10. Multi-Root Workspace Awareness

### Why this is a genuine gap

The current code often uses the first workspace folder. That is workable for a single-folder project, but it weakens the extension in monorepos and multi-root workspaces.

High-value improvements:

- choose target workspace folder per button
- workspace-folder token input type
- folder-aware relative file attachment
- folder-scoped visibility rules

### Why this matters

ButtonFu is unusually well-suited to polyrepo or monorepo developer workflows. Supporting multi-root well would strengthen that positioning.

### Primary code touchpoints

- `src/buttonExecutor.ts`
- `src/buttonPanelProvider.ts`
- `src/editorPanel.ts`
- `src/types.ts`

## 11. Extra Launch Surfaces Beyond The Sidebar

### Why this is a genuine gap

The sidebar is ButtonFu's main home, but some workflows benefit from invoking buttons in-place.

High-value surfaces:

- Explorer context menu: run a button against selected files
- editor title or editor context menu for file-centric actions
- status bar area for pinned buttons
- command palette quick-run, if not already delivered as part of item 2

### Recommendation

Do not expand into every possible VS Code surface. Choose surfaces that naturally provide context to the button run.

### Primary code touchpoints

- `package.json`
- `src/extension.ts`
- `src/buttonExecutor.ts`

## 12. Bulk Management And Archive Flows

### Why this is a genuine gap

Once button libraries get larger, single-item editing becomes slow.

Practical missing flows:

- multi-select delete or move
- bulk recategorize
- bulk locality change
- archive instead of delete
- export selected subset

### Why this is lower priority

This matters mostly after adoption scale has already been achieved. It should follow search, packs, and visibility features.

### Primary code touchpoints

- `resources/editor.js`
- `src/editorPanel.ts`
- `src/buttonStore.ts`

## Agentic Implementation Plan

This section is intentionally written as an execution brief for a future implementation agent. It is not a request to start coding now. It is a phased plan that another agent can follow later.

### Operating Rules For Any Implementation Agent

- Implement exactly one phase at a time and in order.
- Do not start the next phase until the current phase has passed the mandatory review gate described below.
- Do not add features from later phases early unless the current phase cannot be completed correctly without a minimal enabling slice.
- Preserve backward compatibility for existing global and local buttons unless the current phase explicitly includes an approved migration.
- Keep migrations deterministic, reversible where practical, and visible to the user.
- Update documentation, changelog notes, tests, and migration notes in the same phase as the code change.
- Treat managed or centrally sourced buttons as higher risk than personal buttons. Favor explicit trust prompts, safe defaults, and visible provenance.
- Prefer small end-to-end slices over broad partially finished scaffolding.
- If a phase uncovers major architectural constraints, stop at the end of that phase, document the constraint, and revise the remaining phases before continuing.

### Mandatory Review Gate After Every Phase

After each phase is implemented, a full code review must be performed before any work begins on the next phase.

Required review perspectives:

1. Grumpy, nitpicky senior engineer
2. Grumpy, nitpicky senior appsec specialist
3. Senior, nitpicky UI/UX designer and implementer

Required review output format:

- findings first
- ordered by severity
- include file references and concrete behavior risk
- call out regressions, missing tests, and unresolved tradeoffs
- only after findings, include open questions or a short summary
- if no findings exist, state that explicitly and still mention residual risks or testing gaps

Required remediation rules:

- all critical and high findings must be fixed before the phase can be closed
- medium findings must either be fixed or explicitly recorded as accepted follow-up work
- low findings may be deferred, but only if documented
- after fixes, rerun the relevant validation for the changed surface

Minimum validation after every phase:

- compile/build validation for the extension
- linting for touched code
- targeted manual testing of the changed flows
- migration verification for any changed storage model

### Phase 0: Foundation Contract And Migration Design

#### Goal

Define the data contracts, trust model, migration strategy, and implementation boundaries before user-visible catalog features are added.

#### In Scope

- managed catalog schema design
- schema versioning plan
- precedence model for company, team, repository, and user layers
- migration and rollback strategy from current storage
- trust and provenance model for managed sources
- validation and test matrix for future phases

#### Out Of Scope

- shipping managed catalog loading
- shipping remote sync
- shipping search, workflow, or history UI

#### Implementation Tasks

1. Define the catalog schema for buttons, shared settings profiles, source metadata, ownership metadata, prerequisites, and policy fields.
2. Define stable IDs and collision rules for imported or centrally managed buttons.
3. Define the precedence model for company, team, repository, and user-local layers.
4. Define which fields can be locked, overridden locally, or always remain user-editable.
5. Define migration behavior from current `globalButtons` and `workspaceState` storage.
6. Define trust states for managed sources such as unknown, trusted, pinned, invalid, or deprecated.
7. Define the test matrix that later phases must satisfy, including backward-compatibility cases and multi-root edge cases.

#### Likely Code Areas

- `src/types.ts`
- `src/buttonStore.ts`
- `docs/` for schema and migration notes

#### Done When

- the schema and precedence rules are documented and versioned
- migration behavior is specified clearly enough that a follow-on agent can implement it without guessing
- trust, provenance, and override rules are explicit
- future phases have a written test matrix to inherit

#### Review Focus

- engineer: schema clarity, migration safety, future extensibility
- appsec: trust boundaries, source authenticity, safe defaults
- UI/UX: whether the model can be explained to users without confusion

### Phase 1: Managed Catalog Core And File-Backed Packs

#### Goal

Introduce the first usable managed catalog path using local or workspace-backed pack files plus import/export, without remote sync yet.

#### In Scope

- import/export JSON
- workspace or repository file-backed button packs
- shared ButtonFu settings profile loaded from pack files
- source metadata and managed-button read-only presentation
- manual refresh and disconnect flows

#### Out Of Scope

- remote HTTP or Git-based sources
- layered company or team packs
- local override editing of managed fields
- rollout channels or auto-update policies

#### Implementation Tasks

1. Add types and store support for a managed catalog source and pack manifest.
2. Load buttons and approved shared settings from a file-backed pack inside the workspace or another local path.
3. Add commands to connect a pack, disconnect a pack, import buttons, export buttons, and refresh the current pack.
4. Surface provenance in the UI so users can tell whether a button is local, global, or managed.
5. Make managed buttons read-only unless explicitly flagged as locally editable by the schema.
6. Keep existing personal buttons working unchanged alongside managed buttons.
7. Handle missing, invalid, or outdated pack files gracefully with actionable error states.

#### Likely Code Areas

- `src/buttonStore.ts`
- `src/types.ts`
- `src/extension.ts`
- `src/buttonPanelProvider.ts`
- `src/editorPanel.ts`
- `resources/editor.js`
- `package.json`

#### Done When

- a user can point ButtonFu at a pack file and see managed buttons and shared settings load successfully
- managed buttons are visibly distinct from personal buttons
- import/export works for ad hoc sharing without breaking existing storage
- existing buttons still run and edit correctly

#### Review Focus

- engineer: storage cohesion, migration safety, UI-state consistency
- appsec: file path handling, trust prompts, malformed pack handling
- UI/UX: clarity of managed versus personal state, disconnect and error flows

### Phase 2: Central Repository Sources, Caching, And Safe Update Flow

#### Goal

Allow ButtonFu to consume centrally managed catalogs from Git or URL-backed sources with an explicit, reviewable update model.

#### In Scope

- Git-backed or URL-backed catalog sources
- pinned branch, tag, or commit support
- local cache of the last known good catalog
- update check, diff preview, and apply flow
- source trust prompt and allowlist behavior

#### Out Of Scope

- multi-layer override resolution
- field locking and local overrides
- hosted marketplace or control plane

#### Implementation Tasks

1. Add source connectors for a Git repository path or URL-backed manifest, with local cache support.
2. Add pinned ref handling so teams can target a branch, tag, or specific revision.
3. Add manual update checks and a diff-oriented update preview before applying changes.
4. Cache the last known good catalog so the extension can recover from transient source failures.
5. Add trust prompts and source allowlist behavior before activating a newly discovered remote-managed catalog.
6. Make update failures visible and reversible.
7. Document the recommended repository layout for team and company catalog repositories.

#### Likely Code Areas

- `src/buttonStore.ts`
- `src/extension.ts`
- `src/editorPanel.ts`
- `resources/editor.js`
- `package.json`

#### Done When

- a user can point ButtonFu at a central repository or URL-backed catalog and load it successfully
- updates can be checked and applied without blindly replacing the current experience
- the extension falls back safely when the source is unavailable or invalid
- trust state is visible and not silently bypassed

#### Review Focus

- engineer: cache correctness, failure recovery, source abstraction quality
- appsec: source authenticity, downgrade risks, path traversal, unsafe auto-update behavior
- UI/UX: reviewability of updates, clarity of source status, confidence in rollback paths

### Phase 3: Layering, Locked Fields, Local Overrides, And Governance

#### Goal

Turn managed catalogs into a realistic team or company deployment model with deterministic layering, policy controls, and local override behavior.

#### In Scope

- precedence across company, team, repository, and user-local layers
- field locking and override markers
- reset-to-managed action
- schema compatibility checks
- rollout channels such as stable and canary if they fit the source model cleanly
- policy controls for risky or unmanaged button types

#### Out Of Scope

- prerequisite diagnostics
- secret providers
- workflow buttons

#### Implementation Tasks

1. Implement deterministic resolution across company, team, repository, and user-local layers.
2. Add field-level lock enforcement in both storage and UI.
3. Add local override markers, diff visibility, and reset-to-managed flows.
4. Add compatibility checks so unsupported schema or pack versions fail safely.
5. Add policy controls that can restrict unmanaged button creation or risky button capabilities when a managed catalog requires it.
6. Add rollout channel support only if it can be explained and enforced clearly.
7. Add a validator or linter entry point for managed catalogs so catalog maintainers can validate packs outside the extension UI.

#### Likely Code Areas

- `src/buttonStore.ts`
- `src/types.ts`
- `src/editorPanel.ts`
- `src/buttonPanelProvider.ts`
- `resources/editor.js`
- `scripts/` if a catalog validator is added

#### Done When

- layered resolution is deterministic and documented
- locked fields cannot be edited accidentally or through backdoor UI paths
- local overrides are visible and reversible
- incompatible or invalid managed catalogs fail closed rather than partially applying

#### Review Focus

- engineer: precedence correctness, override resolution bugs, validator coverage
- appsec: privilege escalation via overrides, policy bypasses, schema abuse cases
- UI/UX: user comprehension of lock state, override state, and reset behavior

### Phase 4: Discovery, Ownership Metadata, And Onboarding

#### Goal

Make large managed libraries usable and supportable by improving discovery, ownership, and first-run setup.

#### In Scope

- quick-run command
- sidebar search and filtering
- favourites and recents
- ownership metadata and support links
- onboarding flow for connecting to a managed catalog and understanding what is installed

#### Out Of Scope

- workflow buttons
- execution history
- advanced prerequisite remediation

#### Implementation Tasks

1. Add a `ButtonFu: Run Button...` command backed by `QuickPick`.
2. Add sidebar search or filter controls that scale to large button libraries.
3. Add favourites and recents in a way that does not break managed provenance.
4. Add ownership metadata such as owner, team, docs URL, runbook URL, and deprecation or replacement info.
5. Add support affordances so users can open docs or understand who owns a managed button.
6. Add onboarding commands to connect to a company or team catalog and show current source status.
7. Ensure performance remains acceptable with larger button sets.

#### Likely Code Areas

- `src/extension.ts`
- `src/buttonPanelProvider.ts`
- `src/editorPanel.ts`
- `src/types.ts`
- `resources/editor.js`
- `package.json`

#### Done When

- users can discover and run buttons quickly without relying on the sidebar layout alone
- managed buttons include ownership and support metadata where provided
- onboarding to a catalog is understandable without external tribal knowledge
- large libraries remain usable and visually coherent

#### Review Focus

- engineer: performance with large lists, state synchronization, metadata handling
- appsec: untrusted links, unsafe external navigation, spoofed metadata display
- UI/UX: search quality, information hierarchy, onboarding clarity, accessibility

### Phase 5: Rich Inputs, Secret References, Prerequisites, Visibility Rules, And Terminal Context

#### Goal

Make shared buttons safe and practical in real environments by improving runtime input quality, environment setup awareness, and execution context control.

#### In Scope

- richer token types
- secret reference tokens
- remembered values where appropriate
- environment profiles
- per-button prerequisites and readiness diagnostics
- visibility and enablement rules
- terminal working directory, shell, environment, and reuse settings

#### Out Of Scope

- multi-step workflow execution
- full output capture
- hosted secret backends beyond a clean extension point

#### Implementation Tasks

1. Extend token types to include select, multi-select, file, folder, workspace-folder, and secret-reference inputs.
2. Use `ExtensionContext.secrets` for secret-backed local storage and keep the design open for future provider integration.
3. Add environment profile selection for managed packs or workspaces.
4. Add per-button prerequisites such as required extensions, CLIs, files, shells, operating systems, or environment variables.
5. Add readiness diagnostics and actionable remediation guidance.
6. Add visibility and enablement rules so buttons can hide or disable themselves based on context.
7. Add terminal execution context controls such as working directory, shell or profile, environment variables, and terminal reuse policy.

#### Likely Code Areas

- `src/types.ts`
- `src/tokenInputPanel.ts`
- `src/buttonExecutor.ts`
- `src/buttonPanelProvider.ts`
- `src/editorPanel.ts`
- `resources/editor.js`
- `src/extension.ts`

#### Done When

- managed and personal buttons can collect richer inputs safely
- secrets are not stored in plain button config
- users can see why a button is unavailable or not ready
- terminal buttons can express context without boilerplate shell setup in every command

#### Review Focus

- engineer: validation, backward compatibility, complexity containment in the token and execution model
- appsec: secret leakage, unsafe token expansion, environment injection, prerequisite trust assumptions
- UI/UX: form usability, error messaging, disabled-state clarity, diagnostic affordances

### Phase 6: Workflow Buttons, Execution Status, History, And Copilot Expansion

#### Goal

Turn ButtonFu from a launcher into a lightweight workflow orchestrator with visible runtime state and more capable Copilot automation.

#### In Scope

- workflow button type with ordered steps
- stop-on-failure and minimal branching model
- execution status and run history
- result metadata and links back to terminals or outputs
- Copilot attachment patterns and response destinations where APIs permit

#### Out Of Scope

- full scripting language
- cron scheduling
- fragile feature additions that depend on unsupported hidden APIs

#### Implementation Tasks

1. Add a workflow button type that can sequence existing action handlers.
2. Support per-step labels, stop-on-failure, and a deliberately small first-step model.
3. Add execution state indicators such as running, succeeded, failed, and last run time.
4. Add per-button history with timestamps, duration, and outcome metadata.
5. Add links back to the originating terminal, task, or relevant output surface where practical.
6. Extend Copilot buttons with pattern-based file attachments and explicit response destinations only where the VS Code and Copilot APIs support it cleanly.
7. Avoid overbuilding the workflow DSL; keep the first version intentionally narrow.

#### Likely Code Areas

- `src/types.ts`
- `src/buttonExecutor.ts`
- `src/buttonPanelProvider.ts`
- `src/tokenInputPanel.ts`
- `src/editorPanel.ts`
- `resources/editor.js`

#### Done When

- a user can create and run a simple multi-step workflow button end to end
- failures are visible and do not leave the UI ambiguous about what happened
- history exists for troubleshooting and repetition
- Copilot enhancements are implemented only within stable, reviewable API constraints

#### Review Focus

- engineer: state-machine correctness, failure handling, test coverage for sequencing
- appsec: unsafe chaining, output exposure, Copilot attachment trust boundaries
- UI/UX: step authoring clarity, runtime feedback, recovery from failure, perceived responsiveness

### Phase 7: Scale, Polish, And Follow-On Features

#### Goal

Address the important but non-foundational features that matter after managed catalogs and workflows are stable.

#### In Scope

- templates and starter packs
- multi-root workspace awareness
- extra launch surfaces
- bulk management and archive flows
- optional admin reporting and adoption insights only after explicit privacy design and approval

#### Out Of Scope

- hosted control plane
- marketplace model
- full task-runner replacement

#### Implementation Tasks

1. Add templates or starter packs that build on the managed catalog model rather than bypassing it.
2. Add multi-root awareness across token resolution, attachments, visibility rules, and execution targeting.
3. Add extra invocation surfaces only where context genuinely improves usability.
4. Add bulk management, archive, and subset export flows for larger libraries.
5. Consider optional reporting or adoption insights only if privacy, consent, and data ownership are fully designed first.

#### Likely Code Areas

- `src/types.ts`
- `src/buttonStore.ts`
- `src/extension.ts`
- `src/buttonPanelProvider.ts`
- `src/editorPanel.ts`
- `resources/editor.js`
- `package.json`

#### Done When

- the extension scales to larger teams and libraries without collapsing into UI clutter or storage confusion
- multi-root workspaces behave predictably
- any optional reporting is clearly opt-in and privacy-safe

#### Review Focus

- engineer: scalability, multi-root correctness, maintenance cost
- appsec: privacy boundaries, consent, unsafe context injection
- UI/UX: clutter control, discoverability, bulk-flow ergonomics

### Features To Explicitly Defer Unless A Phase Requires A Small Enabling Slice

These ideas may sound attractive, but they should not be treated as primary implementation goals in the first pass.

### 1. Full scripting language or complex workflow DSL

Basic sequencing and safe rules are valuable. A full mini-language is likely to add complexity faster than value.

### 2. Cron-style scheduling or background automation

This pushes ButtonFu toward task-runner territory and adds lifecycle and trust complexity that does not need to be solved first.

### 3. Full hosted control plane or marketplace

A central repository or catalog is worth building soon. A multi-tenant hosted control plane or marketplace should wait until the repository-backed model, governance, and privacy expectations are proven.

### 4. Deep nested hierarchy as the first answer to scale

Search, quick-run, ownership metadata, favourites, and visibility rules should come before a heavy tree model.

### Implementation Directive Summary

If a future implementation agent is asked to execute this plan, the intended sequence is:

1. foundation contract and migration design
2. managed catalog core and file-backed packs
3. central repository sources and safe update flow
4. layering, locked fields, local overrides, and governance
5. discovery, ownership metadata, and onboarding
6. rich inputs, secret references, prerequisites, visibility rules, and terminal context
7. workflow buttons, execution status, history, and Copilot expansion
8. scale, polish, and follow-on features

The phase gate is part of the plan, not an optional follow-up. After every phase, stop, review the changes from all three required perspectives, fix the accepted findings, validate again, and only then continue.

That sequence keeps ButtonFu focused on its strongest identity: fast developer automation inside VS Code, while making it progressively viable as a team and company platform instead of only a personal launcher.