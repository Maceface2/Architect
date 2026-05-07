---
# ============================================================
# ARCHITECT — Design System Tokens
# ============================================================
# Architect is an Electron + React desktop app for visually
# composing and dispatching multi-agent AI systems.

meta:
  name: Architect
  version: "1.0"
  description: >
    Dark-first developer tool for composing and dispatching
    multi-agent AI systems on a drag-and-drop canvas.

# ------------------------------------------------------------
# Color Palette
# ------------------------------------------------------------
colors:

  # --- Canvas & Surface ---
  canvas:
    dark: "#1d1d1d"          # main canvas background (rgb 29 29 29)
    light: "#e2e8f0"         # slate-200 — tinted slate so nodes read as objects
  panel:
    dark: "#181418"          # top nav and side panels (subtle violet tint)
    light: "#f8fafc"         # slate-50
  node:
    dark: "#3a3736"          # hover/active background on inline controls
    light: "#ffffff"
  component:
    dark: "#1e1e1e"          # card surfaces on the canvas (ComponentNode)
    light: "#ffffff"
  terminal:
    dark: "#0d0d0d"          # near-black; maximises ANSI colour contrast
    light: "#ffffff"
  surface:
    dark: "#171717"          # overlay panel / modal body (palette, dispatch modal)
    light: "#ffffff"

  # --- Borders ---
  border:
    default:
      dark: "#4c4846"        # rgb 76 72 70 — warm dark grey
      light: "#cbd5e1"       # slate-300
    active:
      dark: "#58A6FF"        # accent blue — same in both themes
      light: "#58A6FF"

  # --- Brand Accent ---
  accent:
    default: "#58A6FF"       # GitHub-blue; primary buttons, edges, handles
    hover:   "#4a4ad0"       # deeper indigo for pressed/hover on filled buttons

  # --- Text ---
  text:
    primary:
      dark: "#f0eeec"        # rgb 240 238 236 — warm off-white
      light: "#0f172a"       # slate-900
    muted:
      dark: "#a29e9c"        # rgb 162 158 156
      light: "#475569"       # slate-600
    subtle:
      dark: "#6c6866"        # rgb 108 104 102
      light: "#64748b"       # slate-500

  # --- Semantic Status ---
  status:
    running: "#fbbf24"       # amber-400 — in-progress dot on zone
    done:    "#4ade80"       # emerald-400 — success dot on zone
    error:   "#f87171"       # red-400 — failure dot on zone

  # --- Semantic Roles (used for alert banners, badges) ---
  warning:
    text:       "#fcd34d"    # amber-300
    border:     "#fbbf24"    # amber-400 at /40 opacity
    fill:       "#fbbf24"    # amber-400 at /10 opacity
  success:
    text:       "#d1fae5"    # emerald-200
    border:     "#34d399"    # emerald-400 at /40 opacity
    fill:       "#34d399"    # emerald-400 at /10 opacity
  danger:
    text:       "#fca5a5"    # red-300
    border:     "#ef4444"    # red-500 at /15 opacity
    fill:       "#ef4444"    # red-500 at /15 opacity
  assistant:
    text:       "#c084fc"    # purple-400 (AI assistant toggle)
    border:     "#c084fc"    # at /40 opacity
    fill:       "#c084fc"    # at /10 opacity

  # --- Activity Log Semantics (Swimlane view) ---
  activity:
    neutral:    "rgb(148, 163, 184)"   # slate-400 — task-received / progress / note
    done:       "rgb(110, 213, 145)"   # green — done events
    failed:     "rgb(248, 113, 113)"   # red — failed events
    ask:        "rgb(228, 178, 99)"    # amber — blocked/ask events
    answer:     "rgb(180, 167, 224)"   # lavender — answer / dispatch-started events

  # --- Canvas Chrome ---
  canvas_chrome:
    dot_grid:
      dark: "#6c6967"
      light: "#94a3b8"
    controls_bg:
      dark: "#2c2a29"
      light: "#ffffff"
    controls_border:
      dark: "#4a4644"
      light: "#cbd5e1"
    controls_fg:
      dark: "#a8a4a2"
      light: "#475569"
    controls_bg_hover:
      dark: "#383532"
      light: "#e2e8f0"
    controls_fg_hover:
      dark: "#f0eeec"
      light: "#0f172a"

  # --- React Flow Edges ---
  edge:
    stroke:         "#58A6FF"
    stroke_width:   2
    selected_stroke: "#8fc2ff"

