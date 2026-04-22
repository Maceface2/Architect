# Agent Behavior And Runtime Support

This document explains how Architect actually runs agents, how zones behave at dispatch time, and which CLI integrations are complete versus partial.

It is based on the current implementation in:

- `src/main/terminals.ts`
- `src/main/sessionCapture.ts`
- `src/shared/agentRuntimes.ts`
- `src/renderer/src/components/dispatch/DispatchModal.tsx`
- `src/renderer/src/components/nodes/AgentConfigModal.tsx`

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
- optional upstream/downstream relationship context
- a behavior prompt

At dispatch time Architect generates:

- a zone system prompt file in `ARCHITECT/prompts/<zone>.md`
- mailbox participant directories in `ARCHITECT/mailbox/<participant>/`
- a matching output/status log path in `ARCHITECT/outputs/<zone>.md`

## Prompt Layers

Architect uses two distinct prompt layers.

### 1. System Prompt Layer

Generated from zone configuration and canvas context. It includes:

- zone identity and description
- upstream and downstream zone names
- enabled tool names
- component list and specs
- component-to-component wiring inside the zone
- embedded `SKILL.md` contents
- the freeform behavior text from the zone editor
- the instruction to write real code in the project root

This is built by `buildZoneSystemPrompt()`.

### 2. Bootstrap / Task Layer

Dispatch-specific work is not delivered by PTY polling anymore.

In multi-zone mode:

- each zone gets a one-shot bootstrap prompt telling it to read `ARCHITECT/prompts/<zone>.md`
- the zone then enters the mailbox listen loop via `ARCHITECT/scripts/mailbox-listen.sh <participantId>`
- the Architect coordinator and the zones exchange `task`, `result`, `cancel`, and harness messages through mailbox inbox/outbox JSON files

That separation still matters:

- the system prompt defines durable zone identity and working rules
- mailbox messages carry the specific work for one dispatch

## Multi-Zone Orchestration

When there are two or more zones, Architect runs in coordinator mode.

### Sequence

1. `runGraph()` normalizes settings and filters the selected zones.
2. `setupWorkspace()` writes the manifest, prompts, diagram, mailbox scaffold, and output directories.
3. Architect pre-spawns every selected zone plus one `architect-agent` coordinator session.
4. The coordinator gets `ARCHITECT/prompts/architect.md`.
5. Each zone gets `ARCHITECT/prompts/<zone>.md`, `MBX_*` environment variables, and a bootstrap instruction to enter the mailbox loop.
6. `startMailboxObserver()` watches every participant inbox/outbox, updates `ARCHITECT/mailbox/_index.json`, emits `mailbox:activity` renderer events, and injects harness warnings/timeouts when a task stalls.
7. Task routing and handoffs happen through mailbox messages rather than `ARCHITECT/tasks/*.md` polling.

### What The Coordinator Is Told To Do

The coordinator prompt instructs it to:

- read `ARCHITECT/manifest.json`
- write mailbox `task` messages for the selected zones
- read mailbox `result` / harness messages and react to them
- monitor `ARCHITECT/outputs/`
- coordinate downstream handoffs through mailbox traffic and prompt context
- avoid using sub-agents or task tools

The coordinator is therefore a filesystem orchestrator, not a direct runtime supervisor.

## Single-Zone Behavior

If only one zone is selected, Architect skips the coordinator.

Behavior changes:

- no `Architect` coordinator session
- no mailbox observer coordination loop
- the user prompt goes directly to the zone runtime
- the session is treated as interactive instead of autonomous coordinator-managed work

Architect still writes prompt artifacts to `ARCHITECT/`, but the session launches directly with the user request.

## Mailbox And Liveness Detection

Architect does not use runtime-native task callbacks.

Instead, the mailbox observer watches filesystem activity and PTY state:

- zone inbox files reveal newly delivered `task` and `cancel` messages
- zone outbox files reveal `result` replies
- `ARCHITECT/outputs/<zone>.md` mtimes provide one liveness signal
- PTY byte activity provides another liveness signal

If a task stays pending too long or a participant goes quiet, the observer injects harness messages such as:

- `harness.delivery-warning`
- `harness.wake`
- `harness.timeout`
- `harness.heartbeat-missed`
- `harness.pty-exit`

This is more accurate than the old sentinel-string flow, but it is still a file-mediated protocol rather than a runtime-native orchestration API.

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

Architect maps each runtime to a hard-coded CLI invocation shape in `buildRuntimeArgs()`.

### Claude Code

Arguments used:

- `--dangerously-skip-permissions` for autonomous multi-zone work
- `--permission-mode plan` when plan mode is enabled
- `--resume <sessionId>` for persisted conversations
- `--model <model>`
- `--append-system-prompt <prompt>` on fresh spawn only
- positional prompt text for initial work

Claude is the most complete integration because it supports:

