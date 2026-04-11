import type { Config } from "tailwindcss";

export default {
  content: ["./src/renderer/**/*.{ts,tsx,html}"],
  theme: {
    extend: {
      colors: {
        canvas: "#111111",
        panel: "#191919",
        node: "#212121",
        "node-border": "#2d2d2d",
        "node-border-active": "#5b5bf0",
        accent: "#5b5bf0",
      },
    },
  },
  plugins: [],
} satisfies Config;
