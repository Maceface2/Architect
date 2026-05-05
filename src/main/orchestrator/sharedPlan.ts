import fs from 'fs'
import { dirname, join } from 'path'
import type { PendingTask } from '../dispatchCapture'

export interface WorkboardZone {
  participantId: string
  label: string
  outputPath: string
}

export interface WorkboardTask {
  taskId: string
  participantId: string
  body: string
  status: string
  attempts: number
  startedAt?: string
  dependsOn?: string[]
  lastError?: string
}

export interface WorkboardInput {
  projectDir: string
  dispatchId: string
  planRevision: number
  zones: WorkboardZone[]
  tasks: WorkboardTask[]
  completedZones: string[]
}

export function sharedDispatchDir(projectDir: string, dispatchId: string): string {
  return join(projectDir, 'ARCHITECT', 'dispatches', dispatchId)
}

export function sharedPlanPath(projectDir: string, dispatchId: string): string {
  return join(sharedDispatchDir(projectDir, dispatchId), 'plan.md')
}

export function sharedWorkboardPath(projectDir: string, dispatchId: string): string {
  return join(sharedDispatchDir(projectDir, dispatchId), 'workboard.md')
}

export function ensureSharedDispatchDocs(projectDir: string, dispatchId: string): void {
  fs.mkdirSync(sharedDispatchDir(projectDir, dispatchId), { recursive: true })
}

export function hasSharedPlan(projectDir: string, dispatchId: string): boolean {
  try {
    return fs.statSync(sharedPlanPath(projectDir, dispatchId)).isFile()
  } catch {
    return false
  }
}

export function writeSharedPlan(projectDir: string, dispatchId: string, markdown: string, revision: number): string {
  ensureSharedDispatchDocs(projectDir, dispatchId)
  const path = sharedPlanPath(projectDir, dispatchId)
  const body = markdown.trim()
  const header = `# Shared Dispatch Plan\n\nRevision: ${revision}\nUpdated: ${new Date().toISOString()}\n\n`
  fs.writeFileSync(path, `${header}${body}\n`, 'utf-8')
  return path
}

export function writeMinimalSharedPlan(
  projectDir: string,
  dispatchId: string,
  userPrompt: string,
  pendingTasks: PendingTask[],
): string {
  const pending = pendingTasks.length
    ? pendingTasks.map(t => `- ${t.taskId} -> ${t.participantId}: ${t.status}`).join('\n')
    : '- No pending tasks recorded.'
  return writeSharedPlan(
    projectDir,
    dispatchId,
    [
      '## Goal',
      userPrompt.trim() || '(No user prompt recorded.)',
      '',
      '## Resume Context',
      'This minimal plan was generated during resume because no shared plan doc existed on disk.',
      '',
      '## Pending Work',
      pending,
    ].join('\n'),
    1,
  )
}

function taskPreview(body: string): string {
  const compact = body.replace(/\s+/g, ' ').trim()
  if (compact.length <= 220) return compact
  return `${compact.slice(0, 217)}...`
}

export function writeWorkboard(input: WorkboardInput): string {
  ensureSharedDispatchDocs(input.projectDir, input.dispatchId)
  const path = sharedWorkboardPath(input.projectDir, input.dispatchId)
  const byParticipant = new Map<string, WorkboardTask[]>()
  for (const task of input.tasks) {
    const list = byParticipant.get(task.participantId) ?? []
    list.push(task)
    byParticipant.set(task.participantId, list)
  }

  const lines: string[] = [
    '# Dispatch Workboard',
    '',
    `Updated: ${new Date().toISOString()}`,
    `Plan revision: ${input.planRevision || 0}`,
    '',
    '## Zones',
    '',
    '| Zone | Status | Current/Recent Tasks | Output |',
    '| --- | --- | --- | --- |',
  ]

  for (const zone of input.zones) {
    const tasks = byParticipant.get(zone.participantId) ?? []
    const active = tasks.find(t => !['done', 'failed', 'cancelled'].includes(t.status))
    const latest = active ?? tasks[tasks.length - 1]
    const status = latest?.status ?? (input.completedZones.includes(zone.participantId) ? 'done' : 'idle')
    const taskSummary = tasks.length ? tasks.map(t => `${t.taskId} (${t.status})`).join(', ') : '-'
    lines.push(`| ${zone.label} (\`${zone.participantId}\`) | ${status} | ${taskSummary} | \`${zone.outputPath}\` |`)
  }

  lines.push('', '## Tasks', '')
  if (!input.tasks.length) {
    lines.push('_No tasks have been assigned yet._')
  } else {
    for (const task of input.tasks) {
      lines.push(`### ${task.taskId} -> ${task.participantId}`)
      lines.push('')
      lines.push(`- Status: ${task.status}`)
      lines.push(`- Attempts: ${task.attempts}`)
      if (task.startedAt) lines.push(`- Started at: ${task.startedAt}`)
      if (task.dependsOn?.length) lines.push(`- Depends on: ${task.dependsOn.join(', ')}`)
      if (task.lastError) lines.push(`- Last error: ${task.lastError}`)
      lines.push(`- Task: ${taskPreview(task.body)}`)
      lines.push('')
    }
  }

  fs.mkdirSync(dirname(path), { recursive: true })
  fs.writeFileSync(path, `${lines.join('\n')}\n`, 'utf-8')
  return path
}
