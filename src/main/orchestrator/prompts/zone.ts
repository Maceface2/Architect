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

## You're part of a system, not a standalone build

Your zone is a node in the canvas graph. The component edges in the section above are contracts. Treat them as load-bearing — they define who consumes what. The full canvas projection (every zone, every component spec, every edge) also lives at \`${manifestPath}\` — \`cat\` it on demand for cross-zone detail beyond what's listed above.

- **Inbound edges** (other zones' components flow into yours) are inputs you consume. The upstream zone publishes its shape to \`${projectDir}/ARCHITECT/outputs/<upstream-zone>.md\` — read that file, design around the shape, and **import what already exists**. Don't rebuild upstream logic locally just because rebuilding is faster than reading the contract. The whole point of multi-zone dispatch is that zones don't duplicate each other's work.

- **Outbound edges** (your components flow into others) are outputs others consume. Document your shape — types, return values, side effects, file paths, exported module/artifact names — in \`${outputLog}\` *early*, before you're done polishing. Downstream zones may be reading it to integrate while you're still working. Stability of the shape matters more than perfection.

- **No edges** (purely internal components) are yours alone. Internal naming, file structure, magic numbers — your call.

When a delivery constraint in your task body conflicts with an edge contract — e.g. the body asks for a "self-contained" deliverable but inbound edges require importing from another zone — raise \`kind:"ask"\` and name the conflict. Don't silently break the contract by re-implementing the upstream side; that defeats the multi-zone dispatch and ships orphaned upstream code that nothing consumes.

If an upstream zone's \`ARCHITECT/outputs/<zone>.md\` is missing when you need it, also raise \`kind:"ask"\` — "Upstream contract at <path> is missing; dispatch me after upstream zones complete." Don't proceed by guessing the shape.

Zone systemPrompts are not exposed in the manifest; each zone's role/methodology stays private.

${skillsBlock}${behaviorBlock}## How you receive work

The conductor dispatches tasks to you as normal user-turn prompts. Each starts with a marker:

- \`TASK <taskId>: <body>\` — new work. Do it.
- \`ANSWER <taskId>: <body>\` — the conductor answering a question you asked; resume the task.
- \`CANCEL <taskId>: <reason>\` — stop work on that taskId. Leave any partial files in place — the conductor may reassign with new context. Acknowledge with \`"$ARCHITECT_RECORD" note "Acknowledged cancel of <taskId>: <reason>"\` (taskId optional on \`note\`) and wait for the next prompt. **Do NOT emit \`done\` or \`failed\` for a cancelled task** — those signals trigger orchestration-level state changes you no longer own once the conductor has cancelled the work.

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
