// Applied as CSS custom properties on :root by applyTheme().
//
// The list leads with community-proven palettes — the ones people already read
// code in all day (Catppuccin, GitHub, Tokyo Night, Dracula, One Dark, Gruvbox,
// Solarized) — because the originals here were high-saturation and tiring to
// read against. The house palettes (Midnight Purple, Forest, Ember, …) stay on
// below them; nothing was removed, the good defaults were just moved to the top.
// Grouping into dark/light is by --bg luminance (see ThemeSwitcher), so a new
// entry needs no flag — just put a dark bg in the dark run and a light one below.

import { SERVER, authHeaders, IS_DESKTOP } from "./api.ts";
import type { AnsiPalette } from "./termPalette.ts";

export interface Theme {
  id: string;
  name: string;
  preview: { primary: string; secondary: string; accent: string };
  vars: Record<string, string>;
  /** The terminal's 16-colour palette. Omit it and the terminal derives one
   *  from `vars` (see termPalette.ts); pin it when the canonical palette is
   *  part of the theme's identity, as with Gruvbox, Nord, Solarized, Dracula. */
  ansi?: AnsiPalette;
}

export const THEMES: Theme[] = [
  // --- serious neutral defaults, the pair behind System / Dark / Light ---
  // A faithful port of the palette Orca ships (shadcn's "neutral"): monochrome
  // on purpose — the primary is a grey, not a brand hue — so nothing competes
  // with the work. Semantic colours are the only chroma.
  { id: "orca-dark", name: "Orca Dark", preview: {"primary":"#0a0a0a","secondary":"#171717","accent":"#e5e5e5"}, vars: {"--bg":"#0a0a0a","--bg2":"#171717","--bg3":"#262626","--bg4":"#404040","--text":"#fafafa","--text2":"#d4d4d4","--text3":"#a1a1a1","--text4":"#737373","--border":"#262626","--border2":"#383838","--primary":"#e5e5e5","--primary-hover":"#ffffff","--success":"#86efac","--warning":"#fbbf24","--error":"#ff6568","--info":"#60a5fa","--shadow":"rgba(0, 0, 0, 0.9)"} },
  { id: "orca-light", name: "Orca Light", preview: {"primary":"#ffffff","secondary":"#f5f5f5","accent":"#171717"}, vars: {"--bg":"#ffffff","--bg2":"#fafafa","--bg3":"#f5f5f5","--bg4":"#eaeaea","--text":"#0a0a0a","--text2":"#262626","--text3":"#737373","--text4":"#a1a1a1","--border":"#e5e5e5","--border2":"#d4d4d4","--primary":"#171717","--primary-hover":"#000000","--success":"#15803d","--warning":"#d97706","--error":"#e40014","--info":"#2563eb","--shadow":"rgba(0, 0, 0, 0.12)"} },

  // --- community-proven dark palettes ---
  { id: "github-dark", name: "GitHub Dark", preview: {"primary":"#0d1117","secondary":"#161b22","accent":"#58a6ff"}, vars: {"--bg":"#0d1117","--bg2":"#161b22","--bg3":"#21262d","--bg4":"#30363d","--text":"#e6edf3","--text2":"#c9d1d9","--text3":"#8b949e","--text4":"#6e7681","--border":"#30363d","--border2":"#444c56","--primary":"#58a6ff","--primary-hover":"#79c0ff","--success":"#3fb950","--warning":"#d29922","--error":"#f85149","--info":"#58a6ff","--shadow":"rgba(1, 4, 9, 0.85)"} },
  { id: "github-dark-dimmed", name: "GitHub Dark Dimmed", preview: {"primary":"#22272e","secondary":"#2d333b","accent":"#6cb6ff"}, vars: {"--bg":"#22272e","--bg2":"#2d333b","--bg3":"#373e47","--bg4":"#444c56","--text":"#cdd9e5","--text2":"#adbac7","--text3":"#768390","--text4":"#636e7b","--border":"#444c56","--border2":"#545d68","--primary":"#6cb6ff","--primary-hover":"#96d0ff","--success":"#57ab5a","--warning":"#c69026","--error":"#e5534b","--info":"#6cb6ff","--shadow":"rgba(0, 0, 0, 0.8)"} },
  { id: "catppuccin-mocha", name: "Catppuccin Mocha", preview: {"primary":"#1e1e2e","secondary":"#313244","accent":"#89b4fa"}, vars: {"--bg":"#1e1e2e","--bg2":"#313244","--bg3":"#45475a","--bg4":"#585b70","--text":"#cdd6f4","--text2":"#bac2de","--text3":"#a6adc8","--text4":"#7f849c","--border":"#45475a","--border2":"#585b70","--primary":"#89b4fa","--primary-hover":"#b4befe","--success":"#a6e3a1","--warning":"#f9e2af","--error":"#f38ba8","--info":"#74c7ec","--shadow":"rgba(17, 17, 27, 0.7)"} },
  { id: "catppuccin-macchiato", name: "Catppuccin Macchiato", preview: {"primary":"#24273a","secondary":"#363a4f","accent":"#8aadf4"}, vars: {"--bg":"#24273a","--bg2":"#363a4f","--bg3":"#494d64","--bg4":"#5b6078","--text":"#cad3f5","--text2":"#b8c0e0","--text3":"#a5adcb","--text4":"#8087a2","--border":"#494d64","--border2":"#5b6078","--primary":"#8aadf4","--primary-hover":"#b7bdf8","--success":"#a6da95","--warning":"#eed49f","--error":"#ed8796","--info":"#7dc4e4","--shadow":"rgba(24, 25, 38, 0.7)"} },
  { id: "catppuccin-frappe", name: "Catppuccin Frappé", preview: {"primary":"#303446","secondary":"#414559","accent":"#8caaee"}, vars: {"--bg":"#303446","--bg2":"#414559","--bg3":"#51576d","--bg4":"#626880","--text":"#c6d0f5","--text2":"#b5bfe2","--text3":"#a5adce","--text4":"#838ba7","--border":"#51576d","--border2":"#626880","--primary":"#8caaee","--primary-hover":"#babbf1","--success":"#a6d189","--warning":"#e5c890","--error":"#e78284","--info":"#85c1dc","--shadow":"rgba(35, 38, 52, 0.7)"} },
  { id: "tokyo-night", name: "Tokyo Night", preview: {"primary":"#1a1b26","secondary":"#24283b","accent":"#7aa2f7"}, vars: {"--bg":"#1a1b26","--bg2":"#24283b","--bg3":"#292e42","--bg4":"#414868","--text":"#c0caf5","--text2":"#a9b1d6","--text3":"#828bb8","--text4":"#565f89","--border":"#292e42","--border2":"#414868","--primary":"#7aa2f7","--primary-hover":"#9eb6ff","--success":"#9ece6a","--warning":"#e0af68","--error":"#f7768e","--info":"#7dcfff","--shadow":"rgba(0, 0, 0, 0.75)"} },
  { id: "dracula", name: "Dracula", preview: {"primary":"#282a36","secondary":"#343746","accent":"#bd93f9"}, vars: {"--bg":"#282a36","--bg2":"#343746","--bg3":"#44475a","--bg4":"#565872","--text":"#f8f8f2","--text2":"#e2e2dc","--text3":"#a8abbd","--text4":"#6272a4","--border":"#44475a","--border2":"#565872","--primary":"#bd93f9","--primary-hover":"#d6b3ff","--success":"#50fa7b","--warning":"#f1fa8c","--error":"#ff5555","--info":"#8be9fd","--shadow":"rgba(0, 0, 0, 0.8)"}, ansi: {"black":"#21222c","red":"#ff5555","green":"#50fa7b","yellow":"#f1fa8c","blue":"#bd93f9","magenta":"#ff79c6","cyan":"#8be9fd","white":"#f8f8f2","brightBlack":"#6272a4","brightRed":"#ff6e6e","brightGreen":"#69ff94","brightYellow":"#ffffa5","brightBlue":"#d6acff","brightMagenta":"#ff92df","brightCyan":"#a4ffff","brightWhite":"#ffffff"} },
  { id: "one-dark", name: "One Dark", preview: {"primary":"#282c34","secondary":"#2c313c","accent":"#61afef"}, vars: {"--bg":"#282c34","--bg2":"#2c313c","--bg3":"#3b4048","--bg4":"#4b5263","--text":"#abb2bf","--text2":"#9da5b4","--text3":"#7f848e","--text4":"#5c6370","--border":"#3b4048","--border2":"#4b5263","--primary":"#61afef","--primary-hover":"#82c4ff","--success":"#98c379","--warning":"#e5c07b","--error":"#e06c75","--info":"#56b6c2","--shadow":"rgba(0, 0, 0, 0.75)"} },
  { id: "gruvbox-dark", name: "Gruvbox Dark", preview: {"primary":"#282828","secondary":"#3c3836","accent":"#fe8019"}, vars: {"--bg":"#282828","--bg2":"#3c3836","--bg3":"#504945","--bg4":"#665c54","--text":"#ebdbb2","--text2":"#d5c4a1","--text3":"#bdae93","--text4":"#928374","--border":"#504945","--border2":"#665c54","--primary":"#fe8019","--primary-hover":"#fabd2f","--success":"#b8bb26","--warning":"#fabd2f","--error":"#fb4934","--info":"#83a598","--shadow":"rgba(0, 0, 0, 0.85)"}, ansi: {"black":"#282828","red":"#cc241d","green":"#98971a","yellow":"#d79921","blue":"#458588","magenta":"#b16286","cyan":"#689d6a","white":"#a89984","brightBlack":"#928374","brightRed":"#fb4934","brightGreen":"#b8bb26","brightYellow":"#fabd2f","brightBlue":"#83a598","brightMagenta":"#d3869b","brightCyan":"#8ec07c","brightWhite":"#ebdbb2"} },
  { id: "solarized-dark", name: "Solarized Dark", preview: {"primary":"#002b36","secondary":"#073642","accent":"#268bd2"}, vars: {"--bg":"#002b36","--bg2":"#073642","--bg3":"#0d4b5a","--bg4":"#14606f","--text":"#93a1a1","--text2":"#839496","--text3":"#657b83","--text4":"#586e75","--border":"#0f4a58","--border2":"#1a6472","--primary":"#268bd2","--primary-hover":"#4ba6e8","--success":"#859900","--warning":"#b58900","--error":"#dc322f","--info":"#2aa198","--shadow":"rgba(0, 0, 0, 0.7)"}, ansi: {"black":"#073642","red":"#dc322f","green":"#859900","yellow":"#b58900","blue":"#268bd2","magenta":"#d33682","cyan":"#2aa198","white":"#eee8d5","brightBlack":"#002b36","brightRed":"#cb4b16","brightGreen":"#586e75","brightYellow":"#657b83","brightBlue":"#839496","brightMagenta":"#6c71c4","brightCyan":"#93a1a1","brightWhite":"#fdf6e3"} },

  // --- house dark palettes ---
  { id: "midnight-purple", name: "Midnight Purple", preview: {"primary":"#0f0a1a","secondary":"#1a1333","accent":"#a78bfa"}, vars: {"--bg":"#0f0a1a","--bg2":"#1a1333","--bg3":"#2d1b4e","--bg4":"#3f2766","--text":"#f3e8ff","--text2":"#e9d5ff","--text3":"#d8b4fe","--text4":"#c084fc","--border":"#6d28d9","--border2":"#7e22ce","--primary":"#a78bfa","--primary-hover":"#c4b5fd","--success":"#34d399","--warning":"#fbbf24","--error":"#f472b6","--info":"#a78bfa","--shadow":"rgba(0, 0, 0, 0.8)"} },
  { id: "dark", name: "Dark", preview: {"primary":"#111827","secondary":"#1f2937","accent":"#60a5fa"}, vars: {"--bg":"#111827","--bg2":"#1f2937","--bg3":"#374151","--bg4":"#4b5563","--text":"#f9fafb","--text2":"#e5e7eb","--text3":"#d1d5db","--text4":"#9ca3af","--border":"#374151","--border2":"#4b5563","--primary":"#60a5fa","--primary-hover":"#3b82f6","--success":"#34d399","--warning":"#fbbf24","--error":"#f87171","--info":"#60a5fa","--shadow":"rgba(0, 0, 0, 0.75)"} },
  { id: "dark-blue", name: "Dark Blue", preview: {"primary":"#000033","secondary":"#000066","accent":"#0099ff"}, vars: {"--bg":"#000033","--bg2":"#000066","--bg3":"#000099","--bg4":"#0000cc","--text":"#e6f2ff","--text2":"#ccddff","--text3":"#99bbff","--text4":"#6699ff","--border":"#003366","--border2":"#004499","--primary":"#0099ff","--primary-hover":"#0077cc","--success":"#00ff88","--warning":"#ffaa00","--error":"#ff3366","--info":"#0099ff","--shadow":"rgba(0, 0, 51, 0.9)"} },
  { id: "forest", name: "Forest", preview: {"primary":"#0b1210","secondary":"#12201b","accent":"#34d399"}, vars: {"--bg":"#0b1210","--bg2":"#12201b","--bg3":"#1b3129","--bg4":"#254237","--text":"#ecfdf5","--text2":"#d1fae5","--text3":"#a7f3d0","--text4":"#6ee7b7","--border":"#2f5347","--border2":"#3a6455","--primary":"#34d399","--primary-hover":"#6ee7b7","--success":"#4ade80","--warning":"#fbbf24","--error":"#f87171","--info":"#38bdf8","--shadow":"rgba(0, 0, 0, 0.8)"} },
  { id: "ember", name: "Ember", preview: {"primary":"#140d08","secondary":"#21150d","accent":"#fb923c"}, vars: {"--bg":"#140d08","--bg2":"#21150d","--bg3":"#332114","--bg4":"#452c1a","--text":"#fff7ed","--text2":"#ffedd5","--text3":"#fed7aa","--text4":"#fdba74","--border":"#7c2d12","--border2":"#9a3412","--primary":"#fb923c","--primary-hover":"#fdba74","--success":"#34d399","--warning":"#facc15","--error":"#f87171","--info":"#60a5fa","--shadow":"rgba(0, 0, 0, 0.8)"} },
  { id: "rosewood", name: "Rosewood", preview: {"primary":"#16090f","secondary":"#241019","accent":"#fb7185"}, vars: {"--bg":"#16090f","--bg2":"#241019","--bg3":"#3b1a28","--bg4":"#522437","--text":"#fff1f2","--text2":"#ffe4e6","--text3":"#fecdd3","--text4":"#fda4af","--border":"#881337","--border2":"#9f1239","--primary":"#fb7185","--primary-hover":"#fda4af","--success":"#34d399","--warning":"#fbbf24","--error":"#ef4444","--info":"#60a5fa","--shadow":"rgba(0, 0, 0, 0.8)"} },
  { id: "deep-sea", name: "Deep Sea", preview: {"primary":"#081517","secondary":"#0e2226","accent":"#2dd4bf"}, vars: {"--bg":"#081517","--bg2":"#0e2226","--bg3":"#163439","--bg4":"#1f464d","--text":"#ecfeff","--text2":"#cffafe","--text3":"#a5f3fc","--text4":"#67e8f9","--border":"#155e63","--border2":"#0e7490","--primary":"#2dd4bf","--primary-hover":"#5eead4","--success":"#4ade80","--warning":"#fbbf24","--error":"#fb7185","--info":"#22d3ee","--shadow":"rgba(0, 0, 0, 0.8)"} },
  { id: "nord", name: "Nord", preview: {"primary":"#2e3440","secondary":"#3b4252","accent":"#88c0d0"}, vars: {"--bg":"#2e3440","--bg2":"#3b4252","--bg3":"#434c5e","--bg4":"#4c566a","--text":"#eceff4","--text2":"#e5e9f0","--text3":"#d8dee9","--text4":"#aab4c5","--border":"#4c566a","--border2":"#5e81ac","--primary":"#88c0d0","--primary-hover":"#8fbcbb","--success":"#a3be8c","--warning":"#ebcb8b","--error":"#bf616a","--info":"#81a1c1","--shadow":"rgba(0, 0, 0, 0.6)"}, ansi: {"black":"#3b4252","red":"#bf616a","green":"#a3be8c","yellow":"#ebcb8b","blue":"#81a1c1","magenta":"#b48ead","cyan":"#88c0d0","white":"#e5e9f0","brightBlack":"#4c566a","brightRed":"#bf616a","brightGreen":"#a3be8c","brightYellow":"#ebcb8b","brightBlue":"#81a1c1","brightMagenta":"#b48ead","brightCyan":"#8fbcbb","brightWhite":"#eceff4"} },
  { id: "carbon", name: "Carbon", preview: {"primary":"#0a0a0a","secondary":"#161616","accent":"#d4d4d4"}, vars: {"--bg":"#0a0a0a","--bg2":"#161616","--bg3":"#262626","--bg4":"#363636","--text":"#fafafa","--text2":"#e5e5e5","--text3":"#a3a3a3","--text4":"#8a8a8a","--border":"#404040","--border2":"#525252","--primary":"#d4d4d4","--primary-hover":"#fafafa","--success":"#4ade80","--warning":"#facc15","--error":"#f87171","--info":"#60a5fa","--shadow":"rgba(0, 0, 0, 0.9)"} },
  { id: "high-contrast-dark", name: "High Contrast Dark", preview: {"primary":"#000000","secondary":"#0d0d0d","accent":"#ffffff"}, vars: {"--bg":"#000000","--bg2":"#0d0d0d","--bg3":"#1a1a1a","--bg4":"#262626","--text":"#ffffff","--text2":"#ffffff","--text3":"#cccccc","--text4":"#999999","--border":"#ffffff","--border2":"#cccccc","--primary":"#ffffff","--primary-hover":"#cccccc","--success":"#00e676","--warning":"#ffd600","--error":"#ff1744","--info":"#40c4ff","--shadow":"rgba(0, 0, 0, 1)"} },
  { id: "colorblind-dark", name: "Colorblind Dark", preview: {"primary":"#101418","secondary":"#1a2027","accent":"#56b4e9"}, vars: {"--bg":"#101418","--bg2":"#1a2027","--bg3":"#263039","--bg4":"#33404c","--text":"#f8fafc","--text2":"#e2e8f0","--text3":"#cbd5e1","--text4":"#94a3b8","--border":"#475569","--border2":"#64748b","--primary":"#56b4e9","--primary-hover":"#85c8ef","--success":"#009e73","--warning":"#f0e442","--error":"#d55e00","--info":"#0072b2","--shadow":"rgba(0, 0, 0, 0.8)"} },

  // --- community-proven light palettes ---
  { id: "github-light", name: "GitHub Light", preview: {"primary":"#ffffff","secondary":"#f6f8fa","accent":"#0969da"}, vars: {"--bg":"#ffffff","--bg2":"#f6f8fa","--bg3":"#eaeef2","--bg4":"#d0d7de","--text":"#1f2328","--text2":"#414852","--text3":"#656d76","--text4":"#8c959f","--border":"#d0d7de","--border2":"#afb8c1","--primary":"#0969da","--primary-hover":"#0550ae","--success":"#1a7f37","--warning":"#9a6700","--error":"#cf222e","--info":"#0969da","--shadow":"rgba(31, 35, 40, 0.15)"} },
  { id: "catppuccin-latte", name: "Catppuccin Latte", preview: {"primary":"#eff1f5","secondary":"#e6e9ef","accent":"#1e66f5"}, vars: {"--bg":"#eff1f5","--bg2":"#e6e9ef","--bg3":"#dce0e8","--bg4":"#ccd0da","--text":"#4c4f69","--text2":"#5c5f77","--text3":"#6c6f85","--text4":"#8c8fa1","--border":"#ccd0da","--border2":"#bcc0cc","--primary":"#1e66f5","--primary-hover":"#0b57d0","--success":"#40a02b","--warning":"#df8e1d","--error":"#d20f39","--info":"#179299","--shadow":"rgba(76, 79, 105, 0.15)"} },
  { id: "solarized-light", name: "Solarized Light", preview: {"primary":"#fdf6e3","secondary":"#eee8d5","accent":"#268bd2"}, vars: {"--bg":"#fdf6e3","--bg2":"#eee8d5","--bg3":"#e3ddc9","--bg4":"#d3ceb8","--text":"#586e75","--text2":"#657b83","--text3":"#839496","--text4":"#93a1a1","--border":"#ddd6c1","--border2":"#c9c2ad","--primary":"#268bd2","--primary-hover":"#1a6fad","--success":"#859900","--warning":"#b58900","--error":"#dc322f","--info":"#2aa198","--shadow":"rgba(88, 110, 117, 0.15)"}, ansi: {"black":"#073642","red":"#dc322f","green":"#859900","yellow":"#b58900","blue":"#268bd2","magenta":"#d33682","cyan":"#2aa198","white":"#eee8d5","brightBlack":"#002b36","brightRed":"#cb4b16","brightGreen":"#586e75","brightYellow":"#657b83","brightBlue":"#839496","brightMagenta":"#6c71c4","brightCyan":"#93a1a1","brightWhite":"#fdf6e3"} },

  // --- house light twins: the dark palettes above, adapted to light surfaces ---
  { id: "midnight-purple-light", name: "Midnight Purple Light", preview: {"primary":"#faf5ff","secondary":"#f3e8ff","accent":"#7c3aed"}, vars: {"--bg":"#faf5ff","--bg2":"#f3e8ff","--bg3":"#e9d5ff","--bg4":"#d8b4fe","--text":"#2e1065","--text2":"#4c1d95","--text3":"#6d28d9","--text4":"#7c3aed","--border":"#d8b4fe","--border2":"#c084fc","--primary":"#7c3aed","--primary-hover":"#6d28d9","--success":"#059669","--warning":"#d97706","--error":"#db2777","--info":"#7c3aed","--shadow":"rgba(109, 40, 217, 0.25)"} },
  { id: "light", name: "Light", preview: {"primary":"#ffffff","secondary":"#f9fafb","accent":"#3b82f6"}, vars: {"--bg":"#ffffff","--bg2":"#f9fafb","--bg3":"#f3f4f6","--bg4":"#e5e7eb","--text":"#111827","--text2":"#374151","--text3":"#6b7280","--text4":"#9ca3af","--border":"#e5e7eb","--border2":"#d1d5db","--primary":"#3b82f6","--primary-hover":"#2563eb","--success":"#10b981","--warning":"#f59e0b","--error":"#ef4444","--info":"#3b82f6","--shadow":"rgba(0, 0, 0, 0.25)"} },
  { id: "blue-light", name: "Blue Light", preview: {"primary":"#eff6ff","secondary":"#dbeafe","accent":"#1d4ed8"}, vars: {"--bg":"#eff6ff","--bg2":"#dbeafe","--bg3":"#bfdbfe","--bg4":"#93c5fd","--text":"#172554","--text2":"#1e3a8a","--text3":"#1d4ed8","--text4":"#2563eb","--border":"#bfdbfe","--border2":"#93c5fd","--primary":"#1d4ed8","--primary-hover":"#1e40af","--success":"#059669","--warning":"#d97706","--error":"#dc2626","--info":"#1d4ed8","--shadow":"rgba(29, 78, 216, 0.25)"} },
  { id: "forest-light", name: "Forest Light", preview: {"primary":"#f0fdf4","secondary":"#dcfce7","accent":"#059669"}, vars: {"--bg":"#f0fdf4","--bg2":"#dcfce7","--bg3":"#bbf7d0","--bg4":"#86efac","--text":"#052e16","--text2":"#14532d","--text3":"#166534","--text4":"#15803d","--border":"#bbf7d0","--border2":"#86efac","--primary":"#059669","--primary-hover":"#047857","--success":"#16a34a","--warning":"#d97706","--error":"#dc2626","--info":"#0284c7","--shadow":"rgba(5, 150, 105, 0.25)"} },
  { id: "ember-light", name: "Ember Light", preview: {"primary":"#fff7ed","secondary":"#ffedd5","accent":"#ea580c"}, vars: {"--bg":"#fff7ed","--bg2":"#ffedd5","--bg3":"#fed7aa","--bg4":"#fdba74","--text":"#431407","--text2":"#7c2d12","--text3":"#9a3412","--text4":"#c2410c","--border":"#fed7aa","--border2":"#fdba74","--primary":"#ea580c","--primary-hover":"#c2410c","--success":"#059669","--warning":"#ca8a04","--error":"#dc2626","--info":"#2563eb","--shadow":"rgba(234, 88, 12, 0.25)"} },
  { id: "rosewood-light", name: "Rosewood Light", preview: {"primary":"#fff1f2","secondary":"#ffe4e6","accent":"#e11d48"}, vars: {"--bg":"#fff1f2","--bg2":"#ffe4e6","--bg3":"#fecdd3","--bg4":"#fda4af","--text":"#4c0519","--text2":"#881337","--text3":"#9f1239","--text4":"#be123c","--border":"#fecdd3","--border2":"#fda4af","--primary":"#e11d48","--primary-hover":"#be123c","--success":"#059669","--warning":"#d97706","--error":"#b91c1c","--info":"#2563eb","--shadow":"rgba(225, 29, 72, 0.25)"} },
  { id: "deep-sea-light", name: "Deep Sea Light", preview: {"primary":"#ecfeff","secondary":"#cffafe","accent":"#0d9488"}, vars: {"--bg":"#ecfeff","--bg2":"#cffafe","--bg3":"#a5f3fc","--bg4":"#67e8f9","--text":"#083344","--text2":"#155e75","--text3":"#0e7490","--text4":"#0891b2","--border":"#a5f3fc","--border2":"#67e8f9","--primary":"#0d9488","--primary-hover":"#0f766e","--success":"#059669","--warning":"#d97706","--error":"#dc2626","--info":"#0891b2","--shadow":"rgba(13, 148, 136, 0.25)"} },
  { id: "nord-light", name: "Nord Light", preview: {"primary":"#eceff4","secondary":"#e5e9f0","accent":"#5e81ac"}, vars: {"--bg":"#eceff4","--bg2":"#e5e9f0","--bg3":"#d8dee9","--bg4":"#c2cbd8","--text":"#2e3440","--text2":"#3b4252","--text3":"#434c5e","--text4":"#4c566a","--border":"#d8dee9","--border2":"#aab4c5","--primary":"#5e81ac","--primary-hover":"#4c6a91","--success":"#6e8a52","--warning":"#b08b3a","--error":"#bf616a","--info":"#5e81ac","--shadow":"rgba(46, 52, 64, 0.25)"} },
  { id: "paper", name: "Paper", preview: {"primary":"#fafafa","secondary":"#f5f5f5","accent":"#171717"}, vars: {"--bg":"#fafafa","--bg2":"#f5f5f5","--bg3":"#e5e5e5","--bg4":"#d4d4d4","--text":"#0a0a0a","--text2":"#262626","--text3":"#525252","--text4":"#737373","--border":"#d4d4d4","--border2":"#a3a3a3","--primary":"#171717","--primary-hover":"#404040","--success":"#15803d","--warning":"#a16207","--error":"#b91c1c","--info":"#1d4ed8","--shadow":"rgba(0, 0, 0, 0.2)"} },
  { id: "high-contrast", name: "High Contrast Light", preview: {"primary":"#ffffff","secondary":"#f0f0f0","accent":"#000000"}, vars: {"--bg":"#ffffff","--bg2":"#f0f0f0","--bg3":"#e0e0e0","--bg4":"#d0d0d0","--text":"#000000","--text2":"#000000","--text3":"#333333","--text4":"#666666","--border":"#000000","--border2":"#333333","--primary":"#000000","--primary-hover":"#333333","--success":"#008000","--warning":"#ff8c00","--error":"#ff0000","--info":"#0000ff","--shadow":"rgba(0, 0, 0, 0.6)"} },
  { id: "colorblind-friendly", name: "Colorblind Light", preview: {"primary":"#f8fafc","secondary":"#e2e8f0","accent":"#0072b2"}, vars: {"--bg":"#f8fafc","--bg2":"#eef2f7","--bg3":"#e2e8f0","--bg4":"#cbd5e1","--text":"#0f172a","--text2":"#1e293b","--text3":"#334155","--text4":"#64748b","--border":"#cbd5e1","--border2":"#94a3b8","--primary":"#0072b2","--primary-hover":"#005a8e","--success":"#009e73","--warning":"#e69f00","--error":"#d55e00","--info":"#56b4e9","--shadow":"rgba(15, 23, 42, 0.25)"} },
];

