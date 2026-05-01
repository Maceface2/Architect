import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import type { AgentRuntime } from '../shared/agentRuntimes'

// Disk cache of "Refresh models" results. Survives app restarts so the user
// doesn't pay the LLM-probe latency every launch. No TTL — the user
// explicitly re-runs the probe via the Settings button when they want a
// fresh list. Per-runtime entries; opencode is intentionally absent because
// it's auto-probed at startup via `opencode models` (fast + deterministic).

const FILENAME = 'cli-model-cache.json'

interface CacheEntry {
  ids: string[]
  probedAt: number
}

interface CacheShape {
  version: 1
  entries: Partial<Record<AgentRuntime, CacheEntry>>
}

let memo: CacheShape | null = null

function cachePath(): string {
  return path.join(app.getPath('userData'), FILENAME)
}

function read(): CacheShape {
  if (memo) return memo
  try {
    const raw = fs.readFileSync(cachePath(), 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed && parsed.version === 1 && parsed.entries && typeof parsed.entries === 'object') {
      memo = { version: 1, entries: sanitizeEntries(parsed.entries as Record<string, unknown>) }
      return memo
    }
  } catch {
    // missing / unreadable / malformed → treat as empty
  }
  memo = { version: 1, entries: {} }
  return memo
}

// Drop any entry whose inner shape doesn't match { ids: string[], probedAt: number }.
// A hand-edited or partially-written cache file shouldn't smuggle non-strings
// into pickers downstream.
function sanitizeEntries(raw: Record<string, unknown>): Partial<Record<AgentRuntime, CacheEntry>> {
  const out: Partial<Record<AgentRuntime, CacheEntry>> = {}
  for (const [runtime, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object') continue
    const entry = value as Partial<CacheEntry>
    if (!Array.isArray(entry.ids)) continue
    if (typeof entry.probedAt !== 'number' || !Number.isFinite(entry.probedAt)) continue
    const ids = entry.ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    if (ids.length === 0) continue
    out[runtime as AgentRuntime] = { ids, probedAt: entry.probedAt }
  }
  return out
}

function write(next: CacheShape): void {
  memo = next
  try {
    const dir = path.dirname(cachePath())
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(cachePath(), JSON.stringify(next, null, 2), 'utf-8')
  } catch (err) {
    console.warn('[cli-model-cache] write failed:', err)
  }
}

export function getCached(runtime: AgentRuntime): CacheEntry | undefined {
  return read().entries[runtime]
}

export function setCached(runtime: AgentRuntime, entry: CacheEntry): void {
  const next = read()
  write({ version: 1, entries: { ...next.entries, [runtime]: entry } })
}

export function clearCached(runtime: AgentRuntime): void {
  const next = read()
  if (!next.entries[runtime]) return
  const entries = { ...next.entries }
  delete entries[runtime]
  write({ version: 1, entries })
}
