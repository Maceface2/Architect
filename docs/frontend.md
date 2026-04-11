# Architect — Frontend Documentation

Phase 1 of Architect: a visual architecture canvas built as an Electron desktop app. Users design system architectures by dragging component nodes onto a canvas, connecting them with edges, and writing per-node agent prompts that will later drive Claude AI agents.

---

## Tech Stack

| Layer         | Technology                           |
| ------------- | ------------------------------------ |
| Desktop shell | Electron (main + preload + renderer) |
| Bundler       | electron-vite                        |
| UI framework  | React 18 + TypeScript                |
| Canvas        | `@xyflow/react` v12                  |
| Styling       | Tailwind CSS v3 + PostCSS            |
| Icons         | Lucide React                         |

---

## Project Structure

```
src/
├── main/
│   └── index.ts              # Electron main process
├── preload/
│   └── index.ts              # Electron preload — contextBridge
└── renderer/
    ├── index.html
    └── src/
        ├── main.tsx           # React entry point
        ├── App.tsx            # Root component + canvas orchestrator
        ├── index.css          # Tailwind + React Flow overrides
        ├── env.d.ts           # window.electron global type declaration
        ├── types.ts           # Shared TypeScript types
        ├── lib/
        │   └── icons.ts       # Lucide icon registry
        ├── data/
        │   └── componentPalette.ts  # Palette item definitions
        └── components/
            ├── layout/
            │   ├── TopNav.tsx        # Header bar with tabs + actions
            │   ├── Sidebar.tsx       # Left component palette panel
            │   ├── AgentLog.tsx      # Right agent output panel
            │   ├── FilesPanel.tsx    # File browser (Files tab)
            │   └── ResizablePanel.tsx  # Resizable + collapsible panel wrapper
            ├── palette/
            │   └── PaletteItem.tsx   # Draggable item in the sidebar
            └── nodes/
                ├── ArchitectNode.tsx  # Custom React Flow node component
                └── nodeTypes.ts      # React Flow nodeTypes registry
```

---

## Electron Process Architecture

### Main Process — `src/main/index.ts`

Creates the `BrowserWindow` (1440×900, `backgroundColor: '#111111'`, `contextIsolation: true`) and registers three IPC handlers:

| Channel          | Handler                 | Returns                                                        |
| ---------------- | ----------------------- | -------------------------------------------------------------- |
| `get-home-dir`   | `app.getPath('home')`   | `string`                                                       |
| `read-dir`       | `fs.readdirSync`        | `{ name, isDirectory, path }[]` sorted dirs-first, no dotfiles |
| `open-directory` | `dialog.showOpenDialog` | `string \| null`                                               |

### Preload — `src/preload/index.ts`

Exposes a typed `ElectronAPI` object to the renderer via `contextBridge.exposeInMainWorld('electron', ...)`:

```ts
window.electron.platform; // OS platform string
window.electron.getHomeDir(); // Promise<string>
window.electron.readDir(path); // Promise<FileEntry[]>
window.electron.openDirectory(); // Promise<string | null>
```

### Renderer Type Declaration — `src/renderer/src/env.d.ts`

Augments `Window` with the `ElectronAPI` type. The file ends with `export {}` so TypeScript treats it as a module and activates the `declare global` block.

---

## Type Definitions — `src/renderer/src/types.ts`

```ts
type ComponentCategory = "infrastructure" | "services" | "storage";
type NodeStatus = "idle" | "running" | "done" | "error";

interface ArchitectNodeData {
  label: string; // Display name (e.g. "API Gateway")
  description: string; // Short description (e.g. "Request routing")
  category: ComponentCategory;
  iconName: string; // Key into the Lucide icon registry
  color: string; // Hex accent color (e.g. "#fb923c")
  tag: string; // Short abbreviation shown on the card (e.g. "API")
  status: NodeStatus; // Current agent execution state
  prompt: string; // User-written agent prompt
  promptOpen: boolean; // Whether the prompt textarea is expanded
}

type ArchitectNodeType = Node<ArchitectNodeData, "architectNode">;
```

