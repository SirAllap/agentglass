/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      // "tall" = wide AND tall enough to pack the whole cockpit into the
      // viewport. Below it (short laptops) the dashboard scrolls with readable
      // panel heights instead of cramming everything into the fold.
      screens: {
        tall: { raw: "(min-width: 1280px) and (min-height: 860px)" },
      },
      fontFamily: {
        // The whole app is set in this, so it is the one that decides how
        // agentglass reads. The order is the platform's own monospace first —
        // SF Mono on a Mac, whatever `ui-monospace` resolves to elsewhere —
        // rather than a bundled personality. Nerd Font sits at the back purely
        // for glyph coverage: an agent CLI prints powerline and icon
        // codepoints that a stock monospace does not carry, and per-glyph
        // fallback means those come from it while the letters do not.
        mono: [
          "SF Mono", "SFMono-Regular", "ui-monospace", "Cascadia Code", "Menlo", "Consolas",
          "Liberation Mono", "JetBrainsMono Nerd Font Mono", "monospace",
        ],
        // Section titles pair a clean sans against the mono data for hierarchy.
        sans: ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "Helvetica", "Arial", "sans-serif"],
      },
      colors: {
        // Mission-Control violet/indigo palette
        void: {
          950: "#08060f",
          900: "#0d0a1a",
          850: "#120e22",
          800: "#181330",
          700: "#241b47",
          600: "#33285f",
          500: "#463a7a",
        },
        glow: {
          DEFAULT: "#a78bfa",
          bright: "#c4b5fd",
          deep: "#7c3aed",
        },
        live: "#34d399",
        warn: "#fbbf24",
        bad: "#f87171",
      },
      boxShadow: {
        card: "0 0 0 1px rgba(124,58,237,0.18), 0 8px 30px -12px rgba(124,58,237,0.35)",
        glow: "0 0 20px -2px rgba(167,139,250,0.5)",
      },
      keyframes: {
        "slide-in": {
          "0%": { opacity: "0", transform: "translateX(-8px)" },
          "100%": { opacity: "1", transform: "translateX(0)" },
        },
        sweep: { "0%": { transform: "rotate(0deg)" }, "100%": { transform: "rotate(360deg)" } },
        "pulse-ring": {
          "0%": { transform: "scale(0.7)", opacity: "0.7" },
          "100%": { transform: "scale(2.2)", opacity: "0" },
        },
        flicker: { "0%,100%": { opacity: "1" }, "50%": { opacity: "0.55" } },
        rise: { "0%": { transform: "scaleY(0.3)", opacity: "0.4" }, "100%": { transform: "scaleY(1)", opacity: "1" } },
      },
      animation: {
        "slide-in": "slide-in 0.28s cubic-bezier(0.2,0.8,0.2,1)",
        sweep: "sweep 4s linear infinite",
        "pulse-ring": "pulse-ring 1.8s ease-out infinite",
        flicker: "flicker 2.4s ease-in-out infinite",
        rise: "rise 0.4s ease-out",
      },
    },
  },
  plugins: [],
};
