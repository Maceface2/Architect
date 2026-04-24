import { join } from 'path'
import { activityLogPath } from '../activity'

// v5 zone prompt builder. Replaces v4's buildZoneSystemPrompt dispatch-mode
// block (~90 lines of output, prescribes a bash polling loop) with a
// compact, runtime-uniform contract (~40 lines of output, single-shot
// activity-log append).
//
// The zone does NOT live in a loop. It receives task prompts from the
// harness as normal user turns and writes exactly one activity-log line
// when each task is done. No mailbox scripts. No jq. No polling.

export interface ZoneComponentSpec {
  label: string
  tag?: string
  category?: string
  description?: string
  specs?: string
}

export interface ZoneUpstreamRef {
  label: string
  participantId: string
}

export interface ZonePromptInput {
  projectDir: string
  dispatchId: string
  participantId: string
  label: string
  description?: string
  components: ZoneComponentSpec[]
  upstream: ZoneUpstreamRef[]
  downstreamLabels: string[]
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
    const head = `- **${c.label}**${c.tag ? ` [${c.tag}]` : ''}${c.category ? ` (${c.category})` : ''}${c.description ? ` — ${c.description}` : ''}`
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
    upstream,
    downstreamLabels,
    toolNames,
    skills,
    userSystemPrompt,
  } = input

  const activityLog = activityLogPath(projectDir, dispatchId, participantId)
  const outputLog = join(projectDir, 'ARCHITECT', 'outputs', `${participantId}.md`)
  const architectDir = join(projectDir, 'ARCHITECT')

  const upstreamLine = upstream.length
    ? `**Upstream zones (read their output logs when referenced in a task):** ${upstream.map(u => `${u.label} \`${join(architectDir, 'outputs', `${u.participantId}.md`)}\``).join(', ')}`
    : ''
  const downstreamLine = downstreamLabels.length
    ? `**Downstream zones (they'll consume your work):** ${downstreamLabels.join(', ')}`
    : ''
  const toolsLine = toolNames.length ? `**Enabled tools:** ${toolNames.join(', ')}` : ''
  const contextBlock = [upstreamLine, downstreamLine, toolsLine].filter(Boolean).join('\n')

  const skillsBlock = skills.length
    ? `## Skills\n\n${skills.map(s => `### ${s.name}\n${s.content}`).join('\n\n')}\n\n`
    : ''
  const behaviorBlock = userSystemPrompt ? `## Behavior\n\n${userSystemPrompt}\n\n` : ''

  return `You are the **${label}** zone-agent. Your participant id is \`${participantId}\`.${description ? `\nZone description: ${description}` : ''}

${contextBlock}

## What you own (reference)

These components live in your zone on the architecture canvas. This is CONTEXT about the parts of the system you're responsible for — NOT a build list. A given task may touch none, some, or all of them.

${renderComponents(components)}

${skillsBlock}${behaviorBlock}## How you receive work

The conductor dispatches tasks to you as normal user-turn prompts. Each starts with a marker:

- \`TASK <taskId>: <body>\` — new work. Do it.
- \`ANSWER <taskId>: <body>\` — the conductor answering a question you asked; resume the task.
- \`CANCEL <taskId>: <reason>\` — abort the current task. Clean up if possible.

## How you report back

When you finish (or fail, or get blocked), append **exactly one** JSON line to:

\`${activityLog}\`

Use this exact shell command shape (heredoc keeps JSON quoting straightforward):

\`\`\`bash
cat >> '${activityLog}' << 'ACT_EOF'
{"ts":"<iso-utc>","kind":"done","taskId":"<id>","content":"<one-line summary>"}
ACT_EOF
\`\`\`

Replace \`<iso-utc>\` with a current UTC ISO timestamp (e.g. \`2026-04-23T21:10:00Z\`). Replace \`<id>\` with the taskId from the prompt. Valid \`kind\` values:

- \`"done"\` — task finished successfully. Put what you produced in \`content\`.
- \`"failed"\` — task aborted. Put the concrete blocker in \`content\` (e.g. "file X does not exist").
- \`"ask"\` — you need more info to finish. Put the question in \`content\`. The conductor will reply with \`ANSWER\` on the next user turn.

**Optional mid-work progress** (keeps the harness from flagging you as stale on long tasks):

\`\`\`bash
cat >> '${activityLog}' << 'ACT_EOF'
{"ts":"<iso-utc>","kind":"progress","taskId":"<id>","content":"<short note>"}
ACT_EOF
\`\`\`

After your final \`done\`/\`failed\`/\`ask\` line, stop and wait for the next user turn. **Do not loop. Do not poll.**

## Where to put files

- All project files (source, configs, scripts, etc.) go directly in \`${projectDir}\`. Never inside \`${architectDir}/\`.
- \`${outputLog}\` is your free-form human-readable progress scratchpad — append to it as you work if you want the conductor/user to have detail beyond the activity-log summary. Optional but recommended.

## Rules

- Work autonomously. Don't stop to ask clarifying questions unless the task is genuinely ambiguous — in that case emit \`kind:"ask"\`.
- Always include the \`taskId\` from the prompt in your activity line. This is how the conductor correlates your result.
- Include real interfaces (type signatures, function shapes, endpoint specs) in your \`content\` summary when downstream zones will consume your work.
`
}
