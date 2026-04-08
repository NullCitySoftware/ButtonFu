import assert from 'node:assert/strict';
import vm from 'node:vm';

type Listener = (event: any) => void;

class FakeClassList {
    private readonly values = new Set<string>();

    add(...tokens: string[]): void {
        for (const token of tokens) {
            this.values.add(token);
        }
    }

    remove(...tokens: string[]): void {
        for (const token of tokens) {
            this.values.delete(token);
        }
    }

    toggle(token: string, force?: boolean): boolean {
        if (force === true) {
            this.values.add(token);
            return true;
        }
        if (force === false) {
            this.values.delete(token);
            return false;
        }
        if (this.values.has(token)) {
            this.values.delete(token);
            return false;
        }
        this.values.add(token);
        return true;
    }

    contains(token: string): boolean {
        return this.values.has(token);
    }

    toString(): string {
        return [...this.values].join(' ');
    }
}

class FakeElement {
    readonly style: Record<string, string> = {};
    readonly dataset: Record<string, string> = {};
    readonly classList = new FakeClassList();
    readonly attributes: Record<string, string> = {};

    value = '';
    checked = false;
    innerHTML = '';
    textContent = '';
    disabled = false;
    className = '';
    selectionStart = 0;
    selectionEnd = 0;

    private readonly listeners = new Map<string, Listener[]>();

    constructor(readonly id: string, private readonly ownerDocument: FakeDocument) {}

    addEventListener(type: string, listener: Listener): void {
        const existing = this.listeners.get(type) || [];
        existing.push(listener);
        this.listeners.set(type, existing);
    }

    dispatch(type: string, eventInit: Record<string, unknown> = {}): void {
        const event = {
            target: this,
            currentTarget: this,
            preventDefault(): void {
                // noop
            },
            stopPropagation(): void {
                // noop
            },
            ...eventInit
        };

        for (const listener of this.listeners.get(type) || []) {
            listener(event);
        }
    }

    focus(): void {
        this.ownerDocument.activeElement = this;
    }

    blur(): void {
        if (this.ownerDocument.activeElement === this) {
            this.ownerDocument.activeElement = null;
        }
    }

    scrollIntoView(): void {
        // noop
    }

    setSelectionRange(start: number, end: number): void {
        this.selectionStart = start;
        this.selectionEnd = end;
    }

    contains(target: unknown): boolean {
        return target === this;
    }

    closest(selector: string): FakeElement | null {
        if (selector.startsWith('#')) {
            return selector.slice(1) === this.id ? this : null;
        }
        const dataAttributeMatch = selector.match(/^\[(data-[^=\]]+)(?:="([^"]*)")?\]$/);
        if (dataAttributeMatch) {
            const attributeName = dataAttributeMatch[1];
            const expectedValue = dataAttributeMatch[2];
            if (!(attributeName in this.attributes)) {
                return null;
            }
            if (expectedValue !== undefined && this.attributes[attributeName] !== expectedValue) {
                return null;
            }
            return this;
        }
        return null;
    }
}

class FakeDocument {
    activeElement: FakeElement | null = null;

    private readonly listeners = new Map<string, Listener[]>();
    private readonly elements = new Map<string, FakeElement>();

    constructor(html: string) {
        const tagPattern = /<([A-Za-z0-9-]+)([^>]*)>/g;
        const attributePattern = /([A-Za-z0-9:_-]+)="([^"]*)"/g;
        let match: RegExpExecArray | null;
        while ((match = tagPattern.exec(html)) !== null) {
            const attributeText = match[2];
            const idMatch = attributeText.match(/\sid="([^"]+)"/);
            if (!idMatch) {
                continue;
            }

            const id = idMatch[1];
            if (!this.elements.has(id)) {
                const element = new FakeElement(id, this);
                attributePattern.lastIndex = 0;
                let attributeMatch: RegExpExecArray | null;
                while ((attributeMatch = attributePattern.exec(attributeText)) !== null) {
                    const attributeName = attributeMatch[1];
                    const attributeValue = attributeMatch[2];
                    element.attributes[attributeName] = attributeValue;

                    if (attributeName === 'class') {
                        element.className = attributeValue;
                        for (const token of attributeValue.split(/\s+/).filter(Boolean)) {
                            element.classList.add(token);
                        }
                    } else if (attributeName.startsWith('data-')) {
                        element.dataset[toDatasetKey(attributeName)] = attributeValue;
                    }
                }
                this.elements.set(id, element);
            }
        }
    }

    getElementById(id: string): FakeElement | null {
        return this.elements.get(id) ?? null;
    }

    querySelectorAll(selector: string): FakeElement[] {
        if (selector.startsWith('#')) {
            const element = this.getElementById(selector.slice(1));
            return element ? [element] : [];
        }

        const dataAttributeMatch = selector.match(/^\[(data-[^=\]]+)(?:="([^"]*)")?\]$/);
        if (!dataAttributeMatch) {
            return [];
        }

        const attributeName = dataAttributeMatch[1];
        const expectedValue = dataAttributeMatch[2];
        return [...this.elements.values()].filter((element) => {
            if (!(attributeName in element.attributes)) {
                return false;
            }
            return expectedValue === undefined || element.attributes[attributeName] === expectedValue;
        });
    }

    querySelector(selector: string): FakeElement | null {
        return this.querySelectorAll(selector)[0] ?? null;
    }

    addEventListener(type: string, listener: Listener): void {
        const existing = this.listeners.get(type) || [];
        existing.push(listener);
        this.listeners.set(type, existing);
    }

    dispatch(type: string, eventInit: Record<string, unknown> = {}): void {
        const event = {
            preventDefault(): void {
                // noop
            },
            stopPropagation(): void {
                // noop
            },
            ...eventInit
        };

        for (const listener of this.listeners.get(type) || []) {
            listener(event);
        }
    }
}

