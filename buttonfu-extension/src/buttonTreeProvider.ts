import * as vscode from 'vscode';
import { ButtonConfig } from './types';
import { ButtonStore } from './buttonStore';

/**
 * Tree data provider for the sidebar button list.
 * Groups buttons by category, showing both global and local buttons.
 */
export class ButtonTreeProvider implements vscode.TreeDataProvider<ButtonTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ButtonTreeItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    private readonly storeChangeDisposable: vscode.Disposable;

    constructor(private readonly store: ButtonStore) {
        this.storeChangeDisposable = store.onDidChange(() => this.refresh());
    }

    dispose(): void {
        this.storeChangeDisposable.dispose();
        this._onDidChangeTreeData.dispose();
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: ButtonTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: ButtonTreeItem): ButtonTreeItem[] {
        if (!element) {
            return this.getRootItems();
        }
        if (element.contextValue === 'category') {
            return element.children || [];
        }
        return [];
    }

    private getRootItems(): ButtonTreeItem[] {
        const allButtons = this.store.getAllButtons();
        if (allButtons.length === 0) {
            return [new ButtonTreeItem(
                'No buttons configured',
                'Click the gear icon to add buttons',
                vscode.TreeItemCollapsibleState.None,
                'empty',
                undefined,
                new vscode.ThemeIcon('info')
            )];
        }

        // Group by category
        const categories = new Map<string, ButtonConfig[]>();
        for (const btn of allButtons) {
            const cat = btn.category || 'Uncategorised';
            if (!categories.has(cat)) {
                categories.set(cat, []);
            }
            categories.get(cat)!.push(btn);
        }

        // Sort categories alphabetically
        const sortedCats = Array.from(categories.keys()).sort();
        
        // If only one category, show buttons flat (no grouping)
        if (sortedCats.length === 1) {
            return this.createButtonItems(categories.get(sortedCats[0])!);
        }

        // Multiple categories - show as collapsible groups
        return sortedCats.map(catName => {
            const buttons = categories.get(catName)!;
            const children = this.createButtonItems(buttons);
            const catItem = new ButtonTreeItem(
                catName,
                `${buttons.length} button${buttons.length !== 1 ? 's' : ''}`,
                vscode.TreeItemCollapsibleState.Expanded,
                'category',
                undefined,
                new vscode.ThemeIcon('folder')
            );
            catItem.children = children;
            return catItem;
        });
    }

    private createButtonItems(buttons: ButtonConfig[]): ButtonTreeItem[] {
        return buttons.map(btn => {
            const typeLabel = this.getTypeShortLabel(btn.type);
            const tooltip = `${btn.description || btn.name}\n${typeLabel} · ${btn.locality}`;
            
            const iconId = btn.icon || 'play';
            let iconColour: vscode.ThemeColor | undefined;
            if (btn.colour && !btn.colour.startsWith('#')) {
                // ThemeColor accepts theme token identifiers only; hex colours are silently ignored.
                iconColour = new vscode.ThemeColor(btn.colour);
            }

            const item = new ButtonTreeItem(
                `${btn.name}`,
                tooltip,
                vscode.TreeItemCollapsibleState.None,
                'button',
                btn.id,
                new vscode.ThemeIcon(iconId, iconColour)
            );

            // Clicking the button should execute it
            item.command = {
                command: 'buttonfu.executeButton',
                title: 'Execute',
                arguments: [btn.id]
            };

            // Show locality badge in description
            item.description = btn.locality === 'Local' ? '(workspace)' : '';

            return item;
        });
    }

    private getTypeShortLabel(type: string): string {
        switch (type) {
            case 'TerminalCommand': return 'Terminal';
            case 'PowerShellCommand': return 'Terminal';
            case 'PaletteAction': return 'Command';
            case 'TaskExecution': return 'Task';
            case 'CopilotCommand': return 'Copilot';
            default: return type;
        }
    }
}

export class ButtonTreeItem extends vscode.TreeItem {
    public children?: ButtonTreeItem[];

    constructor(
        label: string,
        tooltipText: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
        public override readonly contextValue: string,
        public readonly buttonId?: string,
        icon?: vscode.ThemeIcon
    ) {
        super(label, collapsibleState);
        this.tooltip = tooltipText;
        if (icon) {
            this.iconPath = icon;
        }
    }
}
