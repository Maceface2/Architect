import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { AGENT_RUNTIMES, AGENT_RUNTIME_MAP, type AgentRuntime } from '../../../shared/agentRuntimes'
import type { DetectedRuntime, RuntimeDetectionResult } from '../../../shared/runtimeDetection'

// "Not detected yet" placeholder — used as the initial context value before
// the renderer has a chance to call window.electron.runtime.getDetected().
// Treat every runtime as not-installed so pickers don't briefly show stale
// options on first paint. Main pre-warms the cache before mount, so the
// real snapshot replaces this within one render cycle.
function placeholderResult(): RuntimeDetectionResult {
  return {
    runtimes: AGENT_RUNTIMES.map(def => ({
      id: def.id,
      installed: false,
      models: def.suggestedModels,
      modelsSource: 'suggested' as const,
      defaultModel: def.defaultModel,
    })),
    scannedAt: 0,
  }
}

export interface CliPromptProbeReport {
  runtime: AgentRuntime
  ok: boolean
  count: number
  error?: string
}

interface RuntimeDetectionContextValue {
  result: RuntimeDetectionResult
  byId: Record<AgentRuntime, DetectedRuntime>
  installed: DetectedRuntime[]
  rescanning: boolean
  rescan: () => Promise<void>
  refreshing: boolean
  // Last per-runtime probe report from refreshModels(). Persists in memory
  // until the next refresh so the UI can show success/failure inline.
  lastRefreshReports: CliPromptProbeReport[] | null
  refreshModels: () => Promise<void>
}

const RuntimeDetectionContext = createContext<RuntimeDetectionContextValue | null>(null)

function indexById(result: RuntimeDetectionResult): Record<AgentRuntime, DetectedRuntime> {
  const map = {} as Record<AgentRuntime, DetectedRuntime>
  for (const def of AGENT_RUNTIMES) {
    const found = result.runtimes.find(r => r.id === def.id)
    map[def.id] = found ?? {
      id: def.id,
      installed: false,
      models: def.suggestedModels,
      modelsSource: 'suggested',
      defaultModel: def.defaultModel,
    }
  }
  return map
}

export function RuntimeDetectionProvider({ children }: { children: ReactNode }) {
  const [result, setResult] = useState<RuntimeDetectionResult>(placeholderResult)
  const [rescanning, setRescanning] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [lastRefreshReports, setLastRefreshReports] = useState<CliPromptProbeReport[] | null>(null)

  useEffect(() => {
    let cancelled = false
    window.electron.runtime
      .getDetected()
      .then(snapshot => {
        if (!cancelled) setResult(snapshot)
      })
      .catch(() => {
        // Leave placeholder in place. Pickers will show empty-state.
      })
    return () => {
      cancelled = true
    }
  }, [])

  const rescan = useCallback(async () => {
    setRescanning(true)
    try {
      const next = await window.electron.runtime.rescan()
      setResult(next)
    } finally {
      setRescanning(false)
    }
  }, [])

  const refreshModels = useCallback(async () => {
    setRefreshing(true)
    try {
      const { reports, detection } = await window.electron.runtime.refreshModels()
      setLastRefreshReports(reports)
      setResult(detection)
    } finally {
      setRefreshing(false)
    }
  }, [])

  const value = useMemo<RuntimeDetectionContextValue>(() => {
    const byId = indexById(result)
    const installed = AGENT_RUNTIMES
      .map(def => byId[def.id])
      .filter(r => r.installed)
    return {
      result,
      byId,
      installed,
      rescanning,
      rescan,
      refreshing,
      lastRefreshReports,
      refreshModels,
    }
  }, [result, rescanning, rescan, refreshing, lastRefreshReports, refreshModels])

  return (
    <RuntimeDetectionContext.Provider value={value}>
      {children}
    </RuntimeDetectionContext.Provider>
  )
}

export function useRuntimeDetection(): RuntimeDetectionContextValue {
  const ctx = useContext(RuntimeDetectionContext)
  if (!ctx) throw new Error('useRuntimeDetection must be used inside RuntimeDetectionProvider')
  return ctx
}

// Returns "installed runtimes ∪ {currentSelected}" in canonical AGENT_RUNTIMES
// order. Keeps a saved-but-not-installed selection visible (with a warning
// chip in the UI) instead of silently dropping it from the picker.
export function pickerRuntimes(
  byId: Record<AgentRuntime, DetectedRuntime>,
  currentSelectedId?: AgentRuntime,
): DetectedRuntime[] {
  return AGENT_RUNTIMES
    .map(def => byId[def.id])
    .filter(r => r.installed || r.id === currentSelectedId)
}

export function getRuntimeLabel(id: AgentRuntime): string {
  return AGENT_RUNTIME_MAP[id].label
}
