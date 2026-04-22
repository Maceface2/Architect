# CLAUDE.md / AGENTS.md

This file provides guidance to Claude Code, Codex CLI, and any other agent tooling that reads `CLAUDE.md` or `AGENTS.md` from a project root. Both filenames resolve to this file — `AGENTS.md` is a symlink to `CLAUDE.md`, so editing one edits both.

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
  ├── terminals.ts         — node-pty management, prompt building, startDispatch / runZone / resumeDispatch, mailbox observer
  ├── mailbox.ts           — v4 mailbox protocol: message schema, atomic writes, script templates, _index.json writer
  ├── sessionCapture.ts    — per-runtime session-id capture (claude/codex/gemini/opencode) + per-zone history store
  └── dispatchCapture.ts   — per-dispatch record store (summary, zone session pins, dispatchId)

Preload (src/preload/index.ts)
  └── Exposes window.electron via contextBridge: readDir, startDispatch, terminal.*, zone.*, dispatches.*, assistant.*, mailbox.*

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

1. "New dispatch" tab: user enters prompt + model + plan mode → `startDispatch(nodes, edges, cwd, settings, { userPrompt, model, planMode, onlyZoneIds? }, dispatchContext?)`.
2. "Resume previous" tab: scrollable history of prior `DispatchRecord` entries → `dispatches.resume({ dispatchId, nodes, edges, settings })`.
3. **Every entry into a dispatch** (fresh, redispatch, or resume) first calls `wipeMailboxTree(projectDir)` — `ARCHITECT/mailbox/` is pure communication state and starts clean on every run. `setupWorkspace` then rebuilds the workspace:
    - `ARCHITECT/manifest.json` — full graph description
    - `ARCHITECT/prompts/architect.md` — Overseer's drain-and-plan loop instructions
    - `ARCHITECT/prompts/<safe>.md` — per-zone listen-and-respond loop instructions (in `dispatch` mode for multi-zone, `solo` mode for single-zone/runZone)
    - `ARCHITECT/scripts/mailbox-*.sh` — the five mailbox shell scripts (+x bit set)
    - `ARCHITECT/mailbox/overseer/` + `ARCHITECT/mailbox/<safe>/` — per-participant `{inbox/, outbox/, .tmp/, manifest.json}`
    - `ARCHITECT/outputs/` — progress scratchpads, _not_ wiped (historical narrative persists)
4. One PTY is spawned per zone plus one Overseer session. Each agent is spawned with `MBX_ROOT`, `MBX_SELF`, `MBX_SELF_LABEL`, `MBX_DISPATCH_ID`, and `MBX_SCRIPTS` env vars so the mailbox shell scripts can run without additional configuration. Each session owns a `@xterm/headless` `Terminal` instance; PTY bytes are fed into it but the headless emulator is only used for the `spawning → ready` prompt-glyph cue at bootstrap — there is no per-task cue detection in v4.
5. Overseer gets its full prompt as `initialPrompt` (the architect.md content); zones get a short bootstrap `initialPrompt` ("Read your prompt file and enter your listen loop now") plus their role prompt baked into `--append-system-prompt` (Claude-only, currently). All agents enter their respective mailbox loops on first turn.
6. The harness starts the **mailbox observer** (`startMailboxObserver`), which watches every participant's inbox/outbox via `fs.watch`, refreshes `ARCHITECT/mailbox/_index.json` on activity, broadcasts `mailbox:activity` IPC events to the renderer, and injects synthetic harness events when zones stall (see "Mailbox protocol" below).
7. Each zone's captured CLI session id is upserted into the `DispatchRecord` so "Resume previous" can replay the exact same coordinator + pinned zone sessions.
8. Terminal I/O streams to the renderer via `terminal:data` / `terminal:exit` / `terminal:status` IPC events. Mailbox activity streams via the additive `mailbox:activity` channel.

**Big Change on Save**: if the canvas was previously dispatched and zone config changed, clicking Save auto-opens the dispatch modal with a prefilled prompt describing the diff (added / updated / removed zones).

### Mailbox protocol (v4)

