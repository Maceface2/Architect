# Agent Dispatch Redesign

## Context

This document captures a redesign of Architect's agent dispatch system. Read alongside `agent-dispatch.md` (the current implementation) and `src/main/terminals.ts`.

The goal is to keep the overseer as the architectural brain while fixing the coordination plumbing so it can actually manage subagents in a meaningful feedback loop — not just fire-and-forget.

---

## What's Wrong With the Current System

The current design has three core problems:

**1. The overseer is a one-shot planner, not a manager.**
It writes task files and exits. There is no mechanism for it to read back what agents produced, evaluate quality, or make decisions before downstream agents start.

**2. Agent communication is one-way.**
The only signal an agent sends back is `ARCHITECT_COMPLETE`. There's no structured way for an agent to say "I made assumptions," "I hit a blocker," or "the overseer should review this before proceeding."

**3. Completion is binary.**
`ARCHITECT_COMPLETE` means "I'm done" — but it carries no information about _how_ done, what was built, or what was deferred. The overseer and main process have no basis to make a routing decision.

---

## The Three Things to Nail Down

### 1. Output Contracts

Every subagent must emit a structured summary block at the end of its session, immediately before `ARCHITECT_COMPLETE`. This gives the overseer and main process something to evaluate.

**Format** (written to `ARCHITECT/outputs/<nodeId>.md`):

```
ARCHITECT_AGENT_SUMMARY
{
  "nodeId": "api-server",
  "status": "complete" | "partial" | "blocked",
  "built": ["src/api/routes.ts", "src/api/middleware.ts"],
  "assumptions": ["Used Express, no framework was specified"],
  "unresolved": ["Auth strategy not defined — assumed JWT"],
  "confidence": "high" | "medium" | "low",
  "flagForOverseer": false
}
END_ARCHITECT_AGENT_SUMMARY
```

**Field rules:**

| Field             | Purpose                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------- |
| `status`          | `complete` = done as specified; `partial` = delivered subset; `blocked` = could not proceed |
| `built`           | File paths actually created or modified                                                     |
| `assumptions`     | Decisions the agent made without explicit instruction                                       |
| `unresolved`      | Open questions or deferred work the overseer should know about                              |
| `confidence`      | Agent's self-assessment of output quality                                                   |
| `flagForOverseer` | Explicit request for overseer review before downstream agents start                         |

**Routing rules for the main process:**

- `status: complete` + `flagForOverseer: false` + no `unresolved` items → fire downstream agents directly, no overseer needed
- `status: complete` + `unresolved` items present → re-engage overseer with summary before firing downstream
- `flagForOverseer: true` → always re-engage overseer, regardless of status
- `status: partial` or `blocked` → always re-engage overseer

**Open question:** Should agents self-assess `confidence`, or is that too unreliable? Alternative: main process infers confidence from presence/absence of `unresolved` items and whether `built` matches the task's expected output contract.

---

### 2. Overseer Re-engagement

The overseer needs to be a **persistent resumable session** that gets woken up with new context after each wave of agents completes — not a one-shot session that ends after writing task files.

