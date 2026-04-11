/**
 * ButtonFu shared types and interfaces.
 */

import * as crypto from 'crypto';

/** The type of action a button performs */
export type ButtonType = 
    | 'TerminalCommand'
    | 'PaletteAction'
    | 'TaskExecution'
    | 'CopilotCommand';

/** Where the button is stored */
export type ButtonLocality = 'Global' | 'Local';

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
    /** Sort position within the locality group */
    sortOrder?: number;
    /** Whether to show a confirmation dialog before executing */
    warnBeforeExecution?: boolean;
    /** User-defined tokens for prompt/command injection */
    userTokens?: UserToken[];
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
    /** Whether prompt actions should resolve tokens before execution */
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

/** Creates a new empty button with defaults */
export function createDefaultButton(locality: ButtonLocality = 'Global'): ButtonConfig {
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
        warnBeforeExecution: false,
        userTokens: []
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
        promptEnabled: false,
        copilotModel: '',
        copilotMode: 'agent',
        copilotAttachFiles: [],
        copilotAttachActiveFile: false,
        userTokens: [],
        updatedAt: Date.now()
    };
}

/** Generate a unique ID using a cryptographic random UUID */
export function generateId(): string {
    return crypto.randomUUID();
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

/** Copilot modes */
export const COPILOT_MODES = ['agent', 'ask', 'edit', 'plan'];
export const NOTE_DEFAULT_ACTIONS: NoteDefaultAction[] = ['open', 'insert', 'copilot', 'copy'];

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
    }
};
