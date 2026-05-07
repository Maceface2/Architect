# Product

## Register

product

## Users

Developers and AI engineers running multi-agent workflows on top of terminal-native AI CLIs (Claude Code, Codex, Gemini, OpenCode). They are technically fluent operators: comfortable with PTYs, session files, dispatch contracts, and simultaneous agent processes. They use Architect alongside, not instead of, a real code editor and a terminal. The primary task on any given screen is *spatial reasoning about a system* — drawing what to build, who owns what, and how zones coordinate — followed by *dispatching that system* and *observing it run*.

Their context is focused, not casual: dim rooms, large monitors, frequent context switches between Architect, an editor, and a real terminal. They do not need hand-holding. They need legibility, predictability, and tools that never compete with the underlying CLI output.

## Product Purpose

Architect turns a system architecture diagram into an executable multi-agent runtime. Users compose components and zones on an infinite canvas, then dispatch the canvas as live coordinated CLI sessions. Success looks like: a developer drafts a multi-zone system in minutes, dispatches it, watches the conductor route work between zones in real time, resumes mid-flight after a crash, and never feels the tool is in their way.

The product's hardest job is to be a serious instrument, not a pretty diagram editor.

## Brand Personality

**Spatial, schematic, blueprint-like.** The canvas is a plan view, not a dashboard. Zones read as draftsman annotations (L-bracket corner ticks, ALL-CAPS tracking-widest labels in zone color). Components read as labeled fixtures dropped into a schematic. Edges are signal lines.

Voice: terse, technical, precise. No marketing phrases, no exclamation marks, no smiley microcopy, no "magic." Errors and empty states speak like a CLI, not like a SaaS onboarding flow.

Atmosphere: quiet, intentional, restrained. Color does work; nothing is decorative. Motion is diagnostic only.

## Anti-references

- **Generic developer-tool clones** (primary anti-reference). Architect must not look like a GitHub or VS Code reskin. Dark mode + GitHub-blue accent is a starting palette, not an identity. The schematic/blueprint vocabulary (architectural zone ticks, ALL-CAPS annotations, dashed zone borders, edge handles as signal taps) is what differentiates it.
- **SaaS dashboards.** No hero metric cards, no identical icon-card grids, no cream surfaces, no friendly emoji.
- **Consumer AI chat aesthetics.** No purple-pink gradients, no sparkle iconography, no centered conversation layouts, no "AI magic" framing.

## Design Principles

1. **The canvas is the product.** Every chrome decision (nav, panels, modals) defers to canvas legibility. Chrome shrinks; canvas grows.
2. **Schematic over decorative.** Annotations, ticks, dashed borders, blueprint conventions over cards, gradients, drop shadows. When in doubt, lift from technical drawing, not from product UI fashion.
3. **Diagnostic motion only.** Animation signals state changes (handle reveal, status transition, drag opacity, edge-mode pulse). It never decorates. `prefers-reduced-motion` suppresses everything non-essential including the handle pulse and spinner-only loaders where text alternatives exist.
4. **Color does work.** Accent blue (`#58A6FF`) carries product identity. Per-zone color carries spatial ownership and propagates through fill, border, header, status dot, handle, and tag. The lone purple is the AI-assistant signal. Nothing else gets color.
5. **Coexist with terminals.** Architect always shares the screen with ANSI output. The UI must never out-saturate, out-animate, or out-compete the terminal it exists to host.

## Accessibility & Inclusion

- **WCAG 2.1 AA** as the baseline: contrast, focus visibility, keyboard navigation across canvas, modals, and panels.
- **Strict `prefers-reduced-motion`.** When the OS preference is set, the handle-pulse glow, drag opacity transition, spinner rotation, and any future canvas pan/zoom inertia must be suppressed or replaced with non-animated state cues. Status changes still need to be perceivable without motion.
- **Open gap to flag in critique:** zone identity currently relies heavily on user-assigned color (status dots, header strip, fill, tag). Critique should check whether color is ever the *only* signal for a state distinction (running / done / error) and recommend a redundant cue (shape, label, position) where it is.
