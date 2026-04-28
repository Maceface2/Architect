
## Canvas audit (t-canvas-fleet)

**Zone PTY A (`comm-zone-a`)** — VERDICT: illustrative placeholder, acceptable. Code reality: `dispatch.ts` spawns N zones in a `for (const zone of selectedZones)` loop (line 325) / `for (const zone of zones)` (line 120). There is no fixed "A" PTY in the code — every zone in the user's graph becomes a PTY via `spawnAgentSession`. Description is accurate ("First live zone agent CLI session") but framing it as a discrete fixed slot risks misreading. **Mild drift.**

**Zone PTY B (`comm-zone-b`)** — VERDICT: illustrative placeholder, acceptable. Same as above; "Works in parallel with Zone A once all zones are spawned" correctly captures the serial-spawn / parallel-work pattern. **Mild drift** (canvas implies a 2-zone design; code is N-zone).

**Zone Log A (`comm-zone-log-a`)** — VERDICT: accurate. Maps to real `ARCHITECT/runtime/<dispatchId>/activity/<participantId>.jsonl` (confirmed by `activity.ts` header comment line 5). Append-only JSONL with fs.watch is correct.

**Zone Log B (`comm-zone-log-b`)** — VERDICT: accurate. Independent fs.watch + offset tracker per file is correct (matches scheduler design).

**Edge `comm-pty-write` → `comm-zone-a/b`** — VERDICT: accurate. Scheduler delivers `TASK <id>: <body>` user turns via `writeToParticipant` (two-step body + CR submit).

**Edge `comm-zone-a/b` → `comm-zone-log-a/b`** — VERDICT: accurate. Agents append via `cat >> <path> << 'ACT_EOF'` heredoc inside their own shell tool — not the harness.

**Edge `comm-zone-log-a/b` → `comm-fswatch`** — VERDICT: accurate. Closes the loop; per-file `fs.watch` parses one ActivityEvent per newline.

**Zone overlap with Renderer-UX / Dispatch-Coordination** — No attribution confusion in this zone's components. PTY UI (xterm rendering, user-control lock keystroke detection) belongs to Renderer-UX; PTY spawn / activity-log file management belongs to Dispatch-Coordination. Zone Fleet's components correctly represent only the *runtime artifact* (live PTY session + its log file), not the spawning code or the rendering surface.

**Edits needed: none.** The A/B framing is a known illustrative simplification (the canvas can't show N dynamic instances), descriptions already explicitly call out the N-zone reality ("Zones are spawned serially…work in parallel after all bootstrap turns complete"). Acceptable as-is.
