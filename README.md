# Architect

Architect is an Electron desktop app for designing and running multi-agent coding workflows on top of real terminal-native AI CLIs.

Instead of treating an architecture diagram as static documentation, Architect turns the canvas into an execution plan:

- Components describe parts of the system to build.
- Zones define agent ownership over groups of components.
- Component edges describe dependency/data-flow references with optional labels and direction metadata.
- Dispatch turns the canvas into live CLI sessions coordinated through files in `ARCHITECT/`.

## What The App Does

Architect lets you:

- draw a system as components on a canvas
- overlay one or more zones to assign agent ownership
- choose a default runtime for the project or override it per zone
- attach skills, env vars, models, and behavioral instructions to each zone
- dispatch the graph into live CLI sessions
- inspect agent terminals, outputs, and saved dispatch history
- reopen an architecture assistant that can reason about or edit `architect-canvas.json`

The app is currently designed around four runtime families:

- Claude Code
- Codex CLI
- Gemini CLI
- OpenCode

Runtime support is intentionally uneven today. Architect abstracts them behind one UI, but some features are only implemented for Claude. See [docs/agent-behavior.md](docs/agent-behavior.md) for the exact behavior and current gaps.

## Core Mental Model

Architect has two first-class node types:

### Components

Components are design artifacts. They describe a part of the system such as a frontend, API, worker, queue, database, or auth service.

A component carries:

- label
- short description
- long-form specs
- category
- icon
- color
- tag

Components do not own runtime behavior.

### Zones

Zones are agent containers. Each zone maps to one CLI session when dispatched.

A zone carries:

- label and description
- system prompt / behavior instructions
- runtime selection
- per-runtime model overrides
- skills
- tool flags
- permissions flags
- environment variables

Zone membership is geometric, not edge-based. A component belongs to the smallest zone whose bounding box contains the component center. If a component is outside every zone, it remains a design-only artifact and no agent is spawned for it.

## Runtime Architecture

Architect uses Electron's normal three-part split:

- `src/main/`: process control, PTY spawning, filesystem coordination, IPC handlers
- `src/preload/`: typed bridge exposing `window.electron`
- `src/renderer/src/`: React canvas, layout, dispatch UI, terminal UI, zone/component editors

Important files:

- `src/main/terminals.ts`: dispatch orchestration, prompt generation, runtime argument mapping, session lifecycle
- `src/main/index.ts`: Electron boot and IPC registration
- `src/main/sessionCapture.ts`: session capture and resume helpers for Claude, Codex, Gemini, and OpenCode
- `src/shared/agentRuntimes.ts`: runtime catalog, labels, binaries, default models
- `src/renderer/src/App.tsx`: canvas model, assistant context, dispatch entry point
- `src/renderer/src/components/dispatch/DispatchModal.tsx`: dispatch prompt/model/plan UI
- `src/renderer/src/components/nodes/AgentConfigModal.tsx`: zone runtime/model/system prompt editor

## Dispatch Flow

When you dispatch a graph, Architect translates the canvas into a filesystem-based coordination workspace in the selected project directory.

### Multi-Zone Dispatch

If the canvas has two or more selected zones, Architect uses the **v5 Conductor protocol** — live PTYs coordinated by append-only activity logs and scheduler-delivered user turns.

1. Architect writes a v5 workspace: `ARCHITECT/manifest.json`, `ARCHITECT/prompts/conductor.md`, one prompt per zone, and `ARCHITECT/runtime/<dispatchId>/` activity/state/task directories.
2. It spawns each zone PTY serially so runtime session capture cannot collide. Each zone receives its role prompt and a tiny bootstrap turn that makes the CLI materialize a resumable session.
3. It spawns one `Conductor` PTY. The Conductor receives the user task and emits one structured decision line, usually `{type:"assign"}`.
4. The Scheduler watches each participant's JSONL activity log with `fs.watch`. When the Conductor assigns work, the Scheduler writes `TASK <taskId>: <body>` directly into the target zone PTY. Zones report back by appending `done`, `failed`, or `ask` activity lines.
5. The Conductor decides follow-up work from the user task, zone/component context, component-edge reference context, and reported results. Canvas edges do not order zones or schedule work.

This gives Architect a coordination model that works across Claude, Codex, Gemini, and OpenCode. See [docs/orchestration.md](docs/orchestration.md), [docs/agent-behavior.md](docs/agent-behavior.md), and `CLAUDE.md` for the full protocol spec.

### Single-Zone Dispatch

If the canvas has exactly one zone:

- Architect skips the coordinator entirely.
- The zone launches directly in the project root.
- The user prompt is sent straight to that runtime.
- The dispatch behaves like an interactive single-agent session with canvas context baked in at spawn time.

### Zone Execution Contract

For each zone, Architect generates a system prompt that includes:

- the zone label and description
- enabled tools
- the list of owned components
- component specs
- component-level reference edges, including optional labels and directions, as context only; they do not drive zone scheduling
- embedded skill file contents
- the zone behavior text from the UI
- instructions about the project root and `ARCHITECT/` coordination artifacts

Zone prompts and zone tasks are separate layers:

- **Role prompt**: who the agent is and how it should behave — zone identity, components, component-edge context, skills, and, in dispatch mode, the activity-log reporting contract. Baked in at spawn through the runtime adapter.
- **Task turn**: what this specific dispatch wants built right now — delivered as a normal PTY user turn formatted as `TASK <taskId>: <body>`.

