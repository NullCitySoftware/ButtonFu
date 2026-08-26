/**
 * ButtonFu shared types and interfaces.
 */

import * as crypto from 'crypto';

/** The type of action a button performs */
export type ButtonType = 
    | 'TerminalCommand'
    | 'PaletteAction'
    | 'TaskExecution'
    | 'CopilotCommand'
    | 'ClaudeCommand';

/** Every valid button type, in editor display order. The single source of truth. */
export const BUTTON_TYPES: readonly ButtonType[] =
    ['TerminalCommand', 'PaletteAction', 'TaskExecution', 'CopilotCommand', 'ClaudeCommand'];

/** Where a ClaudeCommand button starts its session. */
export type ClaudeDestination =
    | 'terminalHere'        // integrated terminal in this window
    | 'terminalNewWindow'   // editor terminal, torn off into its own window
    | 'externalTerminal'    // a terminal outside VS Code entirely
    | 'newVsCodeWindow'     // a new VS Code window on another folder, seeded on startup
    | 'panelPrefill'        // the native Claude panel, prompt typed but NOT sent
    | 'headlessThenPanel'   // run with no UI, then open the finished session in the panel
    | 'backgroundAgent';    // claude --bg, managed from the agents list

/**
 * Where the button is stored.
 * - 'Global' — VS Code user settings (`buttonfu.globalButtons`, machine scope).
 * - 'Local' — workspace state (Memento).
 * - 'Workspace' — the read-only `buttonfu.workspaceButtons` setting, typically committed
 *   by a repo in `.vscode/settings.json`. Workspace buttons need no `id` in settings —
 *   a stable id is derived at load time (see {@link deriveWorkspaceButtonId}).
 */
export type ButtonLocality = 'Global' | 'Local' | 'Workspace';

/** Who created or has modified a saved ButtonFu item. */
export type ButtonFuItemSource = 'User' | 'Agent' | 'AgentAndUser';

/** Which actor is responsible for the current save operation. */
export type ButtonFuItemActor = 'User' | 'Agent';

export interface ButtonFuItemProvenance {
    createdBy?: ButtonFuItemActor;
    lastModifiedBy?: ButtonFuItemActor;
    source: ButtonFuItemSource;
}

export function normalizeButtonFuItemActor(actor: unknown): ButtonFuItemActor | undefined {
    return actor === 'Agent' || actor === 'User'
        ? actor
        : undefined;
}

export function normalizeButtonFuItemSource(source: unknown): ButtonFuItemSource {
    return source === 'Agent' || source === 'AgentAndUser'
        ? source
        : 'User';
}

export function getButtonFuItemActorFromSource(source: unknown): ButtonFuItemActor | undefined {
    const normalized = normalizeButtonFuItemSource(source);
    return normalized === 'AgentAndUser' ? undefined : normalized;
}

export function deriveButtonFuItemSource(
    createdBy: unknown,
    lastModifiedBy: unknown,
    legacySource?: unknown
): ButtonFuItemSource {
    const normalizedCreatedBy = normalizeButtonFuItemActor(createdBy);
    const normalizedLastModifiedBy = normalizeButtonFuItemActor(lastModifiedBy);
    const normalizedLegacySource = normalizeButtonFuItemSource(legacySource);

    if (normalizedCreatedBy && normalizedLastModifiedBy) {
        return normalizedCreatedBy === normalizedLastModifiedBy ? normalizedCreatedBy : 'AgentAndUser';
    }

    if (normalizedLegacySource === 'AgentAndUser' && (normalizedCreatedBy || normalizedLastModifiedBy)) {
        return 'AgentAndUser';
    }

    if (normalizedCreatedBy) {
        return normalizedCreatedBy;
    }

    if (normalizedLastModifiedBy) {
        return normalizedLastModifiedBy;
    }

    return normalizedLegacySource;
}