Coordination between the Overseer and zone agents is **peer-to-peer message passing via per-participant inboxes**, inspired by `PatilShreyas/claude-code-session-bridge`. `DISPATCH_PROTOCOL_VERSION = 4` (in `dispatchCapture.ts`); v3 and older resumes are rejected with `legacy-protocol`.

**Key shift from v3**: the harness does not poke the zone PTY with per-task instructions and does not scrape the rendered screen for `ARCHITECT_TASK_ACK` / `ARCHITECT_COMPLETE` sentinels. All per-task delivery flows through JSON message files; the only PTY write the harness does is a one-shot bootstrap at spawn time telling the agent to enter its loop.

#### Participants

Each participant owns a directory under `ARCHITECT/mailbox/`:

- `overseer` — the Architect/coordinator agent
- `<safe>` — each zone, using `sanitize(zone.data.label)` (same identity as v3 filenames)
- `__harness__` — reserved sender id for synthetic events the harness injects into the Overseer's inbox

Layout per participant:

```
ARCHITECT/mailbox/<id>/
  manifest.json              # { participantId, role, label, protocolVersion, startedAt, lastHeartbeat }
  inbox/<iso-ts>-<msgid>.json
  outbox/<iso-ts>-<msgid>.json   # sender's audit copy, status=read
  .tmp/                      # staging for mktemp+rename atomic writes
```

Filenames are `<ISO-timestamp>-<msg-id>.json` so lexicographic ordering = chronological FIFO. Tempfiles live in the sibling `.tmp/`, never the inbox — every reader filters by `*.json`.

#### Message schema

Defined in `src/main/mailbox.ts`:

```ts
interface MailboxMessage {
    id: string; // "msg-<12 hex>"
    from: string; // participantId
    to: string;
    type:
        | "task"
        | "result"
        | "question"
        | "answer"
        | "cancel"
        | "session-ended"
        | "harness.pty-exit"
        | "harness.delivery-warning"
        | "harness.heartbeat-missed"
        | "harness.timeout"
        | "harness.wake"
        | "harness.backpressure";
    timestamp: string; // ISO8601
    status: "pending" | "read";
    content: string;
    structured: { taskId?; result?; durationMs?; blocker?; round? } | null;
    inReplyTo: string | null;
    metadata: { dispatchId: string; protocolVersion: 4; fromLabel: string };
}
```

All writes are atomic: `mktemp` in the target's `.tmp/` sibling dir, then `mv` (same-filesystem rename). Schema validation runs inside `mailbox-send.sh` (jq + type-whitelist) so malformed sends exit non-zero before the file materializes.

#### Agent loops

**Zone (worker)** runs `bash $MBX_SCRIPTS/mailbox-listen.sh <safe>` as a bash tool call. The script polls its own inbox every 2s, returns the first `pending` message (marked `read` atomically), or blocks indefinitely. On return the agent processes the message, sends a `result` / `question` / etc. via `mailbox-send.sh`, and **immediately re-enters** the listen loop. This is prescribed by `buildZoneSystemPrompt(..., 'dispatch')`.

**Overseer (planner)** runs `mailbox-listen.sh overseer 30` (30s timeout so the loop unblocks periodically even when idle), then `mailbox-drain.sh overseer` to pull all accumulated pending messages as a JSON array at once. Reasons over the batch, plans, dispatches new `task` messages, and loops. Prescribed by `buildArchitectPrompt`.

Asymmetry is intentional: zones are workers (one at a time); the Overseer is a scheduler (batched reasoning over accumulated results).

#### Harness role (shrunken from v3)

`startMailboxObserver` in `terminals.ts` is an observer + synthetic-event injector. It does NOT poke PTYs after bootstrap, does NOT scrape screens for ack/complete, does NOT write `status.json` (there is no `status.json`).

What it does:

1. Spawns PTYs; captures CLI session IDs; writes prompts, scripts, participant manifests.
2. One bootstrap `sendPrompt` per session at first-ready — tells the agent to read its prompt file and enter its loop. Per-task delivery never touches the PTY.
3. Watches every participant's inbox + outbox via `fs.watch`, broadcasts `mailbox:activity` IPC on each write, refreshes `ARCHITECT/mailbox/_index.json` (harness-owned observability snapshot).
4. For outgoing `task` messages, arms two timers:
    - `DELIVERY_WARNING_MS` (45s) — if still `pending` in the zone's inbox, inject `harness.delivery-warning` to Overseer + `harness.wake` to the zone
    - `DEFAULT_TASK_TIMEOUT_MS` (30min) — if no matching `result` arrives, inject `harness.timeout`
