import * as vscode from 'vscode';
import {
    ButtonLocality,
    DEFAULT_NOTE_FOLDER_ICON,
    DEFAULT_NOTE_ICON,
    LEGACY_DEFAULT_NOTE_ICON,
    NoteConfig,
    NoteFolder,
    NoteNode,
    generateId,
    getDefaultNoteIcon
} from './types';

const LOCAL_NOTES_KEY = 'buttonfu.localNotes';

function normalizePersistedIcon(kind: 'folder' | 'note', icon: string | undefined): string {
    const value = icon?.trim();
    if (!value) {
        return getDefaultNoteIcon(kind);
    }

    if (kind === 'folder' && value === LEGACY_DEFAULT_NOTE_ICON) {
        return DEFAULT_NOTE_FOLDER_ICON;
    }

    if (kind === 'note' && value === DEFAULT_NOTE_FOLDER_ICON) {
        return DEFAULT_NOTE_ICON;
    }

    return value;
}

/** Manages persistence and hierarchy operations for note folders and notes. */
export class NoteStore {
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    public readonly onDidChange = this._onDidChange.event;
    private suppressGlobalConfigRefresh = false;

    constructor(private readonly context: vscode.ExtensionContext) {
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (this.suppressGlobalConfigRefresh) {
                return;
            }
            if (e.affectsConfiguration('buttonfu.globalNotes')) {
                this._onDidChange.fire();
            }
        });
    }

    /** Get all global notes and folders from user settings. */
    getGlobalNodes(): NoteNode[] {
        const config = vscode.workspace.getConfiguration('buttonfu');
        const raw = config.get<NoteNode[]>('globalNotes') || [];
        return raw.map((node) => this.migrateNode({ ...node, locality: 'Global' }, true));
    }

    /** Get all workspace notes and folders from workspace state. */
    getLocalNodes(): NoteNode[] {
        const raw = this.context.workspaceState.get<NoteNode[]>(LOCAL_NOTES_KEY) || [];
        return raw.map((node) => this.migrateNode({ ...node, locality: 'Local' }, true));
    }

    /** Get all note nodes across both scopes. */
    getAllNodes(): NoteNode[] {
        return [...this.getGlobalNodes(), ...this.getLocalNodes()];
    }

    /** Get a node by ID. */
    getNode(id: string): NoteNode | undefined {
        return this.getAllNodes().find((node) => node.id === id);
    }

    /** Get a note item by ID. */
    getNote(id: string): NoteConfig | undefined {
        const node = this.getNode(id);
        return node?.kind === 'note' ? node : undefined;
    }

    /** Get a folder by ID. */
    getFolder(id: string): NoteFolder | undefined {
        const node = this.getNode(id);
        return node?.kind === 'folder' ? node : undefined;
    }

    /** Get the immediate children for a scope root or folder. */
    getChildren(locality: ButtonLocality, parentId: string | null): NoteNode[] {
        return this.getAllNodes()
            .filter((node) => node.locality === locality && (node.parentId ?? null) === parentId)
            .sort((left, right) => this.compareNodes(left, right));
    }

    /** Get all folders in a given scope. */
    getFolders(locality: ButtonLocality): NoteFolder[] {
        return this.getAllNodes()
            .filter((node): node is NoteFolder => node.locality === locality && node.kind === 'folder')
            .sort((left, right) => this.compareNodes(left, right));
    }

    /** Get all descendant IDs for a folder node. */
    getDescendantIds(id: string): string[] {
        const allNodes = this.getAllNodes();
        return this.collectSubtreeIds(id, allNodes);
    }

    /** Get the slash-separated folder path for a node within its scope. */
    getFolderPath(nodeId: string): string {
        const allNodes = this.getAllNodes();
        const node = allNodes.find((entry) => entry.id === nodeId);
        if (!node) { return ''; }

        const parts: string[] = [];
        let parentId = node.parentId;
        while (parentId) {
            const parent = allNodes.find((entry) => entry.id === parentId && entry.kind === 'folder') as NoteFolder | undefined;
            if (!parent) {
                break;
            }
            parts.unshift(parent.name);
            parentId = parent.parentId;
        }
        return parts.join('/');
    }

    /** Save or update a note node. */
    async saveNode(node: NoteNode): Promise<NoteNode> {
        const allNodes = this.getAllNodes().map((entry) => this.cloneNode(entry));
        const migrated = this.migrateNode(this.cloneNode(node));
        migrated.name = migrated.name.trim();
        if (!migrated.name) {
            throw new Error('A name is required.');
        }
        const existingIndex = allNodes.findIndex((entry) => entry.id === migrated.id);

        if (existingIndex >= 0) {
            const existing = allNodes[existingIndex];
            const movedScope = existing.locality !== migrated.locality;
            const movedParent = (existing.parentId ?? null) !== (migrated.parentId ?? null);
            const contentChanged = existing.kind === 'note'
                && migrated.kind === 'note'
                && existing.content !== migrated.content;

            if (existing.kind === 'folder' && movedScope) {
                const subtreeIds = new Set(this.collectSubtreeIds(existing.id, allNodes));
                for (const entry of allNodes) {
                    if (subtreeIds.has(entry.id)) {
                        entry.locality = migrated.locality;
                    }
                }
            }

            const updatedNode = this.migrateNode({
                ...existing,
                ...migrated,
                sortOrder: existing.sortOrder,
                updatedAt: migrated.kind === 'note'
                    ? (contentChanged ? Date.now() : (existing.kind === 'note' ? existing.updatedAt : Date.now()))
                    : undefined
            } as NoteNode);

            if (!this.isValidParent(updatedNode, allNodes, updatedNode.parentId)) {
                updatedNode.parentId = null;
            }
            if (movedScope || movedParent || updatedNode.sortOrder === undefined || updatedNode.sortOrder === null) {
                updatedNode.sortOrder = this.getNextSortOrder(allNodes, updatedNode.locality, updatedNode.parentId, updatedNode.id);
            }

            allNodes[existingIndex] = updatedNode;
        } else {
            if (!migrated.id) {
                migrated.id = generateId();
            }
            if (!this.isValidParent(migrated, allNodes, migrated.parentId)) {
                migrated.parentId = null;
            }
            if (migrated.sortOrder === undefined || migrated.sortOrder === null) {
                migrated.sortOrder = this.getNextSortOrder(allNodes, migrated.locality, migrated.parentId);
            }
            if (migrated.kind === 'note') {
                migrated.updatedAt = Date.now();
            }
            allNodes.push(migrated);
        }

        await this.persistNodes(allNodes);
        return this.getNode(migrated.id)!;
    }

    /** Delete a note node. Folders delete their full subtree. */
    async deleteNode(id: string): Promise<void> {
        const allNodes = this.getAllNodes().map((entry) => this.cloneNode(entry));
        const subtreeIds = new Set(this.collectSubtreeIds(id, allNodes));
        if (subtreeIds.size === 0) {
            return;
        }

        const filtered = allNodes.filter((entry) => !subtreeIds.has(entry.id));
        await this.persistNodes(filtered);
    }

    /** Move a node to a new parent, optionally changing scope at the same time. */
    async moveNode(id: string, locality: ButtonLocality, parentId: string | null): Promise<boolean> {
        const node = this.getNode(id);
        if (!node) {
            return false;
        }

        const allNodes = this.getAllNodes();
        const updatedNode = this.cloneNode(node);
        updatedNode.locality = locality;
        updatedNode.parentId = parentId;
        if (!this.isValidParent(updatedNode, allNodes, parentId)) {
            return false;
        }

        updatedNode.sortOrder = this.getNextSortOrder(allNodes, locality, parentId, id);
        await this.saveNode(updatedNode);
        return true;
    }

    /** Move a node within its siblings. */
    async reorderNode(id: string, direction: 'up' | 'down'): Promise<void> {
        const allNodes = this.getAllNodes().map((entry) => this.cloneNode(entry));
        const node = allNodes.find((entry) => entry.id === id);
        if (!node) {
            return;
        }

        const siblings = allNodes
            .filter((entry) => entry.locality === node.locality && (entry.parentId ?? null) === (node.parentId ?? null))
            .sort((left, right) => this.compareNodes(left, right));

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

        await this.persistNodes(allNodes);
    }

    /** Normalize stored node data into the current schema. */
    private migrateNode(node: NoteNode, normalizeLegacyIcon = false): NoteNode {
        const kind = node.kind === 'folder' || node.kind === 'note'
            ? node.kind
            : (Object.prototype.hasOwnProperty.call(node as object, 'content') ? 'note' : 'folder');

        if (kind === 'folder') {
            const icon = normalizeLegacyIcon
                ? normalizePersistedIcon('folder', node.icon)
                : (node.icon?.trim() || DEFAULT_NOTE_FOLDER_ICON);
            return {
                id: node.id || generateId(),
                name: node.name || '',
                locality: node.locality === 'Local' ? 'Local' : 'Global',
                parentId: node.parentId ?? null,
                kind: 'folder',
                icon,
                colour: node.colour || '',
                sortOrder: node.sortOrder
            };
        }

        const raw = node as NoteConfig;
        const icon = normalizeLegacyIcon
            ? normalizePersistedIcon('note', raw.icon)
            : (raw.icon?.trim() || DEFAULT_NOTE_ICON);
        return {
            id: raw.id || generateId(),
            name: raw.name || '',
            locality: raw.locality === 'Local' ? 'Local' : 'Global',
            parentId: raw.parentId ?? null,
            kind: 'note',
            icon,
            colour: raw.colour || '',
            sortOrder: raw.sortOrder,
            content: raw.content || '',
            format: raw.format === 'Markdown' ? 'Markdown' : 'PlainText',
            promptEnabled: raw.promptEnabled ?? false,
            copilotModel: raw.copilotModel || '',
            copilotMode: raw.copilotMode || 'agent',
            copilotAttachFiles: Array.isArray(raw.copilotAttachFiles) ? raw.copilotAttachFiles.slice() : [],
            copilotAttachActiveFile: raw.copilotAttachActiveFile ?? false,
            userTokens: Array.isArray(raw.userTokens) ? raw.userTokens.map((token) => ({ ...token })) : [],
            updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now()
        };
    }

    /** Clone a node so edits do not mutate cached objects. */
    private cloneNode(node: NoteNode): NoteNode {
        const migrated = this.migrateNode(node);
        if (migrated.kind === 'folder') {
            return { ...migrated };
        }
        return {
            ...migrated,
            copilotAttachFiles: migrated.copilotAttachFiles.slice(),
            userTokens: (migrated.userTokens || []).map((token) => ({ ...token }))
        };
    }

    /** Compare nodes for display and sibling ordering. */
    private compareNodes(left: NoteNode, right: NoteNode): number {
        const order = (left.sortOrder ?? 99999) - (right.sortOrder ?? 99999);
        if (order !== 0) {
            return order;
        }
        if (left.kind !== right.kind) {
            return left.kind === 'folder' ? -1 : 1;
        }
        return left.name.localeCompare(right.name);
    }

    /** Persist both scopes and notify listeners once. */
    private async persistNodes(nodes: NoteNode[]): Promise<void> {
        const globalNodes = nodes.filter((entry) => entry.locality === 'Global').map((entry) => this.cloneNode(entry));
        const localNodes = nodes.filter((entry) => entry.locality === 'Local').map((entry) => this.cloneNode(entry));
        const currentGlobalNodes = this.getGlobalNodes().map((entry) => this.cloneNode(entry));
        const currentLocalNodes = this.getLocalNodes().map((entry) => this.cloneNode(entry));

        const config = vscode.workspace.getConfiguration('buttonfu');
        const updates: Array<Thenable<void>> = [];
        const shouldUpdateGlobal = !this.areNodeListsEqual(currentGlobalNodes, globalNodes);
        const shouldUpdateLocal = !this.areNodeListsEqual(currentLocalNodes, localNodes);

        if (!shouldUpdateGlobal && !shouldUpdateLocal) {
            return;
        }

        this.suppressGlobalConfigRefresh = shouldUpdateGlobal;

        try {
            if (shouldUpdateGlobal) {
                updates.push(config.update('globalNotes', globalNodes, vscode.ConfigurationTarget.Global));
            }
            if (shouldUpdateLocal) {
                updates.push(this.context.workspaceState.update(LOCAL_NOTES_KEY, localNodes));
            }
            await Promise.all(updates);
        } finally {
            this.suppressGlobalConfigRefresh = false;
        }
        this._onDidChange.fire();
    }

    /** Compare two node arrays without triggering needless persistence churn. */
    private areNodeListsEqual(left: NoteNode[], right: NoteNode[]): boolean {
        return JSON.stringify(left) === JSON.stringify(right);
    }

    /** Validate a parent relationship for a node. */
    private isValidParent(node: NoteNode, allNodes: NoteNode[], parentId: string | null): boolean {
        if (!parentId) {
            return true;
        }

        const parent = allNodes.find((entry) => entry.id === parentId);
        if (!parent || parent.kind !== 'folder') {
            return false;
        }
        if (parent.locality !== node.locality) {
            return false;
        }
        if (parent.id === node.id) {
            return false;
        }
        if (node.kind === 'folder') {
            const descendants = new Set(this.collectSubtreeIds(node.id, allNodes));
            if (descendants.has(parentId)) {
                return false;
            }
        }
        return true;
    }

    /** Compute the next sort order for a sibling set. */
    private getNextSortOrder(nodes: NoteNode[], locality: ButtonLocality, parentId: string | null, excludeId?: string): number {
        const siblings = nodes.filter((entry) =>
            entry.locality === locality &&
            (entry.parentId ?? null) === parentId &&
            entry.id !== excludeId
        );
        const max = siblings.reduce((current, entry) => Math.max(current, entry.sortOrder ?? 0), -1);
        return max + 10;
    }

    /** Collect a folder subtree or single note ID. */
    private collectSubtreeIds(id: string, allNodes: NoteNode[]): string[] {
        const root = allNodes.find((entry) => entry.id === id);
        if (!root) {
            return [];
        }

        const result: string[] = [];
        const queue: string[] = [id];
        while (queue.length > 0) {
            const currentId = queue.shift();
            if (!currentId || result.includes(currentId)) {
                continue;
            }

            result.push(currentId);
            for (const child of allNodes) {
                if ((child.parentId ?? null) === currentId) {
                    queue.push(child.id);
                }
            }
        }
        return result;
    }
}