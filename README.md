# ButtonFu

**Stop hunting through menus. Put your most-used actions one click away.**

ButtonFu adds a fully customisable button panel to the VS Code sidebar. Run terminal commands, trigger palette actions, execute tasks, or fire off a Copilot prompt — all without leaving your flow.

![ButtonFu sidebar showing categorised buttons](README_PIC1.png)

---

## What can a button do?

| Type | What it does |
|------|--------------|
| **Terminal Command** | Runs any shell command in the integrated terminal |
| **Command Palette Action** | Executes any VS Code command by ID, with optional arguments |
| **Task Execution** | Runs a task discovered from your workspace or extensions |
| **Copilot Command** | Sends a prompt to GitHub Copilot Chat, with model, mode, and file attachments |

---

## Global & Workspace buttons
 
Buttons come in two scopes. **Global** buttons are stored in your VS Code user settings and appear in every workspace — perfect for commands you use everywhere, like reloading the window or opening a terminal profile. **Workspace** buttons live in workspace state and are scoped to the current project — handy for project-specific build scripts, deployment commands, or Copilot prompts tailored to your codebase.

Both scopes show up together in the sidebar panel, clearly labelled, so you always know what you're clicking.

---

## The button editor

Click the gear icon in the panel header to open the full button editor. All your buttons are listed in one place — sortable, categorised, and easy to manage.

![ButtonFu editor showing the button list](README_PIC2.png)

Click any button to edit it, or hit **+ Add Button** to create a new one. Every button has:

- A **name**, **description**, and **category** for organisation
- A **type** that determines what it executes
- A **codicon icon** picked from a searchable grid
- An optional **colour** to make important buttons stand out at a glance
- A **keyboard shortcut** you can assign directly from the editor

![Editing a button with Copilot settings expanded](README_PIC3.png)

---

## Copilot integration

Copilot Command buttons let you build reusable AI workflows. Choose your **model** (with autocomplete across all your available models), set the **mode** (Agent, Ask, Edit, or Plan), and attach files that should always be part of the conversation — including a toggle to automatically attach whichever file you currently have open.

When you click the button, ButtonFu opens a fresh chat session, sets the mode and model, attaches any files, and submits your prompt — all in one click.

---

## Organise with categories

Group related buttons under a **category** label. Categories appear as section headers in both the editor list and the sidebar panel, so your workspace stays tidy even as your button collection grows. Buttons can be reordered within their group using the up/down arrows in the editor.

---

## Get started

Search for **ButtonFu** in the VS Code Extensions panel and click Install. The sidebar icon appears immediately — open it and hit **+ Add Button** to create your first button.
