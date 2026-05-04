import { join } from 'path'
import { activityLogPath } from '../activity'
import { renderComponentEdges, type ComponentEdgeSpec } from './componentEdges'

// v5 zone prompt builder. Replaces v4's buildZoneSystemPrompt dispatch-mode
// block (~90 lines of output, prescribes a bash polling loop) with a
// compact, runtime-uniform contract (~40 lines of output, single-shot
// activity-log append).
//
// The zone does NOT live in a loop. It receives task prompts from the
// harness as normal user turns and writes exactly one activity-log line
// when each task is done. No mailbox scripts. No jq. No polling.

export interface ZoneComponentSpec {
  id: string
  label: string
  tag?: string
  category?: string
  description?: string
  specs?: string
}

export interface ZonePromptInput {
  projectDir: string
  dispatchId: string
  participantId: string
  label: string
  description?: string
  components: ZoneComponentSpec[]
  componentEdges: ComponentEdgeSpec[]
  // Enabled tool names from zone.data.tools (filtered to truthy).
  toolNames: string[]
  // Already-resolved skill contents. Empty entries filtered out by caller.
  skills: Array<{ name: string; content: string }>
  // User-authored zone.data.systemPrompt, trimmed. Empty string when unset.
  userSystemPrompt: string
}

function renderComponents(components: ZoneComponentSpec[]): string {
  if (!components.length) return '_(no components were drawn — work from the task alone)_'
  return components.map(c => {
    const head = `- **${c.label}** (\`${c.id}\`)${c.tag ? ` [${c.tag}]` : ''}${c.category ? ` (${c.category})` : ''}${c.description ? ` — ${c.description}` : ''}`
    const specs = (c.specs ?? '').trim()
    return specs ? `${head}\n\n  ${specs.split('\n').join('\n  ')}` : head
  }).join('\n\n')
}

export function buildZonePrompt(input: ZonePromptInput): string {
  const {
    projectDir,
    dispatchId,
    participantId,
    label,
    description,
    components,
    componentEdges,
    toolNames,
    skills,
    userSystemPrompt,
  } = input

  const activityLog = activityLogPath(projectDir, dispatchId, participantId)
  const outputLog = join(projectDir, 'ARCHITECT', 'outputs', `${participantId}.md`)
  const architectDir = join(projectDir, 'ARCHITECT')

  const toolsLine = toolNames.length ? `**Enabled tools:** ${toolNames.join(', ')}` : ''

  const skillsBlock = skills.length
    ? `## Skills\n\n${skills.map(s => `### ${s.name}\n${s.content}`).join('\n\n')}\n\n`
    : ''
  const behaviorBlock = userSystemPrompt ? `## Behavior\n\n${userSystemPrompt}\n\n` : ''

  const manifestPath = join(projectDir, 'ARCHITECT', 'manifest.json')

  return `You are the **${label}** zone-agent. Your participant id is \`${participantId}\`.${description ? `\nZone description: ${description}` : ''}

${toolsLine}

## What you own (reference)

These components live in your zone on the architecture canvas. This is CONTEXT about the parts of the system you're responsible for — NOT a build list. A given task may touch none, some, or all of them.

${renderComponents(components)}

## Component edges (reference)

These component-level links touch at least one component in your zone. They are context only; the conductor decides task ordering.

${renderComponentEdges(componentEdges)}

## Cross-zone context

Other zones, their components, and the full set of component edges live at \`${manifestPath}\`. \`cat\` it on demand when a task implies a contract with another zone — e.g. you need that zone's participant id, the shape of one of its components, or a component spec you're depending on. Your own block in that file matches the components listed above. Zone systemPrompts are not exposed there; each zone's role/methodology stays private.

${skillsBlock}${behaviorBlock}## How you receive work

The conductor dispatches tasks to you as normal user-turn prompts. Each starts with a marker:

- \`TASK <taskId>: <body>\` — new work. Do it.
- \`ANSWER <taskId>: <body>\` — the conductor answering a question you asked; resume the task.
- \`CANCEL <taskId>: <reason>\` — abort the current task. Clean up if possible.

## How you report back

When you finish (or fail, or get blocked), record **exactly one** activity line. Use the harness-provided helper script — it handles JSON encoding, the timestamp, and the \`from\` field for you, and survives any command wrapper your environment uses (rtk, ssh, screen, etc.):

\`\`\`bash
"$ARCHITECT_RECORD" done "<one-line summary>" --task <id>
\`\`\`

Replace \`<id>\` with the taskId from the prompt. Valid first-arg \`kind\` values:

- \`done\` — task finished successfully. Put what you produced in \`<content>\`.
- \`failed\` — task aborted. Put the concrete blocker in \`<content>\` (e.g. "file X does not exist").
- \`ask\` — you need more info to finish. Put the question in \`<content>\`. The conductor will reply with \`ANSWER\` on the next user turn.

**Optional mid-work progress** (keeps the harness from flagging you as stale on long tasks):

\`\`\`bash
"$ARCHITECT_RECORD" progress "<short note>" --task <id>
\`\`\`

**Fallback** — if \`$ARCHITECT_RECORD\` is somehow missing, append directly to the activity log:

\`\`\`bash
cat >> "$ARCHITECT_ACTIVITY_LOG" << 'ACT_EOF'
{"ts":"<iso-utc>","from":"${participantId}","kind":"done","taskId":"<id>","content":"<one-line summary>"}
ACT_EOF
\`\`\`

The activity log path is also exposed as \`$ARCHITECT_ACTIVITY_LOG\` (resolves to \`${activityLog}\`). The \`from\` field must be \`"${participantId}"\` — the harness rejects events whose \`from\` doesn't match the file's owner.

**Content size limit:** keep \`<content>\` under 8 KB. Lines exceeding that cap are rejected by the harness parser. For long output, write to your scratchpad (below) and put a short pointer in \`<content>\`.

After your final \`done\`/\`failed\`/\`ask\` line, stop and wait for the next user turn. **Do not loop. Do not poll.**

## Where to put files

- All project files (source, configs, scripts, etc.) go directly in \`${projectDir}\`. Never inside \`${architectDir}/\`.
- \`${outputLog}\` is your free-form human-readable progress scratchpad — append to it as you work if you want the conductor/user to have detail beyond the activity-log summary. Optional but recommended.

## Rules

- **Definition of done.** Emit \`kind:"done"\` only when the task body's acceptance criteria are actually met — code written *and* compiling, tests passing if the body asks for tests, endpoints reachable if the body asks for an integration. Writing a stub that satisfies the words of the task but not its intent counts as \`kind:"failed"\` (or \`kind:"ask"\` if you genuinely don't know which is wanted). When the body is silent on acceptance, default to: code compiles/typechecks, no obvious runtime errors on a smoke check, and any contract you announced in your \`content\` actually holds in the file you wrote.
- Work autonomously. Don't stop to ask clarifying questions unless the task is genuinely ambiguous — in that case emit \`kind:"ask"\`.
- Always include the \`taskId\` from the prompt in your activity line. This is how the conductor correlates your result.
- Include real interfaces (type signatures, function shapes, endpoint specs) in your \`content\` summary when another zone may need to use your work. If the contract is too long for the 8 KB \`content\` cap, append the full version to \`${outputLog}\` and put a short pointer in \`content\`.
`
}
