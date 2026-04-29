# Architect Frontend

This document describes the current renderer implementation in Architect.

The app is no longer the older "one prompt per node" prototype. The live UI is centered on two canvas node types:

- `zone` nodes, which represent agent sessions and runtime configuration
- `component` nodes, which represent design artifacts owned geometrically by zones

The renderer is responsible for editing that canvas, launching dispatches, surfacing saved sessions, and showing live terminal/output state for active runs.

## Tech Stack

| Layer | Technology |
| --- | --- |
| Desktop shell | Electron |
| Bundler | electron-vite |
| UI framework | React 18 + TypeScript |
| Canvas | `@xyflow/react` v12 |
| Styling | Tailwind CSS v3 + PostCSS |
| Terminals | `@xterm/xterm` + `@xterm/addon-fit` |

## Renderer Structure

```text
src/renderer/src/
├── App.tsx                             # Root app, canvas state, dispatch + assistant flow
├── types.ts                            # Zone/component types, settings, dispatch/session records
├── env.d.ts                            # window.electron type declarations
├── lib/
│   ├── canvas.ts                       # Default zone/component data, normalization helpers
│   └── icons.ts                        # Lucide icon registry
├── context/
│   ├── ProjectDirContext.tsx           # Active project directory
│   └── ProjectSettingsContext.tsx      # Default runtime + assistant mode
└── components/
    ├── auth/
    │   ├── LoginScreen.tsx             # Sign-in screen
    │   └── UserMenu.tsx                # Bottom-right user menu / sign-out
    ├── dispatch/
    │   └── DispatchModal.tsx           # New dispatch / resume previous dispatch
    ├── layout/
    │   ├── TopNav.tsx                  # Header, tabs, dispatch + assistant controls
    │   ├── FilesPanel.tsx              # Project file browser
    │   ├── TerminalPanel.tsx           # Multi-session terminal workspace
    │   ├── PopoutTerminalApp.tsx       # Pop-out terminal window root
    │   ├── AssistantPanel.tsx          # Side-panel assistant (architecture + general)
    │   ├── AssistantLaunchModal.tsx    # Per-mode CLI / model / session picker
    │   ├── ResizablePanel.tsx          # Side / bottom resizable container
    │   └── terminalLayout*.ts          # Terminal docking/splitting state
    ├── edges/
    │   └── ComponentEdge.tsx           # Bezier component-to-component edge + editor
    ├── palette/
    │   └── CompactCanvasPalette.tsx    # Floating Edges / Zones / Components creation tools
    ├── settings/
    │   └── SettingsPanel.tsx           # Project-settings tab (dispatch defaults, harness timeouts)
    └── nodes/
        ├── ZoneNode.tsx                # Resizable zone overlay
        ├── ComponentNode.tsx           # Component card
        ├── AgentConfigModal.tsx        # Zone runtime/model/system prompt editor
        ├── ZoneLaunchModal.tsx         # Launch or resume one zone
        ├── ComponentConfigModal.tsx    # Component editor
        └── nodeTypes.ts                # React Flow node registry
```

## Core Types

`src/renderer/src/types.ts` defines the renderer's shared model.

### `ZoneNodeData`

Carries the agent-facing configuration for a zone:

- `participantId` (immutable, minted from the initial label, used by the orchestrator for activity-log filenames and decision JSON)
- label, description, color, status
- `systemPrompt`
- runtime selection in `agentRuntime` (single source of truth — the legacy `agentRuntimeMode: 'inherit' | 'override'` field is no longer read and is stripped on load)
- per-runtime model overrides in `providerModels`
- `skills`, `tools`, `behavior`, `permissions`, `envVars`, `openSections`

`ZoneNodeType` is `Node<ZoneNodeData, 'zone'>`.

### `ComponentNodeData`

Carries the design artifact shown on the canvas:

- label, description, specs
- category
- icon name
- color
- tag

`ComponentNodeType` is `Node<ComponentNodeData, 'component'>`.

### Dispatch Types

The renderer also models:

- `ProjectSettings`
- `ZoneSessionRecord`
- `DispatchRecord`
- `DispatchRequest`

These mirror the preload bridge and let the UI render dispatch history, per-zone saved sessions, and resume actions without reaching into the main process directly.

## App Flow

`App.tsx` owns the main renderer orchestration:

- mounts the project directory gate
- loads/saves `architect-canvas.json` (with auto-save on non-substantive node changes and a debounced terminal-layout save)
- normalizes canvas data via `migrateCanvasData`
- tracks tabs for Canvas / Files / Terminal / Settings
- maintains a 50-step canvas undo/redo history (Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z or Cmd/Ctrl+Y)
- builds the per-mode assistant context (architecture vs. general)
- opens `DispatchModal`
- calls `window.electron.startDispatch(...)` for new dispatches
- calls `window.electron.dispatches.resume(...)` for saved multi-zone dispatches
- watches `architect-canvas.json` for external edits (assistant writes) and surfaces a `CanvasConflictModal` when the user has unsaved local edits

The canvas stays mounted while the user switches tabs so React Flow state, selection, and node geometry do not reset.

## Canvas Model

The canvas is a mixed graph of zones and components.

### Zone ownership

Component ownership is geometric, not edge-based. A component belongs to the smallest zone whose bounding box contains the component's center. This is why the renderer preserves zone position and dimensions carefully and why zone resizing matters at dispatch time.

### Component edges

Edges are component-level reference links. Each edge may carry an optional label and a semantic direction (`source-to-target`, `bidirectional`, or `none`). These values are persisted in `architect-canvas.json`, rendered on the canvas, and included in assistant/dispatch context, but they do not affect zone ownership or dispatch scheduling.

### Compact creation palette

The canvas uses a small floating palette with three creation tools: Edges, Zones, and Components. Zone and component tools collect essentials in a compact popup, then the user clicks the canvas to place the configured item. The edge tool collects optional label/direction metadata, then the next component-to-component connection receives those defaults.

`buildDemoGraph()` and the normalization helpers in `lib/canvas.ts` keep legacy or partially missing canvas data usable.

## Current UI Surface

### `ZoneNode`

`ZoneNode.tsx` renders the translucent overlay that represents one agent session.

Key behaviors:

- `NodeResizer` exposes direct resize handles
- the header shows status, runtime badge, and effective model
- the launch button opens `ZoneLaunchModal`
- the settings button opens `AgentConfigModal`

This is the main entry point for zone-level runtime overrides and one-off launches/resumes.

### `ComponentNode`

`ComponentNode.tsx` renders a compact card for a design artifact.

Key behaviors:

- shows icon, tag, label, and short description
- marks whether specs exist
- opens `ComponentConfigModal` on edit or double-click

Components are intentionally design-focused and do not carry runtime behavior.

### `DispatchModal`

`DispatchModal.tsx` is the current dispatch UI.

It supports:

- selecting which zones participate in a new dispatch
- entering the user prompt
- choosing the model for the coordinator runtime
- toggling plan mode metadata
- listing prior multi-zone dispatches
- resuming a saved dispatch through `window.electron.dispatches.resume(...)`

### `TerminalPanel`

`TerminalPanel.tsx` is the live PTY workspace.

It provides:

- xterm-backed tabs for spawned sessions, with one xterm instance per terminal id persisted across pane moves and tab switches
- docked split panes (`react-resizable-panels`) with drag-to-split + drag-to-reorder tabs; layout persists per project via `loadTerminalLayout` / `saveTerminalLayout`
- a default project shell spawned once per project via `window.electron.terminal.spawnShell(...)` and a `+` button for additional shells
- pop-out terminals (`terminal.popout` / `terminal.dock`) with auto re-dock on popout-window-close
- saved-session resume buttons for Claude, Codex, Gemini, and OpenCode

For coordinated PTYs (zones in a dispatch + the conductor), `TerminalPanel` auto-drives the user-control lock:

