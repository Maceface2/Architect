# Mailbox Protocol (v4)

This document explains how Architect's v4 dispatch protocol works, why it's designed the way it is, and what the key invariants are. It is the reference for `DISPATCH_PROTOCOL_VERSION = 4` (see `src/main/dispatchCapture.ts`).

It is based on the current implementation in:

- `src/main/mailbox.ts` — protocol core: message schema, atomic writes, shell script templates, participant scaffolding
- `src/main/terminals.ts` — dispatch orchestration (`startDispatch`, `resumeDispatch`, `runZone`), `startMailboxObserver`, prompt builders
- `src/main/dispatchCapture.ts` — `DISPATCH_PROTOCOL_VERSION`, dispatch record schema
- `ARCHITECT/scripts/mailbox-*.sh` — the five bash scripts emitted per dispatch

## Why v4 Exists

v3 coordinated multi-zone dispatches by **poking** zone PTYs: the harness wrote task instructions into the zone CLI's stdin, then watched the rendered screen (`renderScreenText()` on an `@xterm/headless` buffer) for `ARCHITECT_TASK_ACK <id>` / `ARCHITECT_COMPLETE <id>` sentinels, plus a `<safe>.receipt.json` file, plus a shared `status.json` polled by the Overseer via `jq`.

Pain points:

- PTY stdin injection is fragile. Ink renderers treat multi-line writes as a paste; submit-CR has to be a separate delayed write. Every runtime has its own prompt glyph and ready semantics.
- Regexing rendered screen text is brittle and runtime-specific.
- `status.json` was a shared mutable file. The harness wrote it, the Overseer polled it. Schema drift was silent corruption.
- Re-poking required overwriting the task file to re-trigger `fs.watch`. Round bookkeeping (`lastTaskHash`, `round++`, receipt archival) existed entirely to work around that.
- Completion was a three-way AND (ack echo + receipt file + complete echo). Any two surviving was ambiguous.

v4 replaces pokes with **peer-to-peer message passing through per-participant inboxes**, inspired by `PatilShreyas/claude-code-session-bridge`. Every message is a JSON file, written atomically via `mktemp`+rename. The agent itself runs a blocking listen script as a bash tool call and formulates responses using its full conversation context. The harness shrinks to an observer + synthetic-event injector.

## Participants

Each participant owns a directory under `ARCHITECT/mailbox/`:

- `overseer` — the Architect/coordinator agent
- `<safe>` — each zone, using `sanitize(zone.data.label)` (same identity as v3 filenames)
- `__harness__` — reserved sender id for synthetic events the harness injects into the Overseer's inbox

Directory layout per participant:

```
ARCHITECT/mailbox/<id>/
  manifest.json              # { participantId, role, label, protocolVersion, startedAt, lastHeartbeat }
  inbox/<iso-ts>-<msgid>.json
  outbox/<iso-ts>-<msgid>.json   # sender's audit copy, status=read
  .tmp/                      # mktemp staging sibling dir
```

Filenames encode chronological FIFO (`<ISO-timestamp>-<msg-id>.json`) so lexicographic sort = arrival order. Tempfiles live in the sibling `.tmp/`, never the inbox — every reader filters by `*.json`. `.tmp/` lives inside the participant dir so `mv` is same-filesystem atomic.

## Who Creates Mailboxes

The harness, up front, before any PTY spawns.

In `startDispatch` (and `resumeDispatch`):

1. `wipeMailboxTree(projectDir)` — clears the entire `ARCHITECT/mailbox/` tree. Pure communication state; starts clean every run. Durable conversation lives in CLI-native session files reloaded via `resumeSessionId`, not in the mailbox.
2. `setupWorkspace(...)` — calls `createParticipant()` (`mailbox.ts:115`) for the Overseer and every zone. This scaffolds `inbox/`, `outbox/`, `.tmp/`, and `manifest.json` on disk.
3. Only then does `spawnAgentSession` run.

Agents never `mkdir` their own mailboxes. `mailbox-send.sh` calls `mkdir -p` on the peer's directories defensively (so a send can't fail with `ENOENT`), but the canonical participant create happens in TS before any PTY exists. `__harness__` has no directory — it's a sender id only.

## Launch Order And Why It Doesn't Matter

Current sequence in `startDispatch` (multi-zone branch, terminals.ts:1926–2003):

1. Spawn every zone serially, awaiting each zone's `onCaptureSettled` before snapshotting the next. Serialization is for CLI session-id capture (zones share a session directory; concurrent spawns would make "first new session id" polls collide). Dependency ordering still lives in the Overseer's prompt.
2. `startMailboxObserver(projectDir, sorted, dispatchId)` — begins watching every participant's inbox + outbox.
3. Spawn the Overseer last with the full architect prompt as `initialPrompt`.

