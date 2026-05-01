import { AGENT_RUNTIMES, type AgentRuntime } from '../shared/agentRuntimes'
import type { DetectedRuntime, RuntimeDetectionResult } from '../shared/runtimeDetection'
import { resolveBinary } from './terminals'
import { getRuntimeAdapter } from './runtimes'
import { getCached, setCached } from './cliModelCache'
import { isPromptProbableRuntime, probeCliModelsViaPrompt } from './cliModelProbe'

const ADAPTER_PROBE_TIMEOUT_MS = 3000

let cache: RuntimeDetectionResult | null = null
let inflight: Promise<RuntimeDetectionResult> | null = null

async function adapterProbe(runtime: AgentRuntime, binaryPath: string): Promise<{ models: string[]; modelsSource: 'probed' | 'suggested' }> {
  const adapter = getRuntimeAdapter(runtime)
  if (!adapter.probeModels) return { models: [], modelsSource: 'suggested' }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ADAPTER_PROBE_TIMEOUT_MS)
  try {
    const models = await adapter.probeModels({ binaryPath, signal: controller.signal })
    if (!Array.isArray(models) || models.length === 0) {
      return { models: [], modelsSource: 'suggested' }
    }
    return { models, modelsSource: 'probed' }
  } catch {
    return { models: [], modelsSource: 'suggested' }
  } finally {
    clearTimeout(timer)
  }
}

async function detectOne(def: typeof AGENT_RUNTIMES[number]): Promise<DetectedRuntime> {
  const binaryPath = resolveBinary(def.id)
  if (!binaryPath) {
    return {
      id: def.id,
      installed: false,
      models: def.suggestedModels,
      modelsSource: 'suggested',
      defaultModel: def.defaultModel,
    }
  }

  // For runtimes without a fast adapter probe (claude/codex/gemini), prefer
  // any cached "Refresh models" result the user previously triggered. If the
  // cache is empty we fall through to suggestedModels until they hit refresh.
  if (isPromptProbableRuntime(def.id)) {
    const cached = getCached(def.id)
    if (cached && cached.ids.length > 0) {
      return {
        id: def.id,
        installed: true,
        binaryPath,
        models: cached.ids,
        modelsSource: 'probed',
        probedAt: cached.probedAt,
        defaultModel: def.defaultModel,
      }
    }
    return {
      id: def.id,
      installed: true,
      binaryPath,
      models: def.suggestedModels,
      modelsSource: 'suggested',
      defaultModel: def.defaultModel,
    }
  }

  // opencode: live shell-out via `opencode models` (~hundreds of ms, deterministic).
  const probe = await adapterProbe(def.id, binaryPath)
  return {
    id: def.id,
    installed: true,
    binaryPath,
    models: probe.modelsSource === 'probed' ? probe.models : def.suggestedModels,
    modelsSource: probe.modelsSource,
    probedAt: probe.modelsSource === 'probed' ? Date.now() : undefined,
    defaultModel: def.defaultModel,
  }
}

async function runDetection(): Promise<RuntimeDetectionResult> {
  const runtimes = await Promise.all(AGENT_RUNTIMES.map(def => detectOne(def)))
  return { runtimes, scannedAt: Date.now() }
}

export async function detectRuntimes(): Promise<RuntimeDetectionResult> {
  if (cache) return cache
  if (inflight) return inflight
  inflight = runDetection()
  try {
    cache = await inflight
    return cache
  } finally {
    inflight = null
  }
}

export function getDetected(): RuntimeDetectionResult {
  return cache ?? { runtimes: [], scannedAt: 0 }
}

export async function rescanRuntimes(): Promise<RuntimeDetectionResult> {
  cache = null
  inflight = null
  return detectRuntimes()
}

export interface CliPromptProbeReport {
  runtime: AgentRuntime
  ok: boolean
  count: number
  error?: string
}

// User-triggered: probe each installed non-opencode CLI in headless prompt
// mode, write results to disk cache, then rebuild detection so pickers
// pick up the new lists. Returns a per-runtime report so the UI can show
// success / failure / count per CLI.
export async function refreshCliPromptModels(): Promise<{
  reports: CliPromptProbeReport[]
  detection: RuntimeDetectionResult
}> {
  const snapshot = await detectRuntimes()
  const targets = snapshot.runtimes.filter(r => r.installed && r.binaryPath && isPromptProbableRuntime(r.id))

  const reports = await Promise.all(targets.map(async (target): Promise<CliPromptProbeReport> => {
    try {
      const { ids } = await probeCliModelsViaPrompt({ runtime: target.id, binaryPath: target.binaryPath! })
      if (ids.length === 0) {
        return { runtime: target.id, ok: false, count: 0, error: 'No model IDs parsed from CLI output' }
      }
      setCached(target.id, { ids, probedAt: Date.now() })
      return { runtime: target.id, ok: true, count: ids.length }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { runtime: target.id, ok: false, count: 0, error: message.slice(0, 400) }
    }
  }))

  // Rebuild detection so the new cached lists land on subsequent getDetected calls.
  cache = null
  inflight = null
  const detection = await detectRuntimes()
  return { reports, detection }
}