export function normalizeButtonFuItemProvenance(value: {
    createdBy?: unknown;
    lastModifiedBy?: unknown;
    source?: unknown;
}): ButtonFuItemProvenance {
    const createdBy = normalizeButtonFuItemActor(value.createdBy) ?? getButtonFuItemActorFromSource(value.source);
    const lastModifiedBy = normalizeButtonFuItemActor(value.lastModifiedBy) ?? getButtonFuItemActorFromSource(value.source);

    return {
        createdBy,
        lastModifiedBy,
        source: deriveButtonFuItemSource(createdBy, lastModifiedBy, value.source)
    };
}

export function getButtonFuItemProvenanceForNew(actor: ButtonFuItemActor): ButtonFuItemProvenance {
    return {
        createdBy: actor,
        lastModifiedBy: actor,
        source: actor
    };
}

export function mergeButtonFuItemProvenance(
    existing: {
        createdBy?: unknown;
        lastModifiedBy?: unknown;
        source?: unknown;
    },
    actor: ButtonFuItemActor
): ButtonFuItemProvenance {
    const normalized = normalizeButtonFuItemProvenance(existing);
    return {
        createdBy: normalized.createdBy,
        lastModifiedBy: actor,
        source: deriveButtonFuItemSource(normalized.createdBy, actor, normalized.source)
    };
}

/** A single terminal tab configuration */
export interface TerminalTab {
    /** Display name for the tab */
    name: string;
    /** Commands to execute (multi-line) */
    commands: string;
    /** When true, wait for the previous terminal to succeed before running this one */
    dependentOnPrevious: boolean;
}

/** A single button configuration */
export interface ButtonConfig {
    /** Unique identifier */
    id: string;
    /** Display name */
    name: string;
    /** Global or Local (workspace) */
    locality: ButtonLocality;
    /** Tooltip / description */
    description: string;
    /** What kind of action to perform */
    type: ButtonType;
    /** The script, command, prompt, or task name to execute */
    executionText: string;
    /** For TerminalCommand: array of terminal tabs (replaces executionText) */
    terminals?: TerminalTab[];
    /** Category for grouping buttons */
    category: string;
    /** Codicon icon name (e.g. "play", "terminal", "robot") */
    icon: string;
    /** Colour for the icon/button (hex or theme colour token) */
    colour: string;
    /** For CopilotCommand: which model to use */
    copilotModel: string;
    /** For CopilotCommand: which mode (agent, ask, edit, plan) */
    copilotMode: string;
    /** For CopilotCommand: files to attach */
    copilotAttachFiles: string[];
    /** For CopilotCommand: also attach the currently active editor file */
    copilotAttachActiveFile?: boolean;
    /** For ClaudeCommand: where the session starts. */
    claudeDestination?: ClaudeDestination;
    /** For ClaudeCommand: model alias or full name. Empty means the CLI default. */
    claudeModel?: string;
    /** For ClaudeCommand: effort level. Empty means the CLI default. */
    claudeEffort?: string;
    /** For ClaudeCommand: permission mode passed to --permission-mode. */
    claudePermissionMode?: string;
    /** For ClaudeCommand: working directory. Empty means the first workspace folder. Token-resolved. */
    claudeCwd?: string;
    /** For ClaudeCommand, newVsCodeWindow only: the folder the new window opens. Token-resolved. */
    claudeTargetFolder?: string;
    /** For ClaudeCommand: session display name passed to -n. Empty means the button name. */
    claudeSessionName?: string;
    /** For ClaudeCommand: extra directories passed as repeated --add-dir. Token-resolved. */
    claudeAddDirs?: string[];
    /** For ClaudeCommand: run the session in a fresh git worktree (--worktree). */
    claudeWorktree?: boolean;
    /** For ClaudeCommand: optional name for that worktree. Ignored unless claudeWorktree is true. */
    claudeWorktreeName?: string;
    /**
     * For ClaudeCommand: extra CLI arguments, already split into argv entries.
     * This is an argv array, not a command line: nothing splits it on spaces and nothing
     * passes it through a shell, so a flag and its value are two separate entries.
     */
    claudeExtraArgs?: string[];
    /** For ClaudeCommand, panel destinations only: move the Claude panel into its own window. */
    claudeNewWindow?: boolean;
    /** Sort position within the locality group */
    sortOrder?: number;
    /** Whether to show a confirmation dialog before executing */
    warnBeforeExecution?: boolean;
    /** User-defined tokens for prompt/command injection */
    userTokens?: UserToken[];
    /** Which actor originally created this button */
    createdBy?: ButtonFuItemActor;
    /** Which actor last modified this button */
    lastModifiedBy?: ButtonFuItemActor;
    /** Derived provenance summary retained for compatibility */
    source?: ButtonFuItemSource;
}

