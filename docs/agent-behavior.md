# Agent Behavior And Runtime Support

This document explains how Architect actually runs agents, how zones behave at dispatch time, and which CLI integrations are complete versus partial.

It is based on the current implementation in:

- `src/shared/agentRuntimes.ts` — runtime catalog + effort flag mapping
- `src/main/runtimes/` — per-CLI adapters (`claude.ts` / `codex.ts` / `gemini.ts` / `opencode.ts`)
- `src/main/orchestrator/` — multi-zone dispatch scheduler, conductor helpers, prompt builders
- `src/main/terminals.ts` — PTY lifecycle, `spawnAgentSession`, solo-zone flow (`runZone`), assistant flow
- `src/main/sessionCapture.ts` — per-runtime session-id capture + on-disk revalidation
- `src/renderer/src/components/dispatch/DispatchModal.tsx`
- `src/renderer/src/components/nodes/AgentConfigModal.tsx`

The multi-zone coordination protocol itself is documented separately in `docs/orchestration.md` (reference for `DISPATCH_PROTOCOL_VERSION = 5`).

## Runtime Catalog

Architect currently knows about four runtimes:

| Runtime | Binary | Default model |
| --- | --- | --- |
| Claude Code | `claude` | `claude-sonnet-4-6` |
| Codex CLI | `codex` | `gpt-5-codex` |
| Gemini CLI | `gemini` | `gemini-2.5-pro` |
| OpenCode | `opencode` | `openai/gpt-5` |

The runtime catalog lives in `src/shared/agentRuntimes.ts`. That file drives:

- runtime labels in the UI
- per-runtime accent colors
- binary lookup names
- default model values
- model suggestions shown in editors and dispatch modal

## How Agent Ownership Works

Architect does not assign components to zones through explicit links. It computes ownership from geometry.

Rules:

1. Each component's center point is computed from its canvas position.
2. Architect checks which zones contain that center point.
3. If multiple zones contain it, the smallest containing zone wins.
4. If no zone contains it, the component is unassigned and no agent is spawned for it.

This is implemented in `indexGraph()` in `src/main/terminals.ts`.

Implications:

- A component can visually overlap a zone but still be unowned if its center falls outside.
- Nested zones are supported.
- Inner zones take precedence over outer zones because the smallest area wins.
- Unassigned components still appear in the manifest and coordinator prompt, but they are advisory only.

## What A Zone Actually Is

A zone becomes one PTY-backed CLI session.

Each zone contributes:

- a runtime
- a resolved model
- env vars
- embedded skill content
- component context
- a behavior prompt

At dispatch time Architect generates:

- a zone system prompt file in `ARCHITECT/prompts/<zone>.md` — compact (~40 lines) for multi-zone dispatches, a separate solo build (~30 lines) for single-zone launches via `runZone`
- an activity log at `ARCHITECT/runtime/<dispatchId>/activity/<zone>.jsonl` — append-only JSONL, agent writes one line per meaningful step
- a state file at `ARCHITECT/runtime/<dispatchId>/state/<zone>.kv` — atomic key=value snapshot maintained by the scheduler
- an output scratchpad at `ARCHITECT/outputs/<zone>.md` — zones append human-readable progress notes as they work (the scheduler uses it alongside PTY idle-ms for staleness detection)

Zone tasks are delivered as normal user-turn prompts via `pty.write` on the live zone PTY. The prompt is formatted as `TASK <taskId>: <body>`. Completion comes back as a single activity-log line (`{"kind":"done"|"failed"|"ask","taskId":"…"}`). See "Multi-Zone Orchestration" below.

## Prompt Layers

Architect uses two distinct prompt layers.

### 1. System Prompt Layer

Generated from zone configuration and canvas context. It includes:

- zone identity and description
- enabled tool names
- component list and specs
- component edge references touching the zone's owned components, including optional labels and directions
- embedded `SKILL.md` contents
- the freeform behavior text from the zone editor
- the instruction to write real code in the project root (`ARCHITECT/` is coordination-only)
- **in multi-zone dispatch**: the activity-log contract — how to receive `TASK <taskId>:` / `ANSWER <taskId>:` / `CANCEL <taskId>:` prefixed user turns; how to emit one `done` / `failed` / `ask` activity line per task via `cat >> <path> << 'ACT_EOF'` heredoc
- **in solo mode**: instructions to work directly with the user; no activity-log references (no scheduler is running)

