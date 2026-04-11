/**
 * Programmatic CRUD API for ButtonFu buttons.
 *
 * Every function is stateless — pass the store in at the call site.
 * The `openEditor` flag (if present on input) is stripped before persistence
 * and surfaced to the caller so the command handler can open the editor panel.
 */

import { ApiResult, ButtonConfig, ButtonLocality, createDefaultButton } from './types';
import { ButtonStore } from './buttonStore';

const VALID_TYPES: readonly string[] = ['TerminalCommand', 'PaletteAction', 'TaskExecution', 'CopilotCommand'];
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
function mergeCreateInput(input: Record<string, unknown>): ButtonConfig {
    const defaults = createDefaultButton(input.locality as ButtonLocality);
    const merged = pickMutableButtonFields(input);
    return { ...defaults, ...merged, id: defaults.id };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function createButton(
    store: ButtonStore,
    input: unknown
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
        const button = mergeCreateInput(item as Record<string, unknown>);
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
        if (!store.getButton(id)) {
            results.push({ success: false, errors: [`Button not found: ${id}`] });
            continue;
        }
        await store.deleteButton(id);
        results.push({ success: true, data: { id } });
    }

    return isBatch ? results : results[0];
}
