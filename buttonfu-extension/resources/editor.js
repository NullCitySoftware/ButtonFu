// ButtonFu editor webview JavaScript
// Loaded as external resource from resources/editor.js
// Config globals (vscode, ICONS, MODES, TYPE_INFO, SYSTEM_TOKENS) are set by inline script in editorPanel.ts

const vscode = globalThis.vscode;
const ICONS = globalThis.ICONS || [];
const MODES = globalThis.MODES || [];
const TYPE_INFO = globalThis.TYPE_INFO || {};
const SYSTEM_TOKENS = globalThis.SYSTEM_TOKENS || [];

if (!vscode) {
    throw new Error('ButtonFu editor bootstrap was not initialised.');
}

let allButtons = [];
let buttonKeybindings = {};
let currentButton = null;
let isNewButton = false;
let cachedTasks = null;
let cachedCommands = null;
let cachedModels = null;
let cachedWorkspaceFiles = null;
let currentAttachFiles = [];
let currentUserTokens = [];
let editingTokenIndex = -1; // -1 = adding new, >= 0 = editing existing
let currentTerminals = []; // Array of {name, commands, dependantOnPrevious}
let activeTerminalTab = 0;
let optionInputTimer = null;

const DEFAULT_COLOUR_PICKER = '#4fc3f7';

function isHexColour(col) {
    return /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(col || '');
}

function clampAlphaPercent(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return 100;
    }
    return Math.max(0, Math.min(100, Math.round(numeric)));
}

function getAlphaPercent(col) {
    if (!/^#[0-9a-fA-F]{8}$/.test(col || '')) {
        return 100;
    }
    return clampAlphaPercent((parseInt(col.slice(7, 9), 16) / 255) * 100);
}

function composeHexColour(baseHex, alphaPercent) {
    const normalizedBase = /^#[0-9a-fA-F]{6}$/.test(baseHex || '')
        ? baseHex.toLowerCase()
        : DEFAULT_COLOUR_PICKER;
    const normalizedAlpha = clampAlphaPercent(alphaPercent);
    if (normalizedAlpha >= 100) {
        return normalizedBase;
    }
    const alphaHex = Math.round((normalizedAlpha / 100) * 255).toString(16).padStart(2, '0');
    return normalizedBase + alphaHex;
}

function updateColourAlphaControls(alphaPercent) {
    const normalized = clampAlphaPercent(alphaPercent);
    document.getElementById('btn-colour-alpha').value = String(normalized);
    document.getElementById('btn-colour-alpha-number').value = String(normalized);
    document.getElementById('btn-colour-alpha-value').textContent = normalized + '%';
}

function updateColourPreview(col) {
    const preview = document.getElementById('btn-colour-effective-preview');
    if (!preview) {
        return;
    }
    preview.style.backgroundColor = isHexColour(col) ? col : 'transparent';
    preview.title = col ? 'Final colour: ' + col : 'Default sidebar colour';
}

function getExecutionInput() {
    const type = document.getElementById('btn-type').value;
    return (type === 'TaskExecution' || type === 'PaletteAction')
        ? document.getElementById('btn-executionPicker')
        : document.getElementById('btn-executionText');
}

// ─── Initialisation ───
vscode.postMessage({ type: 'getButtons' });

// Tabs
document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('section-' + tab.dataset.tab).classList.add('active');
    });
});

// Close icon picker on outside click
document.addEventListener('click', (e) => {
    const dropdown = document.getElementById('iconDropdown');
    const trigger = document.getElementById('iconTrigger');
    if (dropdown.classList.contains('visible') && 
        !dropdown.contains(e.target) && !trigger.contains(e.target)) {
        dropdown.classList.remove('visible');
    }
});

// ─── Message handling ───
window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
        case 'refreshButtons':
            allButtons = msg.buttons || [];
            buttonKeybindings = msg.keybindings || {};
            renderButtonLists();
            if (msg.workspaceName !== undefined) { updateWorkspaceSectionTitle(msg.workspaceName); }
            break;
        case 'editButton':
            const btn = allButtons.find(b => b.id === msg.buttonId);
            if (btn) openEditor(btn);
            break;
        case 'addButton':
            addButton(msg.locality === 'Local' ? 'Local' : 'Global');
            break;
        case 'workspaceNameChanged':
            updateWorkspaceSectionTitle(msg.workspaceName);
            break;
        case 'tasksResult':
            cachedTasks = msg.tasks;
            showTaskAutocomplete(msg.tasks);
            break;
        case 'commandsResult':
            cachedCommands = msg.commands;
            showCommandAutocomplete(msg.commands);
            break;
        case 'modelsResult':
            cachedModels = msg.models;
            showModelAutocomplete(msg.models);
            break;
        case 'filesResult':
            if (msg.files) {
                currentAttachFiles.push(...msg.files);
                renderFileChips();
            }
            break;
        case 'workspaceFilesResult':
            cachedWorkspaceFiles = msg.files || [];
            renderWorkspaceFileList(cachedWorkspaceFiles, document.getElementById('workspaceFileSearch').value);
            break;
        case 'closeEditorOverlay':
            closeEditor();
            break;
        case 'switchTab': {
            const targetTab = document.querySelector('.tab[data-tab="' + msg.tab + '"]');
            if (targetTab) { targetTab.click(); }
            break;
        }
    }
});

function updateWorkspaceSectionTitle(name) {
    const el = document.getElementById('workspaceSectionTitle');
    if (el) { el.textContent = name ? 'Workspace Buttons [' + name + ']' : 'Workspace Buttons'; }
}

// ─── Render ───
function renderButtonLists() {
    const globals = allButtons.filter(b => b.locality === 'Global')
        .sort((a, b) => (a.sortOrder ?? 99999) - (b.sortOrder ?? 99999));
    const locals = allButtons.filter(b => b.locality === 'Local')
        .sort((a, b) => (a.sortOrder ?? 99999) - (b.sortOrder ?? 99999));
    
    document.getElementById('globalCount').textContent = globals.length;
    document.getElementById('localCount').textContent = locals.length;

    document.getElementById('globalButtonList').innerHTML = 
        globals.length ? renderCards(globals) : emptyState('No global buttons yet', 'Global buttons appear in every workspace.');
    document.getElementById('localButtonList').innerHTML = 
        locals.length ? renderCards(locals) : emptyState('No workspace buttons yet', 'Workspace buttons are specific to this project.');
}

function renderCards(buttons) {
    // buttons is pre-sorted by sortOrder
    const cats = {};
    const idxMap = {};
    buttons.forEach((b, i) => {
        idxMap[b.id] = i;
        const cat = b.category || 'Uncategorised';
        if (!cats[cat]) cats[cat] = [];
        cats[cat].push(b);
    });
    const total = buttons.length;
    
    let html = '';
    const sortedCats = Object.keys(cats).sort();
    
    if (sortedCats.length > 1) {
        sortedCats.forEach(cat => {
            const catItems = cats[cat];
            const catTotal = catItems.length;
            html += '<div style="margin-bottom:20px">';
            html += '<div style="display:flex;align-items:center;gap:10px;font-size:11px;font-weight:700;color:var(--vscode-descriptionForeground);margin-bottom:18px;text-transform:uppercase;letter-spacing:0.6px;line-height:1">' +
                '<span class="codicon codicon-folder" style="font-size:14px;line-height:1"></span><span>' + escapeHtml(cat) + '</span></div>';
            catItems.forEach((b, catIdx) => { html += renderCard(b, catIdx, catTotal); });
            html += '</div>';
        });
    } else {
        buttons.forEach((b, idx) => { html += renderCard(b, idx, total); });
    }
    
    return html;
}

