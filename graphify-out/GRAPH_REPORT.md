# Graph Report - .  (2026-04-18)

## Corpus Check
- 95 files · ~108,352 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 366 nodes · 407 edges · 63 communities detected
- Extraction: 79% EXTRACTED · 20% INFERRED · 1% AMBIGUOUS · INFERRED: 80 edges (avg confidence: 0.81)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Dispatch UI Docs|Dispatch UI Docs]]
- [[_COMMUNITY_Runtime Dispatch Engine|Runtime Dispatch Engine]]
- [[_COMMUNITY_Agent Config Forms|Agent Config Forms]]
- [[_COMMUNITY_Spring Boot Testing|Spring Boot Testing]]
- [[_COMMUNITY_Canvas App Orchestration|Canvas App Orchestration]]
- [[_COMMUNITY_Canvas Data Contracts|Canvas Data Contracts]]
- [[_COMMUNITY_Runtime Palette Registry|Runtime Palette Registry]]
- [[_COMMUNITY_Laravel Workflow Stack|Laravel Workflow Stack]]
- [[_COMMUNITY_Delivery QA Workflow|Delivery QA Workflow]]
- [[_COMMUNITY_Django Hexagonal Patterns|Django Hexagonal Patterns]]
- [[_COMMUNITY_API Backend Patterns|API Backend Patterns]]
- [[_COMMUNITY_UI Screenshot Flow|UI Screenshot Flow]]
- [[_COMMUNITY_Service Diagram|Service Diagram]]
- [[_COMMUNITY_Main Process Watcher|Main Process Watcher]]
- [[_COMMUNITY_Infrastructure Security|Infrastructure Security]]
- [[_COMMUNITY_Concurrency Patterns|Concurrency Patterns]]
- [[_COMMUNITY_ORM Repository Patterns|ORM Repository Patterns]]
- [[_COMMUNITY_Modern Frontend Tooling|Modern Frontend Tooling]]
- [[_COMMUNITY_Preview URL Utilities|Preview URL Utilities]]
- [[_COMMUNITY_Container Deployment|Container Deployment]]
- [[_COMMUNITY_Cross-Stack TDD|Cross-Stack TDD]]
- [[_COMMUNITY_Design System Direction|Design System Direction]]
- [[_COMMUNITY_Brand Mark|Brand Mark]]
- [[_COMMUNITY_App Icon|App Icon]]
- [[_COMMUNITY_Palette Icons|Palette Icons]]
- [[_COMMUNITY_QA CSharp Testing|QA CSharp Testing]]
- [[_COMMUNITY_Analytics Migrations|Analytics Migrations]]
- [[_COMMUNITY_Django Security Verification|Django Security Verification]]
- [[_COMMUNITY_Immutability Standards|Immutability Standards]]
- [[_COMMUNITY_Kotlin Rust Concurrency|Kotlin Rust Concurrency]]
- [[_COMMUNITY_Project Settings Context|Project Settings Context]]
- [[_COMMUNITY_Zone Node View|Zone Node View]]
- [[_COMMUNITY_Assistant Terminal Panel|Assistant Terminal Panel]]
- [[_COMMUNITY_File Browser Panel|File Browser Panel]]
- [[_COMMUNITY_Top Navigation|Top Navigation]]
- [[_COMMUNITY_Onboarding Tour|Onboarding Tour]]
- [[_COMMUNITY_Frontend Engineering Patterns|Frontend Engineering Patterns]]
- [[_COMMUNITY_Ktor Routing Patterns|Ktor Routing Patterns]]
- [[_COMMUNITY_Laravel Verification|Laravel Verification]]
- [[_COMMUNITY_Terminal Tabs|Terminal Tabs]]
- [[_COMMUNITY_Resizable Panels|Resizable Panels]]
- [[_COMMUNITY_Main IPC Handler|Main IPC Handler]]
- [[_COMMUNITY_React Flow Wrapper|React Flow Wrapper]]
- [[_COMMUNITY_Canvas Persistence Rationale|Canvas Persistence Rationale]]
- [[_COMMUNITY_Architecture Decisions|Architecture Decisions]]
- [[_COMMUNITY_Bun Toolchain|Bun Toolchain]]
- [[_COMMUNITY_Claude API Tooling|Claude API Tooling]]
- [[_COMMUNITY_NestJS Validation|NestJS Validation]]
- [[_COMMUNITY_Rust Testing|Rust Testing]]
- [[_COMMUNITY_Security Scanner|Security Scanner]]
- [[_COMMUNITY_Kotlin Testing|Kotlin Testing]]
- [[_COMMUNITY_Postgres Indexing|Postgres Indexing]]
- [[_COMMUNITY_Python Typing|Python Typing]]
- [[_COMMUNITY_Python Testing|Python Testing]]
- [[_COMMUNITY_Electron Vite Config|Electron Vite Config]]
- [[_COMMUNITY_Tailwind Tokens|Tailwind Tokens]]
- [[_COMMUNITY_PostCSS Pipeline|PostCSS Pipeline]]
- [[_COMMUNITY_Renderer Bootstrap|Renderer Bootstrap]]
- [[_COMMUNITY_Electron Env Types|Electron Env Types]]
- [[_COMMUNITY_Shared Type Schemas|Shared Type Schemas]]
- [[_COMMUNITY_Node Type Registry|Node Type Registry]]
- [[_COMMUNITY_Sidebar Panel|Sidebar Panel]]
- [[_COMMUNITY_Palette Data Catalog|Palette Data Catalog]]