**Trigger logic in the main process** (lives in `terminals.ts`, runs after each agent's `ARCHITECT_COMPLETE`):

```
agent completes
  │
  └── parse ARCHITECT_AGENT_SUMMARY block
        │
        ├── [no flag, status complete, no unresolved]
        │     └── trySpawnNode(downstream) — skip overseer, fire directly
        │
        └── [flagForOverseer OR unresolved OR partial/blocked]
              └── resume overseer session with injected context:
                    "Agent <nodeId> completed.
                     Summary: <JSON>
                     Downstream agents pending: [<labels>]
                     Decide: approve / revise <nodeId> / update downstream task"
                  → overseer writes updated task files or confirms proceed
                  → main process detects overseer's ARCHITECT_OVERSEER_PROCEED token
                  → fire downstream agents
```

**New tokens needed:**

| Token                                                   | Meaning                                                |
| ------------------------------------------------------- | ------------------------------------------------------ |
| `ARCHITECT_AGENT_SUMMARY … END_ARCHITECT_AGENT_SUMMARY` | Structured output from subagent                        |
| `ARCHITECT_OVERSEER_PROCEED`                            | Overseer approves downstream agents to fire            |
| `ARCHITECT_OVERSEER_REVISE <nodeId>`                    | Overseer requests agent re-run (main process respawns) |

**Session management:**
The overseer session must be kept resumable (`claudeSessionId`) throughout the entire dispatch run, not just for `plan_delta` cases. The main process resumes it with a fresh prompt containing the agent summary whenever re-engagement is triggered.

**Open question:** Synchronous vs. asynchronous re-engagement.

- **Synchronous:** Downstream agents are blocked until the overseer responds. Simpler, safer, slower.
- **Asynchronous:** Downstream agents that don't depend on the flagging agent can start immediately; overseer review runs in parallel and can issue a correction/stop. Faster, more complex.

Start with synchronous. Add async as an optimization once the loop is stable.

---

### 3. Wave-Based Parallelism With Overseer Checkpoints

Rather than the overseer reviewing every individual agent (fully sequential), agents are grouped into topological waves. Agents within a wave run in parallel. The overseer reviews the wave's combined output before the next wave unlocks.

**Wave structure:**

```
Overseer: full architecture plan + task files for Wave 0
  │
  ├── Wave 0: all nodes with no upstream dependencies
  │     └── [agents run in parallel]
  │           └── all Wave 0 summaries collected
  │                 └── overseer reviews combined Wave 0 output
  │                       └── ARCHITECT_OVERSEER_PROCEED → unlock Wave 1
  │
  ├── Wave 1: all nodes whose upstreams are in Wave 0
  │     └── [agents run in parallel]
  │           └── overseer reviews Wave 1 output
  │                 └── ARCHITECT_OVERSEER_PROCEED → unlock Wave 2
  │
  └── Wave N: ...
```

**Wave failure handling** — when one agent in a wave fails or flags an issue:

- **Option A (conservative):** Block the entire wave from closing. Overseer resolves before any downstream fires. Best for tightly coupled nodes.
- **Option B (permissive):** Close the wave for nodes that completed cleanly. Only block downstream nodes that directly depend on the failed/flagged agent. Better for loosely coupled nodes.

Recommended default: **Option B**. The `upstreamMap` already tracks this granularity — use it.

**Wave construction** (deterministic, runs in main process before overseer starts):

```typescript
function buildWaves(
  nodes: Node[],
  upstreamMap: Map<string, Set<string>>,
): string[][] {
  // Topological sort grouped by depth
  // Wave 0 = nodes with no upstreams
  // Wave N = nodes whose all upstreams are in waves 0..N-1
}
```

This is a pure function of the graph — no LLM needed. Waves are computed upfront and written into `manifest.json` so the overseer and main process share the same view.

---

## How the Three Pieces Connect

```
Output contracts
  → give the overseer structured data to evaluate

Re-engagement
  → give the overseer a moment to evaluate it, mid-run

Wave checkpoints
  → control when that moment happens (per-wave, not per-agent)
```

The main process becomes the **router**: it reads agent summaries, decides whether to fire downstream directly or re-engage the overseer, and manages the wave lifecycle. The overseer stays the **brain**: it plans, evaluates, and decides — but doesn't need to be in the critical path for every individual agent completion.

---

## Suggested Implementation Order

1. **Output contracts first** — add `ARCHITECT_AGENT_SUMMARY` parsing to the main process. No behavioral change yet, just capture the data. Update agent prompts to emit the block.

2. **Wave construction** — add `buildWaves()` to `terminals.ts`, write wave assignments into `manifest.json`. No change to dispatch behavior yet.

3. **Re-engagement trigger** — wire the routing logic in `trySpawnNode()`: after parsing the summary, decide whether to resume the overseer or fire downstream directly.

4. **Overseer session persistence** — change overseer lifecycle so its `claudeSessionId` is preserved across the full dispatch run, not just for `plan_delta` cases.

5. **Wave checkpoint reviews** — once per-agent re-engagement is stable, shift to per-wave: collect all summaries in a wave, then resume overseer once with the full batch.

---

## Files Most Affected

| File                             | Changes                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------- |
| `src/main/terminals.ts`          | `trySpawnNode()`, `buildWaves()`, overseer session lifecycle, summary parsing |
| `ARCHITECT/prompts/<nodeId>.md`  | Add instruction to emit `ARCHITECT_AGENT_SUMMARY` block                       |
| `ARCHITECT/prompts/architect.md` | Add wave structure, re-engagement prompt format                               |
| `ARCHITECT/manifest.json`        | Add `waves` field                                                             |
| `src/renderer/AgentLog.tsx`      | Surface wave status, overseer review state                                    |
