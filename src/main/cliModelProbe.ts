import { execFile } from 'child_process'
import type { AgentRuntime } from '../shared/agentRuntimes'

// User-triggered model discovery: invoke each CLI in headless prompt mode
// and ask the model itself to enumerate the IDs it can run. Best-effort,
// non-deterministic — model output is parsed defensively. Cached on disk by
// the caller so we don't pay this latency/cost on every launch.

const PROBE_TIMEOUT_MS = 120_000 // 2 min — LLM round-trips can be slow.

const PROMPT = `Reply with ONLY a fenced \`\`\`json code block containing the model IDs you support, in this exact shape:
{"models":[{"id":"<model-id-1>"},{"id":"<model-id-2>"}]}
No prose, no commentary, no other fields. Use the canonical model IDs you accept on the --model flag.`

// Per-CLI flags for one-shot mode. Verified against --help:
//   claude  -p <prompt>           (also accepts --json-schema)
//   gemini  -p <prompt>           (also has --output-format json)
//
// codex is intentionally absent — its adapter reads ~/.codex/models_cache.json
// directly, which is faster and avoids `codex exec` fanning out into tool
// calls. opencode is also absent — it has `opencode models` natively.
type PromptProbableRuntime = 'claude' | 'gemini'

const PROBE_ARGS: Record<PromptProbableRuntime, (prompt: string) => string[]> = {
  claude: prompt => ['-p', prompt],
  gemini: prompt => ['-p', prompt],
}

export interface CliModelProbeResult {
  ids: string[]
  rawOutput: string
}

export function isPromptProbableRuntime(runtime: AgentRuntime): runtime is PromptProbableRuntime {
  return runtime === 'claude' || runtime === 'gemini'
}

export async function probeCliModelsViaPrompt(opts: {
  runtime: AgentRuntime
  binaryPath: string
  signal?: AbortSignal
}): Promise<CliModelProbeResult> {
  if (!isPromptProbableRuntime(opts.runtime)) {
    throw new Error(`probeCliModelsViaPrompt: ${opts.runtime} uses adapter.probeModels, not LLM-prompt probing`)
  }
  const args = PROBE_ARGS[opts.runtime](PROMPT)
  const stdout = await runProbe(opts.binaryPath, args, opts.signal)
  const ids = extractModelIds(stdout)
  return { ids, rawOutput: stdout }
}

function runProbe(bin: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      {
        signal,
        timeout: PROBE_TIMEOUT_MS,
        // Up to ~2 MB of output. LLMs occasionally ramble even when told not to.
        maxBuffer: 2 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) {
          // Surface stderr in the error message so the UI can show why a probe failed.
          const reason = (stderr || '').trim().slice(0, 400) || err.message
          reject(new Error(reason))
          return
        }
        resolve(stdout)
      },
    )
  })
}

// Defensive JSON extraction. Tries fenced ```json block first, then any
// fenced block, then a raw object scan. Validates {models:[{id}]} shape and
// drops any id that doesn't match a sane slug pattern.
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]+$/

export function extractModelIds(raw: string): string[] {
  const candidates = collectJsonCandidates(raw)
  for (const candidate of candidates) {
    const ids = parseAndValidate(candidate)
    if (ids.length > 0) return ids
  }
  return []
}

function collectJsonCandidates(raw: string): string[] {
  const out: string[] = []
  // Fenced ```json … ``` block first (most explicit).
  const fencedJson = /```json\s*\n([\s\S]*?)```/gi
  for (const match of raw.matchAll(fencedJson)) {
    out.push(match[1].trim())
  }
  // Any fenced ``` … ``` block as a fallback.
  const fencedAny = /```\s*\n([\s\S]*?)```/g
  for (const match of raw.matchAll(fencedAny)) {
    const body = match[1].trim()
    if (body.startsWith('{')) out.push(body)
  }
  // Greedy outermost {…} as a last resort.
  const firstBrace = raw.indexOf('{')
  const lastBrace = raw.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    out.push(raw.slice(firstBrace, lastBrace + 1))
  }
  return out
}

function parseAndValidate(jsonish: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonish)
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object') return []
  const models = (parsed as { models?: unknown }).models
  if (!Array.isArray(models)) return []
  const ids: string[] = []
  const seen = new Set<string>()
  for (const entry of models) {
    if (!entry || typeof entry !== 'object') continue
    const id = (entry as { id?: unknown }).id
    if (typeof id !== 'string') continue
    const trimmed = id.trim()
    if (!trimmed || seen.has(trimmed)) continue
    if (!ID_RE.test(trimmed)) continue
    seen.add(trimmed)
    ids.push(trimmed)
  }
  return ids
}