class FakeWindow {
    alert(): void {
        // noop
    }

    private readonly listeners = new Map<string, Listener[]>();

    addEventListener(type: string, listener: Listener): void {
        const existing = this.listeners.get(type) || [];
        existing.push(listener);
        this.listeners.set(type, existing);
    }

    dispatch(type: string, eventInit: Record<string, unknown> = {}): void {
        const event = {
            preventDefault(): void {
                // noop
            },
            stopPropagation(): void {
                // noop
            },
            ...eventInit
        };

        for (const listener of this.listeners.get(type) || []) {
            listener(event);
        }
    }
}

export interface ExecutedWebviewRuntime {
    postedMessages: unknown[];
    document: FakeDocument;
    click(id: string): void;
    doubleClick(id: string): void;
    contextMenu(id: string, x?: number, y?: number): void;
    dispatchMessage(data: unknown): void;
}

export function executeWebviewScripts(html: string): ExecutedWebviewRuntime {
    const scripts = extractScripts(html);
    const document = new FakeDocument(html);
    const windowObject = new FakeWindow();
    const postedMessages: unknown[] = [];
    let webviewState: unknown;

    const vscodeApi = {
        postMessage(message: unknown): void {
            // JSON-roundtrip ensures objects created inside the VM sandbox
            // have native prototypes for assert.deepStrictEqual comparisons
            postedMessages.push(JSON.parse(JSON.stringify(message)));
        },
        getState(): unknown {
            return webviewState;
        },
        setState(value: unknown): void {
            webviewState = value;
        }
    };

    const context = vm.createContext({
        window: windowObject,
        document,
        console,
        setTimeout,
        clearTimeout,
        requestAnimationFrame(callback: (timestamp: number) => void): number {
            callback(0);
            return 0;
        },
        cancelAnimationFrame(): void {
            // noop
        },
        acquireVsCodeApi(): typeof vscodeApi {
            return vscodeApi;
        }
    });

    for (const script of scripts) {
        vm.runInContext(script, context, { timeout: 1000 });
    }

    return {
        postedMessages,
        document,
        click(id: string): void {
            const element = document.getElementById(id);
            assert.ok(element, `Expected element #${id} to exist.`);
            element.dispatch('click');
            document.dispatch('click', { target: element });
        },
        doubleClick(id: string): void {
            const element = document.getElementById(id);
            assert.ok(element, `Expected element #${id} to exist.`);
            element.dispatch('dblclick');
            document.dispatch('dblclick', { target: element });
        },
        contextMenu(id: string, x = 20, y = 20): void {
            const element = document.getElementById(id);
            assert.ok(element, `Expected element #${id} to exist.`);
            element.dispatch('contextmenu', { clientX: x, clientY: y });
            document.dispatch('contextmenu', { target: element, clientX: x, clientY: y });
        },
        dispatchMessage(data: unknown): void {
            windowObject.dispatch('message', { data });
        }
    };
}

function toDatasetKey(attributeName: string): string {
    return attributeName
        .slice('data-'.length)
        .replace(/-([a-z])/g, (_match, group: string) => group.toUpperCase());
}

function extractScripts(html: string): string[] {
    const results: string[] = [];
    const scriptPattern = /<script[^>]*>([\s\S]*?)<\/script>/g;
    let match: RegExpExecArray | null;
    while ((match = scriptPattern.exec(html)) !== null) {
        results.push(match[1]);
    }
    return results;
}