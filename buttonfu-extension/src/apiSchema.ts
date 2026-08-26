/**
 * Self-describing schema for the ButtonFu Agent Bridge API.
 *
 * Returned by the `buttonfu.api.describe` introspection method so that
 * connecting agents can discover available operations, parameter shapes,
 * and validation rules without reading source files.
 */

// ---------------------------------------------------------------------------
// Schema types
// ---------------------------------------------------------------------------

export const AGENT_BRIDGE_NAME = 'ButtonFu Agent Bridge';
export const AGENT_BRIDGE_SCHEMA_VERSION = 2;

export interface ApiParamField {
    name: string;
    type: string;
    required: boolean;
    description: string;
    maxLength?: number;
    enum?: readonly string[];
    default?: unknown;
    items?: ApiParamField[];
}

export interface ApiMethodSchema {
    method: string;
    description: string;
    params: ApiParamField[] | string;
    returns: string;
    supportsBatch?: boolean;
    example?: { params: unknown; result: unknown };
    /** Further worked examples, params only, for shapes the main example does not cover. */
    additionalExamples?: { params: unknown }[];
}

export interface AutomationGuidance {
    preferredAutomationSurface: string;
    supportedMutationSurface: string;
    unsupportedAutomationMutationSurfaces: string[];
    automationWarnings: string[];
}

export interface ApiSchemaRoot {
    name: string;
    version: string;
    schemaVersion: number;
    protocol: string;
    transport: string;
    description: string;
    authentication: string;
    automationGuidance: AutomationGuidance;
    methods: ApiMethodSchema[];
    types: Record<string, ApiParamField[]>;
    errorCodes: Record<number, string>;
}

/** Bridge context returned by getBridgeContext and enriched onto mutation results. */
export interface BridgeContext {
    windowId: string;
    vscodePid: number;
    workspaceName: string;
    workspaceFolders: string[];
    hasWorkspace: boolean;
    globalButtonCount: number;
    localButtonCount: number;
    globalNoteCount: number;
    localNoteCount: number;
}

// ---------------------------------------------------------------------------
// Shared field definitions
// ---------------------------------------------------------------------------

