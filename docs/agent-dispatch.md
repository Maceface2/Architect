# Agent Dispatch & Scheduling

This document describes how Architect schedules, coordinates, and dispatches node agents end-to-end. It covers everything from initial project analysis through PTY session management to renderer display.

**Core design principle:** no subprocess spawning between agents. The overseer and agents coordinate exclusively through the filesystem — the overseer writes task files, agents write output files, and the main process bridges them via `fs.watch()`.

---

## Table of Contents

1. [Project Bootstrap](#1-project-bootstrap)
2. [Preflight System](#2-preflight-system)
3. [Launch Scopes](#3-launch-scopes)
4. [Workspace Setup](#4-workspace-setup)
5. [Prompt Construction](#5-prompt-construction)
6. [Session Lifecycle](#6-session-lifecycle)
7. [Task-File-Driven Dispatch](#7-task-file-driven-dispatch)
8. [Full Data Flow Diagram](#8-full-data-flow-diagram)
9. [Renderer Integration](#9-renderer-integration)

---

## 1. Project Bootstrap

**Source:** `src/main/projectAnalyzer.ts → bootstrapProjectCanvas()`

When a project has no `architect-canvas.json`, the bootstrap pipeline runs to generate an initial canvas.

### Pipeline

```
bootstrapProjectCanvas(projectDir, runtime)
  │
  ├── detectCandidateNodes(projectDir)       → ImportedProjectNode[]
  ├── buildEdges(nodes)                       → ImportedProjectEdge[]
  ├── buildStructureSummary(projectDir, nodes) → ProjectStructureSummary + confidence
  │
  ├── [if confidence === "high"] ──────────── return deterministic result
  │
  └── [if confidence === "low" | "medium"] ──→ synthesizeArchitectureFromAgent()
        │
        ├── runOneShotAgentPrompt(buildImportPrompt(structure, deterministicNodes))
        ├── Wait for ARCHITECT_IMPORT_COMPLETE token (120s timeout)
        ├── parseImportBlock() — extract JSON between ARCHITECT_PROJECT_IMPORT markers
        └── normalizeImportedGraph() — validate, deduplicate, infer missing fields
```

### Deterministic Heuristics

**Directory priority** (`TOP_LEVEL_PRIORITY`): `apps`, `packages`, `services`, `server`, `api`, `backend`, `web`, `app`, `client`, `frontend`, `src`, `db`, `database`, `prisma` — these are checked before generic directories.

**Category inference** (regex on path):

- `db|database|prisma|migrations|schema|postgres|redis|cache` → `storage`
- `api|server|backend|service|worker|queue|auth|gateway` → `services`
- `web|client|frontend|ui|renderer|desktop|mobile|app` → `infrastructure`

**Edge inference rules:**

- `infrastructure` → first `services` node (UI→API)
- `services` → first `storage` node (API→DB)
- All non-storage → test nodes (components→tests)

**Confidence scoring:**
| Condition | Score Δ |
|-----------|---------|
| 2–8 nodes detected | +2 |
| Only 1 node | -2 |
| Many root implementation files | -2 |
| Mixed languages | -1 |
| `score ≥ 3` → `high`, `≥ 1` → `medium`, else `low` |

### Agent Fallback

When confidence is `low` or `medium`, a one-shot agent prompt is built from:

- Directory tree (4 levels, max 220 entries)
- Candidate boundaries with per-boundary reasoning
- Representative file samples (`package.json`, `index.ts`, `schema.prisma`, etc.)
- The deterministic draft as a starting point

The agent's response is delimited: `ARCHITECT_PROJECT_IMPORT … END_ARCHITECT_PROJECT_IMPORT`. Output is parsed, repaired if needed, and normalized through `normalizeImportedGraph()` which validates field types, truncates strings to limits, and merges with deterministic fallback values.

---

## 2. Preflight System

**Source:** `src/main/terminals.ts → buildPreflightSummary()`

Runs before every dispatch. Nodes are topologically sorted first so upstream status can inform downstream classification (e.g., detecting `blocked_by_upstream`).

### Node Classification

| Status                | Condition                                                                                                                      | Launch Intent |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| `missing`             | All tracked `ownedPaths` + `expectedFiles` absent from disk                                                                    | `build`       |
| `adopted`             | No ownership metadata defined, OR code exists without prior Architect output file                                              | `plan_delta`  |
| `needs_delta`         | `additionalChanges` field non-empty, OR node changed since dispatch snapshot, OR redispatch with this node in `changedNodeIds` | `plan_delta`  |
| `blocked_by_upstream` | At least one upstream node has non-`unchanged` status                                                                          | `plan_delta`  |
| `unchanged`           | All tracked paths exist, output file documented, no upstream change                                                            | `skip`        |

`launchIntent` determines:

- Whether the agent receives "build from scratch" or "inspect existing code, then minimal delta" instructions
- Whether Claude session resumption is attempted (`plan_delta` + `claudeSessionId` present → resume)

Returns `GraphPreflightSummary`: `{ generatedAt, counts: Record<PreflightNodeStatus, number>, nodes: PreflightNodeResult[] }`.

---

## 3. Launch Scopes

**Source:** `src/main/terminals.ts → resolveLaunchScope()`

Controls which nodes and edges are included in a given dispatch.

| Mode       | Nodes            | Edges                             | Overseer instruction                                                 |
| ---------- | ---------------- | --------------------------------- | -------------------------------------------------------------------- |
| `all`      | Every node       | Every edge                        | "This launch includes every node on the current canvas."             |
| `selected` | Specified subset | Only edges between selected nodes | "Only coordinate: [labels]. Do not create tasks for external nodes." |
| `single`   | One node         | Same as `selected`                | Same as `selected`                                                   |

Nodes with edges crossing the scope boundary are collected as `omittedConnectedNodeLabels` — the overseer receives these as context but must not write task files for them.

---

## 4. Workspace Setup

**Source:** `src/main/terminals.ts → setupWorkspace()`

Creates the following structure inside the project directory:

```
ARCHITECT/
  manifest.json          ← full graph + launch metadata + launch scope
  preflight.json         ← GraphPreflightSummary
  diagram.md             ← Mermaid graph of scoped nodes
  outputs/
    Architect.md         ← overseer coordination log (written by overseer at runtime)
    <nodeId>.md          ← per-agent status log (written by agent at runtime)
  prompts/
    architect.md         ← overseer system prompt
    <nodeId>.md          ← per-agent prompt
  tasks/
    <nodeId>.md          ← task file written by overseer, triggers agent spawn
```

All agent-produced files (real code) go to the **project root**, never inside `ARCHITECT/`.

---

## 5. Prompt Construction

**Source:** `src/main/terminals.ts → buildArchitectPrompt()`, `buildNodePrompt()`

### Overseer Prompt (`ARCHITECT/prompts/architect.md`)

Built by `buildArchitectPrompt()`. Contains:

- **Launch scope summary** — which nodes are active vs. external context only
- **Mermaid architecture diagram** — visual DAG of scoped nodes and edges
- **Workspace preflight table** — per-node: status, owned paths, existing files, missing files, launch intent
- **Agent roster** — for each node: description, runtime, model, user goal, contracts, upstream/downstream relationships
- **Re-dispatch context** (when applicable) — which node labels changed, explicit instruction not to re-run unchanged nodes
- **Coordination instructions:**
  1. Read `ARCHITECT/manifest.json`
  2. Respect preflight status — do not write tasks for `unchanged` nodes
  3. Write task files in topological order (upstream first) to `ARCHITECT/tasks/<nodeId>.md`
  4. Each task must specify: launch mode, files to create/modify scoped to `ownedPaths`, API contracts/ports/schemas, what to read from upstream output files, clear acceptance criteria
  5. Write coordination log to `ARCHITECT/outputs/Architect.md`
  6. Monitor `ARCHITECT/outputs/` for agent completion and update downstream task files with concrete runtime details

### Agent Prompt (`ARCHITECT/prompts/<nodeId>.md`)

Built by `buildNodePrompt()`. Contains:

- **Node identity** — label, tag, description, user-written prompt, `additionalChanges`
- **Launch scope context** — scoped node labels vs. external labels
- **Relationship graph** — upstream nodes this agent depends on; downstream nodes that depend on it
- **Tools** — enabled tool capabilities
- **Skills** — full content of each assigned `SKILL.md` file, embedded verbatim
- **Workspace state** — preflight status, owned paths, expected files, contracts, review hints
- **Mode-specific instructions:**
  - `build`: implement greenfield from the task file spec
  - `plan_delta`: inspect existing code first, read prior output at `ARCHITECT/outputs/<nodeId>.md`, apply only the next required delta
- **Completion signal:** agent's final action must be `echo ARCHITECT_COMPLETE`

---

## 6. Session Lifecycle

**Source:** `src/main/terminals.ts → spawnAgentSession()`, `createSession()`  
**Source:** `src/main/agentCli.ts → buildRuntimeArgs()`, `resolveBinary()`

### PTY Spawning

Each session is spawned via `node-pty`:

```
pty.spawn(resolvedBinary, buildRuntimeArgs(runtime, prompt, model, resumeSessionId), {
  name: 'xterm-256color', cols: 220, rows: 50,
  cwd: projectDir,
  env: { ...process.env, ...node.data.envVars },
})
```

**Runtime arguments:**

| Runtime    | Flags                                                                          |
| ---------- | ------------------------------------------------------------------------------ |
| `claude`   | `--dangerously-skip-permissions [--resume <sessionId>] [--model <m>] <prompt>` |
| `codex`    | `--no-alt-screen -a never -s workspace-write [--model <m>] <prompt>`           |
| `gemini`   | `--approval-mode yolo [--model <m>] --prompt-interactive <prompt>`             |
| `opencode` | `[--prompt <p>] [--model <m>]`                                                 |

**Binary resolution:** checks `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin` before falling back to `which <binary>` via the user's login shell.

### Completion Detection

Agents signal completion by running `echo ARCHITECT_COMPLETE` as their final action. The main process detects this via `hasStandaloneToken()`:

```
buffer → stripAnsi() → replace(\r, \n) → split(\n) → any line.trim() === token
```

- Default token: `ARCHITECT_COMPLETE`
- Resumed sessions get a unique token: `ARCHITECT_COMPLETE_${uuid.slice(0,8)}` (prevents collision with prior session output)

On detection: `session.done = true`, completion callbacks fired, PTY killed.

### Session Resumption (Claude only)

On session completion, the main process:

1. Resolves the newest `.jsonl` session file under `.claude/projects/${base64(projectDir)}/`
2. Emits `node:session-saved` IPC event with `{ nodeId, sessionId }`
3. Renderer updates `node.data.claudeSessionId` and saves canvas

On next dispatch, if `launchIntent === 'plan_delta'` and `claudeSessionId` is present, the agent is spawned with `--resume <sessionId>` and a resume-specific prompt that reads the task file and prior output log before making any changes.

---

## 7. Task-File-Driven Dispatch

**Source:** `src/main/terminals.ts → trySpawnNode()`, `fs.watch()`

This is the core dependency-ordering mechanism. Agent PTYs are not spawned upfront — they are spawned reactively when their task file appears and their upstream dependencies are complete.

### Mechanism

```
fs.watch('ARCHITECT/tasks/')
  │
  └── on .md file write (size > 0):
        ├── taskReady.add(nodeId)
        └── trySpawnNode(nodeId)
              │
              ├── Guard: not triggered AND taskReady AND all upstream in agentDone
              │
              ├── [gate passes] → triggered.add(nodeId)
              │     ├── resolve runtime, model from node config
              │     ├── read ARCHITECT/prompts/<nodeId>.md
              │     ├── check for claudeSessionId:
              │     │     ├── [yes] → spawnAgentSession({ resumeSessionId })
              │     │     └── [no]  → spawnAgentSession({ initialPrompt: prompt })
              │     └── register onSessionDone callback:
              │           ├── agentDone.add(nodeId)
              │           ├── trySpawnNode(downstream) for each downstream
              │           └── [if triggered.size === nodeMap.size] → close watcher
              │
              └── [gate fails] → deferred (downstream callback will retry)
```

### Routing Maps

Built before the overseer is spawned:

- `upstreamMap`: `nodeId → Set<nodeId>` — all in-scope upstream dependencies
- `downstreamMap`: `nodeId → Set<nodeId>` — all in-scope downstream dependents
- `triggered`, `taskReady`, `agentDone` — Sets tracking dispatch state

---

## 8. Full Data Flow Diagram

```
Renderer: dispatchGraph(mode, nodeIds)
  │
  └── window.electron.runGraph(nodes, edges, projectDir, settings, options)
        │                                [IPC → main process]
        │
        ├── killAll()                    kill any prior PTY sessions + watcher
        ├── resolveLaunchScope()         determine which nodes/edges are active
        ├── buildPreflightSummary()      classify each node (topological order)
        ├── filter → actionablePlans     exclude 'skip' nodes
        │
        ├── [if no actionable nodes] → return early, sessions: []
        │
        ├── setupWorkspace()             write manifest, preflight, diagram, prompts
        ├── build upstreamMap/downstreamMap
        ├── fs.watch('ARCHITECT/tasks/') arm task watcher
        │
        ├── spawnAgentSession('architect-agent') ← OVERSEER starts here
        │     │
        │     └── overseer reads manifest, writes task files in topo order
        │           │
        │           └── each task file write → fs.watch fires → trySpawnNode()
        │                 │
        │                 └── [upstream done] → spawnAgentSession(nodeId)
        │                       │
        │                       └── agent executes, writes outputs/, echoes ARCHITECT_COMPLETE
        │                             │
        │                             └── completion detected → agentDone.add()
        │                                   │
        │                                   └── trySpawnNode(downstream...)
        │
        └── return { sessions: TerminalInfo[], preflight: GraphPreflightSummary }
                │                              [IPC → renderer]
                │
                ├── setTerminalSessions() → TerminalPanel shows PTY tabs
                ├── setLastPreflight()   → AgentLog shows preflight counts
                └── setActiveTab('Terminal')

[async, ongoing]
  terminal:data IPC events → TerminalPanel writes to xterm instances
  AgentLog polls ARCHITECT/outputs/ every 2s → shows agent output files
  node:session-saved IPC → App.tsx saves claudeSessionId to node, persists canvas
```

---

## 9. Renderer Integration

### App.tsx — Dispatch Orchestration

- `dispatchGraph(mode, nodeIds)` constructs `RunGraphOptions` (scope + dispatch context) and calls `window.electron.runGraph()`
- After dispatch: stores `terminalSessions`, `lastPreflight`, and a per-node data hash snapshot (`dispatchedGraph`) used to detect changed nodes on re-dispatch
- Canvas polling loop (1200ms interval, only when `!isDirty`): picks up external edits to `architect-canvas.json` such as those made by the Architecture Assistant

### AgentLog.tsx — Output Monitor

- Polls `ARCHITECT/outputs/` every 2000ms via `window.electron.readOutputs()`
- Tracks per-file `mtime` to detect updates and auto-scroll
- Tab per output file; `Architect` tab always first
- When no agents running: shows preflight summary counts from last dispatch

### AssistantPanel.tsx — Architecture Assistant

- Runs a separate PTY session with the project's default runtime
- Streams terminal output through `parseForUpdates()` which scans for `ARCHITECT_CANVAS_UPDATE … END_ARCHITECT_CANVAS_UPDATE` blocks
- JSON is parsed with a repair pass (`repairWrappedJson`) to handle ANSI-split strings
- Valid blocks are passed to `onCanvasUpdate()` → `applyCanvasUpdate()` in App.tsx, which merges with existing positions and config then saves canvas immediately
- Parse buffer is capped at 50,000 chars to prevent unbounded growth

### TerminalPanel.tsx — PTY Display

- One `xterm.js` instance per session ID, cached in a module-level `termInstances` map so scroll history survives tab switches
- All terminal divs are mounted; only the active one is visible (`display: block/none`)
- `ResizeObserver` on the active tab triggers `fit()` + `terminal.resize()` IPC
- User keystrokes → `terminal.input(id, data)` IPC → main process PTY
- Exit event appends `[process exited]` to the xterm buffer

### ArchitectNode.tsx — Node Card

- **Status dot:** `idle`=nodeColor, `running`=amber `#fbbf24`, `done`=green `#4ade80`, `error`=red `#f87171`
- **Task preview:** after dispatch (`launchRevision` increments), node polls `ARCHITECT/tasks/<nodeId>.md` up to 20 times (1.5s intervals) and shows the first 180 chars in the card body
- **Zap button (⚡):** toggles `selected` on the ReactFlow node for use with "Dispatch Selected" mode
- **Runtime badge:** shows assigned runtime; grayed prefix `default:` when inheriting from project settings
- **Node modal:** opens full config — prompt, additional changes, resume session ID, skills, tools, behavior, permissions, env vars