So by the time the Overseer exists, every zone PTY is alive. But even if the order flipped, **correctness holds** because the mailbox is filesystem-backed:

- A `task` written before the zone starts listening sits in `<safe>/inbox/` as a `pending` JSON file.
- `mailbox-listen.sh` polls its own inbox every 2s in FIFO filename order. When the zone finally enters its loop, it drains whatever's there.
- Delivery is eventually consistent; no message is lost to a race.

Safety nets if a zone is slow to boot:

- Harness arms `DELIVERY_WARNING_MS` (45s) on every outgoing task. If still `pending` when the timer fires, it injects `harness.delivery-warning` to the Overseer and `harness.wake` to the zone.
- Re-firing `mailbox-listen.sh` is idempotent — it just polls harder.

The thing that *does* have to happen first is `createParticipant`. That's why scaffolding is in `setupWorkspace` pre-spawn, not lazy inside the send script.

## Message Schema

Defined in `src/main/mailbox.ts`:

```ts
interface MailboxMessage {
    id: string                // "msg-<12 hex>"
    from: string              // participantId
    to: string
    type:
        | 'task'              // overseer → zone
        | 'result'            // zone → overseer
        | 'question'          // zone → overseer (needs info)
        | 'answer'            // overseer → zone (reply to question)
        | 'cancel'            // overseer → zone (soft cancel)
        | 'session-ended'     // teardown hook
        | 'harness.pty-exit'
        | 'harness.delivery-warning'
        | 'harness.heartbeat-missed'
        | 'harness.timeout'
        | 'harness.wake'
        | 'harness.backpressure'
    timestamp: string         // ISO8601
    status: 'pending' | 'read'
    content: string           // free-form, always present
    structured: { taskId?; result?; durationMs?; blocker?; round? } | null
    inReplyTo: string | null
    metadata: { dispatchId: string; protocolVersion: 4; fromLabel: string }
}
```

Schema validation runs inside `mailbox-send.sh` (jq + type whitelist) so malformed sends exit non-zero before the file materializes. The harness-side writer (`writeMessage` in `mailbox.ts`) runs the same validation in TS.

### Why Structured Content As A Field

`content` is always a free-form string (human-readable summary). `structured` is an optional typed payload. Two reasons:

1. The agent's LLM writes `content` naturally; `structured` captures machine-readable fields (taskId for correlation, result verdict, durationMs, blocker kind).
2. Overseer can render `content` verbatim in its reasoning, and branch on `structured.result` for scheduling decisions.

## Shell Scripts

Five scripts emitted into `ARCHITECT/scripts/` by `setupWorkspace`, overwritten every dispatch:

| Script | Signature | Role |
|---|---|---|
| `mailbox-send.sh` | `<to> <type> <content-file> [inReplyTo]` | Build JSON via `jq -n`, validate, atomic write to peer's inbox + own outbox. Content passed as file path to dodge `ARG_MAX`. |
| `mailbox-listen.sh` | `<participant-id> [timeout-seconds]` | Poll own inbox every 2s. Skip `from == self` (echo prevention). Mark first matching `pending` as `read` atomically, print `METADATA_K=V` lines + `---` + content. `timeout=0` means infinite. |
| `mailbox-drain.sh` | `<participant-id>` | Overseer-only. Return **all** `pending` messages as a JSON array (FIFO by filename), mark all `read` atomically, exit. |
| `mailbox-status.sh` | *(no args)* | Walk every participant's outbox/inbox, emit a summary JSON. Used by Overseer + harness. |
| `mailbox-cleanup.sh` | *(no args)* | Dispatch teardown. Sends `session-ended` to every peer. |

All scripts are bash + `jq` only. No `inotifywait`/`fswatch` — polling in shell, `fs.watch` only in Electron main for UI.

Agents are spawned with `MBX_ROOT`, `MBX_SELF`, `MBX_SELF_LABEL`, `MBX_DISPATCH_ID`, `MBX_SCRIPTS` env vars (`mailboxEnv()` in terminals.ts), so script invocations don't need path discovery.

## Agent Loops

**Zone (worker) loop**, prescribed by `buildZoneSystemPrompt(..., 'dispatch')`:

```
loop:
  run: bash $MBX_SCRIPTS/mailbox-listen.sh <safe>
  parse stdout: METADATA_K=V lines, then '---', then content
  dispatch on type:
    task   → do the work, append progress to ARCHITECT/outputs/<safe>.md,
             send a `result` via mailbox-send.sh
    answer → consume clarification, continue in-flight task
    cancel → abort, send result with structured.result='blocked'
    harness.wake → no-op, just re-enter the loop
  IMMEDIATELY goto loop. Never stop listening.
```

**Overseer (planner) loop**, prescribed by `buildArchitectPrompt`:

```
loop:
  run: bash $MBX_SCRIPTS/mailbox-listen.sh overseer 30
       # 30s timeout so the loop unblocks periodically even when idle
  if any message arrived:
    run: bash $MBX_SCRIPTS/mailbox-drain.sh overseer
    for each message (FIFO):
      dispatch by type (result / question / harness.*)
    plan next round, send new task messages via mailbox-send.sh
  goto loop
```

**Asymmetry is intentional.** Zones are workers (one task at a time, respond, immediately re-listen). The Overseer is a scheduler — drain the inbox in one shot and plan across the full batch. Batched reasoning over accumulated results is the point; it's why the Overseer pays the 30s timeout cost instead of indefinite blocking.

## Harness Role (Shrunken From v3)

`startMailboxObserver` in `terminals.ts` is an observer + synthetic-event injector. It does NOT poke PTYs after bootstrap, does NOT scrape screens for ack/complete, does NOT write `status.json` (there is no `status.json`).

What it does:

1. **Spawn PTYs**, capture CLI session ids, write prompts, scripts, participant manifests (all pre-v4-style; unchanged).
2. **One bootstrap `sendPrompt` per session** at first-ready, telling the agent to read its prompt file and enter its loop. Per-task delivery never touches the PTY after that.
3. **Watch every participant's inbox + outbox via `fs.watch`**, broadcast `mailbox:activity` IPC on each write, refresh `ARCHITECT/mailbox/_index.json` (harness-owned observability snapshot).
4. **Arm two timers per outgoing task**:
   - `DELIVERY_WARNING_MS` (45s) — if still `pending` in the zone's inbox, inject `harness.delivery-warning` to Overseer + `harness.wake` to the zone.
   - `DEFAULT_TASK_TIMEOUT_MS` (30min, or zone override — only extends, never shortens) — if no matching `result` arrives, inject `harness.timeout`.
5. **Heartbeat scan every 15s**; fires `harness.heartbeat-missed` for any in-flight task where `outputs/<safe>.md` mtime AND PTY `lastActivityMs` AND `tracker.startedAt` have all been quiet for `IDLE_THRESHOLD_MS` (2 min). OR-of-three; any signal advancing keeps the zone alive. `tracker.startedAt` prevents stale outputs file mtime from prior runs tripping the check on fresh dispatch.
6. **PTY exit**: inject `harness.pty-exit`, flip the participant to `state: 'exited'` in `_index.json`, preserve the mailbox dir as a tombstone so the Overseer gets a structured answer (`{ state: 'exited', exitCode, tail }`) if it asks about the dead zone later.
7. **Two-tier cancel**: soft `cancel` message is consumed by the zone on its next listen turn. Hard-cancel fires `SIGINT` to the zone PTY after `HARD_CANCEL_MS` (60s) of unconsumed pending `cancel`.
8. **Deduplication**: `fs.watch` on macOS fires multiple events per atomic rename. `scheduleTaskTimers` no-ops if `taskTrackers.has(msg.id)` — otherwise every task would arm duplicate `harness.*` timers.

## `_index.json` — Single Pane Of Glass

Replaces v3's shared-mutable `status.json`. Harness-owned derived snapshot, rewritten on every mailbox write:

```ts
interface MailboxIndex {
    dispatchId: string
    protocolVersion: 4
    updatedAt: string
    participants: Record<string, {
        role: 'overseer' | 'zone' | 'harness'
        label: string
        state: 'starting' | 'running' | 'idle' | 'exited' | 'unknown'
        lastActivityMs: number
        exitCode?: number
        pendingTaskIds: string[]
        inboxPending: number
        outboxCount: number
        tail: string            // last N bytes of PTY output — debugger view
    }>
}
```

`state: 'unknown'` is a valid value — used when a participant has no recent PTY activity AND no pending inbox work. We can't distinguish "thinking silently" from "loop broken" from a single snapshot. The Overseer's prompt treats `unknown` as "probably fine, check back next tick."

### Single Source Of Truth

The Overseer MUST NOT probe `~/.claude/`, the process tree, CLI-native session stores, or any other ambient state to ask "does zone X exist / what's it doing?" Those are eventually consistent or flat-out wrong during a live dispatch. Every question the Overseer can ask is answered by:

- reading its own inbox
- running `mailbox-status.sh`
- inspecting `_index.json`

Existence = `_index.json.participants.has(<id>)`, not a filesystem probe.

## Lifecycle

Session lifecycle: `spawning → ready → running → failed`. Note `finished` is gone from v4 — agents live in a continuous listen loop and only exit via PTY close (which flips to `failed`). Per-task state lives in `_index.json.participants[*].state`, not in the session lifecycle. Broadcast via `terminal:status` IPC.

## Resume

`resumeDispatch` rebuilds the workspace from scratch:

1. `wipeMailboxTree(projectDir)` — the dispatch picker lets the user pick any historical dispatch, so the shared `ARCHITECT/mailbox/` has almost certainly been trampled by later runs. Durable conversation is in the CLI's own session store (`~/.claude/projects/...`, etc.), reloaded via `resumeSessionId`. Mailbox starts clean.
2. `setupWorkspace(...)` regenerates prompts, scripts, and participant mailboxes.
3. Spawn each zone with `resumeSessionId` (pinned from the `DispatchRecord`) + `initialPrompt: buildBootstrapBody('zone', safe, projectDir)`. The CLI's native resume flag replays conversation history; the bootstrap body tells the agent "you're back — re-enter the listen loop." This is the **one exception** to the "resume stays idle" rule that governs user-facing sessions — see `memory/feedback_resume_user_prompt.md`.
4. Spawn the Overseer with `resumeSessionId` + the Architect prompt as `initialPrompt`. User-facing, so no auto-poke; the user types the first message.
5. `startMailboxObserver(...)` resumes observation.

Protocol gate: v3 and older records fail resume with `legacy-protocol`. Clean cut, no dual-protocol flag.

## Solo-Zone Launches (No Mailbox)

Two paths:

- `runZone` (ZoneLaunchModal Play button) — spawns one zone, user-driven.
- `startDispatch` with exactly one selected zone — delegates to `runZone`.

Both use `buildZoneSystemPrompt(..., 'solo')`, which omits the mailbox listen-loop instructions. The zone talks directly to the user; there is no Overseer, no mailbox observer, no `MBX_*` env vars. Mailbox scripts still get written by `setupWorkspace` (harmless; no one invokes them).

This is why `buildZoneSystemPrompt` takes a `mode: 'dispatch' | 'solo'` parameter. A unconditional dispatch-mode prompt would make solo zones try to run `mailbox-listen.sh` and crash on missing `MBX_ROOT`.

## What Was Rejected

- **`claude --output-format stream-json`** (and equivalents). Would eliminate all screen-grid parsing, including the one remaining `spawning → ready` cue. Rejected because Architect surfaces the zone PTY to the user in xterm.js; stream-json emits JSON-per-line instead of the interactive rendered UI. Regresses the "watch your agent work" UX. If a future version of Architect splits control-plane from display-plane, revisit.
- **A full `Capabilities`-per-CLI adapter refactor.** Valuable for runtime parity, but a `sessionCapture.ts` concern, not a mailbox concern. Out of scope.
- **Client-generated CLI session IDs** (`claude --session-id <ours>`). Would remove eventual-consistency races on session existence, but again — `sessionCapture.ts`, not mailbox. Mailbox participant IDs (`overseer` / `<safe>` / `__harness__`) are already client-owned, which is all v4 needs.
- **Dual-protocol flag** (`settings.dispatchProtocol: 'v3' | 'v4'`). Rejected in favor of a clean cut via `DISPATCH_PROTOCOL_VERSION`. Doubles the surface of the exact file we're trying to shrink; no external consumers forcing staged rollout.

## v3 → v4 Blocker-Kind Mapping

For anyone reading old code comments or prior-art docs:

| v3 `blocker.kind` | v4 equivalent |
|---|---|
| `delivery-failed` (no ack 45s) | `harness.delivery-warning` + `harness.wake` |
| `idle-stuck` (outputs stale 90s) | `harness.heartbeat-missed` (2 min, OR-of-three signals) |
| `task-timeout` (30min) | `harness.timeout` |
| `pty-exit` | `harness.pty-exit` |
| `malformed-completion` | rejected at send time; malformed → `result.structured.result='failed'` |
| `zone-reported` | `result` with `structured.result ∈ {blocked, failed}` |

## Related Docs

- [agent-behavior.md](agent-behavior.md) — runtime-level behavior, feature matrix, per-CLI quirks
- [frontend.md](frontend.md) — renderer architecture
- `CLAUDE.md` / `AGENTS.md` (symlinked) — day-to-day agent guidance, includes a compressed version of this protocol
