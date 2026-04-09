import * as vscode from 'vscode';
import { NoteConfig } from './types';
import { NoteStore } from './noteStore';

/** Read-only content provider used for note preview documents. */
export class NotePreviewProvider implements vscode.TextDocumentContentProvider {
    public static readonly scheme = 'buttonfu-note-preview';

    private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this._onDidChange.event;

    private readonly trackedUris = new Map<string, vscode.Uri>();

    constructor(private readonly store: NoteStore) {
        store.onDidChange(() => this.refreshAll());
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

    provideTextDocumentContent(uri: vscode.Uri): string {
        const noteId = new URLSearchParams(uri.query).get('id');
        if (!noteId) {
            return 'Note preview unavailable.';
        }

        const note = this.store.getNote(noteId);
        if (!note) {
            return 'This note no longer exists.';
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