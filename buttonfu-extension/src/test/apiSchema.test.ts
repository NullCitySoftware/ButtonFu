import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApiSchema, AUTOMATION_GUIDANCE } from '../apiSchema';

test('buildApiSchema returns well-formed schema with correct version', () => {
    const schema = buildApiSchema('2.0.0');
    assert.equal(schema.version, '2.0.0');
    assert.equal(schema.schemaVersion, 2);
    assert.equal(schema.name, 'ButtonFu Agent Bridge');
    assert.equal(schema.methods.length, 12);
    assert.equal(schema.transport, 'OS named pipe (Windows: \\\\.\\pipe\\buttonfu-vscode-{pid}, Unix: ~/.buttonfu/buttonfu-vscode-{pid}.sock)');

    // Every method has required fields
    for (const m of schema.methods) {
        assert.ok(m.method.startsWith('buttonfu.api.'), `method ${m.method} missing prefix`);
        assert.ok(m.description.length > 0, `method ${m.method} missing description`);
        assert.ok(m.returns.length > 0, `method ${m.method} missing returns`);
    }
});

test('buildApiSchema types include all required ButtonConfig fields', () => {
    const schema = buildApiSchema('0.0.0');
    const btnFields = schema.types.ButtonConfig;
    const requiredNames = btnFields.filter(f => f.required).map(f => f.name);

    assert.ok(requiredNames.includes('name'));
    assert.ok(requiredNames.includes('locality'));
});

test('buildApiSchema types include all required NoteConfig fields', () => {
    const schema = buildApiSchema('0.0.0');
    const noteFields = schema.types.NoteConfig;
    const requiredNames = noteFields.filter(f => f.required).map(f => f.name);

    assert.ok(requiredNames.includes('name'));
    assert.ok(requiredNames.includes('locality'));
});

test('buildApiSchema error codes include all documented codes', () => {
    const schema = buildApiSchema('0.0.0');
    const codes = Object.keys(schema.errorCodes).map(Number);

    assert.ok(codes.includes(-32700)); // parse error
    assert.ok(codes.includes(-32600)); // invalid request
    assert.ok(codes.includes(-32601)); // method not found
    assert.ok(codes.includes(-32603)); // internal error
    assert.ok(codes.includes(-32000)); // auth failed
    assert.ok(codes.includes(-32001)); // rate limited
    assert.ok(codes.includes(-32002)); // message too large
    assert.ok(codes.includes(-32003)); // workspace mismatch
});

test('buildApiSchema types include BridgeContext', () => {
    const schema = buildApiSchema('0.0.0');
    const ctxFields = schema.types.BridgeContext;
    assert.ok(ctxFields, 'BridgeContext type should be present');
    const fieldNames = ctxFields.map(f => f.name);
    assert.ok(fieldNames.includes('windowId'));
    assert.ok(fieldNames.includes('workspaceName'));
    assert.ok(fieldNames.includes('globalButtonCount'));
    assert.ok(fieldNames.includes('localButtonCount'));
});

test('buildApiSchema includes getBridgeContext and listBridges methods', () => {
    const schema = buildApiSchema('0.0.0');
    const methodNames = schema.methods.map(m => m.method);
    assert.ok(methodNames.includes('buttonfu.api.getBridgeContext'));
    assert.ok(methodNames.includes('buttonfu.api.listBridges'));
});

// ---------------------------------------------------------------------------
// Automation guidance
// ---------------------------------------------------------------------------

test('buildApiSchema includes automationGuidance with required fields', () => {
    const schema = buildApiSchema('1.0.0');
    const g = schema.automationGuidance;
    assert.ok(g, 'automationGuidance must be present');
    assert.ok(g.preferredAutomationSurface.length > 0, 'preferredAutomationSurface must not be empty');
    assert.ok(g.supportedMutationSurface.length > 0, 'supportedMutationSurface must not be empty');
    assert.ok(Array.isArray(g.unsupportedAutomationMutationSurfaces), 'unsupportedAutomationMutationSurfaces must be an array');
    assert.ok(g.unsupportedAutomationMutationSurfaces.length >= 4, 'at least 4 unsupported surfaces');
    assert.ok(Array.isArray(g.automationWarnings), 'automationWarnings must be an array');
    assert.ok(g.automationWarnings.length >= 1, 'at least 1 automation warning');
});

test('automationGuidance warns against direct storage edits', () => {
    const g = AUTOMATION_GUIDANCE;
    const allText = [
        g.preferredAutomationSurface,
        g.supportedMutationSurface,
        ...g.unsupportedAutomationMutationSurfaces,
        ...g.automationWarnings
    ].join(' ').toLowerCase();

    assert.ok(allText.includes('buttonfu.api.'), 'must reference buttonfu.api methods');
    assert.ok(allText.includes('state.vscdb') || allText.includes('workspace storage'), 'must warn about workspace storage');
    assert.ok(allText.includes('do not mutate') || allText.includes('do not write'), 'must include a do-not directive');
});

test('AUTOMATION_GUIDANCE matches schema.automationGuidance', () => {
    const schema = buildApiSchema('1.0.0');
    assert.deepStrictEqual(schema.automationGuidance, AUTOMATION_GUIDANCE);
});
