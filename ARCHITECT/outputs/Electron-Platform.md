# Electron-Platform — t-docs-platform report

Owner of `CLAUDE.md` (and `AGENTS.md`, which is a symlink → `CLAUDE.md`). Audited the doc against shipped main-process + IPC code and the cross-doc drift flagged by the other three zones.

## Sections corrected (kept, edited)

1. **IPC surface — file system ops** (`### IPC surface`).
   Was: `readDir / readFile / getHomeDir / openDirectory`. Now: `readDir / openDirectory`.
   Source: self (Electron-Platform.md t-cleanup-platform — removed `read-file` / `get-home-dir` IPC handlers and `readFile` / `getHomeDir` preload exposures).

2. **Multi-zone dispatch design goal** (`### Orchestration v5 …`).
   Removed the parenthetical about `mailbox-listen.sh` not working on Codex's TUI. Kept the "no screen-scrape cue detection" goal — that's still a current design property, not v4 archaeology.
   Source: kill list (`v4 mailbox/scripts`).

3. **Conductor decisions — drain loop** (`#### Conductor decisions`).
   Was: "**No drain loop** is prescribed. No `mailbox-listen.sh`. The Conductor's prompt explicitly says…". Removed the `mailbox-listen.sh` clause.
   Source: kill list (`v4 mailbox/scripts`).

4. **Harness timeouts** (`#### Harness timeouts`).
   Removed the trailing sentence "v4's `deliveryWarningMs` + `taskTimeoutMs` are gone — the mailbox transport they served doesn't exist." The fields don't exist; doc shouldn't keep memorializing them.
   Source: kill list (`deliveryWarningMs`, `taskTimeoutMs`).

5. **Lifecycle state machine** (`#### Lifecycle state machine`).
   Was: "`spawning → running → failed`. v4's `finished` is unused — zones stay alive across tasks…". Now: "`spawning → running → failed`. Zones stay alive across tasks…".
   Source: kill list (`'finished' lifecycle state`).

6. **VS Code reference / xterm-headless paragraph** (`## VS Code reference`).
   Was a sentence claiming Architect keeps `@xterm/headless` fed for a `session.tail` debug buffer + a sentence noting "Screen-grid scanning / sigil regex was removed entirely." Both removed/rewritten.
   New text: "Per-task coordination in v5 flows through activity-log JSONL files and `pty.write`-delivered user turns — no buffered screen scraping. If you ever introduce screen-based detection, reference `src/vs/platform/terminal/node/terminalProcess.ts` for prior art."
   Source: Dispatch-Coordination.md (dropped `Session.tail` + `TAIL_MAX_BYTES`; `ZoneEvent`/`pushEvent`/`eventSeq`) + kill list (`screen-grid/sigil scanning`, `Session.tail/eventSeq`).

## Sections removed (entire bullets / lines)

7. **Multi-zone setup bullet — legacy mailbox cleanup** (under Flow B step 4).
   Removed: "Legacy `ARCHITECT/mailbox/` + `ARCHITECT/scripts/` (v4 leftovers) are `rm -rf`'d on entry."
   Source: kill list (`v4 mailbox/scripts`).

8. **Ephemeral storage bullet — legacy mailbox cleanup** (under Session & dispatch persistence → Ephemeral).
   Removed: "Legacy `ARCHITECT/mailbox/` + `ARCHITECT/scripts/` — `rm -rf`'d on first v5 entry; never recreated."
   Source: kill list (`v4 mailbox/scripts`).

## Cross-zone drift checked, no edit needed

