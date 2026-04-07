import * as vscode from 'vscode';
import { ButtonLocality, NoteNode, getDefaultNoteIcon } from './types';
import { NoteStore } from './noteStore';

const NOTE_TREE_MIME = 'application/vnd.code.tree.buttonfu.notes';

export interface NoteScopeRoot {
    kind: 'scopeRoot';
    id: string;
    locality: ButtonLocality;
    label: string;
}

export type NoteTreeElement = NoteScopeRoot | NoteNode;

/** Tree provider and drag/drop controller for the Notes view. */
export class NoteTreeProvider implements vscode.TreeDataProvider<NoteTreeElement>, vscode.TreeDragAndDropController<NoteTreeElement> {
    public static readonly viewType = 'buttonfu.notesView';

    private readonly _onDidChangeTreeData = new vscode.EventEmitter<NoteTreeElement | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    readonly dragMimeTypes = [NOTE_TREE_MIME];
    readonly dropMimeTypes = [NOTE_TREE_MIME];

    constructor(private readonly store: NoteStore) {
        store.onDidChange(() => this.refresh());
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: NoteTreeElement): vscode.TreeItem {
        if (this.isScopeRoot(element)) {
            const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded);
            item.id = element.id;
            item.contextValue = 'noteScopeRoot';
            item.iconPath = new vscode.ThemeIcon(element.locality === 'Global' ? 'globe' : 'home');
            item.tooltip = `${element.label} notes`;
            return item;
        }

        if (element.kind === 'folder') {
            const hasChildren = this.store.getChildren(element.locality, element.id).length > 0;
            const iconColor = element.colour ? new vscode.ThemeColor(element.colour) : undefined;
            const item = new vscode.TreeItem(
                element.name || 'Untitled Folder',
                hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
            );
            item.id = element.id;
            item.contextValue = 'noteFolder';
            item.tooltip = this.buildNodeTooltip(element);
            item.iconPath = new vscode.ThemeIcon(element.icon || getDefaultNoteIcon('folder'), iconColor);
            return item;
        }

        const iconColor = element.colour ? new vscode.ThemeColor(element.colour) : undefined;
        const item = new vscode.TreeItem(element.name || 'Untitled Note', vscode.TreeItemCollapsibleState.None);
        item.id = element.id;
        item.contextValue = 'noteItem';
        item.command = {
            command: 'buttonfu.openNoteActions',
            title: 'Open Note Actions',
            arguments: [element.id]
        };
        item.description = element.promptEnabled ? 'prompt' : (element.format === 'Markdown' ? 'md' : '');
        item.tooltip = this.buildNodeTooltip(element);
        item.iconPath = new vscode.ThemeIcon(element.icon || getDefaultNoteIcon('note'), iconColor);
        return item;
    }

    getChildren(element?: NoteTreeElement): NoteTreeElement[] {
        if (!element) {
            return this.getRoots();
        }
        if (this.isScopeRoot(element)) {
            return this.store.getChildren(element.locality, null);
        }
        if (element.kind === 'folder') {
            return this.store.getChildren(element.locality, element.id);
        }
        return [];
    }

    getParent(element: NoteTreeElement): NoteTreeElement | undefined {
        if (this.isScopeRoot(element)) {
            return undefined;
        }
        if (!element.parentId) {
            return this.getRootForLocality(element.locality);
        }
        return this.store.getFolder(element.parentId);
    }

    async handleDrag(source: readonly NoteTreeElement[], dataTransfer: vscode.DataTransfer): Promise<void> {
        const draggedIds = source
            .filter((entry): entry is NoteNode => !this.isScopeRoot(entry))
            .map((entry) => entry.id);
        if (draggedIds.length === 0) {
            return;
        }

        dataTransfer.set(NOTE_TREE_MIME, new vscode.DataTransferItem(JSON.stringify(draggedIds)));
    }

    async handleDrop(target: NoteTreeElement | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
        const transferItem = dataTransfer.get(NOTE_TREE_MIME);
        if (!transferItem) {
            return;
        }

        const raw = await transferItem.asString();
        let ids: string[];
        try {
            ids = JSON.parse(raw) as string[];
        } catch {
            return;
        }
        if (!Array.isArray(ids) || ids.length === 0) {
            return;
        }

        if (!target) {
            return;
        }

        if (this.isScopeRoot(target)) {
            let failures = 0;
            for (const id of ids) {
                const moved = await this.store.moveNode(id, target.locality, null);
                if (!moved) { failures++; }
            }
            if (failures > 0) {
                vscode.window.showWarningMessage(`Could not move ${failures} of ${ids.length} item(s) to the selected scope root.`);
            }
            return;
        }

        if (target.kind !== 'folder') {
            vscode.window.showWarningMessage('Notes can only be dropped onto folders or scope roots.');
            return;
        }

        let failures = 0;
        for (const id of ids) {
            const moved = await this.store.moveNode(id, target.locality, target.id);
            if (!moved) { failures++; }
        }
        if (failures > 0) {
            vscode.window.showWarningMessage(`Could not move ${failures} of ${ids.length} item(s) into the selected folder.`);
        }
    }

    private getRoots(): NoteScopeRoot[] {
        const roots: NoteScopeRoot[] = [this.getRootForLocality('Global')];
        const hasWorkspace = !!(vscode.workspace.workspaceFolders?.length || vscode.workspace.name);
        const hasLocalNotes = this.store.getLocalNodes().length > 0;
        if (hasWorkspace || hasLocalNotes) {
            roots.push(this.getRootForLocality('Local'));
        }
        return roots;
    }

    private getRootForLocality(locality: ButtonLocality): NoteScopeRoot {
        const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name ?? vscode.workspace.name ?? null;
        return {
            kind: 'scopeRoot',
            id: locality === 'Global' ? 'buttonfu.notes.root.global' : 'buttonfu.notes.root.local',
            locality,
            label: locality === 'Global'
                ? 'Global'
                : (workspaceName ? `Workspace [${workspaceName}]` : 'Workspace')
        };
    }

    private buildNodeTooltip(node: NoteNode): string {
        if (node.kind === 'folder') {
            const folderPath = this.store.getFolderPath(node.id);
            return folderPath ? `${folderPath}/${node.name}` : node.name;
        }
        const path = this.store.getFolderPath(node.id);
        const preview = node.content.split(/\r?\n/).slice(0, 6).join('\n');
        return `${path ? `${path}/` : ''}${node.name}\n\n${preview}`;
    }

    private isScopeRoot(element: NoteTreeElement): element is NoteScopeRoot {
        return (element as NoteScopeRoot).kind === 'scopeRoot';
    }
}