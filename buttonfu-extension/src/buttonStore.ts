import * as vscode from 'vscode';
import {
    ButtonConfig,
    ButtonFuItemActor,
    ButtonLocality,
    ButtonType,
    deriveButtonFuItemSource,
    generateId,
    getButtonFuItemActorFromSource,
    getButtonFuItemProvenanceForNew,
    mergeButtonFuItemProvenance,
    normalizeButtonFuItemActor
} from './types';

/**
 * Manages persistence of button configurations.
 * Global buttons are stored in VS Code global settings.
 * Local buttons are stored in workspace state.
 */
export class ButtonStore {
    private _onDidChange = new vscode.EventEmitter<void>();
    public readonly onDidChange = this._onDidChange.event;
    private suppressGlobalConfigRefresh = false;

    constructor(private readonly context: vscode.ExtensionContext) {
        // Watch for external changes to global settings
        vscode.workspace.onDidChangeConfiguration(e => {
            if (!this.suppressGlobalConfigRefresh && e.affectsConfiguration('buttonfu.globalButtons')) {
                this._onDidChange.fire();
            }
        });
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

    /** Get all buttons (global + local) */
    getAllButtons(): ButtonConfig[] {
        return [...this.getGlobalButtons(), ...this.getLocalButtons()];
    }

    /** Save a button (routes to global or local based on locality) */
    async saveButton(button: ButtonConfig, actor: ButtonFuItemActor = 'User'): Promise<void> {
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

    /** Delete a button by ID */
    async deleteButton(id: string): Promise<void> {
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