function getUsedUniqueTokenCount(text) {
    const matches = String(text || '').match(/\$[A-Za-z_][A-Za-z0-9_]*\$/g) || [];
    return new Set(matches.map(t => t.toLowerCase())).size;
}

function getButtonAllText(b) {
    if (b.type === 'TerminalCommand' && b.terminals && b.terminals.length > 0) {
        return b.terminals.map(t => t.commands || '').join('\n');
    }
    return b.executionText || '';
}

function renderCard(b, idx, total) {
    const typeInfo = TYPE_INFO[b.type] || {};
    const colour = (b.colour || '').trim();
    const hasHex = isHexColour(colour);
    const category = b.category || 'General';
    const shortcut = buttonKeybindings[b.id];
    const tokenCount = getUsedUniqueTokenCount(getButtonAllText(b));
    const isFirst = idx === 0;
    const isLast  = idx === total - 1;

    const colourPart = hasHex
        ? '<span class="meta-sep">·</span>' +
          '<span class="meta-colour" style="background:' + escapeAttr(colour) + '"></span>' +
          '<span class="meta-hex">' + escapeHtml(colour) + '</span>'
        : '';

    const shortcutPart = shortcut
        ? '<span class="meta-sep">·</span>' +
          '<span class="meta-tag"><span class="codicon codicon-record-keys"></span> ' + escapeHtml(shortcut) + '</span>'
        : '';

                const tokenPart = tokenCount > 0
                        ? '<span class="meta-sep">·</span>' +
                            '<span class="meta-tag"><span class="codicon codicon-symbol-variable"></span> Tokenised [' + tokenCount + ']</span>'
                        : '';

                const modelPart = b.type === 'CopilotCommand'
                        ? '<span class="meta-sep">·</span>' +
                            '<span class="meta-tag"><span class="codicon codicon-hubot"></span> ' + escapeHtml((b.copilotModel || '').trim() || 'auto') + '</span>'
                        : '';

    return '<div class="button-card" data-button-id="' + escapeAttr(b.id) + '">' +
        '<div class="card-icon"><span class="codicon codicon-' + escapeHtml(b.icon || 'play') + '"></span></div>' +
        '<div class="card-body">' +
        '<div class="card-name">' + escapeHtml(b.name || 'Untitled') + '</div>' +
        '<div class="card-meta">' +
        '<span class="meta-tag"><span class="codicon codicon-' + escapeHtml(typeInfo.icon || 'play') + '"></span> ' + escapeHtml(typeInfo.label || b.type) + '</span>' +
        '<span class="meta-sep">·</span>' +
        '<span class="meta-tag"><span class="codicon codicon-tag"></span> ' + escapeHtml(category) + colourPart + '</span>' +
        tokenPart +
        modelPart +
        shortcutPart +
        '</div>' +
        '</div>' +
        '<div class="card-actions">' +
        '<button class="btn-icon btn-icon-xs" data-move-up-id="' + escapeAttr(b.id) + '" title="Move Up"' + (isFirst ? ' disabled' : '') + '>' +
        '<span class="codicon codicon-chevron-up"></span></button>' +
        '<button class="btn-icon btn-icon-xs" data-move-down-id="' + escapeAttr(b.id) + '" title="Move Down"' + (isLast ? ' disabled' : '') + '>' +
        '<span class="codicon codicon-chevron-down"></span></button>' +
        '<button class="btn-icon" data-duplicate-id="' + escapeAttr(b.id) + '" title="Duplicate">' +
        '<span class="codicon codicon-copy"></span></button>' +
        '<button class="btn-icon" data-edit-id="' + escapeAttr(b.id) + '" title="Edit">' +
        '<span class="codicon codicon-edit"></span></button>' +
        '<button class="btn-icon" data-delete-id="' + escapeAttr(b.id) + '" title="Delete">' +
        '<span class="codicon codicon-trash"></span></button>' +
        '</div></div>';
}

function emptyState(title, desc) {
    return '<div class="empty-state">' +
        '<div class="codicon codicon-add" style="font-size:40px;opacity:0.3;margin-bottom:12px"></div>' +
        '<p style="font-weight:600">' + escapeHtml(title) + '</p>' +
        '<p>' + escapeHtml(desc) + '</p>' +
        '</div>';
}

function getButton(id) { return allButtons.find(b => b.id === id); }