# ------------------------------------------------------------
# Typography
# ------------------------------------------------------------
typography:
  font_family:
    sans: >
      -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', sans-serif
    mono: >
      ui-monospace, 'SFMono-Regular', Menlo, monospace
  font_smoothing: antialiased

  scale:
    # Pixel sizes used directly (not Tailwind named steps)
    "2xl":   { size: "1.5rem",   weight: 600, usage: "Page title (login screen)" }
    "xl":    { size: "1.25rem",  weight: 600, usage: "Settings section headings" }
    "lg":    { size: "1.125rem", weight: 600, usage: "Modal titles" }
    "sm":    { size: "0.875rem", weight: 400, usage: "Form inputs, modal body, tab labels (NavRow 2)" }
    "xs":    { size: "0.75rem",  weight: 400, usage: "Top-nav buttons, field labels, nav tabs" }
    "13px":  { size: "13px",     weight: 600, usage: "Component node label, zone header label" }
    "12px":  { size: "12px",     weight: 400, usage: "Settings field rows, activity time gutter" }
    "11px":  { size: "11px",     weight: 400, usage: "Hint text, metadata lines, badge hints" }
    "10px":  { size: "10px",     weight: 700, usage: "ALL-CAPS section headers and tag labels (tracking-widest)" }
    "9px":   { size: "9px",      weight: 400, usage: "Runtime short-label badge inside zone header" }

  tracking:
    tight:   "-0.025em"    # tracking-tight — page/modal headings
    normal:  "0em"
    wide:    "0.1em"       # tracking-wide — model chip badges
    wider:   "0.05em"      # tracking-wider — micro-section caps, runtime badges
    widest:  "0.1em"       # tracking-widest — tag labels, palette section caps
    zone_arch: "0.18em"    # architectural zone label — custom value

# ------------------------------------------------------------
# Spacing
# ------------------------------------------------------------
spacing:
  base: "4px"              # Tailwind default (1 = 4px)
  common_insets:
    tight:   "8px 12px"    # px-3 py-2 — cards and inputs
    default: "16px 24px"   # px-6 py-4 — modal headers and footers
    loose:   "32px"        # px-8 py-8 — settings page

  gaps:
    "1":  "4px"
    "2":  "8px"
    "3":  "12px"
    "4":  "16px"
    "5":  "20px"
    "10": "40px"           # space-y-10 between settings sections

  component_node:
    left_accent_bar: "4px"  # colored left-edge indicator
    left_pad:        "14px" # text clears the bar
    handle_size:     "9px"
    handle_offset:   "-5px" # protruding edge handle

# ------------------------------------------------------------
# Border Radius
# ------------------------------------------------------------
radii:
  "2px":   "2px"    # architectural zone treatment (near-square)
  sm:      "4px"    # rounded — inputs, tiny icon buttons
  md:      "6px"    # rounded-md — nav buttons, activity cards, controls
  lg:      "8px"    # rounded-lg — palette toolbar, settings option rows, zone header
  xl:      "12px"   # rounded-xl — modals, settings section panels
  "2xl":   "16px"   # rounded-2xl — zone nodes (default treatment)
  full:    "9999px" # rounded-full — status dots, toggle thumb, update badge

# ------------------------------------------------------------
# Elevation / Shadow
# ------------------------------------------------------------
elevation:
  component_node:
    shadow: "0 20px 25px -5px rgb(0 0 0 / 0.4), 0 8px 10px -6px rgb(0 0 0 / 0.2)"
    # Tailwind shadow-xl on a near-black canvas
  modal:
    shadow: "0 25px 50px -12px rgb(0 0 0 / 0.6)"
    # Tailwind shadow-2xl; compound: backdrop-blur reinforces floating depth
  palette_popup:
    shadow: "0 25px 50px -12px rgb(0 0 0 / 0.5)"
  zone_selected:
    # Dynamic: uses the zone's own accent color
    formula: "0 0 0 1px {color}/25, 0 0 40px {color}/15"
    note: "Outer ring is a subtle halo at 25% color opacity; bloom is 40px spread at 15%"
  overlay_backdrop: "bg-black/70 backdrop-blur-sm"

