import { join } from 'path'

// Solo-mode zone prompt. Used by runZone for single-zone launches (Play
// button, or a one-zone startDispatch). There is no Conductor, no activity
// log, no scheduler — the agent works directly with the user.
//
// Replaces v4's buildZoneSystemPrompt(..., 'solo') branch.

export interface ZoneComponentSpec {
  label: string
  tag?: string
  category?: string
  description?: string
  specs?: string
}

export interface SoloZonePromptInput {
  projectDir: string
  participantId: string
  label: string
  description?: string
  components: ZoneComponentSpec[]
  toolNames: string[]
  skills: Array<{ name: string; content: string }>
  userSystemPrompt: string
}

function renderComponents(components: ZoneComponentSpec[]): string {
  if (!components.length) return '_(no components were drawn — work from the user goal alone)_'
  return components.map(c => {
    const head = `- **${c.label}**${c.tag ? ` [${c.tag}]` : ''}${c.category ? ` (${c.category})` : ''}${c.description ? ` — ${c.description}` : ''}`
    const specs = (c.specs ?? '').trim()
    return specs ? `${head}\n\n  ${specs.split('\n').join('\n  ')}` : head
  }).join('\n\n')
}

export function buildSoloZonePrompt(input: SoloZonePromptInput): string {
  const { projectDir, participantId, label, description, components, toolNames, skills, userSystemPrompt } = input
  const architectDir = join(projectDir, 'ARCHITECT')
  const outputLog = join(architectDir, 'outputs', `${participantId}.md`)

  const toolsLine = toolNames.length ? `**Enabled tools:** ${toolNames.join(', ')}\n` : ''
  const skillsBlock = skills.length
    ? `## Skills\n\n${skills.map(s => `### ${s.name}\n${s.content}`).join('\n\n')}\n\n`
    : ''
  const behaviorBlock = userSystemPrompt ? `## Behavior\n\n${userSystemPrompt}\n\n` : ''

  return `You are the **${label}** zone-agent. Your participant id is \`${participantId}\`.${description ? `\nZone description: ${description}` : ''}

${toolsLine}This zone was launched standalone. No conductor is coordinating you. You work directly with the user: they prompt you, you respond and do the work.

## What you own (reference)

These components live in your zone on the architecture canvas. This is CONTEXT — not a build list.

${renderComponents(components)}

${skillsBlock}${behaviorBlock}## Where to put files

- All project files (source, configs, scripts, etc.) go directly in \`${projectDir}\`. Do NOT put them inside \`${architectDir}/\`.
- \`${outputLog}\` is a free-form progress scratchpad — append a line per significant step so later dispatches (or the user) can see what you did.

Work autonomously. Don't pause to ask unless the request is genuinely ambiguous.
`
}