// ─── Editor ───
function addButton(locality) {
    const btn = {
        id: crypto.randomUUID(),
        name: '',
        locality: locality,
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
    isNewButton = true;
    openEditor(btn);
}

function openEditor(btn) {
    if (!btn) return;
    currentButton = btn;

    document.getElementById('editorTitle').textContent = isNewButton ? 'New Button' : 'Edit Button';
    document.getElementById('deleteBtn').style.display = isNewButton ? 'none' : '';

    document.getElementById('btn-id').value = btn.id || '';
    document.getElementById('btn-name').value = btn.name || '';
    document.getElementById('btn-locality').value = btn.locality || 'Global';
    document.getElementById('btn-description').value = btn.description || '';
    document.getElementById('btn-type').value = btn.type || 'TerminalCommand';
    document.getElementById('btn-executionText').value = btn.executionText || '';
    document.getElementById('btn-executionPicker').value = btn.executionText || '';
    document.getElementById('btn-category').value = btn.category || 'General';
    document.getElementById('btn-icon').value = btn.icon || 'play';
    document.getElementById('btn-colour').value = btn.colour || '';
    document.getElementById('btn-copilotModel').value = btn.copilotModel || '';
    document.getElementById('btn-copilotMode').value = btn.copilotMode || 'agent';
    
    currentAttachFiles = (btn.copilotAttachFiles || []).slice();
    renderFileChips();
    document.getElementById('btn-copilotAttachActiveFile').checked = btn.copilotAttachActiveFile ?? false;
    document.getElementById('btn-warnBeforeExecution').checked = btn.warnBeforeExecution ?? false;

    currentUserTokens = (btn.userTokens || []).map(t => Object.assign({}, t));
    editingTokenIndex = -1;
    renderTokenTable();
    setupTokenDragDrop();
    hideUserTokenForm();

    // Load terminal tabs
    if (btn.type === 'TerminalCommand') {
        if (btn.terminals && btn.terminals.length > 0) {
            currentTerminals = btn.terminals.map(t => Object.assign({}, t));
        } else if (btn.executionText) {
            // Migrate legacy executionText into a single default tab
            currentTerminals = [{ name: 'Terminal 1', commands: btn.executionText, dependantOnPrevious: false }];
        } else {
            currentTerminals = [{ name: 'Terminal 1', commands: '', dependantOnPrevious: false }];
        }
        activeTerminalTab = 0;
    }

    // Update icon preview
    updateIconPreview(btn.icon || 'play');

    // Sync colour fields and swatch selection
    syncColourUI(btn.colour || '');

    onTypeChanged();
    document.getElementById('editorOverlay').classList.add('visible');
    // Show shortcut button only when editing existing buttons (command exists)
    document.getElementById('shortcutGroup').style.display = isNewButton ? 'none' : '';
    document.getElementById('btn-name').focus();
}

function closeEditor() {
    document.getElementById('editorOverlay').classList.remove('visible');
    currentButton = null;
    isNewButton = false;
}

function saveButton() {
    const type = document.getElementById('btn-type').value;
    let executionText = '';
    let terminals = undefined;

    if (type === 'TerminalCommand') {
        // Flush the active tab's current UI values before collecting
        saveCurrentTerminalTab();
        terminals = currentTerminals.map(t => Object.assign({}, t));
    } else {
        executionText = getExecutionInput().value.trim();
    }

    const btn = {
        id: document.getElementById('btn-id').value,
        name: document.getElementById('btn-name').value.trim(),
        locality: document.getElementById('btn-locality').value,
        description: document.getElementById('btn-description').value.trim(),
        type: type,
        executionText: executionText,
        terminals: terminals,
        category: document.getElementById('btn-category').value.trim() || 'General',
        icon: document.getElementById('btn-icon').value || 'play',
        colour: document.getElementById('btn-colour').value.trim(),
        copilotModel: document.getElementById('btn-copilotModel').value.trim(),
        copilotMode: document.getElementById('btn-copilotMode').value,
        copilotAttachFiles: currentAttachFiles.slice(),
        copilotAttachActiveFile: document.getElementById('btn-copilotAttachActiveFile').checked,
        warnBeforeExecution: document.getElementById('btn-warnBeforeExecution').checked,
        userTokens: currentUserTokens.map(t => Object.assign({}, t)),
        sortOrder: currentButton ? currentButton.sortOrder : undefined
    };

    if (!btn.name) {
        document.getElementById('btn-name').focus();
        return;
    }

    vscode.postMessage({ type: 'saveButton', button: btn });
    closeEditor();
}

function deleteCurrentButton() {
    if (currentButton && currentButton.id) {
        vscode.postMessage({ type: 'deleteButton', id: currentButton.id });
    }
}

function confirmDelete(id) {
    vscode.postMessage({ type: 'deleteButton', id: id });
}

function duplicateButton(id) {
    const src = getButton(id);
    if (!src) return;
    const copy = Object.assign({}, src, {
        id: crypto.randomUUID(),
        name: src.name + ' (Copy)',
        sortOrder: undefined,
        copilotAttachFiles: (src.copilotAttachFiles || []).slice(),
        userTokens: (src.userTokens || []).map(t => Object.assign({}, t))
    });
    isNewButton = true;
    openEditor(copy);
}

function reorderButtonLocal(id, direction) {
    const btn = getButton(id);
    if (!btn) return;
    const group = allButtons.filter(b => b.locality === btn.locality)
        .sort((a, b) => (a.sortOrder ?? 99999) - (b.sortOrder ?? 99999));
    const idx = group.findIndex(b => b.id === id);
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= group.length) { return; }
    // Ensure sortOrders are numeric
    group.forEach((b, i) => { if (b.sortOrder === undefined) { b.sortOrder = i * 10; } });
    const tmp = group[idx].sortOrder;
    group[idx].sortOrder = group[swapIdx].sortOrder;
    group[swapIdx].sortOrder = tmp;
    // Propagate back to allButtons
    group.forEach(b => {
        const ab = allButtons.find(x => x.id === b.id);
        if (ab) { ab.sortOrder = b.sortOrder; }
    });
    renderButtonLists();
    // Flash the moved card after re-render
    requestAnimationFrame(() => {
        const card = document.querySelector('[data-button-id="' + id + '"]');
        if (card) {
            card.classList.add('card-flash');
            setTimeout(() => card.classList.remove('card-flash'), 380);
        }
    });
    vscode.postMessage({ type: 'reorderButton', id, direction });
}

// ─── Type changed ───
function onTypeChanged() {
    const type = document.getElementById('btn-type').value;
    const info = TYPE_INFO[type] || {};
    document.getElementById('typeHelp').textContent = info.description || '';
    // Close any open dropdowns when type changes
    ['autocompleteList', 'modelAutocomplete', 'workspaceFileList'].forEach(id => {
        document.getElementById(id).classList.remove('visible');
    });
    document.getElementById('iconDropdown').classList.remove('visible');

    const copilotSection = document.getElementById('copilotSection');
    const execLabel = document.getElementById('executionLabel');
    const execHelp = document.getElementById('executionHelp');
    const execField = document.getElementById('btn-executionText');
    const execPicker = document.getElementById('btn-executionPicker');
    const executionGroup = document.getElementById('executionGroup');
    const terminalTabsGroup = document.getElementById('terminalTabsGroup');

    if (type === 'TerminalCommand') {
        if (!currentTerminals || currentTerminals.length === 0) {
            currentTerminals = [{ name: 'Terminal 1', commands: '', dependantOnPrevious: false }];
            activeTerminalTab = 0;
        }
        // Show terminal tabs UI, hide the plain execution group
        executionGroup.style.display = 'none';
        terminalTabsGroup.style.display = '';
        renderTerminalTabs();
    } else {
        terminalTabsGroup.style.display = 'none';
        executionGroup.style.display = '';

        const usePicker = type === 'TaskExecution' || type === 'PaletteAction';
        if (usePicker) {
            execPicker.value = execField.value;
            execField.style.display = 'none';
            execPicker.style.display = '';
        } else {
            execField.value = execPicker.value;
            execPicker.style.display = 'none';
            execField.style.display = '';
        }
    }

    copilotSection.classList.toggle('visible', type === 'CopilotCommand');

    switch (type) {
        case 'TerminalCommand':
            // no execLabel/execHelp needed — tabs UI handles it
            break;
        case 'PaletteAction':
            execLabel.textContent = 'Palette Action';
            execPicker.placeholder = 'Search and select a VS Code command';
            execHelp.textContent = 'Pick a command from the list. Advanced: append |{"arg":"value"} manually for command arguments.';
            if (!cachedCommands) vscode.postMessage({ type: 'getCommands' });
            break;
        case 'TaskExecution':
            execLabel.textContent = 'Task';
            execPicker.placeholder = 'Search and select a task';
            execHelp.textContent = 'Pick a task discovered from your workspace and extensions.';
            if (!cachedTasks) vscode.postMessage({ type: 'getTasks' });
            break;
        case 'CopilotCommand':
            execLabel.textContent = 'Prompt';
            execField.placeholder = 'Explain this code and suggest improvements...';
            execHelp.textContent = 'The prompt text to send to GitHub Copilot Chat';
            if (!cachedModels) vscode.postMessage({ type: 'getModels' });
            break;
    }

    // Set up autocomplete for applicable types
    setupAutocomplete(type);
}