The prompt builders emit two variants: `buildZonePrompt` for multi-zone dispatches and `buildSoloZonePrompt` for single-zone launches where the user prompts the agent directly.

## `ARCHITECT/` Workspace Layout

Each dispatch uses a project-local coordination directory:

**Generated per dispatch** (regenerated on every `startDispatch` / `resumeDispatch`):
- `ARCHITECT/manifest.json`: normalized dispatch description
- `ARCHITECT/prompts/conductor.md`: Conductor prompt
- `ARCHITECT/prompts/<zone>.md`: per-zone prompt
- `ARCHITECT/runtime/<dispatchId>/activity/<participant>.jsonl`: append-only activity logs
- `ARCHITECT/runtime/<dispatchId>/state/<participant>.kv`: scheduler-maintained participant state
- `ARCHITECT/runtime/<dispatchId>/tasks/<taskId>.json`: scheduler task snapshots

**Durable (survives dispatches)**:
- `ARCHITECT/outputs/<zone>.md`: narrative progress scratchpad — zones append as they work
- `ARCHITECT/sessions/<zoneKey>/<sessionId>.json`: captured CLI session records, feeds the ZoneLaunchModal history picker
- `ARCHITECT/dispatches/<architectSessionId>.json`: prior multi-zone dispatch records — pins each zone's CLI session id for resume

Project code is never meant to be written into `ARCHITECT/`. Agents are told to create actual source files in the project root working directory.

## Supported Runtime Features

Architect standardizes a few things across all runtimes:

- binary discovery from `PATH`
- per-zone runtime selection
- per-runtime model text
- PTY-backed terminals in the UI
- project-root working directory
- environment variable injection per zone

But runtime parity is incomplete:

- Claude has the deepest integration.
- Codex and Gemini have working launch support but less stateful behavior.
- OpenCode is the thinnest adapter.

The practical consequences:

- session persistence and resume are implemented for Claude, Codex, Gemini, and OpenCode when Architect can locate the saved runtime session
- role prompt delivery works through the runtime adapter: Claude receives `--append-system-prompt`; Codex, Gemini, and OpenCode receive an inline `<<SYSTEM>>…<<END>>` fold in the first prompt
- plan mode is only wired into Claude CLI arguments
- approval behavior differs by runtime

See [docs/agent-behavior.md](docs/agent-behavior.md) for a precise matrix.

## Assistant Panel

Architect has a side-panel embedded coding assistant separate from dispatch. It runs in one of two modes, each with its own PTY and session history:

- **Architecture mode**: reasons about the canvas and edits `architect-canvas.json` directly when asked to change the diagram. Preserves ids, settings, and layout where possible.
- **General mode**: a plain coding assistant with the canvas attached as read-only context. Will not modify `architect-canvas.json`.

The assistant context describes the current zones, components, overlay membership, component edges (with optional labels and directions), and — for architecture mode — the expected JSON schema for canvas edits.

The launcher modal lets you pick CLI + model + new-or-resume per mode. Resuming replays the session under the runtime + model it was originally captured with.

## IPC Surface

The renderer talks to the main process only through `window.electron` in `src/preload/index.ts`.

Main groups:

- filesystem: `readDir`, `openDirectory`
- canvas persistence: `saveCanvas`, `loadCanvas`, `watchCanvas`, `unwatchCanvas`, `onCanvasChanged`
- terminal-layout persistence: `loadTerminalLayout`, `saveTerminalLayout`
- auth: `auth.getSession`, `auth.login`, `auth.logout`, `auth.onSessionChanged`
- execution: `startDispatch`, `zone.launch`, `zone.listSessions`, `zone.resetSession`, `dispatches.resume`
- assistant: `assistant.start`, `assistant.stop`, `assistant.stopMode`, `assistant.listSessions`, `assistant.deleteSession`, `assistant.updateSessionSummary`
- terminal control: `terminal.spawnShell`, `terminal.input`, `terminal.setUserControl`, `terminal.resize`, `terminal.killAll`, `terminal.close`, `terminal.popout`, `terminal.dock`
- history/session reads: `dispatches.list`, `dispatches.delete`, `dispatches.updateSummary`

## Development

### Prerequisites

- Node.js and npm
- macOS support is clearly implemented and packaged; other platforms may work but are not the primary path
- installed agent CLIs on `PATH` for whichever runtimes you want to use:
  - `claude`
  - `codex`
  - `gemini`
  - `opencode`

### Commands

```bash
npm install
npm run dev
npm run build
npm run preview
```

There are currently no configured lint or test scripts.

## Current Limitations

- The docs and UI still carry some Claude-first assumptions.
- Runtime capabilities are not normalized; the abstraction is ahead of the implementation.
- "Tools" and "permissions" are stored in zone config and shown in prompts, but they do not map to a unified enforcement layer across runtimes.
- Multi-zone orchestration is v5 activity-log + `pty.write` coordination. It is intentionally runtime-uniform, but still depends on agents following the prompt contract and appending valid activity-log lines.
- The system prompt field is presented as a generic zone feature, but only Claude currently receives it as a first-class CLI argument.

## Additional Docs

- [docs/agent-behavior.md](docs/agent-behavior.md): deep dive on runtime behavior, orchestration, and feature gaps
- [docs/frontend.md](docs/frontend.md): current frontend-oriented implementation notes