Built by `orchestrator/prompts/zone.ts → buildZonePrompt` for multi-zone, `orchestrator/prompts/solo.ts → buildSoloZonePrompt` for single-zone launches via `runZone`. Delivered on the CLI command line — Claude via `--append-system-prompt`; others (Codex / OpenCode / Gemini) folded into the first user prompt via the adapter's `composeSystemAndUser` with a `<<SYSTEM>>…<<END>>` wrapper.

### 2. Task Layer

Per-dispatch work is delivered as **normal user-turn prompts** via `pty.write` on the live zone PTY. The Scheduler formats each assignment as:

```
TASK <taskId>: <body>
```

and writes it in two steps — text first, a 120 ms pause, then a bare `\r`. The pause separates the paste-burst from the Enter key so Claude's multi-line TUI treats Enter as a distinct keystroke. A single-burst `text + \r` leaves the prompt typed into the input buffer but unsubmitted.

The zone's role prompt teaches it to do the work using its normal tools (Read/Edit/Bash/etc.), optionally emit `progress` activity lines mid-work, and emit exactly one final activity line — `kind: 'done' | 'failed' | 'ask'`, including the `taskId` — when the task completes. The Scheduler correlates the activity line back to the in-flight task by `taskId` and notifies the Conductor.

Zones are bootstrapped at spawn with a minimal first user turn (`"Acknowledge readiness with 'Ready'. Do NOT append an activity-log line yet…"`). This forces the CLI to materialize a session file so capture polling succeeds; the zone's role prompt tells it to just acknowledge and wait. After that, the only inputs the zone ever receives are `TASK` / `ANSWER` / `CANCEL`-prefixed user turns from the Scheduler.

That separation matters: the system prompt is durable zone identity (set once at spawn, cached in the CLI's conversation history across turns), while task deliveries are per-dispatch instructions with full audit trail in the activity log.

## Multi-Zone Orchestration

When there are two or more zones, Architect runs the **v5 orchestration protocol** (`DISPATCH_PROTOCOL_VERSION = 5`, implemented in `src/main/orchestrator/`). See `docs/orchestration.md` for the full protocol reference. High-level flow:

### Sequence

1. `startDispatch()` (in `terminals.ts`) dynamic-imports `orchestrator/dispatch.ts → startDispatchV5`, which normalizes settings, filters the selected zones, and generates a fresh `dispatchId` (16 hex chars).
2. `setupWorkspaceV5()` wipes legacy v4 artifacts (`ARCHITECT/mailbox/`, `ARCHITECT/scripts/`) if present, wipes `ARCHITECT/runtime/<dispatchId>/` from a prior crashed run of the same id, and creates fresh `activity/`, `state/`, `tasks/` directories. It also writes `manifest.json`, `prompts/conductor.md`, `prompts/<zone>.md` per zone, and per-participant `state.kv` skeletons.
3. Architect spawns each zone PTY **serially** (serialized via `serializeAgentSpawn`) so session-capture polls don't collide in the shared per-runtime session directory. Each zone receives its role prompt via the adapter's `composeSystemAndUser` (Claude via `--append-system-prompt`; others inlined in the first user prompt) plus a minimal bootstrap user turn (`"Acknowledge with 'Ready'…"`) so the CLI materializes a session file for capture.
4. Architect spawns the **Conductor** session (`conductor-agent` PTY id). Its system prompt is `prompts/conductor.md`; its first user turn is `composeInitialTurn(userPrompt)` — the dispatch kick-off — delivered via argv so no post-spawn `pty.write` race exists.
5. The **Scheduler** (`orchestrator/scheduler.ts`) starts. It attaches narrow per-file `fs.watch`es on each participant's activity log (draining any pre-existing lines on attach), starts a 15 s status tick, and registers its `stop()` with `setActiveDispatchCoordinator` so `killAll()` tears everything down cleanly.
6. Dispatch is now live. The Conductor emits a `{type:"assign", assignments: […]}` activity-log line; the Scheduler parses it, `pty.write`s `TASK <taskId>: <body>` to each targeted zone's live PTY (two-step submit with 120 ms gap so Claude's TUI recognizes Enter). Zones do the work, emit one `{"kind":"done"|"failed"|"ask", taskId}` activity line when done. Scheduler notifies the Conductor with a compact user-turn summary per event. Repeat.
7. Work ordering lives in the **Conductor's reasoning**, not in spawn order or canvas edges. The Conductor chooses which zones to engage from the user task and zone/component context, then sequences follow-up work from reported results.

