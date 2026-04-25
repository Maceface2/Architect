# Architect: Headless Execution Migration Plan

## 1. Current Approach and Pain Points

Architect runs every agent — zones and the conductor — as a long-lived PTY session via `node-pty`. All coordination flows through `pty.write` calls (task delivery, conductor prompts) and `fs.watch` on append-only JSONL activity logs that agents write by executing `cat >> file << 'ACT_EOF'` heredocs as bash tool calls.

**Structural pain points:**

**PTY input fragility.** Task delivery requires a two-step submit: write the text, wait 120ms, then write `\r`. This works around Claude's TUI treating a large paste burst as one input event rather than a message-plus-enter. The window is empirical; different system loads or TUI versions could break it silently.

**Session capture is a polling race.** Every fresh spawn snapshots session files before spawn, then polls until a new file appears post-spawn. Zones must send a bootstrap prompt (`"Acknowledge readiness with 'Ready'"`) specifically to force the CLI to materialize a session file on disk. If the poll times out (20s), the session id is lost and resume breaks permanently.

**No context control.** PTY sessions accumulate the full conversation history in the CLI's native session store. There is no way to summarize, prune, or steer context without ending the session. Long dispatches drift toward context overflow silently.

**System prompt injection is inconsistent.** Claude gets `--append-system-prompt`; every other runtime uses the `fold.ts` inline hack (`<<SYSTEM PROMPT>>...<<END SYSTEM PROMPT>>`), which depends on the agent recognizing and honoring an ad-hoc wrapper format — not a CLI guarantee.

**Activity log protocol requires bash execution.** Agents must write JSONL activity lines by executing a shell heredoc as a tool call. This is fragile on runtimes that sandbox bash differently, and it means all coordination events are one bash execution away from being silently dropped.

**Staleness detection requires dual signals.** Because a PTY can stay visually quiet during a long tool call, the scheduler requires both PTY idle time and activity-log idle time before marking a participant stale. This is necessary precisely because PTY output is the only liveness signal available.

**OpenCode hang bugs.** The adapter works around a known issue where `--continue` without an explicit session id silently hijacks the wrong session; there are additional hang regressions that make OpenCode unreliable for coordinated dispatch.

---

## 2. Target Architecture: Headless Invocations with Manual Context

Replace long-lived PTY sessions with **per-turn headless CLI invocations**. Each zone and the conductor run as a short-lived subprocess per turn. After every turn, the harness captures structured output and appends it to a per-zone conversation history file. The next turn is submitted by passing that history as input.

**What this buys:**

- **Structured JSON output per turn.** Claude Code's `--print --output-format stream-json` mode emits newline-delimited JSON events (text, tool use, tool result, final result). No TUI, no screen-scraping, no sigil detection.
- **Context is owned by the harness.** The conversation lives in an Architect-managed file, not a CLI session store. At any point we can summarize earlier turns, drop irrelevant tool output, inject updated system context, or cap total tokens.
- **No session capture polling.** There is no "did a session file appear" problem because there are no persistent sessions. Turn inputs and outputs are plain files.
- **No pty.write timing hacks.** Task delivery is just a JSON input to a subprocess invocation, not a keystroke sequence injected into a running TUI.
- **System prompt is always under our control.** With headless Claude, `--system` or `--append-system-prompt` works independently of session history. Other runtimes can receive the system prompt as a clean first-message field once we own the conversation format.
- **Activity events become output fields.** Rather than requiring agents to `cat` a JSONL line to a file as a bash tool call, the harness can parse activity intent directly from the structured output — or agents can emit a single structured tool call that the harness intercepts before passing to the next turn.

**Turn execution model:**

```
for each scheduled task delivered to a zone:
  input = { systemPrompt, conversationHistory, newUserTurn: "TASK <id>: <body>" }
  result = spawnHeadless(runtime, input)   // subprocess, exits when done
  output = parseStructuredOutput(result)   // JSON events → ActivityEvent
  conversationHistory.append({ user: newUserTurn, assistant: output.text, tools: output.toolUse })
  activityLog.append(output.activityEvent) // derived, not agent-executed
  emit activityEvent to scheduler
```

