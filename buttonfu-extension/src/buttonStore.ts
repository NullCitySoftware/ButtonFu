import * as vscode from 'vscode';
import {
    ButtonConfig,
    ButtonFuItemActor,
    ButtonLocality,
    ButtonType,
    deriveButtonFuItemSource,
    deriveWorkspaceButtonId,
    generateId,
    getButtonFuItemActorFromSource,
    getButtonFuItemProvenanceForNew,
    mergeButtonFuItemProvenance,
    normalizeButtonFuItemActor
} from './types';

const VALID_BUTTON_TYPES: readonly string[] = ['TerminalCommand', 'PaletteAction', 'TaskExecution', 'CopilotCommand'];

/**
 * Manages persistence of button configurations.
 * Global buttons are stored in VS Code global settings.
 * Local buttons are stored in workspace state.
 * Workspace buttons are read from the `buttonfu.workspaceButtons` setting
 * (typically committed by a repo in `.vscode/settings.json`) and are read-only —
 * no save path ever writes to that setting.
 */
export class ButtonStore {
    private _onDidChange = new vscode.EventEmitter<void>();
    public readonly onDidChange = this._onDidChange.event;
    private suppressGlobalConfigRefresh = false;
    private readonly configChangeDisposable: vscode.Disposable;

    constructor(private readonly context: vscode.ExtensionContext) {
        // Watch for external changes to global settings and the workspace buttons setting
        this.configChangeDisposable = vscode.workspace.onDidChangeConfiguration(e => {
            const globalChanged = !this.suppressGlobalConfigRefresh && e.affectsConfiguration('buttonfu.globalButtons');
            const workspaceChanged = e.affectsConfiguration('buttonfu.workspaceButtons');
            if (globalChanged || workspaceChanged) {
                this._onDidChange.fire();
            }
        });
    }

    dispose(): void {
        this.configChangeDisposable.dispose();
        this._onDidChange.dispose();
    }

    /** Migrate legacy button types (e.g. PowerShellCommand → TerminalCommand) and data shapes */
    private migrateButton(b: ButtonConfig): ButtonConfig {
        let result = b;
        // Migrate legacy type name
        if ((result.type as string) === 'PowerShellCommand') {
            result = { ...result, type: 'TerminalCommand' as ButtonType };
        }
        // Migrate TerminalCommand buttons that have executionText but no terminals array
        if (result.type === 'TerminalCommand' && (!result.terminals || result.terminals.length === 0) && result.executionText) {
            result = {
                ...result,
                terminals: [{ name: 'Terminal 1', commands: result.executionText, dependentOnPrevious: false }],
                executionText: ''
            };
        }
        // Migrate legacy property name dependantOnPrevious → dependentOnPrevious
        if (result.terminals) {
            result = {
                ...result,
                terminals: result.terminals.map(t => {
                    const legacy = t as unknown as Record<string, unknown>;
                    if ('dependantOnPrevious' in legacy && !('dependentOnPrevious' in legacy)) {
                        const rest = { ...legacy };
                        delete rest.dependantOnPrevious;
                        return { ...rest, dependentOnPrevious: Boolean(legacy.dependantOnPrevious) } as typeof t;
                    }
                    return t;
                })
            };
        }
        return {
            id: result.id,
            name: result.name,
            locality: result.locality,
            description: result.description,
            type: result.type,
            executionText: result.executionText,
            terminals: result.terminals?.map((terminal) => ({ ...terminal })),
            category: result.category,
            icon: result.icon,
            colour: result.colour,
            copilotModel: result.copilotModel,
            copilotMode: result.copilotMode,
            copilotAttachFiles: Array.isArray(result.copilotAttachFiles) ? [...result.copilotAttachFiles] : [],
            copilotAttachActiveFile: result.copilotAttachActiveFile,
            sortOrder: result.sortOrder,
            warnBeforeExecution: result.warnBeforeExecution,
            userTokens: result.userTokens?.map((token) => ({ ...token })),
            createdBy: normalizeButtonFuItemActor(result.createdBy) ?? getButtonFuItemActorFromSource(result.source),
            lastModifiedBy: normalizeButtonFuItemActor(result.lastModifiedBy) ?? getButtonFuItemActorFromSource(result.source),
            source: deriveButtonFuItemSource(result.createdBy, result.lastModifiedBy, result.source)
        };
    }

