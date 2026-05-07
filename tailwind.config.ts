import type { Config } from 'tailwindcss'

// Colors are pulled from CSS variables defined in `src/renderer/src/index.css`.
// Each token is exposed as a space-separated R G B triple (e.g. `91 91 240`)
// so Tailwind's `<alpha-value>` placeholder lets `bg-accent/90`,
// `hover:bg-node/50`, etc. work the same way they would with literals.
function v(token: string) {
  return `rgb(var(--${token}) / <alpha-value>)`
}

// JetBrains Mono Variable as the single UI typeface. Hierarchy is carried by
// weight (400/500/600/700) + size + tracking, never by a second family. The
// stack falls back through bundled woff2, installed JetBrains Mono, then
// platform mono so a font load failure never produces a system serif.
const MONO_STACK = [
  '"JetBrains Mono Variable"',
  '"JetBrains Mono"',
  'ui-monospace',
  'SFMono-Regular',
  'Menlo',
  'monospace',
]

export default {
  content: ['./src/renderer/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      fontFamily: {
        sans: MONO_STACK,
        mono: MONO_STACK,
      },
      colors: {
        canvas: v('bg-canvas'),
        panel: v('bg-panel'),
        node: v('bg-node'),
        // Card surfaces inside the canvas (ComponentNode etc.) that need to
        // flip from dark to white when the theme switches.
        component: v('bg-component'),
        // xterm wrapper background; flips to white in light mode. The xterm
        // theme itself is updated separately in TerminalPanel/AssistantPanel.
        terminal: v('bg-terminal'),
        'node-border': v('border-node'),
        'node-border-active': v('border-node-active'),
        accent: v('accent'),
        // Semantic text tokens — replace text-white / text-slate-* across the
        // renderer so theme switches don't leak hardcoded chrome colors.
        fg: v('fg'),
        'fg-muted': v('fg-muted'),
        'fg-subtle': v('fg-subtle'),
      }
    }
  },
  plugins: []
} satisfies Config
