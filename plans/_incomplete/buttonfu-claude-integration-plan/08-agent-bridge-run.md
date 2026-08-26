# Stage 08: running a Claude button over the agent bridge

> **Status: done 2026-08-26.** `buttonfu.claude.allowBridgeRun` was never turned on and ships `false`; the agent bridge itself is also still off. The live-pipe checks are stage 10's.

**Repo:** `C:\GIT\ButtonFu` (`buttonfu-extension/`)
**Prerequisites:** stages 01 to 06 done. The bridge can only run what the service can launch.
**Block:** 7. Nothing else runs alongside it.

One new method on the named-pipe bridge, so a Claude session in one window can start a seeded
Claude session in another. Rob's ruling of 2026-08-26 sets its shape and it is locked (BC9):
**Claude buttons only, and off unless a setting says otherwise.**

## The boundary being moved, stated plainly

Today the bridge is CRUD and nothing else: `ALLOWED_METHODS` (`src/agentBridge.ts:37-48`) holds
ten create, read, update and delete entries, and no path through the server executes anything.
That is a deliberate boundary, and this stage moves it.

After this stage, any process that can read `~/.buttonfu/bridge-<pid>.json` and its auth token
can cause a Claude session to start. The restrictions that keep that proportionate:

- Only buttons whose `type` is `ClaudeCommand` can be run. A terminal button that deploys a site
  or drops a database is refused, by type, before anything else is considered.
- The method is inert unless `buttonfu.claude.allowBridgeRun` is `true`, and it ships `false`.
- The existing transport protections still apply and are not weakened: per-session 256-bit token
  compared with `crypto.timingSafeEqual`, the sliding rate limit, the 1 MB message cap, the
  three-connection cap, and the `targetWindowId` workspace check at `src/agentBridge.ts:646-662`.

Do not add a fourth restriction that was not asked for, and do not relax any of the three.

## Touch points

| File | Change |
|---|---|
| `src/agentBridge.ts` | `ALLOWED_METHODS` gains `buttonfu.api.runButton`; `ENRICHABLE_METHODS` (line 702) gains it too, so a caller learns which window ran it |
| `src/buttonApiService.ts` | `runButton(store, input)`: resolve, gate, refuse, delegate |
| `src/extension.ts` | register `buttonfu.api.runButton` beside the others (line 364) |
| `package.json` | the command entry, and the setting `buttonfu.claude.allowBridgeRun` |
| `src/apiSchema.ts` | method documentation, its refusal reasons, and one example |
| `src/agentBridgeCommands.ts` | the quick-start text copied by `buttonfu.agentBridgeCopyQuickStart` mentions the method and that it is off by default |
| `src/test/agentBridge.test.ts` | the method is on the allowlist and reaches the command handler |
| `src/test/runButton.test.ts` | **new file** rather than an addition to `buttonApiService.test.ts`: the gate, the type refusal, the token refusal, and what a successful run reports |
| `src/test/extension.integration.test.ts` | the command is registered at activation |

## Design

### `buttonApiService.runButton`

```ts
async runButton(store: ButtonStore, input: unknown): Promise<ApiResult<{ id: string; launched: true }>>;
```

Accepts `{ id }` or `{ name, locality? }`, matching how `getButton` already resolves a target
(`src/buttonApiService.ts:165-175, 220-240`). Then, in this order, with a distinct message for
each refusal:

1. Setting off: *"Running buttons over the agent bridge is disabled. Set
   buttonfu.claude.allowBridgeRun to true to allow it."*
2. Button not found: the existing not-found shape.
3. Wrong type: *"Only Claude buttons can be run over the bridge. This button is a Terminal
   Command."*
4. Otherwise, execute it through the same path a click takes, so tokens resolve identically.

A distinct message per refusal is what stops an agent retrying blindly against a wall.

**Unresolved user tokens are a refusal, not a prompt.** A click can open the token input panel
and wait for a person; a bridge call has nobody to ask. If the button declares user tokens with
no default, refuse with *"This button needs values for $Name$ and cannot be run over the
bridge."* Optionally accept `{ tokens: { Name: 'value' } }` in the request and feed those in
through `executeWithTokens`, which is where the existing token plumbing already expects a
snapshot.

`warnBeforeExecution` is a dialog on a click. Over the bridge it has no meaning and there is
nobody to answer it: run the button and note in the result that the confirmation was skipped.

### Registration

Follow the pattern at `src/extension.ts:364` exactly, including the `panelProvider.refresh()`
convention where it applies (it does not here, since nothing is stored) and the
`context.subscriptions.push` wrapping.

### Setting

```jsonc
"buttonfu.claude.allowBridgeRun": {
  "type": "boolean",
  "default": false,
  "scope": "machine",
  "description": "Allow the ButtonFu agent bridge to run Claude buttons. Only buttons of type Claude Command can ever be run this way; every other type is refused."
}
```

The description is the only place most people will read the rule, so it states the restriction
rather than just the switch.

### Schema and guidance

`src/apiSchema.ts` documents the method beside the CRUD ten: parameters, the three refusal
reasons, and an example. Extend `AUTOMATION_GUIDANCE` (line 237) with one sentence: running is
opt-in, Claude-only, and everything else still has to go through the CRUD methods.

An agent that reads `buttonfu.api.describe` and finds the method should be able to work out in
one read whether it can use it and why it was refused if it could not.

## Done when

- [x] `npm run check-types`, `npm run lint` and `npm test` pass.
- [x] Tests prove: the method is refused when the setting is off; a `TerminalCommand` button is
      refused by type with the setting on; a `ClaudeCommand` button reaches the service; a
      button with unresolved user tokens is refused with a message naming the token.
- [x] `buttonfu.api.describe` over the real pipe lists the method, using the helper at
      `buttonfu-extension/scripts/buttonfu-bridge.ps1`.
- [x] With the setting on, a bridge call starts a session in the target window, and the result
      carries the bridge context naming that window.
- [x] With the setting off again, the same call is refused and nothing spawns.
- [x] Stage table in `00-overview.md` updated, status line flipped to done with the date.

## Notes from the run

- **`runButton` takes a host object rather than reading the setting itself.** `buttonApiService`
  has never imported `vscode` and this stage did not change that: `extension.ts` supplies the
  setting read and the executor, which is also what makes every refusal testable.
- **The setting is checked before the button is looked up**, deliberately, so a bridge with
  running turned off does not answer the question "does a button by this name exist".
- **Supplied token values are accepted with or without the dollars.** An agent writing
  `{ tokens: { Target: "..." } }` is the obvious form; `$Target$` works too.
- **The live-pipe checks belong to stage 10**, which turns the bridge and the setting on once,
  proves the call, and turns both off again.

## Concurrency notes

- **`src/extension.ts` is shared with stage 06**, and `src/apiSchema.ts` and
  `src/buttonApiService.ts` with stage 01. All three stages are in different blocks. If you find
  changes in those files you did not make, another session is in them: stop and wait.
- Testing this means the bridge is live and accepting calls. Turn `buttonfu.claude.allowBridgeRun`
  back off when the stage is finished, and say in the completion note that it is off.