## God Nodes (most connected - your core abstractions)
1. `patch()` - 16 edges
2. `ArchitectFlow Controller` - 12 edges
3. `Electron IPC API Contract` - 9 edges
4. `spawnAgentSession()` - 8 edges
5. `runGraph()` - 8 edges
6. `Test-Driven Development Workflow` - 8 edges
7. `isAgentRuntime()` - 7 edges
8. `setupWorkspace()` - 7 edges
9. `Zone Node Schema` - 6 edges
10. `Dispatch Workflow` - 6 edges

## Surprising Connections (you probably didn't know these)
- `Dispatch Workflow` --references--> `Global Project Controls`  [AMBIGUOUS]
  AGENTS.md → src/renderer/src/components/layout/TopNav.tsx
- `Skills System` --conceptually_related_to--> `Zone Agent Editor`  [INFERRED]
  AGENTS.md → src/renderer/src/components/nodes/AgentConfigModal.tsx
- `Claude Dispatch Workflow Variant` --semantically_similar_to--> `Dispatch Workflow`  [INFERRED] [semantically similar]
  CLAUDE.md → AGENTS.md
- `Dispatch Workflow` --conceptually_related_to--> `Zone Output Preview`  [INFERRED]
  AGENTS.md → src/renderer/src/components/layout/PreviewPanel.tsx
- `Dispatch Workflow` --conceptually_related_to--> `Multi-Session Terminal Workspace`  [INFERRED]
  AGENTS.md → src/renderer/src/components/layout/TerminalPanel.tsx

## Hyperedges (group relationships)
- **Assistant-Driven Canvas Editing** — app_architect_flow_controller, assistantpanel_architecture_assistant_terminal, assistantpanel_canvas_update_protocol, app_canvas_file_source_of_truth [EXTRACTED 1.00]
- **Dispatch Execution Surface** — agents_dispatch_workflow, env_electron_ipc_api_contract, terminalpanel_multi_session_terminal_workspace, previewpanel_zone_output_preview [INFERRED 0.84]
- **Zone and Component Authoring Model** — types_zone_node_schema, types_component_node_schema, app_zone_membership_geometry_rule, agents_visual_composition_rationale [INFERRED 0.87]
- **Architect Dispatch Pipeline** — terminals_graph_indexing, terminals_workspace_setup, terminals_architect_prompt, terminals_zone_prompt, terminals_run_graph [EXTRACTED 1.00]
- **API Guidance Cluster** — apidesign_patterns, backendpatterns_skill, codingstandards_skill [INFERRED 0.86]
- **Canvas Runtime Contract** — canvas_canvas_migration, index_canvas_watcher, terminals_graph_indexing [INFERRED 0.84]
- **Hexagonal Boundary Stack** — hexagonal_architecture_use_cases, hexagonal_architecture_outbound_ports, hexagonal_architecture_adapters, hexagonal_architecture_composition_root [EXTRACTED 1.00]
- **Delivery Quality Loop** — deployment_patterns_skill, django_verification_skill, e2e_testing_ci_integration, github_ops_pr_management [INFERRED 0.79]
- **UI System Stack** — design_system_skill, frontend_design_skill, frontend_patterns_skill [INFERRED 0.80]
- **TDD Red-Green-Refactor Family** — kotlin_testing_tdd_cycle, laravel_tdd_tdd_cycle, python_testing_tdd_cycle, rust_testing_tdd_cycle [INFERRED 0.94]
- **Rate Limiting Across Backend Stacks** — laravel_security_rate_limiting, springboot_patterns_rate_limiting, springboot_security_rate_limiting [INFERRED 0.86]
- **Testing And Verification Skill Family** — springboot_tdd_workflow, springboot_verification_loop, tdd_workflow_main [INFERRED 0.84]
- **Palette Drag Contract** — palette_item_component, palette_drag_payload, component_palette_catalog, component_palette_category_taxonomy [INFERRED 0.87]
- **Runtime Registry Pattern** — agent_runtimes_catalog, agent_runtime_map, default_model_by_runtime, agent_runtime_resolution_helpers [EXTRACTED 1.00]

