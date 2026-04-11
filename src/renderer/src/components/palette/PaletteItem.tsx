import type { PaletteItemConfig } from "../../data/componentPalette";
import { getIcon } from "../../lib/icons";
import type { ComponentCategory } from "../../types";

interface PaletteItemProps {
  item: PaletteItemConfig;
}

export default function PaletteItem({ item }: PaletteItemProps) {
  const Icon = getIcon(item.iconName);

  const onDragStart = (e: React.DragEvent<HTMLDivElement>) => {
    e.dataTransfer.setData("application/architect-node", JSON.stringify(item));
    e.dataTransfer.effectAllowed = "move";
  };

  return (
    <div
      draggable
      onDragStart={onDragStart}
      className="flex items-center gap-2.5 px-3 py-2 text-sm text-slate-300 cursor-grab hover:bg-node rounded-md transition-colors select-none active:cursor-grabbing"
    >
      <Icon size={15} className={categoryIconColor(item.category)} />
      <span>{item.label}</span>
    </div>
  );
}

function categoryIconColor(category: ComponentCategory): string {
  switch (category) {
    case "infrastructure":
      return "text-blue-400";
    case "services":
      return "text-purple-400";
    case "storage":
      return "text-emerald-400";
  }
}
