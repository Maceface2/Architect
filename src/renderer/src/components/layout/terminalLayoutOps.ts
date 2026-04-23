import type { LayoutNode, PaneNode, SplitNode, TerminalLayout, DropEdge } from './terminalLayoutTypes'

let _idCounter = 0
function newId(prefix: string): string {
  _idCounter += 1
  return `${prefix}-${Date.now().toString(36)}-${_idCounter.toString(36)}`
}

export function emptyLayout(): TerminalLayout {
  return {
    root: { kind: 'pane', id: newId('pane'), tabs: [], activeTab: null },
    poppedOut: [],
  }
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

export function findPane(node: LayoutNode, paneId: string): PaneNode | null {
  if (node.kind === 'pane') return node.id === paneId ? node : null
  for (const child of node.children) {
    const hit = findPane(child, paneId)
    if (hit) return hit
  }
  return null
}

export function findPaneByTab(node: LayoutNode, tabId: string): PaneNode | null {
  if (node.kind === 'pane') return node.tabs.includes(tabId) ? node : null
  for (const child of node.children) {
    const hit = findPaneByTab(child, tabId)
    if (hit) return hit
  }
  return null
}

export function allTabIds(node: LayoutNode): string[] {
  if (node.kind === 'pane') return [...node.tabs]
  return node.children.flatMap(allTabIds)
}

export function allPanes(node: LayoutNode): PaneNode[] {
  if (node.kind === 'pane') return [node]
  return node.children.flatMap(allPanes)
}

export function firstPane(node: LayoutNode): PaneNode {
  if (node.kind === 'pane') return node
  return firstPane(node.children[0])
}

// Walks the tree replacing the node with given id using the supplied transform.
// If transform returns null, the node is removed (handled by caller via collapseEmpty).
function transformNode(
  node: LayoutNode,
  targetId: string,
  transform: (n: LayoutNode) => LayoutNode | null,
): LayoutNode | null {
  if (node.id === targetId) return transform(node)
  if (node.kind === 'pane') return node
  const newChildren: LayoutNode[] = []
  let changed = false
  for (const child of node.children) {
    const next = transformNode(child, targetId, transform)
    if (next === null) {
      changed = true
      continue
    }
    if (next !== child) changed = true
    newChildren.push(next)
  }
  if (!changed) return node
  return { ...node, children: newChildren, sizes: redistributeSizes(node.sizes, node.children.length, newChildren.length) }
}

function redistributeSizes(prev: number[], _prevLen: number, nextLen: number): number[] {
  if (nextLen === 0) return []
  const total = prev.reduce((a, b) => a + b, 0) || 100
  if (prev.length === nextLen) return prev
  // Even split when count changes
  return Array(nextLen).fill(total / nextLen)
}

// Remove empty panes from the tree, collapsing single-child splits up to their parents.
function collapseEmpty(node: LayoutNode): LayoutNode | null {
  if (node.kind === 'pane') return node.tabs.length === 0 ? null : node
  const kept: LayoutNode[] = []
  for (const child of node.children) {
    const collapsed = collapseEmpty(child)
    if (collapsed) kept.push(collapsed)
  }
  if (kept.length === 0) return null
  if (kept.length === 1) return kept[0]
  return { ...node, children: kept, sizes: redistributeSizes(node.sizes, node.children.length, kept.length) }
}

export function ensureRootPane(root: LayoutNode | null): LayoutNode {
  if (root) return root
  return { kind: 'pane', id: newId('pane'), tabs: [], activeTab: null }
}

export function addTabToPane(layout: TerminalLayout, paneId: string, tabId: string): TerminalLayout {
  const next = clone(layout)
  // Remove from any existing pane first
  removeTabInPlace(next.root, tabId)
  const pane = findPane(next.root, paneId)
  if (pane) {
    pane.tabs.push(tabId)
    pane.activeTab = tabId
  } else {
    firstPane(next.root).tabs.push(tabId)
    firstPane(next.root).activeTab = tabId
  }
  next.root = ensureRootPane(collapseEmpty(next.root))
  return next
}

function removeTabInPlace(node: LayoutNode, tabId: string): void {
  if (node.kind === 'pane') {
    const idx = node.tabs.indexOf(tabId)
    if (idx >= 0) {
      node.tabs.splice(idx, 1)
      if (node.activeTab === tabId) {
        node.activeTab = node.tabs[Math.min(idx, node.tabs.length - 1)] ?? null
      }
    }
    return
  }
  for (const child of node.children) removeTabInPlace(child, tabId)
}

export function removeTab(layout: TerminalLayout, tabId: string): TerminalLayout {
  const next = clone(layout)
  removeTabInPlace(next.root, tabId)
  next.root = ensureRootPane(collapseEmpty(next.root))
  return next
}

export function reorderTabs(
  layout: TerminalLayout,
  paneId: string,
  fromIdx: number,
  toIdx: number,
): TerminalLayout {
  const next = clone(layout)
  const pane = findPane(next.root, paneId)
  if (!pane) return layout
  if (fromIdx < 0 || fromIdx >= pane.tabs.length) return layout
  const [moved] = pane.tabs.splice(fromIdx, 1)
  const insert = Math.max(0, Math.min(toIdx, pane.tabs.length))
  pane.tabs.splice(insert, 0, moved)
  pane.activeTab = moved
  return next
}

export function setActiveTab(layout: TerminalLayout, paneId: string, tabId: string): TerminalLayout {
  const next = clone(layout)
  const pane = findPane(next.root, paneId)
  if (pane && pane.tabs.includes(tabId)) pane.activeTab = tabId
  return next
}

export function moveTabToPane(
  layout: TerminalLayout,
  tabId: string,
  targetPaneId: string,
  targetIdx?: number,
): TerminalLayout {
  const next = clone(layout)
  removeTabInPlace(next.root, tabId)
  const pane = findPane(next.root, targetPaneId)
  if (!pane) return layout
  const idx = targetIdx === undefined ? pane.tabs.length : Math.max(0, Math.min(targetIdx, pane.tabs.length))
  pane.tabs.splice(idx, 0, tabId)
  pane.activeTab = tabId
  next.root = ensureRootPane(collapseEmpty(next.root))
  return next
}

// Splits a pane by moving the given tab into a new sibling pane on the chosen edge.
export function splitPaneWithTab(
  layout: TerminalLayout,
  targetPaneId: string,
  tabId: string,
  edge: DropEdge,
): TerminalLayout {
  if (edge === 'center') return moveTabToPane(layout, tabId, targetPaneId)

  const next = clone(layout)
  const sourcePane = findPaneByTab(next.root, tabId)
  if (sourcePane && sourcePane.id === targetPaneId && sourcePane.tabs.length === 1) {
    // Trying to split a pane with its only tab — no-op.
    return layout
  }

  removeTabInPlace(next.root, tabId)

  const direction: 'row' | 'column' = edge === 'left' || edge === 'right' ? 'row' : 'column'
  const placeBefore = edge === 'left' || edge === 'top'

  next.root = ensureRootPane(transformNode(next.root, targetPaneId, (node) => {
    if (node.kind !== 'pane') return node
    const newPane: PaneNode = {
      kind: 'pane',
      id: newId('pane'),
      tabs: [tabId],
      activeTab: tabId,
    }
    const existing: PaneNode = { ...node }
    const split: SplitNode = {
      kind: 'split',
      id: newId('split'),
      direction,
      sizes: [50, 50],
      children: placeBefore ? [newPane, existing] : [existing, newPane],
    }
    return split
  }) ?? collapseEmpty(next.root))

  next.root = ensureRootPane(collapseEmpty(next.root))
  return next
}

export function setSplitSizes(layout: TerminalLayout, splitId: string, sizes: number[]): TerminalLayout {
  const next = clone(layout)
  const apply = (node: LayoutNode): void => {
    if (node.kind === 'split') {
      if (node.id === splitId && node.children.length === sizes.length) {
        node.sizes = sizes
      }
      node.children.forEach(apply)
    }
  }
  apply(next.root)
  return next
}

export function setPoppedOut(layout: TerminalLayout, tabId: string, popped: boolean): TerminalLayout {
  const next = clone(layout)
  const has = next.poppedOut.includes(tabId)
  if (popped && !has) next.poppedOut.push(tabId)
  if (!popped && has) next.poppedOut = next.poppedOut.filter(id => id !== tabId)
  return next
}

// Drops stale ids and appends new sessions to the first pane so the layout
// stays in sync with the actual list of running terminals.
export function migrateLayout(layout: TerminalLayout, currentSessionIds: string[]): TerminalLayout {
  const known = new Set(currentSessionIds)
  let next = clone(layout)

  // Drop tabs whose sessions are gone.
  for (const tabId of allTabIds(next.root)) {
    if (!known.has(tabId)) {
      removeTabInPlace(next.root, tabId)
    }
  }
  // Drop popped-out ids whose sessions are gone.
  next.poppedOut = next.poppedOut.filter(id => known.has(id))

  next.root = ensureRootPane(collapseEmpty(next.root))

  // Add any new sessions not yet in the layout (and not popped out).
  const present = new Set(allTabIds(next.root))
  const popped = new Set(next.poppedOut)
  const target = firstPane(next.root)
  for (const id of currentSessionIds) {
    if (!present.has(id) && !popped.has(id)) {
      target.tabs.push(id)
      if (!target.activeTab) target.activeTab = id
    }
  }

  return next
}
