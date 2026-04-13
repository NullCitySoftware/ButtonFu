import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeBridgeCommandParam } from '../bridgeCommandSanitizer';

test('sanitizeBridgeCommandParam removes UI side-effect flags from object params', () => {
    const input = {
        name: 'Smoke Button',
        locality: 'Global',
        openEditor: true,
        openEditors: true,
        category: 'SecurityTest'
    };

    const result = sanitizeBridgeCommandParam(input) as Record<string, unknown>;

    assert.equal(result.openEditor, undefined);
    assert.equal(result.openEditors, undefined);
    assert.equal(result.name, 'Smoke Button');
    assert.equal(result.category, 'SecurityTest');
    assert.equal((input as Record<string, unknown>).openEditor, true);
    assert.equal((input as Record<string, unknown>).openEditors, true);
});

test('sanitizeBridgeCommandParam sanitizes objects inside arrays', () => {
    const array = [{ openEditor: true, name: 'Test' }, { openEditors: true, id: '1' }];

    const result = sanitizeBridgeCommandParam(array) as Record<string, unknown>[];
    assert.equal(result[0].openEditor, undefined);
    assert.equal(result[0].name, 'Test');
    assert.equal(result[1].openEditors, undefined);
    assert.equal(result[1].id, '1');
    // Original array should not be mutated
    assert.equal((array[0] as Record<string, unknown>).openEditor, true);
});

test('sanitizeBridgeCommandParam sanitizes nested objects recursively', () => {
    const input = {
        payload: {
            openEditor: true,
            items: [{ openEditors: true, name: 'Nested' }]
        }
    };

    const result = sanitizeBridgeCommandParam(input) as {
        payload: { openEditor?: boolean; items: Array<Record<string, unknown>> };
    };

    assert.equal(result.payload.openEditor, undefined);
    assert.equal(result.payload.items[0].openEditors, undefined);
    assert.equal(result.payload.items[0].name, 'Nested');
    assert.equal((input.payload as { openEditor?: boolean }).openEditor, true);
});

test('sanitizeBridgeCommandParam leaves primitives unchanged', () => {
    const primitive = 'button-id';

    assert.equal(sanitizeBridgeCommandParam(primitive), primitive);
});