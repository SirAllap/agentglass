// Ported from the Mission Control theme system — 22 palettes — 11 dark, each with a light twin.
// Applied as CSS custom properties on :root by applyTheme().

import { SERVER } from "./api.ts";

export interface Theme {
  id: string;
  name: string;
  preview: { primary: string; secondary: string; accent: string };
  vars: Record<string, string>;
}

export const THEMES: Theme[] = [
  { id: "midnight-purple", name: "Midnight Purple", preview: {"primary":"#0f0a1a","secondary":"#1a1333","accent":"#a78bfa"}, vars: {"--bg":"#0f0a1a","--bg2":"#1a1333","--bg3":"#2d1b4e","--bg4":"#3f2766","--text":"#f3e8ff","--text2":"#e9d5ff","--text3":"#d8b4fe","--text4":"#c084fc","--border":"#6d28d9","--border2":"#7e22ce","--primary":"#a78bfa","--primary-hover":"#c4b5fd","--success":"#34d399","--warning":"#fbbf24","--error":"#f472b6","--info":"#a78bfa","--shadow":"rgba(0, 0, 0, 0.8)"} },
  { id: "dark", name: "Dark", preview: {"primary":"#111827","secondary":"#1f2937","accent":"#60a5fa"}, vars: {"--bg":"#111827","--bg2":"#1f2937","--bg3":"#374151","--bg4":"#4b5563","--text":"#f9fafb","--text2":"#e5e7eb","--text3":"#d1d5db","--text4":"#9ca3af","--border":"#374151","--border2":"#4b5563","--primary":"#60a5fa","--primary-hover":"#3b82f6","--success":"#34d399","--warning":"#fbbf24","--error":"#f87171","--info":"#60a5fa","--shadow":"rgba(0, 0, 0, 0.75)"} },
  { id: "dark-blue", name: "Dark Blue", preview: {"primary":"#000033","secondary":"#000066","accent":"#0099ff"}, vars: {"--bg":"#000033","--bg2":"#000066","--bg3":"#000099","--bg4":"#0000cc","--text":"#e6f2ff","--text2":"#ccddff","--text3":"#99bbff","--text4":"#6699ff","--border":"#003366","--border2":"#004499","--primary":"#0099ff","--primary-hover":"#0077cc","--success":"#00ff88","--warning":"#ffaa00","--error":"#ff3366","--info":"#0099ff","--shadow":"rgba(0, 0, 51, 0.9)"} },
  { id: "forest", name: "Forest", preview: {"primary":"#0b1210","secondary":"#12201b","accent":"#34d399"}, vars: {"--bg":"#0b1210","--bg2":"#12201b","--bg3":"#1b3129","--bg4":"#254237","--text":"#ecfdf5","--text2":"#d1fae5","--text3":"#a7f3d0","--text4":"#6ee7b7","--border":"#2f5347","--border2":"#3a6455","--primary":"#34d399","--primary-hover":"#6ee7b7","--success":"#4ade80","--warning":"#fbbf24","--error":"#f87171","--info":"#38bdf8","--shadow":"rgba(0, 0, 0, 0.8)"} },
  { id: "ember", name: "Ember", preview: {"primary":"#140d08","secondary":"#21150d","accent":"#fb923c"}, vars: {"--bg":"#140d08","--bg2":"#21150d","--bg3":"#332114","--bg4":"#452c1a","--text":"#fff7ed","--text2":"#ffedd5","--text3":"#fed7aa","--text4":"#fdba74","--border":"#7c2d12","--border2":"#9a3412","--primary":"#fb923c","--primary-hover":"#fdba74","--success":"#34d399","--warning":"#facc15","--error":"#f87171","--info":"#60a5fa","--shadow":"rgba(0, 0, 0, 0.8)"} },
  { id: "rosewood", name: "Rosewood", preview: {"primary":"#16090f","secondary":"#241019","accent":"#fb7185"}, vars: {"--bg":"#16090f","--bg2":"#241019","--bg3":"#3b1a28","--bg4":"#522437","--text":"#fff1f2","--text2":"#ffe4e6","--text3":"#fecdd3","--text4":"#fda4af","--border":"#881337","--border2":"#9f1239","--primary":"#fb7185","--primary-hover":"#fda4af","--success":"#34d399","--warning":"#fbbf24","--error":"#ef4444","--info":"#60a5fa","--shadow":"rgba(0, 0, 0, 0.8)"} },
  { id: "deep-sea", name: "Deep Sea", preview: {"primary":"#081517","secondary":"#0e2226","accent":"#2dd4bf"}, vars: {"--bg":"#081517","--bg2":"#0e2226","--bg3":"#163439","--bg4":"#1f464d","--text":"#ecfeff","--text2":"#cffafe","--text3":"#a5f3fc","--text4":"#67e8f9","--border":"#155e63","--border2":"#0e7490","--primary":"#2dd4bf","--primary-hover":"#5eead4","--success":"#4ade80","--warning":"#fbbf24","--error":"#fb7185","--info":"#22d3ee","--shadow":"rgba(0, 0, 0, 0.8)"} },
  { id: "nord", name: "Nord", preview: {"primary":"#2e3440","secondary":"#3b4252","accent":"#88c0d0"}, vars: {"--bg":"#2e3440","--bg2":"#3b4252","--bg3":"#434c5e","--bg4":"#4c566a","--text":"#eceff4","--text2":"#e5e9f0","--text3":"#d8dee9","--text4":"#aab4c5","--border":"#4c566a","--border2":"#5e81ac","--primary":"#88c0d0","--primary-hover":"#8fbcbb","--success":"#a3be8c","--warning":"#ebcb8b","--error":"#bf616a","--info":"#81a1c1","--shadow":"rgba(0, 0, 0, 0.6)"} },
  { id: "carbon", name: "Carbon", preview: {"primary":"#0a0a0a","secondary":"#161616","accent":"#d4d4d4"}, vars: {"--bg":"#0a0a0a","--bg2":"#161616","--bg3":"#262626","--bg4":"#363636","--text":"#fafafa","--text2":"#e5e5e5","--text3":"#a3a3a3","--text4":"#737373","--border":"#404040","--border2":"#525252","--primary":"#d4d4d4","--primary-hover":"#fafafa","--success":"#4ade80","--warning":"#facc15","--error":"#f87171","--info":"#60a5fa","--shadow":"rgba(0, 0, 0, 0.9)"} },
  { id: "high-contrast-dark", name: "High Contrast Dark", preview: {"primary":"#000000","secondary":"#0d0d0d","accent":"#ffffff"}, vars: {"--bg":"#000000","--bg2":"#0d0d0d","--bg3":"#1a1a1a","--bg4":"#262626","--text":"#ffffff","--text2":"#ffffff","--text3":"#cccccc","--text4":"#999999","--border":"#ffffff","--border2":"#cccccc","--primary":"#ffffff","--primary-hover":"#cccccc","--success":"#00e676","--warning":"#ffd600","--error":"#ff1744","--info":"#40c4ff","--shadow":"rgba(0, 0, 0, 1)"} },
  { id: "colorblind-dark", name: "Colorblind Dark", preview: {"primary":"#101418","secondary":"#1a2027","accent":"#56b4e9"}, vars: {"--bg":"#101418","--bg2":"#1a2027","--bg3":"#263039","--bg4":"#33404c","--text":"#f8fafc","--text2":"#e2e8f0","--text3":"#cbd5e1","--text4":"#94a3b8","--border":"#475569","--border2":"#64748b","--primary":"#56b4e9","--primary-hover":"#85c8ef","--success":"#009e73","--warning":"#f0e442","--error":"#d55e00","--info":"#0072b2","--shadow":"rgba(0, 0, 0, 0.8)"} },

  // --- light twins: the dark palettes above, adapted to light surfaces ---
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

export const DEFAULT_THEME = "midnight-purple";

export function applyTheme(id: string) {
  const t = THEMES.find((x) => x.id === id) || THEMES[0];
  const root = document.documentElement;
  for (const [k, v] of Object.entries(t.vars)) root.style.setProperty(k, v);
  root.setAttribute("data-theme", t.id);
  try { localStorage.setItem("agentglass-theme", t.id); } catch {}
  /*
   * Carry the palette out to tmux and nvim.
   *
   * Fire-and-forget on purpose: this reaches across to other processes, and
   * none of them are allowed to make changing the app's own theme feel slow or
   * fail. The server writes two files and pushes to any editor it can reach —
   * see server/src/themesync.ts.
   */
  void fetch(`${SERVER}/theme/sync`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: t.name, vars: t.vars }),
  }).catch(() => { /* no server (the static demo), or it declined */ });
}

export function initialTheme(): string {
  try { return localStorage.getItem("agentglass-theme") || DEFAULT_THEME; } catch { return DEFAULT_THEME; }
}
