import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'

// v2 workspace schema. Replaces the legacy { folders: [{path}] } shape with
// a per-folder list of pages. Each page is an independent canvas with its
// own outgoing links to pages in other folders. Mutual links (A1<->B2) are
// stored on both sides so each folder resolves standalone.

const ARCHITECT_DIRNAME = 'ARCHITECT'
const WORKSPACE_FILENAME = 'workspace.json'
const PAGES_SUBDIR = 'pages'
const LEGACY_CANVAS_FILENAME = 'architect-canvas.json'
const WORKSPACE_SCHEMA_VERSION = 2 as const
const DEFAULT_PAGE_NAME = 'Default'

export interface PageLink {
  folderPath: string
  pageId: string
}

export interface WorkspacePage {
  id: string
  name: string
  createdAt: string
  links: PageLink[]
}

export interface WorkspaceFileV2 {
  schemaVersion: typeof WORKSPACE_SCHEMA_VERSION
  pages: WorkspacePage[]
  activePageId: string
}

// What the renderer receives. The host folder is implicit (whichever path
// was passed to loadWorkspace), so we don't echo it back on the wire.
export interface LoadedWorkspace {
  pages: WorkspacePage[]
  activePageId: string
}

interface LegacyWorkspaceFile {
  folders?: Array<{ path?: unknown }>
}

function architectDir(hostDir: string): string {
  return path.join(hostDir, ARCHITECT_DIRNAME)
}

function workspaceFile(hostDir: string): string {
  return path.join(architectDir(hostDir), WORKSPACE_FILENAME)
}

function pagesDir(hostDir: string): string {
  return path.join(architectDir(hostDir), PAGES_SUBDIR)
}

export function pageFile(hostDir: string, pageId: string): string {
  return path.join(pagesDir(hostDir), `${pageId}.json`)
}

function legacyCanvasFile(hostDir: string): string {
  return path.join(hostDir, LEGACY_CANVAS_FILENAME)
}

function writeFileAtomic(target: string, contents: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, contents, 'utf-8')
  fs.renameSync(tmp, target)
}

function readJsonOrNull(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch {
    return null
  }
}

function isV2(value: unknown): value is WorkspaceFileV2 {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    v.schemaVersion === WORKSPACE_SCHEMA_VERSION &&
    Array.isArray(v.pages) &&
    typeof v.activePageId === 'string'
  )
}

function normalizePage(value: unknown): WorkspacePage | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.id !== 'string' || !v.id) return null
  const name = typeof v.name === 'string' && v.name ? v.name : DEFAULT_PAGE_NAME
  const createdAt =
    typeof v.createdAt === 'string' ? v.createdAt : new Date().toISOString()
  const links: PageLink[] = Array.isArray(v.links)
    ? v.links
        .map(l => {
          if (!l || typeof l !== 'object') return null
          const lr = l as Record<string, unknown>
          if (typeof lr.folderPath !== 'string' || !lr.folderPath) return null
          if (typeof lr.pageId !== 'string' || !lr.pageId) return null
          return { folderPath: lr.folderPath, pageId: lr.pageId }
        })
        .filter((l): l is PageLink => l !== null)
    : []
  return { id: v.id, name, createdAt, links }
}

function normalizeV2(value: WorkspaceFileV2): WorkspaceFileV2 {
  const pages = (value.pages
    .map(normalizePage)
    .filter((p): p is WorkspacePage => p !== null))
  if (pages.length === 0) {
    const p = createDefaultPage()
    pages.push(p)
  }
  const activePageId =
    pages.find(p => p.id === value.activePageId)?.id ?? pages[0].id
  return { schemaVersion: WORKSPACE_SCHEMA_VERSION, pages, activePageId }
}

function createDefaultPage(name: string = DEFAULT_PAGE_NAME): WorkspacePage {
  return {
    id: randomUUID(),
    name,
    createdAt: new Date().toISOString(),
    links: [],
  }
}

function emptyCanvasJson(): string {
  return JSON.stringify(
    { nodes: [], edges: [], settings: {}, savedAt: new Date().toISOString() },
    null,
    2,
  )
}

