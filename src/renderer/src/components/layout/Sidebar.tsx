import PaletteItem from '../palette/PaletteItem'
import { palette, categoryOrder, categoryLabels } from '../../data/componentPalette'

export default function Sidebar() {
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
    </div>
  )
}
