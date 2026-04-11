import * as vscode from 'vscode';
import {
    ButtonFuItemActor,
    ButtonLocality,
    DEFAULT_NOTE_FOLDER_ICON,
    LEGACY_DEFAULT_NOTE_ICON,
    NoteConfig,
    NOTE_DEFAULT_ACTIONS,
    deriveButtonFuItemSource,
    generateId,
    getButtonFuItemActorFromSource,
    getButtonFuItemProvenanceForNew,
    getDefaultNoteIcon,
    mergeButtonFuItemProvenance,
    normalizeButtonFuItemActor
} from './types';

const LOCAL_NOTES_KEY = 'buttonfu.localNotes';

function normalizePersistedIcon(icon: string | undefined): string {
    const value = icon?.trim();
    if (!value || value === DEFAULT_NOTE_FOLDER_ICON || value === LEGACY_DEFAULT_NOTE_ICON) {
        return getDefaultNoteIcon();
    }

    return value;
}

function normalizeDefaultAction(action: unknown): NoteConfig['defaultAction'] {
    return NOTE_DEFAULT_ACTIONS.includes(action as NoteConfig['defaultAction'])
        ? action as NoteConfig['defaultAction']
        : 'open';
}

/** Manages persistence and ordering for flat note items. */
export class NoteStore {
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    public readonly onDidChange = this._onDidChange.event;
    private suppressGlobalConfigRefresh = false;

