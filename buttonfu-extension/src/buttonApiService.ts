/**
 * Programmatic CRUD API for ButtonFu buttons.
 *
 * Every function is stateless — pass the store in at the call site.
 * The `openEditor` flag (if present on input) is stripped before persistence
 * and surfaced to the caller so the command handler can open the editor panel.
 */

import {
    ApiResult,
    BUTTON_TYPE_INFO,
    BUTTON_TYPES,
    ButtonConfig,
    ButtonLocality,
    CLAUDE_DESTINATION_INFO,
    CLAUDE_PERMISSION_MODES,
    createDefaultButton
} from './types';
import { ButtonStore } from './buttonStore';
import type { ButtonExecutor, TokenSnapshot } from './buttonExecutor';

const VALID_TYPES: readonly string[] = BUTTON_TYPES;
const VALID_CLAUDE_DESTINATIONS: readonly string[] = Object.keys(CLAUDE_DESTINATION_INFO);
const VALID_LOCALITIES: readonly string[] = ['Global', 'Local'];
const MUTABLE_BUTTON_FIELDS: ReadonlyArray<keyof ButtonConfig> = [
    'name',
    'locality',
    'description',
    'type',
    'executionText',
    'terminals',
    'category',
    'icon',
    'colour',
    'copilotModel',
    'copilotMode',
    'copilotAttachFiles',
    'copilotAttachActiveFile',
    'claudeDestination',
    'claudeModel',
    'claudeEffort',
    'claudePermissionMode',
    'claudeCwd',
    'claudeTargetFolder',
    'claudeSessionName',
    'claudeAddDirs',
    'claudeWorktree',
    'claudeWorktreeName',
    'claudeExtraArgs',
    'claudeNewWindow',
    'sortOrder',
    'warnBeforeExecution',
    'userTokens'
];
const MAX_NAME = 500;
const MAX_EXECUTION_TEXT = 100_000;
const MAX_DESCRIPTION = 5_000;
const MAX_CATEGORY = 200;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function checkString(obj: Record<string, unknown>, field: string, maxLen: number, required: boolean): string | undefined {
    const val = obj[field];
    if (val === undefined || val === null) {
        return required ? `${field} is required.` : undefined;
    }
    if (typeof val !== 'string') {
        return `${field} must be a string.`;
    }
    if (required && !val.trim()) {
        return `${field} must be a non-empty string.`;
    }
    if (val.length > maxLen) {
        return `${field} must not exceed ${maxLen} characters.`;
    }
    return undefined;
}

function checkStringArray(obj: Record<string, unknown>, field: string): string | undefined {
    const val = obj[field];
    if (val === undefined || val === null) {
        return undefined;
    }
    if (!Array.isArray(val) || val.some(entry => typeof entry !== 'string')) {
        return `${field} must be an array of strings.`;
    }
    return undefined;
}

/** Validates the ClaudeCommand fields shared by create and update. */
function checkClaudeFields(obj: Record<string, unknown>): string[] {
    const errors: string[] = [];

    if (obj.claudeDestination !== undefined && !VALID_CLAUDE_DESTINATIONS.includes(obj.claudeDestination as string)) {
        errors.push(`claudeDestination must be one of: ${VALID_CLAUDE_DESTINATIONS.join(', ')}.`);
    }

    if (obj.claudePermissionMode !== undefined && obj.claudePermissionMode !== ''
        && !CLAUDE_PERMISSION_MODES.includes(obj.claudePermissionMode as string)) {
        errors.push(`claudePermissionMode must be one of: ${CLAUDE_PERMISSION_MODES.join(', ')}.`);
    }

    for (const field of ['claudeAddDirs', 'claudeExtraArgs']) {
        const err = checkStringArray(obj, field);
        if (err) { errors.push(err); }
    }

    for (const field of ['claudeModel', 'claudeEffort', 'claudeCwd', 'claudeTargetFolder', 'claudeSessionName', 'claudeWorktreeName']) {
        const err = checkString(obj, field, MAX_CATEGORY, false);
        if (err) { errors.push(err); }
    }

    return errors;
}

