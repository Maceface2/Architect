import fs from 'fs'
import path from 'path'
import { readMainLogTail } from './logger'

export interface BundleArgs {
  userMessage: string
  rendererLogs: string
  projectDir: string | null
  activeDispatchId: string | null
  appVersion: string
  includeLogs: boolean
}

const MAIN_LOG_TAIL_BYTES = 200_000
const PER_FILE_TAIL_BYTES = 100_000

function readTail(file: string, maxBytes: number): string {
  let size = 0
  try {
    size = fs.statSync(file).size
  } catch {
    return ''
  }
  if (size === 0) return ''
  const start = Math.max(0, size - maxBytes)
  const fd = fs.openSync(file, 'r')
  try {
    const len = size - start
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, start)
    let text = buf.toString('utf-8')
    if (start > 0) {
      const nl = text.indexOf('\n')
      if (nl >= 0) text = text.slice(nl + 1)
    }
    return text
  } finally {
    fs.closeSync(fd)
  }
}

function readDispatchActivity(projectDir: string, dispatchId: string): string {
  const sections: string[] = []
  const runtimeDir = path.join(projectDir, 'ARCHITECT', 'runtime', dispatchId)
  const orchestrationFile = path.join(runtimeDir, 'orchestration.jsonl')
  if (fs.existsSync(orchestrationFile)) {
    sections.push(`--- orchestration.jsonl (tail) ---\n${readTail(orchestrationFile, PER_FILE_TAIL_BYTES)}`)
  }
  const activityDir = path.join(runtimeDir, 'activity')
  let activityFiles: string[] = []
  try {
    activityFiles = fs
      .readdirSync(activityDir)
      .filter(f => f.endsWith('.jsonl'))
      .sort()
  } catch {
    activityFiles = []
  }
  for (const name of activityFiles) {
    const file = path.join(activityDir, name)
    sections.push(`--- activity/${name} (tail) ---\n${readTail(file, PER_FILE_TAIL_BYTES)}`)
  }
  return sections.join('\n\n')
}

export function bundleBugReport(args: BundleArgs): string {
  const ts = new Date().toISOString()
  const header = [
    `Architect bug report`,
    `Timestamp: ${ts}`,
    `App version: ${args.appVersion}`,
    `Platform: ${process.platform} ${process.arch}`,
    `Electron: ${process.versions.electron}`,
    `Node: ${process.versions.node}`,
    `Chrome: ${process.versions.chrome}`,
    `Project: ${args.projectDir ?? '(none)'}`,
    `Active dispatch: ${args.activeDispatchId ?? '(none)'}`,
  ].join('\n')

  const sections: string[] = [header]
  sections.push(`=== User message ===\n${args.userMessage.trim() || '(empty)'}`)

  if (args.includeLogs) {
    const mainTail = readMainLogTail(MAIN_LOG_TAIL_BYTES)
    sections.push(`=== Main process log (tail) ===\n${mainTail || '(empty)'}`)
    sections.push(`=== Renderer console (recent) ===\n${args.rendererLogs.trim() || '(empty)'}`)
    if (args.projectDir && args.activeDispatchId) {
      const activity = readDispatchActivity(args.projectDir, args.activeDispatchId)
      sections.push(`=== Dispatch activity (${args.activeDispatchId}) ===\n${activity || '(empty)'}`)
    }
  }

  return sections.join('\n\n') + '\n'
}
