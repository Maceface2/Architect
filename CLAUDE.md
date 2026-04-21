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

Architect is an **Electron + React** desktop app that lets users visually compose multi-agent systems using a drag-and-drop canvas, then dispatch them as real Claude Code CLI sessions.

### Process model

```
Main process (src/main/)
  ├── index.ts             — BrowserWindow setup, IPC handlers (file system, graph execution)
  ├── terminals.ts         — node-pty management, prompt building, runGraph / runZone / resumeDispatch
  ├── sessionCapture.ts    — per-runtime session-id capture (claude/codex/gemini/opencode) + per-zone history store
  └── dispatchCapture.ts   — per-dispatch record store (summary, zone session pins)

Preload (src/preload/index.ts)
  └── Exposes window.electron via contextBridge: readDir, runGraph, terminal.*, zone.*, dispatches.*, assistant.*

Renderer (src/renderer/src/)
  ├── App.tsx        — Root: DirectoryGate → ArchitectFlow (tab layout: Canvas / Files / Terminal)
  ├── types.ts       — All shared types (ZoneNodeData, ZoneSessionRecord, DispatchRecord, DispatchRequest, etc.)
  ├── components/layout/    — TopNav, Sidebar, AgentLog, FilesPanel, TerminalPanel, ResizablePanel
  ├── components/nodes/     — ZoneNode, ComponentNode, AgentConfigModal, ZoneLaunchModal
  ├── components/dispatch/  — DispatchModal (tabbed: new dispatch / resume previous)
  ├── components/palette/   — PaletteItem (drag source)
  └── data/componentPalette.ts — Pre-defined node templates (infrastructure/services/storage)
```

### Execution flow

Note: Overseer = "Architect" (the coordinator agent).

The canvas exposes two launch flows, both binary-choice (start new vs. resume previous):

**Flow A — single-zone launch** (Play button on a zone → `ZoneLaunchModal`):
1. Modal shows a "Start new session" input + scrollable history of prior `ZoneSessionRecord` entries for this zone.
2. User picks one — "new" submits `zone.launch({ mode: 'new', summary? })`; "resume <row>" submits `zone.launch({ mode: 'resume', sessionId })`.
3. Main process (`terminals.ts → runZone`) spawns one PTY for just that zone. Fresh spawns snapshot the runtime's session store pre-spawn, then poll post-spawn to capture the new session id.

**Flow B — multi-zone dispatch** (TopNav Dispatch button → `DispatchModal`):
1. "New dispatch" tab: user enters prompt + model + plan mode → `runGraph(nodes, edges, cwd, settings, { userPrompt, model, planMode, onlyZoneIds? }, dispatchContext?)`.
2. "Resume previous" tab: scrollable history of prior `DispatchRecord` entries → `dispatches.resume({ dispatchId, nodes, edges, settings })`.
3. On a fresh dispatch, `runGraph` creates the `ARCHITECT/` workspace:
    - `ARCHITECT/manifest.json` — full graph description
    - `ARCHITECT/prompts/overseer.md` — Overseer's coordination instructions
    - `ARCHITECT/prompts/<agent>.md` — per-agent role prompt
    - `ARCHITECT/tasks/` — written by Overseer at runtime
    - `ARCHITECT/outputs/` — written by agents at runtime
4. One PTY is spawned per zone plus one Overseer session. Each session owns a `@xterm/headless` `Terminal` instance; PTY bytes are fed into it and cue detection runs against the rendered screen grid (not raw ANSI bytes). Ready = bottom non-empty row ends with a known prompt glyph (`>` / `❯` / `›` / `>>>` / `$` / `#`).
5. Overseer reads its prompt and coordinates; the main process watches `ARCHITECT/tasks/<agent>.md` (via `fs.watch`) and dispatches tasks to the matching agent PTY using the three-stage protocol (see "Architect ↔ zone protocol" below).
6. Each zone's captured session id is upserted into the `DispatchRecord` so "Resume previous" can replay the exact same coordinator + pinned zone sessions.
7. Terminal I/O streams to the renderer via `terminal:data` / `terminal:exit` / `terminal:status` IPC events.

**Big Change on Save**: if the canvas was previously dispatched and zone config changed, clicking Save auto-opens the dispatch modal with a prefilled prompt describing the diff (added / updated / removed zones).

### Architect ↔ zone protocol (v3)

