# Repository Guidelines

## Project Overview

Architect is an Electron desktop app for visually planning and dispatching agent-driven coding work inside a real project directory. The renderer presents a node-based canvas where users model systems, attach prompts and runtime settings to nodes, inspect project files, and launch agent sessions against the selected workspace. The app is designed around local CLI-based agents rather than hosted orchestration, so repository context, terminal behavior, and runtime availability are all first-class concerns.

At a high level, the flow is:

- the user opens a project folder
- the renderer loads or creates an `architect-canvas.json` graph for that folder
- nodes and edges describe architecture tasks, agent prompts, skills, tools, and permissions
- dispatch actions cross the preload bridge into Electron main-process IPC handlers
- the main process spawns PTY-backed CLI sessions for supported runtimes such as Claude Code, Codex, Gemini, and OpenCode
- terminal output and assistant activity stream back into the renderer for live monitoring

The architecture is intentionally split into clear layers:

- `src/renderer/`: React + React Flow UI for the canvas, side panels, file browser, assistant panel, and terminal views
- `src/preload/`: the typed, minimal IPC bridge that exposes safe filesystem, canvas, assistant, and terminal APIs to the renderer
- `src/main/`: Electron window setup, filesystem IPC handlers, graph dispatch logic, and PTY/session lifecycle management
- `src/shared/`: runtime definitions and shared cross-process types that must stay aligned between main, preload, and renderer

## Project Structure & Module Organization

`src/main/` contains Electron main-process code, including PTY/session orchestration and IPC handlers. `src/preload/` exposes the safe bridge used by the renderer. `src/renderer/src/` holds the React app: `components/` for UI, `lib/` for canvas/runtime helpers, `context/` for shared state, and `data/` for palette definitions. Shared runtime metadata lives in `src/shared/`. Static assets are in `resources/`, and repository-local skills live in `skills/`.

## Build, Test, and Development Commands

- `npm install`: install dependencies and run the `node-pty` postinstall fixup.
- `npm run dev`: start the Electron + Vite development environment.
- `npm run build`: produce production bundles in `out/`; run this before opening a PR.
- `npm run preview`: preview the built renderer bundle.

There is currently no dedicated `test` script. Use `npm run build` as the minimum verification step.

## Coding Style & Naming Conventions

Use TypeScript with strict typing and React function components. Follow the existing style: 2-space indentation, single quotes, and semicolon-free statements. Use `PascalCase` for React components, `camelCase` for functions/variables, and descriptive file names such as `AssistantPanel.tsx` or `agentRuntimes.ts`. Keep shared cross-process types explicit; if data crosses IPC, update preload and renderer typings together.

## Testing Guidelines

No automated test framework is configured yet. For behavior changes:

- run `npm run build`
- manually exercise the affected flow in `npm run dev`
- verify both renderer behavior and Electron/terminal integration when touching `src/main/` or `src/preload/`

If you add tests later, place them next to the feature or in a small `__tests__/` directory and keep names aligned with the source file.

## Commit & Pull Request Guidelines

Recent commits use short, imperative summaries such as `multi cli support` and `fixed node editing`. Keep commits focused and similarly concise. PRs should include:

- a clear summary of user-visible changes
- verification steps
- screenshots or short recordings for UI changes
- notes about CLI/runtime assumptions when modifying agent execution

## Security & Configuration Tips

Do not hardcode secrets or local machine paths. CLI availability varies by machine; when adding a new runtime, handle missing binaries gracefully and keep fallback behavior explicit.