export const DEFAULT_THEME = "github-dark";

/**
 * The decorative and second-flavour palettes, demoted behind a "more themes"
 * disclosure in the picker — kept for tinkering, never removed. Anything NOT in
 * this set is a curated default, so a new serious theme shows up front with no
 * extra flag, the same way the rest of this file avoids per-theme booleans.
 */
export const EXPERIMENTAL_THEME_IDS = new Set<string>([
  "github-dark-dimmed", "catppuccin-macchiato", "catppuccin-frappe",
  "midnight-purple", "dark", "dark-blue", "forest", "ember", "rosewood", "deep-sea",
  "midnight-purple-light", "light", "blue-light", "forest-light", "ember-light",
  "rosewood-light", "deep-sea-light", "nord-light",
  // The old neutral pair — superseded as defaults by Orca Dark/Light, kept here.
  "carbon", "paper",
]);

/** Dark by the luminance of its background — no per-theme flag needed. Shared by
 *  the picker to split each list into a dark run and a light one. */
export function isDarkTheme(t: Theme): boolean {
  const hex = (t.vars["--bg"] ?? "#000").replace("#", "");
  const v = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
  const n = parseInt(v, 16);
  return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255) < 128;
}

/**
 * Paint the app in a theme.
 *
 * `sync` carries the palette out to tmux and nvim, and defaults to off because
 * the files it writes are machine-global while the choice that drives it is
 * per-browser. Only a deliberate pick may broadcast — see `pickTheme`.
 */
