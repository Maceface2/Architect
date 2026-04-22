# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Start Electron app in development mode (hot reload via electron-vite)
npm run build    # Build for production
npm run preview  # Preview production build
```

No lint or test scripts are configured yet.

## Architecture

Architect is an **Electron + React** desktop app that lets users visually compose multi-agent systems using a drag-and-drop canvas, then dispatch them as real Codex CLI sessions.

### Process model

```
Main process (src/main/)
  ├── index.ts       — BrowserWindow setup, IPC handlers (file system, graph execution)
  └── terminals.ts   — node-pty management, prompt building, workspace setup

Preload (src/preload/index.ts)
  └── Exposes window.electron API via contextBridge (typed: readDir, runGraph, terminal.*)

Renderer (src/renderer/src/)
  ├── App.tsx        — Root: directory gate, canvas state, dispatch flow, assistant context
  ├── types.ts       — Shared zone/component canvas types, settings, dispatch/session records
  ├── components/layout/   — TopNav, Sidebar, FilesPanel, TerminalPanel, PreviewPanel
  ├── components/dispatch/ — DispatchModal (new/resume dispatch UI)
  ├── components/nodes/    — ZoneNode, ComponentNode, config/launch modals, nodeTypes registry
  ├── components/palette/  — PaletteItem (drag source)
  └── data/componentPalette.ts — Pre-defined node templates (infrastructure/services/storage)
```

### Execution flow

When the user clicks **Dispatch**:

1. `window.electron.runGraph(nodes, edges, projectDir, settings, dispatch, dispatchContext)` is called from the renderer.
2. Main process (`terminals.ts → runGraph`) wipes any stale mailbox state, then creates an `ARCHITECT/` workspace inside the project directory:
   - `ARCHITECT/manifest.json` — full graph description
   - `ARCHITECT/diagram.md` — Mermaid view of the zone graph
   - `ARCHITECT/prompts/architect.md` — coordinator instructions
   - `ARCHITECT/prompts/<zone>.md` — per-zone system prompt
   - `ARCHITECT/mailbox/<participant>/{inbox,outbox}` — mailbox protocol state
   - `ARCHITECT/mailbox/_index.json` — live observer snapshot for the renderer
   - `ARCHITECT/outputs/` — per-zone status/output notes
3. For multi-zone dispatches, one Architect coordinator PTY is spawned plus one PTY per selected zone. Zone sessions are pre-spawned up front and wired with `MBX_*` env vars for the mailbox scripts.
4. Sessions are considered ready when their rendered PTY output looks like a CLI prompt, with a startup-timeout fallback for unknown TUIs.
5. A one-shot bootstrap prompt tells each participant to read its prompt file and enter its mailbox loop.
6. `startMailboxObserver()` watches inbox/outbox writes, updates `ARCHITECT/mailbox/_index.json`, emits `mailbox:activity` events to the renderer, and injects harness warnings/timeouts when zones stall.
7. `runGraph()` captures new session IDs for Claude, Codex, Gemini, and OpenCode so dispatch history and per-zone resume can track whichever runtime was used.
8. Single-zone dispatch skips the Architect coordinator and launches the zone directly with its prompt and generated system prompt.

### Skills system

`skills/` at the repo root contains markdown skill files (`SKILL.md`) grouped by topic (e.g., `skills/python-testing/SKILL.md`). Node agents can be assigned skills; their content is embedded verbatim into the agent's prompt. Built-in skills are referenced as `builtin:<skill-folder-name>`, custom skills as `custom:<absolute-path>`.

### IPC surface

All renderer ↔ main communication goes through `window.electron` (defined in preload):
- `readDir / readFile / getHomeDir / openDirectory` — file system ops
- `runGraph` — start agent execution, returns `TerminalInfo[]`
- `dispatches.list / dispatches.resume / dispatches.delete / dispatches.updateSummary` — saved multi-zone dispatch history
- `zone.launch / zone.listSessions / zone.deleteSession / zone.updateSessionSummary / zone.resetSession` — per-zone launch + session history
- `terminal.spawnShell / terminal.input / terminal.resize / terminal.killAll` — PTY control
- `terminal.onData / terminal.onExit` — streaming terminal output (event listeners, return cleanup fn)

### Styling

Tailwind CSS with custom colors defined in `index.css`: `bg-canvas` (`#111111`), `bg-surface`, `bg-accent` (`#3d3dbf`), etc.

## graphify

This project has a graphify knowledge graph at graphify-out/.

Rules:
- Before answering architecture or codebase questions, read graphify-out/GRAPH_REPORT.md for god nodes and community structure
- If graphify-out/wiki/index.md exists, navigate it instead of reading raw files
- After modifying code files in this session, run `graphify update .` to keep the graph current (AST-only, no API cost)