The scheduler logic is unchanged — it still watches activity logs and drives the conductor. The surface area that changes is only the "how a turn gets executed and how events are captured."

---

## 3. Runtime Prioritization

**Claude Code — highest priority.** Already the most mature integration. `claude --print --output-format stream-json` is a stable, documented interface. Stream-JSON events include assistant text, tool use, tool results, and a final result block. The conversation history format (`--resume` with a session id) can be replaced with Architect-owned JSONL history passed via `--input-file` or piped stdin once that API stabilizes; in the interim, use `--print` with explicit resume for multi-turn chains. Claude should be the reference implementation for the headless adapter interface.

**Codex — second priority.** OpenAI Codex CLI has a non-interactive mode (`codex run` or `--no-alt-screen` with a prompt) that produces reasonably parseable output. Context injection is more limited — Codex does not have a public conversation-history API equivalent. Strategy: pass the prior turn summary as part of the user prompt rather than full history replay. Lower fidelity than Claude but sufficient for zone-level tasks.

**Gemini — text-mode only, no context replay for now.** Gemini CLI's headless flag (`--prompt-interactive`) effectively runs single-turn. Multi-turn context would require the full `--resume` chain, which reintroduces session state. For now, Gemini zones operate as single-turn executors: each task is a fresh call with the system prompt and task body, no conversation replay. Suitable for independent tasks; unsuitable for multi-step work within a single zone.

**OpenCode — hold.** Known hang bugs in the CLI make it unreliable even for PTY mode. Do not invest in a headless adapter until those bugs are resolved upstream.

---

## 4. Context Storage and Injection Per Zone

Each zone gets a durable context file at:

```
ARCHITECT/runtime/<dispatchId>/context/<participantId>.jsonl
```

Format: one JSON line per exchange, ordered chronologically.

```json
{ "role": "user",      "content": "TASK t-abc: …",         "ts": "…", "taskId": "t-abc" }
{ "role": "assistant", "content": "…",                      "ts": "…", "taskId": "t-abc", "toolUse": […] }
```

**System prompt** is stored separately and re-injected on every turn (not embedded in history). This means the system prompt can be updated between turns — for example, to reflect a new upstream zone's output — without altering history.

