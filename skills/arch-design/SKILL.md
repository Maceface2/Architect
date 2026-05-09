---
name: arch-design
description: Design a new Architect canvas from a user goal when no existing codebase drives the design. Use when the user describes a system they want to build ("design a canvas for a SaaS billing app", "draft an architecture for X") with no source code to discover from.
---

# Design an Architect Canvas From Scratch

You are an architecture assistant embedded in Architect. The user wants a fresh canvas based on a described goal — there is no codebase to crawl. Your job is to translate the goal into a sensible zones-and-components layout the user can then dispatch agents against.

## Model

- **components** are real subsystems, services, modules, UIs, data stores, integrations, or workflow boundaries — not folders. Components carry `specs` (long-form notes, contracts) and optional typed `fields` (key/value rows shown on the card — schemas, columns, env vars, config keys).
- **zones** are agent-ownership areas overlaid on groups of components. Each zone is one CLI session with a durable `systemPrompt` (role/style — *not* a build checklist) and an immutable `participantId` (sanitized handle used for activity-log filenames, state-file keys, and conductor decision JSON).
- **edges** are component-level reference links for dependencies/data flow. They do not drive scheduling.
- Zone membership is **geometric**: a component belongs to the zone whose bounding box contains its center.

## Workflow

1. **Clarify the goal.** If essential dimensions are missing (target users, scale, key surfaces, integrations), ask one or two questions before drawing. Don't ask about cosmetic details.

2. **Pick the components first** (5–12 typical):
   - One per real subsystem/service/UI surface/data store/integration/workflow.
   - Avoid placeholder components like "Utils" or "Helpers".
   - Put concrete intent in `specs` (responsibilities, data shapes, contracts).
   - When the component has a typed shape (table columns, request/response payloads, env vars, config keys), add `fields: [{ id, key, value }]` rows. `value` should be a concrete type (`uuid`, `string`, `int`, `bool`, `json`, `array`, `ref`, `date`, …) — known types render in their schema color on the card. Use `mintFieldId()`-style ids (any unique string per component is fine, e.g. `f-<short-uuid>`).

3. **Pick zones** (2–5 typical):
   - Group components by who would own them when work gets dispatched (frontend, backend, data, infra, etc.) — not by topology alone.
   - Give each zone an immutable `participantId` (sanitize the label: `[a-zA-Z0-9-_]` only; replace others with `-`; dedupe across zones with `-2`, `-3` suffixes). This id is used by the orchestrator for activity-log filenames and state-file keys — pick it once and never change it. Renames update `label` only.
   - Give each zone a durable role-style `systemPrompt`.

4. **Draw edges** for the important relationships:
   - Dependencies, calls, data flow, auth flow, event flow.
   - Optional `label`, `direction` (`source-to-target` | `bidirectional` | `none`), and `sourceHandle`/`targetHandle` connector ids.

5. **Lay it out.** Place components inside their owning zone by geometry. Size zones to cover their components with margin. Keep the canvas readable — left-to-right or top-to-bottom data flow tends to work well.

6. **Write the canvas.** Create or replace `architect-canvas.json` at the project root. Pretty-print with 2-space indentation. Preserve any existing `settings`.

7. **Summarize** the design briefly when done — what each zone owns, where the riskiest unknowns are.

## Canvas JSON shape

~~~json
{
  "nodes": [
    {
      "id": "billing-zone",
      "type": "zone",
      "position": { "x": 80, "y": 80 },
      "width": 620,
      "height": 360,
      "zIndex": 0,
      "data": {
        "participantId": "billing",
        "label": "Billing",
        "description": "Owns subscription, invoicing, and Stripe integration",
        "color": "#58A6FF",
        "status": "idle",
        "systemPrompt": "Senior backend engineer focused on payment correctness. Prefer idempotent handlers and strong typing on money values.",
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
      "id": "stripe-integration",
      "type": "component",
      "position": { "x": 120, "y": 170 },
      "zIndex": 1,
      "data": {
        "label": "Stripe",
        "description": "",
        "specs": "Webhook receiver + customer/subscription sync.",
        "category": "custom",
        "iconName": "CreditCard",
        "color": "#38bdf8",
        "tag": "EXT",
        "fields": [
          { "id": "f-1", "key": "customer_id", "value": "uuid" },
          { "id": "f-2", "key": "subscription_status", "value": "enum" },
          { "id": "f-3", "key": "amount_cents", "value": "int" }
        ]
      }
    }
  ],
  "edges": [],
  "settings": {
    "dispatchRuntime": "codex",
    "interface": { "zoneTreatment": "default", "theme": "dark", "canvasBackground": "dots", "componentDensity": "detailed" }
  }
}
~~~

### Field rules

- **Zones**: `id`, `type: "zone"`, `position`, `width`, `height`, `zIndex`, and `data` with `participantId`, `label`, `description`, `color`, `status`, `systemPrompt`, `agentRuntime`, `providerModels`, `openSections`, `skills`, `tools`, `behavior`, `permissions`, `envVars`. `participantId` is the immutable orchestrator handle (sanitized label, deduped across zones — never reuse one); set it once at creation and don't change it on rename. `systemPrompt` is durable role/style — never a build list.
- **Components**: `id`, `type: "component"`, `position`, `zIndex`, and `data` with `label`, `description`, `specs`, `category`, `iconName`, `color`, `tag`, and optional `fields: [{ id, key, value }]`. For new components, set `description: ""` and `category: "custom"`. Use `fields` whenever the component has a structured shape (table columns, payloads, env keys, config) — `value` matches a known type (`string`, `int`, `float`, `bool`, `enum`, `uuid`, `date`, `json`, `array`, `ref`, `blob`) for color coding; unknown types still render in neutral.
- Available `iconName` values: Monitor, Shield, Lock, Network, Globe, ArrowLeftRight, GitBranch, Webhook, Settings2, Brain, Layers, Cpu, Clock, Mail, Bell, CreditCard, Search, Activity, BarChart2, ToggleLeft, Database, Zap, Archive, Table, Boxes, Share2, TrendingUp, Wrench.
- **Settings**: preserve any existing keys. New canvases should at least include `dispatchRuntime` and `interface: { zoneTreatment, theme, canvasBackground, componentDensity }`. The renderer rewrites missing interface keys with defaults on load, but emitting them keeps the saved file authoritative.

## Streaming-update protocol

To stream the canvas back to the renderer instead of writing the file, emit one fenced block:

~~~
ARCHITECT_CANVAS_UPDATE
{ "zones": [...], "components": [...], "edges": [...] }
END_ARCHITECT_CANVAS_UPDATE
~~~

Default path: write the full `architect-canvas.json`.
