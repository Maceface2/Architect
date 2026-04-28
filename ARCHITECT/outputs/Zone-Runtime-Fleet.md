# Zone-Runtime-Fleet — t-docs-runtime

Audit of `docs/agent-behavior.md` against current `src/main/runtimes/**` and `src/main/sessionCapture.ts`.

## Corrections (one-liner each)

- **Session record path**: doc claimed `ARCHITECT/sessions/<zone>.json` (flat). Actual layout is `ARCHITECT/sessions/<zoneKey>/<sessionId>.json` with a `MAX_ZONE_SESSIONS = 20` cap and oldest-pruned. Replaced; also clarified that `ZoneSessionRecord` carries `runtime, sessionId, capturedAt, summary, model?, dispatchId?`.
- **OpenCode resume form**: doc listed `opencode --continue --session` in the resume bullet. The adapter never passes `--continue`; resume is `--session <id>` only. Fixed (and tightened the "never bare `--continue`" warning later in the file to match: "Architect never passes `--continue`").
- **OpenCode argv ordering**: doc had `--model <m> --prompt <user>` for spawn and `--session <id> --model <m> --prompt <user?>` for resume. Adapter actually emits `--prompt` before `--model` in both. Fixed both lines.
- **`revalidateSession` semantics**: doc said "checks that the runtime-specific session is still reachable on disk" with no per-runtime detail. Replaced with the actual split — Codex / Gemini implement a real on-disk check; Claude / OpenCode return `true` and let the CLI surface failures at resume time.
- **Capture entry points**: doc described capture in prose only. Updated to reference the adapter methods callers actually use (`snapshotSessions(cwd)` / `captureNewSession(cwd, snapshot)`).

## Verified accurate (no change needed)