function validateCreateInput(input: unknown): string[] {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return ['Input must be a non-null object.'];
    }
    const obj = input as Record<string, unknown>;
    const errors: string[] = [];

    const nameErr = checkString(obj, 'name', MAX_NAME, true);
    if (nameErr) { errors.push(nameErr); }

    if (!VALID_LOCALITIES.includes(obj.locality as string)) {
        errors.push(`locality is required and must be one of: ${VALID_LOCALITIES.join(', ')}.`);
    }

    if (obj.type !== undefined && !VALID_TYPES.includes(obj.type as string)) {
        errors.push(`type must be one of: ${VALID_TYPES.join(', ')}.`);
    }

    for (const [field, max] of [['executionText', MAX_EXECUTION_TEXT], ['description', MAX_DESCRIPTION], ['category', MAX_CATEGORY]] as const) {
        const err = checkString(obj, field, max, false);
        if (err) { errors.push(err); }
    }

    errors.push(...checkClaudeFields(obj));

    return errors;
}

function validateUpdateInput(input: unknown): string[] {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return ['Input must be a non-null object.'];
    }
    const obj = input as Record<string, unknown>;
    const errors: string[] = [];

    const idErr = checkString(obj, 'id', 200, true);
    if (idErr) { errors.push(idErr); }

    if (obj.name !== undefined) {
        const nameErr = checkString(obj, 'name', MAX_NAME, true);
        if (nameErr) { errors.push(nameErr); }
    }

    if (obj.locality !== undefined && !VALID_LOCALITIES.includes(obj.locality as string)) {
        errors.push(`locality must be one of: ${VALID_LOCALITIES.join(', ')}.`);
    }

    if (obj.type !== undefined && !VALID_TYPES.includes(obj.type as string)) {
        errors.push(`type must be one of: ${VALID_TYPES.join(', ')}.`);
    }

    for (const [field, max] of [['executionText', MAX_EXECUTION_TEXT], ['description', MAX_DESCRIPTION], ['category', MAX_CATEGORY]] as const) {
        const err = checkString(obj, field, max, false);
        if (err) { errors.push(err); }
    }

    errors.push(...checkClaudeFields(obj));

    return errors;
}

// ---------------------------------------------------------------------------
// Merge helpers
// ---------------------------------------------------------------------------

function pickMutableButtonFields(input: Record<string, unknown>): Partial<ButtonConfig> {
    const picked: Partial<ButtonConfig> = {};

    for (const field of MUTABLE_BUTTON_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(input, field)) {
            (picked as Record<string, unknown>)[field] = input[field];
        }
    }

    return picked;
}

