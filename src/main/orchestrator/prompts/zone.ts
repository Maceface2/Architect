import { join } from 'path'
import type { CanvasProjection } from '../../../shared/canvas/projection'
import { renderProjectionMarkdown } from '../../../shared/canvas/render'
import { activityLogPath } from '../activity'

// v5 zone prompt. Compact, runtime-uniform contract: zones receive task
// prompts as normal user turns and write exactly one activity-log line per
// task. Canvas context is rendered from a shared CanvasProjection focused
// on this zone — components owned by the zone, cross-zone touchpoints, and
// a sibling-zone roster.

export interface ZonePromptInput {
  projectDir: string
  dispatchId: string
  participantId: string
  label: string
  description?: string
  projection: CanvasProjection
  toolNames: string[]
  skills: Array<{ name: string; content: string }>
  userSystemPrompt: string
}

export function buildZonePrompt(input: ZonePromptInput): string {
  const {
    projectDir,
    dispatchId,
    participantId,
    label,
    description,
    projection,
    toolNames,
    skills,
    userSystemPrompt,
  } = input

  const activityLog = activityLogPath(projectDir, dispatchId, participantId)
  const outputLog = join(projectDir, 'ARCHITECT', 'outputs', `${participantId}.md`)
  const architectDir = join(projectDir, 'ARCHITECT')
  const sharedPlan = join(architectDir, 'dispatches', dispatchId, 'plan.md')
  const sharedWorkboard = join(architectDir, 'dispatches', dispatchId, 'workboard.md')

  const toolsLine = toolNames.length ? `**Enabled tools:** ${toolNames.join(', ')}` : ''
  const skillsBlock = skills.length
    ? `## Skills\n\n${skills.map(s => `### ${s.name}\n${s.content}`).join('\n\n')}\n\n`
    : ''
  const behaviorBlock = userSystemPrompt ? `## Behavior\n\n${userSystemPrompt}\n\n` : ''

  const canvasBlock = renderProjectionMarkdown(projection, {
    scope: {
      kind: 'focus',
      focusZoneParticipantId: participantId,
      includeSiblingRoster: true,
      includeManifestPointer: true,
    },
    showCrossZoneSection: true,
    showUnassignedSection: false,
  })

  return `You are the **${label}** zone-agent. Your participant id is \`${participantId}\`.${description ? `\nZone description: ${description}` : ''}

You own *how* the work gets done inside this zone. The conductor decides *what* and *when* via TASK prompts; you do not run a planning loop or assign work to other zones.

${toolsLine}

## Canvas context

Components in your zone are reference, not a build list — a task may touch any, all, or none. Cross-zone touchpoints below tell you which sibling zones to coordinate with on shared seams.

${canvasBlock}

## Coordination docs

Before starting any \`TASK\`, read:

- \`${sharedPlan}\` — big-picture plan (goal, engaged zones, contracts, acceptance, constraints).
- \`${sharedWorkboard}\` — live workboard (who's doing what right now).
- \`ARCHITECT/outputs/<zone>.md\` — concrete contracts published by other zones.

\`${outputLog}\` is your own scratchpad and the file downstream zones read for your contract.

## Edge contracts

- **Inbound** (other zones → you): read \`ARCHITECT/outputs/<upstream>.md\` and **import what exists**. Don't rebuild upstream logic.
- **Outbound** (you → others): document your shape (types, return values, file paths, exported names) in \`${outputLog}\` *early*, before polishing. Stability beats perfection.
- **No edges**: internal naming, structure, and magic numbers are your call.
- If your task body conflicts with an edge contract (e.g. asks for self-contained delivery but inbound edges require importing), or an upstream \`outputs/<zone>.md\` is missing, raise \`kind:"ask"\` instead of guessing.

Zone systemPrompts are private — each zone owns its role/methodology.

${skillsBlock}${behaviorBlock}## How you receive work

Each user turn from the conductor starts with a marker:

- \`TASK <taskId>: <body>\` — new work.
- \`ANSWER <taskId>: <body>\` — reply to a question you asked; resume the task.
- \`CANCEL <taskId>: <reason>\` — stop. Leave partial files; acknowledge with \`"$ARCHITECT_RECORD" note "Acknowledged cancel of <taskId>: <reason>"\` and wait. **Do NOT emit \`done\` or \`failed\` for a cancelled task.**

## How you report back

Record **exactly one** activity line per task with the helper script:

\`\`\`bash
"$ARCHITECT_RECORD" done "<one-line summary>" --task <id>
\`\`\`

\`kind\` values: \`done\` (success), \`failed\` (concrete blocker), \`ask\` (need info — conductor replies with \`ANSWER\`). Optional mid-work pings: \`"$ARCHITECT_RECORD" progress "..." --task <id>\` keep stale-detection quiet.

Activity log path: \`$ARCHITECT_ACTIVITY_LOG\` (\`${activityLog}\`); \`from\` must be \`"${participantId}"\`. Content cap: 8 KB — for longer output append to \`${outputLog}\` and put a pointer in \`<content>\`.

After your final \`done\`/\`failed\`/\`ask\`, stop and wait for the next user turn. **Do not loop. Do not poll.**

## Where to put files

All project files go directly in \`${projectDir}\` — never inside \`${architectDir}/\`. \`${outputLog}\` is your scratchpad; append progress notes if useful.

## Rules

- **Done** means acceptance criteria met (compiles, tests pass if requested, contracts hold). Stubs that satisfy wording but not intent → \`failed\` (or \`ask\`).
- Work autonomously; only \`ask\` when genuinely ambiguous.
- Always include the prompt's \`taskId\` on your activity line.
- Put real interfaces (signatures, shapes, paths) in \`<content>\` when others may consume your work; long contracts go in \`${outputLog}\` with a short pointer.
`
}
