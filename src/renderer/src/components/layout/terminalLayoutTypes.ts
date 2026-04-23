export interface PaneNode {
  kind: 'pane'
  id: string
  tabs: string[]
  activeTab: string | null
}

export interface SplitNode {
  kind: 'split'
  id: string
  direction: 'row' | 'column'
  sizes: number[]
  children: LayoutNode[]
}

export type LayoutNode = PaneNode | SplitNode

export interface TerminalLayout {
  root: LayoutNode
  poppedOut: string[]
}

export type DropEdge = 'left' | 'right' | 'top' | 'bottom' | 'center'