// Ensure a v2 workspace.json exists in `folderDir`. If a legacy
// architect-canvas.json is present, its contents are copied into the new
// default page's file. Returns the resulting v2 file. Idempotent.
function bootstrapV2(folderDir: string): WorkspaceFileV2 {
  const existing = readJsonOrNull(workspaceFile(folderDir))
  if (isV2(existing)) return normalizeV2(existing as WorkspaceFileV2)

  // Reuse the same legacy file path if migration already half-ran (e.g. the
  // user opened the folder, migration wrote new files, but the legacy file
  // didn't get marked). We just rebuild from whatever exists.
  const legacy = (existing as LegacyWorkspaceFile | null) ?? null
  const defaultPage = createDefaultPage()
  const next: WorkspaceFileV2 = {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    pages: [defaultPage],
    activePageId: defaultPage.id,
  }

  // Copy or initialize the page file.
  const target = pageFile(folderDir, defaultPage.id)
  let legacyCanvasRaw: string | null = null
  try {
    legacyCanvasRaw = fs.readFileSync(legacyCanvasFile(folderDir), 'utf-8')
  } catch {}
  writeFileAtomic(target, legacyCanvasRaw ?? emptyCanvasJson())

  writeFileAtomic(workspaceFile(folderDir), JSON.stringify(next, null, 2))

  // Mark legacy canvas as migrated (one-release rollback path) when it
  // existed and could be parsed as JSON. Skipping the mark on parse error
  // avoids overwriting a corrupted file.
  if (legacyCanvasRaw !== null) {
    try {
      const parsed = JSON.parse(legacyCanvasRaw) as Record<string, unknown>
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        parsed._migratedAt = new Date().toISOString()
        writeFileAtomic(
          legacyCanvasFile(folderDir),
          JSON.stringify(parsed, null, 2),
        )
      }
    } catch {}
  }

  // If a legacy workspace.json existed with extras, wire reverse links now.
  if (legacy && Array.isArray(legacy.folders)) {
    for (const f of legacy.folders) {
      const otherPath = typeof f?.path === 'string' ? f.path : null
      if (!otherPath || otherPath === folderDir) continue
      try {
        ensureLink(folderDir, defaultPage.id, otherPath)
      } catch {}
    }
  }

  return next
}

// Add mutual links between hostDir/hostPageId and otherDir/(picked or new).
// If otherPageId is undefined, pick the other folder's active page (or
// create a default if needed). Idempotent: re-adding an existing link is a
// no-op.
export function ensureLink(
  hostDir: string,
  hostPageId: string,
  otherDir: string,
  otherPageId?: string,
): { hostPageId: string; otherPageId: string } {
  if (hostDir === otherDir) {
    throw new Error('cannot link a folder to itself')
  }

  const otherWs = bootstrapV2(otherDir)
  const pickedOtherId =
    otherPageId && otherWs.pages.some(p => p.id === otherPageId)
      ? otherPageId
      : otherWs.activePageId

  const hostWs = bootstrapV2(hostDir)
  const hostPage = hostWs.pages.find(p => p.id === hostPageId)
  if (!hostPage) throw new Error(`unknown host page: ${hostPageId}`)
  if (!hostPage.links.some(l => l.folderPath === otherDir && l.pageId === pickedOtherId)) {
    hostPage.links.push({ folderPath: otherDir, pageId: pickedOtherId })
    writeFileAtomic(workspaceFile(hostDir), JSON.stringify(hostWs, null, 2))
  }

  const otherPage = otherWs.pages.find(p => p.id === pickedOtherId)
  if (otherPage) {
    if (!otherPage.links.some(l => l.folderPath === hostDir && l.pageId === hostPageId)) {
      otherPage.links.push({ folderPath: hostDir, pageId: hostPageId })
      writeFileAtomic(workspaceFile(otherDir), JSON.stringify(otherWs, null, 2))
    }
  }

  return { hostPageId, otherPageId: pickedOtherId }
}

export function removeLink(
  hostDir: string,
  hostPageId: string,
  otherDir: string,
  otherPageId?: string,
): void {
  const hostWs = readWorkspaceOrNull(hostDir)
  if (hostWs) {
    const page = hostWs.pages.find(p => p.id === hostPageId)
    if (page) {
      const before = page.links.length
      page.links = page.links.filter(
        l =>
          !(l.folderPath === otherDir &&
            (otherPageId === undefined || l.pageId === otherPageId)),
      )
      if (page.links.length !== before) {
        writeFileAtomic(workspaceFile(hostDir), JSON.stringify(hostWs, null, 2))
      }
    }
  }
  const otherWs = readWorkspaceOrNull(otherDir)
  if (otherWs) {
    let changed = false
    for (const p of otherWs.pages) {
      if (otherPageId !== undefined && p.id !== otherPageId) continue
      const before = p.links.length
      p.links = p.links.filter(
        l => !(l.folderPath === hostDir && l.pageId === hostPageId),
      )
      if (p.links.length !== before) changed = true
    }
    if (changed) {
      writeFileAtomic(workspaceFile(otherDir), JSON.stringify(otherWs, null, 2))
    }
  }
}

function readWorkspaceOrNull(hostDir: string): WorkspaceFileV2 | null {
  const raw = readJsonOrNull(workspaceFile(hostDir))
  if (!isV2(raw)) return null
  return normalizeV2(raw)
}