### Completion is an activity line

A zone is "done with a task" when it appends an activity-log line with `kind: 'done'` and a `taskId` matching the Scheduler's in-flight task. The Scheduler's `fs.watch`-driven callback parses the line, marks the task done, pty-writes a compact "Zone X done on t-abc: <summary>. What next?" user turn to the Conductor, and (if all in-flight tasks are complete) pty-writes an all-done turn.

A dispatch is "done" when the Conductor emits `{type: "final", summary: "…"}`. The Scheduler broadcasts `dispatch:complete` IPC once and stops invoking the Conductor.

### What the Conductor is told to do

The Conductor prompt (`orchestrator/prompts/conductor.ts → buildConductorPrompt`) instructs it to:

- **not run a loop** — the harness drives its turn-taking
- respond to each incoming user-turn summary with **exactly one** activity-log line
- emit `kind: 'note'` with `structured.type ∈ {'assign', 'answer', 'final', 'noop'}`
- use the `cat >> <path> << 'ACT_EOF' … ACT_EOF` heredoc pattern so JSON quoting stays clean
- reference zones by their `participantId` (sanitized label)
- trust the harness's user turns as ground truth — no need to inspect zone state separately

## Single-Zone Behavior

If only one zone is selected, Architect skips the Conductor entirely and delegates to `runZone` (the same path used by the Play button on a zone node):

- no Conductor session
- no Scheduler / activity-log coordination
- no `runtime/<dispatchId>/` subtree
- compact solo-mode prompt (`orchestrator/prompts/solo.ts → buildSoloZonePrompt`) that teaches the agent it's working directly with the user
- the user prompt goes directly to the zone as its first user turn

Architect still writes prompt artifacts and ensures `ARCHITECT/outputs/<zone>.md` exists, but the session launches directly with the user request and does not participate in any multi-zone protocol.

## Staleness And Liveness Detection

The v5 Scheduler's status tick (`orchestrator/status.ts → computeParticipantStatus`) uses a multi-signal decision:

1. PTY alive? → no: `exited`
2. Last activity-log line kind: `ask` → `blocked`; `failed` → `failed`; `done` on current taskId → `idle`
3. BOTH signals quiet past threshold (`ptyIdleMs > idleThresholdMs` AND `activityIdleMs > idleThresholdMs`) → `stale`
4. Otherwise → `starting` (no activity yet + no task) or `running`

Staleness requires BOTH signals quiet. PTY output alone (long silent tool call with no observable bytes) keeps the zone out of stale; activity-log writes alone likewise. This prevents false positives during long synchronous tool calls.

When a participant has been `stale` continuously for `staleEscalationMs` (default 10 min), the Scheduler pty-writes a `"Zone X stale for Nm on t-abc. Retry / reassign / fail?"` user turn to the Conductor, increments `state.staleEscalations`, and resets `state.staleAt` so the counter restarts if the stale streak continues.

If the zone PTY exits (any reason), the Scheduler marks `ptyAlive=false`, fails the in-flight task, and pty-writes a `"Zone X PTY exited (code N)…"` turn to the Conductor. The Conductor decides whether to reassign the work, emit `{type:'final'}`, or do nothing.

Default thresholds (`ProjectSettings.harnessTimeouts`, tunable in the Settings panel):

- `idleThresholdMs` = 3 min — flip to `stale`
- `staleEscalationMs` = 10 min — escalate to Conductor

