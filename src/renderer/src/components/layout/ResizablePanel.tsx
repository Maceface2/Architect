import { useState, useCallback } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

interface ResizablePanelProps {
  side: "left" | "right";
  defaultWidth: number;
  minWidth?: number;
  maxWidth?: number;
  children: React.ReactNode;
}

export default function ResizablePanel({
  side,
  defaultWidth,
  minWidth = 120,
  maxWidth = 480,
  children,
}: ResizablePanelProps) {
  const [width, setWidth] = useState(defaultWidth);
  const [collapsed, setCollapsed] = useState(false);
  const isLeft = side === "left";

  const onDragStart = useCallback(
    (e: React.MouseEvent) => {
      if (collapsed) return;
      e.preventDefault();
      const startX = e.clientX;
      const startW = width;

      const onMove = (ev: MouseEvent) => {
        const delta = isLeft ? ev.clientX - startX : startX - ev.clientX;
        setWidth(Math.max(minWidth, Math.min(maxWidth, startW + delta)));
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [collapsed, width, isLeft, minWidth, maxWidth],
  );

  const CollapseIcon = collapsed
    ? isLeft
      ? ChevronRight
      : ChevronLeft
    : isLeft
      ? ChevronLeft
      : ChevronRight;

  const handle = (
    <div
      className={`relative w-2 flex-shrink-0 flex items-center justify-center group select-none ${
        collapsed ? "cursor-default" : "cursor-col-resize"
      }`}
      onMouseDown={onDragStart}
    >
      {/* Divider line */}
      <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-node-border group-hover:bg-[#5b5bf0]/50 transition-colors" />

      {/* Collapse toggle — visible on hover */}
      <button
        className="relative z-10 w-[18px] h-6 flex items-center justify-center rounded-sm bg-panel border border-node-border text-slate-500 hover:text-white hover:border-[#5b5bf0] transition-all opacity-0 group-hover:opacity-100 flex-shrink-0"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => setCollapsed((c) => !c)}
        title={collapsed ? "Expand" : "Collapse"}
      >
        <CollapseIcon size={9} />
      </button>
    </div>
  );

  const content = (
    <div
      className="flex-shrink-0 overflow-hidden"
      style={{ width: collapsed ? 0 : width }}
    >
      {children}
    </div>
  );

  return isLeft ? (
    <>
      {content}
      {handle}
    </>
  ) : (
    <>
      {handle}
      {content}
    </>
  );
}