    constructor(private readonly context: vscode.ExtensionContext) {
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (!this.suppressGlobalConfigRefresh && event.affectsConfiguration('buttonfu.globalNotes')) {
                this._onDidChange.fire();
            }
        });
    }

    /** Get all global notes from user settings. */
    getGlobalNodes(): NoteConfig[] {
        const config = vscode.workspace.getConfiguration('buttonfu');
        const raw = config.get<unknown[]>('globalNotes') ?? [];
        return this.normalizePersistedNotes(raw, 'Global');
    }

    /** Get all workspace notes from workspace state. */
    getLocalNodes(): NoteConfig[] {
        const raw = this.context.workspaceState.get<unknown[]>(LOCAL_NOTES_KEY) ?? [];
        return this.normalizePersistedNotes(raw, 'Local');
    }

    /** Get all notes across both scopes. */
    getAllNodes(): NoteConfig[] {
        return [...this.getGlobalNodes(), ...this.getLocalNodes()];
    }

    /** Get a note by ID. */
    getNode(id: string): NoteConfig | undefined {
        return this.getAllNodes().find((note) => note.id === id);
    }

    /** Get a note by ID. */
    getNote(id: string): NoteConfig | undefined {
        return this.getNode(id);
    }

    /** Save or update a note. */
    async saveNode(note: NoteConfig, actor: ButtonFuItemActor = 'User'): Promise<NoteConfig> {
        const allNotes = this.getAllNodes().map((entry) => this.cloneNote(entry));
        const migrated = this.migrateNote(note);
        if (!migrated) {
            throw new Error('Failed to save the note.');
        }

        migrated.name = migrated.name.trim();
        migrated.category = migrated.category.trim() || 'General';
        if (!migrated.name) {
            throw new Error('A name is required.');
        }

        const existingIndex = allNotes.findIndex((entry) => entry.id === migrated.id);
        if (existingIndex >= 0) {
            const existing = allNotes[existingIndex];
            const localityChanged = existing.locality !== migrated.locality;
            const contentChanged = existing.content !== migrated.content;
            const updated: NoteConfig = {
                ...existing,
                ...migrated,
                ...mergeButtonFuItemProvenance(existing, actor),
                sortOrder: localityChanged
                    ? this.getNextSortOrder(allNotes, migrated.locality, migrated.id)
                    : existing.sortOrder,
                updatedAt: contentChanged ? Date.now() : existing.updatedAt
            };
            allNotes[existingIndex] = updated;
        } else {
            if (!migrated.id) {
                migrated.id = generateId();
            }
            if (migrated.sortOrder === undefined || migrated.sortOrder === null) {
                migrated.sortOrder = this.getNextSortOrder(allNotes, migrated.locality);
            }
            migrated.updatedAt = Date.now();
            Object.assign(migrated, getButtonFuItemProvenanceForNew(actor));
            allNotes.push(migrated);
        }

        await this.persistNotes(allNotes);
        return this.getNode(migrated.id)!;
    }

    /** Delete a note by ID. */
    async deleteNode(id: string): Promise<void> {
        const filtered = this.getAllNodes().filter((entry) => entry.id !== id);
        await this.persistNotes(filtered);
    }

    /** Move a note within its locality order. */
    async reorderNode(id: string, direction: 'up' | 'down'): Promise<void> {
        const allNotes = this.getAllNodes().map((entry) => this.cloneNote(entry));
        const note = allNotes.find((entry) => entry.id === id);
        if (!note) {
            return;
        }

        const siblings = allNotes
            .filter((entry) => entry.locality === note.locality)
            .sort((left, right) => this.compareNotes(left, right));

        siblings.forEach((entry, index) => {
            if (entry.sortOrder === undefined || entry.sortOrder === null) {
                entry.sortOrder = index * 10;
            }
        });

        const currentIndex = siblings.findIndex((entry) => entry.id === id);
        const swapIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
        if (currentIndex < 0 || swapIndex < 0 || swapIndex >= siblings.length) {
            return;
        }

        const current = siblings[currentIndex];
        const swap = siblings[swapIndex];
        const temp = current.sortOrder;
        current.sortOrder = swap.sortOrder;
        swap.sortOrder = temp;

        await this.persistNotes(allNotes);
    }

    private normalizePersistedNotes(rawNotes: readonly unknown[], locality: ButtonLocality): NoteConfig[] {
        const legacyFoldersById = new Map<string, string>();
        for (const entry of rawNotes) {
            if (!entry || typeof entry !== 'object') {
                continue;
            }

            const candidate = entry as Record<string, unknown>;
            if (candidate.kind !== 'folder') {
                continue;
            }

            const folderId = typeof candidate.id === 'string' ? candidate.id.trim() : '';
            if (!folderId) {
                continue;
            }

            const folderName = typeof candidate.name === 'string' && candidate.name.trim()
                ? candidate.name.trim()
                : 'General';
            legacyFoldersById.set(folderId, folderName);
        }

        return rawNotes
            .map((entry) => {
                if (!entry || typeof entry !== 'object') {
                    return null;
                }

                return this.migrateNote({ ...(entry as Record<string, unknown>), locality }, legacyFoldersById, true);
            })
            .filter((entry): entry is NoteConfig => !!entry)
            .sort((left, right) => this.compareNotes(left, right));
    }

    private migrateNote(
        raw: unknown,
        legacyFoldersById: ReadonlyMap<string, string> = new Map<string, string>(),
        normalizeLegacyIcon = false
    ): NoteConfig | null {
        if (!raw || typeof raw !== 'object') {
            return null;
        }

        const candidate = raw as Record<string, unknown>;
        const explicitKind = typeof candidate.kind === 'string' ? candidate.kind : undefined;
        const hasContent = Object.prototype.hasOwnProperty.call(candidate, 'content');
        if ((explicitKind && explicitKind !== 'note') || (!explicitKind && !hasContent)) {
            return null;
        }

        const icon = normalizeLegacyIcon
            ? normalizePersistedIcon(typeof candidate.icon === 'string' ? candidate.icon : undefined)
            : ((typeof candidate.icon === 'string' && candidate.icon.trim()) ? candidate.icon.trim() : getDefaultNoteIcon());
        const category = this.resolvePersistedCategory(candidate, legacyFoldersById);

        return {
            id: typeof candidate.id === 'string' && candidate.id.trim() ? candidate.id : generateId(),
            name: typeof candidate.name === 'string' ? candidate.name : '',
            locality: candidate.locality === 'Local' ? 'Local' : 'Global',
            category,
            icon,
            colour: typeof candidate.colour === 'string' ? candidate.colour : '',
            sortOrder: typeof candidate.sortOrder === 'number' ? candidate.sortOrder : undefined,
            content: typeof candidate.content === 'string' ? candidate.content : '',
            format: candidate.format === 'Markdown' ? 'Markdown' : 'PlainText',
            defaultAction: normalizeDefaultAction(candidate.defaultAction),
            promptEnabled: typeof candidate.promptEnabled === 'boolean' ? candidate.promptEnabled : false,
            copilotModel: typeof candidate.copilotModel === 'string' ? candidate.copilotModel : '',
            copilotMode: typeof candidate.copilotMode === 'string' ? candidate.copilotMode : 'agent',
            copilotAttachFiles: Array.isArray(candidate.copilotAttachFiles)
                ? candidate.copilotAttachFiles.filter((entry): entry is string => typeof entry === 'string')
                : [],
            copilotAttachActiveFile: typeof candidate.copilotAttachActiveFile === 'boolean' ? candidate.copilotAttachActiveFile : false,
            userTokens: Array.isArray(candidate.userTokens)
                ? candidate.userTokens
                    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
                    .map((entry) => ({ ...entry })) as unknown as NoteConfig['userTokens']
                : [],
            updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : Date.now(),
            createdBy: normalizeButtonFuItemActor(candidate.createdBy) ?? getButtonFuItemActorFromSource(candidate.source),
            lastModifiedBy: normalizeButtonFuItemActor(candidate.lastModifiedBy) ?? getButtonFuItemActorFromSource(candidate.source),
            source: deriveButtonFuItemSource(candidate.createdBy, candidate.lastModifiedBy, candidate.source)
        };
    }

    private resolvePersistedCategory(
        candidate: Record<string, unknown>,
        legacyFoldersById: ReadonlyMap<string, string>
    ): string {
        if (typeof candidate.category === 'string' && candidate.category.trim()) {
            return candidate.category.trim();
        }

        const parentId = typeof candidate.parentId === 'string' ? candidate.parentId.trim() : '';
        if (parentId) {
            return legacyFoldersById.get(parentId) ?? 'General';
        }

        return 'General';
    }

    private cloneNote(note: NoteConfig): NoteConfig {
        return {
            ...note,
            copilotAttachFiles: note.copilotAttachFiles.slice(),
            userTokens: (note.userTokens || []).map((token) => ({ ...token }))
        };
    }

    private compareNotes(left: NoteConfig, right: NoteConfig): number {
        const order = (left.sortOrder ?? 99999) - (right.sortOrder ?? 99999);
        if (order !== 0) {
            return order;
        }

        const categoryOrder = left.category.localeCompare(right.category);
        if (categoryOrder !== 0) {
            return categoryOrder;
        }

        return left.name.localeCompare(right.name);
    }

    private async persistNotes(notes: NoteConfig[]): Promise<void> {
        const nextGlobalNotes = notes
            .filter((entry) => entry.locality === 'Global')
            .map((entry) => this.cloneNote(entry));
        const nextLocalNotes = notes
            .filter((entry) => entry.locality === 'Local')
            .map((entry) => this.cloneNote(entry));
        const currentGlobalNotes = this.getGlobalNodes().map((entry) => this.cloneNote(entry));
        const currentLocalNotes = this.getLocalNodes().map((entry) => this.cloneNote(entry));

        const shouldUpdateGlobal = !this.areNoteListsEqual(currentGlobalNotes, nextGlobalNotes);
        const shouldUpdateLocal = !this.areNoteListsEqual(currentLocalNotes, nextLocalNotes);
        if (!shouldUpdateGlobal && !shouldUpdateLocal) {
            return;
        }

        const updates: Array<Thenable<void>> = [];
        const config = vscode.workspace.getConfiguration('buttonfu');
        this.suppressGlobalConfigRefresh = shouldUpdateGlobal;

        try {
            if (shouldUpdateGlobal) {
                updates.push(config.update('globalNotes', nextGlobalNotes, vscode.ConfigurationTarget.Global));
            }
            if (shouldUpdateLocal) {
                updates.push(this.context.workspaceState.update(LOCAL_NOTES_KEY, nextLocalNotes));
            }
            await Promise.all(updates);
        } finally {
            this.suppressGlobalConfigRefresh = false;
        }

        this._onDidChange.fire();
    }

    private areNoteListsEqual(left: NoteConfig[], right: NoteConfig[]): boolean {
        return JSON.stringify(left) === JSON.stringify(right);
    }

    private getNextSortOrder(notes: NoteConfig[], locality: ButtonLocality, excludeId?: string): number {
        const siblings = notes.filter((entry) => entry.locality === locality && entry.id !== excludeId);
        const max = siblings.reduce((current, entry) => Math.max(current, entry.sortOrder ?? 0), -1);
        return max + 10;
    }
}