## Session Persistence And Resume

Session persistence is implemented for Claude, Codex, Gemini, and OpenCode.

### How It Works

`src/main/sessionCapture.ts` snapshots each runtime's on-disk session store before spawn, then polls for a new session matching the current project.

Runtime-specific sources:

- Claude: `~/.claude/projects/<sanitized-cwd>/`
- Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
- Gemini: `~/.gemini/tmp/<project>/chats/session-*.json`
- OpenCode: the runtime's saved session metadata discovered by `snapshotOpencodeSessions()`

For fresh sessions:

1. Architect snapshots the runtime's existing sessions before spawn.
2. It spawns the new PTY.
3. It polls for a newly created session that matches the current project.
4. It saves the discovered `sessionId` into `ARCHITECT/sessions/<zone>.json`.

For resume:

- Architect reads the saved session file
- checks that the runtime-specific session is still reachable on disk
- launches the runtime-specific resume form (`claude --resume`, `codex resume`, `gemini --resume`, `opencode --continue --session`)
- optionally writes the next user prompt after spawn if needed

### Where Resume Is Used

Resume support appears in:

- zone re-open from the terminal panel
- single-zone dispatch reruns
- zone launch/resume from the zone modal
- assistant reopen

## Runtime Argument Mapping

Architect maps each runtime to its CLI invocation shape via an **adapter layer** (`src/main/runtimes/`). Every runtime implements `RuntimeAdapter` with `buildSpawnArgs`, `buildResumeArgs`, `composeSystemAndUser`, `snapshotSessions`, `captureNewSession`, `revalidateSession`. `getRuntimeAdapter(runtime)` is the only way callers acquire runtime-specific behavior — there are no runtime branches in `terminals.ts` / `dispatch.ts`.

### Claude Code (`runtimes/claude.ts`)

Spawn args: `[perms] --model <m> [--effort <level>] --append-system-prompt <system> <user>`. Resume args: `[perms] --resume <id> --model <m> [effort] <user?>`.

- `--dangerously-skip-permissions` for autonomous dispatch work; `--permission-mode plan` when plan mode is enabled
- `supportsSystemPromptFlag: true` — the only runtime with a first-class system-prompt channel
- Session capture polls `~/.claude/projects/<sanitized-cwd>/*.jsonl`

### Codex CLI (`runtimes/codex.ts`)

Spawn args: `--no-alt-screen -a never -s workspace-write --model <m> [-c model_reasoning_effort="<level>"] <user>`. Resume args: `resume <id> <operating flags> <user?>` (`resume` is a subcommand, not a flag).