---

## Component Palette — `src/renderer/src/data/componentPalette.ts`

Defines 8 draggable component types across 3 categories:

| Label       | Category       | Tag   | Color     | Icon      |
| ----------- | -------------- | ----- | --------- | --------- |
| Frontend    | infrastructure | UI    | `#f472b6` | Monitor   |
| API Gateway | infrastructure | API   | `#fb923c` | Shield    |
| Auth        | infrastructure | AUTH  | `#4ade80` | Lock      |
| Service     | services       | SVC   | `#60a5fa` | Settings2 |
| AI Model    | services       | AI    | `#a78bfa` | Brain     |
| Queue       | services       | QUEUE | `#fbbf24` | Layers    |
| Database    | storage        | DB    | `#60a5fa` | Database  |
| Cache       | storage        | CACHE | `#34d399` | Zap       |

Each item is a `PaletteItemConfig` object. `categoryOrder` and `categoryLabels` control the sidebar grouping order and display names.

---

## Icon Registry — `src/renderer/src/lib/icons.ts`

Maps `iconName` strings to Lucide icon components. Falls back to `Settings2` for unknown names. Used by `PaletteItem` and `ArchitectNode` to resolve icons at runtime without importing all of Lucide.

---

## Components

### `TopNav`

Header bar. Props: `activeTab`, `onTabChange`, `onClear`, `onLoadDemo`.

- Left: inline SVG architect logo + "architect" wordmark
- Center: tab strip — Canvas, Files, Terminal, Preview
- Right: version badge (`v0.1.0`), Clear button, Load demo button, Dispatch agents button (accent color, `Zap` icon — not yet wired)

### `Sidebar`

Left panel. Groups palette items by category using `categoryOrder`. Renders a section header for each category and a `PaletteItem` for each item within it.

### `PaletteItem`

A single draggable entry in the sidebar. On `dragstart`, serializes the `PaletteItemConfig` as JSON into the `application/architect-node` transfer slot. Icon color varies by category (blue = infrastructure, purple = services, emerald = storage).

### `AgentLog`

Right panel. Currently displays a placeholder empty state (ScrollText icon + "No agents running yet"). Wired up in phase 2 for live Claude agent output streams.

### `ResizablePanel`

Wraps the Sidebar and AgentLog. Props:

| Prop           | Type                | Default  |
| -------------- | ------------------- | -------- |
| `side`         | `'left' \| 'right'` | required |
| `defaultWidth` | `number`            | required |
| `minWidth`     | `number`            | `120`    |
| `maxWidth`     | `number`            | `480`    |

**Drag to resize:** `mousedown` on the 8px drag handle attaches `mousemove`/`mouseup` to `window`. Delta is applied in the correct direction based on `side`. No CSS transitions during drag to avoid lag.

**Collapse:** A chevron button appears on hover over the drag handle. Toggling collapsed sets the content div width to `0`. The chevron direction always points toward the panel content (visual hint to expand).

### `FilesPanel`

Full filesystem browser loaded on the Files tab. On mount, calls `window.electron.getHomeDir()` to set the initial path. Navigating into a directory pushes the current path to a history stack, enabling the back button. The "Open" button invokes `window.electron.openDirectory()` to show a native folder picker.

File entries: directories show `Folder` (amber), files show `File` (slate). Dotfiles are filtered out in the main process.

### `ArchitectNode`

Custom React Flow node. The node card is built with two layers to solve handle clipping:

```
<div className="relative">           ← outer wrapper, no overflow-hidden
  <Handle type="target" ... />       ← left connector dot
  <div className="... overflow-hidden"> ← card with rounded corners + accent strip
    <div className="absolute left-0 ...">  ← colored 5px left accent strip
    {/* tag + status dot + label */}
    {/* prompt dropdown */}
  </div>
  <Handle type="source" ... />       ← right connector dot
</div>
```