- **Acquire** on any non-Enter, non-Arrow keystroke into the terminal (calls `terminal.setUserControl(id, true)`).
- **Release** on Enter — *unless* a slash-command picker is active. A `pendingPickerEnterRef` is armed by any `/` keypress or arrow-key event; the next Enter is absorbed instead of releasing the lock.

Detection runs on `term.onKey` (DOM keydown), not `term.onData`, so protocol chatter (focus reports, mouse motion, cursor-position replies) doesn't trip detection.

Plan-mode dispatches show a "PLAN MODE — waiting for GO" pill in the conductor tab until the user types `GO` on its own line; detection is a second `term.onData` listener with a small line buffer.

Per-zone resume options are populated from `window.electron.zone.listSessions(...)` and from `zone.onSessionCaptured` events fired post-spawn.

### `AssistantPanel`

`AssistantPanel.tsx` is the side-panel embedded coding assistant, mounted into a `ResizablePanel` (right or bottom orientation, persisted in `localStorage`).

Two modes share the panel chrome but each owns its own xterm + PTY id:

- `architecture` — edits `architect-canvas.json` via `ARCHITECT_CANVAS_UPDATE` blocks parsed out of the ANSI-stripped data stream.
- `general` — plain coding assistant with the canvas attached as read-only context; canvas-update parsing is disabled.

Both terminals stay mounted across close / mode-switch / orientation-change, so PTY state and xterm scrollback survive. Resize handling follows the VS Code split (rows broadcast immediately, cols debounced ~100 ms; resizes while hidden are parked and flushed on visibility return).

`AssistantLaunchModal` lets the user pick CLI + model + new-or-resume per mode. Resume replays the session under the runtime + model it was originally captured with — the launcher's pickers only affect "Start new".

## Preload Contract Used By The Renderer

The renderer talks to Electron main only through `window.electron`.

The frontend depends on these groups:

- filesystem: `readDir`, `openDirectory`
- canvas persistence: `saveCanvas`, `loadCanvas`, `watchCanvas`, `unwatchCanvas`, `onCanvasChanged`
- terminal layout: `loadTerminalLayout`, `saveTerminalLayout`
- auth: `auth.getSession`, `auth.login`, `auth.logout`, `auth.onSessionChanged`
- dispatches: `startDispatch`, `dispatches.list`, `dispatches.resume`, `dispatches.delete`, `dispatches.updateSummary`
- zones: `zone.launch`, `zone.listSessions`, `zone.deleteSession`, `zone.updateSessionSummary`, `zone.resetSession`, `zone.onSessionCaptured`
- assistant: `assistant.start`, `assistant.stop`, `assistant.stopMode`, `assistant.listSessions`, `assistant.deleteSession`, `assistant.updateSessionSummary`
- terminal control: `terminal.spawnShell`, `terminal.input`, `terminal.setUserControl`, `terminal.resize`, `terminal.killAll`, `terminal.close`, `terminal.popout`, `terminal.dock`
- terminal streaming: `terminal.onData`, `terminal.onExit`, `terminal.onSpawned`, `terminal.onStatus`, `terminal.onPopoutClosed`

`terminal.setUserControl(id, hasControl)` is the renderer's hook into the per-PTY scheduler-write queue described under `TerminalPanel` above.

## Runtime-Related UI Caveats

The renderer exposes a more uniform UI than the runtime adapters currently implement.

Important caveats:

- zone system prompt injection is only honored as a dedicated CLI argument for Claude
- plan mode is recorded for every dispatch, but only Claude currently consumes it in runtime args
- "Reset conversation" deletes saved zone session metadata generically, but the practical meaning still depends on the underlying runtime session store

## Recommended Reading Order

If you need to understand the frontend quickly, read:

1. `src/renderer/src/types.ts`
2. `src/renderer/src/lib/canvas.ts`
3. `src/renderer/src/App.tsx`
4. `src/renderer/src/components/dispatch/DispatchModal.tsx`
5. `src/renderer/src/components/nodes/ZoneNode.tsx`
6. `src/renderer/src/components/layout/TerminalPanel.tsx`
7. `src/renderer/src/components/layout/AssistantPanel.tsx`
8. `src/preload/index.ts`
