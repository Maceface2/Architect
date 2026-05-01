import { useState } from 'react'
import { AGENT_RUNTIMES, AGENT_RUNTIME_MAP, type AgentRuntime } from '../../../../shared/agentRuntimes'
import { INSTALL_COMMANDS } from '../../../../shared/runtimeDetection'
import { useRuntimeDetection } from '../../context/RuntimeDetectionContext'

// Inline empty-state shown by every runtime picker when no CLIs are
// detected on this machine. Lists install commands per CLI with copy
// buttons and a Rescan trigger that hits the same context method as
// SettingsPanel's Rescan button.
export function RuntimeEmptyState({ compact = false }: { compact?: boolean }) {
  const { rescan, rescanning } = useRuntimeDetection()
  return (
    <div className={`rounded-lg border border-amber-400/30 bg-amber-400/5 px-4 py-3 ${compact ? 'text-[11px]' : 'text-xs'}`}>
      <div className="text-amber-200 font-medium mb-2">No CLIs detected</div>
      <div className="text-fg-subtle leading-relaxed mb-3">
        Architect orchestrates agent CLIs. Install at least one to dispatch zones.
      </div>
      <div className="space-y-1.5 mb-3">
        {AGENT_RUNTIMES.map(def => (
          <RuntimeInstallRow key={def.id} runtimeId={def.id} />
        ))}
      </div>
      <div className="flex items-center justify-between">
        <button
          onClick={() => void rescan()}
          disabled={rescanning}
          className="px-2.5 py-1 rounded border border-white/10 text-fg-muted hover:text-fg hover:border-white/20 text-[11px] disabled:opacity-50"
        >
          {rescanning ? 'Rescanning…' : 'Rescan'}
        </button>
        <span className="text-[10px] text-fg-subtle">After installing, click Rescan or restart the app.</span>
      </div>
    </div>
  )
}

function RuntimeInstallRow({ runtimeId }: { runtimeId: AgentRuntime }) {
  const def = AGENT_RUNTIME_MAP[runtimeId]
  const cmds = INSTALL_COMMANDS[runtimeId]
  // Prefer brew on macOS users' first glance, then npm. Show only one to
  // keep the row scannable; the docs URL covers the rest.
  const primary = cmds.brew ?? cmds.npm ?? ''
  return (
    <div className="flex items-center gap-2">
      <span className="text-fg-muted w-24 shrink-0" style={{ color: def.accentColor }}>
        {def.label}
      </span>
      <code className="flex-1 truncate font-mono text-[10.5px] text-fg-subtle bg-black/30 rounded px-2 py-0.5">
        {primary}
      </code>
      <CopyButton text={primary} />
    </div>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      // Clipboard unavailable; the user can still select+copy by hand.
    }
  }
  return (
    <button
      onClick={onClick}
      className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-white/10 text-fg-subtle hover:text-fg hover:border-white/30"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}