/** Content format for note text */
export type NoteContentFormat = 'PlainText' | 'Markdown';

/** Primary action triggered by clicking a note button. */
export type NoteDefaultAction = 'open' | 'insert' | 'copilot' | 'copy';

/** A saved note definition. */
export interface NoteConfig {
    /** Unique identifier */
    id: string;
    /** Display name */
    name: string;
    /** Global or Local (workspace) */
    locality: ButtonLocality;
    /** Grouping label shared with regular buttons */
    category: string;
    /** Codicon icon name */
    icon: string;
    /** Colour for the note button */
    colour: string;
    /** Sort position within the locality */
    sortOrder?: number;
    /** Note text content */
    content: string;
    /** Plain text or markdown */
    format: NoteContentFormat;
    /** Default action for the main split-button click */
    defaultAction: NoteDefaultAction;
    /** @deprecated No longer used — token resolution is automatic. Kept for migration only. */
    promptEnabled?: boolean;
    /** For Copilot prompt actions: which model to use */
    copilotModel: string;
    /** For Copilot prompt actions: which mode (agent, ask, edit, plan) */
    copilotMode: string;
    /** For Copilot prompt actions: files to attach */
    copilotAttachFiles: string[];
    /** For Copilot prompt actions: also attach the currently active editor file */
    copilotAttachActiveFile?: boolean;
    /** User-defined tokens for prompt injection */
    userTokens?: UserToken[];
    /** Last updated timestamp */
    updatedAt: number;
    /** Which actor originally created this note */
    createdBy?: ButtonFuItemActor;
    /** Which actor last modified this note */
    lastModifiedBy?: ButtonFuItemActor;
    /** Derived provenance summary retained for compatibility */
    source?: ButtonFuItemSource;
}

/** Compatibility alias for callers that still use the older name. */
export type NoteNode = NoteConfig;

export const DEFAULT_NOTE_ICON = 'note';
export const DEFAULT_NOTE_FOLDER_ICON = 'folder';
export const LEGACY_DEFAULT_NOTE_ICON = 'notebook';

export function getDefaultNoteIcon(): string {
    return DEFAULT_NOTE_ICON;
}

/** Data types available for user tokens */
export type TokenDataType = 'String' | 'MultiLineString' | 'Integer' | 'Boolean';

/** A user-defined token */
export interface UserToken {
    /** Token name including $ delimiters, e.g. $MyToken$ */
    token: string;
    /** Display label shown in the questionnaire */
    label: string;
    /** Longer description for the questionnaire */
    description: string;
    /** Data type */
    dataType: TokenDataType;
    /** Default value (empty string means user-requested) */
    defaultValue: string;
    /** Whether this token is required */
    required: boolean;
}

/** A system token definition */
export interface SystemTokenDef {
    /** Token name including $ delimiters */
    token: string;
    /** Description of what the token resolves to */
    description: string;
    /** Data type (always String for system tokens) */
    dataType: 'String';
}