# ------------------------------------------------------------
# Motion / Animation
# ------------------------------------------------------------
motion:
  default_transition:
    property: colors
    duration: "150ms"
    easing: ease
    note: "transition-colors on virtually every interactive element"

  handle_reveal:
    property: "opacity, box-shadow"
    duration: "150ms"
    easing: ease
    note: "Connection handles hidden at opacity 0; appear on parent hover or edge-mode"

  handle_pulse:
    name: architect-handle-pulse
    duration: "1.15s"
    easing: "ease-in-out"
    iteration: infinite
    keyframes:
      "0%, 100%":
        box_shadow: "0 0 0 2px rgba(88,166,255,0.16), 0 0 10px rgba(88,166,255,0.32)"
      "50%":
        box_shadow: "0 0 0 5px rgba(88,166,255,0.28), 0 0 18px rgba(88,166,255,0.58)"
    note: "Active in edge-creation mode; pulses accent-blue glow on all handles"

  drag_opacity:
    value: 0.8
    note: "Dragged node drops to 80% opacity"

  spinner:
    class: animate-spin
    usage: "Loader2 icon during dispatch launch and sign-in"

  two_step_pty_submit:
    note: >
      Scheduler writes text to PTY, waits 120 ms, then sends bare CR.
      This separates the paste burst from Enter so multi-line CLIs treat them
      as distinct events. Not a CSS animation — a harness timing contract.

# ------------------------------------------------------------
# Component Patterns
# ------------------------------------------------------------
components:

  # Navigation bar (two rows)
  top_nav:
    height_row1: "44px"    # h-11 — macOS title-bar drag region
    height_row2: "36px"    # h-9 — tab strip
    background: panel
    border_bottom: "border-node-border"
    left_inset: "88px"     # clears macOS traffic-light buttons

  # Primary action button (Dispatch, Place zone, Sign in)
  button_primary:
    bg: accent             # #58A6FF
    bg_hover: "#4a4ad0"
    text: fg               # warm off-white
    radius: "6px–8px"
    padding: "px-3 py-1.5 or px-4 py-1.5"
    font: "text-xs to text-sm, font-medium"

  # Ghost button (Cancel, nav tools)
  button_ghost:
    bg: transparent
    bg_hover: node
    text: fg_muted
    text_hover: fg
    border: border-node-border

  # Destructive action (delete zone, delete dispatch record)
  button_destructive:
    text: "text-fg-subtle"
    text_hover: "text-red-300 or text-red-400"
    bg_hover: "bg-red-500/15 or bg-red-400/10"

  # Segmented control (used in Settings for theme, zone style, etc.)
  segmented_control:
    container: "rounded overflow-hidden border border-white/[0.08]"
    segment_active: "bg-[#58A6FF]/20 text-[#58A6FF]"
    segment_inactive: "text-fg-subtle hover:text-fg-muted"
    padding: "px-2.5 py-1"
    font: "text-[11px] capitalize"

  # Toggle switch
  toggle:
    track_on: "#58A6FF"
    track_off: "white/10"
    thumb: white
    size: "w-8 h-4 track; w-3 h-3 thumb"
    transition: "left 150ms"

  # Text inputs and textareas
  input:
    bg: "black/30 or bg-canvas"
    border: "border-white/10 or border-node-border"
    border_focus: "border-accent or ring-1 ring-accent"
    text: fg
    placeholder: fg_subtle
    radius: "4px–6px"
    padding: "px-3 py-2"

  # Modal overlay
  modal:
    backdrop: "bg-black/70 backdrop-blur-sm"
    panel_bg: "#171717 (surface)"
    panel_border: "border-white/10"
    panel_radius: "rounded-xl"
    panel_shadow: "shadow-2xl"
    max_width: "max-w-2xl"
    section_divider: "border-white/10"

  # Tab underline (modal tabs and nav)
  tab_active: "border-b-2 border-accent text-fg"
  tab_inactive: "border-b-2 border-transparent text-fg-muted hover:text-fg"

  # Settings section card
  settings_section:
    header: "text-[10px] uppercase tracking-widest text-fg-subtle"
    panel: "rounded-xl border border-node-border bg-panel p-5"