export function applyTheme(id: string, { sync = false } = {}) {
  const known = THEMES.find((x) => x.id === id);
  const t = known || THEMES[0];
  const root = document.documentElement;
  for (const [k, v] of Object.entries(t.vars)) root.style.setProperty(k, v);
  root.setAttribute("data-theme", t.id);
  // Only ever persist a theme that exists. An id we don't recognise still gets
  // painted in the fallback, but writing that fallback back to storage would
  // turn one bad read into the permanent loss of a real choice.
  if (known) { try { localStorage.setItem("agentglass-theme", t.id); } catch {} }
  if (sync) syncTheme(t);
}

/**
 * The user picked a theme, so tell the rest of the machine.
 *
 * Fire-and-forget on purpose: this reaches across to other processes, and none
 * of them are allowed to make changing the app's own theme feel slow or fail.
 * The server writes two files and pushes to any editor it can reach — see
 * server/src/themesync.ts.
 */
export function pickTheme(id: string) {
  applyTheme(id, { sync: true });
}

function syncTheme(t: Theme) {
  // authHeaders, not a bare content-type: `/theme/sync` sits behind the same
  // token gate as every other route, so a token-protected server (any box with
  // remote access on) answered 401 and dropped the sync on the floor. Without
  // this, tmux and nvim silently kept whatever palette was last written while a
  // token was not yet required — days stale, and never a visible error.
  void fetch(`${SERVER}/theme/sync`, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ name: t.name, vars: t.vars }),
  }).catch(() => { /* no server (the static demo), or it declined */ });
}