5. Runs a heartbeat scan every 15s; fires `harness.heartbeat-missed` for any in-flight task where BOTH `outputs/<safe>.md` mtime AND PTY `lastActivityMs` have been quiet for `IDLE_THRESHOLD_MS` (2 min). Either signal advancing keeps the zone considered alive; the OR prevents false positives during long tool calls where the agent isn't appending progress notes.
6. On zone PTY exit: injects `harness.pty-exit`, flips the participant to `state: 'exited'` in `_index.json`, but preserves the mailbox dir as a tombstone so the Overseer gets a structured answer ("exited + final tail") if it asks about the dead zone later.
7. Two-tier cancel: soft `cancel` message is consumed by the zone on its next listen turn; hard-cancel fires SIGINT to the zone PTY after `HARD_CANCEL_MS` (60s) of unconsumed pending `cancel`.
8. Deduplication: `fs.watch` on macOS fires multiple events per atomic rename, so `scheduleTaskTimers` no-ops if `taskTrackers.has(msg.id)` — otherwise you'd get duplicate `harness.*` events per task.

#### `_index.json` — single pane of glass (replaces v3's `status.json`)

```ts
interface MailboxIndex {
    dispatchId: string;
    protocolVersion: 4;
    updatedAt: string;
    participants: Record<
        string,
        {
            role: "overseer" | "zone" | "harness";
            label: string;
            state: "starting" | "running" | "idle" | "exited" | "unknown";
            lastActivityMs: number;
            exitCode?: number;
            pendingTaskIds: string[];
            inboxPending: number;
            outboxCount: number;
            tail: string; // last N bytes of PTY output — debugger view
        }
    >;
}
```

