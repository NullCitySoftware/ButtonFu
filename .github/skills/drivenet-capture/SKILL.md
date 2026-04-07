---
name: drivenet-capture
description: "Use this skill to capture screenshots of windows or UI elements in a Windows desktop app through Drive.NET. Covers the 'capture' MCP tool with window and element targeting, base64 inline image and file output formats, including workspace-safe `.drive-net` artifact writes. Keywords: Drive.NET, capture, screenshot, image, base64, PNG, window, element, visual evidence, file, photo, .drive-net."
argument-hint: "[goal] [window or element target]"
user-invocable: true
---

# Drive.NET Screenshot Capture

Use this skill when you need to capture visual evidence of a Windows desktop application's state.

## `capture` Tool

Capture screenshots of windows or specific UI elements.

### Parameters

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `sessionId` | string | Yes | — | Session ID from `session connect`. |
| `target` | string | No | `"window"` | `"window"` or `"element"`. |
| `elementId` | string | No | — | Element ID to capture. Required when `target` is `"element"`. |
| `format` | string | No | `"base64"` | `"base64"` (returns inline MCP image) or `"file"` (saves to disk). |
| `filePath` | string | No | auto-generated | File path hint with `.png` extension. Required when `format` is `"file"` unless auto-generation is acceptable. Drive.NET normalizes the result under the workspace-root `.drive-net` directory. |
| `windowHandle` | string | No | main window | Window handle from `window list`. Defaults to the session's main window. |

### Base64 Response (default)

Returns an image object viewable inline by AI agents:

```json
{
  "type": "image",
  "mimeType": "image/png",
  "data": "iVBORw0KGgo...",
  "width": 800,
  "height": 600,
  "sizeBytes": 45678
}
```

### File Response

```json
{
  "filePath": "...\\.drive-net\\captures\\capture.png",
  "width": 800,
  "height": 600,
  "sizeBytes": 45678
}
```

### Examples

```
capture sessionId="..."
capture sessionId="..." target="element" elementId="e_panel1"
capture sessionId="..." format="file" filePath="captures/test.png"
capture sessionId="..." format="file"
capture sessionId="..." windowHandle="0x12D687"
```

## Rules

- Use `window bringToFront` before capturing to ensure the window is not obscured by other windows.
- Window captures require a non-minimized target window. Restore the window first if capture reports that the window is minimized.
- Default `base64` format returns inline images that AI agents can view directly.
- Use `file` format for evidence you want to persist, or for larger screenshots.
- When `format` is `"file"`, Drive.NET writes captures under the workspace-root `.drive-net` folder.
- Explicit `filePath` values must still end in `.png`, but Drive.NET normalizes them into `.drive-net` to avoid arbitrary file writes.

## Complex Capture Patterns

### Before/After Visual Regression

Capture the window before and after an interaction to visually compare state:

```
capture sessionId="..." format="file" filePath="evidence/before.png"
interact sessionId="..." action="click" elementId="e_theme_toggle"
wait_for sessionId="..." condition="elementExists" automationId="themeApplied" timeoutMs=3000
capture sessionId="..." format="file" filePath="evidence/after.png"
```

### Capture Specific Elements for Focused Evidence

When a full window screenshot is too noisy, target a specific element:

```
capture sessionId="..." target="element" elementId="e_errorPanel"
```

### Multi-Window Capture

For apps with multiple windows, capture each by handle:

```
window sessionId="..." action="list"
capture sessionId="..." windowHandle="0x1A4F" format="file" filePath="evidence/main.png"
capture sessionId="..." windowHandle="0x2B5E" format="file" filePath="evidence/dialog.png"
```