## Communities

### Community 0 - "Dispatch UI Docs"
Cohesion: 0.09
Nodes (34): Zone Agent Editor, Architect Application, Dispatch Workflow, IPC Surface, Skills System, Visual Composition Before CLI Dispatch, ArchitectFlow Controller, Canvas Conflict Resolution (+26 more)

### Community 1 - "Runtime Dispatch Engine"
Cohesion: 0.13
Nodes (22): getAgentRuntime(), isAgentRuntime(), isAgentRuntimeMode(), buildArchitectPrompt(), buildMermaidDiagram(), buildRuntimeArgs(), buildZonePrompt(), createSession() (+14 more)

### Community 2 - "Agent Config Forms"
Cohesion: 0.16
Nodes (17): addCustomSkill(), addEnvVar(), hasSkill(), removeEnvVar(), removeSkill(), saveLabel(), setBehavior(), setConfiguredRuntime() (+9 more)

### Community 3 - "Spring Boot Testing"
Cohesion: 0.13
Nodes (20): Fast Isolated Deterministic Testing Rationale, JaCoCo Coverage Enforcement, Spring Boot Testcontainers Strategy, Spring Boot TDD Workflow, Diff Review Phase, Fast Feedback Beats Late Surprises Rationale, Spring Boot Verification Loop, Security Scan Phase (+12 more)

### Community 4 - "Canvas App Orchestration"
Cohesion: 0.13
Nodes (9): buildDemoGraph(), createDefaultZoneAgentConfig(), createDefaultZoneData(), getEffectiveModel(), getEffectiveRuntime(), migrateCanvasData(), normalizeProjectSettings(), normalizeProviderModels() (+1 more)

### Community 5 - "Canvas Data Contracts"
Cohesion: 0.16
Nodes (17): Canvas Data Migration, Project Settings Normalization, Effective Runtime and Model Resolution, Default Zone Agent Config, Electron Process Architecture, Lucide Icon Registry, Canvas Watcher, File System IPC Surface (+9 more)

### Community 6 - "Runtime Palette Registry"
Cohesion: 0.13
Nodes (17): Agent Runtime Map, Runtime Resolution Helpers, Agent Runtime Catalog, Component Palette Catalog, Component Category Taxonomy, Zone Palette Item, Default Agent Runtime, Default Model By Runtime (+9 more)

### Community 7 - "Laravel Workflow Stack"
Cohesion: 0.12
Nodes (16): Use scoped bindings to prevent cross-tenant access, Scoped Route Model Binding, Laravel Development Patterns, LaraPlugins.io MCP Server, Laravel Plugin Discovery, Laravel Rate Limiting, Laravel Security Best Practices, Laravel TDD Workflow (+8 more)

### Community 8 - "Delivery QA Workflow"
Cohesion: 0.25
Nodes (9): E2E CI Integration, Page Object Model, E2E Testing Patterns, Conventional Commits, GitHub Flow, Git Workflow Patterns, gh CLI, PR Management (+1 more)

### Community 9 - "Django Hexagonal Patterns"
Cohesion: 0.36
Nodes (9): DRF ViewSet Pattern, Django Service Layer Pattern, Django Development Patterns, Adapters, Composition Root, Keep business logic independent from frameworks, Outbound Ports, Hexagonal Architecture (+1 more)