// ─── Terminal Tabs ───
function saveCurrentTerminalTab() {
    if (currentTerminals.length === 0) { return; }
    const tab = currentTerminals[activeTerminalTab];
    const cmdsEl = document.getElementById('terminal-tab-commands');
    const depEl  = document.getElementById('terminal-tab-dependent');
    if (cmdsEl) { tab.commands = cmdsEl.value; }
    if (depEl)  { tab.dependantOnPrevious = depEl.checked; }
}

function renderTerminalTabs() {
    const bar = document.getElementById('terminalTabsBar');
    if (!bar) { return; }
    if (!currentTerminals || currentTerminals.length === 0) {
        currentTerminals = [{ name: 'Terminal 1', commands: '', dependantOnPrevious: false }];
        activeTerminalTab = 0;
    }
    let html = '';
    currentTerminals.forEach((tab, i) => {
        const active = i === activeTerminalTab ? ' active' : '';
        const isFirst = i === 0;
        const isLast = i === currentTerminals.length - 1;
        html += '<div class="terminal-tab' + active + '" data-terminal-tab-index="' + i + '">' +
            '<span class="terminal-tab-label">' + escapeHtml(tab.name || ('Terminal ' + (i + 1))) + '</span>' +
            '<span class="terminal-tab-actions">' +
            '<button class="btn-icon btn-icon-xs" data-terminal-move-left="' + i + '" title="Move Left"' + (isFirst ? ' disabled' : '') + '>' +
            '<span class="codicon codicon-chevron-left"></span></button>' +
            '<button class="btn-icon btn-icon-xs" data-terminal-move-right="' + i + '" title="Move Right"' + (isLast ? ' disabled' : '') + '>' +
            '<span class="codicon codicon-chevron-right"></span></button>' +
            '<button class="btn-icon btn-icon-xs" data-terminal-delete="' + i + '" title="Remove Tab"' + (currentTerminals.length === 1 ? ' disabled' : '') + '>' +
            '<span class="codicon codicon-close"></span></button>' +
            '</span>' +
            '</div>';
    });
    html += '<button class="terminal-tab-add" id="terminalTabAdd" title="Add Terminal">+</button>';
    bar.innerHTML = html;
    updateTerminalTabContent();
}

function updateTerminalTabContent() {
    if (currentTerminals.length === 0) { return; }
    const tab = currentTerminals[activeTerminalTab];
    const cmdsEl = document.getElementById('terminal-tab-commands');
    const depEl  = document.getElementById('terminal-tab-dependent');
    if (cmdsEl) { cmdsEl.value = tab.commands || ''; }
    if (depEl)  { depEl.checked = tab.dependantOnPrevious || false; }
}

function switchTerminalTab(index) {
    saveCurrentTerminalTab();
    activeTerminalTab = index;
    renderTerminalTabs();
}

function addTerminalTab() {
    saveCurrentTerminalTab();
    const newName = 'Terminal ' + (currentTerminals.length + 1);
    currentTerminals.push({ name: newName, commands: '', dependantOnPrevious: false });
    activeTerminalTab = currentTerminals.length - 1;
    renderTerminalTabs();
}

function moveTerminalTab(index, direction) {
    saveCurrentTerminalTab();
    const swapIdx = direction === 'left' ? index - 1 : index + 1;
    if (swapIdx < 0 || swapIdx >= currentTerminals.length) { return; }
    const tmp = currentTerminals[index];
    currentTerminals[index] = currentTerminals[swapIdx];
    currentTerminals[swapIdx] = tmp;
    activeTerminalTab = swapIdx;
    renderTerminalTabs();
}

function deleteTerminalTab(index) {
    if (currentTerminals.length <= 1) { return; }
    saveCurrentTerminalTab();
    currentTerminals.splice(index, 1);
    if (activeTerminalTab >= currentTerminals.length) {
        activeTerminalTab = currentTerminals.length - 1;
    }
    renderTerminalTabs();
}

// ─── Tab inline rename ───
let renamingTabIndex = -1;

function startTabRename(index) {
    if (renamingTabIndex === index) { return; }
    commitTabRename(); // close any existing rename first
    renamingTabIndex = index;
    const tabEl = document.querySelector('#terminalTabsBar [data-terminal-tab-index="' + index + '"]');
    if (!tabEl) { return; }
    const labelEl = tabEl.querySelector('.terminal-tab-label');
    if (!labelEl) { return; }
    // Position the input over the label
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'terminal-tab-rename-input';
    input.value = currentTerminals[index].name || '';
    input.setAttribute('data-rename-for', String(index));
    // Make label's parent position:relative so the input can overlay it
    tabEl.style.position = 'relative';
    tabEl.appendChild(input);
    labelEl.style.visibility = 'hidden';
    input.focus();
    input.select();

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { commitTabRename(); e.preventDefault(); }
        if (e.key === 'Escape') { abortTabRename(); e.preventDefault(); }
        e.stopPropagation();
    });
    input.addEventListener('blur', () => {
        // Small delay so that a click on a button (delete, move) can fire first
        setTimeout(() => commitTabRename(), 80);
    });
}

function commitTabRename() {
    if (renamingTabIndex < 0) { return; }
    const index = renamingTabIndex;
    renamingTabIndex = -1;
    const tabEl = document.querySelector('#terminalTabsBar [data-terminal-tab-index="' + index + '"]');
    if (!tabEl) { return; }
    const input = tabEl.querySelector('.terminal-tab-rename-input');
    const labelEl = tabEl.querySelector('.terminal-tab-label');
    if (input) {
        const val = input.value.trim();
        if (val.length >= 2) {
            currentTerminals[index].name = val;
        }
        // val < 2 chars: just keep existing name
        input.remove();
    }
    if (labelEl) {
        labelEl.textContent = currentTerminals[index].name || ('Terminal ' + (index + 1));
        labelEl.style.visibility = '';
    }
    tabEl.style.position = '';
}

function abortTabRename() {
    if (renamingTabIndex < 0) { return; }
    const index = renamingTabIndex;
    renamingTabIndex = -1;
    const tabEl = document.querySelector('#terminalTabsBar [data-terminal-tab-index="' + index + '"]');
    if (!tabEl) { return; }
    const input = tabEl.querySelector('.terminal-tab-rename-input');
    const labelEl = tabEl.querySelector('.terminal-tab-label');
    if (input) { input.remove(); }
    if (labelEl) { labelEl.style.visibility = ''; }
    tabEl.style.position = '';
}