/** All system tokens that can be auto-resolved */
export const SYSTEM_TOKENS: SystemTokenDef[] = [
    { token: '$WorkspacePath$', description: 'Root path of the workspace folder', dataType: 'String' },
    { token: '$WorkspaceName$', description: 'Name of the workspace folder', dataType: 'String' },
    { token: '$FullActiveFilePath$', description: 'Full file path of the active editor', dataType: 'String' },
    { token: '$ActiveFileName$', description: 'File name of the active editor (with extension)', dataType: 'String' },
    { token: '$ActiveFileExtension$', description: 'File extension of the active editor', dataType: 'String' },
    { token: '$ActiveFileDirectory$', description: 'Directory of the active file', dataType: 'String' },
    { token: '$ActiveFileRelativePath$', description: 'Workspace-relative path of the active file', dataType: 'String' },
    { token: '$SelectedText$', description: 'Currently selected text in the active editor', dataType: 'String' },
    { token: '$CurrentLineNumber$', description: 'Current line number in the active editor', dataType: 'String' },
    { token: '$CurrentColumnNumber$', description: 'Current column number in the active editor', dataType: 'String' },
    { token: '$CurrentLineText$', description: 'Text of the current line in the active editor', dataType: 'String' },
    { token: '$ButtonName$', description: 'Name of the button being executed', dataType: 'String' },
    { token: '$ButtonType$', description: 'Type of the button (TerminalCommand, CopilotCommand, etc.)', dataType: 'String' },
    { token: '$DateTime$', description: 'Current date and time (ISO 8601)', dataType: 'String' },
    { token: '$Date$', description: 'Current date (YYYY-MM-DD)', dataType: 'String' },
    { token: '$Time$', description: 'Current time (HH:MM:SS)', dataType: 'String' },
    { token: '$Platform$', description: 'Operating system platform (win32, darwin, linux)', dataType: 'String' },
    { token: '$Hostname$', description: 'Computer hostname (sensitive — may be sent to external services if used in Copilot prompts)', dataType: 'String' },
    { token: '$Username$', description: 'Current OS username (sensitive — may be sent to external services if used in Copilot prompts)', dataType: 'String' },
    { token: '$HomeDirectory$', description: 'User home directory path', dataType: 'String' },
    { token: '$TempDirectory$', description: 'System temporary directory path', dataType: 'String' },
    { token: '$Clipboard$', description: 'Current clipboard text contents', dataType: 'String' },
    { token: '$GitBranch$', description: 'Current git branch name (if available)', dataType: 'String' },
    { token: '$PathSeparator$', description: 'OS path separator (/ or \\)', dataType: 'String' },
    { token: '$EOL$', description: 'OS line ending (\\n or \\r\\n)', dataType: 'String' },
    { token: '$RandomUUID$', description: 'A random UUID (generated once per button click \u2014 all occurrences in the same command get the same value)', dataType: 'String' },
];

/**
 * Creates a new empty button with defaults.
 *
 * `defaultPermissionMode` is the `buttonfu.claude.defaultPermissionMode` setting. It is passed
 * in rather than read here, because this function is pure and must not import `vscode`.
 */
export function createDefaultButton(
    locality: ButtonLocality = 'Global',
    defaultPermissionMode?: string
): ButtonConfig {
    return {
        id: generateId(),
        name: '',
        locality,
        description: '',
        type: 'TerminalCommand',
        executionText: '',
        category: 'General',
        icon: 'play',
        colour: '',
        copilotModel: '',
        copilotMode: 'agent',
        copilotAttachFiles: [],
        copilotAttachActiveFile: false,
        claudeDestination: DEFAULT_CLAUDE_DESTINATION,
        claudeModel: '',
        claudeEffort: '',
        claudePermissionMode: CLAUDE_PERMISSION_MODES.includes(defaultPermissionMode ?? '')
            ? defaultPermissionMode!
            : DEFAULT_CLAUDE_PERMISSION_MODE,
        claudeCwd: '',
        claudeTargetFolder: '',
        claudeSessionName: '',
        claudeAddDirs: [],
        claudeWorktree: false,
        claudeWorktreeName: '',
        claudeExtraArgs: [],
        claudeNewWindow: false,
        warnBeforeExecution: false,
        userTokens: [],
        createdBy: 'User',
        lastModifiedBy: 'User',
        source: 'User'
    };
}

/** Creates a new empty note with defaults */
export function createDefaultNote(locality: ButtonLocality = 'Global'): NoteConfig {
    return {
        id: generateId(),
        name: '',
        locality,
        category: 'General',
        icon: DEFAULT_NOTE_ICON,
        colour: '',
        sortOrder: undefined,
        content: '',
        format: 'PlainText',
        defaultAction: 'open',
        promptEnabled: undefined,
        copilotModel: '',
        copilotMode: 'agent',
        copilotAttachFiles: [],
        copilotAttachActiveFile: false,
        userTokens: [],
        updatedAt: Date.now(),
        createdBy: 'User',
        lastModifiedBy: 'User',
        source: 'User'
    };
}