### Community 10 - "API Backend Patterns"
Cohesion: 0.29
Nodes (8): API Connector Builder, Cursor Pagination, API Design Patterns, Cache-Aside Pattern, Repository Pattern, Backend Development Patterns, Readability First, Coding Standards

### Community 11 - "UI Screenshot Flow"
Cohesion: 0.36
Nodes (8): Agent Log Panel, arc.dev UI, Visual Architecture Canvas, Canvas Tab, Component Palette, Dispatch Agents Button, PostgreSQL Node, React App Node

### Community 12 - "Service Diagram"
Cohesion: 0.48
Nodes (7): API Layer, Auth, Database, Frontend, Infra, Node-Based Canvas UI, Service Architecture Diagram

### Community 13 - "Main Process Watcher"
Cohesion: 0.4
Nodes (2): startCanvasWatcher(), stopCanvasWatcher()

### Community 14 - "Infrastructure Security"
Cohesion: 0.33
Nodes (6): CI/CD Pipeline Security, Least Privilege IAM, Cloud Infrastructure Security Skill, Input Validation, Secrets Management, Security Review Skill

### Community 15 - "Concurrency Patterns"
Cohesion: 0.4
Nodes (6): Context Cancellation, Go Development Patterns, Useful Zero Value Design, Kotlin Coroutines & Flows, StateFlow UI State, Structured Concurrency

### Community 16 - "ORM Repository Patterns"
Cohesion: 0.4
Nodes (6): N+1 Prevention, JPA Repository Pattern, JPA/Hibernate Patterns, newSuspendedTransaction, Exposed Repository Pattern, Kotlin Exposed Patterns

### Community 17 - "Modern Frontend Tooling"
Cohesion: 0.33
Nodes (6): Use Turbopack for faster cold start and hot updates, Next.js and Turbopack, Turbopack Incremental Bundler, Keep the first render deterministic to avoid hydration mismatches, Hydration Safety, Nuxt 4 Patterns

### Community 18 - "Preview URL Utilities"
Cohesion: 0.5
Nodes (2): poll(), sanitize()

### Community 19 - "Container Deployment"
Cohesion: 0.4
Nodes (5): Multi-Stage Docker Builds, Rolling Deployment, Deployment Patterns, Dev/Prod Multi-Stage Dockerfile, Docker Patterns

### Community 20 - "Cross-Stack TDD"
Cohesion: 0.4
Nodes (5): Red-Green-Refactor Cycle, Django Testing with TDD, Go Red-Green-Refactor Cycle, Go Testing Patterns, Table-Driven Tests

### Community 21 - "Design System Direction"
Cohesion: 0.4
Nodes (5): Generate Design System Mode, Design System Skill, Frontend Design, Strong aesthetic beats safe-average UI, Committed Visual Direction

### Community 22 - "Brand Mark"
Cohesion: 0.6
Nodes (5): Connected Graph / Node Motif, Corner Joint Nodes, Architect Logo, Stylized Capital A, Open Triangular Frame

### Community 23 - "App Icon"
Cohesion: 0.4
Nodes (5): App Icon, Dark Rounded-Square Background, Node-Link Network Concept, Stylized Letter A, Three-Node Connected Graph Symbol

### Community 24 - "Palette Icons"
Cohesion: 0.5
Nodes (2): getIcon(), PaletteItem()

### Community 25 - "QA CSharp Testing"
Cohesion: 0.5
Nodes (4): Browser QA, Visual Regression Phase, C# Testing Patterns, Testcontainers Integration Tests

### Community 26 - "Analytics Migrations"
Cohesion: 0.5
Nodes (4): MergeTree Table Design, ClickHouse Analytics Patterns, Expand-Contract Migration Pattern, Database Migration Patterns

### Community 27 - "Django Security Verification"
Cohesion: 0.5
Nodes (4): Production Security Settings, Django Security Best Practices, Security Scan Phase, Django Verification Loop

### Community 28 - "Immutability Standards"
Cohesion: 0.5
Nodes (4): Immutability by Default, .NET Development Patterns, Java Immutability by Default, Java Coding Standards