/* System / Dark / Light — the mode toggle above the palette grid.
 *
 * "system" tracks the OS and flips between the two serious neutral defaults;
 * "dark"/"light" pin one of them; picking any named palette from the grid drops
 * the mode to "custom". The chosen theme id is still what gets persisted and
 * applied — the mode is a thin layer over it, remembered so a system-mode user
 * boots into the palette the OS is on right now, not the one it was on last. */
export type ThemeMode = "system" | "dark" | "light" | "custom";
export const SERIOUS_DARK = "orca-dark";
export const SERIOUS_LIGHT = "orca-light";
const MODE_KEY = "agentglass-theme-mode";

export function themeMode(): ThemeMode {
  try { const m = localStorage.getItem(MODE_KEY); if (m === "system" || m === "dark" || m === "light") return m; } catch {}
  return "custom";
}

function systemIsDark(): boolean {
  try { return window.matchMedia("(prefers-color-scheme: dark)").matches; } catch { return true; }
}

/** The theme id a mode resolves to right now (null for "custom"). */
export function resolveThemeMode(mode: ThemeMode): string | null {
  if (mode === "dark") return SERIOUS_DARK;
  if (mode === "light") return SERIOUS_LIGHT;
  if (mode === "system") return systemIsDark() ? SERIOUS_DARK : SERIOUS_LIGHT;
  return null;
}

