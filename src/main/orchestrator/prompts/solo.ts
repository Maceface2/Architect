import { join } from 'path'
import { renderComponentEdges, type ComponentEdgeSpec } from './componentEdges'

// Solo-mode zone prompt for runZone (Play button or single-zone dispatch).
// No conductor, no scheduler, no activity log — the agent works directly
// with the user.

export interface ZoneComponentSpec {
  id: string
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
  componentEdges: ComponentEdgeSpec[]
  toolNames: string[]
  skills: Array<{ name: string; content: string }>
  userSystemPrompt: string
}

function renderComponents(components: ZoneComponentSpec[]): string {
  if (!components.length) return '_(no components were drawn — work from the user goal alone)_'
  return components.map(c => {
    const head = `- **${c.label}** (\`${c.id}\`)${c.tag ? ` [${c.tag}]` : ''}${c.category ? ` (${c.category})` : ''}${c.description ? ` — ${c.description}` : ''}`
    const specs = (c.specs ?? '').trim()
    return specs ? `${head}\n\n  ${specs.split('\n').join('\n  ')}` : head
  }).join('\n\n')
}

export function buildSoloZonePrompt(input: SoloZonePromptInput): string {
  const { projectDir, participantId, label, description, components, componentEdges, toolNames, skills, userSystemPrompt } = input
  const architectDir = join(projectDir, 'ARCHITECT')
  const outputLog = join(architectDir, 'outputs', `${participantId}.md`)

  const toolsLine = toolNames.length ? `**Enabled tools:** ${toolNames.join(', ')}\n` : ''
  const skillsBlock = skills.length
    ? `## Skills\n\n${skills.map(s => `### ${s.name}\n${s.content}`).join('\n\n')}\n\n`
    : ''
  const behaviorBlock = userSystemPrompt ? `## Behavior\n\n${userSystemPrompt}\n\n` : ''

  return `You are the **${label}** zone-agent. Your participant id is \`${participantId}\`.${description ? `\nZone description: ${description}` : ''}

${toolsLine}Launched standalone — no conductor. You work directly with the user: they prompt, you respond and do the work.

## What you own (reference)

Canvas components in your zone — context, not a build list.

${renderComponents(components)}

## Component edges (reference)

${renderComponentEdges(componentEdges)}

${skillsBlock}${behaviorBlock}## Files

- Project files go in \`${projectDir}\`, never inside \`${architectDir}/\`.
- \`${outputLog}\` is a free-form scratchpad — append a line per significant step so later dispatches (or the user) can see what you did.

Work autonomously. Don't pause to ask unless the request is genuinely ambiguous.
`
}