    /** Get all global buttons from VS Code settings */
    getGlobalButtons(): ButtonConfig[] {
        const config = vscode.workspace.getConfiguration('buttonfu');
        const raw = config.get<ButtonConfig[]>('globalButtons') || [];
        return raw.map(b => this.migrateButton({ ...b, locality: 'Global' as ButtonLocality }))
            .sort((a, b) => (a.sortOrder ?? 99999) - (b.sortOrder ?? 99999));
    }

    /** Get all local (workspace) buttons from workspace state */
    getLocalButtons(): ButtonConfig[] {
        const raw = this.context.workspaceState.get<ButtonConfig[]>('buttonfu.localButtons') || [];
        return raw.map(b => this.migrateButton({ ...b, locality: 'Local' as ButtonLocality }))
            .sort((a, b) => (a.sortOrder ?? 99999) - (b.sortOrder ?? 99999));
    }

    /**
     * Get all workspace buttons from the `buttonfu.workspaceButtons` setting.
     * Entries are normalised/validated; unusable entries (no name) are skipped.
     * Workspace buttons are read-only — they are never written back anywhere.
     */
    getWorkspaceButtons(): ButtonConfig[] {
        const config = vscode.workspace.getConfiguration('buttonfu');
        const raw = config.get<unknown>('workspaceButtons');
        if (!Array.isArray(raw)) {
            return [];
        }

        const seenIds = new Set<string>();
        const buttons: ButtonConfig[] = [];
        for (const entry of raw) {
            const button = this.normalizeWorkspaceButton(entry);
            if (!button || seenIds.has(button.id)) {
                continue;
            }
            seenIds.add(button.id);
            buttons.push(button);
        }

        return buttons.sort((a, b) => (a.sortOrder ?? 99999) - (b.sortOrder ?? 99999));
    }

    /**
     * Normalise and validate one raw `buttonfu.workspaceButtons` settings entry.
     * Applies defaults (type TerminalCommand, category General, icon play, default colour)
     * and derives a stable id from name + category + executionText.
     * Returns null when the entry is unusable (not an object, or missing a name).
     */
    private normalizeWorkspaceButton(entry: unknown): ButtonConfig | null {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            return null;
        }

        const raw = entry as Record<string, unknown>;
        const name = typeof raw.name === 'string' ? raw.name.trim() : '';
        if (!name) {
            return null;
        }

        const type = VALID_BUTTON_TYPES.includes(raw.type as string) ? raw.type as ButtonType : 'TerminalCommand';
        const category = typeof raw.category === 'string' && raw.category.trim() ? raw.category.trim() : 'General';
        const executionText = typeof raw.executionText === 'string' ? raw.executionText : '';
        const terminals = Array.isArray(raw.terminals)
            ? (raw.terminals as unknown[])
                .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object' && !Array.isArray(t))
                .map((t, index) => ({
                    name: typeof t.name === 'string' && t.name ? t.name : `Terminal ${index + 1}`,
                    commands: typeof t.commands === 'string' ? t.commands : '',
                    dependentOnPrevious: Boolean(t.dependentOnPrevious)
                }))
            : undefined;