/** Strip non-ButtonConfig keys (e.g. openEditor) and merge with defaults. */
function mergeCreateInput(input: Record<string, unknown>, defaultPermissionMode?: string): ButtonConfig {
    const defaults = createDefaultButton(input.locality as ButtonLocality, defaultPermissionMode);
    const merged = pickMutableButtonFields(input);
    return { ...defaults, ...merged, id: defaults.id };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function createButton(
    store: ButtonStore,
    input: unknown,
    defaultPermissionMode?: string
): Promise<ApiResult<ButtonConfig> | ApiResult<ButtonConfig>[]> {
    const isBatch = Array.isArray(input);
    const items: unknown[] = isBatch ? input : [input];
    const results: ApiResult<ButtonConfig>[] = [];

    for (const item of items) {
        const errors = validateCreateInput(item);
        if (errors.length > 0) {
            results.push({ success: false, errors });
            continue;
        }
        const button = mergeCreateInput(item as Record<string, unknown>, defaultPermissionMode);
        await store.saveButton(button, 'Agent');
        results.push({ success: true, data: store.getButton(button.id) ?? button });
    }

    return isBatch ? results : results[0];
}

export function getButton(store: ButtonStore, input: unknown): ApiResult<ButtonConfig> {
    const id = typeof input === 'string' ? input : (input as Record<string, unknown> | undefined)?.id;
    if (typeof id !== 'string' || !id.trim()) {
        return { success: false, errors: ['id is required and must be a non-empty string.'] };
    }
    const button = store.getButton(id);
    if (!button) {
        return { success: false, errors: [`Button not found: ${id}`] };
    }
    return { success: true, data: button };
}

export function listButtons(store: ButtonStore, input?: unknown): ApiResult<ButtonConfig[]> {
    const filter = (input && typeof input === 'object') ? input as Record<string, unknown> : {};
    let buttons: ButtonConfig[];
    if (filter.locality === 'Global') {
        buttons = store.getGlobalButtons();
    } else if (filter.locality === 'Local') {
        buttons = store.getLocalButtons();
    } else if (filter.locality === 'Workspace') {
        buttons = store.getWorkspaceButtons();
    } else {
        buttons = store.getAllButtons();
    }
    return { success: true, data: buttons };
}

export async function updateButton(store: ButtonStore, input: unknown): Promise<ApiResult<ButtonConfig>> {
    const errors = validateUpdateInput(input);
    if (errors.length > 0) {
        return { success: false, errors };
    }
    const obj = input as Record<string, unknown>;
    const existing = store.getButton(obj.id as string);
    if (!existing) {
        return { success: false, errors: [`Button not found: ${obj.id}`] };
    }
    if (existing.locality === 'Workspace') {
        return { success: false, errors: [`Button is read-only: ${obj.id} is a workspace button defined in .vscode/settings.json (buttonfu.workspaceButtons).`] };
    }
    const fields = pickMutableButtonFields(obj);
    const merged = { ...existing, ...fields } as ButtonConfig;
    await store.saveButton(merged, 'Agent');
    return { success: true, data: store.getButton(merged.id) ?? merged };
}

export async function deleteButton(
    store: ButtonStore,
    input: unknown
): Promise<ApiResult<{ id: string }> | ApiResult<{ id: string }>[]> {
    let rawIds: unknown[];
    let isBatch: boolean;

    if (Array.isArray(input)) {
        rawIds = input;
        isBatch = true;
    } else if (typeof input === 'string') {
        rawIds = [input];
        isBatch = false;
    } else if (input && typeof input === 'object') {
        const obj = input as Record<string, unknown>;
        if (Array.isArray(obj.ids)) {
            rawIds = obj.ids;
            isBatch = true;
        } else if (typeof obj.id === 'string') {
            rawIds = [obj.id];
            isBatch = false;
        } else {
            return { success: false, errors: ['id is required.'] };
        }
    } else {
        return { success: false, errors: ['id is required.'] };
    }

    const results: ApiResult<{ id: string }>[] = [];
    for (const raw of rawIds) {
        const id = typeof raw === 'string' ? raw : (raw as Record<string, unknown> | undefined)?.id as string | undefined;
        if (!id) {
            results.push({ success: false, errors: ['Each item must have an id.'] });
            continue;
        }
        const existing = store.getButton(id);
        if (!existing) {
            results.push({ success: false, errors: [`Button not found: ${id}`] });
            continue;
        }
        if (existing.locality === 'Workspace') {
            results.push({ success: false, errors: [`Button is read-only: ${id} is a workspace button defined in .vscode/settings.json (buttonfu.workspaceButtons).`] });
            continue;
        }
        await store.deleteButton(id);
        results.push({ success: true, data: { id } });
    }

    return isBatch ? results : results[0];
}

// ---------------------------------------------------------------------------
// Running a button
// ---------------------------------------------------------------------------

/** What a bridge-run needs from the extension host. */
export interface RunButtonHost {
    /** True when `buttonfu.claude.allowBridgeRun` is on. */
    allowed(): boolean;
    /** The executor a click would use, so tokens resolve exactly the same way. */
    executor(): ButtonExecutor;
}

/** The result of a successful run. */
export interface RunButtonResult {
    id: string;
    launched: true;
    /** Names anything a click would have done that a bridge call cannot. */
    notes?: string[];
}

/** Finds a button by id, or by name within an optional locality. */
function resolveButtonTarget(store: ButtonStore, obj: Record<string, unknown>): ButtonConfig | undefined {
    if (typeof obj.id === 'string' && obj.id.trim()) {
        return store.getButton(obj.id.trim());
    }

    if (typeof obj.name === 'string' && obj.name.trim()) {
        const name = obj.name.trim().toLowerCase();
        const locality = typeof obj.locality === 'string' ? obj.locality : undefined;
        return store.getAllButtons().find(button =>
            button.name.toLowerCase() === name && (!locality || button.locality === locality));
    }

    return undefined;
}

/**
 * Runs a button on behalf of an agent.
 *
 * Only Claude buttons can ever be run this way, and only when the setting says so. A terminal
 * button that deploys a site or drops a database is refused by type before anything else is
 * considered. Each refusal has its own message, so an agent that hits one knows whether to change
 * the request or give up rather than retrying blindly.
 */
export async function runButton(
    store: ButtonStore,
    input: unknown,
    host: RunButtonHost
): Promise<ApiResult<RunButtonResult>> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return { success: false, errors: ['Input must be a non-null object.'] };
    }
    const obj = input as Record<string, unknown>;

    if (!host.allowed()) {
        return {
            success: false,
            errors: ['Running buttons over the agent bridge is disabled. '
                + 'Set buttonfu.claude.allowBridgeRun to true to allow it.']
        };
    }

    const button = resolveButtonTarget(store, obj);
    if (!button) {
        const target = typeof obj.id === 'string' ? obj.id : (typeof obj.name === 'string' ? obj.name : '');
        return {
            success: false,
            errors: [target ? `Button not found: ${target}` : 'id or name is required and must be a non-empty string.']
        };
    }

    if (button.type !== 'ClaudeCommand') {
        const label = BUTTON_TYPE_INFO[button.type]?.label ?? button.type;
        return {
            success: false,
            errors: [`Only Claude buttons can be run over the bridge. This button is a ${label}.`]
        };
    }

    const executor = host.executor();
    const systemSnap = executor.captureSystemTokens(button);
    await executor.captureClipboard(button, systemSnap);

    const supplied = readSuppliedTokens(obj.tokens);
    const unresolved = executor.getUnresolvedUserTokens(button, systemSnap)
        .filter(token => !(token.token.toLowerCase() in supplied));

    if (unresolved.length > 0) {
        // A click can open the input panel and wait for a person. A bridge call has nobody to ask.
        return {
            success: false,
            errors: [`This button needs values for ${unresolved.map(t => t.token).join(', ')} `
                + 'and cannot be run over the bridge. Pass them as { tokens: { Name: "value" } }.']
        };
    }

    const notes: string[] = [];
    if (button.warnBeforeExecution) {
        // The confirmation is a dialog on a click, and there is nobody here to answer it.
        notes.push('Warn Before Execution was skipped: a bridge call has nobody to confirm with.');
    }

    await executor.executeWithTokens(button, systemSnap, supplied);

    return { success: true, data: { id: button.id, launched: true, ...(notes.length > 0 ? { notes } : {}) } };
}

/** Normalises a caller-supplied token map into the snapshot shape the executor expects. */
function readSuppliedTokens(value: unknown): TokenSnapshot {
    const snapshot: TokenSnapshot = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return snapshot;
    }

    for (const [name, tokenValue] of Object.entries(value as Record<string, unknown>)) {
        if (typeof tokenValue !== 'string') {
            continue;
        }
        const key = name.startsWith('$') && name.endsWith('$') ? name : `$${name}$`;
        snapshot[key.toLowerCase()] = tokenValue;
    }

    return snapshot;
}
