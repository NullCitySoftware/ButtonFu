import * as vscode from 'vscode';
import { NoteConfig } from './types';
import { NoteStore } from './noteStore';

/** Read-only content provider used for note preview documents. */
export class NotePreviewProvider implements vscode.TextDocumentContentProvider {
    public static readonly scheme = 'buttonfu-note-preview';

    private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this._onDidChange.event;

    private readonly trackedUris = new Map<string, vscode.Uri>();
    private readonly storeChangeDisposable: vscode.Disposable;
    private readonly resolvedContent = new Map<string, string>();

    constructor(private readonly store: NoteStore) {
        this.storeChangeDisposable = store.onDidChange(() => this.refreshAll());
    }

    dispose(): void {
        this.storeChangeDisposable.dispose();
        this.trackedUris.clear();
        this._onDidChange.dispose();
    }

    /** Build a preview URI for a note. */
    getUri(note: NoteConfig): vscode.Uri {
        const safeName = (note.name || 'note').replace(/[\\/:*?"<>|]/g, '-');
        const extension = note.format === 'Markdown' ? 'md' : 'txt';
        const uri = vscode.Uri.from({
            scheme: NotePreviewProvider.scheme,
            path: `/${safeName}.${extension}`,
            query: `id=${encodeURIComponent(note.id)}`
        });
        this.trackedUris.set(note.id, uri);
        return uri;
    }

    /** Store resolved (token-substituted) content for a note so the next
     *  provideTextDocumentContent call returns it instead of the raw text. */
    setResolvedContent(noteId: string, content: string): void {
        this.resolvedContent.set(noteId, content);
    }

    /** Remove any previously stored resolved content for a note. */
    clearResolvedContent(noteId: string): void {
        this.resolvedContent.delete(noteId);
    }

    provideTextDocumentContent(uri: vscode.Uri): string {
        const noteId = new URLSearchParams(uri.query).get('id');
        if (!noteId) {
            return 'Note preview unavailable.';
        }

        const note = this.store.getNote(noteId);
        if (!note) {
            return 'This note no longer exists.';
        }

        const resolved = this.resolvedContent.get(noteId);
        if (resolved !== undefined) {
            return resolved;
        }
        return note.content;
    }

    /** Refresh all currently tracked preview URIs. */
    private refreshAll(): void {
        for (const [noteId, uri] of this.trackedUris) {
            if (this.store.getNote(noteId)) {
                this._onDidChange.fire(uri);
            } else {
                this._onDidChange.fire(uri);
                this.trackedUris.delete(noteId);
            }
        }
    }
}