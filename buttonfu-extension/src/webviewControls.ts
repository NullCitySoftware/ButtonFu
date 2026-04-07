import * as vscode from 'vscode';

export function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

export function escapeHtml(value: string): string {
    if (!value) { return ''; }
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export function escapeAttribute(value: string): string {
    return escapeHtml(value).replace(/'/g, '&#39;');
}

export interface CopilotModelInfo {
    id: string;
    name: string;
    vendor: string;
    family: string;
    maxInputTokens: number;
}

interface IconPickerMarkupOptions {
    triggerId: string;
    previewId: string;
    labelId: string;
    inputId: string;
    dropdownId: string;
    searchId: string;
    gridId: string;
    defaultLabel?: string;
    searchPlaceholder?: string;
}

interface ModelAutocompleteMarkupOptions {
    inputId: string;
    listId: string;
    triggerId: string;
    placeholder?: string;
}

interface ColourFieldMarkupOptions {
    wrapperId: string;
    pickerId: string;
    inputId: string;
    alphaId: string;
    placeholder?: string;
}

interface CollapsibleCardMarkupOptions {
    cardId: string;
    toggleId: string;
    iconId: string;
    bodyId: string;
    title: string;
    description?: string;
    content: string;
}

const COLOUR_SWATCH_ROWS: Array<Array<{ colour: string; title: string }>> = [
    [
        { colour: '#4fc3f7', title: 'Blue' },
        { colour: '#4caf50', title: 'Green' },
        { colour: '#ff9800', title: 'Orange' },
        { colour: '#f44336', title: 'Red' },
        { colour: '#9c27b0', title: 'Purple' },
        { colour: '#ffeb3b', title: 'Yellow' },
        { colour: '#00bcd4', title: 'Cyan' },
        { colour: '#e91e63', title: 'Pink' },
        { colour: '#607d8b', title: 'Grey' },
        { colour: '', title: 'Default (no colour)' }
    ],
    [
        { colour: '#aed6f1', title: 'Pastel Blue' },
        { colour: '#a9dfbf', title: 'Pastel Green' },
        { colour: '#fad7a0', title: 'Pastel Peach' },
        { colour: '#f5b7b1', title: 'Pastel Coral' },
        { colour: '#d7bde2', title: 'Pastel Lavender' },
        { colour: '#fef9c3', title: 'Pastel Yellow' },
        { colour: '#a3e4db', title: 'Pastel Teal' },
        { colour: '#f8b4c8', title: 'Pastel Rose' },
        { colour: '#c5cae9', title: 'Pastel Periwinkle' },
        { colour: '#d7ccc8', title: 'Pastel Taupe' }
    ]
];

export async function getAvailableCopilotModels(): Promise<CopilotModelInfo[]> {
    try {
        const lm = (vscode as any).lm;
        if (lm?.selectChatModels) {
            let models = await lm.selectChatModels({ vendor: 'copilot' });
            if (!models.length) {
                models = await lm.selectChatModels();
            }

            const deduped = new Map<string, CopilotModelInfo>();
            for (const model of models) {
                const info: CopilotModelInfo = {
                    id: model.id,
                    name: model.name || model.id,
                    vendor: model.vendor || '',
                    family: model.family || '',
                    maxInputTokens: model.maxInputTokens || 0
                };
                if (!deduped.has(info.id)) {
                    deduped.set(info.id, info);
                }
            }

            return [...deduped.values()].sort((left, right) => {
                const vendorCompare = left.vendor.localeCompare(right.vendor);
                if (vendorCompare !== 0) {
                    return vendorCompare;
                }
                return left.name.localeCompare(right.name);
            });
        }
    } catch {
        // API not available
    }

    return [];
}

export function getAutocompleteStyles(): string {
    return /*css*/`
        .autocomplete-container { position: relative; }
        .autocomplete-input-row {
            display: flex;
            align-items: stretch;
            gap: 6px;
        }
        .autocomplete-input-row input {
            flex: 1 1 auto;
        }
        .autocomplete-trigger {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            min-width: 34px;
            padding: 0 10px;
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            cursor: pointer;
        }
        .autocomplete-trigger:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .autocomplete-list {
            display: none;
            position: absolute;
            top: 100%;
            left: 0;
            right: 0;
            z-index: 50;
            background: var(--vscode-dropdown-background);
            border: 1px solid var(--vscode-dropdown-border);
            border-radius: 4px;
            max-height: 200px;
            overflow-y: auto;
            box-shadow: 0 4px 12px rgba(0,0,0,0.2);
        }
        .autocomplete-list.visible { display: block; }
        .autocomplete-item {
            padding: 6px 10px;
            cursor: pointer;
            font-size: 12px;
        }
        .autocomplete-item:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .autocomplete-item.selected {
            background: var(--vscode-list-activeSelectionBackground);
            color: var(--vscode-list-activeSelectionForeground);
        }
        .autocomplete-empty {
            padding: 8px 10px;
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }
        .autocomplete-item .item-label { font-weight: 500; }
        .autocomplete-item .item-source {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            margin-left: 8px;
        }
        .model-group-header {
            padding: 4px 10px 2px;
            font-size: 10px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--vscode-descriptionForeground);
            background: var(--vscode-sideBar-background);
            border-bottom: 1px solid var(--vscode-panel-border);
            position: sticky;
            top: 0;
        }
        .model-item {
            display: flex !important;
            flex-direction: column !important;
            align-items: stretch !important;
            gap: 1px;
            padding: 5px 10px !important;
        }
        .model-item .item-label {
            font-weight: 500;
            font-size: 12px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .model-item .model-details {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            display: flex;
            gap: 6px;
            align-items: center;
        }
        .model-ctx {
            padding: 0 4px;
            border-radius: 3px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
        }
    `;
}

export function getIconPickerStyles(): string {
    return /*css*/`
        .icon-picker-trigger {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 6px 10px;
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            cursor: pointer;
            font-size: var(--vscode-font-size);
            color: var(--vscode-input-foreground);
        }
        .icon-picker-trigger:hover { border-color: var(--vscode-focusBorder); }
        .icon-picker-trigger .preview-icon {
            font-size: 16px;
        }
        .icon-picker-dropdown {
            display: none;
            position: absolute;
            z-index: 50;
            background: var(--vscode-dropdown-background);
            border: 1px solid var(--vscode-dropdown-border);
            border-radius: 6px;
            box-shadow: 0 4px 16px rgba(0,0,0,0.3);
            width: 320px;
            max-height: 300px;
            overflow: hidden;
        }
        .icon-picker-dropdown.visible { display: block; }
        .icon-picker-search {
            padding: 8px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .icon-picker-search input {
            width: 100%;
            padding: 4px 8px;
            border: 1px solid var(--vscode-input-border);
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border-radius: 3px;
            font-size: 12px;
            outline: none;
        }
        .icon-picker-grid {
            display: grid;
            grid-template-columns: repeat(8, 1fr);
            gap: 2px;
            padding: 8px;
            max-height: 240px;
            overflow-y: auto;
        }
        .icon-picker-item {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 32px;
            height: 32px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 16px;
            color: var(--vscode-foreground);
        }
        .icon-picker-item:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .icon-picker-item.selected {
            background: var(--vscode-list-activeSelectionBackground);
            color: var(--vscode-list-activeSelectionForeground);
        }
    `;
}

export function getColourFieldStyles(): string {
    return /*css*/`
        .colour-field {
            display: flex;
            flex-direction: column;
            gap: 6px;
        }
        .colour-row {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .colour-preview {
            width: 28px;
            height: 28px;
            border-radius: 4px;
            border: 1px solid var(--vscode-input-border);
            cursor: pointer;
            flex-shrink: 0;
        }
        .colour-row input[type="text"] {
            flex: 1 1 auto;
        }
        .colour-alpha-row {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .colour-alpha-row label {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            white-space: nowrap;
            min-width: 38px;
        }
        .colour-alpha-row input[type="range"] {
            flex: 1 1 auto;
            accent-color: var(--vscode-focusBorder);
        }
        .colour-alpha-row .alpha-value {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            min-width: 32px;
            text-align: right;
        }
        .colour-presets {
            display: flex;
            gap: 4px;
            flex-wrap: wrap;
        }
        .colour-swatch {
            width: 20px;
            height: 20px;
            border-radius: 3px;
            cursor: pointer;
            border: 1px solid transparent;
            transition: transform 0.1s;
        }
        .colour-swatch:hover { transform: scale(1.2); }
        .colour-swatch.selected { border-color: var(--vscode-focusBorder); }
    `;
}

export function getCollapsibleCardStyles(): string {
    return /*css*/`
        .buttonfu-collapsible-card {
            margin-top: 18px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 8px;
            overflow: hidden;
            background: var(--vscode-input-background);
        }
        .buttonfu-collapsible-card.collapsed {
            background: var(--vscode-editor-background);
        }
        .buttonfu-collapsible-card-toggle {
            width: 100%;
            display: flex;
            align-items: flex-start;
            justify-content: space-between;
            gap: 12px;
            padding: 12px 14px;
            border: none;
            background: transparent;
            color: inherit;
            cursor: pointer;
            text-align: left;
        }
        .buttonfu-collapsible-card-toggle:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .buttonfu-collapsible-card-copy {
            display: flex;
            flex-direction: column;
            gap: 4px;
            min-width: 0;
        }
        .buttonfu-collapsible-card-title {
            font-size: 13px;
            font-weight: 600;
            color: var(--vscode-foreground);
        }
        .buttonfu-collapsible-card-description {
            font-size: 11px;
            line-height: 1.5;
            color: var(--vscode-descriptionForeground);
        }
        .buttonfu-collapsible-card-icon {
            flex-shrink: 0;
            font-size: 16px;
            margin-top: 1px;
        }
        .buttonfu-collapsible-card-body {
            padding: 0 14px 14px;
            border-top: 1px solid var(--vscode-panel-border);
        }
        .buttonfu-collapsible-card.collapsed .buttonfu-collapsible-card-body {
            display: none;
        }
    `;
}

export function renderIconPickerMarkup(options: IconPickerMarkupOptions): string {
    return /*html*/`
                    <div class="icon-picker-trigger" id="${options.triggerId}">
                        <span class="preview-icon codicon" id="${options.previewId}"></span>
                        <span id="${options.labelId}">${escapeHtml(options.defaultLabel || 'Select icon...')}</span>
                    </div>
                    <input type="hidden" id="${options.inputId}" />
                    <div class="icon-picker-dropdown" id="${options.dropdownId}">
                        <div class="icon-picker-search">
                            <input type="text" id="${options.searchId}" placeholder="${escapeHtml(options.searchPlaceholder || 'Search icons...')}" />
                        </div>
                        <div class="icon-picker-grid" id="${options.gridId}"></div>
                    </div>`;
}

export function renderModelAutocompleteMarkup(options: ModelAutocompleteMarkupOptions): string {
    return /*html*/`
                        <div class="autocomplete-container">
                            <div class="autocomplete-input-row">
                                <input type="text" id="${options.inputId}" placeholder="${escapeHtml(options.placeholder || '')}" />
                                <button type="button" class="autocomplete-trigger" id="${options.triggerId}" title="Show available models" aria-label="Show available models">
                                    <span class="codicon codicon-chevron-down"></span>
                                </button>
                            </div>
                            <div class="autocomplete-list" id="${options.listId}"></div>
                        </div>`;
}

export function renderColourFieldMarkup(options: ColourFieldMarkupOptions): string {
    return /*html*/`
                    <div class="colour-field" id="${options.wrapperId}">
                        <div class="colour-row">
                            <input type="color" class="colour-preview" id="${options.pickerId}" />
                            <input type="text" id="${options.inputId}" placeholder="${escapeHtml(options.placeholder || '#ffffff or theme token')}" />
                        </div>
                        <div class="colour-alpha-row">
                            <label>Alpha</label>
                            <input type="range" id="${options.alphaId}" min="0" max="255" value="255" />
                            <span class="alpha-value" id="${options.alphaId}-label">FF</span>
                        </div>
${COLOUR_SWATCH_ROWS.map((row) => `                        <div class="colour-presets">
${row.map((swatch) => `                            <div class="colour-swatch" style="background:${escapeHtml(swatch.colour || '#ffffff')}" data-colour="${escapeHtml(swatch.colour)}" title="${escapeHtml(swatch.title)}"></div>`).join('\n')}
                        </div>`).join('\n')}
                    </div>`;
}

export function renderCollapsibleCardMarkup(options: CollapsibleCardMarkupOptions): string {
    return /*html*/`
            <section class="buttonfu-collapsible-card" id="${options.cardId}">
                <button type="button" class="buttonfu-collapsible-card-toggle" id="${options.toggleId}">
                    <span class="buttonfu-collapsible-card-copy">
                        <span class="buttonfu-collapsible-card-title">${escapeHtml(options.title)}</span>
                        ${options.description ? `<span class="buttonfu-collapsible-card-description">${escapeHtml(options.description)}</span>` : ''}
                    </span>
                    <span class="codicon codicon-chevron-down buttonfu-collapsible-card-icon" id="${options.iconId}"></span>
                </button>
                <div class="buttonfu-collapsible-card-body" id="${options.bodyId}">
${options.content}
                </div>
            </section>`;
}

export function getSharedWebviewControlScript(): string {
    return /*js*/`
        function buttonFuControlEscapeHtml(value) {
            if (!value) return '';
            return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        }

        function buttonFuControlEscapeAttr(value) {
            return buttonFuControlEscapeHtml(value).replace(/'/g, '&#39;');
        }

        function buttonFuFormatModelTokens(value) {
            if (!value) return '';
            if (value >= 1000) return Math.round(value / 1000) + 'K';
            return String(value);
        }

        function createButtonFuIconPicker(config) {
            const icons = Array.isArray(config.icons) ? config.icons : [];
            const trigger = document.getElementById(config.triggerId);
            const preview = document.getElementById(config.previewId);
            const label = document.getElementById(config.labelId);
            const input = document.getElementById(config.inputId);
            const dropdown = document.getElementById(config.dropdownId);
            const search = document.getElementById(config.searchId);
            const grid = document.getElementById(config.gridId);
            const defaultLabel = config.defaultLabel || 'Select icon...';

            function render(filter) {
                const lower = (filter || '').toLowerCase();
                const current = input.value || '';
                const filtered = icons.filter((icon) =>
                    !lower || icon.name.toLowerCase().includes(lower) || icon.label.toLowerCase().includes(lower)
                );

                grid.innerHTML = filtered.map((icon) =>
                    '<div class="icon-picker-item' + (icon.name === current ? ' selected' : '') + '" ' +
                    'data-icon-name="' + buttonFuControlEscapeAttr(icon.name) + '" title="' + buttonFuControlEscapeHtml(icon.label) + '">' +
                    '<span class="codicon codicon-' + icon.name + '"></span></div>'
                ).join('');
            }

            function updatePreview(name) {
                const resolved = name || '';
                preview.className = 'preview-icon codicon' + (resolved ? ' codicon-' + resolved : '');
                const icon = icons.find((entry) => entry.name === resolved);
                label.textContent = icon ? icon.label : (resolved || defaultLabel);
            }

            function close() {
                dropdown.classList.remove('visible');
            }

            function open() {
                search.value = '';
                render('');
                dropdown.classList.add('visible');
                search.focus();
                dropdown.scrollIntoView({ block: 'nearest' });
            }

            function toggle() {
                if (dropdown.classList.contains('visible')) {
                    close();
                } else {
                    open();
                }
            }

            function select(name) {
                input.value = name;
                updatePreview(name);
                close();
            }

            trigger.addEventListener('click', () => toggle());
            search.addEventListener('input', () => render(search.value));
            grid.addEventListener('click', (event) => {
                const item = event.target.closest('[data-icon-name]');
                if (item) {
                    select(item.dataset.iconName);
                }
            });
            document.addEventListener('click', (event) => {
                if (!dropdown.classList.contains('visible')) {
                    return;
                }
                if (!dropdown.contains(event.target) && !trigger.contains(event.target)) {
                    close();
                }
            });

            updatePreview(input.value || config.initialValue || '');

            return {
                close,
                setValue(name) {
                    input.value = name || '';
                    updatePreview(input.value);
                }
            };
        }

        function createButtonFuColourField(config) {
            const wrapper = document.getElementById(config.wrapperId);
            const input = document.getElementById(config.inputId);
            const picker = document.getElementById(config.pickerId);
            const alphaSlider = document.getElementById(config.alphaId);
            const alphaLabel = document.getElementById(config.alphaId + '-label');
            const defaultPickerColour = config.defaultPickerColour || '#ffffff';

            function getSwatches() {
                if (wrapper && typeof wrapper.querySelectorAll === 'function') {
                    return wrapper.querySelectorAll('.colour-swatch');
                }
                return document.querySelectorAll('#' + config.wrapperId + ' .colour-swatch');
            }

            function parseAlpha(hex) {
                if (/^#[0-9a-f]{8}$/i.test(hex)) {
                    return parseInt(hex.slice(7, 9), 16);
                }
                return 255;
            }

            function alphaHex(value) {
                var n = Math.max(0, Math.min(255, Math.round(Number(value))));
                return n.toString(16).toUpperCase().padStart(2, '0');
            }

            function stripAlpha(hex) {
                if (/^#[0-9a-f]{8}$/i.test(hex)) {
                    return hex.slice(0, 7);
                }
                return hex;
            }

            function syncAlphaUi(alpha) {
                if (alphaSlider) { alphaSlider.value = String(alpha); }
                if (alphaLabel) { alphaLabel.textContent = alphaHex(alpha); }
            }

            function sync(value) {
                var resolved = value || '';
                input.value = resolved;
                var base = stripAlpha(resolved);
                var alpha = parseAlpha(resolved);
                if (/^#[0-9a-f]{6}$/i.test(base)) {
                    picker.value = base;
                } else if (!resolved) {
                    picker.value = defaultPickerColour;
                    alpha = 255;
                }
                syncAlphaUi(alpha);

                var matchVal = (alpha < 255) ? resolved : base;
                getSwatches().forEach(function(swatch) {
                    swatch.classList.toggle('selected', (swatch.dataset.colour || '') === matchVal);
                });
            }

            function buildValue() {
                var base = stripAlpha(input.value.trim());
                if (!base) { return ''; }
                var a = alphaSlider ? parseInt(alphaSlider.value, 10) : 255;
                if (/^#[0-9a-f]{6}$/i.test(base) && a < 255) {
                    return base + alphaHex(a);
                }
                return base;
            }

            picker.addEventListener('change', function() {
                var base = picker.value || defaultPickerColour;
                var a = alphaSlider ? parseInt(alphaSlider.value, 10) : 255;
                sync(a < 255 ? base + alphaHex(a) : base);
            });
            input.addEventListener('input', function() {
                sync(input.value);
            });
            input.addEventListener('change', function() {
                sync(input.value.trim());
            });
            if (alphaSlider) {
                alphaSlider.addEventListener('input', function() {
                    syncAlphaUi(alphaSlider.value);
                    input.value = buildValue();
                });
            }
            wrapper.addEventListener('click', function(event) {
                var swatch = event.target.closest('[data-colour]');
                if (!swatch) {
                    return;
                }
                event.preventDefault();
                var colour = swatch.dataset.colour || '';
                if (alphaSlider) { alphaSlider.value = '255'; }
                sync(colour);
            });

            sync(input.value || config.initialValue || '');

            return {
                setValue(value) {
                    sync(value || '');
                }
            };
        }

        function createButtonFuCollapsibleCard(config) {
            const card = document.getElementById(config.cardId);
            const toggle = document.getElementById(config.toggleId);
            const body = document.getElementById(config.bodyId);
            const icon = document.getElementById(config.iconId);
            let collapsed = !!config.initialCollapsed;

            function apply() {
                card.classList.toggle('collapsed', collapsed);
                if (body) {
                    body.style.display = collapsed ? 'none' : '';
                }
                if (toggle) {
                    toggle.dataset.collapsed = collapsed ? 'true' : 'false';
                }
                if (icon) {
                    icon.className = 'codicon buttonfu-collapsible-card-icon ' + (collapsed ? 'codicon-chevron-right' : 'codicon-chevron-down');
                }
            }

            toggle.addEventListener('click', (event) => {
                event.preventDefault();
                collapsed = !collapsed;
                apply();
                if (typeof config.onToggle === 'function') {
                    config.onToggle(collapsed);
                }
            });

            apply();

            return {
                isCollapsed() {
                    return collapsed;
                },
                setCollapsed(value) {
                    collapsed = !!value;
                    apply();
                }
            };
        }

        function createButtonFuModelAutocomplete(config) {
            const input = document.getElementById(config.inputId);
            const list = document.getElementById(config.listId);
            const trigger = document.getElementById(config.triggerId);
            let models = [];
            let hasRequested = false;

            const autoModel = {
                id: 'auto',
                name: 'Auto (default)',
                vendor: 'Default',
                family: 'Automatic',
                maxInputTokens: 0
            };

            function getRenderableModels() {
                return [autoModel].concat(models);
            }

            function close() {
                list.classList.remove('visible');
            }

            function ensureModels() {
                if (hasRequested || typeof config.requestModels !== 'function') {
                    return;
                }
                hasRequested = true;
                config.requestModels();
            }

            function open() {
                ensureModels();
                render(input.value);
            }

            function render(filter) {
                const lower = (filter || '').toLowerCase();
                const filtered = getRenderableModels().filter((model) =>
                    !lower || model.id.toLowerCase().includes(lower) || model.name.toLowerCase().includes(lower)
                        || model.vendor.toLowerCase().includes(lower) || model.family.toLowerCase().includes(lower)
                );

                if (filtered.length === 0) {
                    list.innerHTML = '<div class="autocomplete-empty">No matching models.</div>';
                    list.classList.add('visible');
                    return;
                }

                const groups = {};
                filtered.forEach((model) => {
                    const vendor = model.vendor || 'Other';
                    if (!groups[vendor]) {
                        groups[vendor] = [];
                    }
                    groups[vendor].push(model);
                });

                let html = '';
                Object.keys(groups).sort((left, right) => {
                    if (left === 'Default') {
                        return -1;
                    }
                    if (right === 'Default') {
                        return 1;
                    }
                    return left.localeCompare(right);
                }).forEach((vendor) => {
                    html += '<div class="model-group-header">' + buttonFuControlEscapeHtml(vendor) + '</div>';
                    groups[vendor].forEach((model) => {
                        const tokenInfo = buttonFuFormatModelTokens(model.maxInputTokens);
                        const details = [model.family || model.id, tokenInfo].filter(Boolean).join(' · ');
                        const selected = (input.value || '').toLowerCase() === model.id.toLowerCase() ? ' selected' : '';
                        html += '<div class="autocomplete-item model-item' + selected + '" data-model-id="' + buttonFuControlEscapeAttr(model.id) + '">' +
                            '<div class="item-label">' + buttonFuControlEscapeHtml(model.name) + '</div>' +
                            '<div class="model-details"><span>' + buttonFuControlEscapeHtml(details) + '</span></div>' +
                            '</div>';
                    });
                });

                list.innerHTML = html;
                list.classList.add('visible');
                list.scrollIntoView({ block: 'nearest' });
            }

            function select(modelId) {
                input.value = modelId === 'auto' ? 'auto' : modelId;
                close();
            }

            input.addEventListener('focus', () => {
                open();
            });
            input.addEventListener('input', () => {
                open();
            });
            input.addEventListener('blur', () => {
                setTimeout(() => close(), 200);
            });
            if (trigger) {
                trigger.addEventListener('mousedown', (event) => {
                    event.preventDefault();
                });
                trigger.addEventListener('click', () => {
                    if (list.classList.contains('visible')) {
                        close();
                    } else {
                        open();
                    }
                });
            }
            list.addEventListener('mousedown', (event) => {
                const item = event.target.closest('[data-model-id]');
                if (item) {
                    select(item.dataset.modelId);
                }
            });
            document.addEventListener('click', (event) => {
                if (!list.classList.contains('visible')) {
                    return;
                }
                if (!list.contains(event.target) && !input.contains(event.target) && !(trigger && trigger.contains(event.target))) {
                    close();
                }
            });

            return {
                close,
                prefetch() {
                    ensureModels();
                },
                setModels(nextModels) {
                    models = Array.isArray(nextModels) ? nextModels : [];
                    if (document.activeElement === input || list.classList.contains('visible')) {
                        render(input.value);
                    }
                }
            };
        }
    `;
}