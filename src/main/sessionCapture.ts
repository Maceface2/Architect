import fs from 'fs'
import os from 'os'
import { join } from 'path'
import * as pty from 'node-pty'
import type { AgentRuntime } from '../shared/agentRuntimes'

export interface ZoneSession {
  runtime: AgentRuntime
  sessionId: string
  capturedAt: string
}

const CLAUDE_PROJECTS_ROOT = join(os.homedir(), '.claude', 'projects')
const SESSIONS_SUBDIR = 'sessions'

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

function listCodexSessionIdsForCwd(cwd: string, primaryOnly = false): Set<string> {
  const ids = new Set<string>()
  let years: string[]
  try {
    years = fs.readdirSync(CODEX_SESSIONS_ROOT).filter(n => /^\d{4}$/.test(n)).sort().reverse()
  } catch {
    return ids
  }
  // Walk newest-first. We only need to scan deep enough to cover anything that
  // could plausibly have been created during this dispatch (today + yesterday
  // is always safe, and we cap the day count for safety).
  let dayBudget = 5
  for (const y of years) {
    if (dayBudget <= 0) break
    let months: string[]
    try {
      months = fs.readdirSync(join(CODEX_SESSIONS_ROOT, y)).filter(n => /^\d{2}$/.test(n)).sort().reverse()
    } catch { continue }
    for (const m of months) {
      if (dayBudget <= 0) break
      let days: string[]
      try {
        days = fs.readdirSync(join(CODEX_SESSIONS_ROOT, y, m)).filter(n => /^\d{2}$/.test(n)).sort().reverse()
      } catch { continue }
      for (const d of days) {
        if (dayBudget <= 0) break
        dayBudget--
        const dir = join(CODEX_SESSIONS_ROOT, y, m, d)
        let files: string[]
        try {
          files = fs.readdirSync(dir).filter(n => n.startsWith('rollout-') && n.endsWith('.jsonl'))
        } catch { continue }
        for (const f of files) {
          const meta = readCodexSessionMeta(join(dir, f))
          if (!meta || meta.cwd !== cwd) continue
          if (primaryOnly && !meta.isPrimary) continue
          ids.add(meta.id)
        }
      }
    }
  }
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
  let years: string[]
  try {
    years = fs.readdirSync(CODEX_SESSIONS_ROOT).filter(n => /^\d{4}$/.test(n)).sort().reverse()
  } catch {
    return false
  }

  for (const y of years) {
    let months: string[]
    try {
      months = fs.readdirSync(join(CODEX_SESSIONS_ROOT, y)).filter(n => /^\d{2}$/.test(n)).sort().reverse()
    } catch { continue }

    for (const m of months) {
      let days: string[]
      try {
        days = fs.readdirSync(join(CODEX_SESSIONS_ROOT, y, m)).filter(n => /^\d{2}$/.test(n)).sort().reverse()
      } catch { continue }

      for (const d of days) {
        const dir = join(CODEX_SESSIONS_ROOT, y, m, d)
        let files: string[]
        try {
          files = fs.readdirSync(dir).filter(n => n.endsWith(`${sessionId}.jsonl`))
        } catch { continue }

        for (const f of files) {
          const meta = readCodexSessionMeta(join(dir, f))
          if (meta?.id === sessionId && meta.cwd === cwd && meta.isPrimary) return true
        }
      }
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

function sessionFile(projectDir: string, zoneKey: string): string {
  return join(sessionsDir(projectDir), `${zoneKey}.json`)
}

export function saveZoneSession(projectDir: string, zoneKey: string, session: ZoneSession): void {
  fs.mkdirSync(sessionsDir(projectDir), { recursive: true })
  fs.writeFileSync(sessionFile(projectDir, zoneKey), JSON.stringify(session, null, 2))
}

// Primary key is the zone's stable id. When the file is absent, fall back to a
// legacy key (e.g. sanitized label from pre-refactor builds); if found, rewrite
// it under the primary key so future lookups hit directly.
export function loadZoneSession(
  projectDir: string,
  zoneKey: string,
  legacyKey?: string,
): ZoneSession | null {
  const primary = readZoneSession(sessionFile(projectDir, zoneKey))
  if (primary) return primary

  if (legacyKey && legacyKey !== zoneKey) {
    const legacy = readZoneSession(sessionFile(projectDir, legacyKey))
    if (legacy) {
      try {
        saveZoneSession(projectDir, zoneKey, legacy)
        fs.unlinkSync(sessionFile(projectDir, legacyKey))
      } catch {}
      return legacy
    }
  }
  return null
}

function readZoneSession(path: string): ZoneSession | null {
  try {
    const raw = fs.readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw)
    if (typeof parsed?.sessionId === 'string' && typeof parsed?.runtime === 'string') {
      return parsed as ZoneSession
    }
  } catch {}
  return null
}

export function deleteZoneSession(projectDir: string, zoneKey: string, legacyKey?: string): boolean {
  let removed = false
  const primary = sessionFile(projectDir, zoneKey)
  if (fs.existsSync(primary)) {
    try { fs.unlinkSync(primary); removed = true } catch {}
  }
  if (legacyKey && legacyKey !== zoneKey) {
    const legacy = sessionFile(projectDir, legacyKey)
    if (fs.existsSync(legacy)) {
      try { fs.unlinkSync(legacy); removed = true } catch {}
    }
  }
  return removed
}