- system prompt injection
- plan mode wiring
- persisted session resume
- conversation reset by deleting saved session metadata

### Codex CLI

Arguments used:

- `--no-alt-screen`
- `-a never`
- `-s workspace-write`
- `resume <sessionId>` when resuming
- `--model <model>`
- positional prompt text

Consequences:

- Codex always runs with approval mode effectively disabled from Architect's side.
- Sandbox mode is fixed to `workspace-write`.
- There is no runtime-specific plan mode support in the current adapter.
- Saved Codex sessions can be resumed.
- Zone system prompts are not passed as a separate first-class argument.

### Gemini CLI

Arguments used:

- `--approval-mode yolo`
- `--resume <sessionId>` when resuming
- `--model <model>`
- `--prompt-interactive <prompt>`

Consequences:

- Gemini is always forced into an autonomous approval mode.
- Saved Gemini sessions can be resumed.
- There is no system prompt injection equivalent in the current adapter.
- Plan mode in the UI does not translate into Gemini-specific runtime behavior.

### OpenCode

Arguments used:

- `--continue --session <sessionId>` when resuming
- `--prompt <prompt>`
- `--model <model>`

Consequences:

- OpenCode currently has the thinnest integration.
- No explicit approval-mode mapping is configured.
- Saved OpenCode sessions can be resumed.
- No system prompt injection path exists in the adapter.
- No plan mode handling exists.

## Feature Matrix

| Feature | Claude | Codex | Gemini | OpenCode |
| --- | --- | --- | --- | --- |
| Spawn from zone/runtime picker | Yes | Yes | Yes | Yes |
| Per-runtime model selection | Yes | Yes | Yes | Yes |
| Multi-zone coordinator support | Yes | Yes | Yes | Yes |
| Single-zone direct run | Yes | Yes | Yes | Yes |
| Assistant panel support | Yes | Yes | Yes | Yes |
| Zone env var injection | Yes | Yes | Yes | Yes |
| Zone system prompt injection as dedicated runtime arg | Yes | No | No | No |
| Saved session capture | Yes | Yes | Yes | Yes |
| Resume saved session | Yes | Yes | Yes | Yes |
| Reset conversation semantics | Yes | No | No | No |
| Plan mode wired to runtime args | Yes | No | No | No |
| Runtime-specific permission strategy implemented | Yes | Partial | Partial | Minimal |

## Important Gaps Between UI And Implementation

The UI presents some zone controls as generic, but the code does not implement them generically.

### System Prompt Is Effectively Claude-Only

The zone editor says the system prompt is passed as `--append-system-prompt` on first spawn. That is true only for Claude.

For Codex, Gemini, and OpenCode:

- `appendSystemPrompt` is computed
- `spawnAgentSession()` passes it into `buildRuntimeArgs()`
- `buildRuntimeArgs()` ignores it for those runtimes

Result:

- non-Claude zones do not receive the zone behavior prompt through a dedicated system-prompt channel
- in single-zone runs they only get the user prompt
- in multi-zone runs they only get the bootstrap instruction to read the prompt file and enter the mailbox loop

This is one of the biggest current parity gaps.

### Plan Mode Is Also Effectively Claude-Only

The dispatch modal exposes a generic `Plan mode` checkbox.

In code:

- the flag is forwarded to all runtime launches
- only Claude actually consumes it in `buildRuntimeArgs()`

Result:

- for Codex, Gemini, and OpenCode, checking the box currently changes recorded dispatch metadata but not CLI invocation behavior

### Resume UI Is Multi-Runtime

The terminal panel exposes resume for exited Claude, Codex, Gemini, and OpenCode sessions when a saved session record is available.

The zone editor's "Reset conversation" control deletes Architect's saved session record for that zone. That works across runtimes, but only Claude also has dedicated system-prompt support, so the practical effect still varies by runtime.

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

## What Is Missing Or Incomplete Compared To A Fully Unified Runtime Layer

If Architect is meant to support multiple CLIs equally, these are the main missing pieces:

1. Non-Claude system prompt support.
2. Runtime-aware "reset conversation" semantics outside Claude.
3. Runtime-aware plan mode behavior outside Claude.
4. A normalized permission model rather than per-runtime hard-coded flags.
5. Better runtime-native orchestration than filesystem mailbox observation.
6. Explicit runtime capability metadata so the UI can disable unsupported controls instead of implying parity.
7. Dispatch history decoupled from session-capture success.

## Recommended Reading Order In The Code

If you want to understand the implementation quickly, read files in this order:

1. `src/shared/agentRuntimes.ts`
2. `src/main/terminals.ts`
3. `src/main/sessionCapture.ts`
4. `src/main/index.ts`
5. `src/preload/index.ts`
6. `src/renderer/src/App.tsx`
7. `src/renderer/src/components/dispatch/DispatchModal.tsx`
8. `src/renderer/src/components/nodes/AgentConfigModal.tsx`