// Terminal tab bar — event delegation
document.getElementById('terminalTabsBar').addEventListener('click', (e) => {
    if (!(e.target instanceof Element)) { return; }
    const moveLeft  = e.target.closest('[data-terminal-move-left]');
    const moveRight = e.target.closest('[data-terminal-move-right]');
    const del       = e.target.closest('[data-terminal-delete]');
    const add       = e.target.closest('#terminalTabAdd');
    const tab       = e.target.closest('[data-terminal-tab-index]');
    // Ignore clicks inside the rename input itself
    if (e.target.classList.contains('terminal-tab-rename-input')) { return; }

    if (moveLeft && !moveLeft.disabled) {
        e.stopPropagation();
        commitTabRename();
        moveTerminalTab(parseInt(moveLeft.dataset.terminalMoveLeft), 'left');
    } else if (moveRight && !moveRight.disabled) {
        e.stopPropagation();
        commitTabRename();
        moveTerminalTab(parseInt(moveRight.dataset.terminalMoveRight), 'right');
    } else if (del && !del.disabled) {
        e.stopPropagation();
        commitTabRename();
        deleteTerminalTab(parseInt(del.dataset.terminalDelete));
    } else if (add) {
        commitTabRename();
        addTerminalTab();
    } else if (tab && !e.target.closest('[data-terminal-move-left],[data-terminal-move-right],[data-terminal-delete]')) {
        const idx = parseInt(tab.dataset.terminalTabIndex);
        if (idx !== activeTerminalTab) {
            switchTerminalTab(idx);
        }
    }
});

// Double-click on a tab label → start rename
document.getElementById('terminalTabsBar').addEventListener('dblclick', (e) => {
    if (!(e.target instanceof Element)) { return; }
    if (e.target.classList.contains('terminal-tab-rename-input')) { return; }
    const tab = e.target.closest('[data-terminal-tab-index]');
    if (tab && !e.target.closest('[data-terminal-move-left],[data-terminal-move-right],[data-terminal-delete],#terminalTabAdd')) {
        e.preventDefault();
        startTabRename(parseInt(tab.dataset.terminalTabIndex));
    }
});

// F2 anywhere in the editor overlay while TerminalCommand is active → start rename
document.addEventListener('keydown', (e) => {
    if (e.key !== 'F2') { return; }
    const overlay = document.getElementById('editorOverlay');
    if (!overlay || !overlay.classList.contains('visible')) { return; }
    const typeEl = document.getElementById('btn-type');
    if (!typeEl || typeEl.value !== 'TerminalCommand') { return; }
    if (e.target instanceof Element && e.target.classList.contains('terminal-tab-rename-input')) { return; }
    startTabRename(activeTerminalTab);
    e.preventDefault();
    e.stopPropagation();
});

// ─── Autocomplete ───
function setupAutocomplete(type) {
    const execField = getExecutionInput();
    const list = document.getElementById('autocompleteList');

    execField.onfocus = null;
    execField.oninput = null;
    execField.onblur = null;
    
    if (type === 'TaskExecution') {
        execField.onfocus = () => {
            if (cachedTasks) showTaskAutocomplete(cachedTasks);
            else vscode.postMessage({ type: 'getTasks' });
        };
        execField.oninput = () => {
            if (cachedTasks) renderAutocomplete(cachedTasks, execField.value);
        };
        execField.onblur = () => {
            setTimeout(() => { list.classList.remove('visible'); }, 200);
        };
    } else if (type === 'PaletteAction') {
        execField.onfocus = () => {
            if (cachedCommands) showCommandAutocomplete(cachedCommands);
            else vscode.postMessage({ type: 'getCommands' });
        };
        execField.oninput = () => {
            if (cachedCommands) renderAutocomplete(cachedCommands, execField.value);
        };
        execField.onblur = () => {
            setTimeout(() => { list.classList.remove('visible'); }, 200);
        };
    }
}

function showTaskAutocomplete(tasks) {
    if (document.getElementById('btn-type').value !== 'TaskExecution') return;
    const input = getExecutionInput();
    if (document.activeElement !== input) return;
    renderAutocomplete(tasks, input.value);
}

function showCommandAutocomplete(commands) {
    if (document.getElementById('btn-type').value !== 'PaletteAction') return;
    const input = getExecutionInput();
    if (document.activeElement !== input) return;
    renderAutocomplete(commands, input.value);
}

function showModelAutocomplete(models) {
    const list = document.getElementById('modelAutocomplete');
    const input = document.getElementById('btn-copilotModel');
    
    input.addEventListener('focus', () => {
        renderModelList(models, input.value);
    });
    input.addEventListener('input', () => {
        renderModelList(models, input.value);
    });
    input.addEventListener('blur', () => {
        setTimeout(() => { list.classList.remove('visible'); }, 200);
    });
}

function formatTokens(n) {
    if (!n) return '';
    if (n >= 1000) return Math.round(n / 1000) + 'K';
    return String(n);
}

function renderModelList(models, filter) {
    const list = document.getElementById('modelAutocomplete');
    const lower = (filter || '').toLowerCase();
    const filtered = models.filter(m => 
        !lower || m.id.toLowerCase().includes(lower) || m.name.toLowerCase().includes(lower)
            || m.vendor.toLowerCase().includes(lower) || m.family.toLowerCase().includes(lower)
    );

    if (filtered.length === 0) { list.classList.remove('visible'); return; }

    // Group by vendor
    const groups = {};
    filtered.forEach(m => {
        const v = m.vendor || 'Other';
        if (!groups[v]) groups[v] = [];
        groups[v].push(m);
    });

    let html = '';
    Object.keys(groups).sort().forEach(vendor => {
        html += '<div class="model-group-header">' + escapeHtml(vendor) + '</div>';
        groups[vendor].forEach(m => {
            const ctx = formatTokens(m.maxInputTokens);
            const details = [m.family || m.id, ctx].filter(Boolean).join(' · ');
            html += '<div class="autocomplete-item model-item" data-model-id="' + escapeAttr(m.id) + '">' +
                '<div class="item-label">' + escapeHtml(m.name) + '</div>' +
                '<div class="model-details"><span>' + escapeHtml(details) + '</span></div>' +
                '</div>';
        });
    });

    list.innerHTML = html;
    list.classList.add('visible');
    list.scrollIntoView({ block: 'nearest' });
}

function selectModel(id) {
    document.getElementById('btn-copilotModel').value = id;
    document.getElementById('modelAutocomplete').classList.remove('visible');
}

function renderAutocomplete(items, filter) {
    const list = document.getElementById('autocompleteList');
    const lower = (filter || '').toLowerCase();
    const normalized = items.map(i => typeof i === 'string'
        ? { value: i, label: i, source: '' }
        : { value: i.value, label: i.label || i.value, source: i.source || '' });
    const filtered = normalized.filter(i => {
        if (!lower) { return true; }
        return i.value.toLowerCase().includes(lower)
            || i.label.toLowerCase().includes(lower)
            || i.source.toLowerCase().includes(lower);
    }).slice(0, 40);
    
    if (filtered.length === 0) { list.classList.remove('visible'); return; }
    
    list.innerHTML = filtered.map(i => 
        '<div class="autocomplete-item" data-autocomplete-value="' + escapeAttr(i.value) + '">' +
        '<span class="item-label">' + escapeHtml(i.label) + '</span>' +
        (i.source ? '<span class="item-source">' + escapeHtml(i.source) + '</span>' : '') +
        (i.label !== i.value ? '<span class="item-source">' + escapeHtml(i.value) + '</span>' : '') +
        '</div>'
    ).join('');
    list.classList.add('visible');
    list.scrollIntoView({ block: 'nearest' });
}

