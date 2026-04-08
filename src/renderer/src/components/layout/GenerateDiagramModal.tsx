import { useState } from 'react'
import { Sparkles, Loader2, X } from 'lucide-react'

interface Props {
  onClose: () => void
  onGenerate: (description: string) => Promise<void>
}

export default function GenerateDiagramModal({ onClose, onGenerate }: Props) {
  const [description, setDescription] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async () => {
    if (!description.trim()) return
    setLoading(true)
    setError(null)
    try {
      await onGenerate(description.trim())
      onClose()
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-panel border border-node-border rounded-lg w-[480px] p-5 flex flex-col gap-4"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles size={14} className="text-[#3d3dbf]" />
            <span className="text-sm font-medium text-white">Generate Diagram with AI</span>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300 transition-colors">
            <X size={14} />
          </button>
        </div>

        <textarea
          autoFocus
          value={description}
          onChange={e => setDescription(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSubmit() }}
          placeholder="Describe your system… e.g. 'A web scraper pipeline with a fetcher, parser, and summarizer agent'"
          className="bg-canvas border border-node-border rounded p-3 text-sm text-slate-200 placeholder-slate-600 resize-none h-28 focus:outline-none focus:border-[#3d3dbf] transition-colors"
        />

        <p className="text-xs text-slate-600">Tip: Press ⌘↵ to generate</p>

        {error && <p className="text-xs text-red-400">{error}</p>}

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={loading || !description.trim()}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-accent rounded hover:bg-[#4a4ad0] disabled:opacity-40 disabled:pointer-events-none transition-colors"
          >
            {loading ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
            {loading ? 'Generating…' : 'Generate'}
          </button>
        </div>
      </div>
    </div>
  )
}