Coordination between the Overseer and zone agents is file-based and verifiable. `DISPATCH_PROTOCOL_VERSION = 3` (in `dispatchCapture.ts`); v2 resumes are rejected with `legacy-protocol`.

**Three-stage round**: each time the Overseer writes a task file, the harness generates a short `task_id` (hex) and embeds it in the poke message. The zone agent must:

1. **Ack** — echo `ARCHITECT_TASK_ACK <task_id>` before doing anything else. Harness detects this on the rendered screen and flips status `running → ack`. Missing ack within 45s → `blocker.kind = 'delivery-failed'`.
2. **Progress** — append to `ARCHITECT/outputs/<safe>.md` as work progresses. Harness polls mtime every 15s as a heartbeat. Stale mtime for 90s → `blocker.kind = 'idle-stuck'`.
3. **Receipt** — write structured JSON to `ARCHITECT/outputs/<safe>.receipt.json`: `{ task_id, result: 'success' | 'blocked' | 'failed', summary, durationMs }`, then echo `ARCHITECT_COMPLETE <task_id>`. Harness watches the file via `fs.watch`; on match, state flips to `done` (or `blocked` if `result !== 'success'`). Old receipts are archived as `<safe>.receipt.<round>.json`.

**Per-task timeout**: `DEFAULT_TASK_TIMEOUT_MS = 30 * 60_000` (30 min), overridable via `ZoneNodeData.behavior.timeoutMs`. On fire: `blocker.kind = 'task-timeout'`. PTY stays alive; resolution is left to the Architect/user.

**`ARCHITECT/zones/<safe>/status.json`** — written by the harness, polled by the Overseer via `jq`:
```ts
interface ZoneStatus {
  round: number
  state: 'idle' | 'running' | 'ack' | 'done' | 'blocked' | 'failed'
  taskId: string | null
  lastTaskHash: string | null
  startedAt: string | null
  acknowledgedAt: string | null
  lastActivityAt: string | null    // mtime of outputs/<safe>.md
  completedAt: string | null
  blocker: { kind, message, since } | null
  receipt: { result, summary, durationMs } | null
}
```

Blocker kinds: `delivery-failed | idle-stuck | task-timeout | pty-exit | malformed-completion | zone-reported`. The Overseer prompt (`buildArchitectPrompt` in `terminals.ts`) documents how to react per-kind (overwrite task file to re-poke, escalate to user, etc.). A non-null `blocker` means do NOT keep polling — resolve or escalate.

**Ready detection** uses `renderScreenText(term)` — walks `term.buffer.active` and calls `getLine(i).translateToString(true)` per row, so prompt cues match on clean text regardless of ANSI escape codes. The regex-on-raw-bytes approach was removed.

**Lifecycle state machine**: `spawning → ready → running → finished | failed`. Broadcast via `terminal:status` IPC. `ready` via prompt cue on rendered screen; `running` on `sendPrompt`; `finished` on successful receipt; `failed` on PTY exit / binary-missing / startup timeout. `blocked` is a soft-failure on `status.json` (task-level) that the Architect can recover from without the PTY being terminal.

### Session & dispatch persistence

Storage lives under the project's `ARCHITECT/` directory:

- `ARCHITECT/sessions/<zoneKey>/<sessionId>.json` — one file per captured zone session: `{ runtime, sessionId, capturedAt, summary, dispatchId? }`. Oldest entries are pruned past `MAX_ZONE_SESSIONS = 20`. Legacy single-file layout (`sessions/<zoneKey>.json`) is migrated transparently on first read.
- `ARCHITECT/dispatches/<architectSessionId>.json` — one file per dispatch: `{ architectSessionId, architectRuntime, zoneIds, zoneLabels, zoneSessions[], userPrompt, summary, model, planMode, timestamp, protocolVersion }`. The `zoneSessions` array pins each zone's `sessionId` so resume always replays the same conversation set. `protocolVersion: 3` is required for resume; older dispatches fail with `legacy-protocol`.
- `ARCHITECT/zones/<safe>/status.json` — per-zone coordination state (see "Architect ↔ zone protocol" above). Ephemeral per dispatch.
- `ARCHITECT/outputs/<safe>.receipt.json` — structured completion receipt for the current round. Previous rounds are archived as `<safe>.receipt.<round>.json`.

