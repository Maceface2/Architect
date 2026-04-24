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

Architect is an **Electron + React** desktop app that lets users visually compose multi-agent systems using a drag-and-drop canvas, then dispatch them as real CLI sessions. Supported CLIs: **Claude Code**, **Codex**, **OpenCode**, **Gemini** (partial).

### Process model

```
Main process (src/main/)
  ├── index.ts                      — BrowserWindow, IPC handlers (file system, dispatch, assistant, terminal)
  ├── terminals.ts                  — node-pty lifecycle, spawnAgentSession, runZone (solo flow), assistant flow
  ├── sessionCapture.ts             — per-runtime session-id capture (claude/codex/gemini/opencode) + per-zone history store
  ├── dispatchCapture.ts            — DispatchRecord store (v5 schema: zoneSessions, pendingTasks, conductorDecisions)
  │
  ├── runtimes/                     — per-CLI adapters behind one interface
  │   ├── types.ts                  — RuntimeAdapter + SpawnArgs / ResumeArgs / ComposedPrompt
  │   ├── claude.ts / codex.ts /
  │   │   gemini.ts / opencode.ts   — adapters; absorb every `if runtime === 'x'` branch
  │   ├── fold.ts                   — shared inline-system-prompt wrapper (for runtimes without --append-system-prompt)
  │   └── index.ts                  — getRuntimeAdapter(runtime) registry
  │
  └── orchestrator/                 — v5 multi-zone coordination
      ├── activity.ts               — append-only JSONL activity log: schema, append/tail/watch
      ├── state.ts                  — per-participant atomic key=value snapshot
      ├── status.ts                 — multi-signal ParticipantStatus computation
      ├── conductor.ts              — parseDecision + compose*Turn helpers for the conductor PTY
      ├── scheduler.ts              — per-task state machine, activity watchers, status tick
      ├── workspace.ts              — setupWorkspaceV5 (manifest, prompts, state + activity + tasks skeletons)
      ├── dispatch.ts               — startDispatchV5 / resumeDispatchV5 entry points
      └── prompts/
          ├── conductor.ts          — compact conductor.md builder
          ├── zone.ts               — compact <safe>.md builder (multi-zone)
          └── solo.ts               — compact prompt for single-zone runZone launches

Preload (src/preload/index.ts)
  └── Exposes window.electron via contextBridge: readDir, startDispatch, terminal.*, zone.*, dispatches.*,
      assistant.*, activity.{onEvent, onState, onDispatchComplete}

Renderer (src/renderer/src/)
  ├── App.tsx        — Root: DirectoryGate → ArchitectFlow (tab layout: Canvas / Files / Terminal)
  ├── types.ts       — Shared types (ZoneNodeData, ZoneSessionRecord, DispatchRecord, HarnessTimeouts, etc.)
  ├── components/layout/    — TopNav, Sidebar, AgentLog, FilesPanel, TerminalPanel, ResizablePanel
  ├── components/nodes/     — ZoneNode, ComponentNode, AgentConfigModal, ZoneLaunchModal
  ├── components/dispatch/  — DispatchModal (tabbed: new dispatch / resume previous)
  ├── components/palette/   — PaletteItem (drag source)
  └── data/componentPalette.ts — Pre-defined node templates (infrastructure/services/storage)
```

### Execution flow

The canvas exposes two launch flows, both binary-choice (start new vs. resume previous):

**Flow A — single-zone launch** (Play button on a zone → `ZoneLaunchModal`):

1. Modal shows "Start new session" + scrollable history of prior `ZoneSessionRecord` entries for this zone.
2. User picks one — "new" submits `zone.launch({ mode: 'new', summary? })`; "resume <row>" submits `zone.launch({ mode: 'resume', sessionId })`.
3. Main process (`terminals.ts → runZone`) spawns one PTY. Solo mode uses `buildSoloZonePrompt` (short, no activity-log contract) and no scheduler — the agent talks directly with the user.
4. Fresh spawns snapshot the runtime's session store pre-spawn, then poll post-spawn via `adapter.captureNewSession(cwd, before)` to capture the new session id.

