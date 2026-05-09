import fs from 'fs'
import { join } from 'path'
import type { AgentRuntime } from '../shared/agentRuntimes'

export interface DispatchZoneSession {
  zoneId: string
  label: string
  runtime: AgentRuntime
  sessionId: string
  // Multi-folder dispatch: which workspace folder this zone ran in. Used on
  // resume to validate the folder is still loaded (or auto-load it). Absent
  // for v1 single-folder dispatches and for older v5 records written before
  // multi-folder support landed; consumers fall back to the dispatch primary
  // (record.dispatchPrimaryFolder ?? projectDir).
  folderPath?: string
}

// A task that was in-flight at dispatch teardown. Re-delivered to the zone
// on resume via pty.write. Completed / cancelled tasks are not persisted
// here — they live in the zone's activity log.
//
// `queued` tasks (waiting on dependsOn upstreams) are persisted so the
// resume path can surface "your old plan was lost" to the conductor with
// full context, but they are NOT auto-redispatched: completedZones starts
// empty after a fresh scheduler comes up.
export interface PendingTask {
  taskId: string
  zoneId: string
  participantId: string
  body: string
  status: 'pending' | 'queued' | 'dispatched' | 'in-progress' | 'blocked'
  attempts: number
  startedAt?: string
  // Populated only when status === 'queued'. Lists the participantIds the
  // task was waiting on at the moment of teardown.
  dependsOn?: string[]
}

export interface DispatchRecord {
  architectSessionId: string
  architectRuntime: AgentRuntime
  // v5 correlation id. Independent from the CLI session id (which is how we
  // resume the conversation on the runtime side). Generated at
  // startDispatch; pinned on the record so resume re-uses the same
  // ARCHITECT/runtime/<dispatchId>/ subtree.
  dispatchId?: string
  zoneIds: string[]
  zoneLabels: string[]
  zoneSessions: DispatchZoneSession[]
  userPrompt: string
  summary: string
  model: string
  planMode: boolean
  timestamp: string
  protocolVersion?: number
  // v5 additions. Both optional so legacy reads don't throw.
  pendingTasks?: PendingTask[]
  // Append-only log of parsed conductor decision JSON strings. Useful for
  // resume (to re-seed scheduler state) and for post-hoc debugging.
  conductorDecisions?: string[]
  // ParticipantIds that have produced at least one `done` event in this
  // dispatch. Persisted so the queue/release dep gate (`dependsOn`) keeps
  // working across a resume — otherwise a fresh Scheduler would start
  // with an empty completedZones set and any queued task would stall.
  completedZones?: string[]
  // Shared plan/workboard metadata for multi-zone dispatches. The docs
  // themselves live under ARCHITECT/dispatches/<dispatchId>/.
  planRevision?: number
  planPath?: string
  workboardPath?: string
  planUpdatedAt?: string
  // Workspace anchor for the dispatch. Equal to projectDir today (the
  // workspace primary). When the renderer starts using majority-rule
  // primary-for-dispatch this will diverge — runtime/manifest/prompts live
  // under THIS folder's ARCHITECT/, not necessarily the workspace primary.
  // Optional for backward compat with older v5 records.
  dispatchPrimaryFolder?: string
  // Distinct folders that contributed zones to this dispatch. Resume uses
  // this to validate that all required folders are still loaded (or
  // auto-load missing ones) before re-spawning. Absent for older records.
  involvedFolders?: string[]
}

export const DISPATCH_PROTOCOL_VERSION = 5

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
      dispatchId: typeof parsed.dispatchId === 'string' ? parsed.dispatchId : undefined,
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
      pendingTasks: Array.isArray(parsed.pendingTasks) ? parsed.pendingTasks : undefined,
      conductorDecisions: Array.isArray(parsed.conductorDecisions) ? parsed.conductorDecisions : undefined,
      completedZones: Array.isArray(parsed.completedZones)
        ? parsed.completedZones.filter((s): s is string => typeof s === 'string')
        : undefined,
      planRevision: typeof parsed.planRevision === 'number' ? parsed.planRevision : undefined,
      planPath: typeof parsed.planPath === 'string' ? parsed.planPath : undefined,
      workboardPath: typeof parsed.workboardPath === 'string' ? parsed.workboardPath : undefined,
      planUpdatedAt: typeof parsed.planUpdatedAt === 'string' ? parsed.planUpdatedAt : undefined,
      dispatchPrimaryFolder:
        typeof parsed.dispatchPrimaryFolder === 'string' ? parsed.dispatchPrimaryFolder : undefined,
      involvedFolders: Array.isArray(parsed.involvedFolders)
        ? parsed.involvedFolders.filter((s): s is string => typeof s === 'string')
        : undefined,
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

// Rewrites the pendingTasks array. Callers build it from current scheduler
// state and invoke this on every task-state transition so a crash-then-
// resume can re-deliver exactly what was in flight.
export function setDispatchPendingTasks(
  projectDir: string,
  id: string,
  pendingTasks: PendingTask[],
): boolean {
  const rec = getDispatch(projectDir, id)
  if (!rec) return false
  saveDispatch(projectDir, { ...rec, pendingTasks })
  return true
}

// Rewrites the completedZones array (full set, not append). Called by the
// scheduler each time a zone reaches `done` for the first time so a
// resume can rehydrate the dependsOn dep gate.
export function setDispatchCompletedZones(
  projectDir: string,
  id: string,
  completedZones: string[],
): boolean {
  const rec = getDispatch(projectDir, id)
  if (!rec) return false
  saveDispatch(projectDir, { ...rec, completedZones })
  return true
}

// Append-only log of parsed conductor decision JSON. Written once per
// successfully-parsed decision so resume has an audit trail.
export function appendDispatchConductorDecision(
  projectDir: string,
  id: string,
  decisionJson: string,
): boolean {
  const rec = getDispatch(projectDir, id)
  if (!rec) return false
  const existing = rec.conductorDecisions ?? []
  saveDispatch(projectDir, { ...rec, conductorDecisions: [...existing, decisionJson] })
  return true
}

export function setDispatchPlanMetadata(
  projectDir: string,
  id: string,
  metadata: {
    planRevision: number
    planPath: string
    workboardPath: string
    planUpdatedAt?: string
  },
): boolean {
  const rec = getDispatch(projectDir, id)
  if (!rec) return false
  saveDispatch(projectDir, {
    ...rec,
    planRevision: metadata.planRevision,
    planPath: metadata.planPath,
    workboardPath: metadata.workboardPath,
    planUpdatedAt: metadata.planUpdatedAt ?? new Date().toISOString(),
  })
  return true
}