/** Generate a unique ID using a cryptographic random UUID */
export function generateId(): string {
    return crypto.randomUUID();
}

/**
 * Derive a stable id for a workspace button (from `buttonfu.workspaceButtons`).
 * Workspace buttons carry no `id` in settings, so the id is a hash of the fields
 * that identify the button (name + category + executionText). The id stays stable
 * across reloads as long as those fields do not change, which keeps derived
 * artefacts (e.g. `buttonfu.run.<id>` keybinding commands) stable too.
 */
export function deriveWorkspaceButtonId(name: string, category: string, executionText: string): string {
    const hash = crypto.createHash('sha256')
        .update(`${name}\u0000${category}\u0000${executionText}`, 'utf8')
        .digest('hex');
    return `ws-${hash.slice(0, 24)}`;
}

/** Available codicon icons suitable for buttons */
export const AVAILABLE_ICONS: { name: string; label: string }[] = [
    // Actions
    { name: 'play', label: 'Play' },
    { name: 'debug-start', label: 'Debug Start' },
    { name: 'run-all', label: 'Run All' },
    { name: 'stop', label: 'Stop' },
    { name: 'gear', label: 'Gear / Settings' },
    { name: 'tools', label: 'Tools' },
    { name: 'wrench', label: 'Wrench' },
    { name: 'wand', label: 'Wand' },
    { name: 'zap', label: 'Zap / Lightning' },
    { name: 'rocket', label: 'Rocket' },
    { name: 'flame', label: 'Flame' },
    { name: 'beaker', label: 'Beaker / Test' },
    { name: 'check', label: 'Check' },
    { name: 'check-all', label: 'Check All' },
    { name: 'close', label: 'Close' },
    { name: 'trash', label: 'Trash / Delete' },
    { name: 'refresh', label: 'Refresh' },
    { name: 'sync', label: 'Sync' },
    { name: 'save', label: 'Save' },
    { name: 'save-all', label: 'Save All' },
    // Terminal/Code
    { name: 'terminal', label: 'Terminal' },
    { name: 'terminal-bash', label: 'Terminal Bash' },
    { name: 'terminal-cmd', label: 'Terminal CMD' },
    { name: 'terminal-powershell', label: 'Terminal PowerShell' },
    { name: 'code', label: 'Code' },
    { name: 'file-code', label: 'File Code' },
    { name: 'console', label: 'Console' },
    // AI/Robot
    { name: 'robot', label: 'Robot / AI' },
    { name: 'copilot', label: 'Copilot' },
    { name: 'sparkle', label: 'Sparkle / AI' },
    { name: 'hubot', label: 'Hubot' },
    { name: 'comment-discussion', label: 'Chat / Discussion' },
    // Files/Folders
    { name: 'file', label: 'File' },
    { name: 'folder', label: 'Folder' },
    { name: 'folder-opened', label: 'Folder Opened' },
    { name: 'new-file', label: 'New File' },
    { name: 'new-folder', label: 'New Folder' },
    { name: 'files', label: 'Files' },
    // Build/Deploy
    { name: 'package', label: 'Package' },
    { name: 'archive', label: 'Archive' },
    { name: 'cloud-upload', label: 'Cloud Upload' },
    { name: 'cloud-download', label: 'Cloud Download' },
    { name: 'cloud', label: 'Cloud' },
    { name: 'server', label: 'Server' },
    { name: 'database', label: 'Database' },
    // Navigation/UI
    { name: 'home', label: 'Home' },
    { name: 'search', label: 'Search' },
    { name: 'filter', label: 'Filter' },
    { name: 'bookmark', label: 'Bookmark' },
    { name: 'pin', label: 'Pin' },
    { name: 'eye', label: 'Eye / View' },
    { name: 'link', label: 'Link' },
    { name: 'link-external', label: 'External Link' },
    { name: 'window', label: 'Window' },
    { name: 'split-horizontal', label: 'Split Horizontal' },
    // Source Control
    { name: 'git-commit', label: 'Git Commit' },
    { name: 'git-pull-request', label: 'Git Pull Request' },
    { name: 'git-merge', label: 'Git Merge' },
    { name: 'source-control', label: 'Source Control' },
    { name: 'repo', label: 'Repository' },
    { name: 'repo-push', label: 'Push' },
    { name: 'repo-pull', label: 'Pull' },
    // Status/Info
    { name: 'info', label: 'Info' },
    { name: 'warning', label: 'Warning' },
    { name: 'error', label: 'Error' },
    { name: 'question', label: 'Question' },
    { name: 'bell', label: 'Bell / Notification' },
    { name: 'megaphone', label: 'Megaphone' },
    { name: 'milestone', label: 'Milestone' },
    { name: 'tag', label: 'Tag' },
    // Misc
    { name: 'star-full', label: 'Star' },
    { name: 'heart', label: 'Heart' },
    { name: 'shield', label: 'Shield' },
    { name: 'lock', label: 'Lock' },
    { name: 'key', label: 'Key' },
    { name: 'lightbulb', label: 'Lightbulb' },
    { name: 'extensions', label: 'Extensions' },
    { name: 'symbol-color', label: 'Colour' },
    { name: 'symbol-event', label: 'Event' },
    { name: 'symbol-method', label: 'Method' },
    { name: 'calendar', label: 'Calendar' },
    { name: 'mail', label: 'Mail' },
    { name: 'globe', label: 'Globe' },
    { name: 'compass', label: 'Compass' },
    { name: 'dashboard', label: 'Dashboard' },
    { name: 'graph', label: 'Graph' },
    { name: 'settings-gear', label: 'Settings Gear' },
    { name: 'circuit-board', label: 'Circuit Board' },
    { name: 'note', label: 'Note' },
    { name: 'notebook', label: 'Notebook' },
    { name: 'output', label: 'Output' },
    { name: 'preview', label: 'Preview' },
    { name: 'debug-console', label: 'Debug Console' },
    { name: 'list-unordered', label: 'List' },
    { name: 'checklist', label: 'Checklist' },
    { name: 'tasklist', label: 'Task List' },
    { name: 'diff', label: 'Diff' },
    { name: 'record', label: 'Record' },
    { name: 'indent', label: 'Indent' },
    { name: 'group-by-ref-type', label: 'Group' },
    { name: 'layout', label: 'Layout' },
    { name: 'type-hierarchy', label: 'Hierarchy' },
    { name: 'combine', label: 'Combine' }
];