### Community 29 - "Kotlin Rust Concurrency"
Cohesion: 0.5
Nodes (4): Kotlin Development Patterns, Structured Concurrency with Coroutines and Flow, Safe Concurrency with Arc, Mutex, Channels, and Tokio, Rust Development Patterns

### Community 30 - "Project Settings Context"
Cohesion: 0.67
Nodes (0): 

### Community 31 - "Zone Node View"
Cohesion: 0.67
Nodes (0): 

### Community 32 - "Assistant Terminal Panel"
Cohesion: 0.67
Nodes (0): 

### Community 33 - "File Browser Panel"
Cohesion: 0.67
Nodes (0): 

### Community 34 - "Top Navigation"
Cohesion: 0.67
Nodes (0): 

### Community 35 - "Onboarding Tour"
Cohesion: 0.67
Nodes (3): Reconnaissance Phase, Codebase Onboarding, Code Tour

### Community 36 - "Frontend Engineering Patterns"
Cohesion: 0.67
Nodes (3): Component Composition, Frontend Performance Optimization, Frontend Development Patterns

### Community 37 - "Ktor Routing Patterns"
Cohesion: 0.67
Nodes (3): Keep routes thin and push logic to services, Ktor Routing DSL and Thin Routes, Ktor Server Patterns

### Community 38 - "Laravel Verification"
Cohesion: 0.67
Nodes (3): Stop immediately when environment or Composer checks fail, Sequential Verification Phase Pipeline, Laravel Verification Loop

### Community 39 - "Terminal Tabs"
Cohesion: 1.0
Nodes (0): 

### Community 40 - "Resizable Panels"
Cohesion: 1.0
Nodes (0): 

### Community 41 - "Main IPC Handler"
Cohesion: 1.0
Nodes (0): 

### Community 42 - "React Flow Wrapper"
Cohesion: 1.0
Nodes (2): Overflow Wrapper Rationale, Two-Layer ArchitectNode Wrapper

### Community 43 - "Canvas Persistence Rationale"
Cohesion: 1.0
Nodes (2): Always-Mounted React Flow Canvas, Canvas State Preservation Rationale

### Community 44 - "Architecture Decisions"
Cohesion: 1.0
Nodes (2): Structured Architecture Decision Records, Decisions Should Not Live Only in Chat Threads

### Community 45 - "Bun Toolchain"
Cohesion: 1.0
Nodes (2): Single Bun Toolchain, Bun Runtime

### Community 46 - "Claude API Tooling"
Cohesion: 1.0
Nodes (2): Claude API, Claude Tool Use

### Community 47 - "NestJS Validation"
Cohesion: 1.0
Nodes (2): Global Validation Pipe, NestJS Development Patterns

### Community 48 - "Rust Testing"
Cohesion: 1.0
Nodes (2): Rust Testing Patterns, Rust RED-GREEN-REFACTOR Cycle

### Community 49 - "Security Scanner"
Cohesion: 1.0
Nodes (2): AgentShield, Security Scan Skill

### Community 50 - "Kotlin Testing"
Cohesion: 1.0
Nodes (2): Kotlin Testing Patterns, Kotlin RED-GREEN-REFACTOR Cycle

### Community 51 - "Postgres Indexing"
Cohesion: 1.0
Nodes (2): Index Strategy, PostgreSQL Patterns

### Community 52 - "Python Typing"
Cohesion: 1.0
Nodes (2): Python Development Patterns, Type Hints and Protocol-Based Duck Typing

### Community 53 - "Python Testing"
Cohesion: 1.0
Nodes (2): Python Testing Patterns, Python RED-GREEN-REFACTOR Cycle

### Community 54 - "Electron Vite Config"
Cohesion: 1.0
Nodes (0): 

### Community 55 - "Tailwind Tokens"
Cohesion: 1.0
Nodes (0): 

### Community 56 - "PostCSS Pipeline"
Cohesion: 1.0
Nodes (0): 

### Community 57 - "Renderer Bootstrap"
Cohesion: 1.0
Nodes (0): 

### Community 58 - "Electron Env Types"
Cohesion: 1.0
Nodes (0): 

### Community 59 - "Shared Type Schemas"
Cohesion: 1.0
Nodes (0): 

### Community 60 - "Node Type Registry"
Cohesion: 1.0
Nodes (0): 

