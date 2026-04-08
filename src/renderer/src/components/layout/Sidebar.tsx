import { useState, useCallback } from 'react'
import { FolderOpen } from 'lucide-react'
import PaletteItem from '../palette/PaletteItem'
import { palette, categoryOrder, categoryLabels } from '../../data/componentPalette'
import type { PaletteItemConfig } from '../../data/componentPalette'

export default function Sidebar() {
  const [customItems, setCustomItems] = useState<PaletteItemConfig[]>([])
  const [importing, setImporting] = useState(false)

  const onImport = useCallback(async () => {
    setImporting(true)
    try {
      const dir = await window.electron.openDirectory()
      if (!dir) return
      const items = await window.electron.scanComponents(dir) as PaletteItemConfig[]
      if (items.length > 0) {
        setCustomItems(prev => {
          const existingIds = new Set(prev.map(i => i.id))
          return [...prev, ...items.filter(i => !existingIds.has(i.id))]
        })
      }
    } finally {
      setImporting(false)
    }
  }, [])

  return (
    <div className="flex flex-col bg-panel border-r border-node-border h-full overflow-y-auto py-2">
      {categoryOrder.map(category => (
        <div key={category} className="mb-2">
          <div className="px-3 pt-3 pb-1">
            <span className="text-[10px] font-semibold tracking-widest text-slate-500 uppercase">
              {categoryLabels[category]}
            </span>
          </div>
          {palette
            .filter(item => item.category === category)
            .map(item => (
              <PaletteItem key={item.id} item={item} />
            ))}
        </div>
      ))}

      {customItems.length > 0 && (
        <div className="mb-2">
          <div className="px-3 pt-3 pb-1">
            <span className="text-[10px] font-semibold tracking-widest text-slate-500 uppercase">
              {categoryLabels['custom']}
            </span>
          </div>
          {customItems.map(item => (
            <PaletteItem key={item.id} item={item} />
          ))}
        </div>
      )}

      <div className="px-2 pt-2 mt-auto border-t border-node-border">
        <button
          onClick={onImport}
          disabled={importing}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-[11px] text-slate-400 hover:text-slate-200 border border-node-border rounded hover:bg-node transition-colors disabled:opacity-40 disabled:pointer-events-none"
        >
          <FolderOpen size={11} />
          {importing ? 'Scanning…' : 'Import components'}
        </button>
      </div>
    </div>
  )
}
