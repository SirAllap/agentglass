/*
 * What a person chose for how one file or folder looks in the finder: a colour,
 * an icon from Strata's sixteen, or an emoji. Kept on this machine, in this
 * browser, by absolute path, like the pins: it is taste, not state anybody else
 * needs, and it never touches the file. The ceiling is only there so a script
 * cannot grow it without end.
 */
export const STYLE_KEY = "agentglass.finder.styles";
export const STYLE_MAX = 500;

/** Strata's colour row, in its order; null is "no colour: the icon's own". */
export const STYLE_COLORS = [
  { id: "red", hex: "#e5484d" }, { id: "orange", hex: "#f76b15" }, { id: "amber", hex: "#e5a50a" }, { id: "green", hex: "#30a46c" },
  { id: "blue", hex: "#0090ff" }, { id: "purple", hex: "#8e4ec6" }, { id: "grey", hex: "#8b8d98" },
] as const;
/** Strata's sixteen icons, as the names of its drawings. */
export const STYLE_ICONS = [
  "file-text", "download", "file-code", "folder-archive", "image", "video", "terminal", "house",
  "hard-drive", "network", "monitor", "key-round", "pin", "play", "settings", "list-checks",
] as const;

export interface ItemStyle { color?: string; icon?: string; emoji?: string }
export type Styles = Record<string, ItemStyle>;

const HEX = /^#[0-9a-fA-F]{6}$/;
const graphemes = (s: string): string[] => (typeof Intl !== "undefined" && "Segmenter" in Intl ? [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)].map((x) => x.segment) : [...s]);
/** One emoji: a single grapheme that is not a letter, a digit or a space. */
export const isEmoji = (s: string): boolean => { const g = graphemes(s.trim()); return g.length === 1 && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(g[0]!); };

export function cleanStyle(v: unknown): ItemStyle | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const s: ItemStyle = {};
  if (typeof o.color === "string" && HEX.test(o.color)) s.color = o.color.toLowerCase();
  if (typeof o.icon === "string" && (STYLE_ICONS as readonly string[]).includes(o.icon)) s.icon = o.icon;
  if (typeof o.emoji === "string" && isEmoji(o.emoji)) s.emoji = o.emoji.trim();
  return s.color || s.icon || s.emoji ? s : null;
}

export function readStyles(raw: string | null): Styles {
  if (!raw) return {};
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return {}; }
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Styles = {};
  for (const [k, x] of Object.entries(v)) {
    if (!k.startsWith("/") || k === "/") continue;
    const s = cleanStyle(x);
    if (s) out[k] = s;
    if (Object.keys(out).length >= STYLE_MAX) break;
  }
  return out;
}

/** The styles with `paths` set to `style` (an empty one clears them). An icon and an emoji exclude each other: the last one chosen wins. A full store keeps what it has. */
export function applyStyle(styles: Styles, paths: readonly string[], style: ItemStyle): Styles {
  const next = { ...styles };
  const clean = cleanStyle(style);
  for (const p of paths) {
    if (!clean) delete next[p];
    else if (p in next || Object.keys(next).length < STYLE_MAX) next[p] = clean;
  }
  return next;
}

/** Choosing an icon drops the emoji and the other way round. */
export function pick(style: ItemStyle, change: Partial<ItemStyle> & { clearColor?: true }): ItemStyle {
  const next: ItemStyle = { ...style };
  if (change.clearColor) delete next.color;
  if (change.color) next.color = change.color;
  if (change.icon) { next.icon = change.icon; delete next.emoji; }
  if (change.emoji) { next.emoji = change.emoji; delete next.icon; }
  return next;
}
