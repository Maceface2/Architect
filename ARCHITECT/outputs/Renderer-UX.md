# Renderer-UX docs audit — t-docs-ux

## Files touched

- `docs/frontend.md`
- `README.md`

## Corrections (one-liner each)

### docs/frontend.md

- File-tree: dropped fictitious `PreviewPanel.tsx`; added `auth/`, `edges/`, `settings/`, plus the actually-shipped `AssistantPanel.tsx`, `AssistantLaunchModal.tsx`, `ResizablePanel.tsx`, `PopoutTerminalApp.tsx`.
- `ZoneNodeData`: removed legacy `agentRuntimeMode` field reference (stripped on load); added `participantId` and `openSections`.
- App-flow bullet list: replaced "Canvas / Files / Terminal / Preview" with the real tab set "Canvas / Files / Terminal / Settings"; documented the 50-step undo/redo, debounced auto-save, and the external-edit `CanvasConflictModal` flow.
- Removed the entire `PreviewPanel` section (component does not exist; per-zone output tail / iframe preview is not shipped).
- Replaced the thin `TerminalPanel` description with shipped detail: persistent xterm-per-id, drag-split + drag-reorder via `react-resizable-panels`, popout/dock + `onPopoutClosed` re-dock, plan-mode `GO` pill, and the auto-driven user-control lock semantics (acquire on non-Enter/non-Arrow, release on Enter unless `pendingPickerEnterRef` is armed by `/` or arrow keys; runs on `term.onKey`).
- Added an `AssistantPanel` section covering both modes (architecture vs general), independent PTYs/session histories, the `ARCHITECT_CANVAS_UPDATE` parser gated to architecture mode, the rows-immediate / cols-debounced (~100 ms) resize policy, parked-while-hidden flush on visibility return, and the `AssistantLaunchModal` resume-replays-original-runtime-and-model rule.
- Preload contract list: removed killed names (`readFile`, `getHomeDir`, `terminal.onCaptureState`, `activity.onEvent`/`onState`/`onDispatchComplete`, plus the trailing "Older names … `mailbox.onActivity`" sentence). Added the ones the renderer actually consumes: `onCanvasChanged`, `loadTerminalLayout` / `saveTerminalLayout`, the `auth.*` group, `assistant.listSessions`/`deleteSession`/`updateSessionSummary`, `terminal.setUserControl`, `terminal.onSpawned`, `terminal.onPopoutClosed`.
- Recommended-reading order: appended `AssistantPanel.tsx`.

### README.md

- Multi-zone dispatch step list: removed the "Legacy v4 artifacts (`ARCHITECT/mailbox/` and `ARCHITECT/scripts/`) are removed on entry" step and the "without mailbox polling loops or terminal-screen sentinels" trailing phrase (kill-list scrub).
- Workspace layout: removed the standalone "Legacy cleanup" subsection that listed `ARCHITECT/mailbox/` + `ARCHITECT/scripts/`.
- Assistant Panel section: rewrote to reflect the shipped two-mode panel (architecture + general, independent PTYs/session histories, launcher pickers only affect "Start new", resume replays original runtime + model).
- IPC Surface list: dropped `readFile`, `getHomeDir`. Added `unwatchCanvas`, `onCanvasChanged`, `loadTerminalLayout` / `saveTerminalLayout`, the `auth.*` group, the rest of the `assistant.*` group, `terminal.setUserControl`, `terminal.close`, `terminal.dock`.

## Sections fully removed

- `docs/frontend.md` — the entire `### PreviewPanel` section (4 bullets + 1 paragraph).
- `docs/frontend.md` — trailing "Older names … not part of the current API contract." sentence under Preload Contract.
- `README.md` — "Legacy cleanup" block under Workspace Layout.
- `README.md` — the v4-mailbox/scripts cleanup step from the multi-zone dispatch list.

## Cross-doc drift flagged for other owners (NOT edited)

- **`docs/orchestration.md`** (Scheduler-Harness / Dispatch-Coordination zone) — extensive `mailbox` references survive throughout the document by design (it explains the v4→v5 rationale), but the kill list calls for scrubbing the term entirely. If the kill list is meant to apply project-wide, this doc needs a pass: lines ~14, 24, 54, 66, 125, 178, 399, plus the "harness" role used as a self-noun in many headings (lines 34, 38, 66, 112, 161, 178, 256, 275, 426). Recommend the orchestration owner decide whether to keep the v4-history exposition or strip it.
- **`docs/agent-behavior.md`** (Conductor-Agent / Zone-Fleet zone) — line 121 still says `setupWorkspaceV5()` wipes `ARCHITECT/mailbox/` and `ARCHITECT/scripts/`. Lines 138, 143, 172 use the "harness" role-noun. Owner should decide.
- **`CLAUDE.md`** (root project doc) — uses "harness" as the orchestrator's noun in lines 142, 171, 193, 246, and references "mailbox" historically at line 144 ("Task delivery: pty.write, not a mailbox") and line 92 ("No shell scripts, no mailbox files"). Same call.
- **`docs/orchestration.md` line 232** mentions an `answer` decision routing — verify against scheduler.ts, not in this task's scope.
- The `'finished'` lifecycle status type still appears in `src/preload/index.ts` and `src/renderer/src/env.d.ts` (typed but never emitted in v5). Renderer-side flagged in last cleanup; preload edit belongs to Electron-Platform.