/** Remember the mode without re-applying — used when a grid pick is itself one
 *  of the serious pair, so the segment stays in step without a double paint. */
export function persistThemeMode(mode: ThemeMode): void {
  try { if (mode === "custom") localStorage.removeItem(MODE_KEY); else localStorage.setItem(MODE_KEY, mode); } catch {}
}

/** Choose System/Dark/Light: remember it and apply the matching serious theme.
 *  Returns the applied id so the caller can keep its own state in step. */
export function applyThemeMode(mode: ThemeMode): string | null {
  persistThemeMode(mode);
  const id = resolveThemeMode(mode);
  if (id) pickTheme(id);
  return id;
}

/** Re-apply on OS change while in system mode. Call once at boot. */
export function watchSystemTheme(): void {
  try {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
      if (themeMode() !== "system") return;
      applyTheme(systemIsDark() ? SERIOUS_DARK : SERIOUS_LIGHT, { sync: IS_DESKTOP });
    });
  } catch { /* no matchMedia (headless) */ }
}

export function initialTheme(): string {
  // System mode resolves live off the OS; pinned modes and custom picks are
  // whatever was last written to the theme key (applyThemeMode/pickTheme wrote it).
  if (themeMode() === "system") return resolveThemeMode("system") ?? DEFAULT_THEME;
  try { return localStorage.getItem("agentglass-theme") || DEFAULT_THEME; } catch { return DEFAULT_THEME; }
}

/**
 * Follow the theme when another document of ours changes it.
 *
 * `storage` only fires in the OTHER documents on this origin, which is exactly
 * the case worth handling: a second tab, and the landing page, which picks a
 * phosphor for the demo it is showing behind the glass and writes it to the
 * same key this app reads. Without this the frame kept whatever palette it
 * booted in and the page had two colour schemes on screen at once.
 *
 * Never syncs outward: this document did not make the choice, so it has no
 * business telling tmux and nvim about it.
 */
export function watchThemeStorage() {
  addEventListener("storage", (e) => {
    if (e.key !== "agentglass-theme" || !e.newValue) return;
    if (document.documentElement.getAttribute("data-theme") === e.newValue) return;
    applyTheme(e.newValue);
  });
}
