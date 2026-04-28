
## Canvas audit (t-canvas-conductor)

- **Conductor PTY (comm-conductor-pty)**: MATCHES. Spec cites `dispatch.ts` + `composeInitialTurn` + scheduler-driven turns. Real wiring: `CONDUCTOR_PTY_ID = 'conductor-agent'` spawned in `src/main/orchestrator/dispatch.ts:62,306,433,577,638`; initial turn delivered via argv from `composeInitialTurn` (`conductor.ts:77`, `dispatch.ts:417`). Verdict: accurate.
- **Conductor Activity Log (comm-conductor-log)**: MATCHES. Spec cites `ARCHITECT/runtime/<dispatchId>/activity/conductor.jsonl` with `kind:note` + ConductorDecision union. Real file present at `ARCHITECT/runtime/84f77e81f2212384/activity/conductor.jsonl`. `parseDecision` in `conductor.ts` handles `assign|answer|final|noop`. Verdict: accurate.
- **Edge comm-conductor-pty → comm-conductor-log (comm-e1)**: MATCHES. Conductor writes its decision lines via `cat >> … << 'ACT_EOF'` heredoc per its own prompt; this is the agent's sole output channel.
- **Edge comm-conductor-log → comm-fswatch (comm-e2)**: MATCHES. `activity.ts:240` uses `fs.watch(path, …)` inside `watchActivity` (line 176); `scheduler.ts:135` calls `watchActivity` for the conductor log. Per-file fs.watch is real.
- **Edge comm-scheduler → comm-conductor-pty (comm-e11)**: MATCHES. Scheduler pty.writes the harness-synthesized user-turn summaries (done/failed/ask/stale/pty-exit/all-done) to the conductor PTY each material event, per CLAUDE.md "Conductor decisions" section and `writeToParticipant` in scheduler.

Overlap check with Dispatch-Coordination zone: No double-counting. The Dispatch-Coordination zone owns the scheduler/dispatch orchestration code (`dispatch.ts`, `scheduler.ts`, `activity.ts`); the Conductor-Agent zone owns only the *conductor PTY* and its *conductor.jsonl* output channel — i.e. the agent-facing surface, not the harness implementation. The directional edges (scheduler→pty, log→fswatch) correctly cross the zone boundary toward Dispatch-Coordination components, which is the right attribution.

Edits needed: none.
