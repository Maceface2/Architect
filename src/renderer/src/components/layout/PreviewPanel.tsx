import { useEffect, useRef, useState } from 'react'
import { Activity, ExternalLink } from 'lucide-react'
import { getAgentRuntime } from '../../../../shared/agentRuntimes'
import type { ZoneNodeType } from '../../types'

interface Props {
  zones: ZoneNodeType[]
  projectDir: string
}

const POLL_INTERVAL = 2000
const MAX_TAIL_LINES = 20
const URL_RE = /(https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/[^\s]*)?)/

function sanitize(label: string): string {
  return label.replace(/[^a-zA-Z0-9_-]+/g, '_')
}

function tail(content: string, n: number): string {
  const lines = content.split('\n')
  return lines.slice(-n).join('\n')
}

function extractUrl(content: string): string | null {
  const m = content.match(URL_RE)
  return m ? m[1] : null
}

export default function PreviewPanel({ zones, projectDir }: Props) {
  const [contents, setContents] = useState<Record<string, string>>({})
  const [iframeOpen, setIframeOpen] = useState<Record<string, boolean>>({})
  const [activeZoneId, setActiveZoneId] = useState<string | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    if (!projectDir || zones.length === 0) return
    let cancelled = false

    const poll = async () => {
      const next: Record<string, string> = {}
      for (const zone of zones) {
        const filePath = `${projectDir}/ARCHITECT/outputs/${sanitize(zone.data.label)}.md`
        const content = await window.electron.readFile(filePath)
        if (cancelled) return
        if (content) next[zone.id] = content
      }
      if (!cancelled) setContents(next)
    }

    poll()
    const id = setInterval(poll, POLL_INTERVAL)
    return () => { cancelled = true; clearInterval(id) }
  }, [projectDir, zones.map(z => `${z.id}:${z.data.label}`).join('|')])

  useEffect(() => {
    if (zones.length === 0) { setActiveZoneId(null); return }
    if (!activeZoneId || !zones.find(z => z.id === activeZoneId)) {
      setActiveZoneId(zones[0].id)
    }
  }, [zones.map(z => z.id).join('|')])

  if (zones.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 bg-[#0d0d0d]">
        <p className="text-xs text-slate-600">No zones to preview.</p>
        <p className="text-xs text-slate-700">Create a zone on the canvas, then Dispatch.</p>
      </div>
    )
  }

  const activeZone = zones.find(z => z.id === activeZoneId) ?? zones[0]
  const activeContent = contents[activeZone.id] ?? ''
  const activeUrl = extractUrl(activeContent)
  const runtime = getAgentRuntime(activeZone.data.agentRuntime)
  const showIframe = iframeOpen[activeZone.id] ?? false

  return (
    <div className="flex flex-col h-full bg-[#0d0d0d]">
      {/* Zone tab strip */}
      <div className="flex items-center gap-0 border-b border-white/[0.06] flex-shrink-0 overflow-x-auto">
        {zones.map(zone => {
          const isActive = zone.id === activeZone.id
          const zoneRuntime = getAgentRuntime(zone.data.agentRuntime)
          return (
            <button
              key={zone.id}
              onClick={() => setActiveZoneId(zone.id)}
              className={`flex items-center gap-2 px-4 py-2 text-xs whitespace-nowrap border-b-2 transition-colors flex-shrink-0 ${
                isActive
                  ? 'border-[#58A6FF] text-white bg-white/[0.04]'
                  : 'border-transparent text-slate-500 hover:text-slate-300 hover:bg-white/[0.02]'
              }`}
            >
              <span
                className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                style={{ background: zone.data.color || '#58A6FF' }}
              />
              <span>{zone.data.label || 'Zone'}</span>
              <span
                className="px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider"
                style={{ color: zoneRuntime.accentColor, backgroundColor: `${zoneRuntime.accentColor}20` }}
              >
                {zoneRuntime.shortLabel}
              </span>
            </button>
          )
        })}
      </div>

      {/* Active zone body */}
      <div className="flex-1 overflow-y-auto">
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
          <div className="flex items-center gap-2">
            <Activity size={12} className="text-[#58A6FF]" />
            <span className="text-xs text-slate-400">Last {MAX_TAIL_LINES} lines of status log</span>
            <span
              className="px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider"
              style={{ color: runtime.accentColor, backgroundColor: `${runtime.accentColor}20` }}
            >
              {runtime.label}
            </span>
          </div>
          {activeUrl && (
            <button
              onClick={() =>
                setIframeOpen(prev => ({ ...prev, [activeZone.id]: !prev[activeZone.id] }))
              }
              className="flex items-center gap-1.5 text-[11px] text-slate-400 hover:text-slate-200 transition-colors"
            >
              <ExternalLink size={11} />
              {showIframe ? 'Hide preview' : 'Show preview'}
            </button>
          )}
        </div>

        <pre className="text-[11px] text-slate-300 font-mono whitespace-pre-wrap leading-relaxed break-words px-4 py-3">
          {activeContent
            ? tail(activeContent, MAX_TAIL_LINES)
            : <span className="text-slate-700 italic">Waiting for output…</span>
          }
        </pre>

        {activeUrl && showIframe && (
          <div className="mx-4 mb-4 border border-white/[0.06] rounded overflow-hidden" style={{ height: 420 }}>
            <div className="flex items-center gap-2 px-3 py-1.5 border-b border-white/[0.06] bg-[#111111]">
              <span className="text-[10px] text-slate-500 font-mono truncate">{activeUrl}</span>
            </div>
            <iframe
              src={activeUrl}
              title={`${activeZone.data.label} preview`}
              className="w-full h-[calc(100%-28px)] bg-white"
              sandbox="allow-scripts allow-same-origin allow-forms"
            />
          </div>
        )}
      </div>
    </div>
  )
}
