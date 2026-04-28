# Scheduler-Harness scratchpad

## Canvas audit (t-canvas-harness)

Audited `architect-canvas.json` against `src/main/orchestrator/{scheduler,activity,state}.ts` and `src/main/terminals.ts`.

### Per-component verdict

- **Scheduler (`comm-scheduler`)** — MATCH. Specs cite `orchestrator/scheduler.ts` and the real per-task state machine (`pending → dispatched → in-progress → {done|failed|blocked}`), `writeToParticipant` to assign, conductor-turn synthesis on done/failed/ask, the 15 s status tick, and `pendingTasks[]` persistence to DispatchRecord. All confirmed in `scheduler.ts` (writeToParticipant calls at lines 204/259/270/277/312/470/505/509/534/562/586/597/772; tick + resume logic present).

- **fs.watch (`comm-fswatch`)** — MATCH. Specs cite `orchestrator/activity.ts → watchActivity`, per-file `fs.watch`, byte-offset + partial-line buffer, pre-existing-bytes drain on attach, JSON.parse per newline, malformed lines logged + skipped. Confirmed: `activity.ts:176` defines `watchActivity`, `activity.ts:240` calls `fs.watch(path, () => drain())`, comment block at 170 documents the macOS multi-fire handling.

- **pty.write Delivery (`comm-pty-write`)** — MATCH. Specs cite the two-step submit (text → 120 ms → bare `\r`), 220 ms inter-turn gap, and the `userControlState` queue. Confirmed in `terminals.ts:741` (`SUBMIT_BODY_TO_CR_MS = 120`), `:742` (`INTER_TURN_GAP_MS = 220`), `:737` (`userControlState`), `:738` (`turnQueue`), and the user-control-during-120ms-gap CR-skip at `:764-769`. The "single-burst text+\r leaves the turn typed but unsubmitted" rationale matches the comment at `:745-747`.

- **State KV (`comm-state-kv`)** — MATCH. Specs cite `ARCHITECT/runtime/<dispatchId>/state/<participantId>.kv`, atomic mktemp+rename, the listed fields, ephemerality, and reconstructability from activity log + DispatchRecord. Confirmed in `state.ts:8` (path comment) and `state.ts:169` (`fs.renameSync(tmp, path)` atomic write).

### Edge verdict

All 12 edges (`comm-e1` … `comm-e12`) match the real call graph:

- `comm-conductor-pty → comm-conductor-log` (conductor appends decisions) ✓
- `comm-conductor-log → comm-fswatch → comm-scheduler` (watch fires → scheduler routes) ✓
- `comm-scheduler → comm-pty-write → {comm-zone-a, comm-zone-b}` (writeToParticipant → terminals.ts two-step) ✓
- `{comm-zone-a, comm-zone-b} → {comm-zone-log-a, comm-zone-log-b} → comm-fswatch` (closes the loop) ✓
- `comm-scheduler → comm-conductor-pty` (synthesized done/failed/ask/stale/exit/all-done turns) ✓
- `comm-scheduler → comm-state-kv` (per-transition + 15 s tick KV writes) ✓

No missing or wrong-direction edges within the harness comm-* set.

### Cross-zone double-counting (overlap with Dispatch-Coordination)

Flagged. The canvas has parallel pairs where the same source file is represented twice — once as a Dispatch-Coordination component and once as a Scheduler-Harness comm-* component:

- `scheduler` (DC) ↔ `comm-scheduler` (SH) — both point at `src/main/orchestrator/scheduler.ts`.
- `activity-log` (DC) ↔ `comm-fswatch` + `comm-conductor-log` + `comm-zone-log-*` (SH) — DC's `activity-log` already covers `watchActivity` and the JSONL schema.
- `pty-orchestrator` (DC) ↔ `comm-pty-write` (SH) — DC's `pty-orchestrator` already documents `userControlState` + `turnQueue` from `terminals.ts`; `comm-pty-write` re-states the 120 ms / 220 ms two-step.
- `conductor` (DC) ↔ `comm-conductor-pty` (SH) — DC's `conductor` already describes the conductor PTY spawn, initial turn, and decision schema.

This is canvas-modelling double-counting (same code surfaces split across two zones), not a code defect. The harness comm-* set is accurate at finer granularity (it models the wires, not just the boxes), so the duplication is intentional-looking — but worth flagging if the canvas convention is "one component per source surface."

### Edits needed

none — audit-only task. Canvas accurately reflects scheduler.ts / activity.ts / state.ts / terminals.ts. Cross-zone overlap flagged above for human review.