const buttonFields: ApiParamField[] = [
    { name: 'name', type: 'string', required: true, description: 'Display name.', maxLength: 500 },
    { name: 'locality', type: 'string', required: true, description: 'Storage scope.', enum: ['Global', 'Local'] },
    { name: 'description', type: 'string', required: false, description: 'Tooltip / description text.', maxLength: 5000 },
    { name: 'type', type: 'string', required: false, description: 'Action type. Defaults to TerminalCommand.', enum: ['TerminalCommand', 'PaletteAction', 'TaskExecution', 'CopilotCommand', 'ClaudeCommand'], default: 'TerminalCommand' },
    { name: 'executionText', type: 'string', required: false, description: 'The command, prompt, or task name to execute.', maxLength: 100000 },
    { name: 'terminals', type: 'TerminalTab[]', required: false, description: 'Multi-tab terminal configuration (replaces executionText for TerminalCommand).' },
    { name: 'category', type: 'string', required: false, description: 'Grouping label for the sidebar tree.', maxLength: 200, default: 'General' },
    { name: 'icon', type: 'string', required: false, description: 'Codicon icon name (e.g. "play", "terminal", "rocket").', default: 'play' },
    { name: 'colour', type: 'string', required: false, description: 'Hex colour (e.g. "#ff0000") or empty for default.' },
    { name: 'copilotModel', type: 'string', required: false, description: 'For CopilotCommand: model ID (e.g. "claude-opus-4.6").' },
    { name: 'copilotMode', type: 'string', required: false, description: 'For CopilotCommand: chat mode.', enum: ['agent', 'ask', 'edit', 'plan'], default: 'agent' },
    { name: 'copilotAttachFiles', type: 'string[]', required: false, description: 'For CopilotCommand: workspace-relative file paths to attach.' },
    { name: 'copilotAttachActiveFile', type: 'boolean', required: false, description: 'For CopilotCommand: also attach the active editor file.' },
    { name: 'claudeDestination', type: 'string', required: false, description: 'For ClaudeCommand: where the session starts. The default, panelPrefill, types the prompt into the Claude panel and waits for the user to send it; it also ignores claudeModel, claudeEffort and claudePermissionMode, because the panel has nowhere to put them. Every other destination runs the prompt and honours those fields.', enum: ['terminalHere', 'terminalNewWindow', 'externalTerminal', 'newVsCodeWindow', 'backgroundAgent', 'headlessThenPanel', 'panelPrefill'], default: 'panelPrefill' },
    { name: 'claudeModel', type: 'string', required: false, description: 'For ClaudeCommand: model alias or full name (e.g. "opus"). Empty means the CLI default.' },
    { name: 'claudeEffort', type: 'string', required: false, description: 'For ClaudeCommand: reasoning effort. Empty means the CLI default.', enum: ['', 'low', 'medium', 'high', 'xhigh', 'max'] },
    { name: 'claudePermissionMode', type: 'string', required: false, description: 'For ClaudeCommand: permission mode the session starts in.', enum: ['bypassPermissions', 'acceptEdits', 'auto', 'plan', 'manual', 'dontAsk'], default: 'bypassPermissions' },
    { name: 'claudeCwd', type: 'string', required: false, description: 'For ClaudeCommand: working directory. Empty means the first workspace folder. Tokens are resolved.' },
    { name: 'claudeTargetFolder', type: 'string', required: false, description: 'For ClaudeCommand with claudeDestination "newVsCodeWindow": the folder the new window opens. Required for that destination.' },
    { name: 'claudeSessionName', type: 'string', required: false, description: 'For ClaudeCommand: session display name. Empty means the button name.' },
    { name: 'claudeAddDirs', type: 'string[]', required: false, description: 'For ClaudeCommand: extra directories the session may read, one --add-dir each.' },
    { name: 'claudeWorktree', type: 'boolean', required: false, description: 'For ClaudeCommand: run the session in a fresh git worktree.' },
    { name: 'claudeWorktreeName', type: 'string', required: false, description: 'For ClaudeCommand: name for that worktree. Ignored unless claudeWorktree is true.' },
    { name: 'claudeExtraArgs', type: 'string[]', required: false, description: 'For ClaudeCommand: extra CLI arguments as argv entries. Nothing is split on spaces, so a flag and its value are two entries.' },
    { name: 'claudeNewWindow', type: 'boolean', required: false, description: 'For ClaudeCommand panel destinations: move the Claude panel into its own window.' },
    { name: 'sortOrder', type: 'number', required: false, description: 'Sort position within the category.' },
    { name: 'warnBeforeExecution', type: 'boolean', required: false, description: 'Show a confirmation dialog before executing.' },
    { name: 'userTokens', type: 'UserToken[]', required: false, description: 'User-defined tokens for prompt/command injection.' }
];

const noteFields: ApiParamField[] = [
    { name: 'name', type: 'string', required: true, description: 'Display name.', maxLength: 500 },
    { name: 'locality', type: 'string', required: true, description: 'Storage scope.', enum: ['Global', 'Local'] },
    { name: 'content', type: 'string', required: false, description: 'Note text content.', maxLength: 500000 },
    { name: 'format', type: 'string', required: false, description: 'Content format.', enum: ['PlainText', 'Markdown'], default: 'PlainText' },
    { name: 'defaultAction', type: 'string', required: false, description: 'Primary action triggered by clicking the note.', enum: ['open', 'insert', 'copilot', 'copy'], default: 'open' },
    { name: 'category', type: 'string', required: false, description: 'Grouping label for the sidebar tree.', maxLength: 200, default: 'General' },
    { name: 'icon', type: 'string', required: false, description: 'Codicon icon name.', default: 'note' },
    { name: 'colour', type: 'string', required: false, description: 'Hex colour or empty for default.' },
    { name: 'sortOrder', type: 'number', required: false, description: 'Sort position within the category.' },

    { name: 'copilotModel', type: 'string', required: false, description: 'For Copilot prompt actions: model ID.' },
    { name: 'copilotMode', type: 'string', required: false, description: 'For Copilot prompt actions: chat mode.', enum: ['agent', 'ask', 'edit', 'plan'], default: 'agent' },
    { name: 'copilotAttachFiles', type: 'string[]', required: false, description: 'For Copilot prompt actions: file paths to attach.' },
    { name: 'copilotAttachActiveFile', type: 'boolean', required: false, description: 'For Copilot prompt actions: also attach the active editor file.' },
    { name: 'userTokens', type: 'UserToken[]', required: false, description: 'User-defined tokens for prompt injection.' }
];

