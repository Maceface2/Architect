import fs from 'fs'
import os from 'os'
import { createHash } from 'crypto'
import { join, resolve } from 'path'
import * as pty from 'node-pty'
import type { AgentRuntime } from '../shared/agentRuntimes'

export interface ZoneSessionRecord {
  runtime: AgentRuntime
  sessionId: string
  capturedAt: string
  summary: string
  // Model passed to the CLI at spawn. Used to replay the exact same config on
  // resume — the per-CLI default or the user's current picker selection may
  // have drifted since this session was started.
  model?: string
  // When the session was spawned as part of a multi-zone dispatch, points to
  // the Architect session that orchestrated it. Used by the renderer to show
  // a "from dispatch" badge in the zone launcher history.
  dispatchId?: string
}

const CLAUDE_PROJECTS_ROOT = join(os.homedir(), '.claude', 'projects')
const CLAUDE_CONFIG_PATH = join(os.homedir(), '.claude.json')
const SESSIONS_SUBDIR = 'sessions'
const MAX_ZONE_SESSIONS = 20

// On a directory Claude Code has never seen, the TUI opens with a "Do you
// trust the files in this folder?" prompt and blocks session-file creation
// until dismissed — which makes our capture poll time out and freezes the
// UI for the full CAPTURE_SERIAL_TIMEOUT_MS window. Pre-seeding the trust
// flag for the project in ~/.claude.json sidesteps the dialog entirely for
// Architect-managed cwds, without weakening per-edit permission prompts.
// Best-effort: any read/parse/write failure is swallowed — worst case is
// the pre-fix behavior.
export function ensureClaudeProjectTrusted(cwd: string): void {
  let config: Record<string, unknown> = {}
  try {
    const raw = fs.readFileSync(CLAUDE_CONFIG_PATH, 'utf-8')
    config = JSON.parse(raw) as Record<string, unknown>
  } catch {
    // File missing or unreadable — start from empty; claude will fill in
    // the rest on first launch.
  }
  const projects = (config.projects as Record<string, Record<string, unknown>> | undefined) ?? {}
  const existing = projects[cwd]
  if (existing && existing.hasTrustDialogAccepted === true) return
  projects[cwd] = {
    allowedTools: [],
    mcpContextUris: [],
    mcpServers: {},
    enabledMcpjsonServers: [],
    disabledMcpjsonServers: [],
    projectOnboardingSeenCount: 1,
    hasClaudeMdExternalIncludesApproved: false,
    hasClaudeMdExternalIncludesWarningShown: false,
    ...(existing ?? {}),
    hasTrustDialogAccepted: true,
  }
  config.projects = projects
  try {
    const tmp = `${CLAUDE_CONFIG_PATH}.architect.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2))
    fs.renameSync(tmp, CLAUDE_CONFIG_PATH)
  } catch {
    // Another claude instance may have rewritten the file concurrently.
    // Dropping the update is safe — the dialog just shows once.
  }
}

// Claude Code stores per-project sessions at ~/.claude/projects/<sanitized-cwd>/<uuid>.jsonl.
// Claude replaces any character outside [A-Za-z0-9_-] (slashes, spaces, dots, etc.) with a dash.
function sanitizeCwdForClaude(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9_-]/g, '-')
}

function listClaudeSessionUuids(cwd: string): Set<string> {
  const dir = join(CLAUDE_PROJECTS_ROOT, sanitizeCwdForClaude(cwd))
  try {
    return new Set(
      fs.readdirSync(dir)
        .filter(name => name.endsWith('.jsonl'))
        .map(name => name.slice(0, -'.jsonl'.length))
    )
  } catch {
    return new Set()
  }
}

export function snapshotClaudeSessions(cwd: string): Set<string> {
  return listClaudeSessionUuids(cwd)
}

// Polls the Claude projects dir for a UUID that wasn't present at snapshot time.
// Returns the new session ID, or null if none appears within `timeoutMs`.
export async function captureNewClaudeSession(
  cwd: string,
  before: Set<string>,
  timeoutMs = 30000,
  pollMs = 500,
): Promise<string | null> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const current = listClaudeSessionUuids(cwd)
    for (const id of current) {
      if (!before.has(id)) return id
    }
    await new Promise(resolve => setTimeout(resolve, pollMs))
  }
  return null
}

// --- Codex ---
// Sessions live in ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<UUID>.jsonl.
// First line is {"type":"session_meta","payload":{"id":"<UUID>","cwd":"<cwd>",...}}.
// We filter to sessions whose cwd matches so cross-project codex usage doesn't
// pollute capture.
const CODEX_SESSIONS_ROOT = join(os.homedir(), '.codex', 'sessions')

interface CodexSessionMeta {
  id: string
  cwd: string
  isPrimary: boolean
}

// Walks ~/.codex/sessions/YYYY/MM/DD/ newest-first, invoking fn for each day
// directory. Return true from fn to stop early. maxDays caps scan depth — the
// list-on-poll path uses 5 (covers today + a safety margin), the lookup path
// scans unbounded so a stale id from any date can still revalidate.
function forEachCodexDayDir(maxDays: number | undefined, fn: (dir: string) => boolean | void): void {
  let years: string[]
  try {
    years = fs.readdirSync(CODEX_SESSIONS_ROOT).filter(n => /^\d{4}$/.test(n)).sort().reverse()
  } catch { return }
  let budget = maxDays ?? Infinity
  for (const y of years) {
    if (budget <= 0) return
    let months: string[]
    try {
      months = fs.readdirSync(join(CODEX_SESSIONS_ROOT, y)).filter(n => /^\d{2}$/.test(n)).sort().reverse()
    } catch { continue }
    for (const m of months) {
      if (budget <= 0) return
      let days: string[]
      try {
        days = fs.readdirSync(join(CODEX_SESSIONS_ROOT, y, m)).filter(n => /^\d{2}$/.test(n)).sort().reverse()
      } catch { continue }
      for (const d of days) {
        if (budget <= 0) return
        budget--
        if (fn(join(CODEX_SESSIONS_ROOT, y, m, d)) === true) return
      }
    }
  }
}

function listCodexSessionIdsForCwd(cwd: string, primaryOnly = false): Set<string> {
  const ids = new Set<string>()
  forEachCodexDayDir(5, dir => {
    let files: string[]
    try {
      files = fs.readdirSync(dir).filter(n => n.startsWith('rollout-') && n.endsWith('.jsonl'))
    } catch { return }
    for (const f of files) {
      const meta = readCodexSessionMeta(join(dir, f))
      if (!meta || meta.cwd !== cwd) continue
      if (primaryOnly && !meta.isPrimary) continue
      ids.add(meta.id)
    }
  })
  return ids
}

function readCodexSessionMeta(path: string): CodexSessionMeta | null {
  try {
    const fd = fs.openSync(path, 'r')
    try {
      const buf = Buffer.alloc(65536)
      const bytes = fs.readSync(fd, buf, 0, buf.length, 0)
      const firstLine = buf.slice(0, bytes).toString('utf-8').split('\n', 1)[0]
      const parsed = JSON.parse(firstLine)
      if (parsed?.type === 'session_meta' && typeof parsed?.payload?.cwd === 'string' && typeof parsed?.payload?.id === 'string') {
        const source = parsed.payload.source
        const isSubagent =
          !!source &&
          typeof source === 'object' &&
          'subagent' in (source as Record<string, unknown>)

        return {
          id: parsed.payload.id as string,
          cwd: parsed.payload.cwd as string,
          isPrimary: !isSubagent,
        }
      }
    } finally {
      fs.closeSync(fd)
    }
  } catch {}
  return null
}

export function snapshotCodexSessions(cwd: string): Set<string> {
  return listCodexSessionIdsForCwd(cwd, true)
}

export async function captureNewCodexSession(
  cwd: string,
  before: Set<string>,
  timeoutMs = 90000,
  pollMs = 750,
): Promise<string | null> {
  const start = Date.now()
  let lastSize = before.size
  while (Date.now() - start < timeoutMs) {
    const current = listCodexSessionIdsForCwd(cwd, true)
    for (const id of current) {
      if (!before.has(id)) return id
    }
    if (current.size !== lastSize) {
      console.log(`[session-capture] codex poll: cwd-matching sessions ${lastSize} → ${current.size} (none new)`)
      lastSize = current.size
    }
    await new Promise(resolve => setTimeout(resolve, pollMs))
  }
  return null
}

export function isCodexSessionIdForCwd(cwd: string, sessionId: string): boolean {
  let found = false
  forEachCodexDayDir(undefined, dir => {
    let files: string[]
    try {
      files = fs.readdirSync(dir).filter(n => n.endsWith(`${sessionId}.jsonl`))
    } catch { return }
    for (const f of files) {
      const meta = readCodexSessionMeta(join(dir, f))
      if (meta?.id === sessionId && meta.cwd === cwd && meta.isPrimary) {
        found = true
        return true
      }
    }
  })
  return found
}

// --- Gemini ---
// Gemini stores project sessions under ~/.gemini/tmp/<identifier>/chats/session-*.json.
// Newer versions use a slug from ~/.gemini/projects.json; older versions used a
// SHA-256 hash of the project root. Session files include the stable sessionId,
// projectHash, timestamps, messages, and a kind ("main" or "subagent").
const GEMINI_ROOT = join(os.homedir(), '.gemini')
const GEMINI_TMP_ROOT = join(GEMINI_ROOT, 'tmp')
const GEMINI_PROJECTS_PATH = join(GEMINI_ROOT, 'projects.json')

interface GeminiSessionMeta {
  id: string
  projectHash: string
  isPrimary: boolean
}

function hashGeminiProjectRoot(cwd: string): string {
  return createHash('sha256').update(resolve(cwd)).digest('hex')
}

function readGeminiProjectRegistry(): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(GEMINI_PROJECTS_PATH, 'utf-8'))
    return parsed?.projects && typeof parsed.projects === 'object'
      ? parsed.projects as Record<string, string>
      : {}
  } catch {
    return {}
  }
}

function listGeminiChatDirs(cwd: string): string[] {
  const dirs = new Set<string>()
  const resolved = resolve(cwd)
  const projectHash = hashGeminiProjectRoot(resolved)
  dirs.add(join(GEMINI_TMP_ROOT, projectHash, 'chats'))

  const slug = readGeminiProjectRegistry()[resolved]
  if (typeof slug === 'string' && slug) {
    dirs.add(join(GEMINI_TMP_ROOT, slug, 'chats'))
  }

  return Array.from(dirs)
}

function readGeminiSessionMeta(path: string): GeminiSessionMeta | null {
  try {
    const raw = fs.readFileSync(path, 'utf-8')
    // Newer Gemini versions write JSONL (one event per line, metadata on line 1);
    // older versions wrote a single JSON object. Try line-1 parse first, then whole-file.
    let parsed: any = null
    const firstNewline = raw.indexOf('\n')
    const firstLine = firstNewline >= 0 ? raw.slice(0, firstNewline) : raw
    try {
      parsed = JSON.parse(firstLine)
    } catch {
      try {
        parsed = JSON.parse(raw)
      } catch {
        return null
      }
    }
    if (typeof parsed?.sessionId !== 'string' || typeof parsed?.projectHash !== 'string') return null
    return {
      id: parsed.sessionId as string,
      projectHash: parsed.projectHash as string,
      isPrimary: parsed.kind !== 'subagent',
    }
  } catch {
    return null
  }
}

function listGeminiSessionIdsForCwd(cwd: string, primaryOnly = false): Set<string> {
  const ids = new Set<string>()
  const projectHash = hashGeminiProjectRoot(cwd)

  for (const dir of listGeminiChatDirs(cwd)) {
    let files: string[]
    try {
      files = fs.readdirSync(dir).filter(
        name => name.startsWith('session-') && (name.endsWith('.jsonl') || name.endsWith('.json')),
      )
    } catch {
      continue
    }

    for (const file of files) {
      const meta = readGeminiSessionMeta(join(dir, file))
      if (!meta || meta.projectHash !== projectHash) continue
      if (primaryOnly && !meta.isPrimary) continue
      ids.add(meta.id)
    }
  }

  return ids
}

export function snapshotGeminiSessions(cwd: string): Set<string> {
  return listGeminiSessionIdsForCwd(cwd, true)
}

export async function captureNewGeminiSession(
  cwd: string,
  before: Set<string>,
  timeoutMs = 90000,
  pollMs = 750,
): Promise<string | null> {
  const start = Date.now()
  let lastSize = before.size
  while (Date.now() - start < timeoutMs) {
    const current = listGeminiSessionIdsForCwd(cwd, true)
    for (const id of current) {
      if (!before.has(id)) return id
    }
    if (current.size !== lastSize) {
      console.log(`[session-capture] gemini poll: project sessions ${lastSize} → ${current.size} (none new)`)
      lastSize = current.size
    }
    await new Promise(resolve => setTimeout(resolve, pollMs))
  }
  return null
}

export function isGeminiSessionIdForCwd(cwd: string, sessionId: string): boolean {
  const projectHash = hashGeminiProjectRoot(cwd)
  for (const dir of listGeminiChatDirs(cwd)) {
    let files: string[]
    try {
      files = fs.readdirSync(dir).filter(name => name.endsWith('.jsonl') || name.endsWith('.json'))
    } catch {
      continue
    }

    for (const file of files) {
      const meta = readGeminiSessionMeta(join(dir, file))
      if (meta?.id === sessionId && meta.projectHash === projectHash && meta.isPrimary) return true
    }
  }

  return false
}

// --- OpenCode ---
// OpenCode keeps sessions in a SQLite DB. We use the public CLI listing so we
// don't couple to internal schema. Each poll spawns a process, so use a longer
// interval than Claude/Codex.

function resolveOpencodeBin(): string {
  for (const dir of (process.env.PATH || '').split(':')) {
    const candidate = join(dir, 'opencode')
    try { if (fs.statSync(candidate).isFile()) return candidate } catch {}
  }
  return 'opencode'
}

// opencode's `session list` only writes to stdout when stdin is a TTY.
// Spawn it under a PTY so the CLI flushes its JSON, then collect the output.
function runOpencodeSessionList(maxCount = 10, timeoutMs = 10000): Promise<Set<string>> {
  return new Promise(resolve => {
    let settled = false
    const finish = (ids: Set<string>): void => {
      if (settled) return
      settled = true
      try { proc.kill() } catch {}
      clearTimeout(timer)
      resolve(ids)
    }

    const bin = resolveOpencodeBin()
    let proc: pty.IPty
    try {
      proc = pty.spawn(bin, ['session', 'list', '--format', 'json', '-n', String(maxCount)], {
        name: 'xterm-256color',
        cols: 200,
        rows: 50,
        cwd: process.env.HOME || os.homedir(),
        env: process.env as Record<string, string>,
      })
    } catch (err) {
      console.warn(`[session-capture] opencode session list spawn error:`, (err as Error).message)
      return resolve(new Set())
    }

    let buf = ''
    proc.onData(d => { buf += d })

    const timer = setTimeout(() => {
      console.warn(`[session-capture] opencode session list timed out (${timeoutMs}ms); raw=${buf.slice(0, 200).replace(/\[[0-9;]*m/g, '')}`)
      finish(parseOpencodeSessions(buf))
    }, timeoutMs)

    proc.onExit(() => finish(parseOpencodeSessions(buf)))
  })
}

function parseOpencodeSessions(raw: string): Set<string> {
  const ids = new Set<string>()
  // Strip ANSI escapes the PTY may inject.
  const cleaned = raw.replace(/\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '')
  const start = cleaned.indexOf('[')
  const end = cleaned.lastIndexOf(']')
  if (start < 0 || end <= start) return ids
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1))
    if (Array.isArray(parsed)) {
      for (const row of parsed) {
        const id = row?.id ?? row?.sessionId ?? row?.session_id
        if (typeof id === 'string') ids.add(id)
      }
    }
  } catch (e) {
    console.warn(`[session-capture] opencode session list JSON parse failed:`, (e as Error).message, `cleaned=${cleaned.slice(0, 200)}`)
  }
  return ids
}

export function snapshotOpencodeSessions(): Promise<Set<string>> {
  return runOpencodeSessionList()
}

export async function captureNewOpencodeSession(
  before: Set<string>,
  timeoutMs = 90000,
  pollMs = 2000,
): Promise<string | null> {
  const start = Date.now()
  let lastSize = before.size
  while (Date.now() - start < timeoutMs) {
    const current = await runOpencodeSessionList()
    for (const id of current) {
      if (!before.has(id)) return id
    }
    if (current.size !== lastSize) {
      console.log(`[session-capture] opencode poll: sessions ${lastSize} → ${current.size} (none new)`)
      lastSize = current.size
    }
    await new Promise(resolve => setTimeout(resolve, pollMs))
  }
  return null
}

function sessionsDir(projectDir: string): string {
  return join(projectDir, 'ARCHITECT', SESSIONS_SUBDIR)
}

function zoneDir(projectDir: string, zoneKey: string): string {
  return join(sessionsDir(projectDir), zoneKey)
}

function sessionRecordFile(projectDir: string, zoneKey: string, sessionId: string): string {
  return join(zoneDir(projectDir, zoneKey), `${sessionId}.json`)
}

// Legacy layout: ARCHITECT/sessions/<zoneKey>.json as a flat file. On first
// read under the new layout we migrate to ARCHITECT/sessions/<zoneKey>/<id>.json.
function legacyZoneFile(projectDir: string, zoneKey: string): string {
  return join(sessionsDir(projectDir), `${zoneKey}.json`)
}

function readRecord(path: string): ZoneSessionRecord | null {
  try {
    const raw = fs.readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw)
    if (typeof parsed?.sessionId === 'string' && typeof parsed?.runtime === 'string') {
      return {
        runtime: parsed.runtime,
        sessionId: parsed.sessionId,
        capturedAt: typeof parsed.capturedAt === 'string' ? parsed.capturedAt : new Date().toISOString(),
        summary: typeof parsed.summary === 'string' ? parsed.summary : 'Imported session',
        dispatchId: typeof parsed.dispatchId === 'string' ? parsed.dispatchId : undefined,
      }
    }
  } catch {}
  return null
}

function migrateLegacyIfPresent(projectDir: string, zoneKey: string, legacyKey?: string): void {
  const candidates = new Set<string>()
  candidates.add(legacyZoneFile(projectDir, zoneKey))
  if (legacyKey && legacyKey !== zoneKey) candidates.add(legacyZoneFile(projectDir, legacyKey))

  for (const path of candidates) {
    if (!fs.existsSync(path)) continue
    // If a directory with the same name already exists we've already migrated.
    try {
      const stat = fs.statSync(path)
      if (!stat.isFile()) continue
    } catch { continue }

    const rec = readRecord(path)
    if (!rec) {
      try { fs.unlinkSync(path) } catch {}
      continue
    }

    try {
      fs.mkdirSync(zoneDir(projectDir, zoneKey), { recursive: true })
      const target = sessionRecordFile(projectDir, zoneKey, rec.sessionId)
      if (!fs.existsSync(target)) {
        fs.writeFileSync(target, JSON.stringify({ ...rec, summary: rec.summary || 'Imported session' }, null, 2))
      }
      fs.unlinkSync(path)
    } catch {}
  }
}

function pruneToMax(projectDir: string, zoneKey: string): void {
  const dir = zoneDir(projectDir, zoneKey)
  let entries: string[]
  try {
    entries = fs.readdirSync(dir).filter(n => n.endsWith('.json'))
  } catch { return }
  if (entries.length <= MAX_ZONE_SESSIONS) return

  const withMeta = entries
    .map(name => {
      const rec = readRecord(join(dir, name))
      return rec ? { name, capturedAt: rec.capturedAt } : null
    })
    .filter((x): x is { name: string; capturedAt: string } => x !== null)
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt)) // oldest first

  const toDrop = withMeta.slice(0, Math.max(0, withMeta.length - MAX_ZONE_SESSIONS))
  for (const { name } of toDrop) {
    try { fs.unlinkSync(join(dir, name)) } catch {}
  }
}

export function appendZoneSession(
  projectDir: string,
  zoneKey: string,
  record: ZoneSessionRecord,
): void {
  fs.mkdirSync(zoneDir(projectDir, zoneKey), { recursive: true })
  fs.writeFileSync(
    sessionRecordFile(projectDir, zoneKey, record.sessionId),
    JSON.stringify(record, null, 2),
  )
  pruneToMax(projectDir, zoneKey)
}

// Newest-first list of a zone's recorded sessions. Migrates legacy layout on demand.
export function listZoneSessions(
  projectDir: string,
  zoneKey: string,
  legacyKey?: string,
): ZoneSessionRecord[] {
  migrateLegacyIfPresent(projectDir, zoneKey, legacyKey)
  const dir = zoneDir(projectDir, zoneKey)
  let entries: string[]
  try {
    entries = fs.readdirSync(dir).filter(n => n.endsWith('.json'))
  } catch { return [] }

  const records: ZoneSessionRecord[] = []
  for (const name of entries) {
    const rec = readRecord(join(dir, name))
    if (rec) records.push(rec)
  }
  records.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))
  return records
}

export function getZoneSessionRecord(
  projectDir: string,
  zoneKey: string,
  sessionId: string,
  legacyKey?: string,
): ZoneSessionRecord | null {
  migrateLegacyIfPresent(projectDir, zoneKey, legacyKey)
  return readRecord(sessionRecordFile(projectDir, zoneKey, sessionId))
}

// When sessionId is provided, deletes that one record. Otherwise wipes all
// history for the zone (used by "clear history" or by a full reset).
export function deleteZoneSession(
  projectDir: string,
  zoneKey: string,
  sessionId?: string,
  legacyKey?: string,
): boolean {
  migrateLegacyIfPresent(projectDir, zoneKey, legacyKey)
  const dir = zoneDir(projectDir, zoneKey)

  if (sessionId) {
    const path = sessionRecordFile(projectDir, zoneKey, sessionId)
    if (fs.existsSync(path)) {
      try { fs.unlinkSync(path); return true } catch {}
    }
    return false
  }

  let removed = false
  try {
    for (const name of fs.readdirSync(dir)) {
      try { fs.unlinkSync(join(dir, name)); removed = true } catch {}
    }
    try { fs.rmdirSync(dir) } catch {}
  } catch {}
  return removed
}

export function updateZoneSessionSummary(
  projectDir: string,
  zoneKey: string,
  sessionId: string,
  summary: string,
  legacyKey?: string,
): boolean {
  migrateLegacyIfPresent(projectDir, zoneKey, legacyKey)
  const path = sessionRecordFile(projectDir, zoneKey, sessionId)
  const rec = readRecord(path)
  if (!rec) return false
  try {
    fs.writeFileSync(path, JSON.stringify({ ...rec, summary }, null, 2))
    return true
  } catch {
    return false
  }
}
