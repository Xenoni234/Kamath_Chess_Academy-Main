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
        kca: {
          black: "#050505",
          surface: "#0D0D0D",
          "surface-2": "#141414",
          "surface-3": "#1C1C1C",
          border: "#1F1F1F",
          "border-bright": "#2D2D2D",
          cyan: "#00C8E8",
          "cyan-bright": "#29D8ED",
          "cyan-dim": "#0099B2",
          white: "#FFFFFF",
          "gray-100": "#E0E0E0",
          "gray-400": "#888888",
          "gray-600": "#444444",
          success: "#22C55E",
          warning: "#F59E0B",
          danger: "#EF4444",
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