/** Structured result returned by API commands */
export interface ApiResult<T = unknown> {
    success: boolean;
    data?: T;
    errors?: string[];
}

/** Copilot modes */
export const COPILOT_MODES = ['agent', 'ask', 'edit', 'plan'];

/** Permission modes a Claude session can start in, in editor display order. */
export const CLAUDE_PERMISSION_MODES =
    ['bypassPermissions', 'acceptEdits', 'auto', 'plan', 'manual', 'dontAsk'];

/** The permission mode a Claude button falls back to. Unattended by design. */
export const DEFAULT_CLAUDE_PERMISSION_MODE = 'bypassPermissions';

/**
 * Where a new Claude button starts, and what an unrecognised destination falls back to.
 *
 * The panel is deliberate: it types the prompt and waits, so a button's first click never sets an
 * unattended session off against files before its author has read the prompt back. Every other
 * destination runs it, and the editor says which is which.
 */
export const DEFAULT_CLAUDE_DESTINATION: ClaudeDestination = 'panelPrefill';

/** Effort levels. The empty entry means "leave it to the CLI default". */
export const CLAUDE_EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];

/** Suggestions only. The field stays free text so a full model name works. */
export const CLAUDE_MODEL_SUGGESTIONS = ['opus', 'sonnet', 'haiku', 'fable'];

