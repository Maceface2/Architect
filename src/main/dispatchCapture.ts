import fs from 'fs'
import { join } from 'path'
import type { AgentRuntime } from '../shared/agentRuntimes'

export interface DispatchZoneSession {
  zoneId: string
  label: string
  runtime: AgentRuntime
  sessionId: string
}

export interface DispatchRecord {
  architectSessionId: string
  architectRuntime: AgentRuntime
  zoneIds: string[]
  zoneLabels: string[]
  zoneSessions: DispatchZoneSession[]
  userPrompt: string
  summary: string
  model: string
  planMode: boolean
  timestamp: string
  protocolVersion?: number
}

export const DISPATCH_PROTOCOL_VERSION = 3

const DISPATCHES_SUBDIR = 'dispatches'

function dispatchesDir(projectDir: string): string {
  return join(projectDir, 'ARCHITECT', DISPATCHES_SUBDIR)
}

function dispatchFile(projectDir: string, id: string): string {
  return join(dispatchesDir(projectDir), `${id}.json`)
}

export function summarizeFromPrompt(userPrompt: string): string {
  const firstLine = (userPrompt ?? '').split('\n').map(s => s.trim()).find(Boolean)
  const trimmed = (firstLine ?? '').slice(0, 120)
  return trimmed || '(no prompt)'
}

export function saveDispatch(projectDir: string, record: DispatchRecord): void {
  const dir = dispatchesDir(projectDir)
  fs.mkdirSync(dir, { recursive: true })
  const stamped: DispatchRecord = { ...record, protocolVersion: DISPATCH_PROTOCOL_VERSION }
  fs.writeFileSync(dispatchFile(projectDir, record.architectSessionId), JSON.stringify(stamped, null, 2))
}

function readDispatch(path: string): DispatchRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path, 'utf-8')) as Partial<DispatchRecord>
    if (typeof parsed?.architectSessionId !== 'string') return null
    if (!Array.isArray(parsed.zoneIds)) return null
    return {
      architectSessionId: parsed.architectSessionId,
      architectRuntime: (parsed.architectRuntime ?? 'claude') as AgentRuntime,
      zoneIds: parsed.zoneIds ?? [],
      zoneLabels: Array.isArray(parsed.zoneLabels) ? parsed.zoneLabels : [],
      zoneSessions: Array.isArray(parsed.zoneSessions) ? parsed.zoneSessions : [],
      userPrompt: typeof parsed.userPrompt === 'string' ? parsed.userPrompt : '',
      summary: typeof parsed.summary === 'string' && parsed.summary
        ? parsed.summary
        : summarizeFromPrompt(typeof parsed.userPrompt === 'string' ? parsed.userPrompt : ''),
      model: typeof parsed.model === 'string' ? parsed.model : '',
      planMode: parsed.planMode === true,
      timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : new Date().toISOString(),
      protocolVersion: typeof parsed.protocolVersion === 'number' ? parsed.protocolVersion : undefined,
    }
  } catch {
    return null
  }
}

export function listDispatches(projectDir: string): DispatchRecord[] {
  const dir = dispatchesDir(projectDir)
  let entries: string[]
  try {
    entries = fs.readdirSync(dir).filter(name => name.endsWith('.json'))
  } catch {
    return []
  }
  const records: DispatchRecord[] = []
  for (const name of entries) {
    const rec = readDispatch(join(dir, name))
    if (rec) records.push(rec)
  }
  records.sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''))
  return records
}

export function getDispatch(projectDir: string, id: string): DispatchRecord | null {
  return readDispatch(dispatchFile(projectDir, id))
}

export function deleteDispatch(projectDir: string, id: string): boolean {
  const path = dispatchFile(projectDir, id)
  if (!fs.existsSync(path)) return false
  try { fs.unlinkSync(path); return true } catch { return false }
}

export function updateDispatchSummary(projectDir: string, id: string, summary: string): boolean {
  const rec = getDispatch(projectDir, id)
  if (!rec) return false
  saveDispatch(projectDir, { ...rec, summary })
  return true
}

// Zone sessions land asynchronously as each agent's CLI captures its id; this
// merges one entry into the existing record without clobbering others.
export function upsertDispatchZoneSession(
  projectDir: string,
  id: string,
  entry: DispatchZoneSession,
): boolean {
  const rec = getDispatch(projectDir, id)
  if (!rec) return false
  const without = rec.zoneSessions.filter(z => z.zoneId !== entry.zoneId)
  saveDispatch(projectDir, { ...rec, zoneSessions: [...without, entry] })
  return true
}
