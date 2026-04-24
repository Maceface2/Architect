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
├── data/
│   └── componentPalette.ts             # Built-in component presets
└── components/
    ├── dispatch/
    │   └── DispatchModal.tsx           # New dispatch / resume previous dispatch
    ├── layout/
    │   ├── TopNav.tsx                  # Header, tabs, dispatch button, assistant controls
    │   ├── Sidebar.tsx                 # Palette and component browser
    │   ├── FilesPanel.tsx              # Project file browser
    │   ├── TerminalPanel.tsx           # Multi-session terminal workspace
    │   ├── PreviewPanel.tsx            # Per-zone output tail + localhost iframe preview
    │   └── terminalLayout*.ts          # Terminal docking/splitting state
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

- label, description, color, status
- `systemPrompt`
- runtime selection via `agentRuntimeMode` + `agentRuntime`
- per-runtime model overrides in `providerModels`
- `skills`, `tools`, `behavior`, `permissions`, `envVars`

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
- loads/saves `architect-canvas.json`
- normalizes canvas data
- tracks tabs for Canvas / Files / Terminal / Preview
- builds assistant context
- opens `DispatchModal`
- calls `window.electron.runGraph(...)` for new dispatches
- calls `window.electron.dispatches.resume(...)` for saved multi-zone dispatches

The canvas stays mounted while the user switches tabs so React Flow state, selection, and node geometry do not reset.

## Canvas Model

The canvas is a mixed graph of zones and components.

### Zone ownership

Component ownership is geometric, not edge-based. A component belongs to the smallest zone whose bounding box contains the component's center. This is why the renderer preserves zone position and dimensions carefully and why zone resizing matters at dispatch time.

### Drag/drop and defaults

The sidebar emits palette payloads through `application/architect-node`. `App.tsx` converts those payloads into either:

- a new zone with default runtime-aware agent config
- a new component with the selected category/icon/color/tag preset

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

`TerminalPanel.tsx` is the live PTY workspace, not a placeholder.

It provides:

- xterm-backed tabs for spawned sessions
- docked split panes with persistent layout
- a project shell tab via `window.electron.terminal.spawnShell(...)`
- pop-out terminals
- saved-session resume buttons for Claude, Codex, Gemini, and OpenCode

Per-zone resume options are populated from `window.electron.zone.listSessions(...)`.

### `PreviewPanel`

`PreviewPanel.tsx` reads `ARCHITECT/outputs/<zone>.md` for each zone and shows:

- the latest tail of zone status/output notes
- runtime badges per zone
- a localhost iframe preview when the output contains a preview URL

This panel is intentionally lightweight: it watches output artifacts, not the full scheduler state. Live per-zone status badges come from the `activity:state` IPC broadcasts emitted by the scheduler's tick loop.

## Preload Contract Used By The Renderer

The renderer talks to Electron main only through `window.electron`.

The frontend depends heavily on these groups:

- filesystem: `readDir`, `readFile`, `openDirectory`, `getHomeDir`
- canvas persistence: `saveCanvas`, `loadCanvas`, `watchCanvas`, `unwatchCanvas`
- dispatches: `startDispatch`, `dispatches.list`, `dispatches.resume`, `dispatches.delete`, `dispatches.updateSummary`
- zones: `zone.launch`, `zone.listSessions`, `zone.deleteSession`, `zone.updateSessionSummary`, `zone.resetSession`, `zone.onSessionCaptured`
- terminals: `terminal.spawnShell`, `terminal.input`, `terminal.resize`, `terminal.close`, `terminal.popout`, `terminal.dock`
- streaming events: `terminal.onData`, `terminal.onExit`, `terminal.onStatus`, `terminal.onCaptureState`, `activity.onEvent`, `activity.onState`, `activity.onDispatchComplete`

`activity.onEvent` fires once per appended activity-log line (zone progress, Conductor decisions, failures). `activity.onState` fires on scheduler-emitted `ParticipantStatus` transitions. `activity.onDispatchComplete` fires once when the Conductor emits a `{type:'final', summary}` decision.

Older names `runGraph`, `zone.run`, `zone.resume`, `zone.getSession`, top-level `listDispatches`, and `mailbox.onActivity` are not part of the current API contract.

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
7. `src/preload/index.ts`