function selectAutocomplete(value) {
    getExecutionInput().value = value;
    document.getElementById('autocompleteList').classList.remove('visible');
}

// ─── Icon Picker ───
function toggleIconPicker() {
    const dd = document.getElementById('iconDropdown');
    dd.classList.toggle('visible');
    if (dd.classList.contains('visible')) {
        renderIconGrid();
        document.getElementById('iconSearch').value = '';
        document.getElementById('iconSearch').focus();
        dd.scrollIntoView({ block: 'nearest' });
    }
}

function renderIconGrid(filter) {
    const grid = document.getElementById('iconGrid');
    const lower = (filter || '').toLowerCase();
    const current = document.getElementById('btn-icon').value;
    
    const filtered = ICONS.filter(i => 
        !lower || i.name.toLowerCase().includes(lower) || i.label.toLowerCase().includes(lower)
    );
    
    grid.innerHTML = filtered.map(i => 
        '<div class="icon-picker-item' + (i.name === current ? ' selected' : '') + '" ' +
        'data-icon-name="' + i.name + '" title="' + escapeHtml(i.label) + '">' +
        '<span class="codicon codicon-' + i.name + '"></span></div>'
    ).join('');
}

function filterIcons() {
    renderIconGrid(document.getElementById('iconSearch').value);
}

function selectIcon(name) {
    document.getElementById('btn-icon').value = name;
    updateIconPreview(name);
    document.getElementById('iconDropdown').classList.remove('visible');
}

function updateIconPreview(name) {
    const preview = document.getElementById('iconPreview');
    preview.className = 'preview-icon codicon codicon-' + name;
    const info = ICONS.find(i => i.name === name);
    document.getElementById('iconLabel').textContent = info ? info.label : name;
}

// ─── Colour ───
function syncColourControls(col) {
    const normalized = String(col || '').trim();
    const picker = document.getElementById('btn-colour-picker');
    const clearBtn = document.getElementById('btn-colour-clear');

    if (/^#[0-9a-fA-F]{6}$/.test(normalized)) {
        picker.value = normalized.slice(0, 7).toLowerCase();
    } else if (/^#[0-9a-fA-F]{8}$/.test(normalized)) {
        picker.value = normalized.slice(0, 7).toLowerCase();
    } else if (!/^#[0-9a-fA-F]{6}$/.test(picker.value || '')) {
        picker.value = DEFAULT_COLOUR_PICKER;
    }

    updateColourAlphaControls(isHexColour(normalized) ? getAlphaPercent(normalized) : 100);
    updateColourPreview(normalized);
    clearBtn.disabled = normalized === '';

    const lower = normalized.toLowerCase();
    document.querySelectorAll('.colour-swatch').forEach(sw => {
        sw.classList.toggle('selected', (sw.dataset.colour || '').toLowerCase() === lower);
    });
}

function syncColourUI(col) {
    document.getElementById('btn-colour').value = col;
    syncColourControls(col);
}

function setColour(col) {
    syncColourUI(col || '');
}

function onColourPicked(val) {
    const alphaPercent = clampAlphaPercent(document.getElementById('btn-colour-alpha').value);
    syncColourUI(composeHexColour(val, alphaPercent));
}

function onColourAlphaChanged(value) {
    if (value === '') {
        return;
    }
    const alphaPercent = clampAlphaPercent(value);
    const baseHex = document.getElementById('btn-colour-picker').value || DEFAULT_COLOUR_PICKER;
    syncColourUI(composeHexColour(baseHex, alphaPercent));
}

function onColourTextChanged() {
    syncColourControls(document.getElementById('btn-colour').value);
}

// ─── Files ───
function pickFiles() {
    vscode.postMessage({ type: 'pickFiles' });
}

function onWorkspaceFileSearch() {
    const q = document.getElementById('workspaceFileSearch').value;
    if (!q) { document.getElementById('workspaceFileList').classList.remove('visible'); return; }
    if (!cachedWorkspaceFiles) {
        vscode.postMessage({ type: 'getWorkspaceFiles' });
    } else {
        renderWorkspaceFileList(cachedWorkspaceFiles, q);
    }
}

function renderWorkspaceFileList(files, filter) {
    const list = document.getElementById('workspaceFileList');
    const lower = (filter || '').toLowerCase();
    if (!lower) { list.classList.remove('visible'); return; }
    const filtered = files.filter(f => f.toLowerCase().includes(lower)).slice(0, 60);
    if (!filtered.length) { list.classList.remove('visible'); return; }
    list.innerHTML = filtered.map(f =>
        '<div class="autocomplete-item" data-workspace-file="' + escapeAttr(f) + '">' +
        '<span class="item-label">' + escapeHtml(f) + '</span></div>'
    ).join('');
    list.classList.add('visible');
    list.scrollIntoView({ block: 'nearest' });
}

function addWorkspaceFile(filePath) {
    if (!currentAttachFiles.includes(filePath)) {
        currentAttachFiles.push(filePath);
        renderFileChips();
    }
    document.getElementById('workspaceFileSearch').value = '';
    document.getElementById('workspaceFileList').classList.remove('visible');
}

function renderFileChips() {
    const container = document.getElementById('fileChips');
    container.innerHTML = currentAttachFiles.map((f, i) => 
        '<span class="file-chip">' +
        '<span class="codicon codicon-file"></span> ' + escapeHtml(f) +
        ' <span class="remove-file" data-file-index="' + i + '">\u00d7</span></span>'
    ).join('');
}

function removeFile(idx) {
    currentAttachFiles.splice(idx, 1);
    renderFileChips();
}

// ─── Utilities ───
function escapeHtml(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, '&#39;');
}

// ─── Event Listeners ───
document.getElementById('addGlobalBtn').addEventListener('click', () => addButton('Global'));
document.getElementById('addLocalBtn').addEventListener('click', () => addButton('Local'));
document.getElementById('deleteBtn').addEventListener('click', () => deleteCurrentButton());
document.getElementById('cancelBtn').addEventListener('click', () => closeEditor());
document.getElementById('saveBtn').addEventListener('click', () => saveButton());
document.getElementById('btn-type').addEventListener('change', () => onTypeChanged());
document.getElementById('iconTrigger').addEventListener('click', () => toggleIconPicker());
document.getElementById('iconSearch').addEventListener('input', () => filterIcons());
document.getElementById('btn-colour-picker').addEventListener('input', (e) => onColourPicked(e.target.value));
document.getElementById('btn-colour-picker').addEventListener('change', (e) => onColourPicked(e.target.value));
document.getElementById('btn-colour').addEventListener('input', () => onColourTextChanged());
document.getElementById('btn-colour-alpha').addEventListener('input', (e) => onColourAlphaChanged(e.target.value));
document.getElementById('btn-colour-alpha').addEventListener('change', (e) => onColourAlphaChanged(e.target.value));
document.getElementById('btn-colour-alpha-number').addEventListener('input', (e) => {
    if (e.target.value !== '') {
        onColourAlphaChanged(e.target.value);
    }
});
document.getElementById('btn-colour-alpha-number').addEventListener('change', (e) => onColourAlphaChanged(e.target.value));
document.getElementById('btn-colour-clear').addEventListener('click', () => setColour(''));
document.getElementById('pickFilesBtn').addEventListener('click', () => pickFiles());
document.getElementById('setShortcutBtn').addEventListener('click', () => {
    if (currentButton && currentButton.id) {
        vscode.postMessage({ type: 'openKeybinding', buttonId: currentButton.id });
    }
});