/** The fields every destination that actually invokes the CLI can set. */
const CLAUDE_CLI_FIELDS: readonly string[] = [
    'claudeModel',
    'claudeEffort',
    'claudePermissionMode',
    'claudeCwd',
    'claudeSessionName',
    'claudeAddDirs',
    'claudeWorktree',
    'claudeWorktreeName',
    'claudeExtraArgs'
];

/**
 * User-facing copy for each Claude launch destination, in editor display order.
 *
 * `runsPrompt` is false only for the native panel, which types the prompt but cannot send it.
 * `needsFolder` is true only for a new VS Code window, which has to be told what to open.
 */
export const CLAUDE_DESTINATION_INFO: Record<ClaudeDestination,
    { label: string; description: string; runsPrompt: boolean; needsFolder: boolean }> = {
    terminalHere: {
        label: 'Terminal in this window',
        description: 'Opens a terminal here and runs the prompt in it.',
        runsPrompt: true,
        needsFolder: false
    },
    terminalNewWindow: {
        label: 'Terminal in its own window',
        description: 'Opens a terminal and tears it off into a separate window, running the prompt.',
        runsPrompt: true,
        needsFolder: false
    },
    externalTerminal: {
        label: 'External terminal',
        description: 'Runs the prompt in a terminal outside VS Code.',
        runsPrompt: true,
        needsFolder: false
    },
    newVsCodeWindow: {
        label: 'New VS Code window',
        description: 'Opens another folder in a new VS Code window and runs the prompt there.',
        runsPrompt: true,
        needsFolder: true
    },
    backgroundAgent: {
        label: 'Background agent',
        description: 'Starts the session in the background and returns straight away.',
        runsPrompt: true,
        needsFolder: false
    },
    headlessThenPanel: {
        label: 'Headless, then open the panel',
        description: 'Runs the prompt with no interface, then opens the finished session in the Claude panel.',
        runsPrompt: true,
        needsFolder: false
    },
    panelPrefill: {
        label: 'Claude panel (prompt typed, not sent)',
        description: 'Opens the Claude panel with the prompt typed into the box. You press Enter yourself. This is where a new button starts.',
        runsPrompt: false,
        needsFolder: false
    }
};
export const NOTE_DEFAULT_ACTIONS: NoteDefaultAction[] = ['open', 'insert', 'copilot', 'copy'];

/**
 * Which `claude*` fields the editor shows for each destination.
 *
 * A field that means nothing for a destination is hidden rather than greyed out: an absent field
 * asks no questions, a disabled one invites "why can I not set this". The native panel takes a
 * session id and a prompt and nothing else, so a model picker there would be a lie.
 */
export const CLAUDE_FIELD_APPLICABILITY: Record<ClaudeDestination, readonly string[]> = {
    terminalHere: CLAUDE_CLI_FIELDS,
    terminalNewWindow: CLAUDE_CLI_FIELDS,
    externalTerminal: CLAUDE_CLI_FIELDS,
    newVsCodeWindow: [...CLAUDE_CLI_FIELDS, 'claudeTargetFolder'],
    backgroundAgent: CLAUDE_CLI_FIELDS,
    headlessThenPanel: [...CLAUDE_CLI_FIELDS, 'claudeNewWindow'],
    panelPrefill: ['claudeNewWindow']
};

/** Button type display names and descriptions */
export const BUTTON_TYPE_INFO: Record<ButtonType, { label: string; description: string; icon: string }> = {
    TerminalCommand: {
        label: 'Terminal Command',
        description: 'Runs a command in the integrated terminal',
        icon: 'terminal'
    },
    PaletteAction: {
        label: 'Command Palette Action',
        description: 'Executes a VS Code command palette action',
        icon: 'symbol-event'
    },
    TaskExecution: {
        label: 'Task Execution',
        description: 'Runs a task from tasks.json',
        icon: 'tasklist'
    },
    CopilotCommand: {
        label: 'Copilot Command',
        description: 'Sends a prompt to GitHub Copilot Chat',
        icon: 'copilot'
    },
    ClaudeCommand: {
        label: 'Claude Command',
        description: 'Starts a Claude Code session with the prompt already running',
        icon: 'sparkle'
    }
};
