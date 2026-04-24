import { join } from 'path'
import type { AgentRuntime } from '../../../shared/agentRuntimes'
import { getAgentRuntime } from '../../../shared/agentRuntimes'
import { activityLogPath } from '../activity'

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
  upstreamLabels: string[]
  downstreamLabels: string[]
}

export interface ConductorPromptInput {
  projectDir: string
  dispatchId: string
  userPrompt?: string
  zones: ConductorZoneContext[]
  zoneEdges: Array<{ fromLabel: string; toLabel: string }>
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

function buildMermaid(zones: ConductorZoneContext[], zoneEdges: Array<{ fromLabel: string; toLabel: string }>): string {
  const lines: string[] = ['```mermaid', 'graph TD']
  for (const zone of zones) {
    lines.push(`  ${zone.participantId}["${zone.label}"]`)
  }
  for (const edge of zoneEdges) {
    lines.push(`  ${edge.fromLabel} --> ${edge.toLabel}`)
  }
  lines.push('```')
  return lines.join('\n')
}

export function buildConductorPrompt(input: ConductorPromptInput): string {
  const { projectDir, dispatchId, userPrompt, zones, zoneEdges, unassignedComponents } = input
  const activityLog = activityLogPath(projectDir, dispatchId, 'conductor')

  const zoneLines = zones.map(zone => {
    const upstream = zone.upstreamLabels.length ? ` · upstream: ${zone.upstreamLabels.join(', ')}` : ''
    const downstream = zone.downstreamLabels.length ? ` · downstream: ${zone.downstreamLabels.join(', ')}` : ''
    const components = zone.componentLabels.length ? ` · components: ${zone.componentLabels.join(', ')}` : ''
    const desc = zone.description ? ` — ${zone.description}` : ''
    return `- **${zone.label}** (\`${zone.participantId}\`, ${getAgentRuntime(zone.runtime).shortLabel})${desc}${components}${upstream}${downstream}`
  }).join('\n')

  const flow = zoneEdges.length
    ? zoneEdges.map(e => `  ${e.fromLabel} → ${e.toLabel}`).join('\n')
    : '  (zones are independent — no cross-zone edges)'

  const unassigned = unassignedComponents.length
    ? `\n\n## Unassigned components (reference only, no zone owns them)\n${unassignedComponents.map(c => `- ${c.label}${c.tag ? ` [${c.tag}]` : ''}${c.description ? ` — ${c.description}` : ''}`).join('\n')}`
    : ''

  const task = userPrompt?.trim()
    ? `## Task (from user)\n${userPrompt.trim()}`
    : `## Task (from user)\n(No task yet. The harness will pty-write one when the user provides it.)`

  return `You are the **Conductor** for a multi-agent dispatch. Your participant id is \`conductor\`. Zones are listed below — each is already spawned as an interactive CLI session waiting for work. You decide what task goes to which zone, handle questions from zones, and produce a final summary when work completes.

**You do not run a loop.** The harness drives your turn-taking. It sends you one user turn per material event:
- a zone finished a task ("Zone X done on t-abc: <summary>. What next?")
- a zone is blocked ("Zone X blocked on t-abc: <question>. Answer or reassign.")
- a zone has gone stale ("Zone X stale for Nm on t-abc. Retry / reassign / fail?")
- work is complete ("All zones done. Produce final summary.")

For each incoming user turn, respond by appending **exactly one** activity-log line to:

\`${activityLog}\`

**Use this exact shell command shape**:

\`\`\`bash
cat >> '${activityLog}' << 'ACT_EOF'
{"ts":"<iso-utc>","kind":"note","content":"<one-line human summary>","structured":<decision>}
ACT_EOF
\`\`\`

Replace \`<iso-utc>\` with the current UTC ISO timestamp (e.g. \`2026-04-23T21:10:00Z\`). Replace \`<decision>\` with one of:

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

## Architecture (reference only — not a build list)

${buildMermaid(zones, zoneEdges)}

## Zones

${zoneLines}

## Inter-zone flow

${flow}${unassigned}

## Rules

- Only engage the zones the task requires. Zones you don't assign stay idle — that is correct.
- Upstream zones go first: if zone B depends on zone A's output, assign A before B.
- A zone's output file lives at \`${join(projectDir, 'ARCHITECT', 'outputs')}/<participantId>.md\`. Reference these paths in task bodies so zones know where their peers' work is.
- Project source code lives in \`${projectDir}\` — zones write real files there. The \`ARCHITECT/\` directory is coordination-only.
- Keep task bodies concrete: name the files/endpoints to touch, contract at seams with other zones, acceptance criteria.
- Trust the harness's user turns as ground truth — you don't need to verify zone state separately.
`
}
