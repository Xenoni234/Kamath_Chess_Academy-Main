import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Values are driven by CSS variables (see globals.css) so the palette
        // can switch between dark (default) and light themes at runtime. Opacity
        // modifiers (e.g. bg-kca-cyan/25) work because Tailwind v4 uses color-mix.
        kca: {
          black: "var(--kca-black)",
          surface: "var(--kca-surface)",
          "surface-2": "var(--kca-surface-2)",
          "surface-3": "var(--kca-surface-3)",
          border: "var(--kca-border)",
          "border-bright": "var(--kca-border-bright)",
          cyan: "var(--kca-cyan)",
          "cyan-bright": "var(--kca-cyan-bright)",
          "cyan-dim": "var(--kca-cyan-dim)",
          white: "var(--kca-white)",
          "gray-100": "var(--kca-gray-100)",
          "gray-400": "var(--kca-gray-400)",
          "gray-600": "var(--kca-gray-600)",
          success: "var(--kca-success)",
          warning: "var(--kca-warning)",
          danger: "var(--kca-danger)",
        },
      },
      fontFamily: {
        sans: ["var(--font-inter)", "sans-serif"],
        display: ["var(--font-space-grotesk)", "sans-serif"],
        mono: ["var(--font-jetbrains-mono)", "monospace"],
      },
      boxShadow: {
        "cyan-sm": "0 0 20px rgba(0,200,232,0.10)",
        "cyan-md": "0 0 40px rgba(0,200,232,0.15)",
      },
    },
  },
  plugins: [],
};

export default config;
