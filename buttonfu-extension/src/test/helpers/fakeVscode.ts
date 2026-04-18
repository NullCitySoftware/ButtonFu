import Module from 'node:module';
import path from 'node:path';

const runtimeRequire = Module.createRequire(__filename);

type Listener<T> = (event: T) => void;
type CommandHandler = (...args: any[]) => unknown;

class FakeDisposable {
    constructor(private readonly onDispose: () => void = () => {}) {}

    dispose(): void {
        this.onDispose();
    }

    static from(...items: Array<{ dispose(): void }>): FakeDisposable {
        return new FakeDisposable(() => {
            for (const item of items) {
                item.dispose();
            }
        });
    }
}

class FakeEventEmitter<T> {
    private readonly listeners = new Set<Listener<T>>();

    readonly event = (listener: Listener<T>, thisArgs?: unknown, disposables?: Array<{ dispose(): void }>): FakeDisposable => {
        const wrapped = thisArgs ? listener.bind(thisArgs) : listener;
        this.listeners.add(wrapped);
        const disposable = new FakeDisposable(() => {
            this.listeners.delete(wrapped);
        });
        if (disposables) {
            disposables.push(disposable);
        }
        return disposable;
    };

    fire(event: T): void {
        for (const listener of [...this.listeners]) {
            listener(event);
        }
    }

    dispose(): void {
        this.listeners.clear();
    }
}

class FakeMemento {
    private readonly values = new Map<string, unknown>();

    get<T>(key: string, defaultValue?: T): T {
        return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
    }

    async update(key: string, value: unknown): Promise<void> {
        this.values.set(key, value);
    }
}

function createUri(fsPath: string): { fsPath: string; path: string; scheme: string; toString(): string } {
    const normalized = path.resolve(fsPath);
    return {
        fsPath: normalized,
        path: normalized.replace(/\\/g, '/'),
        scheme: 'file',
        toString: () => normalized
    };
}

function createPosition(line = 0, character = 0): { line: number; character: number } {
    return { line, character };
}

function createSelection(line = 0, character = 0): {
    start: { line: number; character: number };
    end: { line: number; character: number };
    anchor: { line: number; character: number };
    active: { line: number; character: number };
} {
    const position = createPosition(line, character);
    return {
        start: position,
        end: position,
        anchor: position,
        active: position
    };
}

function createFakeTextEditor(workspaceRoot: { fsPath: string }, options?: {
    selectionCount?: number;
    selectedText?: string;
    lineText?: string;
    filePath?: string;
    documentText?: string;
}): any {
    const selectionCount = options?.selectionCount ?? 1;
    const selections = Array.from({ length: selectionCount }, (_, index) => createSelection(index, 0));
    const selectedText = options?.selectedText ?? '';
    const documentText = options?.documentText ?? selectedText;
    const lineText = options?.lineText ?? 'Active line';
    const filePath = options?.filePath ?? path.join(workspaceRoot.fsPath, 'active.txt');
    const uri = createUri(filePath);
    const editOperations: Array<{ selection: unknown; text: string }> = [];

    return {
        document: {
            uri,
            getText: (selection?: unknown) => selection ? selectedText : documentText,
            lineAt: () => ({ text: lineText })
        },
        selection: selections[0],
        selections,
        editOperations,
        async edit(callback: (editBuilder: { replace(selection: unknown, text: string): void }) => void): Promise<boolean> {
            callback({
                replace(selection: unknown, text: string): void {
                    editOperations.push({ selection, text });
                }
            });
            return true;
        }
    };
}