const userTokenFields: ApiParamField[] = [
    { name: 'token', type: 'string', required: true, description: 'Token name with $ delimiters, e.g. "$MyToken$".' },
    { name: 'label', type: 'string', required: true, description: 'Display label shown in the input dialog.' },
    { name: 'description', type: 'string', required: false, description: 'Longer description for the input dialog.' },
    { name: 'dataType', type: 'string', required: false, description: 'Data type.', enum: ['String', 'MultiLineString', 'Integer', 'Boolean'], default: 'String' },
    { name: 'defaultValue', type: 'string', required: false, description: 'Default value (empty means user must provide).' },
    { name: 'required', type: 'boolean', required: false, description: 'Whether the user must provide a value.', default: true }
];

const bridgeContextFields: ApiParamField[] = [
    { name: 'windowId', type: 'string', required: true, description: 'Unique ID for this VS Code window/session.' },
    { name: 'vscodePid', type: 'number', required: true, description: 'OS process ID of the VS Code instance.' },
    { name: 'workspaceName', type: 'string', required: true, description: 'Name of the open workspace (empty if no workspace).' },
    { name: 'workspaceFolders', type: 'string[]', required: true, description: 'Absolute paths of all workspace folders.' },
    { name: 'hasWorkspace', type: 'boolean', required: true, description: 'Whether a workspace/folder is currently open.' },
    { name: 'globalButtonCount', type: 'number', required: true, description: 'Number of global buttons in this store.' },
    { name: 'localButtonCount', type: 'number', required: true, description: 'Number of local (workspace) buttons.' },
    { name: 'globalNoteCount', type: 'number', required: true, description: 'Number of global notes in this store.' },
    { name: 'localNoteCount', type: 'number', required: true, description: 'Number of local (workspace) notes.' }
];

const terminalTabFields: ApiParamField[] = [
    { name: 'name', type: 'string', required: true, description: 'Display name for the terminal tab.' },
    { name: 'commands', type: 'string', required: true, description: 'Commands to execute (multi-line).' },
    { name: 'dependentOnPrevious', type: 'boolean', required: false, description: 'Wait for the previous tab to succeed first.', default: false }
];

// ---------------------------------------------------------------------------
// Method definitions
// ---------------------------------------------------------------------------