// Colour swatches — event delegation
document.querySelectorAll('.colour-presets').forEach(row => {
    row.addEventListener('click', (e) => {
        const swatch = e.target.closest('.colour-swatch');
        if (swatch) setColour(swatch.dataset.colour);
    });
});

// Button cards — document-level delegation (covers dynamically rendered content)
document.addEventListener('click', (e) => {
    const del = e.target.closest('[data-delete-id]');
    if (del) { e.stopPropagation(); confirmDelete(del.dataset.deleteId); return; }
    const dup = e.target.closest('[data-duplicate-id]');
    if (dup) { e.stopPropagation(); duplicateButton(dup.dataset.duplicateId); return; }
    const moveUp = e.target.closest('[data-move-up-id]');
    if (moveUp && !moveUp.disabled) { e.stopPropagation(); reorderButtonLocal(moveUp.dataset.moveUpId, 'up'); return; }
    const moveDown = e.target.closest('[data-move-down-id]');
    if (moveDown && !moveDown.disabled) { e.stopPropagation(); reorderButtonLocal(moveDown.dataset.moveDownId, 'down'); return; }
    const edit = e.target.closest('[data-edit-id]');
    if (edit) { e.stopPropagation(); isNewButton = false; openEditor(getButton(edit.dataset.editId)); return; }
    const card = e.target.closest('[data-button-id]');
    if (card && !e.target.closest('[data-delete-id],[data-duplicate-id],[data-move-up-id],[data-move-down-id],[data-edit-id]')) { isNewButton = false; openEditor(getButton(card.dataset.buttonId)); }
});

// Icon grid — event delegation
document.getElementById('iconGrid').addEventListener('click', (e) => {
    const item = e.target.closest('[data-icon-name]');
    if (item) selectIcon(item.dataset.iconName);
});

// Autocomplete — event delegation
document.getElementById('autocompleteList').addEventListener('mousedown', (e) => {
    const item = e.target.closest('[data-autocomplete-value]');
    if (item) selectAutocomplete(item.dataset.autocompleteValue);
});

// Model autocomplete — event delegation
document.getElementById('modelAutocomplete').addEventListener('mousedown', (e) => {
    const item = e.target.closest('[data-model-id]');
    if (item) selectModel(item.dataset.modelId);
});

// File chips — event delegation
document.getElementById('fileChips').addEventListener('click', (e) => {
    const remove = e.target.closest('[data-file-index]');
    if (remove) removeFile(parseInt(remove.dataset.fileIndex));
});

// Workspace file search
document.getElementById('workspaceFileSearch').addEventListener('input', onWorkspaceFileSearch);
document.getElementById('workspaceFileSearch').addEventListener('focus', onWorkspaceFileSearch);
document.getElementById('workspaceFileSearch').addEventListener('blur', () => {
    setTimeout(() => document.getElementById('workspaceFileList').classList.remove('visible'), 200);
});

// Workspace file autocomplete — event delegation
document.getElementById('workspaceFileList').addEventListener('mousedown', (e) => {
    const item = e.target.closest('[data-workspace-file]');
    if (item) addWorkspaceFile(item.dataset.workspaceFile);
});

// ─── Token Table ───
function renderTokenTable() {
    const tbody = document.getElementById('tokenTableBody');
    let html = '';

    // System tokens section
    html += '<tr class="token-section-header"><td colspan="3"><span class="codicon codicon-server"></span><span>System Tokens</span></td></tr>';
    SYSTEM_TOKENS.forEach(st => {
        html += '<tr draggable="true" data-drag-token="' + escapeAttr(st.token) + '">' +
            '<td style="color:var(--vscode-textLink-foreground)">' + escapeHtml(st.token) + '</td>' +
            '<td class="sys-label">' + escapeHtml(st.description) + '</td>' +
            '<td>' + escapeHtml(st.dataType) + '</td></tr>';
    });

    // User tokens section
    html += '<tr class="token-section-header"><td colspan="3"><span class="codicon codicon-account"></span><span>User Tokens</span></td></tr>';
    if (currentUserTokens.length === 0) {
        html += '<tr><td colspan="3" style="color:var(--vscode-descriptionForeground);font-family:var(--vscode-font-family)">No user tokens defined. Click "Add User Token" to create one.</td></tr>';
    } else {
        currentUserTokens.forEach((ut, i) => {
            const valDisplay = ut.defaultValue ? escapeHtml(ut.defaultValue) : '<span style="color:var(--vscode-descriptionForeground);font-family:var(--vscode-font-family);font-style:italic">[User Requested]</span>';
            const reqBadge = ut.required ? ' <span style="color:#c72e2e;font-weight:bold" title="Required">*</span>' : '';
            html += '<tr class="user-token-table" draggable="true" data-drag-token="' + escapeAttr(ut.token) + '">' +
                '<td style="color:var(--vscode-textLink-foreground)">' + escapeHtml(ut.token) + reqBadge + '</td>' +
                '<td style="font-family:var(--vscode-font-family)">' + valDisplay + '</td>' +
                '<td>' + escapeHtml(ut.dataType) +
                '<span class="ut-actions">' +
                '<button class="btn-icon-xs" data-edit-token="' + i + '" title="Edit"><span class="codicon codicon-edit"></span></button>' +
                '<button class="btn-icon-xs" data-delete-token="' + i + '" title="Delete"><span class="codicon codicon-trash"></span></button>' +
                '</span></td></tr>';
        });
    }
    tbody.innerHTML = html;
}