export interface FakeVscodeHarness {
    readonly vscode: any;
    readonly registeredCommands: Map<string, (...args: any[]) => unknown>;
    readonly registeredTreeViews: Map<string, unknown>;
    readonly registeredWebviewProviders: Map<string, unknown>;
    readonly registeredContentProviders: Map<string, unknown>;
    readonly webviewPanels: FakeWebviewPanelHarness[];
    readonly configurationUpdates: Array<{ key: string; value: unknown }>;
    readonly executedCommands: Array<{ command: string; args: any[] }>;
    readonly openedTextDocuments: unknown[];
    readonly shownTextDocuments: Array<{ document: unknown; options: unknown }>;
    readonly clipboardWrites: string[];
    readonly informationMessages: string[];
    readonly statusBarMessages: Array<{ text: string; timeout?: number }>;
    readonly warningMessages: string[];
    readonly errorMessages: string[];
    readonly executedTasks: unknown[];
    readonly quickPickCalls: Array<{ items: unknown[]; options: unknown }>;
    queueQuickPickResult(result: unknown): void;
    queueWarningMessageResult(result: unknown): void;
    setExternalCommandHandler(command: string, handler: CommandHandler): void;
    setClipboardText(text: string): void;
    setTasks(tasks: unknown[]): void;
    setWorkspaceFolders(folders: Array<{ name: string; fsPath: string }>, options?: { name?: string; fireEvent?: boolean }): void;
    setWorkspaceTrust(isTrusted: boolean): void;
    setExtensionMode(mode: number): void;
    setActiveTextEditor(options?: {
        selectionCount?: number;
        selectedText?: string;
        lineText?: string;
        filePath?: string;
        documentText?: string;
    }): any;
    clearActiveTextEditor(): void;
    createExtensionContext(): any;
}

export interface FakeWebviewPanelHarness {
    readonly panel: any;
    readonly postedMessages: unknown[];
    readonly revealCount: number;
    sendMessage(message: unknown): Promise<void>;
    setVisible(visible: boolean): void;
    dispose(): void;
}

export interface LoadOverrides {
    [request: string]: unknown;
}

