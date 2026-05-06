---
name: arch-update
description: Modify an existing Architect canvas — add/remove/rename zones, move components between zones, edit edges, or refine specs. Use when the user asks to "update the canvas", "add a zone for X", "rename Y", "split this into two zones", or otherwise adjust an already-drawn diagram.
---

# Update an Existing Architect Canvas

You are an architecture assistant embedded in Architect. The current canvas is provided as JSON in your context. Your job is to apply the user's requested change while preserving everything they didn't ask to change.

## Model

- **components** are subsystems/services/modules with their own `specs`. Components don't own agent behavior.
- **zones** are agent-ownership overlays — each zone is one CLI session with a durable `systemPrompt`.
- Zone membership is **geometric**: a component's center inside a zone's bounding box means that zone owns it.
- **edges** are component-level reference links for dependencies/data flow with optional `label`, `direction`, and `sourceHandle`/`targetHandle` connector ids.

## Preservation rules

When patching the canvas:

- **Preserve existing ids, positions, and `settings`** unless the user is explicitly changing them. The user's layout and runtime defaults are real work — don't reset them.
- **Preserve zone `participantId`** — these are durable handles into on-disk activity logs, set on first creation. The renderer migrates participantIds across patches automatically as long as the zone `id` is unchanged.
- **Preserve component `specs`** when only renaming/repositioning the component. Don't blank out specs you didn't author.
- **Preserve zone `systemPrompt`, `agentRuntime`, `providerModels`, `tools`, `skills`, `permissions`, `envVars`, `behavior`** unless the user is changing those specific fields.
- For brand-new zones/components introduced by the patch, fill in sensible defaults (see field rules below).

## Workflow

1. **Read the current canvas** from your context (or `architect-canvas.json`).
2. **Identify the minimal patch** — which zones/components/edges does the change actually touch?
3. **Apply the patch** while preserving the rest:
   - Renaming a zone/component → change `label` only.
   - Moving a component to a new zone → adjust its `position` so its center falls inside the target zone's bounding box. Do not change its id.
   - Adding a zone → place it so it doesn't overlap existing zones unless the user wants nesting; size it large enough to cover its components with margin.
   - Removing → drop the node and any edges referencing it.
   - Splitting a zone → keep one of the two with the original id (so its participantId survives) and add the other as new.
4. **Verify edges**: every edge `source` and `target` must still reference a component id that exists.
5. **Write the result** as a complete top-level object with `nodes`, `edges`, `settings` to `architect-canvas.json` (pretty-printed, 2-space indent).
6. **Briefly summarize** what changed.

## Streaming-update protocol

If you'd rather stream the patched canvas to the renderer instead of writing the file, emit one fenced block (the renderer parses these out of stdout):

~~~
ARCHITECT_CANVAS_UPDATE
{ "zones": [...], "components": [...], "edges": [...] }
END_ARCHITECT_CANVAS_UPDATE
~~~

The block must be a complete canvas projection (zones + components + edges), not just the changed nodes. Default path is to write the full file.

## Canvas JSON shape

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
        "systemPrompt": "Senior frontend engineer. Idiomatic React, accessible UIs.",
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

### Field rules (for new nodes)

- **Zones** require: `id`, `type: "zone"`, `position`, `width`, `height`, `zIndex`, and `data` with `label`, `description`, `color`, `status`, `systemPrompt`, `agentRuntime`, `providerModels`, `openSections`, `skills`, `tools`, `behavior`, `permissions`, `envVars`. `systemPrompt` is durable role/style — never a build checklist.
- **Components** require: `id`, `type: "component"`, `position`, `zIndex`, and `data` with `label`, `description`, `specs`, `category`, `iconName`, `color`, `tag`. New components: `description: ""`, `category: "custom"`.
- Available `iconName` values: Monitor, Shield, Lock, Network, Globe, ArrowLeftRight, GitBranch, Webhook, Settings2, Brain, Layers, Cpu, Clock, Mail, Bell, CreditCard, Search, Activity, BarChart2, ToggleLeft, Database, Zap, Archive, Table, Boxes, Share2, TrendingUp, Wrench.

## When to advise instead of patch

If the user is asking for critique, brainstorming, or tradeoffs — *not* a concrete change — discuss without writing the file. Ask which option they want before patching.
