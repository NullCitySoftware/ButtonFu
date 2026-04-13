const UI_SIDE_EFFECT_FLAGS = new Set(['openEditor', 'openEditors']);

export function sanitizeBridgeCommandParam(param: unknown): unknown {
    if (!param || typeof param !== 'object') {
        return param;
    }

    if (Array.isArray(param)) {
        return param.map(item => sanitizeBridgeCommandParam(item));
    }

    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(param as Record<string, unknown>)) {
        if (UI_SIDE_EFFECT_FLAGS.has(key)) {
            continue;
        }
        sanitized[key] = sanitizeBridgeCommandParam(value);
    }

    return sanitized;
}