export function createFakeVscodeHarness(): FakeVscodeHarness {
    const registeredCommands = new Map<string, (...args: any[]) => unknown>();
    const registeredTreeViews = new Map<string, unknown>();
    const registeredWebviewProviders = new Map<string, unknown>();
    const registeredContentProviders = new Map<string, unknown>();
    const webviewPanels: FakeWebviewPanelHarness[] = [];
    const externalCommandHandlers = new Map<string, CommandHandler>();
    const configurationUpdates: Array<{ key: string; value: unknown }> = [];
    const executedCommands: Array<{ command: string; args: any[] }> = [];
    const openedTextDocuments: unknown[] = [];
    const shownTextDocuments: Array<{ document: unknown; options: unknown }> = [];
    const clipboardWrites: string[] = [];
    const informationMessages: string[] = [];
    const statusBarMessages: Array<{ text: string; timeout?: number }> = [];
    const warningMessages: string[] = [];
    const errorMessages: string[] = [];
    const executedTasks: unknown[] = [];
    const quickPickCalls: Array<{ items: unknown[]; options: unknown }> = [];
    const quickPickQueue: unknown[] = [];
    const warningMessageQueue: unknown[] = [];

    const configurationValues = new Map<string, unknown>([
        ['buttonfu.globalButtons', []],
        ['buttonfu.globalNotes', []]
    ]);

    const configurationEmitter = new FakeEventEmitter<{ affectsConfiguration(section: string): boolean }>();
    const workspaceFoldersEmitter = new FakeEventEmitter<void>();

    const defaultWorkspaceRoot = createUri(path.resolve(process.cwd(), 'test-workspace'));
    let currentWorkspaceFolders = [{ name: 'TestWorkspace', uri: defaultWorkspaceRoot }];
    let currentWorkspaceName = 'TestWorkspace';
    let currentWorkspaceTrusted = true;
    let currentExtensionMode = 2;
    let clipboardText = '';
    let availableTasks: unknown[] = [];

    const vscode = {
        EventEmitter: FakeEventEmitter,
        Disposable: FakeDisposable,
        ExtensionMode: {
            Production: 1,
            Development: 2,
            Test: 3
        },
        ConfigurationTarget: {
            Global: 'Global'
        },
        TreeItemCollapsibleState: {
            None: 0,
            Collapsed: 1,
            Expanded: 2
        },
        ViewColumn: {
            One: 1,
            Beside: 2
        },
        ThemeIcon: class ThemeIcon {
            constructor(public readonly id: string) {}
        },
        TreeItem: class TreeItem {
            label: string;
            collapsibleState: number;

            constructor(label: string, collapsibleState = 0) {
                this.label = label;
                this.collapsibleState = collapsibleState;
            }
        },
        DataTransferItem: class DataTransferItem {
            constructor(private readonly value: string) {}

            async asString(): Promise<string> {
                return this.value;
            }
        },
        Uri: {
            file: (fsPath: string) => createUri(fsPath),
            joinPath: (base: { fsPath: string }, ...segments: string[]) => createUri(path.join(base.fsPath, ...segments)),
            from: (parts: { scheme?: string; path?: string; query?: string }) => ({
                fsPath: parts.path ?? '',
                path: parts.path ?? '',
                query: parts.query ?? '',
                scheme: parts.scheme ?? 'file',
                toString: () => `${parts.scheme ?? 'file'}:${parts.path ?? ''}${parts.query ? `?${parts.query}` : ''}`
            })
        },
        commands: {
            registerCommand: (command: string, callback: (...args: any[]) => unknown) => {
                registeredCommands.set(command, callback);
                return new FakeDisposable(() => {
                    registeredCommands.delete(command);
                });
            },
            executeCommand: async (command: string, ...args: any[]) => {
                executedCommands.push({ command, args });
                const handler = registeredCommands.get(command);
                if (handler) {
                    return handler(...args);
                }
                const externalHandler = externalCommandHandlers.get(command);
                if (externalHandler) {
                    return externalHandler(...args);
                }
                return undefined;
            },
            getCommands: async () => [...new Set([...registeredCommands.keys(), ...externalCommandHandlers.keys()])]
        },
        env: {
            clipboard: {
                async readText(): Promise<string> {
                    return clipboardText;
                },
                async writeText(value: string): Promise<void> {
                    clipboardText = value;
                    clipboardWrites.push(value);
                }
            }
        },
        tasks: {
            fetchTasks: async () => availableTasks,
            executeTask: async (task: unknown) => {
                executedTasks.push(task);
                return { task };
            }
        },
        workspace: {
            get workspaceFolders() {
                return currentWorkspaceFolders;
            },
            get name() {
                return currentWorkspaceName;
            },
            get isTrusted() {
                return currentWorkspaceTrusted;
            },
            getConfiguration: (section?: string) => ({
                get: <T>(key: string, defaultValue?: T): T => {
                    const fullKey = section ? `${section}.${key}` : key;
                    return (configurationValues.has(fullKey) ? configurationValues.get(fullKey) : defaultValue) as T;
                },
                update: async (key: string, value: unknown): Promise<void> => {
                    const fullKey = section ? `${section}.${key}` : key;
                    configurationValues.set(fullKey, value);
                    configurationUpdates.push({ key: fullKey, value });
                    configurationEmitter.fire({
                        affectsConfiguration: (target: string) => target === fullKey
                    });
                }
            }),
            onDidChangeConfiguration: configurationEmitter.event,
            onDidChangeWorkspaceFolders: workspaceFoldersEmitter.event,
            registerTextDocumentContentProvider: (scheme: string, provider: unknown) => {
                registeredContentProviders.set(scheme, provider);
                return new FakeDisposable(() => {
                    registeredContentProviders.delete(scheme);
                });
            },
            asRelativePath: (uri: { fsPath: string }) => {
                for (const folder of currentWorkspaceFolders) {
                    const relative = path.relative(folder.uri.fsPath, uri.fsPath);
                    if (relative && !relative.startsWith('..')) {
                        return relative;
                    }
                    if (relative === '') {
                        return path.basename(uri.fsPath);
                    }
                }
                return uri.fsPath;
            },
            openTextDocument: async (uri: unknown) => {
                openedTextDocuments.push(uri);
                return { uri };
            }
        },
        window: {
            activeTextEditor: undefined,
            registerWebviewViewProvider: (viewType: string, provider: unknown) => {
                registeredWebviewProviders.set(viewType, provider);
                return new FakeDisposable(() => {
                    registeredWebviewProviders.delete(viewType);
                });
            },
            createTreeView: (viewType: string, options: unknown) => {
                registeredTreeViews.set(viewType, options);
                return new FakeDisposable(() => {
                    registeredTreeViews.delete(viewType);
                });
            },
            createWebviewPanel: () => {
                const messageListeners = new Set<(message: unknown) => unknown>();
                const disposeListeners = new Set<() => void>();
                const viewStateListeners = new Set<(event: { webviewPanel: any }) => void>();
                const postedMessages: unknown[] = [];
                let revealCount = 0;
                let disposed = false;

                const panel = {
                    webview: {
                        html: '',
                        options: {},
                        postMessage: async (message: unknown) => {
                            postedMessages.push(message);
                            return true;
                        },
                        onDidReceiveMessage: (listener: (message: unknown) => unknown, thisArgs?: unknown, disposables?: Array<{ dispose(): void }>) => {
                            const wrapped = thisArgs ? listener.bind(thisArgs) : listener;
                            messageListeners.add(wrapped);
                            const disposable = new FakeDisposable(() => {
                                messageListeners.delete(wrapped);
                            });
                            if (disposables) {
                                disposables.push(disposable);
                            }
                            return disposable;
                        },
                        asWebviewUri: (uri: unknown) => uri
                    },
                    visible: true,
                    onDidDispose: (listener: () => void, thisArgs?: unknown, disposables?: Array<{ dispose(): void }>) => {
                        const wrapped = thisArgs ? listener.bind(thisArgs) : listener;
                        disposeListeners.add(wrapped);
                        const disposable = new FakeDisposable(() => {
                            disposeListeners.delete(wrapped);
                        });
                        if (disposables) {
                            disposables.push(disposable);
                        }
                        return disposable;
                    },
                    onDidChangeViewState: (listener: (event: { webviewPanel: any }) => void, thisArgs?: unknown, disposables?: Array<{ dispose(): void }>) => {
                        const wrapped = thisArgs ? listener.bind(thisArgs) : listener;
                        viewStateListeners.add(wrapped);
                        const disposable = new FakeDisposable(() => {
                            viewStateListeners.delete(wrapped);
                        });
                        if (disposables) {
                            disposables.push(disposable);
                        }
                        return disposable;
                    },
                    reveal: () => {
                        revealCount += 1;
                        panel.visible = true;
                    },
                    dispose: () => {
                        if (disposed) {
                            return;
                        }
                        disposed = true;
                        panel.visible = false;
                        for (const listener of [...disposeListeners]) {
                            listener();
                        }
                    }
                };

                const harnessPanel: FakeWebviewPanelHarness = {
                    panel,
                    postedMessages,
                    get revealCount() {
                        return revealCount;
                    },
                    async sendMessage(message: unknown): Promise<void> {
                        for (const listener of [...messageListeners]) {
                            await listener(message);
                        }
                    },
                    setVisible(visible: boolean): void {
                        panel.visible = visible;
                        for (const listener of [...viewStateListeners]) {
                            listener({ webviewPanel: panel });
                        }
                    },
                    dispose(): void {
                        panel.dispose();
                    }
                };

                webviewPanels.push(harnessPanel);
                return panel;
            },
            showWarningMessage: async (message: string) => {
                warningMessages.push(message);
                return warningMessageQueue.shift();
            },
            showInformationMessage: async (message: string) => {
                informationMessages.push(message);
                return undefined;
            },
            showErrorMessage: async (message: string) => {
                errorMessages.push(message);
                return undefined;
            },
            showTextDocument: async (document: unknown, options?: unknown) => {
                shownTextDocuments.push({ document, options });
                return vscode.window.activeTextEditor;
            },
            showOpenDialog: async () => undefined,
            showQuickPick: async (items: Iterable<unknown>, options?: unknown) => {
                const materialized = Array.from(items);
                quickPickCalls.push({ items: materialized, options });
                const queued = quickPickQueue.shift();
                if (typeof queued === 'string') {
                    return materialized.find((item) => (item as { label?: string }).label === queued);
                }
                return queued;
            },
            setStatusBarMessage: (text: string, timeout?: number) => {
                statusBarMessages.push({ text, timeout });
                return new FakeDisposable();
            }
        }
    };

    return {
        vscode,
        registeredCommands,
        registeredTreeViews,
        registeredWebviewProviders,
        registeredContentProviders,
        webviewPanels,
        configurationUpdates,
        executedCommands,
        openedTextDocuments,
        shownTextDocuments,
        clipboardWrites,
        informationMessages,
        statusBarMessages,
        warningMessages,
        errorMessages,
        executedTasks,
        quickPickCalls,
        queueQuickPickResult(result: unknown): void {
            quickPickQueue.push(result);
        },
        queueWarningMessageResult(result: unknown): void {
            warningMessageQueue.push(result);
        },
        setExternalCommandHandler(command: string, handler: CommandHandler): void {
            externalCommandHandlers.set(command, handler);
        },
        setClipboardText(text: string): void {
            clipboardText = text;
        },
        setTasks(tasks: unknown[]): void {
            availableTasks = [...tasks];
        },
        setWorkspaceFolders(folders: Array<{ name: string; fsPath: string }>, options?: { name?: string; fireEvent?: boolean }): void {
            currentWorkspaceFolders = folders.map((folder) => ({
                name: folder.name,
                uri: createUri(folder.fsPath)
            }));
            currentWorkspaceName = options?.name ?? currentWorkspaceFolders[0]?.name ?? '';
            if (options?.fireEvent !== false) {
                workspaceFoldersEmitter.fire();
            }
        },
        setWorkspaceTrust(isTrusted: boolean): void {
            currentWorkspaceTrusted = isTrusted;
        },
        setExtensionMode(mode: number): void {
            currentExtensionMode = mode;
        },
        setActiveTextEditor(options): any {
            const workspaceRoot = currentWorkspaceFolders[0]?.uri ?? defaultWorkspaceRoot;
            const editor = createFakeTextEditor(workspaceRoot, options);
            vscode.window.activeTextEditor = editor;
            return editor;
        },
        clearActiveTextEditor(): void {
            vscode.window.activeTextEditor = undefined;
        },
        createExtensionContext: () => ({
            subscriptions: [] as Array<{ dispose(): void }>,
            workspaceState: new FakeMemento(),
            globalState: new FakeMemento(),
            extensionUri: createUri(process.cwd()),
            extensionMode: currentExtensionMode
        })
    };
}

export function loadWithPatchedVscode<T>(modulePath: string, vscodeMock: any, overrides: LoadOverrides = {}): T {
    const compiledRoot = path.resolve(process.cwd(), '.test-out');
    for (const cacheKey of Object.keys(require.cache)) {
        if (cacheKey.startsWith(compiledRoot) && cacheKey !== __filename) {
            delete require.cache[cacheKey];
        }
    }

    const originalLoad = (Module as any)._load;
    (Module as any)._load = function patchedLoad(request: string, parent: NodeModule, isMain: boolean) {
        if (request === 'vscode') {
            return vscodeMock;
        }
        if (Object.prototype.hasOwnProperty.call(overrides, request)) {
            return overrides[request];
        }
        return originalLoad.call(this, request, parent, isMain);
    };

    try {
        delete runtimeRequire.cache[modulePath];
        return runtimeRequire(modulePath) as T;
    } finally {
        (Module as any)._load = originalLoad;
    }
}