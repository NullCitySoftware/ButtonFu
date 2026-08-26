/**
 * Programmatic CRUD API for ButtonFu notes.
 *
 * Mirrors the button API surface. Every function is stateless - pass the
 * store in at the call site. The `openEditor` flag (if present) is stripped
 * before persistence and surfaced to the caller.
 */

import { ApiResult, ButtonLocality, NoteConfig, NoteDefaultAction, NOTE_DEFAULT_ACTIONS, createDefaultNote } from './types';
import { NoteStore } from './noteStore';

const VALID_LOCALITIES: readonly string[] = ['Global', 'Local'];
const VALID_FORMATS: readonly string[] = ['PlainText', 'Markdown'];
const MAX_NAME = 500;
const MAX_CONTENT = 500_000;
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

    const contentErr = checkString(obj, 'content', MAX_CONTENT, false);
    if (contentErr) { errors.push(contentErr); }

    const catErr = checkString(obj, 'category', MAX_CATEGORY, false);
    if (catErr) { errors.push(catErr); }

    if (obj.format !== undefined && !VALID_FORMATS.includes(obj.format as string)) {
        errors.push(`format must be one of: ${VALID_FORMATS.join(', ')}.`);
    }

    if (obj.defaultAction !== undefined && !NOTE_DEFAULT_ACTIONS.includes(obj.defaultAction as NoteDefaultAction)) {
        errors.push(`defaultAction must be one of: ${NOTE_DEFAULT_ACTIONS.join(', ')}.`);
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

    const contentErr = checkString(obj, 'content', MAX_CONTENT, false);
    if (contentErr) { errors.push(contentErr); }

    const catErr = checkString(obj, 'category', MAX_CATEGORY, false);
    if (catErr) { errors.push(catErr); }

    if (obj.format !== undefined && !VALID_FORMATS.includes(obj.format as string)) {
        errors.push(`format must be one of: ${VALID_FORMATS.join(', ')}.`);
    }

    if (obj.defaultAction !== undefined && !NOTE_DEFAULT_ACTIONS.includes(obj.defaultAction as NoteDefaultAction)) {
        errors.push(`defaultAction must be one of: ${NOTE_DEFAULT_ACTIONS.join(', ')}.`);
    }

    return errors;
}

// ---------------------------------------------------------------------------
// Merge helpers
// ---------------------------------------------------------------------------

function mergeCreateInput(input: Record<string, unknown>): NoteConfig {
    const defaults = createDefaultNote(input.locality as ButtonLocality);
    const merged = { ...input };
    delete merged.openEditor;
    return { ...defaults, ...merged, id: defaults.id } as NoteConfig;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function createNote(
    store: NoteStore,
    input: unknown
): Promise<ApiResult<NoteConfig> | ApiResult<NoteConfig>[]> {
    const isBatch = Array.isArray(input);
    const items: unknown[] = isBatch ? input : [input];
    const results: ApiResult<NoteConfig>[] = [];

    for (const item of items) {
        const errors = validateCreateInput(item);
        if (errors.length > 0) {
            results.push({ success: false, errors });
            continue;
        }
        const note = mergeCreateInput(item as Record<string, unknown>);
        const saved = await store.saveNode(note, 'Agent');
        results.push({ success: true, data: saved });
    }

    return isBatch ? results : results[0];
}

export function getNote(store: NoteStore, input: unknown): ApiResult<NoteConfig> {
    const id = typeof input === 'string' ? input : (input as Record<string, unknown> | undefined)?.id;
    if (typeof id !== 'string' || !id.trim()) {
        return { success: false, errors: ['id is required and must be a non-empty string.'] };
    }
    const note = store.getNode(id);
    if (!note) {
        return { success: false, errors: [`Note not found: ${id}`] };
    }
    return { success: true, data: note };
}

export function listNotes(store: NoteStore, input?: unknown): ApiResult<NoteConfig[]> {
    const filter = (input && typeof input === 'object') ? input as Record<string, unknown> : {};
    let notes: NoteConfig[];
    if (filter.locality === 'Global') {
        notes = store.getGlobalNodes();
    } else if (filter.locality === 'Local') {
        notes = store.getLocalNodes();
    } else {
        notes = store.getAllNodes();
    }
    return { success: true, data: notes };
}

export async function updateNote(store: NoteStore, input: unknown): Promise<ApiResult<NoteConfig>> {
    const errors = validateUpdateInput(input);
    if (errors.length > 0) {
        return { success: false, errors };
    }
    const obj = input as Record<string, unknown>;
    const existing = store.getNode(obj.id as string);
    if (!existing) {
        return { success: false, errors: [`Note not found: ${obj.id}`] };
    }
    const fields = { ...obj };
    delete fields.openEditor;
    const merged = { ...existing, ...fields } as NoteConfig;
    const saved = await store.saveNode(merged, 'Agent');
    return { success: true, data: saved };
}

export async function deleteNote(
    store: NoteStore,
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
        if (!store.getNode(id)) {
            results.push({ success: false, errors: [`Note not found: ${id}`] });
            continue;
        }
        await store.deleteNode(id);
        results.push({ success: true, data: { id } });
    }

    return isBatch ? results : results[0];
}
