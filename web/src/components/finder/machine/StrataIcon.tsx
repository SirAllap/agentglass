// Strata's own drawings, inline so a theme can recolour them. The glob is inside a function:
// `import.meta.glob` is a Vite macro and hooks-module-scope.test.ts imports every module under
// web/src in bun, where it does not exist (see understudy/persona/layers.ts).
import { useMemo, useSyncExternalStore } from "react";
import { ICON } from "../../../lib/iconSize.ts";
import { iconSvg, strataIconFor } from "../../../lib/strataIcons.ts";
import { useItemStyle } from "../../../lib/finderStyleStore.ts";

let sources: { ctp: Record<string, string>; act: Record<string, string> } | null = null;
function vendored() {
  if (sources) return sources;
  const by = (g: Record<string, string>) => Object.fromEntries(Object.entries(g).map(([k, v]) => [k.slice(k.lastIndexOf("/") + 1).replace(/\.svg$/, ""), v]));
  sources = {
    ctp: by(import.meta.glob("../../../assets/strata/ctp/*.svg", { eager: true, query: "?raw", import: "default" }) as Record<string, string>),
    act: by(import.meta.glob("../../../assets/strata/actions/*.svg", { eager: true, query: "?raw", import: "default" }) as Record<string, string>),
  };
  return sources;
}

/** Strata picks Catppuccin Mocha on a dark window and Latte on a light one; so does this, by the page background. */
function darkNow(): boolean {
  const hex = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim().replace("#", "");
  if (!/^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(hex)) return true;
  const v = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
  const n = parseInt(v, 16);
  return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255) < 128;
}
function watchTheme(cb: () => void) {
  const o = new MutationObserver(cb);
  o.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style", "class"] });
  return () => o.disconnect();
}

export function StrataIcon({ set, name, size = ICON.sm, className }: { set: "ctp" | "act"; name: string; size?: number; className?: string }) {
  const dark = useSyncExternalStore(watchTheme, darkNow, () => true);
  const html = useMemo(() => { const src = vendored()[set][name]; return src ? iconSvg(set, src, size, dark) : ""; }, [set, name, size, dark]);
  return <span className={`flex shrink-0 ${className ?? ""}`} style={{ width: size, height: size }} aria-hidden dangerouslySetInnerHTML={{ __html: html }} />;
}

/** The icon a file or folder row wears. A folder is drawn in the accent, as in Strata; a file keeps its own colours. */
export function FileTypeIcon({ name, isDir, broken, size = ICON.sm }: { name: string; isDir: boolean; broken?: boolean; size?: number }) {
  const i = strataIconFor(name, isDir, broken);
  const tint = i.set === "act" ? (isDir || broken ? "var(--primary)" : "var(--text3)") : undefined;
  return <span className="flex shrink-0" style={{ color: tint }}><StrataIcon set={i.set} name={i.name} size={size} /></span>;
}

/** An item the person gave a look of their own (Customize…): their colour on its icon, or their icon, or an emoji in its place. */
export function StyledIcon({ style, name, isDir, size = ICON.sm }: { style: { color?: string; icon?: string; emoji?: string }; name: string; isDir: boolean; size?: number }) {
  if (style.emoji) return <span className="flex shrink-0 items-center justify-center leading-none" style={{ width: size, height: size, fontSize: Math.round(size * 0.82) }} aria-hidden>{style.emoji}</span>;
  // Strata draws a coloured folder as a filled one with the chosen icon in white on it (its shots 48 and 49).
  if (isDir && (style.color || style.icon)) {
    const fill = style.color ?? "var(--primary)";
    return (
      <span className="relative flex shrink-0" style={{ width: size, height: size }} aria-hidden>
        <svg viewBox="0 0 24 24" width={size} height={size} fill={fill}><path d="M2 6.5A2.5 2.5 0 0 1 4.5 4H9l2.2 2.4H19.5A2.5 2.5 0 0 1 22 8.9v9.6a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 2 18.5z" /></svg>
        {style.icon && <span className="absolute flex" style={{ left: "50%", top: "58%", transform: "translate(-50%, -50%)", color: "#fff" }}><StrataIcon set="act" name={style.icon} size={Math.round(size * 0.52)} /></span>}
      </span>
    );
  }
  // Strata's own file-type drawings carry their colours; a colour the person chose is painted on a plain icon instead.
  const base = style.color ? { set: "act" as const, name: isDir ? "folder" : "file-text" } : strataIconFor(name, isDir, false);
  const set = style.icon ? "act" : base.set, icon = style.icon ?? base.name;
  const tint = style.color ?? (set === "act" ? (isDir ? "var(--primary)" : "var(--text3)") : undefined);
  return <span className="flex shrink-0" style={{ color: tint }}><StrataIcon set={set} name={icon} size={size} /></span>;
}

/** The one reader of the look a person chose in Customize…: whatever draws an item by its path (a column row, an icon tile, a search hit, the preview header) goes through here, so a style set once shows everywhere. */
export function PathIcon({ path, name, isDir, broken, size = ICON.sm }: { path: string | undefined; name: string; isDir: boolean; broken?: boolean; size?: number }) {
  const own = useItemStyle(path);
  return own ? <StyledIcon style={own} name={name} isDir={isDir} size={size} /> : <FileTypeIcon name={name} isDir={isDir} broken={broken} size={size} />;
}
