const UI_SIDE_EFFECT_FLAGS = new Set(['openEditor', 'openEditors']);

export function sanitizeBridgeCommandParam(param: unknown): unknown {
    if (!param || typeof param !== 'object') {
        return param;
    }

    if (Array.isArray(param)) {
        return param.map(item => sanitizeBridgeCommandParam(item));
    }

    const sanitized = { ...(param as Record<string, unknown>) };
    for (const flag of UI_SIDE_EFFECT_FLAGS) {
        delete sanitized[flag];
    }

    return sanitized;
}