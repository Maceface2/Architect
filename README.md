# Architect

Architect is an Electron desktop app for designing and running multi-agent coding workflows on top of real terminal-native AI CLIs.

Instead of treating an architecture diagram as static documentation, Architect turns the canvas into an execution plan:

- Components describe parts of the system to build.
- Zones define agent ownership over groups of components.
- Edges define dependency and handoff flow.
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

If the canvas has two or more zones:

1. Architect wipes any prior mailbox transport state, then writes `ARCHITECT/manifest.json`, prompt files, mailbox scripts/directories, output folders, and a Mermaid diagram.
2. It pre-spawns one coordinator session called `Architect` plus one PTY per selected zone.
3. The coordinator reads `ARCHITECT/prompts/architect.md`.
4. Each zone reads `ARCHITECT/prompts/<zone>.md`, gets `MBX_*` environment variables, and enters the mailbox listen loop.
5. `startMailboxObserver()` watches `ARCHITECT/mailbox/**`, refreshes `ARCHITECT/mailbox/_index.json`, emits renderer activity events, and injects harness warnings/timeouts when a participant stalls.
6. Zones exchange tasks, results, and handoff messages through mailbox inbox/outbox files rather than `ARCHITECT/tasks/*.md` polling.
7. Each zone still writes progress and interface notes to `ARCHITECT/outputs/<zone>.md` for the preview/status UI.

This gives Architect a file-mediated orchestration model rather than direct inter-agent messaging.

### Single-Zone Dispatch

If the canvas has exactly one zone:

- Architect skips the coordinator entirely.
- The zone launches directly in the project root.
- The user prompt is sent straight to that runtime.
- The dispatch behaves like an interactive single-agent session with canvas context baked in at spawn time.

### Zone Execution Contract

For each zone, Architect generates a system prompt that includes:

- the zone label and description
- upstream and downstream zone references
- enabled tools
- the list of owned components
- component specs
- relevant component-to-component edges
- embedded skill file contents
- the zone behavior text from the UI
- instructions about the project root and `ARCHITECT/` coordination artifacts

Dispatch-specific work is separate from that system prompt:

- System prompt: who the zone is and how it should behave
- Mailbox messages: what the current multi-zone dispatch wants done right now

## `ARCHITECT/` Workspace Layout

Each dispatch uses a project-local coordination directory:

- `ARCHITECT/manifest.json`: normalized dispatch description
- `ARCHITECT/diagram.md`: Mermaid view of the zone graph
- `ARCHITECT/prompts/architect.md`: coordinator instructions
- `ARCHITECT/prompts/<zone>.md`: per-zone system prompt
- `ARCHITECT/mailbox/<participant>/inbox/*.json`: incoming mailbox messages
- `ARCHITECT/mailbox/<participant>/outbox/*.json`: outgoing mailbox messages
- `ARCHITECT/mailbox/_index.json`: live observer snapshot of participant state
- `ARCHITECT/scripts/`: mailbox helper scripts used by zone loops
- `ARCHITECT/outputs/<zone>.md`: progress, handoff notes, completion summaries
- `ARCHITECT/sessions/*.json`: persisted session metadata
- `ARCHITECT/dispatches/*.json`: prior multi-zone dispatch records
- `ARCHITECT/.assistant-context.md`: context file for the architecture assistant

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
- zone system prompt injection is Claude-only
- plan mode is only wired into Claude CLI arguments
- approval behavior differs by runtime

See [docs/agent-behavior.md](docs/agent-behavior.md) for a precise matrix.

## Assistant Panel

Architect also has an interactive "Architecture Assistant" session separate from dispatch.

Its job is to:

- reason about the current canvas
- discuss design tradeoffs
- edit `architect-canvas.json` when asked to change the diagram
- preserve ids, settings, and layout where possible

The assistant gets a generated context file describing:

- the current zones
- the current components
- overlay membership
- current edges
- component palette defaults
- the expected JSON schema for canvas edits

If a prior assistant session exists for the selected runtime and Architect can still resolve it on disk, Architect resumes it. Otherwise it starts fresh.

## IPC Surface

The renderer talks to the main process only through `window.electron` in `src/preload/index.ts`.

Main groups:

- filesystem: `readDir`, `readFile`, `openDirectory`, `getHomeDir`
- canvas persistence: `saveCanvas`, `loadCanvas`, `watchCanvas`
- execution: `runGraph`, `zone.launch`, `zone.listSessions`, `zone.resetSession`, `dispatches.resume`
- assistant: `assistant.start`, `assistant.stop`
- terminal control: `terminal.spawnShell`, `terminal.input`, `terminal.resize`, `terminal.killAll`, `terminal.popout`
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
- Multi-zone orchestration still depends on filesystem mailbox observation rather than richer runtime-native lifecycle hooks.
- System prompt injection is still Claude-only, even though session capture and resume now span all supported runtimes.
- The system prompt field is presented as a generic zone feature, but only Claude currently receives it as a first-class CLI argument.

## Additional Docs

- [docs/agent-behavior.md](docs/agent-behavior.md): deep dive on runtime behavior, orchestration, and feature gaps
- [docs/frontend.md](docs/frontend.md): current frontend-oriented implementation notes
