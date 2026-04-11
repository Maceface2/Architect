# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Start Electron app in development mode (hot reload via electron-vite)
npm run build    # Build for production
npm run preview  # Preview production build
```

No lint or test scripts are configured yet.

## Architecture

Architect is an **Electron + React** desktop app that lets users visually compose multi-agent systems using a drag-and-drop canvas, then dispatch them as real coding-agent CLI sessions.

### Process model

```
src/shared/          — Types shared between main and renderer (no Electron/DOM imports)
  agentRuntimes.ts   — AgentRuntime union type + definitions for claude/codex/gemini/opencode
  graphDispatch.ts   — RunGraphOptions, LaunchScope, PreflightNodeResult, RunGraphResult
  projectBootstrap.ts — Types for the project analysis / canvas bootstrap pipeline

src/main/
  index.ts           — BrowserWindow setup, all IPC handler registration
  terminals.ts       — node-pty session management, prompt building, preflight logic, task polling
  agentCli.ts        — Binary resolution, runtime arg building, one-shot PTY runner
  projectAnalyzer.ts — Deterministic repo analysis + optional agent fallback → bootstrap canvas

src/preload/index.ts — Exposes window.electron API via contextBridge

src/renderer/src/
  App.tsx            — Root: DirectoryGate → ArchitectFlow (canvas/files/terminal tabs)
  types.ts           — All renderer types (ArchitectNodeData, NodeSkillFile, NodeTools, etc.)
  lib/canvas.ts      — createDefaultNodeConfig, migrateCanvasData, canvas serialization helpers
  context/           — React contexts: ProjectDirectoryContext, ProjectSettingsContext, DispatchActionsContext
  components/layout/ — TopNav, Sidebar, AgentLog, AssistantPanel, FilesPanel, TerminalPanel, ResizablePanel
  components/nodes/  — ArchitectNode (ReactFlow custom node), nodeTypes registry
  components/palette/ — PaletteItem (drag source)
  data/componentPalette.ts — Pre-defined node templates
```

### Multi-runtime support

Each node (and the project globally) can target one of four runtimes: `claude`, `codex`, `gemini`, or `opencode`. `src/shared/agentRuntimes.ts` is the canonical definition — add new runtimes there first. `agentCli.ts:buildRuntimeArgs` maps each runtime to its CLI flags. The runtime's binary is resolved via `resolveBinary`, which checks Homebrew paths before falling back to a shell `which` call.

### Canvas persistence

The canvas is saved as `architect-canvas.json` in the user's project directory. The renderer polls this file every 1.2 s (when not dirty) so the Architecture Assistant's edits appear in real time. `src/renderer/src/lib/canvas.ts:migrateCanvasData` handles forward-compatibility when the schema changes.

### Project bootstrap

When a project has no `architect-canvas.json`, `projectAnalyzer.ts:bootstrapProjectCanvas` runs a deterministic repo scan (`ProjectStructureSummary`) and, if confidence is low, falls back to a one-shot agent call (`runOneShotAgentPrompt`) to produce a `ProjectBootstrapResult`. The result is turned into nodes and edges and saved as the initial canvas.

### Execution flow

When the user clicks **Dispatch**:

1. `window.electron.runGraph(nodes, edges, projectDir, settings, options)` is called.
2. Main process runs a **preflight** check (`GraphPreflightSummary`) that classifies each node as `missing / adopted / needs_delta / blocked_by_upstream / unchanged` based on `ownedPaths` and `expectedFiles` on disk.
3. An `ARCHITECT/` workspace is created inside the project directory:
   - `ARCHITECT/manifest.json` — full graph description
   - `ARCHITECT/prompts/overseer.md` — Overseer coordination instructions
   - `ARCHITECT/prompts/<agent>.md` — per-agent role prompt (node data + skills + edges)
   - `ARCHITECT/tasks/` — written by Overseer at runtime
   - `ARCHITECT/outputs/` — written by agents at runtime
4. One `claude --dangerously-skip-permissions` PTY (or equivalent) is spawned per node **plus** one Overseer session. Nodes flagged `unchanged` by preflight are skipped.
5. Sessions are detected as ready when output matches `/[>❯]\s*$/`.
6. Main process polls `ARCHITECT/tasks/<agent>.md` every 2 s; when Overseer writes a task file the corresponding agent PTY receives its prompt.
7. On completion, the agent's `claudeSessionId` is written back to the node so future dispatches can use `--resume`.
8. Terminal I/O streams to the renderer via `terminal:data` / `terminal:exit` IPC events.

### Launch scopes

`RunGraphOptions.launchScope` controls which nodes are started:

- `all` — full dispatch (default)
- `selected` — only user-selected nodes
- `single` — one specific node (lightning-bolt per-node button)

On re-dispatch, nodes whose data hash hasn't changed since the last snapshot are skipped by preflight.

### Architecture Assistant

The **Assistant** is a separate interactive PTY session (same runtime as the project default) with a system prompt that gives it full context of the current canvas and the `architect-canvas.json` schema. It edits `architect-canvas.json` directly; the renderer picks up the change within ~1.2 s via the canvas polling loop.

### Skills system

`skills/` at the repo root contains markdown skill files (`SKILL.md`) grouped by topic. Node agents can be assigned skills; their content is embedded verbatim into the agent's prompt. Built-in skills are referenced as `builtin:<skill-folder-name>`, custom skills as `custom:<absolute-path>`.

### IPC surface

All renderer ↔ main communication goes through `window.electron` (defined in `src/preload/index.ts`):

- `readDir / readFile / readOutputs / getHomeDir / openDirectory` — file system ops
- `saveCanvas / loadCanvas` — canvas persistence
- `bootstrapProject` — trigger project analysis
- `scanComponents` — walk a directory for `architect-component.json` files
- `runGraph` — start agent execution, returns `RunGraphResult` (sessions + preflight summary)
- `assistant.start / assistant.stop` — Architecture Assistant PTY
- `terminal.input / terminal.resize / terminal.killAll` — PTY control
- `terminal.onData / terminal.onExit / terminal.onNodeSessionSaved` — streaming events (return cleanup fn)

### Styling

Tailwind CSS with custom tokens in `tailwind.config.ts` and `index.css`:

- `bg-canvas` `#111111` — canvas background
- `bg-panel` / `bg-surface` — sidebar, nav, log panels
- `bg-accent` `#3d3dbf` / `bg-node-border-active` `#5b5bf0` — primary action color