        return this.migrateButton({
            id: deriveWorkspaceButtonId(name, category, executionText),
            name,
            locality: 'Workspace' as ButtonLocality,
            description: typeof raw.description === 'string' ? raw.description : '',
            type,
            executionText,
            terminals,
            category,
            icon: typeof raw.icon === 'string' && raw.icon.trim() ? raw.icon.trim() : 'play',
            colour: typeof raw.colour === 'string' ? raw.colour : '',
            copilotModel: typeof raw.copilotModel === 'string' ? raw.copilotModel : '',
            copilotMode: typeof raw.copilotMode === 'string' ? raw.copilotMode : 'agent',
            copilotAttachFiles: Array.isArray(raw.copilotAttachFiles)
                ? (raw.copilotAttachFiles as unknown[]).filter((f): f is string => typeof f === 'string')
                : [],
            copilotAttachActiveFile: Boolean(raw.copilotAttachActiveFile),
            sortOrder: typeof raw.sortOrder === 'number' ? raw.sortOrder : undefined,
            warnBeforeExecution: Boolean(raw.warnBeforeExecution),
            userTokens: Array.isArray(raw.userTokens) ? raw.userTokens as ButtonConfig['userTokens'] : [],
            createdBy: 'User',
            lastModifiedBy: 'User',
            source: 'User'
        });
    }

    /** Returns true when the id belongs to a read-only workspace button. */
    isWorkspaceButton(id: string): boolean {
        return this.getWorkspaceButtons().some(b => b.id === id);
    }

    /** Get all buttons (global + local + workspace) */
    getAllButtons(): ButtonConfig[] {
        return [...this.getGlobalButtons(), ...this.getLocalButtons(), ...this.getWorkspaceButtons()];
    }

    /**
     * Save a button (routes to global or local based on locality).
     * Workspace buttons are read-only and are rejected — writes only ever
     * target the global settings store or workspace state.
     */
    async saveButton(button: ButtonConfig, actor: ButtonFuItemActor = 'User'): Promise<void> {
        if (button.locality === 'Workspace') {
            throw new Error('Workspace buttons are read-only — they are defined in .vscode/settings.json (buttonfu.workspaceButtons).');
        }
        const normalizedButton = this.migrateButton({
            ...button,
            id: button.id || generateId()
        });
        const existing = this.getButton(normalizedButton.id);
        const persistedButton: ButtonConfig = {
            ...normalizedButton,
            ...(existing
                ? mergeButtonFuItemProvenance(existing, actor)
                : getButtonFuItemProvenanceForNew(actor))
        };

        if (persistedButton.sortOrder === undefined || persistedButton.sortOrder === null) {
            const existingButtons = persistedButton.locality === 'Global' ? this.getGlobalButtons() : this.getLocalButtons();
            const maxOrder = existingButtons.reduce((m, b) => Math.max(m, b.sortOrder ?? 0), -1);
            persistedButton.sortOrder = maxOrder + 10;
        }

        await this.removeButtonFromOppositeLocality(persistedButton, false);

        if (persistedButton.locality === 'Global') {
            await this.saveGlobalButton(persistedButton, false);
        } else {
            await this.saveLocalButton(persistedButton, false);
        }
        this._onDidChange.fire();
    }

    /** Delete a button by ID. Workspace buttons are read-only and are never deleted. */
    async deleteButton(id: string): Promise<void> {
        if (this.isWorkspaceButton(id)) {
            console.warn('ButtonFu: deleteButton ignored — workspace buttons are read-only (defined in .vscode/settings.json)');
            return;
        }

        // Try removing from global
        const globals = this.getGlobalButtons();
        const globalIdx = globals.findIndex(b => b.id === id);
        if (globalIdx >= 0) {
            globals.splice(globalIdx, 1);
            await this.saveGlobalButtons(globals, false);
            this._onDidChange.fire();
            return;
        }

        // Try removing from local
        const locals = this.getLocalButtons();
        const localIdx = locals.findIndex(b => b.id === id);
        if (localIdx >= 0) {
            locals.splice(localIdx, 1);
            await this.saveLocalButtons(locals, false);
            this._onDidChange.fire();
            return;
        }
    }

    /** Get a button by ID */
    getButton(id: string): ButtonConfig | undefined {
        return this.getAllButtons().find(b => b.id === id);
    }

    /** Move a button up or down within its locality. Returns true if the reorder was applied. */
    async reorderButton(id: string, direction: 'up' | 'down'): Promise<boolean> {
        const globals = this.getGlobalButtons(); // already sorted
        const globalIdx = globals.findIndex(b => b.id === id);
        if (globalIdx >= 0) {
            globals.forEach((b, i) => { if (b.sortOrder === undefined) { b.sortOrder = i * 10; } });
            const swapIdx = direction === 'up' ? globalIdx - 1 : globalIdx + 1;
            if (swapIdx < 0 || swapIdx >= globals.length) { return false; }
            const tmp = globals[globalIdx].sortOrder!;
            globals[globalIdx].sortOrder = globals[swapIdx].sortOrder!;
            globals[swapIdx].sortOrder = tmp;
            await this.saveGlobalButtons(globals, false);
            this._onDidChange.fire();
            return true;
        }
        const locals = this.getLocalButtons(); // already sorted
        const localIdx = locals.findIndex(b => b.id === id);
        if (localIdx >= 0) {
            locals.forEach((b, i) => { if (b.sortOrder === undefined) { b.sortOrder = i * 10; } });
            const swapIdx = direction === 'up' ? localIdx - 1 : localIdx + 1;
            if (swapIdx < 0 || swapIdx >= locals.length) { return false; }
            const tmp = locals[localIdx].sortOrder!;
            locals[localIdx].sortOrder = locals[swapIdx].sortOrder!;
            locals[swapIdx].sortOrder = tmp;
            await this.saveLocalButtons(locals, false);
            this._onDidChange.fire();
            return true;
        }
        console.warn(`ButtonFu: reorderButton — button "${id}" not found in global or local lists`);
        return false;
    }

    /** Update only the sortOrder of a button by ID. */
    async setSortOrder(id: string, sortOrder: number): Promise<void> {
        const globals = this.getGlobalButtons();
        const globalIdx = globals.findIndex(b => b.id === id);
        if (globalIdx >= 0) {
            globals[globalIdx].sortOrder = sortOrder;
            await this.saveGlobalButtons(globals, false);
            this._onDidChange.fire();
            return;
        }
        const locals = this.getLocalButtons();
        const localIdx = locals.findIndex(b => b.id === id);
        if (localIdx >= 0) {
            locals[localIdx].sortOrder = sortOrder;
            await this.saveLocalButtons(locals, false);
            this._onDidChange.fire();
        }
    }

    /** Replace all global buttons */
    async saveGlobalButtons(buttons: ButtonConfig[], emitChange = true): Promise<void> {
        const config = vscode.workspace.getConfiguration('buttonfu');
        this.suppressGlobalConfigRefresh = true;
        try {
            await config.update(
                'globalButtons',
                buttons.map((button) => this.migrateButton({ ...button, locality: 'Global' as ButtonLocality })),
                vscode.ConfigurationTarget.Global
            );
        } finally {
            this.suppressGlobalConfigRefresh = false;
        }
        if (emitChange) {
            this._onDidChange.fire();
        }
    }

    /** Replace all local buttons */
    async saveLocalButtons(buttons: ButtonConfig[], emitChange = true): Promise<void> {
        await this.context.workspaceState.update(
            'buttonfu.localButtons',
            buttons.map((button) => this.migrateButton({ ...button, locality: 'Local' as ButtonLocality }))
        );
        if (emitChange) {
            this._onDidChange.fire();
        }
    }

    private async removeButtonFromOppositeLocality(button: ButtonConfig, emitChange = true): Promise<void> {
        if (button.locality === 'Global') {
            const locals = this.getLocalButtons();
            const nextLocals = locals.filter((entry) => entry.id !== button.id);
            if (nextLocals.length !== locals.length) {
                await this.saveLocalButtons(nextLocals, emitChange);
            }
            return;
        }

        const globals = this.getGlobalButtons();
        const nextGlobals = globals.filter((entry) => entry.id !== button.id);
        if (nextGlobals.length !== globals.length) {
            await this.saveGlobalButtons(nextGlobals, emitChange);
        }
    }

    private async saveGlobalButton(button: ButtonConfig, emitChange = true): Promise<void> {
        const buttons = this.getGlobalButtons();
        const idx = buttons.findIndex(b => b.id === button.id);
        if (idx >= 0) {
            buttons[idx] = button;
        } else {
            buttons.push(button);
        }
        await this.saveGlobalButtons(buttons, emitChange);
    }

    private async saveLocalButton(button: ButtonConfig, emitChange = true): Promise<void> {
        const buttons = this.getLocalButtons();
        const idx = buttons.findIndex(b => b.id === button.id);
        if (idx >= 0) {
            buttons[idx] = button;
        } else {
            buttons.push(button);
        }
        await this.saveLocalButtons(buttons, emitChange);
    }
}
