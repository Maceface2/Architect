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
  ├── App.tsx        — Root: DirectoryGate → ArchitectFlow (tab layout: Canvas / Files / Terminal)
  ├── types.ts       — All shared types (ArchitectNodeData, NodeSkillFile, NodeTools, etc.)
  ├── components/layout/   — TopNav, Sidebar, AgentLog, FilesPanel, TerminalPanel, ResizablePanel
  ├── components/nodes/    — ArchitectNode (ReactFlow custom node), nodeTypes registry
  ├── components/palette/  — PaletteItem (drag source)
  └── data/componentPalette.ts — Pre-defined node templates (infrastructure/services/storage)
```

### Execution flow

When the user clicks **Dispatch**:

1. `window.electron.runGraph(nodes, edges, projectDir)` is called from the renderer.
2. Main process (`terminals.ts → runGraph`) creates an `ARCHITECT/` workspace inside the project directory:
   - `ARCHITECT/manifest.json` — full graph description
   - `ARCHITECT/prompts/overseer.md` — Overseer's coordination instructions
   - `ARCHITECT/prompts/<agent>.md` — per-agent role prompt (built from node data + edges)
   - `ARCHITECT/tasks/` — written by Overseer at runtime
   - `ARCHITECT/outputs/` — written by agents at runtime
3. One `Codex --dangerously-skip-permissions` PTY is spawned per node **plus** one Overseer session.
4. Sessions are detected as ready when their output matches `/[>❯]\s*$/`.
5. Overseer is immediately told to read its prompt file and coordinate.
6. Main process polls `ARCHITECT/tasks/<agent>.md` every 2s; when the Overseer writes a task file, the corresponding agent PTY is sent its prompt command.
7. Terminal I/O streams back to the renderer via `terminal:data` / `terminal:exit` IPC events.

### Skills system

`skills/` at the repo root contains markdown skill files (`SKILL.md`) grouped by topic (e.g., `skills/python-testing/SKILL.md`). Node agents can be assigned skills; their content is embedded verbatim into the agent's prompt. Built-in skills are referenced as `builtin:<skill-folder-name>`, custom skills as `custom:<absolute-path>`.

### IPC surface

All renderer ↔ main communication goes through `window.electron` (defined in preload):
- `readDir / readFile / readOutputs / getHomeDir / openDirectory` — file system ops
- `runGraph` — start agent execution, returns `TerminalInfo[]`
- `terminal.input / terminal.resize / terminal.killAll` — PTY control
- `terminal.onData / terminal.onExit` — streaming terminal output (event listeners, return cleanup fn)

### Styling

Tailwind CSS with custom colors defined in `index.css`: `bg-canvas` (`#111111`), `bg-surface`, `bg-accent` (`#3d3dbf`), etc.

## graphify

This project has a graphify knowledge graph at graphify-out/.

Rules:
- Before answering architecture or codebase questions, read graphify-out/GRAPH_REPORT.md for god nodes and community structure
- If graphify-out/wiki/index.md exists, navigate it instead of reading raw files
- After modifying code files in this session, run `graphify update .` to keep the graph current (AST-only, no API cost)