### Community 61 - "Sidebar Panel"
Cohesion: 1.0
Nodes (0): 

### Community 62 - "Palette Data Catalog"
Cohesion: 1.0
Nodes (0): 

## Ambiguous Edges - Review These
- `Global Project Controls` → `Dispatch Workflow`  [AMBIGUOUS]
  AGENTS.md · relation: references
- `Spring Boot Verification Loop` → `Terminal Ops Skill Stack`  [AMBIGUOUS]
  skills/terminal-ops/SKILL.md · relation: references
- `Auth` → `API Layer`  [AMBIGUOUS]
  PNG image.png · relation: conceptually_related_to
- `Database` → `API Layer`  [AMBIGUOUS]
  PNG image.png · relation: conceptually_related_to
- `Open Triangular Frame` → `Connected Graph / Node Motif`  [AMBIGUOUS]
  architect-logo-final.svg · relation: conceptually_related_to
- `App Icon` → `Stylized Letter A`  [AMBIGUOUS]
  resources/icon.png · relation: references

## Knowledge Gaps
- **104 isolated node(s):** `Directory Gate`, `Project Directory Browser`, `Localhost Iframe Preview`, `Collapsible Split Panel`, `Component Palette Importer` (+99 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Terminal Tabs`** (2 nodes): `TerminalPanel.tsx`, `TermTab()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Resizable Panels`** (2 nodes): `ResizablePanel()`, `ResizablePanel.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Main IPC Handler`** (2 nodes): `handler()`, `index.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `React Flow Wrapper`** (2 nodes): `Overflow Wrapper Rationale`, `Two-Layer ArchitectNode Wrapper`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Canvas Persistence Rationale`** (2 nodes): `Always-Mounted React Flow Canvas`, `Canvas State Preservation Rationale`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Architecture Decisions`** (2 nodes): `Structured Architecture Decision Records`, `Decisions Should Not Live Only in Chat Threads`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Bun Toolchain`** (2 nodes): `Single Bun Toolchain`, `Bun Runtime`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Claude API Tooling`** (2 nodes): `Claude API`, `Claude Tool Use`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `NestJS Validation`** (2 nodes): `Global Validation Pipe`, `NestJS Development Patterns`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Rust Testing`** (2 nodes): `Rust Testing Patterns`, `Rust RED-GREEN-REFACTOR Cycle`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Security Scanner`** (2 nodes): `AgentShield`, `Security Scan Skill`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Kotlin Testing`** (2 nodes): `Kotlin Testing Patterns`, `Kotlin RED-GREEN-REFACTOR Cycle`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Postgres Indexing`** (2 nodes): `Index Strategy`, `PostgreSQL Patterns`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Python Typing`** (2 nodes): `Python Development Patterns`, `Type Hints and Protocol-Based Duck Typing`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Python Testing`** (2 nodes): `Python Testing Patterns`, `Python RED-GREEN-REFACTOR Cycle`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Electron Vite Config`** (1 nodes): `electron.vite.config.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Tailwind Tokens`** (1 nodes): `tailwind.config.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `PostCSS Pipeline`** (1 nodes): `postcss.config.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Renderer Bootstrap`** (1 nodes): `main.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Electron Env Types`** (1 nodes): `env.d.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Shared Type Schemas`** (1 nodes): `types.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Node Type Registry`** (1 nodes): `nodeTypes.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Sidebar Panel`** (1 nodes): `Sidebar.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Palette Data Catalog`** (1 nodes): `componentPalette.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `Global Project Controls` and `Dispatch Workflow`?**
  _Edge tagged AMBIGUOUS (relation: references) - confidence is low._
- **What is the exact relationship between `Spring Boot Verification Loop` and `Terminal Ops Skill Stack`?**
  _Edge tagged AMBIGUOUS (relation: references) - confidence is low._
- **What is the exact relationship between `Auth` and `API Layer`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `Database` and `API Layer`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `Open Triangular Frame` and `Connected Graph / Node Motif`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `App Icon` and `Stylized Letter A`?**
  _Edge tagged AMBIGUOUS (relation: references) - confidence is low._
- **Why does `isAgentRuntime()` connect `Runtime Dispatch Engine` to `Canvas App Orchestration`?**
  _High betweenness centrality (0.007) - this node is a cross-community bridge._