**Why two divs:** `overflow-hidden` is required on the card to render the left accent strip and rounded corners correctly. However, `overflow-hidden` clips React Flow's `Handle` components which are positioned at `-6px` outside the card boundary. The outer wrapper has no clipping so handles are always visible and interactive.

**Handles:** 11×11px circles with `background: '#1e1e1e'` and `border: 2px solid nodeColor`. This matches the card background while the colored border makes them discoverable.

**Status dot colors:**

| Status    | Color                        |
| --------- | ---------------------------- |
| `idle`    | same as `nodeColor` (accent) |
| `running` | `#fbbf24` (amber)            |
| `done`    | `#4ade80` (green)            |
| `error`   | `#f87171` (red)              |

**Prompt dropdown:** clicking "Agent prompt" toggles `promptOpen` in node data via `setNodes`. The `<textarea>` writes back via `updatePrompt`. Both use `useReactFlow().setNodes` so state lives in the React Flow store — no external state manager needed.

---

## App Orchestration — `src/renderer/src/App.tsx`

`ReactFlowProvider` wraps `ArchitectFlow` so that `useReactFlow()` is available both in `ArchitectFlow` itself and in any custom node rendered inside `<ReactFlow>`.

**State:** `useNodesState<ArchitectNodeType>` and `useEdgesState<Edge>` manage the canvas state.

**Drag and drop:** `onDrop` reads `application/architect-node` from the drag transfer, converts the screen position to flow coordinates via `screenToFlowPosition`, and adds a new node. `onDragOver` sets `dropEffect: 'move'`.

**Tab switching:** The canvas `<ReactFlow>` container is always mounted (toggled with `hidden` class) to preserve node/edge state when switching to other tabs. `FilesPanel` is conditionally rendered. Terminal and Preview show a "coming soon" placeholder.

**Demo data:** `onLoadDemo` loads 3 pre-wired nodes (React App, API Gateway, PostgreSQL) with 2 edges.

**Edge styling:** `defaultEdgeOptions: { style: { stroke: '#3a3a3a', strokeWidth: 1.5 } }`. React Flow's default bezier edge type produces smooth curved connections.

---

## Styling

### Tailwind Color Tokens (`tailwind.config.ts`)

| Token                | Hex       | Used for                                  |
| -------------------- | --------- | ----------------------------------------- |
| `canvas`             | `#111111` | Canvas background                         |
| `panel`              | `#191919` | Sidebar, top nav, agent log backgrounds   |
| `node`               | `#212121` | Node card background, button hover states |
| `node-border`        | `#2d2d2d` | Borders throughout                        |
| `node-border-active` | `#5b5bf0` | Selected node borders                     |
| `accent`             | `#5b5bf0` | Primary action button, edge active state  |

### React Flow CSS Overrides (`index.css`)

- Canvas background: `#111111`
- Controls: borderless, dark `#191919` buttons
- Edges: `stroke: #5b5bf0`, `stroke-width: 2`
- Selection box: `#5b5bf0` with 8% opacity fill

---

## Running the App

```bash
cd /Users/masonostman/Documents/Architect
npm install
npm run dev
```

This starts the electron-vite dev server and launches the Electron window with hot module replacement.

---

## Phase 2 — Agent Integration (Planned)

The frontend is designed to hand off to the Claude Agent SDK. Each node's `prompt` field contains the user's intent for that component. The "Dispatch agents" button in `TopNav` is the entry point — when wired up, it will:

1. Traverse the node graph to determine build order (respecting edges as dependencies)
2. Spawn a Claude agent per node, passing the node `prompt` as the task description
3. Stream agent output into the `AgentLog` panel
4. Update each node's `status` field (`running` → `done` / `error`) to reflect progress in real time