function scrollUserTokenIntoView(tokenName) {
    if (!tokenName) return;
    const tbody = document.getElementById('tokenTableBody');
    if (!tbody) return;
    const tokenLower = tokenName.toLowerCase();
    const row = Array.from(tbody.querySelectorAll('tr.user-token-table'))
        .find(r => (r.dataset.dragToken || '').toLowerCase() === tokenLower);
    if (row) {
        row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
}

function showUserTokenForm(index) {
    const form = document.getElementById('userTokenForm');
    form.style.display = 'block';
    // Clear any prior validation error
    const errEl = document.getElementById('ut-token-error');
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
    document.getElementById('ut-token').style.borderColor = '';

    editingTokenIndex = index;
    if (index >= 0 && index < currentUserTokens.length) {
        const t = currentUserTokens[index];
        document.getElementById('utFormTitle').textContent = 'Edit User Token';
        document.getElementById('ut-token').value = t.token || '';
        document.getElementById('ut-datatype').value = t.dataType || 'String';
        document.getElementById('ut-label').value = t.label || '';
        document.getElementById('ut-description').value = t.description || '';
        document.getElementById('ut-defaultValue').value = t.defaultValue || '';
        document.getElementById('ut-required').checked = t.required || false;
    } else {
        document.getElementById('utFormTitle').textContent = 'New User Token';
        document.getElementById('ut-token').value = '';
        document.getElementById('ut-datatype').value = 'String';
        document.getElementById('ut-label').value = '';
        document.getElementById('ut-description').value = '';
        document.getElementById('ut-defaultValue').value = '';
        document.getElementById('ut-required').checked = false;
    }
    document.getElementById('ut-token').focus();
}

function hideUserTokenForm() {
    document.getElementById('userTokenForm').style.display = 'none';
    editingTokenIndex = -1;
}

function setTokenError(msg) {
    const errEl = document.getElementById('ut-token-error');
    const inp = document.getElementById('ut-token');
    if (msg) {
        errEl.textContent = msg;
        errEl.style.display = 'block';
        inp.style.borderColor = '#c72e2e';
        inp.focus();
    } else {
        errEl.style.display = 'none';
        errEl.textContent = '';
        inp.style.borderColor = '';
    }
}

function saveUserToken() {
    let token = (document.getElementById('ut-token').value || '').trim();
    if (!token) {
        setTokenError('Token name is required');
        return;
    }
    // Normalize to exactly one leading and one trailing $.
    token = '$' + token.replace(/^\$+/, '').replace(/\$+$/, '') + '$';
    // Validate format: $Identifier$
    if (!/^\$[A-Za-z_][A-Za-z0-9_]*\$$/.test(token)) {
        setTokenError('Must be $Identifier$ — letters, digits, underscores only (e.g. $MyToken$)');
        return;
    }
    // Check for system token collision (case-insensitive)
    if (SYSTEM_TOKENS.some(st => st.token.toLowerCase() === token.toLowerCase())) {
        setTokenError('This name conflicts with a system token — choose a different name');
        return;
    }
    // Check for duplicate user token (except when editing the same index)
    const dupIdx = currentUserTokens.findIndex(ut => ut.token.toLowerCase() === token.toLowerCase());
    if (dupIdx >= 0 && dupIdx !== editingTokenIndex) {
        setTokenError('A user token with this name already exists');
        return;
    }
    setTokenError('');

    const ut = {
        token: token,
        label: (document.getElementById('ut-label').value || '').trim(),
        description: (document.getElementById('ut-description').value || '').trim(),
        dataType: document.getElementById('ut-datatype').value,
        defaultValue: (document.getElementById('ut-defaultValue').value || '').trim(),
        required: document.getElementById('ut-required').checked
    };

    if (editingTokenIndex >= 0 && editingTokenIndex < currentUserTokens.length) {
        currentUserTokens[editingTokenIndex] = ut;
    } else {
        currentUserTokens.push(ut);
    }

    renderTokenTable();
    setupTokenDragDrop();
    scrollUserTokenIntoView(token);
    hideUserTokenForm();
}

function deleteUserToken(index) {
    if (index >= 0 && index < currentUserTokens.length) {
        currentUserTokens.splice(index, 1);
        renderTokenTable();
        setupTokenDragDrop();
    }
}

// ─── Token Drag-Drop ───
let tokenDragDropInit = false;
function setupTokenDragDrop() {
    const execText = document.getElementById('btn-executionText');
    const execPicker = document.getElementById('btn-executionPicker');

    if (!tokenDragDropInit) {
        tokenDragDropInit = true;
        // Drag start/end via delegation on the whole table body
        const tbody = document.getElementById('tokenTableBody');
        tbody.addEventListener('dragstart', onTokenDragStart);
        tbody.addEventListener('dragend', onTokenDragEnd);

        // Drop targets — wire once on both exec fields + terminal commands textarea
        const termCmds = document.getElementById('terminal-tab-commands');
        [execText, execPicker, termCmds].forEach(target => {
            if (!target) { return; }
            target.addEventListener('dragover', onExecDragOver);
            target.addEventListener('dragleave', onExecDragLeave);
            target.addEventListener('drop', onExecDrop);
        });
    }
}

function onTokenDragStart(e) {
    const row = e.target.closest('tr[data-drag-token]');
    if (!row) return;
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', row.dataset.dragToken);
    row.classList.add('drag-over-row');
}

function onTokenDragEnd(e) {
    document.querySelectorAll('tr.drag-over-row').forEach(r => r.classList.remove('drag-over-row'));
}

function onExecDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    e.target.classList.add('drop-target-active');
}

function onExecDragLeave(e) {
    e.target.classList.remove('drop-target-active');
}

function onExecDrop(e) {
    e.preventDefault();
    e.target.classList.remove('drop-target-active');
    const token = e.dataTransfer.getData('text/plain');
    if (!token) return;
    const el = e.target;
    // For textarea: insert at caret
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        const start = el.selectionStart ?? el.value.length;
        const end = el.selectionEnd ?? el.value.length;
        el.value = el.value.slice(0, start) + token + el.value.slice(end);
        const newPos = start + token.length;
        el.setSelectionRange(newPos, newPos);
        el.focus();
    }
}

// Token button events — use delegation on the form container to avoid null issues
document.getElementById('userTokenForm').addEventListener('click', (e) => {
    if (e.target.closest('#utSaveBtn')) { saveUserToken(); return; }
    if (e.target.closest('#utCancelBtn')) { hideUserTokenForm(); return; }
});
document.getElementById('addUserTokenBtn').addEventListener('click', () => showUserTokenForm(-1));

// Token table event delegation
document.getElementById('tokenTableBody').addEventListener('click', (e) => {
    const editBtn = e.target.closest('[data-edit-token]');
    if (editBtn) { showUserTokenForm(parseInt(editBtn.dataset.editToken)); return; }
    const delBtn = e.target.closest('[data-delete-token]');
    if (delBtn) { deleteUserToken(parseInt(delBtn.dataset.deleteToken)); return; }
});

// Setup drag-drop initially (no user tokens yet, but sets up exec textarea targets)
setupTokenDragDrop();

// ─── Options ───
function onOptionChanged() {
    const colVal = parseInt(document.getElementById('opt-columns').value) || 1;
    const opts = {
        showBuildInformation: document.getElementById('opt-showBuildInfo').checked,
        showAddAndEditorButtons: document.getElementById('opt-showAddEditorBtns').checked,
        columns: Math.max(1, Math.min(12, colVal))
    };
    const stamp = document.getElementById('headerDebugStamp');
    if (stamp) { stamp.style.display = opts.showBuildInformation ? '' : 'none'; }
    vscode.postMessage({ type: 'saveOptions', options: opts });
}

function onOptionInputChanged() {
    clearTimeout(optionInputTimer);
    optionInputTimer = setTimeout(() => onOptionChanged(), 150);
}

document.getElementById('opt-showBuildInfo').addEventListener('change', onOptionChanged);
document.getElementById('opt-showAddEditorBtns').addEventListener('change', onOptionChanged);
document.getElementById('opt-columns').addEventListener('change', onOptionChanged);
document.getElementById('opt-columns').addEventListener('input', onOptionInputChanged);