# ------------------------------------------------------------
# Canvas Nodes
# ------------------------------------------------------------
nodes:

  zone_default:
    radius: "rounded-2xl"
    fill_alpha: 0.08        # zone color at 8% opacity (dark) / 18% (light)
    border: "1.5px dashed {color}/35"
    border_selected: "1.5px solid {color}/60"
    glow_selected: "0 0 0 1px {color}/25, 0 0 40px {color}/15"
    header_fill: "{color}/18"
    header_border: "{color}/25"

  zone_architectural:
    radius: "rounded-[2px]"
    fill: transparent
    border: "1px solid {color}/30"
    border_selected: "1px solid {color}/55"
    corners: "12px L-shaped ticks, 1.5px thick, inset 6px, in zone color"
    label: "11px, font-medium, uppercase, tracking-[0.18em], colored in zone color"
    glow: none

  component_node:
    bg: component
    radius: "rounded-lg"
    shadow: shadow-xl
    border_dark: "white/[0.06] hover:white/20"
    border_light: "slate-300 hover:slate-400"
    selected: "outline 2px solid {color}, outlineOffset 2px"
    accent_bar: "4px left edge, zone color"
    min_width: "160px"
    max_width: "200px"

  handle:
    size: "9px"
    border: "2px solid {color}"
    bg_dark: "#1e1e1e"
    bg_light: "#ffffff"
    visibility: "hidden (opacity 0) by default, shown on parent hover or edge mode"

# ------------------------------------------------------------
# Zone Status Dot
# ------------------------------------------------------------
zone_status:
  idle:    "zone accent color"
  running: "#fbbf24"
  done:    "#4ade80"
  error:   "#f87171"
  size:    "w-2 h-2 rounded-full"

# ------------------------------------------------------------
# Logo
# ------------------------------------------------------------
logo:
  shape: "wireframe triangle — 3 lines + 3 circle joints"
  color: "#58A6FF"
  geometry:
    apex:        "360, 40"
    bottom_left: "40, 360"
    bottom_mid:  "200, 360"
  stroke_width: "14px (full-size SVG), 32px (inline 20×20 nav version)"
  joint_radius: "14px (full-size), 28px (inline nav version)"

# ------------------------------------------------------------
# Icon Library
# ------------------------------------------------------------
icons:
  library: lucide-react
  sizes_used: [9, 10, 11, 12, 13, 14, 15, 16, 18, 20]
  color: inherits from text color class

---

## Visual Identity

Architect is a **dark, developer-native desktop tool** — the same aesthetic register as a high-end code editor or CLI multiplexer, not a consumer SaaS product. The canvas is an infinite spatial canvas where AI agents live as coloured zones and components. Every design decision defers to function and legibility first.

### Atmosphere

The default surface stack runs very dark: the canvas sits at `#1d1d1d` (near-charcoal), panels dip slightly darker and violet-tinted to `#181418` (separating sidebar chrome from canvas content without a hard border), component cards occupy a flat `#1e1e1e`, and the terminal goes nearly black at `#0d0d0d` for maximum ANSI colour contrast. Modal overlays use a near-black `#171717` panel over a `bg-black/70 backdrop-blur-sm` scrim so they float clearly above the canvas without losing context.

Warm off-white (`#f0eeec`) is the primary text colour — it reads crisper on warm-dark backgrounds than a pure `#ffffff`. Secondary and hint text step down through warm greys (`#a29e9c`, `#6c6866`).

### Accent

A single brand blue — **`#58A6FF`** — does almost everything: primary buttons, selected borders, edge strokes, handle pulses, active segmented-control segments, pinned-model chips. This is intentionally GitHub-adjacent and immediately readable in a dark context. The pressed/hover variant deepens to `#4a4ad0` (indigo territory) rather than just darkening, adding a subtle hue shift that communicates state without brightness loss.

The only deliberate deviation from the monochrome blue regime is the **AI assistant toggle**, which glows a soft `#c084fc` purple — a purposeful signal that this surface is AI-mediated rather than a regular tool action.

### Zone Colour System

Each zone carries a user-assigned accent colour. This colour cascades through the zone's fill tint, border, status dot, header strip, resize handle, and corner tick marks. The same accent colour at varying alpha values produces a coherent family: the fill at 8% (dark) or 18% (light) is barely perceptible but creates a sense of spatial ownership; the border at 35% dashed draws the boundary without competing with components inside; the glow ring on selection (`0 0 0 1px /25` + `0 0 40px /15`) reinforces selection state through both a crisp ring and a diffuse bloom.

The **default zone treatment** is a rounded, translucent card — closer to a coloured glass panel. The **architectural zone treatment** strips the fill entirely and replaces the rounded corners with precise 12-pixel L-bracket ticks in the zone colour, evoking a blueprint or circuit-board annotation style. Labels in architectural mode switch to ALL CAPS + extra tracking, turning zone boundaries into schematic annotations rather than containers.

### Component Nodes