const methods: ApiMethodSchema[] = [
    {
        method: 'buttonfu.api.createButton',
        description: 'Create one or more buttons. Pass a single object or an array for batch creation.',
        params: buttonFields,
        returns: 'ApiResult<ButtonConfig> | ApiResult<ButtonConfig>[]',
        supportsBatch: true,
        example: {
            params: { name: 'Run Tests', locality: 'Global', type: 'TerminalCommand', executionText: 'npm test', category: 'Dev', icon: 'beaker' },
            result: { success: true, data: { id: '<generated-uuid>', name: 'Run Tests', locality: 'Global', type: 'TerminalCommand', executionText: 'npm test', category: 'Dev', icon: 'beaker', colour: '' } }
        },
        additionalExamples: [
            {
                params: {
                    name: 'Plan this repo', locality: 'Global', type: 'ClaudeCommand',
                    executionText: 'Read AGENTS.md and summarise what this repo does.',
                    claudeDestination: 'terminalNewWindow', claudeModel: 'opus', category: 'Claude', icon: 'sparkle'
                }
            }
        ]
    },
    {
        method: 'buttonfu.api.getButton',
        description: 'Retrieve a single button by ID.',
        params: 'string (button ID) or { id: string }',
        returns: 'ApiResult<ButtonConfig>'
    },
    {
        method: 'buttonfu.api.listButtons',
        description: 'List all buttons, optionally filtered by locality. Workspace buttons come from the buttonfu.workspaceButtons setting and are read-only.',
        params: 'undefined (all) or { locality: "Global" | "Local" | "Workspace" }',
        returns: 'ApiResult<ButtonConfig[]>'
    },
    {
        method: 'buttonfu.api.updateButton',
        description: 'Update an existing button. Pass the id plus any fields to change. Workspace buttons (locality "Workspace") are read-only and cannot be updated.',
        params: '{ id: string, ...fields }  - accepts all ButtonConfig fields except id',
        returns: 'ApiResult<ButtonConfig>'
    },
    {
        method: 'buttonfu.api.deleteButton',
        description: 'Delete one or more buttons by ID. Pass a string, { id }, or an array for batch. Workspace buttons (locality "Workspace") are read-only and cannot be deleted.',
        params: 'string | { id: string } | string[] | { ids: string[] }',
        returns: 'ApiResult<{ id: string }> | ApiResult<{ id: string }>[]',
        supportsBatch: true
    },
    {
        method: 'buttonfu.api.createNote',
        description: 'Create one or more notes. Pass a single object or an array for batch creation.',
        params: noteFields,
        returns: 'ApiResult<NoteConfig> | ApiResult<NoteConfig>[]',
        supportsBatch: true,
        example: {
            params: { name: 'Deployment Checklist', locality: 'Global', content: '- [ ] Run tests\n- [ ] Update version', format: 'Markdown' },
            result: { success: true, data: { id: '<generated-uuid>', name: 'Deployment Checklist', locality: 'Global', content: '- [ ] Run tests\n- [ ] Update version', format: 'Markdown', defaultAction: 'open' } }
        }
    },
    {
        method: 'buttonfu.api.getNote',
        description: 'Retrieve a single note by ID.',
        params: 'string (note ID) or { id: string }',
        returns: 'ApiResult<NoteConfig>'
    },
    {
        method: 'buttonfu.api.listNotes',
        description: 'List all notes, optionally filtered by locality.',
        params: 'undefined (all) or { locality: "Global" | "Local" }',
        returns: 'ApiResult<NoteConfig[]>'
    },
    {
        method: 'buttonfu.api.updateNote',
        description: 'Update an existing note. Pass the id plus any fields to change.',
        params: '{ id: string, ...fields }  - accepts all NoteConfig fields except id and updatedAt',
        returns: 'ApiResult<NoteConfig>'
    },
    {
        method: 'buttonfu.api.deleteNote',
        description: 'Delete one or more notes by ID. Pass a string, { id }, or an array for batch.',
        params: 'string | { id: string } | string[] | { ids: string[] }',
        returns: 'ApiResult<{ id: string }> | ApiResult<{ id: string }>[]',
        supportsBatch: true
    },
    {
        method: 'buttonfu.api.runButton',
        description:
            'Run a button. Off by default and Claude-only: it answers with an error unless '
            + 'buttonfu.claude.allowBridgeRun is true, and it refuses any button whose type is not '
            + 'ClaudeCommand. The three refusals are distinct: the setting being off, the button not '
            + 'being found, and the button being the wrong type. A button that declares user tokens '
            + 'with no default is also refused unless the values are supplied, because a bridge call '
            + 'has nobody to ask. Warn Before Execution is skipped and said so in the result.',
        params: [
            { name: 'id', type: 'string', required: false, description: 'Button ID. Give this or a name.' },
            { name: 'name', type: 'string', required: false, description: 'Button name, matched case-insensitively. Give this or an id.' },
            { name: 'locality', type: 'string', required: false, description: 'Narrows a name match to one scope.', enum: ['Global', 'Local', 'Workspace'] },
            { name: 'tokens', type: 'Record<string, string>', required: false, description: 'Values for the button user tokens, by name with or without the $ delimiters.' }
        ],
        returns: 'ApiResult<{ id: string, launched: true, notes?: string[] }>',
        example: {
            params: { name: 'Plan this repo', tokens: { Target: 'the router' } },
            result: { success: true, data: { id: '<button-uuid>', launched: true } }
        }
    },
    {
        method: 'buttonfu.api.getBridgeContext',
        description: 'Return the current bridge identity, workspace info, and store counts. Use this to verify which VS Code window you are connected to before performing local-scoped operations.',
        params: 'undefined (no parameters)',
        returns: 'BridgeContext'
    },
    {
        method: 'buttonfu.api.listBridges',
        description: 'List all live bridge files (stale bridges are cleaned first). Auth tokens are redacted. Use this to discover other VS Code windows and select the correct bridge for workspace-targeted operations.',
        params: 'undefined (no parameters)',
        returns: '{ bridges: BridgeInfo[] }  - authToken omitted from each entry'
    }
];