- RuntimeAdapter interface enumeration (line ~217): `supportsSystemPromptFlag, buildSpawnArgs, buildResumeArgs, composeSystemAndUser, snapshotSessions, captureNewSession, revalidateSession` — matches `runtimes/types.ts`.
- Claude spawn/resume argv shape, `--dangerously-skip-permissions` vs `--permission-mode plan`, `~/.claude/projects/<sanitized-cwd>/*.jsonl` capture path.
- Codex `--no-alt-screen -a never -s workspace-write`, `resume <id>` subcommand-not-flag, `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` walk filtered by `payload.cwd` + non-subagent.
- Gemini `--approval-mode yolo`, `--prompt-interactive`, `--resume`, dual-dir lookup (sha256 hash + `~/.gemini/projects.json` slug).
- `<<SYSTEM PROMPT … >> <<END SYSTEM PROMPT>>` fold for Codex/Gemini/OpenCode (the doc's `<<SYSTEM>>…<<END>>` shorthand is fine — verbatim wrapper is in `runtimes/fold.ts`).
- Feature matrix rows for plan-mode (Claude only) and reasoning-effort (Claude `--effort` / Codex `-c model_reasoning_effort` only).
- Multi-zone v5 flow, conductor decision shape, `DISPATCH_PROTOCOL_VERSION = 5` reference.

## Sections removed / rewritten

- None wholesale-removed. Kill-list scan came back clean: no v4 mailbox/script references in this doc (only the historical line at §"Multi-Zone Orchestration" noting that `setupWorkspaceV5` wipes legacy `mailbox/` + `scripts/`, which is a current behavior of the workspace setup and stays). No `ZoneSession` alias references. No deprecated lifecycle states (`finished` / `mailbox-listen.sh` / sigil scanning). The v4-vs-v5 narrative under §"Role prompt delivery" is historical context for *why* the adapter layer exists and was kept intentionally — describes shipped behavior, not speculation.

## Cross-doc drift — for Electron-Platform (`CLAUDE.md`) to assess

- `CLAUDE.md` line 17: still describes Gemini as "(partial)". With session capture, resume, role-prompt fold, and dispatch participation all shipping today, the only remaining Gemini gaps are reasoning-effort (no spawn-time flag) and plan-mode (no flag, Claude-only feature). "Partial" reads stronger than the actual gap. Suggest tightening to "Gemini (no plan-mode / effort-flag parity)" or dropping the qualifier.
- `CLAUDE.md` runtime-adapter bullet at line 32 calls `fold.ts` "shared inline-system-prompt wrapper". After the t-cleanup-runtime pass, `fold.ts` also exports `foldComposeSystemAndUser` (used by codex/gemini/opencode adapters as their `composeSystemAndUser` directly). Suggest amending to "shared inline-system-prompt wrapper + `composeSystemAndUser` helper".
- Neither file (`CLAUDE.md`, `docs/agent-behavior.md`) currently points the other direction; cross-references are one-way. Optional follow-up.

## Follow-ups

1. **`ZoneSessionRecord.model` field**: declared in the type, written by `appendZoneSession`, read by `AssistantLaunchModal` + `DispatchModal`, but `readRecord` in `sessionCapture.ts` strips it on load. Doc now asserts the field is present in the record — once the read-side fix lands (flagged in t-cleanup-runtime follow-ups), this becomes accurate end-to-end. Until then, the doc reflects the *intended* (and written-side) contract.
2. **Per-runtime resume revalidation depth**: doc could add a short table mapping each runtime to its concrete revalidation predicate (cwd match for Codex / projectHash + non-subagent for Gemini / always-true for Claude/OpenCode). Skipped here to avoid feature creep — current prose covers it.
3. **Session capture timeouts**: capture uses hard-coded 30 s (Claude) / 90 s (others). Doc doesn't surface these; if Settings ever exposes them via `harnessTimeouts` (also flagged in last cleanup), document at that time.
4. **Recommended Reading Order step 4** still says "per-runtime session store polling + revalidation" — accurate but could reference the new `forEachCodexDayDir` helper for readers walking the codex section. Optional, low value.

## Canvas audit (t-canvas-runtime)

Audit of `architect-canvas.json` zone `zone-agent-pool` ("Zone Runtime Fleet") and its four owned components against `src/main/runtimes/**`, `src/main/sessionCapture.ts`, `src/main/terminals.ts`, `src/main/orchestrator/prompts/`, and the on-disk `ARCHITECT/` + `skills/` layouts.

### Zone node verdict

- `zone-agent-pool` label / description / tools (fileRead+fileWrite+shell) match the zone's actual responsibilities. ✓ No drift.

### Components

- **Agent Pool (`agent-pool`)** — ✓ Accurate. Spec correctly attributes spawn to `orchestrator/dispatch.ts` (multi-zone) and `terminals.ts → runZone` (solo); names the adapter system-prompt path (Claude `--append-system-prompt` vs inline fold for the rest); names the bootstrap "Acknowledge with 'Ready'…" turn that exists verbatim in the spawn code. No drift.
- **Session Capture (`session-capture`)** — ✓ Accurate. Spec lists the four runtime capture sources (`~/.claude/projects/<cwd>/`, `~/.codex/sessions/`, `~/.gemini/tmp/`, `opencode session list`) — all match `sessionCapture.ts`. Persistence path `ARCHITECT/sessions/<zoneKey>/<sessionId>.json` with max 20 / oldest-pruned matches `appendZoneSession` + `pruneToMax` (`MAX_ZONE_SESSIONS = 20`). Adapter-method reference (`adapter.captureNewSession`) matches `runtimes/types.ts`. No drift.
- **Skills Library (`skills-library`)** — ✓ Accurate-with-one-nit. The `builtin:` / `custom:` scheme is real (`readSkillContent` in `src/main/terminals.ts:892` resolves `builtin:<name>` → `<__dirname>/../../skills/<name>/SKILL.md`, `custom:<path>` → arbitrary file). Repo-root `skills/` exists with ~50+ SKILL.md folders. The spec attributes inlining to `orchestrator/prompts/zone.ts` and `prompts/solo.ts` — those builders DO inline the resolved contents verbatim (verified: `skills.map(s => \`### ${s.name}\n${s.content}\``). Nit: the **resolution** (file read) actually happens in `terminals.ts → readSkillContent`, upstream of the prompt builders; the spec implies the prompt builders also do the read. Cosmetic — describing the "ingested into prompts" outcome correctly. No edit needed.
- **Agent Workspace (`workspace`)** — ✓ Accurate. Durable list (`sessions/<zoneKey>/<sessionId>.json`, `dispatches/<sessionId>.json` per `DispatchRecord`, `outputs/<safe>.md`, `terminal-layout.json`) and ephemeral list (`runtime/<dispatchId>/{activity,state,tasks,index.json}`, `prompts/conductor.md`, `prompts/<safe>.md`) all match `setupWorkspaceV5` + `sessionCapture.ts` + `dispatchCapture.ts`. Legacy v4 `mailbox/` + `scripts/` wipe-on-entry matches CLAUDE.md and current workspace setup. No drift.

### Edges

- `e8 skills-library → agent-pool` — ✓ Real flow: `readSkillContent` reads `skills/<name>/SKILL.md` → `buildZonePrompt` / `buildSoloZonePrompt` inline → `adapter.composeSystemAndUser` → PTY spawn. Direction correct (skill content flows into agents at spawn time).
- `e9 agent-pool → workspace` — ✓ Real flow: live zone PTYs append to `ARCHITECT/runtime/<dispatchId>/activity/<participantId>.jsonl` and append narrative notes to `ARCHITECT/outputs/<safe>.md`. Direction correct.
- `e18 session-capture → agent-pool` — ✓ Real flow: `snapshotSessions` runs pre-spawn, `captureNewSession` polls post-spawn, captured `sessionId` is fed back to the spawn pipeline (and to the resume path via `getZoneSessionRecord` → `buildResumeArgs`). Direction correct (capture metadata feeds Agent Pool's spawn/resume).
- (Out-of-zone but adjacent) `e11 pty-orchestrator → agent-pool`, `e14 scheduler → agent-pool`, `e15 agent-pool → activity-log`, `e16 runtime-adapters → pty-orchestrator` — ✓ All consistent with the actual code paths.

### Edits needed

**none** — components, specs, and edges all reflect shipped behavior. The single nit (skill file resolution location) is cosmetic and does not warrant a canvas edit.