**Flow B — multi-zone dispatch** (TopNav Dispatch button → `DispatchModal`):

1. "New dispatch" tab: user enters prompt + model + plan mode → `startDispatch(nodes, edges, cwd, settings, { userPrompt, model, planMode, onlyZoneIds? }, dispatchContext?)`.
2. "Resume previous" tab: scrollable history of prior `DispatchRecord` entries → `dispatches.resume({ dispatchId, nodes, edges, settings })`.
3. `terminals.ts` forwards to `orchestrator/dispatch.ts` (dynamic import, to avoid a module-load cycle with `spawnAgentSession`). Single-zone dispatches fall through to `runZone` — no conductor needed.
4. Multi-zone path: mint `dispatchId`, call `setupWorkspaceV5(projectDir, dispatchId, …)` to lay down:
    - `ARCHITECT/manifest.json` — graph description (protocolVersion: 5, dispatchId, per-zone entries with runtime/model/components/upstream/downstream/paths)
    - `ARCHITECT/prompts/conductor.md` — compact conductor prompt (~60 lines)
    - `ARCHITECT/prompts/<safe>.md` — compact per-zone prompt (~40 lines)
    - `ARCHITECT/runtime/<dispatchId>/` (ephemeral) — `activity/`, `state/`, `tasks/`, `index.json`
    - `ARCHITECT/outputs/<safe>.md` — progress scratchpad dirs ensured (contents preserved across dispatches)
    - Legacy `ARCHITECT/mailbox/` + `ARCHITECT/scripts/` (v4 leftovers) are `rm -rf`'d on entry.
5. Spawn each zone PTY serially (serialized capture avoids diff-races in the shared `~/.claude/projects/<cwd>/` etc.). Each zone spawn passes its full role prompt via `adapter.composeSystemAndUser` — Claude gets `--append-system-prompt`; codex/opencode/gemini fold it into the first user prompt via `<<SYSTEM>>…<<END>>`. Each zone also receives a short **bootstrap user prompt** as its first turn (`"Acknowledge with 'Ready'. Do NOT append an activity-log line yet…"`) so the CLI materializes a session file on disk — without it, capture polling times out.
6. Spawn the Conductor PTY. Its system prompt is `conductor.md`; its **initial user turn is the dispatch kick-off** (`composeInitialTurn(userPrompt)` = `"New dispatch. User task: <prompt>. Emit one {type:'assign'} decision line"`). Delivered via argv, same spawn-time mechanism as the zone bootstrap — no post-spawn pty.write needed.
7. Build and start the `Scheduler`. It attaches a per-file `fs.watch` on every participant's activity log (drains any pre-existing lines on attach to handle races), runs a 15 s status tick for staleness detection, and registers its `stop()` with `setActiveDispatchCoordinator` so `killAll()` tears everything down.
8. Terminal I/O streams to the renderer via `terminal:data` / `terminal:exit` / `terminal:status`. Activity events stream via `activity:event`; status transitions stream via `activity:state`. Final summary emits `dispatch:complete`.

**Big Change on Save**: if the canvas was previously dispatched and zone config changed, clicking Save auto-opens the Dispatch modal with a prefilled prompt describing the diff (added / updated / removed zones).

### Orchestration v5 (activity-log + conductor)

Coordination between zones and the Conductor is **file-based activity logs + pty.write task delivery**. No shell scripts, no mailbox files, no polling loops inside agents. `DISPATCH_PROTOCOL_VERSION = 5` (in `dispatchCapture.ts`); v4 and older resumes are rejected with `legacy-protocol`.