**Context budget management.** Before each turn, the harness counts approximate tokens in the history. When approaching a configurable ceiling (default: leave 30% headroom for the model's context window), older exchanges are summarized: send the history up to the cutoff to a cheap summarization call and replace those lines with a single `{ "role": "system", "content": "Summary of prior work: …" }` entry. The summary call uses the same runtime as the zone but with a fixed, short prompt — it does not consume a zone turn or produce an activity event.

**The conductor's context** is also harness-managed. Each conductor turn consists of: system prompt + last N task/status events as the user turn. The conductor has no need to replay its full history — it only needs enough context to make the next routing decision. Default window: last 20 activity events.

---

## 5. Orchestrator/Conductor Changes

The scheduler's internal structure is largely preserved. What changes is the execution and event-delivery layer beneath it.

**Zone execution.** The `writeToPty(ptyId, text)` dep in `SchedulerDeps` is replaced with `executeZoneTurn(participantId, text): Promise<ActivityEvent>`. The scheduler awaits the turn result rather than fire-and-forgetting a pty.write and watching a log for a response. This eliminates the staleness/stale-detection loop for turn execution — a turn either returns or times out at the subprocess level. Staleness detection remains useful for cases where the agent is mid-tool-execution and the turn hasn't returned yet.

**Activity events become synchronous returns.** Instead of the agent appending to an activity log file via bash, the headless turn runner parses the structured JSON output and derives the activity event directly. The JSONL activity log file is still written (for audit, resume, and the renderer's `activity:event` stream), but the harness writes it, not the agent.

**Conductor decisions.** The conductor turn still emits a `kind: 'note'` line with a `structured.type` decision field — but it does so as part of its assistant response text, which the turn runner parses. The `parseDecision` logic in `orchestrator/conductor.ts` is unchanged.

**No more bootstrap prompt.** Because there are no sessions to materialize, zones do not need a `"Acknowledge readiness with 'Ready'"` first turn. The first turn is the first real task.

**Turn-level timeout.** Each headless invocation gets a per-turn timeout (default: 5 minutes). If the subprocess does not exit, the runner sends SIGTERM, marks the activity event as `failed`, and the scheduler proceeds to retry/escalation as today.

---

## 6. Migration Approach

**Phase 1: Add `HeadlessAdapter` interface alongside `RuntimeAdapter` (no removal).**

Define a new `HeadlessAdapter` interface in `src/main/runtimes/types.ts`:

```ts
interface HeadlessTurnInput {
  systemPrompt: string
  history: ConversationEntry[]
  userTurn: string
  model?: string
  cwd: string
  env?: Record<string, string>
  timeoutMs?: number
}

interface HeadlessTurnResult {
  assistantText: string
  toolUse?: ToolUseEntry[]
  activityEvent?: ActivityEvent   // derived by the adapter from structured output
  exitCode: number
}

interface HeadlessAdapter {
  readonly id: AgentRuntime
  executeTurn(input: HeadlessTurnInput): Promise<HeadlessTurnResult>
}
```

Implement `ClaudeHeadlessAdapter` first, backed by `claude --print --output-format stream-json`. All other runtimes continue using the existing PTY path.

**Phase 2: Introduce `HeadlessZoneRunner` in the orchestrator.**

Add `src/main/orchestrator/headlessRunner.ts`. It wraps `HeadlessAdapter.executeTurn`, reads/writes the context file, derives the activity event, and appends to the JSONL activity log. The scheduler receives a new dep `executeTurn` that can be backed by either the headless runner or the existing pty.write path, switchable per-zone.

Add a zone-level setting (`zone.data.executionMode: 'pty' | 'headless'`) defaulting to `'pty'`. Wire `dispatch.ts` to pass the appropriate dep based on the zone's setting.

**Phase 3: Default Claude zones to headless, keep others on PTY.**

Once the headless runner is proven stable for a few Claude-only dispatches, flip the default for `runtime === 'claude'` zones to `headless`. Conduct tests with the PTY flag as a fallback escape hatch (the canvas setting stays accessible).

**Phase 4: Implement Codex headless adapter, migrate conductor.**

Add `CodexHeadlessAdapter` with the summarized-history injection strategy. Then switch the conductor to headless — the conductor is a single-runtime session (usually Claude) and is the highest-value target because conductor PTY failures block the whole dispatch.

**Phase 5: Deprecate PTY path for coordinated dispatch.**

Once headless is the default and stable for Claude + Codex, mark the PTY coordinated-mode path as legacy. The solo zone flow (ZoneLaunchModal, `runZone`) stays PTY-based — that's a human-interactive session and PTY is correct there.

**What stays PTY forever:** solo zone launches (Flow A), the assistant side panel. These are interactive by design; headless execution is not appropriate.

---

## Open Questions

- **Claude `--input-file` / stdin history format**: the exact API for passing conversation history to `claude --print` without `--resume` needs verification against the current CLI version. If it's not available, the interim approach is `--resume` with the harness capturing the session id for history access, or passing prior context inline in the system prompt.
- **Token counting**: approximate counting (character-based) is fine for the MVP context budget; switch to tiktoken or the model's native count endpoint if precision matters.
- **Parallel vs. serial headless turns**: two zones can execute turns concurrently since headless subprocesses are independent. The serialization lock currently in `serializeAgentSpawn` is for session capture only — it can be dropped in headless mode.