**Runtime-specific capture** (sessionCapture.ts):
- Claude: polls `~/.claude/projects/<sanitized-cwd>/*.jsonl` for a new UUID
- Codex: walks `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, filters by `payload.cwd` and primary (non-subagent)
- Gemini: checks both hash-based and slug-based dirs under `~/.gemini/tmp/*/chats/`; filters by `projectHash` and `kind !== 'subagent'`
- OpenCode: spawns `opencode session list --format json` under a PTY (CLI requires TTY for stdout)

`isRecordReachable` revalidates codex/gemini session ids against on-disk files before resume; stale entries fail fast with `session-not-found`.

### Skills system

`skills/` at the repo root contains markdown skill files (`SKILL.md`) grouped by topic (e.g., `skills/python-testing/SKILL.md`). Node agents can be assigned skills; their content is embedded verbatim into the agent's prompt. Built-in skills are referenced as `builtin:<skill-folder-name>`, custom skills as `custom:<absolute-path>`.

### IPC surface

All renderer ↔ main communication goes through `window.electron` (defined in preload):

- `readDir / readFile / getHomeDir / openDirectory` — file system ops
- `saveCanvas / loadCanvas / watchCanvas / unwatchCanvas / onCanvasChanged` — canvas persistence + external-edit watcher
- `runGraph` — start multi-zone dispatch, returns `TerminalInfo[]`
- `terminal.spawnShell / terminal.input / terminal.resize / terminal.killAll` — PTY control
- `terminal.onData / terminal.onExit / terminal.onSpawned / terminal.onStatus / terminal.popout / terminal.dock` — terminal streaming, lifecycle state broadcasts, popout windows
- `zone.launch({ mode: 'new' | 'resume', sessionId?, summary?, ... })` — spawn or resume a single zone
- `zone.listSessions / zone.deleteSession / zone.updateSessionSummary / zone.resetSession` — per-zone history management
- `zone.onSessionCaptured` — broadcast when a fresh spawn captures its CLI session id (event includes `summary` and optional `dispatchId`)
- `dispatches.list / dispatches.delete / dispatches.updateSummary / dispatches.resume` — per-dispatch record management; `resume` replays coordinator + all pinned zone sessions
- `assistant.start(projectDir, contextMd, runtime, mode) / assistant.stop` — side-panel assistant. `mode: 'architecture' | 'general'` selects the prompt/behavior: architecture mode edits `architect-canvas.json` via `ARCHITECT_CANVAS_UPDATE` blocks; general mode is a plain coding assistant with the canvas attached as read-only reference. Each mode has its own sanitized zone key (`Architecture_Assistant_Design` / `Architecture_Assistant_General`) and PTY id (`architect-assistant-architecture` / `architect-assistant-general`), so session history and resume points are independent per mode. `assistant.stop()` tears down both.

### Styling

Tailwind CSS with custom colors defined in `index.css`: `bg-canvas` (`#111111`), `bg-surface`, `bg-accent` (`#3d3dbf`), etc.

## VS Code reference

Architect is an Electron app and shares many low-level concerns with VS Code (shell env resolution, PTY management, IPC patterns, packaged-app PATH issues, etc.). When solving a non-trivial Electron/Node problem, check how VS Code handles it first:

- Source: https://github.com/microsoft/vscode (fetch raw files via `https://raw.githubusercontent.com/microsoft/vscode/main/<path>`)
- Useful areas:
    - `src/vs/platform/shell/node/shellEnv.ts` — login shell environment resolution (already ported)
    - `src/vs/platform/terminal/node/` — PTY lifecycle, environment, shell detection
    - `src/vs/workbench/contrib/terminal/` — terminal UI patterns
    - `src/vs/base/node/` — Node.js utilities (shell detection, fs helpers, processes)
    - `src/vs/platform/environment/node/` — packaged-app path resolution

Before implementing anything related to: shell spawning, PATH resolution, PTY management, app packaging, IPC design, or file watching — check the VS Code source for a proven approach.

VS Code also uses `@xterm/headless` for server-side terminal state (the same pattern Architect now uses for agent cue detection). If adjusting `renderScreenText` or adding new screen-based detectors, reference `src/vs/platform/terminal/node/terminalProcess.ts` and related files.

## graphify

This project has a graphify knowledge graph at graphify-out/.

Rules:

- Before answering architecture or codebase questions, read graphify-out/GRAPH_REPORT.md for god nodes and community structure
- If graphify-out/wiki/index.md exists, navigate it instead of reading raw files
- After modifying code files in this session, run `graphify update .` to keep the graph current (AST-only, no API cost)
