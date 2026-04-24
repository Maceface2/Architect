# Orchestration Protocol (v5)

This document explains how Architect's v5 multi-zone dispatch works, why it's designed the way it is, and what the key invariants are. It is the reference for `DISPATCH_PROTOCOL_VERSION = 5` (see `src/main/dispatchCapture.ts`).

It is based on the current implementation in:

- `src/main/orchestrator/` — workspace setup, activity log, state, status, scheduler, conductor helpers, dispatch entry points, prompt builders
- `src/main/runtimes/` — per-CLI adapters (Claude / Codex / Gemini / OpenCode) behind one interface
- `src/main/terminals.ts` — PTY lifecycle, `spawnAgentSession`, solo-zone flow (`runZone`), assistant flow
- `src/main/dispatchCapture.ts` — `DispatchRecord` schema (with `pendingTasks` and `conductorDecisions` added in v5)

## Why v5 exists

v4 coordinated multi-zone dispatches by running a **filesystem mailbox transport**: every participant had an inbox directory of JSON message files; agents polled their own inbox with `bash mailbox-listen.sh <id>` (a 2 s loop that `jq`'d the first `pending` file and emitted its metadata); the Overseer ran a parallel drain-and-plan loop pulling its inbox as a JSON array. It worked on Claude but had real problems:

1. **Codex / OpenCode / Gemini fragility.** The listen loop assumed Claude's Bash tool semantics (long-running blocking subprocess, `jq` available, stable TTY). Codex's sandboxed shell and TUI didn't reliably support running a `while :; do … sleep 2; done` bash tool call across multiple turns — zones frequently never re-entered the loop after their first turn.
2. **Context bloat.** The Overseer's bootstrap included ~250 lines of protocol documentation, and every `mailbox-drain.sh` call emitted every pending message as a JSON array. No GC of old messages within a dispatch.
3. **Claude-only role prompts.** `--append-system-prompt` was the only system-prompt channel; Codex / OpenCode / Gemini zones silently never received their role prompt in multi-zone dispatch.
4. **Brittle observability.** `fs.watch` dedup hacks (30 ms debounce), O(P×M) full-inbox re-scan on every event, screen-glyph regex for ready detection.

v5 replaces this with three core shifts:

1. **Runtime adapters** (`src/main/runtimes/`) absorb every `if runtime === 'x'` branch. One interface; four implementations.
2. **Activity logs** (append-only JSONL per participant) replace bidirectional mailboxes. Agents emit one line per meaningful step using a single POSIX heredoc; no `jq`, no polling, no blocking subprocess.
3. **`pty.write`-driven task delivery.** The scheduler delivers `TASK <id>: <body>` as a normal user turn on the live zone PTY — the one operation every TUI is built around. Conductor decisions land via argv at spawn or as follow-up user turns between material events.

## Participants

Every participant has a stable id used as both activity-log filename prefix and state-file basename:

- `conductor` — the planner/coordinator agent. PTY id: `conductor-agent`.
- `<safe>` — each zone, using `sanitize(zone.data.label)` (same identity convention as v4). PTY id: the zone's React Flow node id.

There is one Conductor per dispatch. No harness participant id — synthetic events don't exist in v5; the harness influences the Conductor by pty-writing user turns, not by injecting messages into its inbox.

## Who lays down the workspace

The harness, up front, before any PTY spawns.

`orchestrator/dispatch.ts → startDispatchV5` calls `orchestrator/workspace.ts → setupWorkspaceV5`, which does:

1. **Wipes legacy v4 artifacts** — `ARCHITECT/mailbox/` and `ARCHITECT/scripts/` are `rm -rf`'d. Projects previously dispatched under v4 have these directories from prior runs; v5 never recreates them.
2. **Wipes this dispatch's ephemeral subtree** — `ARCHITECT/runtime/<dispatchId>/` (if it exists from a crashed prior run with the same id, e.g. mid-crash resume).
3. **Creates dirs** — `ARCHITECT/{outputs,prompts,sessions,dispatches}` + `ARCHITECT/runtime/<dispatchId>/{activity,state,tasks}`.
4. **Writes the manifest** — `ARCHITECT/manifest.json` with `protocolVersion: 5`, `dispatchId`, per-zone entries (runtime, model, components, upstream/downstream, activity-log path, state-file path, output-file path).
5. **Writes the prompts** — `ARCHITECT/prompts/conductor.md` + `<safe>.md` per zone. Compact (~60 and ~40 lines of output respectively) — see `orchestrator/prompts/`.
6. **Writes state skeletons** — `ARCHITECT/runtime/<dispatchId>/state/<participantId>.kv` via `initialState(role, label, runtime)`. One for `conductor` + one per zone.
7. **Touches activity logs** — empty `.jsonl` files via `ensureActivityLog()` so `fs.watch` can attach before any agent writes.

Only then does `spawnAgentSession` run.

## Launch order (and why it matters this time)

Unlike v4 (where launch order genuinely didn't matter — the mailbox was filesystem-backed and eventually consistent), v5 requires a specific sequence:

1. **Zones spawn serially** (`serializeAgentSpawn` wraps each). Serialization prevents diff-race collisions in the shared per-runtime session directory (`~/.claude/projects/<cwd>/`, `~/.codex/sessions/…`, etc.) — concurrent spawns would make diff-based "what new file appeared?" polls attribute the same `sessionId` to multiple zones. Each zone:
    - gets its role prompt via `adapter.composeSystemAndUser(systemPrompt, ZONE_BOOTSTRAP_PROMPT)` — Claude via `--append-system-prompt`; others folded into the first user prompt via `<<SYSTEM>>…<<END>>`
    - receives a small **bootstrap user prompt** as its first turn (`"Acknowledge readiness with 'Ready'. Do NOT append an activity-log line yet…"`). This forces the CLI to materialize a session file on disk; without it, session-capture polling times out at 20 s and the DispatchRecord can't save `zoneSessions[]`.
    - captures its `sessionId` via `adapter.captureNewSession(cwd, beforeSnapshot)`; upsert into DispatchRecord
2. **Conductor spawns last** with `composeInitialTurn(userPrompt)` as its first user turn (argv). That kick-off prompt tells the Conductor "New dispatch. User task: … Emit one {type:'assign'} decision line." — delivered at spawn so there's no race between PTY readiness and a post-spawn `pty.write`.
3. **Scheduler starts.** Attaches `watchActivity` on every participant's `.jsonl`. On attach, `watchActivity` drains any pre-existing lines (race safety: the Conductor's first decision may already be in the file by the time the watcher attaches).
4. **Dispatch is now live.** Everything else is event-driven.

## Activity log

The sole bidirectional data channel between agents and the harness.

### Path

```
ARCHITECT/runtime/<dispatchId>/activity/<participantId>.jsonl
```

Append-only. One JSON object per line. File is ephemeral — wiped on every `startDispatch` / `resumeDispatch` entry.

### Schema

```ts
type ActivityKind =
    | "task-received"   // agent acknowledges a dispatched task
    | "progress"        // mid-work update; keeps staleness detection quiet
    | "ask"             // blocked on a question; waiting for ANSWER
    | "answer"          // reply to a prior ask (conductor → zone is rare; mostly conductor emits {type:'answer'} decisions)
    | "done"            // task finished successfully
    | "failed"          // task aborted with reason
    | "note"            // free-form log line; the Conductor's decisions are encoded as kind:'note' with structured.type

interface ActivityEvent {
    ts: string // ISO8601 UTC
    kind: ActivityKind
    taskId?: string
    content: string // human-readable one-line summary
    structured?: Record<string, unknown> // decision payload (conductor), or extra context
}
```

### How agents write lines

Every agent — zone or conductor — uses one POSIX shell command:

```bash
cat >> '<abs-activity-path>' << 'ACT_EOF'
{"ts":"2026-04-23T21:10:00Z","kind":"done","taskId":"t-abc","content":"Implemented GET /users endpoint at src/api/users.ts"}
ACT_EOF
```

The `cat << 'ACT_EOF'` heredoc is deliberately chosen over `echo '…' >> file` because the quoting inside multi-line JSON content is easier. Every CLI that exposes a Bash/shell tool passes this pattern through uniformly. No `jq` required. No polling loop inside the agent's shell.

### How the harness reads lines

`orchestrator/activity.ts → watchActivity`:

- narrow per-file `fs.watch` (not a whole-directory scan)
- tracks a byte offset + a partial-line buffer so writes that straddle a newline boundary don't produce broken lines
- on each `change` event, stats the file, reads the new bytes from offset to size, splits on `\n`, parses each line
- handles truncation (if size < offset, re-reads from 0)
- drains pre-existing lines at attach time so the scheduler catches events that landed before the watcher was ready
- malformed lines are logged and skipped

Each parsed line fires one `onEvent` callback → the scheduler updates `state.kv`, broadcasts `activity:event` IPC to the renderer, and (if it's the Conductor) `parseDecision` attempts to extract a `ConductorDecision`.

## Task delivery (pty.write, not mailbox)

When the Conductor emits an `{type:'assign'}` decision, the Scheduler executes it by pty-writing a normal user-turn prompt to each targeted zone's live PTY:

```
TASK <taskId>: <body>
```

Plus `ANSWER <taskId>: <body>` when the Conductor emits `{type:'answer'}` and `CANCEL <taskId>: <reason>` for aborts. The zone's role prompt teaches the agent these prefixes.

`scheduler.writeToParticipant(pid, text)` is a **two-step submit**:

1. Write the text as one chunk (no trailing terminator).
2. Wait 120 ms.
3. Write a bare `\r`.

This separates the paste-burst from the Enter key so Claude's multi-line TUI treats Enter as a distinct keystroke — not part of pasted content. A single-burst `text + \r` leaves the turn typed into the input buffer but unsubmitted. (Empirically verified on `claude-haiku-4-5`; same mechanism `tmux send-keys "text" Enter` uses.)

## Conductor contract

The Conductor is **harness-driven**, not self-driving. It does not run a loop.

### What it receives

Between turns, the scheduler pty-writes one compact user-turn summary per material event:

| Event                    | Turn text (abbreviated)                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------------- |
| Dispatch kick-off (argv) | `"New dispatch. User task: <prompt>. Emit one {type:'assign'} decision line…"`                          |
| Zone `done`              | `"Zone X (<pid>) completed <taskId>: <summary>. What next?"`                                            |
| Zone `failed` (retry)    | `"Zone X failed <taskId>: <reason>. Will retry. Acknowledge or override."`                              |
| Zone `failed` (exhausted)| `"Zone X failed <taskId>: <reason>. Retries exhausted (N/M). Recover, reroute, or emit {type:'final'}."`|
| Zone `ask`               | `"Zone X blocked on <taskId>: <question>. Emit {type:'answer', targetZoneId:'…'} or reassign."`         |
| Stale escalation         | `"Zone X stale for <N>m on <taskId>. Retry / reassign / mark failed?"`                                  |
| Zone PTY exit            | `"Zone X (<pid>) PTY exited (code N). Further messages will fail. Decide how to proceed."`              |
| All zones done           | `"All engaged zones reported done. Emit one {type:'final', summary:'…'} decision."`                     |

The Conductor has **no listen loop**. No `mailbox-listen.sh`. No polling. The harness calls on it only when there's something material to decide.

### What it emits

Exactly one activity-log line per turn, `kind: 'note'`, `structured.type` ∈:

```ts
type ConductorDecision =
    | { type: "assign";  assignments: Array<{ zoneId: string; body: string; taskId?: string }> }
    | { type: "answer";  targetZoneId: string; body: string }
    | { type: "final";   summary: string }
    | { type: "noop";    reason?: string }
```

`assignments[*].zoneId` is the zone's `participantId` (sanitized label); `taskId` is optional — the scheduler mints one if omitted. `targetZoneId` is also a participantId. One `assign` decision can dispatch work to multiple zones in parallel when their work is independent.

### Why `structured` instead of `<<<MARKER>>>` blocks

Early plans specified marker-delimited blocks (`<<<ASSIGN>>>...<<<END>>>`) inside the activity line's `content`. Implementation moved to `structured.type` because:

- `structured` is native JSON — no double-escaping hell inside a JSON string field
- activity-line schema stays uniform (same fields regardless of who emitted the line)
- parsing is a field lookup, not a regex

## Scheduler

`orchestrator/scheduler.ts`. One `Scheduler` instance per running dispatch.

### Responsibilities

1. Attach `watchActivity` on conductor + every zone.
2. Maintain per-task state (`InFlightTask`) keyed by `taskId`.
3. Route zone activity events:
    - `task-received` / `progress` / `note` → update `lastActivityTs`; no conductor turn
    - `done` (taskId matches current) → mark done, remove from `currentTaskByParticipant`, pty-write `composeZoneDoneTurn` to conductor; if this empties all in-flight tasks, pty-write `composeAllDoneTurn`
    - `failed` → if `attempts < zone.retriesAllowed`: increment attempts, re-pty-write the same task body with `(retry K/N)` prefix + previous-error hint, pty-write a conductor-retry turn. Else: mark failed, pty-write `composeZoneFailedTurn(... exhausted: true)`
    - `ask` → set `lastTaskStatus = 'blocked'`, pty-write `composeZoneAskTurn` to conductor
4. Execute conductor decisions via `executeDecision`:
    - `assign` → for each assignment, `dispatchTaskInternal` (mint taskId if absent, write `tasks/<taskId>.json`, pty-write `TASK <id>: <body>` to zone)
    - `answer` → look up the target zone's current taskId, pty-write `ANSWER <taskId>: <body>`
    - `final` → broadcast `dispatch:complete { dispatchId, summary }` (once); set `finalEmitted = true`
    - `noop` → audit-log only
5. Persist `DispatchRecord.conductorDecisions[]` (append-only) via `appendDispatchConductorDecision`.
6. Persist `DispatchRecord.pendingTasks[]` via `setDispatchPendingTasks` on every task transition — crash-safe resume depends on this.
7. Run a 15 s status tick: recompute `ParticipantStatus` for every participant; set/clear `staleAt`; escalate to conductor after `staleEscalationMs`.
8. Handle PTY exits: mark `ptyAlive=false`, fail current task, pty-write `composePtyExitTurn`.

### What the scheduler does NOT do

- **Spawn PTYs directly.** It receives `writeToPty` / `getPtyLastActivityMs` / broadcast functions as deps from `dispatch.ts`.
- **Write to agent stdin outside the user-turn channel.** No "control" messages. Everything the agent sees looks like a user prompt.
- **Parse PTY bytes.** `session.tail` + xterm-headless are read only for debugging surfaces, never for coordination.

## Status machine

`orchestrator/status.ts → computeParticipantStatus(input: StatusInput): ParticipantStatus`

Inputs:

- `state.ptyAlive`
- `lastActivity` (most recent parsed line or null)
- `ptyIdleMs` (now − session.lastActivityMs)
- `activityIdleMs` (now − Date.parse(state.lastActivityTs))
- `idleThresholdMs` (from `ProjectSettings.harnessTimeouts`)

Priority order:

1. PTY dead → `exited`
2. Last activity `ask` → `blocked`; `failed` → `failed`; `done` on the currently-tracked `lastTaskId` → `idle`
3. BOTH `ptyIdleMs > idleThresholdMs` AND `activityIdleMs > idleThresholdMs` → `stale`
4. No activity AND no current task → `starting`; otherwise → `running`

Staleness requires BOTH signals quiet. PTY output alone (long silent tool call that prints nothing observable) keeps the zone out of stale; activity-log writes alone likewise. This is diagnostic only — escalation to the conductor is separately gated by `staleEscalationMs`.

### Escalation

`shouldEscalateStale(state, now, staleEscalationMs)` returns true when `state.staleAt` exists and `(now - Date.parse(staleAt)) ≥ staleEscalationMs`. When true, the scheduler:

1. Pty-writes `composeStaleTurn` to the conductor
2. Increments `state.staleEscalations`
3. Clears `state.staleAt` (so the next stale streak starts a fresh counter)

Default thresholds (`ProjectSettings.harnessTimeouts`, tunable in the Settings panel):

- `idleThresholdMs` = 3 min — flip to `stale`
- `staleEscalationMs` = 10 min — escalate to conductor

## State files

`ARCHITECT/runtime/<dispatchId>/state/<participantId>.kv`. Flat `key=value`, one pair per line, atomic mktemp+rename writes. Ephemeral.

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

Types: `role ∈ {conductor, zone, harness}`, `lastTaskStatus ∈ {none, pending, dispatched, in-progress, blocked, done, failed, resumed}`.

The entire state is reconstructable from the activity log + DispatchRecord, so wiping it on every entry is safe.

## Runtime adapters

Every per-CLI quirk sits behind `RuntimeAdapter` (`src/main/runtimes/types.ts`):

```ts
interface RuntimeAdapter {
    readonly id: AgentRuntime
    readonly supportsSystemPromptFlag: boolean
    buildSpawnArgs(opts: SpawnArgs): string[]
    buildResumeArgs(opts: ResumeArgs): string[]
    composeSystemAndUser(systemPrompt: string, userPrompt: string): ComposedPrompt
    snapshotSessions(cwd: string): Promise<Set<string>> | Set<string>
    captureNewSession(cwd: string, before: Set<string>, timeoutMs?: number): Promise<string | null>
    revalidateSession(cwd: string, sessionId: string): boolean
}
```

### Claude (`runtimes/claude.ts`)

- `supportsSystemPromptFlag: true`
- Spawn: `claude [--permission-mode plan | --dangerously-skip-permissions] --model <m> [--effort low|medium|high|xhigh|max] --append-system-prompt <system> <user>`
- Resume: `claude [perms] --resume <id> --model <m> [effort] <user?>`
- Session store: `~/.claude/projects/<sanitized-cwd>/<uuid>.jsonl` (cwd sanitization replaces non-`[A-Za-z0-9_-]` with `-`)
- Revalidation: always `true` (Claude has no cheap reachability check; stale ids fail visibly at resume time)

### Codex (`runtimes/codex.ts`)

- `supportsSystemPromptFlag: false`
- Spawn: `codex --no-alt-screen -a never -s workspace-write --model <m> [-c model_reasoning_effort="<level>"] <user>`
- Resume: `codex resume <id> <operating flags> <user?>` (`resume` is a subcommand, not a flag)
- No system-prompt flag; `composeSystemAndUser` inlines via `<<SYSTEM>>…<<END>>` fold
- Session store: `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<UUID>.jsonl`. First line is `session_meta` with `payload.cwd` and `payload.id`.
- Revalidation: `isCodexSessionIdForCwd(cwd, sessionId)` walks the date-based tree and verifies cwd match + primary (non-subagent)

### Gemini (`runtimes/gemini.ts`)

- `supportsSystemPromptFlag: false`
- Spawn: `gemini --approval-mode yolo --model <m> --prompt-interactive <user>`
- Resume: `gemini --approval-mode yolo --resume <id> --model <m> --prompt-interactive <user?>`
- Inline system-prompt fold
- Session store: `~/.gemini/tmp/{sha256-hash|slug}/chats/session-*.json`. Both hash (derived from `resolve(cwd)`) and slug (from `~/.gemini/projects.json`) dirs are searched
- Revalidation: `isGeminiSessionIdForCwd(cwd, sessionId)` verifies `projectHash` match and `kind !== 'subagent'`

### OpenCode (`runtimes/opencode.ts`)

- `supportsSystemPromptFlag: false`
- Spawn: `opencode --model <m> --prompt <user>`
- Resume: `opencode --session <id> --model <m> --prompt <user?>` — **always `--session`, never `--continue`** alone. `--continue` loads the most-recent session and silently hijacks resumes when Architect has spawned multiple opencode instances
- Inline system-prompt fold
- Session store: OpenCode's own SQLite DB; listed via `opencode session list --format json` spawned under a PTY (the CLI requires TTY for stdout flush)
- Revalidation: always `true` (no cheap on-disk check)

## Persistence

Under the project's `ARCHITECT/` directory.

### Durable (survives dispatch teardown)

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
        pendingTasks?: PendingTask[]
        conductorDecisions?: string[] // JSON-serialized decision objects, in order
    }
    interface PendingTask {
        taskId: string
        zoneId: string
        participantId: string
        body: string
        status: "pending" | "dispatched" | "in-progress" | "blocked"
        attempts: number
        startedAt?: string
    }
    ```

    `protocolVersion: 5` required for resume. v4 and older dispatches fail with `legacy-protocol`.

- `ARCHITECT/outputs/<safe>.md` — narrative progress log. Preserved across dispatches. Zones may append to it as a free-form scratchpad during work (non-machine-readable; in contrast to the activity log).

### Ephemeral (wiped on every `startDispatch` / `resumeDispatch`)

- `ARCHITECT/runtime/<dispatchId>/` — the entire subtree (`activity/`, `state/`, `tasks/`). Per-dispatch subdirectory so concurrent/historical dispatches never overwrite each other; resume wipes only its own subtree.
- `ARCHITECT/prompts/conductor.md` + `ARCHITECT/prompts/<safe>.md` — regenerated from current canvas state per dispatch.
- `ARCHITECT/mailbox/` + `ARCHITECT/scripts/` (legacy v4 artifacts) — `rm -rf`'d on first v5 entry; never recreated.

### Why regenerate prompts on resume

Resumes reload the agent's full conversation from the CLI-native session store (`--resume <id>` etc.). At that point `--append-system-prompt` is ignored by Claude — the original system prompt is already baked into the resumed history. So regenerating the prompt file is harmless and keeps the on-disk artifact consistent with the current canvas (in case the user opens the file to inspect).

## Resume flow

`orchestrator/dispatch.ts → resumeDispatchV5`:

1. Load `DispatchRecord` from `ARCHITECT/dispatches/<architectSessionId>.json`. Reject if `protocolVersion < 5` with `legacy-protocol`. Reject if missing with `not-found`.
2. `setupWorkspaceV5(..., dispatchId = record.dispatchId)` — wipes + rebuilds the `runtime/<dispatchId>/` subtree, rewrites prompts, initializes state.kv skeletons with `lastTaskStatus=resumed`, touches activity logs.
3. For each zone: `adapter.revalidateSession(cwd, entry.sessionId)`; stale → skip spawn (scheduler treats as `exited` from turn zero).
4. Spawn each reachable zone with `adapter.buildResumeArgs(sessionId)`. **No initial prompt** — zones come back idle at their prompt. Capture is NOT armed (resume reuses an existing session id; there's no new file to poll for).
5. `adapter.revalidateSession(projectDir, record.architectSessionId)`; if unreachable → abort with `not-found`.
6. Spawn the Conductor with `buildResumeArgs` — also no initial prompt. Conductor is idle until the scheduler sends a user turn.
7. Build + start the Scheduler.
8. For each entry in `record.pendingTasks`: `scheduler.redispatchTask(task)` — pty-writes `TASK <taskId>: <body>` with the ORIGINAL taskId so the agent's correlation with prior state (activity-log entries it already wrote, `outputs/<safe>.md` content) stays stable.

Completed tasks stay completed. The Conductor waits for the next material event (a re-delivered task finishing, a new question, a stale escalation) before speaking. There is no "resume has happened, speak up" prompt — the Conductor is stateless between turns by design.

## The one remaining screen-grid read

None. v4 had `renderScreenText` matching prompt glyphs (`>` `❯` `›` `>>>` `│ >`) for `spawning → ready` detection. v5 uses `spawning → running` driven by first PTY output — no glyph matching, no screen parse. The `@xterm/headless` `Terminal` instance is still fed PTY bytes (so `session.tail` has a usable last-N-bytes buffer for debugging views) but nothing on the critical path reads from the grid.

## What's intentionally NOT in v5

- **No synthetic `harness.*` messages.** v4's `harness.delivery-warning` / `harness.heartbeat-missed` / `harness.timeout` / `harness.wake` / `harness.pty-exit` are all collapsed into: the scheduler either pty-writes a Conductor turn directly, or it doesn't act. If you care about a signal, it flows through a pty-write to the Conductor as a user turn — no side channel.
- **No per-task cue detection.** Agents reporting `done` / `failed` / `ask` via activity-log lines is the only completion signal. No screen regex, no sentinel echo.
- **No backpressure messages.** Single zone, one task at a time. If you want a zone to queue work, the Conductor delays its next `assign` for that zone.
- **No `status.json` / `_index.json` / other harness-owned rolling snapshot.** The renderer subscribes to `activity:event` + `activity:state` IPC; the main process holds scheduler state in memory; `DispatchRecord.pendingTasks` is the only durable snapshot.

## Versioning

`DISPATCH_PROTOCOL_VERSION = 5` in `dispatchCapture.ts`. Resume rejects everything older.

v3 and v4 dispatch records may still be present on disk from prior usage — they are visible in the dispatch list but `resume` fails with `{ ok: false, error: 'legacy-protocol' }`. The user can delete them via the dispatch modal.