The design goal: one coordination primitive that works identically across Claude, Codex, OpenCode, and Gemini — so no Claude-only flags (`--append-system-prompt` is absorbed by the adapter, not prescribed), no bash-tool-semantics assumptions (v4's `mailbox-listen.sh` blocking loop didn't work on Codex's TUI), no screen-scrape cue detection.

#### Participants

Every participant has a stable id used as both filename prefix and state-file basename:

- `conductor` — the planner/coordinator agent. PTY id: `conductor-agent`.
- `<safe>` — each zone, using `sanitize(zone.data.label)`. PTY id: zone's React Flow node id.

The Conductor's participant id is fixed (`conductor`); it's the only coordinator per dispatch.

#### Transport: activity logs

Each participant owns one append-only JSONL file:

```
ARCHITECT/runtime/<dispatchId>/activity/<participantId>.jsonl
```

Every meaningful action lands as one line:

```ts
interface ActivityEvent {
    ts: string // ISO8601
    kind:
        | "task-received" // agent acknowledges a dispatched task
        | "progress" // mid-work update (optional, keeps stale detection quiet)
        | "ask" // blocked on a question
        | "answer" // reply to a prior ask (conductor → zone flow, rare)
        | "done" // task finished successfully
        | "failed" // task aborted with reason
        | "note" // free-form log line; conductor decisions use this
    taskId?: string
    content: string
    structured?: Record<string, unknown>
}
```

Agents emit lines with **one POSIX shell command** (no jq, no polling loop):

```bash
cat >> '<abs-activity-path>' << 'ACT_EOF'
{"ts":"2026-04-23T21:10:00Z","kind":"done","taskId":"t-abc","content":"…"}
ACT_EOF
```

The `cat << 'ACT_EOF'` heredoc is chosen because it sidesteps shell quoting issues inside JSON; every CLI with a Bash/shell tool handles it uniformly.

The harness watches each log with narrow per-file `fs.watch`. `watchActivity` tracks offset + a partial-line buffer, drains any pre-existing bytes on attach (race safety), and fires one parsed `ActivityEvent` per newline. Malformed lines are logged and skipped.

#### Task delivery: pty.write, not a mailbox

When the Conductor emits an `{type: 'assign'}` decision (see below), the `Scheduler` dispatches work by writing a normal user-turn prompt to each targeted zone's live PTY:

```
TASK <taskId>: <body>
```

Plus `ANSWER <taskId>: <body>` for conductor replies and `CANCEL <taskId>: <reason>` for aborts. The zone's role prompt teaches it the prefix semantics.

`scheduler.writeToParticipant(pid, text)` is a **two-step submit** — write the text, wait 120 ms, then write a bare `\r`. This separates the paste-burst from the Enter key so Claude's multi-line TUI treats Enter as a distinct keystroke rather than a literal character inside pasted content. Single-burst `text + \r` leaves the turn typed into the input buffer but unsubmitted.

#### Conductor decisions

The Conductor is **harness-driven**, not self-driving. Between turns, the scheduler pty.writes one compact user-turn summary per material event:

- `done` → `"Zone X done on t-abc: <summary>. What next?"`
- `failed` (retries left) → `"Zone X failed t-abc: <reason>. Will retry. Acknowledge or override."`
- `failed` (exhausted) → `"Zone X failed t-abc: <reason>. Retries exhausted. Recover, reroute, or mark final."`
- `ask` → `"Zone X blocked on t-abc: <question>. Answer or reassign."`
- `stale` (past `staleEscalationMs`) → `"Zone X stale for Nm on t-abc. Retry / reassign / fail?"`
- `pty-exit` → `"Zone X PTY exited (code N). Decide how to proceed."`
- all-done → `"All engaged zones reported done. Emit one {type:'final'} decision."`

The Conductor responds with **one activity-log line** per turn, `kind: 'note'`, `structured.type` ∈:

```ts
type ConductorDecision =
  | { type: "assign";  assignments: Array<{ zoneId: string; body: string; taskId?: string }> }
  | { type: "answer";  targetZoneId: string; body: string }
  | { type: "final";   summary: string }
  | { type: "noop";    reason?: string }
```

The scheduler's activity watcher parses each conductor line via `parseDecision`, executes it (pty.write to zones, mark task done, emit `dispatch:complete`, etc.), and appends the decision JSON to `DispatchRecord.conductorDecisions[]` for audit + resume.

**No drain loop** is prescribed. No `mailbox-listen.sh`. The Conductor's prompt explicitly says: *"You do not run a loop. The harness drives your turn-taking."*

#### Scheduler responsibilities

`orchestrator/scheduler.ts`:

1. Attaches activity watchers for conductor + every zone.
2. Maintains per-task state (`pending → dispatched → in-progress → {done | failed | blocked → in-progress (after answer) | failed}`).
3. Routes zone activity lines:
    - `task-received` / `progress` / `note` → update `lastActivityTs`
    - `done` → mark task complete; pty.write conductor-done turn; if all zones idle, signal all-done
    - `failed` → retry with same `taskId` up to `zone.data.behavior.retries`; on exhaustion, pty.write conductor-failed turn
    - `ask` → set `lastTaskStatus = 'blocked'`; pty.write conductor-ask turn
4. Executes conductor decisions (assign / answer / final / noop).
5. Persists `DispatchRecord.pendingTasks[]` on every task transition so a crash-then-resume can re-deliver in-flight work exactly.
6. Runs a 15 s status tick: recomputes each participant's `ParticipantStatus`, sets/clears `staleAt`, and escalates to the conductor after `staleEscalationMs` of continuous staleness.
7. Handles PTY exits: marks the participant `ptyAlive=false`, fails the in-flight task, and pty.writes a conductor-exit turn.

The scheduler **never** spawns PTYs directly; it receives `writeToPty` + `getPtyLastActivityMs` + broadcast functions as deps from `dispatch.ts`.

#### Multi-signal status

`orchestrator/status.ts → computeParticipantStatus` picks a `ParticipantStatus` ∈ `{ starting, running, idle, blocked, failed, stale, exited }` from:

1. **PTY alive?** no → `exited`
2. **Last activity kind:** `ask → blocked`; `failed → failed`; `done` on the current task → `idle`
3. **Both idle past threshold** (`ptyIdleMs > idleThresholdMs && activityIdleMs > idleThresholdMs`) → `stale`
4. Otherwise → `starting` (no activity yet, no task) or `running`

Staleness requires BOTH signals quiet. PTY output alone (long silent tool call) keeps the zone out of stale; activity lines alone likewise. This is diagnostic — escalation to the conductor is a separate decision gated by `staleEscalationMs`.

#### State files

`ARCHITECT/runtime/<dispatchId>/state/<participantId>.kv` — flat key=value, atomic mktemp+rename writes:

```
role=zone
label=Frontend
runtime=claude
sessionId=<uuid>
lastTaskId=t-abc
lastTaskStatus=in-progress
lastTaskStartedAt=2026-04-23T21:08:00Z
lastActivityTs=2026-04-23T21:10:00Z
ptyAlive=true
staleEscalations=0
staleAt=2026-04-23T21:14:00Z
```

Ephemeral. Reconstructable from the activity log + DispatchRecord, so it's wiped on every dispatch entry.

#### Harness timeouts

`ProjectSettings.harnessTimeouts`:

- `idleThresholdMs` (default 3 min) — when both the PTY and the activity log go quiet past this threshold, the participant flips to `stale`.
- `staleEscalationMs` (default 10 min) — how long a stale streak must persist before the scheduler invokes the conductor for recovery.

Exposed in the Settings panel. v4's `deliveryWarningMs` + `taskTimeoutMs` are gone — the mailbox transport they served doesn't exist.

#### Lifecycle state machine

`spawning → running → failed`. v4's `finished` is unused — zones stay alive across tasks and only exit via PTY close. Per-task state lives in `state.kv` + the activity log, not the session lifecycle. Broadcast via `terminal:status` IPC.

### Runtime adapters

Every per-CLI quirk sits behind `RuntimeAdapter` in `src/main/runtimes/types.ts`:

```ts
interface RuntimeAdapter {
    readonly id: AgentRuntime
    readonly supportsSystemPromptFlag: boolean // only claude today
    buildSpawnArgs(opts: SpawnArgs): string[]
    buildResumeArgs(opts: ResumeArgs): string[]
    composeSystemAndUser(systemPrompt: string, userPrompt: string): ComposedPrompt
    snapshotSessions(cwd: string): Promise<Set<string>> | Set<string>
    captureNewSession(cwd: string, before: Set<string>, timeoutMs?: number): Promise<string | null>
    revalidateSession(cwd: string, sessionId: string): boolean
}
```

- **claude**: `--append-system-prompt` for the system prompt, positional for the user prompt. `--resume <id>` for resume. `--dangerously-skip-permissions` | `--permission-mode plan`. Session dir: `~/.claude/projects/<sanitized-cwd>/*.jsonl`.
- **codex**: `resume <id>` subcommand (not flag) for resume; `--no-alt-screen -a never -s workspace-write` operating flags. Positional for prompt. No system-prompt flag — adapter folds it inline via `<<SYSTEM>>…<<END>>`. Session dir: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. Pre-resume reachability check: `isCodexSessionIdForCwd`.
- **gemini**: `--approval-mode yolo`, `--prompt-interactive <prompt>`, `--resume <id>`. Inline fold. Session dir: `~/.gemini/tmp/{hash|slug}/chats/session-*.json`. Pre-resume check: `isGeminiSessionIdForCwd`.
- **opencode**: `--session <id>` (explicit; never `--continue` alone, which loads the most-recent session and silently hijacks resumes). `--prompt <prompt>`. Inline fold. Session capture spawns `opencode session list --format json` under a PTY (the CLI requires TTY for stdout).

Every call site in `terminals.ts` / `dispatch.ts` goes through `getRuntimeAdapter(runtime)`.

### Session & dispatch persistence

Storage lives under the project's `ARCHITECT/` directory. Durable vs. ephemeral:

**Durable (survives dispatch teardown)**:

- `ARCHITECT/sessions/<zoneKey>/<sessionId>.json` — one file per captured zone session: `{ runtime, sessionId, capturedAt, summary, model?, dispatchId? }`. Oldest entries pruned past `MAX_ZONE_SESSIONS = 20`. Feeds the ZoneLaunchModal history picker.
- `ARCHITECT/dispatches/<architectSessionId>.json` — one file per dispatch:

    ```ts
    interface DispatchRecord {
        architectSessionId: string
        architectRuntime: AgentRuntime
        dispatchId?: string
        zoneIds: string[]
        zoneLabels: string[]
        zoneSessions: Array<{ zoneId; label; runtime; sessionId }>
        userPrompt: string
        summary: string
        model: string
        planMode: boolean
        timestamp: string
        protocolVersion?: number // = 5 for v5 dispatches
        pendingTasks?: PendingTask[] // in-flight at teardown; re-delivered on resume
        conductorDecisions?: string[] // append-only audit log of parsed decision JSON
    }
    ```

    `protocolVersion: 5` required for resume; v4 and older dispatches fail with `legacy-protocol`.

- `ARCHITECT/outputs/<safe>.md` — narrative progress log. Preserved across dispatches. Zones may append to this as a free-form scratchpad during work.

**Ephemeral (wiped on every `startDispatch` / `resumeDispatch`)**:

- `ARCHITECT/runtime/<dispatchId>/` — entire subtree (`activity/`, `state/`, `tasks/`, `index.json`). Per-dispatch subdirectory means concurrent/historical dispatches never overwrite each other. Resume wipes only its own subtree.
- `ARCHITECT/prompts/conductor.md` + `<safe>.md` — regenerated per dispatch.
- Legacy `ARCHITECT/mailbox/` + `ARCHITECT/scripts/` — `rm -rf`'d on first v5 entry; never recreated.

**Resume flow** (`resumeDispatchV5`):

1. Load `DispatchRecord`; reject if `protocolVersion < 5`.
2. Wipe `ARCHITECT/runtime/<dispatchId>/`, re-run `setupWorkspaceV5`.
3. For each zone, call `adapter.revalidateSession(cwd, sessionId)`; stale ids → skip the spawn (scheduler sees them as `exited` from turn zero).
4. Spawn each reachable zone with `buildResumeArgs(sessionId)` — **no initial prompt** (zones come back idle).
5. Spawn the Conductor with `buildResumeArgs(architectSessionId)` — also no initial prompt.
6. Build + start the Scheduler; re-deliver each `record.pendingTasks[i]` via `scheduler.redispatchTask(task)` (pty.write, same `taskId` as before so correlations hold).

Durable conversation for every runtime lives in its CLI-native session store — reloaded via `buildResumeArgs`. Architect never stores conversation text.

### Skills system

`skills/` at the repo root contains markdown skill files (`SKILL.md`) grouped by topic (e.g., `skills/python-testing/SKILL.md`). Node agents can be assigned skills; their content is embedded verbatim into the agent's prompt. Built-in skills are referenced as `builtin:<skill-folder-name>`, custom skills as `custom:<absolute-path>`.

### IPC surface

All renderer ↔ main communication goes through `window.electron` (defined in preload):

- `readDir / readFile / getHomeDir / openDirectory` — file system ops
- `saveCanvas / loadCanvas / watchCanvas / unwatchCanvas / onCanvasChanged` — canvas persistence + external-edit watcher
- `startDispatch` — start multi-zone dispatch, returns `TerminalInfo[]` (each `{id, label, runtime, coordinatedMode?}`; `coordinatedMode: true` on zones spawned inside a dispatch so the renderer locks user input)
- `terminal.spawnShell / terminal.input / terminal.resize / terminal.killAll` — PTY control
- `terminal.onData / terminal.onExit / terminal.onSpawned / terminal.onStatus / terminal.onCaptureState / terminal.popout / terminal.dock / terminal.onPopoutClosed` — terminal streaming, lifecycle state broadcasts, popout windows
- `zone.launch({ mode: 'new' | 'resume', sessionId?, summary?, ... })` — spawn or resume a single zone via `runZone`
- `zone.listSessions / zone.deleteSession / zone.updateSessionSummary / zone.resetSession` — per-zone history management
- `zone.onSessionCaptured` — broadcast when a fresh spawn captures its CLI session id (event includes `summary` and optional `dispatchId`)
- `dispatches.list / dispatches.delete / dispatches.updateSummary / dispatches.resume` — per-dispatch record management; `resume` replays the Conductor + all pinned zone sessions
- `activity.onEvent` — one event per appended activity-log line: `{ dispatchId, participantId, event: ActivityEvent }`. Lets the renderer surface agent progress, Conductor decisions, and failures in real time without polling.
- `activity.onState` — one event per `ParticipantStatus` transition emitted by the scheduler's tick loop: `{ dispatchId, participantId, status, lastTaskId? }`.
- `activity.onDispatchComplete` — fires once when the Conductor emits `{type:'final', summary}`: `{ dispatchId, summary }`.
- `assistant.start(projectDir, contextMd, runtime, mode, opts?) / assistant.stop / assistant.stopMode` — side-panel assistant. `mode: 'architecture' | 'general'` selects the prompt/behavior: architecture mode edits `architect-canvas.json` via `ARCHITECT_CANVAS_UPDATE` blocks; general mode is a plain coding assistant with the canvas attached as read-only reference. Each mode has its own sanitized zone key and PTY id, so session history and resume points are independent per mode. The assistant flow is intentionally decoupled from dispatch — it does not use the scheduler / activity logs.

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

VS Code also uses `@xterm/headless` for server-side terminal state. Architect keeps each PTY's `@xterm/headless` `Terminal` instance fed with raw bytes for the `session.tail` buffer (last N bytes — used by debug views), but all per-task coordination in v5 flows through activity-log JSONL files and `pty.write`-delivered user turns. Screen-grid scanning / sigil regex was removed entirely. If you ever reintroduce screen-based detection, reference `src/vs/platform/terminal/node/terminalProcess.ts` for prior art.

## graphify

This project has a graphify knowledge graph at graphify-out/.

Rules:

- Before answering architecture or codebase questions, read graphify-out/GRAPH_REPORT.md for god nodes and community structure
- If graphify-out/wiki/index.md exists, navigate it instead of reading raw files
- After modifying code files in this session, run `graphify update .` to keep the graph current (AST-only, no API cost)
