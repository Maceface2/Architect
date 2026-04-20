import fs from 'fs'
import os from 'os'
import { join } from 'path'
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
