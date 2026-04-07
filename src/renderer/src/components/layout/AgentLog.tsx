import { ScrollText } from 'lucide-react'

export default function AgentLog() {
  return (
    <div className="flex flex-col bg-panel border-l border-node-border h-full">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-node-border">
        <div className="w-1.5 h-1.5 rounded-full bg-slate-600" />
        <span className="text-sm text-slate-300 font-medium">Agent log</span>
      </div>
      <div className="flex-1 flex flex-col items-center justify-center p-6 gap-3">
        <ScrollText size={24} className="text-slate-700" />
        <div className="text-center">
          <p className="text-xs text-slate-500">No agents running yet.</p>
          <p className="text-xs text-slate-600 mt-0.5">Dispatch to start building.</p>
        </div>
      </div>
    </div>
  )
}
