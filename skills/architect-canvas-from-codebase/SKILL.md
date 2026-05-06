---
name: architect-canvas-from-codebase
description: Generate an Architect canvas (zones, components, edges) by performing a deep architecture-discovery pass over an existing codebase. Use when the user asks for "a canvas of this repo", "discover architecture", "generate canvas from code", or invokes auto-canvas generation.
---

# Generate an Architect Canvas From an Existing Codebase

You are an architecture assistant embedded in Architect — a tool for visually composing multi-agent systems. The user wants a canvas inferred from the actual code in the project directory. Take your time exploring before writing — a correct canvas is worth a few minutes of `rg` and `find`.

## Model

- **components** are first-class design artifacts on a flat canvas. Each carries: `label`, `specs` (API contracts, schemas, responsibilities, notes), `tag`, `color`, `iconName`. Components do NOT own agent behavior.
- **zones** are translucent overlays drawn on top of a group of components. Each zone is an agent (one CLI session). Zones own a `systemPrompt` (durable role/style — *not* a build checklist), runtime, model, tools, skills, permissions.
- Zone membership is **geometric**: if a component's center falls inside a zone's bounding box, that zone owns it. A component outside all zones is a design artifact only.
- Edges are component-level reference links for dependencies/data flow. Optional `label`, `direction` (`source-to-target` | `bidirectional` | `none`), and `sourceHandle`/`targetHandle` connector ids (e.g. `source-right`, `target-top`). Not used for scheduling or ownership.

## Workflow

1. **Explore before writing.**
   - Inspect the repository structure. Identify package/build files, entry points, backend services, frontend apps, data/storage layers, integrations, config, tests, and deployment files.
   - Prefer fast, targeted commands (`rg --files`, `find`, manifest reads) before opening large files.
   - Manage context — summarize as you go instead of dumping large files.

2. **Build an architecture model.**
   - 5–12 meaningful components. A component is a real subsystem, package, service, module, UI surface, data store, external integration, or workflow boundary — not a folder by accident.
   - 2–5 zones representing useful agent-ownership areas, not just folder splits.
   - Component edges for important dependencies, calls, data flow, auth flow, event flow, or build/deploy relationships.
   - Use uncertainty honestly. If a relationship is inferred from filenames/config rather than confirmed code, say so in the component `specs`.

3. **Write the canvas.**
   - Create or replace `architect-canvas.json` at the project root.
   - Pretty-print with 2-space indentation.
   - Preserve any existing `settings` if present.
   - Give zones durable role-style `systemPrompt` values (e.g. "Senior backend engineer — write idiomatic Go, prefer stdlib, always add tests"). Do **not** turn zone prompts into build checklists.
   - Place components inside their owning zone by geometry — size zones large enough to cover their components with margin.
   - Keep labels concise and `specs` specific.

4. **Verify.**
   - Re-read `architect-canvas.json`. Confirm valid JSON with top-level `nodes`, `edges`, `settings`.
   - Confirm every edge references existing component ids.
   - Give a brief final summary of the discovered architecture and any uncertain areas.

## Scope

Do **not** modify source code. Only write `architect-canvas.json`.

## Canvas JSON shape

Always pretty-printed with 2-space indentation. The app live-reloads `architect-canvas.json` on save.

~~~json
{
  "nodes": [
    {
      "id": "frontend-zone",
      "type": "zone",
      "position": { "x": 80, "y": 80 },
      "width": 620,
      "height": 360,
      "zIndex": 0,
      "data": {
        "label": "Frontend Agent",
        "description": "Owns the user-facing app shell",
        "color": "#58A6FF",
        "status": "idle",
        "systemPrompt": "Senior frontend engineer. Build clean, idiomatic React UIs with proper state management and accessibility.",
        "agentRuntime": "codex",
        "providerModels": { "codex": "gpt-5.2-codex" },
        "openSections": [],
        "skills": [],
        "tools": { "webSearch": false, "codeExec": false, "fileRead": false, "fileWrite": false, "apiCalls": false, "shell": false },
        "behavior": { "mode": "sequential", "retries": 0, "onFailure": "stop", "timeoutMs": 30000 },
        "permissions": { "readFiles": false, "writeFiles": false, "network": false, "shell": false },
        "envVars": []
      }
    },
    {
      "id": "web-ui",
      "type": "component",
      "position": { "x": 120, "y": 170 },
      "zIndex": 1,
      "data": {
        "label": "Frontend",
        "description": "",
        "specs": "React app with auth, dashboard, and settings screens.",
        "category": "custom",
        "iconName": "Monitor",
        "color": "#f472b6",
        "tag": "UI"
      }
    }
  ],
  "edges": [
    {
      "id": "component-flow",
      "source": "web-ui",
      "target": "api-client",
      "sourceHandle": "source-right",
      "targetHandle": "target-left",
      "data": { "label": "uses", "direction": "source-to-target" }
    }
  ],
  "settings": { "dispatchRuntime": "codex" }
}
~~~

### Field rules

- **Zones** need: `id`, `type: "zone"`, `position`, `width`, `height`, `zIndex`, and `data` with `label`, `description`, `color`, `status`, `systemPrompt`, `agentRuntime`, `providerModels`, `openSections`, `skills`, `tools`, `behavior`, `permissions`, `envVars`.
- **Components** need: `id`, `type: "component"`, `position`, `zIndex`, and `data` with `label`, `description`, `specs`, `category`, `iconName`, `color`, `tag`. For new components, put detail in `specs`, set `description: ""` and `category: "custom"`.
- Available `iconName` values: Monitor, Shield, Lock, Network, Globe, ArrowLeftRight, GitBranch, Webhook, Settings2, Brain, Layers, Cpu, Clock, Mail, Bell, CreditCard, Search, Activity, BarChart2, ToggleLeft, Database, Zap, Archive, Table, Boxes, Share2, TrendingUp, Wrench.

## Streaming-update protocol (alternative to writing the file)

If, instead of writing `architect-canvas.json`, you prefer to stream the canvas back to the running Architect renderer (the side-panel parser watches your stdout), emit a single fenced block:

~~~
ARCHITECT_CANVAS_UPDATE
{ "zones": [...], "components": [...], "edges": [...] }
END_ARCHITECT_CANVAS_UPDATE
~~~

Use this only when explicitly streaming patches. The default path is to write the full `architect-canvas.json` file.
