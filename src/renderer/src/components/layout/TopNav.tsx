import { Zap } from 'lucide-react'

interface TopNavProps {
  activeTab: string
  onTabChange: (tab: string) => void
  onClear: () => void
  onLoadDemo: () => void
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

export default function TopNav({ activeTab, onTabChange, onClear, onLoadDemo }: TopNavProps) {
  return (
    <div className="flex items-center justify-between h-11 px-4 bg-panel border-b border-node-border flex-shrink-0">
      <div className="flex items-center gap-6">
        <div className="flex items-center gap-2 select-none">
          <ArchitectLogo />
          <span className="text-sm font-semibold text-white tracking-tight">architect</span>
        </div>
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
        <span className="text-xs text-slate-500 mr-1">v0.1.0</span>
        <button
          onClick={onClear}
          className="px-3 py-1.5 text-xs text-slate-300 border border-node-border rounded hover:bg-node transition-colors"
        >
          Clear
        </button>
        <button
          onClick={onLoadDemo}
          className="px-3 py-1.5 text-xs text-slate-300 border border-node-border rounded hover:bg-node transition-colors"
        >
          Load demo
        </button>
        <button className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-accent rounded hover:bg-[#4a4ad0] transition-colors">
          <Zap size={12} />
          Dispatch agents
        </button>
      </div>
    </div>
  )
}
