# Dispatch-Coordination — t-docs-dispatch report

## Files touched

- `docs/orchestration.md` — patched drift against current code

## Deletions performed

- `rm architect-plans/headless-transition.md`
- `rm orch-mason-progress.md`
- `rmdir architect-plans/` (empty after deletion — confirmed gone)

## Corrections (one-liner each)

- **ActivityEvent schema**: added required `from: string` field; documented mismatch rejection + the full `ActivityRejection` set (`empty-line`, `non-json`, `not-object`, `missing-ts`, `missing-or-unknown-kind`, `missing-content`, `oversized-content`, `missing-from`, `from-mismatch`); noted 8 KB `MAX_CONTENT_BYTES` cap.
- **Heredoc example**: added `"from":"<participantId>"` to the JSON line so docs match what the prompt builders actually instruct agents to write.
- **Participants section**: `ParticipantRole` now stated as `'conductor' | 'zone'` (`'harness'` removed from the enum); rewrote the harmless "no harness participant id" sentence to match.
- **State files types line**: `role ∈ {conductor, zone}` and `lastTaskStatus ∈ {none, pending, dispatched, in-progress, blocked, done, failed}` — dropped dead `'harness'` and `'resumed'` enum values.
- **Resume flow step 2**: was "initializes state.kv skeletons with `lastTaskStatus=resumed`" — corrected to fresh `lastTaskStatus=none` (the dead `'resumed'` status was never actually written).
- **Scheduler responsibility 4 (`assign`)**: removed false claim that the scheduler writes `tasks/<taskId>.json` — it does not (only the empty `tasks/` dir is mkdir'd by `workspace.ts`); added the real validation flow (`composeAssignRejectedTurn` for `unknown-zone` / `duplicate-task` / `empty-body`) and the supersede-on-reassign behavior.
- **Scheduler responsibility 4 (`final`)**: documented the premature-final gate and `composePrematureFinalTurn` push-back when in-flight tasks remain.
- **Scheduler responsibility 4 (`answer`)**: documented routing by the pending-`ask` task (not the harness's stale current-task notion) and `blockedOn` clearing.
- **Scheduler responsibility 3**: documented the all-done signal being folded into the same conductor turn as `composeZoneDoneTurn` (because back-to-back writes coalesce paste before the 120 ms-delayed `\r`); added the orphan / cross-zone drop guard, the same-`taskId` retry contract, and `structured.blockedOn` cycle detection / `composeDeadlockTurn`.
- **Scheduler "does NOT" list**: corrected `writeToPty` → `submitTurn` (actual dep name in `SchedulerDeps`); rewrote the `session.tail` sentence (field was removed) to describe the headless terminal honestly.
- **"The one remaining screen-grid read" section**: renamed to "No screen-grid coordination" and rewrote to drop the dead `session.tail` + "debugging buffer" claim.
- **"What's intentionally NOT in v5"**: collapsed the v4 `harness.*` synthetic-events bullet to a generic "no synthetic harness events" line (the v4 enum is irrelevant now); dropped `_index.json` from the snapshot bullet.
- **New subsection — Plan mode**: added a brief block describing `composePlanModeInitialTurn`, the GO sentinel, and the runtime gate (only Claude prompts mention `ExitPlanMode`).
- **New subsection — Per-task state machine**: explicit `pending → dispatched → in-progress → {done | failed | blocked → in-progress}` diagram with the retry / supersede rules.

## Sections removed / consolidated

- Old "The one remaining screen-grid read" → replaced with "No screen-grid coordination".
- v4 `harness.*` event taxonomy in the "intentionally NOT" list → replaced with one generic line.

## Cross-doc drift for Electron-Platform (`CLAUDE.md`)

The root `CLAUDE.md` (Electron-Platform-owned) has the same `ActivityEvent` interface drift my zone just fixed in `docs/orchestration.md`. Specifically the block under **Orchestration v5 → Transport: activity logs**:

```ts
interface ActivityEvent {
    ts: string
    kind: ...
    taskId?: string
    content: string
    structured?: ...
}
```

Missing the required `from: string` field. The heredoc example a few lines below it also omits `"from"`. Same fix pattern as my doc edit.

Other CLAUDE.md drift that surfaced while reading (all Electron-Platform's call):

1. **Lifecycle state machine block**: claims `spawning → running → failed` and that "`finished` is unused — zones stay alive across tasks". Accurate, but the explanatory block sits next to a comment that mentions `'resumed'` status by implication elsewhere — recheck.
2. **Process-model tree**: the `runtime/<dispatchId>/` line says "`activity/`, `state/`, `tasks/`, `index.json`". `tasks/` is mkdir'd but nothing writes to it; `index.json` is not created either. Either start using them or drop both from the doc and from `workspace.ts → ensureDispatchDirs`.
3. **`startDispatch` IPC contract**: signature still shows `dispatchContext?` — that argument was just made into `_dispatchContext` (accepted, unused) in `terminals.ts` and removed entirely from `StartDispatchV5Input`. Worth a doc note that it's a legacy IPC param scheduled for removal.

## Follow-ups

1. **Dead `tasks/` dir**: `workspace.ts → ensureDispatchDirs` mkdir's `runtime/<dispatchId>/tasks/` but no writer exists. Either remove the mkdir or wire it up. (Same surface as CLAUDE.md item 2 above.)
2. **Activity log `ts` field is untrusted for conductor**: scheduler explicitly rewrites `lastActivityTs = new Date().toISOString()` for conductor events to defeat backdating. Worth noting in the activity-log section that the harness ignores client-supplied `ts` for staleness math even though it preserves it on the broadcast event. (Did not add — wanted confirmation before expanding the doc.)
3. **`ConductorDecision` decision flow**: doc would benefit from a state diagram (incoming user turn → activity-log line → scheduler `executeDecision` → outbound pty.write to zone). Currently described in prose only.
4. **Plan mode signal handling**: doc now mentions the GO sentinel and `ExitPlanMode`, but the actual GO-detection logic lives in the renderer (or main?) — verify and link.

## Canvas audit (t-canvas-dispatch)

Read-only audit of `architect-canvas.json`. Zone `zone-pty-orchestrator` (label "Dispatch Coordination", bbox 850/80 +760×350) overlays six components: PTY Orchestrator, Conductor, Scheduler, Activity Log, Runtime Adapters, Dispatch Record. Confirmed present and inside the bbox.

### Per-component verdict

- **PTY Orchestrator** (`pty-orchestrator`, WORKER) — ✓ matches `src/main/terminals.ts` (`spawnAgentSession`, user-control lock + turn queue, two-step submit). Owned here.
- **Conductor** (`conductor`, AI) — ✓ matches the conductor PTY spawned by `orchestrator/dispatch.ts` + parser/composers in `orchestrator/conductor.ts`. Owned here.
- **Scheduler** (`scheduler`, WORKER) — ✓ matches `orchestrator/scheduler.ts`. Owned here.
- **Activity Log** (`activity-log`, OBS) — ✓ matches `orchestrator/activity.ts` (append-only JSONL, `watchActivity`, `parseActivityLineDetailed` with `from`-mismatch guard). Owned here.
- **Runtime Adapters** (`runtime-adapters`, ADPT) — **DRIFT**. Component sits inside the Dispatch Coordination zone bbox, but the code (`src/main/runtimes/{claude,codex,gemini,opencode,fold,index,types}.ts`) is owned by Zone-Runtime-Fleet per `ARCHITECT/prompts/Zone-Runtime-Fleet.md`. Either: (a) move the component into the Zone-Runtime-Fleet zone bbox, or (b) reassign code ownership in the zone prompts. The existing `runtime-adapters → pty-orchestrator` edge (real: `terminals.ts` calls `getRuntimeAdapter`) is accurate either way; only the overlay attribution is wrong.
- **Dispatch Record** (`dispatch-record`, REC) — ✓ matches `src/main/dispatchCapture.ts` (DispatchRecord schema, `protocolVersion=5`, `pendingTasks`, append-only `conductorDecisions`). Owned here.

### Edge verdict

- `main-process → pty-orchestrator` — ✓ `src/main/index.ts` IPC handlers call into `terminals.ts`.
- `pty-orchestrator → conductor` — ✓ `dispatch.ts` calls `spawnAgentSession` for the conductor PTY (id `conductor-agent`).
- `pty-orchestrator → agent-pool` — ✓ same path spawns each zone PTY.
- `conductor → activity-log` — ✓ conductor appends decisions to `runtime/<dispatchId>/activity/conductor.jsonl`.
- `activity-log → scheduler` — ✓ `watchActivity` per file → `Scheduler.handleActivity`.
- `scheduler → agent-pool` — ✓ `pty.write` task delivery via `submitTurnToTerminal` (two-step body→120ms→\r).
- `agent-pool → activity-log` — ✓ zones heredoc-append their JSONL lines.
- `runtime-adapters → pty-orchestrator` — ✓ `getRuntimeAdapter(runtime).buildSpawnArgs / composeSystemAndUser`.
- `dispatch-record → scheduler` — ✓ resume reads `record.pendingTasks` and calls `redispatchTask`. **Partial drift**: in code the arrow is bidirectional — `Scheduler.persistPendingTasks` calls `setDispatchPendingTasks`, and `handleConductorActivity` calls `appendDispatchConductorDecision`. Canvas only shows record→scheduler. Direction could be `bidirectional` to capture both legs.

### Comm-zone components (mechanism zones, not owned by me)

The illustrative components in `Conductor Agent` (Conductor PTY, Conductor Activity Log), `Scheduler Harness` (Scheduler, fs.watch, pty.write Delivery, State KV), and `Zone Fleet` (Zone PTY A/B, Zone Log A/B) duplicate concepts I own (Activity Log gets split into Conductor + per-Zone logs; Scheduler and pty.write appear twice — once as my owned `scheduler` component, once as the mechanism-zone `comm-scheduler`). The duplication is intentional / pedagogical: the comm-zones diagram the v5 data-flow loop while my zone holds the code. The comm-zone edges (`Conductor PTY → Conductor Log → fs.watch → Scheduler → pty.write → Zone PTY → Zone Log → fs.watch → Scheduler` + `Scheduler → Conductor PTY` + `Scheduler → State KV`) accurately reflect the real flow in `orchestrator/scheduler.ts` + `orchestrator/activity.ts` + `orchestrator/state.ts` (key=value `state.kv`). No drift in the loop's shape.

### Edits needed

**none** — audit-only task. Canvas changes flagged for the canvas owner (or whoever picks up the cross-zone reorg):

1. Reassign `Runtime Adapters` overlay to the `Zone Runtime Fleet` zone (or move code ownership) — current placement misattributes `src/main/runtimes/` to Dispatch Coordination.
2. Optional: change `dispatch-record → scheduler` edge `direction` from `source-to-target` to `bidirectional` to capture `setDispatchPendingTasks` + `appendDispatchConductorDecision` write-back.
