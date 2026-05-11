import { join } from 'path'
import type { CanvasProjection } from '../../../shared/canvas/projection'
import { renderProjectionMarkdown } from '../../../shared/canvas/render'

// Solo-mode zone prompt for runZone (Play button or single-zone dispatch).
// No conductor, no scheduler, no activity log — the agent works directly
// with the user. Canvas context is rendered from a focused CanvasProjection
// so the same shared formatter drives every prompt site.

export interface SoloZonePromptInput {
  projectDir: string
  participantId: string
  label: string
  description?: string
  projection: CanvasProjection
  toolNames: string[]
  skills: Array<{ name: string; content: string }>
  userSystemPrompt: string
}

export function buildSoloZonePrompt(input: SoloZonePromptInput): string {
  const { projectDir, participantId, label, description, projection, toolNames, skills, userSystemPrompt } = input
  const architectDir = join(projectDir, 'ARCHITECT')
  const outputLog = join(architectDir, 'outputs', `${participantId}.md`)

  const toolsLine = toolNames.length ? `**Enabled tools:** ${toolNames.join(', ')}\n` : ''
  const skillsBlock = skills.length
    ? `## Skills\n\n${skills.map(s => `### ${s.name}\n${s.content}`).join('\n\n')}\n\n`
    : ''
  const behaviorBlock = userSystemPrompt ? `## Behavior\n\n${userSystemPrompt}\n\n` : ''

  const canvasBlock = renderProjectionMarkdown(projection, {
    scope: {
      kind: 'focus',
      focusZoneParticipantId: participantId,
      includeSiblingRoster: false,
      includeManifestPointer: false,
    },
    showCrossZoneSection: true,
    showUnassignedSection: false,
  })

  return `You are the **${label}** zone-agent. Your participant id is \`${participantId}\`.${description ? `\nZone description: ${description}` : ''}

${toolsLine}Launched standalone — no conductor. You work directly with the user: they prompt, you respond and do the work.

## Canvas context

Components and edges in your zone are reference, not a build list — work from the user's request.

${canvasBlock}

${skillsBlock}${behaviorBlock}## Files

- Project files go in \`${projectDir}\`, never inside \`${architectDir}/\`.
- \`${outputLog}\` is a free-form scratchpad — append a line per significant step so later dispatches (or the user) can see what you did.

Work autonomously. Don't pause to ask unless the request is genuinely ambiguous.
`
}
