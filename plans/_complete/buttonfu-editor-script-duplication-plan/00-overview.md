# ButtonFu: the button editor's script exists twice, and one copy never runs

> **Status: DONE 2026-08-26.** Rob chose "delete the dead copy" the same day it was carved.
> `resources/editor.js` is gone, the `<script src>` tag with it, and `check-webview-js` now runs
> `scripts/check-webview-script.js`, which pulls the live script out of the template literal and
> hands it to `node --check`. Verified both ways: breaking a function signature in the inline
> script makes the gate exit 1, and restoring it makes it exit 0. This folder is kept as the
> record of why. Carved out of
> [`plans/_incomplete/buttonfu-claude-integration-plan/`](../../_incomplete/buttonfu-claude-integration-plan/00-overview.md)
> on 2026-08-26, which found the problem while adding the Claude section to the editor and worked
> around it rather than fixing it. Nothing is waiting on this. It costs nothing today beyond the
> duplication itself, which is exactly why it was left.

## What is wrong

The button editor webview loads two scripts. The first is inline in the template literal inside
`buttonfu-extension/src/editorPanel.ts`; the second is `buttonfu-extension/resources/editor.js`,
pulled in by a `<script src>` tag after it. They are near-identical copies of the same 1,400 lines:
the same `openEditor`, the same `saveButton`, the same `onTypeChanged`.

**Only the inline copy runs.** The inline script opens with:

```js
const vscode = acquireVsCodeApi();
```

and `resources/editor.js` opens with:

```js
const vscode = globalThis.vscode;
```

A `const` at the top level of a classic script goes into the global lexical environment shared by
every script on the page, so the second declaration is a `SyntaxError` before a line of the file
executes. Proved by running the two in one `vm` context:

```
second script FAILED: SyntaxError Identifier 'vscode' has already been declared
```

Nothing sets `globalThis.vscode`, either, so even without the collision the file's own bootstrap
guard would throw `ButtonFu editor bootstrap was not initialised.`

The comment at the top of `editor.js` says the inline script sets those globals for it. That was
presumably true once.

## Why it matters

- **Every editor change has to be made twice.** The Claude work did exactly that, by hand, with a
  script that re-indented one copy by eight spaces to match the other. The next person will not
  know they have to.
- **`npm run check-webview-js` guards the wrong file.** It is `node --check resources/editor.js`,
  which is the copy that never runs. A syntax error in the inline copy sails past it and shows up
  as a blank editor at runtime. The Claude work hit this: a `'\n'` written inside the TypeScript
  template literal reached the browser as a real newline inside a string, and only a webview
  runtime test caught it.
- The two copies have presumably already drifted in ways nobody has noticed, because nobody has
  had a reason to diff them.

## The two ways out

**Delete `resources/editor.js`.** The inline copy is the one that works, so this is the smaller
change. `check-webview-js` then needs to point at something real: extract the inline script from
the template literal and `node --check` that instead, which is what the Claude work did by hand to
prove the section parsed.

**Or wire the external file up properly.** Move the inline bootstrap onto `globalThis`
(`globalThis.vscode = acquireVsCodeApi()` and the same for `ICONS`, `MODES`, `TYPE_INFO`,
`SYSTEM_TOKENS` and the Claude tables), delete the inline body, and let `editor.js` be the editor.
The editor becomes a real file with real tooling, and `check-webview-js` starts guarding the thing
it names. More work, and it needs care: the webview runtime tests in
`src/test/helpers/webviewRuntime.ts` only execute inline scripts, so they would need to load the
external file too.

The second is the better end state. The first is a tenth of the work. Somebody should pick, rather
than an agent picking mid-way through unrelated work.

## What would bring this back

Any of:

- The next substantial change to the button editor, which would otherwise be made twice again.
- A blank editor in the wild, which is what an unguarded syntax error in the inline copy looks
  like.
- Somebody noticing the two copies have drifted.

## Reference

- `buttonfu-extension/src/editorPanel.ts` - the inline script starts at the `<script nonce>` tag
  and runs to `</script>`, roughly 2,100 lines in.
- `buttonfu-extension/resources/editor.js` - the copy that never runs.
- `buttonfu-extension/package.json` - the `check-webview-js` script.
- `buttonfu-extension/src/test/helpers/webviewRuntime.ts` - `extractScripts` takes inline scripts
  only, which is why the tests exercise the live copy today.
