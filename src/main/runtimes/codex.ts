import fs from 'fs'
import os from 'os'
import path from 'path'
import { effortArgsFor, type AgentRuntime } from '../../shared/agentRuntimes'
import {
  captureNewCodexSession,
  isCodexSessionIdForCwd,
  snapshotCodexSessions,
} from '../sessionCapture'
import { foldComposeSystemAndUser } from './fold'
import type { ResumeArgs, RuntimeAdapter, SpawnArgs } from './types'

const id: AgentRuntime = 'codex'

const CODEX_MODELS_CACHE = path.join(os.homedir(), '.codex', 'models_cache.json')
const CODEX_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]+$/

// codex maintains a local model registry in ~/.codex/models_cache.json,
// kept in sync by the CLI itself. Reading it is far better than an LLM
// probe — fast, deterministic, and the slugs are exactly what `--model`
// accepts. Hidden models (visibility: "hide") are filtered out so we don't
// surface internal/oss variants the user can't actually pick.
async function probeCodexModelsFromCache(): Promise<string[]> {
  let raw: string
  try {
    raw = fs.readFileSync(CODEX_MODELS_CACHE, 'utf-8')
  } catch {
    throw new Error('~/.codex/models_cache.json not found — log in via `codex login` first')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('models_cache.json: not valid JSON — try `codex login` to regenerate it')
  }
  const models = (parsed as { models?: unknown } | null)?.models
  if (!Array.isArray(models)) throw new Error('models_cache.json: models field missing')
  const ids: string[] = []
  const seen = new Set<string>()
  for (const m of models) {
    if (!m || typeof m !== 'object') continue
    if (m.visibility === 'hide') continue
    const slug = m.slug
    if (typeof slug !== 'string') continue
    const trimmed = slug.trim()
    if (!trimmed || seen.has(trimmed) || !CODEX_SLUG_RE.test(trimmed)) continue
    seen.add(trimmed)
    ids.push(trimmed)
  }
  return ids
}

// Shared operating flags. Applied on both fresh spawn and resume —
// `codex resume <UUID>` is a subcommand, not a flag, and accepts the same
// standard operating flags.
const BASE_OP_FLAGS = ['--no-alt-screen', '-a', 'never', '-s', 'workspace-write']

function buildSpawnArgs(opts: SpawnArgs): string[] {
  const args: string[] = []
  args.push(...BASE_OP_FLAGS)
  if (opts.model) args.push('--model', opts.model)
  if (opts.effort) args.push(...effortArgsFor(id, opts.effort))
  if (opts.userPrompt) args.push(opts.userPrompt)
  return args
}

function buildResumeArgs(opts: ResumeArgs): string[] {
  const args: string[] = ['resume', opts.sessionId, ...BASE_OP_FLAGS]
  if (opts.model) args.push('--model', opts.model)
  if (opts.effort) args.push(...effortArgsFor(id, opts.effort))
  if (opts.userPrompt) args.push(opts.userPrompt)
  return args
}

export const codexAdapter: RuntimeAdapter = {
  id,
  supportsSystemPromptFlag: false,
  buildSpawnArgs,
  buildResumeArgs,
  composeSystemAndUser: foldComposeSystemAndUser,
  snapshotSessions: (cwd) => snapshotCodexSessions(cwd),
  captureNewSession: (cwd, before, timeoutMs) =>
    captureNewCodexSession(cwd, before, timeoutMs),
  revalidateSession: (cwd, sessionId) => isCodexSessionIdForCwd(cwd, sessionId),
  probeModels: probeCodexModelsFromCache,
}
