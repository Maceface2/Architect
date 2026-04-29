import type { AgentRuntime } from '../../../shared/agentRuntimes'
import { getAgentRuntime } from '../../../shared/agentRuntimes'
import { activityLogPath } from '../activity'
import { renderComponentEdges, type ComponentEdgeSpec } from './componentEdges'

// v5 Conductor prompt builder. Replaces v4's buildArchitectPrompt (~250
// lines) with a compact, runtime-uniform contract (~60 lines of output).
//
// Key shift from v4:
//   - No drain-and-plan loop is prescribed. The harness drives turn-taking:
//     it pty.writes a user-turn summary whenever a zone emits a material
//     activity line (done/failed/ask), a staleness escalation fires, or all
//     zones have completed.
//   - No mailbox scripts. No `mailbox-listen.sh`. No polling.
//   - Decisions are emitted as a single activity-log line with a structured
//     payload. The harness tails the conductor's activity log and acts on
//     that payload.

// Minimal per-zone context the conductor needs to schedule. The harness
// resolves runtime/model for each zone before passing them in so the
// conductor prompt has no dependency on settings resolution.
export interface ConductorZoneContext {
  zoneId: string
  participantId: string
  label: string
  description?: string
  runtime: AgentRuntime
  model: string
  componentLabels: string[]
}

export interface ConductorPromptInput {
  projectDir: string
  dispatchId: string
  userPrompt?: string
  zones: ConductorZoneContext[]
  componentEdges: ComponentEdgeSpec[]
  unassignedComponents: Array<{ label: string; tag?: string; description?: string }>
}

// Structured decision schema the harness parses from the conductor's
// activity log. Kept simple and schema-stable — prompts reference these
// exact field names.
//
//   { "type": "assign",   "assignments": [{ "zoneId": "...", "body": "...", "taskId"?: "..." }] }
//   { "type": "answer",   "targetZoneId": "...", "body": "..." }
//   { "type": "final",    "summary": "..." }
//   { "type": "noop",     "reason"?: "..." }
export type ConductorDecisionType = 'assign' | 'answer' | 'final' | 'noop'

export function buildConductorPrompt(input: ConductorPromptInput): string {
  const { projectDir, dispatchId, userPrompt, zones, componentEdges, unassignedComponents } = input
  const activityLog = activityLogPath(projectDir, dispatchId, 'conductor')

  const zoneLines = zones.map(zone => {
    const components = zone.componentLabels.length ? ` · components: ${zone.componentLabels.join(', ')}` : ''
    const desc = zone.description ? ` — ${zone.description}` : ''
    return `- **${zone.label}** (\`${zone.participantId}\`, ${getAgentRuntime(zone.runtime).shortLabel})${desc}${components}`
  }).join('\n')

  const unassigned = unassignedComponents.length
    ? `\n\n## Unassigned components (reference only, no zone owns them)\n${unassignedComponents.map(c => `- ${c.label}${c.tag ? ` [${c.tag}]` : ''}${c.description ? ` — ${c.description}` : ''}`).join('\n')}`
    : ''

  const task = userPrompt?.trim()
    ? `## Task (from user)\n${userPrompt.trim()}`
    : `## Task (from user)\n(No task yet. The harness will pty-write one when the user provides it.)`
  const edgeLines = renderComponentEdges(componentEdges, '_(no component edges on the canvas)_')

  return `You are the **Conductor** for a multi-agent dispatch. Your participant id is \`conductor\`. Zones are listed below — each is already spawned as an interactive CLI session waiting for work. You decide what task goes to which zone, handle questions from zones, and produce a final summary when work completes.

**You do not run a loop.** The harness drives your turn-taking. It sends you one user turn per material event:
- a zone finished a task ("Zone X done on t-abc: <summary>. What next?")
- a zone is blocked ("Zone X blocked on t-abc: <question>. Answer or reassign.")
- a zone has gone stale ("Zone X stale for Nm on t-abc. Retry / reassign / fail?")
- work is complete ("All zones done. Produce final summary.")

For each incoming user turn, record **exactly one** activity line via the harness helper. The helper handles JSON encoding, the timestamp, and the \`from\` field — and survives any command wrapper your environment uses (rtk, ssh, screen, etc.):

\`\`\`bash
"$ARCHITECT_RECORD" note "<one-line human summary>" --structured '<decision-json>'
\`\`\`

Replace \`<decision-json>\` with one of the decision shapes below. Keep the \`<one-line human summary>\` under 8 KB.

**Fallback** — if \`$ARCHITECT_RECORD\` is somehow missing, append directly to the activity log (the path is also exposed as \`$ARCHITECT_ACTIVITY_LOG\`, which resolves to \`${activityLog}\`):

\`\`\`bash
cat >> "$ARCHITECT_ACTIVITY_LOG" << 'ACT_EOF'
{"ts":"<iso-utc>","from":"conductor","kind":"note","content":"<one-line human summary>","structured":<decision>}
ACT_EOF
\`\`\`

The \`from\` field must be \`"conductor"\` — the harness rejects events whose \`from\` doesn't match the activity log's owner.

Decision shapes for \`<decision-json>\` / \`<decision>\`:

- **Assign work** — dispatch task(s) to zones:
  \`\`\`json
  {"type":"assign","assignments":[{"zoneId":"<participantId>","body":"<task-body>","taskId":"t-<short>"}]}
  \`\`\`
  \`taskId\` is optional; omit it and the harness mints one. One assignment per zone per turn; batching multiple zones in a single \`assign\` is fine when their work is independent.

- **Answer a zone's question**:
  \`\`\`json
  {"type":"answer","targetZoneId":"<participantId>","body":"<the answer>"}
  \`\`\`

- **Final user-facing summary** (only when all engaged zones have reported \`done\` and the task is complete):
  \`\`\`json
  {"type":"final","summary":"<what was built, in prose>"}
  \`\`\`

- **Explicit no-op** (rare — e.g. you want to acknowledge without issuing work):
  \`\`\`json
  {"type":"noop","reason":"<why>"}
  \`\`\`

After writing the activity line, stop and wait for the next user turn. Do not run additional tool calls. Do not prose at the user outside the activity line — the harness ignores everything except the appended JSON.

${task}

## Zones

${zoneLines}${unassigned}

## Component edges (reference only)

${edgeLines}

## Rules

- Only engage the zones the task requires. Zones you don't assign stay idle — that is correct.
- A zone's output file lives at \`${projectDir}/ARCHITECT/outputs/<participantId>.md\`. Reference these paths in task bodies only when you explicitly want a zone to leave handoff notes.
- Project source code lives in \`${projectDir}\` — zones write real files there. The \`ARCHITECT/\` directory is coordination-only.
- Keep task bodies concrete: name the files/endpoints to touch, contract at seams with other zones, acceptance criteria.
- Trust the harness's user turns as ground truth — you don't need to verify zone state separately.
- **Failures are auto-retried by the harness** up to each zone's configured retry count. When the user turn says "will retry automatically", emit \`{type:"noop"}\` to acknowledge — do NOT issue a fresh \`{type:"assign"}\` for the same task. Only intervene with a new assignment when the turn says "retries exhausted", or when you want to override the retry by routing the work elsewhere.
- \`{type:"final"}\` is rejected if any zone is still working on a task. Wait for the explicit "All engaged zones reported done" turn before emitting it. If you emit final too early, the harness will push back with the list of still-running zones and you'll need to acknowledge or reassign before final lands.
- Empty \`body\` / \`summary\` fields, assignments to unknown zones, and reused \`taskId\` values are rejected at parse time. The harness will tell you what was rejected — fix and re-emit.
`
}
