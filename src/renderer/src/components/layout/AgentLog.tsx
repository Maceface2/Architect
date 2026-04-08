import { useEffect, useRef, useState } from 'react'
import { join } from 'path'

interface OutputFile {
  name: string
  content: string
  mtime: number
}

interface Props {
  projectDir: string
}

const POLL_INTERVAL = 2000

export default function AgentLog({ projectDir }: Props) {
  const [files, setFiles]       = useState<OutputFile[]>([])
  const [active, setActive]     = useState<string | null>(null)
  const [running, setRunning]   = useState(false)
  const bottomRef               = useRef<HTMLDivElement>(null)
  const prevMtimes              = useRef<Record<string, number>>({})

  const outputsDir = `${projectDir}/ARCHITECT/outputs`

  // Poll every 2s
  useEffect(() => {
    let cancelled = false

    const poll = async () => {
      const result: OutputFile[] = await window.electron.readOutputs(outputsDir)
      if (cancelled) return

      if (result.length > 0) {
        setRunning(true)
        setFiles(result)

        // Auto-select first file if nothing selected
        setActive(prev => prev ?? result[0].name)

        // Detect if any file was updated — auto-scroll if so
        const anyUpdated = result.some(f => {
          const prev = prevMtimes.current[f.name]
          return prev === undefined || f.mtime > prev
        })
        result.forEach(f => { prevMtimes.current[f.name] = f.mtime })

        if (anyUpdated) {
          setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
        }
      } else {
        setRunning(false)
      }
    }

    poll()
    const id = setInterval(poll, POLL_INTERVAL)
    return () => { cancelled = true; clearInterval(id) }
  }, [outputsDir])

  const activeFile = files.find(f => f.name === active)

  if (!running) {
    return (
      <div className="flex flex-col bg-panel border-l border-node-border h-full">
        <Header />
        <div className="flex-1 flex flex-col items-center justify-center gap-2 p-4">
          <p className="text-xs text-slate-600 text-center">No agents running yet.</p>
          <p className="text-xs text-slate-700 text-center">Dispatch to start building.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col bg-panel border-l border-node-border h-full">
      <Header />

      {/* Agent tabs */}
      <div className="flex overflow-x-auto border-b border-node-border flex-shrink-0">
        {files.map(f => (
          <button
            key={f.name}
            onClick={() => setActive(f.name)}
            className={`px-3 py-1.5 text-[11px] whitespace-nowrap flex-shrink-0 border-b-2 transition-colors ${
              active === f.name
                ? 'border-[#58A6FF] text-white'
                : 'border-transparent text-slate-600 hover:text-slate-400'
            }`}
          >
            {f.name === 'Architect' ? '⬡ Architect' : f.name}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-3">
        {activeFile ? (
          <>
            <pre className="text-[11px] text-slate-300 font-mono whitespace-pre-wrap leading-relaxed break-words">
              {activeFile.content || <span className="text-slate-700 italic">Waiting for output…</span>}
            </pre>
            <div ref={bottomRef} />
          </>
        ) : (
          <p className="text-xs text-slate-700 italic">Empty</p>
        )}
      </div>
    </div>
  )
}

function Header() {
  return (
    <div className="flex items-center gap-2 px-4 py-3 border-b border-node-border flex-shrink-0">
      <div className="w-1.5 h-1.5 rounded-full bg-[#58A6FF] animate-pulse" />
      <span className="text-sm text-slate-300 font-medium">Agent log</span>
    </div>
  )
}
