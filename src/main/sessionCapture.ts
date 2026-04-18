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

function sessionFile(projectDir: string, zoneSafe: string): string {
  return join(sessionsDir(projectDir), `${zoneSafe}.json`)
}

export function saveZoneSession(projectDir: string, zoneSafe: string, session: ZoneSession): void {
  fs.mkdirSync(sessionsDir(projectDir), { recursive: true })
  fs.writeFileSync(sessionFile(projectDir, zoneSafe), JSON.stringify(session, null, 2))
}

export function loadZoneSession(projectDir: string, zoneSafe: string): ZoneSession | null {
  try {
    const raw = fs.readFileSync(sessionFile(projectDir, zoneSafe), 'utf-8')
    const parsed = JSON.parse(raw)
    if (typeof parsed?.sessionId === 'string' && typeof parsed?.runtime === 'string') {
      return parsed as ZoneSession
    }
  } catch {}
  return null
}