- **`ZoneEvent` / `pushEvent` / `eventSeq`** (Dispatch-Coordination): never appeared in CLAUDE.md by those names. Covered indirectly by edit (6) which dropped the only paragraph that referenced the related debug-tail buffer.
- **`'harness'` `ParticipantRole` and `'resumed'` `TaskStatus`** (Dispatch-Coordination): not enumerated in CLAUDE.md (the `ParticipantStatus` enum it documents is `{starting, running, idle, blocked, failed, stale, exited}`, which is unchanged and correct). No edit.
- **`wireScheduler` placeholder** (Dispatch-Coordination): never named in CLAUDE.md.
- **`ZoneSession` back-compat alias** (Zone-Runtime-Fleet): never named in CLAUDE.md.
- **`dispatchContext` IPC param drop** (Dispatch-Coordination follow-up #2): still wired through `src/main/index.ts` + preload + my `startDispatch` signature in CLAUDE.md (line listing `startDispatch(nodes, edges, cwd, settings, { …, onlyZoneIds? }, dispatchContext?)`). Field remains in the IPC contract for now (only renamed to `_dispatchContext` internally in `terminals.ts`); doc still matches shipped surface. No edit.

## Verification

- `ls -la AGENTS.md` → `AGENTS.md -> CLAUDE.md` ✓ symlink intact, never edited directly.
- `grep` over CLAUDE.md for kill-list tokens (`readFile`, `getHomeDir`, `deliveryWarningMs`, `taskTimeoutMs`, `mailbox-listen`, `finished.*unused`, `session.tail`, `eventSeq`, `ZoneEvent`, `pushEvent`, `wireScheduler`, `Screen-grid`, `sigil`, `harness.*role`, `resumed.*TaskStatus`, `ZoneSession.*alias`) → 0 matches.

## Follow-ups (flagged, not implemented)

1. **`dispatchContext` IPC param** is still passed across IPC and silently discarded inside `startDispatchV5`. When Dispatch-Coordination + Electron-Platform agree to drop it from the IPC contract, the `startDispatch(...)` signature in CLAUDE.md (Flow B step 1) will need to lose the trailing `, dispatchContext?` argument too.
2. **Renderer-UX flagged** that `behavior.mode` / `onFailure` / `timeoutMs` are wired in the UI but never read by the v5 scheduler. CLAUDE.md doesn't currently document those fields, so no doc edit is required — but if the product call goes the "remove the fields" direction, the assistant-system-prompt JSON example in `App.tsx:986` (`"behavior": { "mode": …, "retries": 0, "onFailure": …, "timeoutMs": … }`) must be kept consistent with whatever subset survives.
3. **Renderer `env.d.ts` drift** (`onStatus` still types `'finished'`; preload no longer surfaces `readFile` / `getHomeDir` types). Renderer-UX zone — outside this doc edit.
4. **`sessionCapture.ts` duplicate-key warning** (Zone-Runtime-Fleet zone) — outside CLAUDE.md scope but mentioned in three zones' reports; worth a single one-line fix in `ensureClaudeProjectTrusted`.

## Canvas audit (t-canvas-platform)

Audit-only; `architect-canvas.json` not modified.

### Per-component verdict

- **Electron Platform zone (`zone-main-process`)** — accurate. `systemPrompt` correctly names `src/preload/index.ts` + `src/main/index.ts` as the owned surface. No drift.
- **IPC Bridge (`ipc-bridge`)** — **drift**. The `specs` string enumerates "…plus readDir/**readFile**/saveCanvas/loadCanvas/watchCanvas/startDispatch/terminal-layout." The `readFile` IPC handler + preload exposure were removed in t-cleanup-platform (zero renderer callers). `getHomeDir` was also removed but was never listed in `specs` (no drift there). Other namespaces (`terminal.*`, `zone.*`, `dispatches.*`, `activity.*`, `assistant.*`) match the shipped preload — partial enumerations, acceptable.
- **Main Process (`main-process`)** — accurate. `specs` matches `src/main/index.ts`: BrowserWindow, FS + canvas IPC handlers, popout windows, canvas watcher start/stop, dispatch/zone/assistant forwarding into `terminals.ts`, contextIsolation preserved.
- **Canvas Store (`canvas-store`)** — accurate. `specs` matches reality: project-root `architect-canvas.json`, `fs.watch` watcher emitting `canvas:changed` for live reload, save preserves layout/ids. Code path: `startCanvasWatcher` + `emitCanvasChanged` + `save-canvas`/`load-canvas`/`watch-canvas`/`unwatch-canvas` handlers in `src/main/index.ts`.

### Edge verdict

All edges incident to the Electron Platform zone reflect real call paths in `src/main/index.ts` + `src/preload/index.ts`:

- `Desktop App → IPC Bridge` (e1) ✓ — renderer calls `window.electron.*`.
- `IPC Bridge → Main Process` (e2) ✓ — `contextBridge` → `ipcRenderer.invoke/send` → `ipcMain.handle/on`.
- `Main Process → Canvas Store` (e3) ✓ — `save-canvas` / `load-canvas` / `watch-canvas` handlers + `startCanvasWatcher`.
- `Main Process → PTY Orchestrator` (e4) ✓ — `index.ts` imports from `./terminals` and forwards `dispatch:start`, `terminal:run-zone`, `terminal:spawn-shell`, `terminal:input`, `terminal:resize`, `start-assistant`, etc.
- `Dispatch Modal → IPC Bridge` (e19), `Terminal Panel → IPC Bridge` (e20), `Assistant Panel → IPC Bridge` (e21) ✓ — each renderer panel calls only through `window.electron`.

### Edits needed

Yes — one:

1. **`ipc-bridge.data.specs`** should drop `readFile` from the bullet list "plus readDir/**readFile**/saveCanvas/loadCanvas/watchCanvas/startDispatch/terminal-layout". After the fix the segment should read: "plus readDir/saveCanvas/loadCanvas/watchCanvas/startDispatch/terminal-layout."

No other components or edges require changes. No deleted features still listed elsewhere on these nodes.