`state: 'unknown'` is valid — used when a participant has no recent PTY activity AND no pending inbox work (can't distinguish "thinking silently" from "loop broken"). The Overseer's prompt treats `unknown` as "probably fine, check back on next listen tick."

The Overseer does NOT probe `~/.claude/`, process tree, or CLI-native session stores to ask "is zone X alive / what's it doing?" Those are eventually consistent. Every question is answered via its own inbox or a `mailbox-status.sh` call. Existence = `_index.json.participants.has(<id>)`.

#### v3 → v4 blocker-kind mapping

| v3 `blocker.kind`                | v4 equivalent                                                                      |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| `delivery-failed` (no ack 45s)   | `harness.delivery-warning` + `harness.wake` nudge                                  |
| `idle-stuck` (outputs stale 90s) | `harness.heartbeat-missed` (2 min, BOTH outputs + PTY must be quiet)               |
| `task-timeout` (30min)           | `harness.timeout`                                                                  |
| `pty-exit`                       | `harness.pty-exit`                                                                 |
| `malformed-completion`           | validation at send time; malformed content → `result.structured.result = 'failed'` |
| `zone-reported`                  | `result` with `structured.result ∈ {blocked, failed}`                              |

#### Ready detection (bootstrap only)

`renderScreenText(term)` is still used for the `spawning → ready` transition at PTY boot (walks `term.buffer.active`, calls `line.translateToString(true)`, matches on known prompt glyphs `>` / `❯` / `›` / `>>>` / `│ >` etc). That's the only remaining screen-grid read in v4. Per-task cue detection was deleted.

#### Lifecycle state machine (simplified)

`spawning → ready → running → failed`. Note `finished` is gone — v4 agents live in a continuous listen loop and only exit via PTY close (which flips to `failed`). Per-task state lives in `_index.json.participants[*].state`, not the session lifecycle. Broadcast via `terminal:status` IPC.

### Session & dispatch persistence

Storage lives under the project's `ARCHITECT/` directory. Durable vs. ephemeral matters:

**Durable (survives dispatch teardown)**:

- `ARCHITECT/sessions/<zoneKey>/<sessionId>.json` — one file per captured zone session: `{ runtime, sessionId, capturedAt, summary, dispatchId? }`. Oldest entries pruned past `MAX_ZONE_SESSIONS = 20`. Legacy single-file layout migrated on first read. This feeds the ZoneLaunchModal's history picker.
- `ARCHITECT/dispatches/<architectSessionId>.json` — one file per dispatch: `{ architectSessionId, architectRuntime, dispatchId, zoneIds, zoneLabels, zoneSessions[], userPrompt, summary, model, planMode, timestamp, protocolVersion }`. The `zoneSessions` array pins each zone's `sessionId`. `dispatchId` (v4 addition) is the mailbox correlation id stamped on every message's metadata. `protocolVersion: 4` is required for resume; older dispatches fail with `legacy-protocol`.
- `ARCHITECT/outputs/<safe>.md` — narrative progress log. Preserved across dispatches. `isRedispatch` flag in the Architect prompt tells the Overseer to expect prior outputs.

**Ephemeral (wiped on every `startDispatch` / `resumeDispatch`)**:

- `ARCHITECT/mailbox/` — the entire tree. Wiped via `wipeMailboxTree(projectDir)` at the start of every dispatch entry point, then rebuilt fresh. Pure communication state; durable conversation lives in CLI-native session files (`~/.claude/projects/...`, etc.) reloaded via `resumeSessionId`.
- `ARCHITECT/scripts/mailbox-*.sh` — overwritten on every `setupWorkspace` so script fixes land immediately.
- `ARCHITECT/prompts/architect.md` + `ARCHITECT/prompts/<safe>.md` — regenerated from current canvas state per dispatch.

**Why wipe mailbox on resume too**: the dispatch picker lets the user pick any historical dispatch, not just the most recent. By the time they resume an old one, the shared `ARCHITECT/mailbox/` has almost certainly been trampled by later runs, so whatever's on disk is unrelated junk. Durable conversation is in the CLI's own session store.

**Runtime-specific CLI session capture** (sessionCapture.ts):

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
- `startDispatch` — start multi-zone dispatch, returns `TerminalInfo[]`
- `terminal.spawnShell / terminal.input / terminal.resize / terminal.killAll` — PTY control
- `terminal.onData / terminal.onExit / terminal.onSpawned / terminal.onStatus / terminal.popout / terminal.dock` — terminal streaming, lifecycle state broadcasts, popout windows
- `zone.launch({ mode: 'new' | 'resume', sessionId?, summary?, ... })` — spawn or resume a single zone
- `zone.listSessions / zone.deleteSession / zone.updateSessionSummary / zone.resetSession` — per-zone history management
- `zone.onSessionCaptured` — broadcast when a fresh spawn captures its CLI session id (event includes `summary` and optional `dispatchId`)
- `dispatches.list / dispatches.delete / dispatches.updateSummary / dispatches.resume` — per-dispatch record management; `resume` replays coordinator + all pinned zone sessions
- `mailbox.onActivity` — additive v4 channel broadcasting one event per inbox/outbox write: `{ dispatchId, participantId, direction: 'inbox' | 'outbox', filename, msgId?, type?, from?, to? }`. Lets the renderer reflect message flow in real time without polling the filesystem. UI consumers are optional — the existing `terminal:status` + raw PTY stream still drive the terminal tabs.
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

VS Code also uses `@xterm/headless` for server-side terminal state. Architect uses the same pattern for the one remaining screen-grid scan (the `spawning → ready` prompt-glyph detector at bootstrap in `renderScreenText`). Per-task cue detection was removed in v4 — all coordination flows through mailbox message files. If you ever reintroduce screen-based detection, reference `src/vs/platform/terminal/node/terminalProcess.ts` for prior art.

## graphify

This project has a graphify knowledge graph at graphify-out/.

Rules:

- Before answering architecture or codebase questions, read graphify-out/GRAPH_REPORT.md for god nodes and community structure
- If graphify-out/wiki/index.md exists, navigate it instead of reading raw files
- After modifying code files in this session, run `graphify update .` to keep the graph current (AST-only, no API cost)