## Follow-ups

- If the kill list for "harness" is project-wide rather than just doc-vocabulary, the `HarnessTimeouts` type in `src/renderer/src/types.ts` and the `harnessTimeouts` settings field also need renaming — that ripples through `src/main/orchestrator/scheduler.ts`, `setupWorkspaceV5`, and `SettingsPanel.tsx`. Cross-zone change; needs a coordinated dispatch.
- `docs/frontend.md` "Runtime-Related UI Caveats" still lists `plan mode is recorded for every dispatch, but only Claude currently consumes it in runtime args` — verified accurate against current adapters; left as-is.
- Neither doc currently documents the per-project `ARCHITECT/terminal-layout.json` file written by `saveTerminalLayout`. Worth a one-line addition in a future pass — left out here to keep this audit narrowly scoped to drift removal.

## Canvas audit (t-canvas-ux)

Audited `architect-canvas.json` zone `zone-frontend` (label "Renderer UX", participantId `Renderer-UX`, runtime `claude`, position {-260,140}, size 380×560). The four geometric components inside this zone:

### Components

- **frontend / "Desktop App" / UI** — OK. Maps to `src/renderer/src/App.tsx` (DirectoryGate → ArchitectFlow shell, ReactFlow canvas, tab layout).
- **dispatch-modal / "Dispatch Modal" / DLG** — OK. Maps to `src/renderer/src/components/dispatch/DispatchModal.tsx` (new + resume tabs, plan-mode toggle, conductor-runtime picker).
- **terminal-panel / "Terminal Panel" / TTY** — OK. Maps to `src/renderer/src/components/layout/TerminalPanel.tsx` (xterm tabs, drag-split layout, user-control lock, plan-mode pill).
- **assistant-panel / "Assistant Panel" / AI** — OK. Maps to `src/renderer/src/components/layout/AssistantPanel.tsx` (architecture + general modes, per-mode PTYs, `ARCHITECT_CANVAS_UPDATE` parser).

No deleted or renamed components present in the zone.

### Edges into/out of this zone's components

- **e1: frontend → ipc-bridge (source-to-target)** — OK. App.tsx talks to main exclusively through `window.electron` (canvas persistence, dispatch start/resume, assistant start, zone session capture, etc.).
- **e19: dispatch-modal → ipc-bridge (source-to-target)** — OK. DispatchModal calls `window.electron.dispatches.{list,delete,updateSummary,resume}` and bubbles `startDispatch` via parent.
- **e20: terminal-panel → ipc-bridge (source-to-target)** — OK. TerminalPanel calls `window.electron.terminal.{spawnShell,input,setUserControl,resize,close,popout,dock,onData,onExit,onSpawned,onPopoutClosed}` plus `zone.{listSessions,launch,onSessionCaptured}`.
- **e21: assistant-panel → ipc-bridge (source-to-target)** — OK. AssistantPanel + AssistantLaunchModal call `window.electron.assistant.{start,listSessions,deleteSession,updateSessionSummary}` and `window.electron.terminal.{input,resize,onData,onExit}`.

All four edges accurately reflect shipped IPC traffic. No spurious or missing edges among components currently inside this zone.

### Zone label / runtime defaults

- Label `"Renderer UX"` — OK, matches my participantId and the role this zone owns.
- `agentRuntime: "claude"` — OK, matches `DEFAULT_AGENT_RUNTIME` and how this zone has been spawned in v5 dispatches.
- Position locked at `zIndex: 0` per recent `lock zones at z=0` commit — OK, consistent with all other zones.

### Genuinely missing components (shipped renderer features not represented)

The four-component view is coarse enough that minor pieces (LoginScreen, UserMenu, ResizablePanel, edges/ComponentEdge, palette internals, ZoneNode, ComponentNode) are reasonable to fold into "Desktop App". But three top-level renderer features rendered as full panels/tools are notably absent and arguably belong here on par with `dispatch-modal` / `terminal-panel` / `assistant-panel`:

- **Files Panel** — `src/renderer/src/components/layout/FilesPanel.tsx`, top-level tab, owns `window.electron.readDir`. Not represented.
- **Settings Panel** — `src/renderer/src/components/settings/SettingsPanel.tsx`, top-level tab, owns dispatch defaults + `harnessTimeouts` editing. Not represented.
- **Canvas Palette** — `src/renderer/src/components/palette/CompactCanvasPalette.tsx`, the floating Edges / Zones / Components creation tool. Not represented (and arguably owns the canvas-mutation surface that the Architecture Assistant edits via `ARCHITECT_CANVAS_UPDATE`).

Flagging per task instructions; whether to add them is a product/product-canvas decision.

### Edits needed

**none** for the four components currently in the zone (all OK). **Yes — optional** if the canvas should represent every shipped top-level renderer surface: add `files-panel`, `settings-panel`, and `canvas-palette` components inside the Renderer UX zone, with a single source-to-target edge each into `ipc-bridge` (Files Panel uses `readDir`; Settings Panel reads/writes via App.tsx-mediated `saveCanvas`; Canvas Palette is renderer-only with no IPC and could be drawn without an ipc edge).