// Public entry point used by the workspace:load IPC. Returns a v2 workspace
// for the host folder, running migration on the first read.
export function loadWorkspace(hostDir: string): LoadedWorkspace {
  const ws = bootstrapV2(hostDir)
  return { pages: ws.pages, activePageId: ws.activePageId }
}

export function saveWorkspace(hostDir: string, file: LoadedWorkspace): void {
  const normalized = normalizeV2({
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    pages: file.pages,
    activePageId: file.activePageId,
  })
  writeFileAtomic(workspaceFile(hostDir), JSON.stringify(normalized, null, 2))
}

export function setActivePage(hostDir: string, pageId: string): void {
  const ws = readWorkspaceOrNull(hostDir) ?? bootstrapV2(hostDir)
  if (!ws.pages.some(p => p.id === pageId)) {
    throw new Error(`unknown page: ${pageId}`)
  }
  if (ws.activePageId !== pageId) {
    ws.activePageId = pageId
    writeFileAtomic(workspaceFile(hostDir), JSON.stringify(ws, null, 2))
  }
}

export function createPage(hostDir: string, name?: string): WorkspacePage {
  const ws = readWorkspaceOrNull(hostDir) ?? bootstrapV2(hostDir)
  const page = createDefaultPage(name && name.trim() ? name.trim() : 'Untitled')
  ws.pages.push(page)
  ws.activePageId = page.id
  writeFileAtomic(pageFile(hostDir, page.id), emptyCanvasJson())
  writeFileAtomic(workspaceFile(hostDir), JSON.stringify(ws, null, 2))
  return page
}

export function renamePage(hostDir: string, pageId: string, name: string): void {
  const ws = readWorkspaceOrNull(hostDir) ?? bootstrapV2(hostDir)
  const page = ws.pages.find(p => p.id === pageId)
  if (!page) throw new Error(`unknown page: ${pageId}`)
  const trimmed = name.trim()
  if (!trimmed) return
  page.name = trimmed
  writeFileAtomic(workspaceFile(hostDir), JSON.stringify(ws, null, 2))
}

// Delete a page from this host folder. Removes its canvas file, prunes
// reverse links from every linked folder's pages, and auto-creates a fresh
// page when the host would otherwise be left with zero pages.
export function deletePage(hostDir: string, pageId: string): WorkspaceFileV2 {
  const ws = readWorkspaceOrNull(hostDir) ?? bootstrapV2(hostDir)
  const page = ws.pages.find(p => p.id === pageId)
  if (!page) throw new Error(`unknown page: ${pageId}`)

  for (const link of page.links) {
    try {
      const otherWs = readWorkspaceOrNull(link.folderPath)
      if (!otherWs) continue
      let changed = false
      for (const other of otherWs.pages) {
        const before = other.links.length
        other.links = other.links.filter(
          l => !(l.folderPath === hostDir && l.pageId === pageId),
        )
        if (other.links.length !== before) changed = true
      }
      if (changed) {
        writeFileAtomic(
          workspaceFile(link.folderPath),
          JSON.stringify(otherWs, null, 2),
        )
      }
    } catch {}
  }

  try { fs.unlinkSync(pageFile(hostDir, pageId)) } catch {}

  ws.pages = ws.pages.filter(p => p.id !== pageId)
  if (ws.pages.length === 0) {
    const fresh = createDefaultPage()
    ws.pages.push(fresh)
    writeFileAtomic(pageFile(hostDir, fresh.id), emptyCanvasJson())
    ws.activePageId = fresh.id
  } else if (ws.activePageId === pageId) {
    ws.activePageId = ws.pages[0].id
  }
  writeFileAtomic(workspaceFile(hostDir), JSON.stringify(ws, null, 2))
  return ws
}

// Used by the renderer's "Add Folder" link prompt to enumerate candidate
// pages in the folder the user just picked. Bootstraps the folder's
// workspace.json on demand so a brand-new folder still shows a single
// "Default" option in the picker.
export function listPagesInFolder(folderDir: string): WorkspacePage[] {
  const ws = bootstrapV2(folderDir)
  return ws.pages
}

// Per-page canvas IO. Used by the loadCanvas / saveCanvas IPC after they
// were rewritten to take (folderPath, pageId).
export function loadPageCanvas(hostDir: string, pageId: string): string | null {
  try {
    return fs.readFileSync(pageFile(hostDir, pageId), 'utf-8')
  } catch {
    return null
  }
}

export function savePageCanvas(
  hostDir: string,
  pageId: string,
  raw: string,
): void {
  writeFileAtomic(pageFile(hostDir, pageId), raw)
}

export { WORKSPACE_SCHEMA_VERSION, ARCHITECT_DIRNAME, PAGES_SUBDIR }
