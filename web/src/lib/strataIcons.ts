// Which icon a name gets, decided the way Strata decides it (src/ui/browser/entry.rs and
// entry/catppuccin.rs, MIT): an exact name, then an affix pattern, then the longest dotted
// suffix, then the extension groups, then a plain text file. The tables are generated from its
// source into assets/strata/map.json; the drawings are its own SVGs (Lucide, ISC, for the chrome
// and the folder; Catppuccin VSCode icons, MIT, for the languages). Where they come from is in NOTICE.md.
import map from "../assets/strata/map.json";

export type StrataIcon = { set: "ctp" | "act"; name: string };

type Table = { names: Record<string, string>; exts: Record<string, string>; fileNames: Record<string, string>; affix: string[][]; arms: [string[], string][] };
const T = map as unknown as Table;
const parse = (t: string): StrataIcon => ({ set: t.slice(0, 3) as "ctp" | "act", name: t.slice(4) });

const ARM = new Map<string, string>();
for (const [exts, icon] of T.arms) for (const e of exts) if (!ARM.has(e)) ARM.set(e, icon);

export function strataIconFor(name: string, isDir: boolean, broken = false): StrataIcon {
  if (broken) return { set: "act", name: "x" };
  if (isDir) return { set: "act", name: "folder" };
  const lowered = name.toLowerCase();
  const exact = T.names[lowered] ?? T.fileNames[lowered];
  if (exact) return parse(exact);
  for (const [pre, suf, icon] of T.affix) if (name.startsWith(pre!) && name.endsWith(suf!)) return parse(icon!);
  for (let i = lowered.indexOf("."); i >= 0; i = lowered.indexOf(".", i + 1)) {
    const hit = lowered.length > i + 1 ? T.exts[lowered.slice(i + 1)] : undefined;
    if (hit) return parse(hit);
  }
  const dot = lowered.lastIndexOf(".");
  const arm = dot >= 0 ? ARM.get(lowered.slice(dot + 1)) : undefined;
  return parse(arm ?? "act:file-text");
}

/** Catppuccin Mocha and Latte, the two flavours Strata picks between by the darkness of the window. */
export const CTP_DARK = { rosewater: "#f5e0dc", flamingo: "#f2cdcd", pink: "#f5c2e7", mauve: "#cba6f7", red: "#f38ba8", maroon: "#eba0ac", peach: "#fab387", yellow: "#f9e2af", green: "#a6e3a1", teal: "#94e2d5", sky: "#89dceb", sapphire: "#74c7ec", blue: "#89b4fa", lavender: "#b4befe", text: "#cdd6f4", overlay1: "#7f849c" } as const;
export const CTP_LIGHT = { rosewater: "#dc8a78", flamingo: "#dd7878", pink: "#ea76cb", mauve: "#8839ef", red: "#d20f39", maroon: "#e64553", peach: "#fe640b", yellow: "#df8e1d", green: "#40a02b", teal: "#179299", sky: "#04a5e5", sapphire: "#209fb5", blue: "#1e66f5", lavender: "#7287fd", text: "#4c4f69", overlay1: "#8c8fa1" } as const;

/** The SVG source sized for the screen. Chrome icons ship stroked in Strata's default accent; here that stroke is the colour of the surrounding text, so a theme recolours them. */
export function iconSvg(set: "ctp" | "act", source: string, size: number, dark = true): string {
  let s = source.replace(/\swidth="\d+"/, ` width="${size}"`).replace(/\sheight="\d+"/, ` height="${size}"`);
  if (set === "act") return s.replace(/#8bc9eb/g, "currentColor");
  const pal = dark ? CTP_DARK : CTP_LIGHT;
  for (const [k, v] of Object.entries(pal)) s = s.split(`var(--vscode-ctp-${k})`).join(v);
  return s;
}