Component nodes are the only truly opaque, card-like objects on the canvas. They use a drop shadow (`shadow-xl`) to establish spatial hierarchy above the translucent zones, a 4-pixel coloured left-edge bar as the primary per-category colour signal, and a monochrome (warm-dark) body so they never compete with zone fills. The tag (`AUTH`, `API`, `UI`) renders in the component's accent colour with wide uppercase tracking — this is the fastest reading path for identifying category at a glance.

Connection handles are invisible by default; they fade in on hover or pulse in edge-creation mode. The pulse animation uses a dual box-shadow that breathes between a compact 2px ring and a 5px ring with a 10–18px outer glow, all in the accent blue. This makes every potential connection point feel alive without being distracting.

### Typography Hierarchy

There are two registers: **prose** (body, forms, hints) and **annotation** (ALL-CAPS micro-labels). The prose stack uses system-ui with `antialiased` smoothing; `text-sm` (14px) is the modal body default, `text-xs` (12px) drives most nav/toolbar text. Annotation labels — section headers in Settings, zone runtime badges, tag labels on components — drop to 10-11px with `font-semibold uppercase tracking-widest`. This contrast in case and tracking is the primary typographic differentiator; font weight alone doesn't carry enough signal at small sizes.

Monospace is used sparingly: file path chips in the top nav, model strings in the settings panel, number inputs, and model-id search fields. This signals "editable identifier" versus "display label."

### Motion

The dominant motion primitive is `transition-colors` at 150ms ease, applied to nearly every interactive element. This creates a unified feel of responsive surfaces without velocity cues (nothing slides, nothing scales). The only exceptions are: connection handle reveal (opacity + box-shadow, also 150ms), the handle-pulse glow animation in edge-creation mode (1.15s sine, infinite), and the loading spinner (continuous rotation). This restraint keeps the tool feeling fast and focused — motion is diagnostic (state changes) not decorative.

### Light Mode

Light mode is a considered inversion rather than a naive colour flip. The canvas becomes `slate-200` (`#e2e8f0`), a tinted slate that ensures nodes read as raised objects rather than disappearing into a white background. Panel areas flip to `slate-50`. Text scales to dark navy. Crucially, the accent colour stays identical (`#58A6FF`) across both themes — switching to indigo was evaluated and rejected as confusing. Node borders become `slate-300`; zone fills alpha increases from 8% to 18% and header fills from 18% to 32% to preserve spatial legibility against the lighter canvas.

### Interaction States

- **Primary actions** (Dispatch, Place zone, Save): `bg-accent` filled, white text, hover to `bg-[#4a4ad0]`.
- **Ghost/secondary** (Cancel, Clear, nav tools): transparent with `border-node-border`, hover to `bg-node` surface tint.
- **Destructive** (Delete zone, Delete dispatch): neutral until hover, then `text-red-300 bg-red-500/15` — colour appears only on intent.
- **Disabled**: `opacity-40` with `pointer-events-none`, no separate visual vocabulary.
- **Warning state** (uninstalled CLI, zone divergence): `text-amber-300 border-amber-400/40 bg-amber-400/10`.
- **Success state** (update ready, model refresh success): `text-emerald-200 border-emerald-400/40 bg-emerald-400/10`.

### Overlay & Depth System

Three layers of depth operate on the canvas:
1. **Canvas background** — dots/grid on `bg-canvas`.
2. **Zone bodies** (z-index 0) — translucent, always behind components.
3. **Component nodes** (z-index 1) — opaque cards, above zones.
4. **Edges** — z-index 1, explicitly lifted above zone fills to remain clickable.
5. **Canvas palette** — absolute-positioned `z-30` overlay, near-black at 95% opacity with backdrop-blur.
6. **Modals** — fixed-position `z-[9999]`, full-screen scrim with blur.

### Typographic Annotations vs. Component Labels

Zone header labels in default mode read as **UI chrome** (white or near-white, semi-bold, 13px). Zone header labels in architectural mode read as **schematic annotations** (zone-colour, 11px, uppercase, 0.18em tracking). Component tags (`AUTH`, `API`) read as **category badges** (zone-colour, 10px, bold, widest tracking). These three roles — chrome, schematic, badge — form the full visual vocabulary for spatial labelling.

### Summary

Architect's visual language is: **dark canvas, warm neutrals, single saturated blue, tight type, restrained motion**. It's legible at a glance, extensible through per-zone colour assignments, and never competes with the terminal content (ANSI output, code) it exists to contain and coordinate.