- `supportsSystemPromptFlag: false` — `composeSystemAndUser` inlines the system prompt into the first user prompt via `<<SYSTEM>>…<<END>>` fold
- Approval mode pinned to `never`; sandbox pinned to `workspace-write`
- Session capture walks `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, filters by `payload.cwd` + non-subagent
- `revalidateSession` verifies the sessionId still resolves to a primary session for the current cwd

### Gemini CLI (`runtimes/gemini.ts`)

Spawn args: `--approval-mode yolo --model <m> [effort] --prompt-interactive <user>`. Resume args: `--approval-mode yolo --resume <id> --model <m> --prompt-interactive <user?>`.

- `supportsSystemPromptFlag: false` — inline fold
- Forced into autonomous approval mode (`yolo`)
- Session capture checks both hash-based (`sha256(resolve(cwd))`) and slug-based (`~/.gemini/projects.json`) dirs under `~/.gemini/tmp/*/chats/`
- `revalidateSession` verifies `projectHash` match and `kind !== 'subagent'`

### OpenCode (`runtimes/opencode.ts`)

Spawn args: `--model <m> --prompt <user>`. Resume args: `--session <id> --model <m> --prompt <user?>`.

- `supportsSystemPromptFlag: false` — inline fold
- **Always `--session <id>`, never `--continue` alone.** `--continue` loads the most-recent OpenCode session globally and silently hijacked resumes when Architect had spawned multiple opencode instances.
- Session capture spawns `opencode session list --format json` under a PTY (the CLI requires TTY for stdout flush)
- `revalidateSession` is a no-op that returns true (no cheap on-disk reachability check)

### Role prompt delivery (how the adapter layer fixed the Claude-only gap)

Under v4, the zone's role prompt was passed to `spawnAgentSession` as `appendSystemPrompt`. The spawn helper passed it to `buildRuntimeArgs` which only honored it in the `case 'claude'` branch — Codex / Gemini / OpenCode silently dropped it in multi-zone dispatch.

Under v5, every caller goes through `adapter.composeSystemAndUser(systemPrompt, userPrompt)` which returns:

- `{ appendSystemPromptFlag: systemPrompt, firstUserPrompt: userPrompt }` on Claude
- `{ firstUserPrompt: "<<SYSTEM>>…<<END>>\n\nUser:\n<user>" }` on Codex / Gemini / OpenCode

Callers set `SpawnArgs.appendSystemPrompt` to `composed.appendSystemPromptFlag` and `SpawnArgs.userPrompt` to `composed.firstUserPrompt`. Every runtime gets its role prompt — Claude via the native flag, others inlined into the first turn. No silent drop.

## Feature Matrix

| Feature | Claude | Codex | Gemini | OpenCode |
| --- | --- | --- | --- | --- |
| Spawn from zone/runtime picker | Yes | Yes | Yes | Yes |
| Per-runtime model selection | Yes | Yes | Yes | Yes |
| Multi-zone Conductor support | Yes | Yes | Yes | Yes |
| Single-zone direct run | Yes | Yes | Yes | Yes |
| Assistant panel support | Yes | Yes | Yes | Yes |
| Zone env var injection | Yes | Yes | Yes | Yes |
| Role prompt delivered to the agent | Yes (`--append-system-prompt`) | Yes (inlined fold) | Yes (inlined fold) | Yes (inlined fold) |
| Saved session capture | Yes | Yes | Yes | Yes |
| Resume saved session | Yes | Yes | Yes | Yes |
| Pre-resume reachability check | — | Yes (`isCodexSessionIdForCwd`) | Yes (`isGeminiSessionIdForCwd`) | — |
| Reset conversation semantics | Yes | Yes (delete record) | Yes (delete record) | Yes (delete record) |
| Plan mode wired to runtime args | Yes | No | No | No |
| Reasoning-effort arg | Yes (`--effort`) | Yes (`-c model_reasoning_effort`) | No (config.json + interactive `/model` only) | No (Ctrl-T cycles in-session only) |

## Current Gaps Between UI And Implementation

The UI presents some zone controls as generic, but a few still have per-runtime caveats (much narrower than the v4 era, which had silent drops of the system prompt for three of four runtimes).

### Plan Mode Is Effectively Claude-Only

The dispatch modal exposes a generic `Plan mode` checkbox.

In code: the flag is forwarded to all runtime launches via `SpawnArgs.planMode`, but only Claude's adapter consumes it (maps to `--permission-mode plan`).

Result: for Codex, Gemini, and OpenCode, checking the box changes recorded dispatch metadata but not CLI invocation behavior. The workaround is to encode "plan-mode-style" behavior in the zone's system prompt when running on non-Claude runtimes.

### Reasoning Effort Is Claude / Codex Only

`ProjectSettings.dispatchEffort` and the per-zone effort override are honored by Claude (`--effort`) and Codex (`-c model_reasoning_effort=…`). Gemini and OpenCode's CLIs don't accept an effort flag at spawn — Gemini needs a `config.json` preset plus an interactive `/model` command; OpenCode cycles variants in-session via `Ctrl-T`. The adapter's `effortArgsFor(runtime, effort)` returns `[]` for both, so the setting is dropped silently.

### Resume UI Is Multi-Runtime

The terminal panel exposes resume for exited Claude, Codex, Gemini, and OpenCode sessions when a saved session record is available. The zone editor's "Reset conversation" control deletes Architect's saved session record for that zone. Works across runtimes.

## Permissions And Autonomy Semantics

Architect does not normalize runtime permissions behind one internal policy engine. It pushes a different approval/autonomy stance per CLI:

- Claude multi-zone: `--dangerously-skip-permissions`
- Claude single-zone / assistant: interactive, no skip flag by default
- Codex: `-a never -s workspace-write`
- Gemini: `--approval-mode yolo`
- OpenCode: no extra approval mapping configured

The zone-level `tools` and `permissions` structures do not currently enforce runtime capability. They are mostly:

- stored in canvas data
- surfaced in generated prompts
- useful as behavioral instructions to the model

They are not a cross-runtime enforcement layer.

## Dispatch History

Dispatch history is stored for multi-zone runs after the Architect coordinator session is captured, regardless of whether that coordinator is Claude, Codex, Gemini, or OpenCode.

Stored record fields:

- `architectSessionId`
- `architectRuntime`
- `dispatchId`
- `zoneIds`
- `zoneLabels`
- `zoneSessions`
- `userPrompt`
- `summary`
- `model`
- `planMode`
- `timestamp`

This powers the "Prior Architect sessions" list in the dispatch modal.

Practical limitation:

- history persistence is still coupled to successful coordinator session capture, so a failed or unreachable runtime session can still leave a dispatch without a resumable record

## Architecture Assistant Behavior

The assistant is a separate session named `architect-assistant`.

On start:

1. Architect writes `ARCHITECT/.assistant-context.md`.
2. It spawns the selected runtime.
3. Fresh sessions get the prompt `Read ARCHITECT/.assistant-context.md`.
4. If a saved session for that runtime is still reachable on disk, Architect resumes it.

The assistant prompt built in `App.tsx` teaches the runtime:

- the difference between zones and components
- the current canvas state
- the palette schema
- the JSON format to write to `architect-canvas.json`
- when to discuss versus when to directly edit the canvas file

This makes the assistant an architecture editor, not the same thing as the dispatch coordinator.

## What Is Still Missing Or Incomplete

Remaining parity gaps (v5 resolved the biggest — system prompt delivery — by introducing the adapter layer):

1. **Plan-mode parity** — Claude-only (see "Current Gaps" above).
2. **Reasoning-effort parity** — Claude + Codex only.
3. **Normalized permission model** — each runtime still pushes its own autonomy flag (`--dangerously-skip-permissions`, `-a never -s workspace-write`, `--approval-mode yolo`, nothing). There is no cross-runtime capability layer.
4. **Explicit runtime capability metadata in the UI** — the Settings page could dim / annotate controls that don't map to a given runtime (`runtimeSupportsEffortFlag` exists for effort; similar helpers could be added for plan mode and system-prompt delivery).
5. **Dispatch history decoupled from session-capture success** — history persistence still depends on the Conductor's session id being captured; a capture timeout leaves the dispatch unresumable.

## Recommended Reading Order In The Code

If you want to understand the implementation quickly, read files in this order:

1. `src/shared/agentRuntimes.ts` — runtime catalog + `effortArgsFor`
2. `src/main/runtimes/types.ts` + `index.ts` — adapter interface + registry
3. `src/main/runtimes/claude.ts` / `codex.ts` / `gemini.ts` / `opencode.ts` — per-CLI adapters (each < 60 lines)
4. `src/main/sessionCapture.ts` — per-runtime session store polling + revalidation
5. `src/main/terminals.ts` — PTY lifecycle, `spawnAgentSession`, `runZone` (solo), `startDispatch` / `resumeDispatch` (thin forwarders)
6. `src/main/orchestrator/activity.ts` + `state.ts` + `status.ts` — coordination primitives
7. `src/main/orchestrator/scheduler.ts` — task state machine, activity watchers, status tick
8. `src/main/orchestrator/conductor.ts` — `parseDecision` + `compose*Turn` helpers
9. `src/main/orchestrator/dispatch.ts` — `startDispatchV5` / `resumeDispatchV5`
10. `src/main/orchestrator/workspace.ts` + `prompts/` — file layout + compact prompt builders
11. `src/main/index.ts` + `src/preload/index.ts` — IPC surface
12. `src/renderer/src/App.tsx` + `components/dispatch/DispatchModal.tsx` + `components/nodes/AgentConfigModal.tsx` — frontend