// ---------------------------------------------------------------------------
// Full schema builder
// ---------------------------------------------------------------------------

export const AUTOMATION_GUIDANCE: AutomationGuidance = {
    preferredAutomationSurface:
        'ButtonFu Agent Bridge (named-pipe JSON-RPC 2.0) and the registered buttonfu.api.* VS Code commands.',
    supportedMutationSurface:
        'All button and note mutations MUST go through buttonfu.api.createButton, buttonfu.api.updateButton, ' +
        'buttonfu.api.deleteButton, buttonfu.api.createNote, buttonfu.api.updateNote, and buttonfu.api.deleteNote - ' +
        'either via the Agent Bridge named pipe or via vscode.commands.executeCommand() from a co-hosted extension.',
    unsupportedAutomationMutationSurfaces: [
        'VS Code workspace storage (state.vscdb / context.workspaceState)',
        'The nullcity.buttonfu workspace memento',
        'VS Code user/machine settings key buttonfu.globalButtons',
        'VS Code user/machine settings key buttonfu.globalNotes',
        'Direct file writes to any .vscdb or SQLite database',
        'Any mechanism that bypasses the ButtonFu API command handlers'
    ],
    automationWarnings: [
        'Do not mutate ButtonFu data by editing VS Code storage directly. ' +
            'Direct writes bypass validation, provenance tracking, UI refresh, and may corrupt or lose data.',
        'The internal storage format is not a stable API and may change between versions without notice.',
        'Always use the ButtonFu Agent Bridge or buttonfu.api.* commands for automation.',
        'buttonfu.api.runButton is the only method that executes anything. It is opt-in through '
            + 'buttonfu.claude.allowBridgeRun, it runs Claude buttons and nothing else, and every '
            + 'other kind of change still has to go through the create, update and delete methods.'
    ]
};

export function buildApiSchema(extensionVersion: string): ApiSchemaRoot {
    return {
        name: AGENT_BRIDGE_NAME,
        version: extensionVersion,
        schemaVersion: AGENT_BRIDGE_SCHEMA_VERSION,
        protocol: 'JSON-RPC 2.0 over newline-delimited named pipe',
        transport: 'OS named pipe (Windows: \\\\.\\pipe\\buttonfu-vscode-{pid}, Unix: ~/.buttonfu/buttonfu-vscode-{pid}.sock)',
        description:
            'Programmatic CRUD API for managing ButtonFu buttons and notes. ' +
            'Agents discover the pipe via ~/.buttonfu/bridge-{pid}.json which ' +
            'contains the pipeName, authToken, describeMethod, limits, workspace identity, and version metadata. ' +
            'Every request must include an "auth" field with the token from that file. ' +
            'Mutation responses (create/update/delete) include a bridgeContext object identifying the window that was modified. ' +
            'To target a specific window, include "targetWindowId" in params; the bridge rejects mismatches with error -32003.',
        authentication:
            'Include "auth": "<token>" in every JSON-RPC request object. ' +
            'The token is a 256-bit hex string from the bridge discovery file. ' +
            'Failed authentication returns error code -32000.',
        automationGuidance: AUTOMATION_GUIDANCE,
        methods,
        types: {
            ButtonConfig: buttonFields,
            NoteConfig: noteFields,
            UserToken: userTokenFields,
            TerminalTab: terminalTabFields,
            BridgeContext: bridgeContextFields
        },
        errorCodes: {
            [-32700]: 'Parse error - malformed JSON.',
            [-32600]: 'Invalid request - not a valid JSON-RPC 2.0 object.',
            [-32601]: 'Method not found - method is not in the allowlist.',
            [-32603]: 'Internal error - command execution failed.',
            [-32000]: 'Authentication failed - missing or wrong auth token.',
            [-32001]: 'Rate limited - exceeded 60 requests per 60 seconds.',
            [-32002]: 'Message too large - exceeds 1 MB limit.',
            [-32003]: 'Workspace mismatch - targetWindowId does not match this bridge.'
        }
    };
}
