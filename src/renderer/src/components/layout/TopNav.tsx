import { Zap, Loader2, FolderOpen, Save, Bot } from 'lucide-react'

interface TopNavProps {
  activeTab: string
  onTabChange: (tab: string) => void
  onClear: () => void
  onLoadDemo: () => void
  onDispatch: () => void
  dispatching: boolean
  nodeCount: number
  projectDir: string
  onChangeDir: () => void
  onSave: () => void
  isDirty: boolean
  onAssistantToggle: () => void
  assistantOpen: boolean
  isRedispatch: boolean
  changedCount: number
}

const TABS = ['Canvas', 'Files', 'Terminal', 'Preview']

function ArchitectLogo() {
  return (
    <svg width="20" height="20" viewBox="0 0 400 400" fill="none" xmlns="http://www.w3.org/2000/svg">
      <line x1="40"  y1="360" x2="360" y2="40"  stroke="#58A6FF" strokeWidth="14" strokeLinecap="round"/>
      <line x1="40"  y1="360" x2="200" y2="360" stroke="#58A6FF" strokeWidth="14" strokeLinecap="round"/>
      <line x1="200" y1="360" x2="360" y2="40"  stroke="#58A6FF" strokeWidth="14" strokeLinecap="round"/>
      <circle cx="40"  cy="360" r="14" fill="#58A6FF"/>
      <circle cx="200" cy="360" r="14" fill="#58A6FF"/>
      <circle cx="360" cy="40"  r="14" fill="#58A6FF"/>
    </svg>
  )
}

export default function TopNav({
  activeTab, onTabChange, onClear, onLoadDemo,
  onDispatch, dispatching, nodeCount,
  projectDir, onChangeDir, onSave, isDirty,
  onAssistantToggle, assistantOpen, isRedispatch, changedCount,
}: TopNavProps) {
  const dirName = projectDir.split('/').filter(Boolean).pop() ?? projectDir

  return (
    <div className="flex items-center justify-between h-11 px-4 bg-panel border-b border-node-border flex-shrink-0">
      <div className="flex items-center gap-4">
        {/* Logo */}
        <div className="flex items-center gap-2 select-none">
          <ArchitectLogo />
          <span className="text-sm font-semibold text-white tracking-tight">architect</span>
        </div>

        {/* Project dir badge */}
        <button
          onClick={onChangeDir}
          className="flex items-center gap-1.5 px-2 py-1 rounded text-xs text-slate-400 hover:text-slate-200 hover:bg-white/[0.05] border border-white/[0.06] transition-colors max-w-[200px]"
          title={projectDir}
        >
          <FolderOpen size={11} className="text-amber-400 flex-shrink-0" />
          <span className="truncate font-mono">{dirName}</span>
        </button>

        {/* Tabs */}
        <div className="flex items-center gap-0.5">
          {TABS.map(tab => (
            <button
              key={tab}
              onClick={() => onTabChange(tab)}
              className={`px-3 py-1.5 text-sm rounded transition-colors ${
                activeTab === tab
                  ? 'text-white bg-node'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-node/50'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-xs text-slate-600 mr-1">v0.1.0</span>
        <button
          onClick={onSave}
          className="relative flex items-center gap-1.5 px-3 py-1.5 text-xs text-slate-300 border border-node-border rounded hover:bg-node transition-colors"
          title="Save canvas"
        >
          <Save size={12} />
          Save
          {isDirty && (
            <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-amber-400" />
          )}
        </button>
        <button
          onClick={onAssistantToggle}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border transition-colors ${
            assistantOpen
              ? 'text-[#c084fc] border-[#c084fc]/40 bg-[#c084fc]/10 hover:bg-[#c084fc]/20'
              : 'text-slate-300 border-node-border hover:bg-node'
          }`}
          title="Architecture assistant"
        >
          <Bot size={12} />
          Assistant
        </button>
        <button onClick={onClear} className="px-3 py-1.5 text-xs text-slate-300 border border-node-border rounded hover:bg-node transition-colors">
          Clear
        </button>
        <button onClick={onLoadDemo} className="px-3 py-1.5 text-xs text-slate-300 border border-node-border rounded hover:bg-node transition-colors">
          Load demo
        </button>
        <button
          onClick={onDispatch}
          disabled={dispatching || nodeCount === 0}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-accent rounded hover:bg-[#4a4ad0] transition-colors disabled:opacity-40 disabled:pointer-events-none"
        >
          {dispatching ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
          {dispatching
            ? 'Launching…'
            : isRedispatch
              ? `Redispatch${changedCount > 0 ? ` (${changedCount} changed)` : ''}`
              : `Dispatch${nodeCount > 0 ? ` (${nodeCount})` : ''}`
          }
        </button>
      </div>
    </div>
  )
}
