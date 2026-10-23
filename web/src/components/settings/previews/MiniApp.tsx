import type { ComponentType, CSSProperties } from "react";
import { VIEWS, SHIPPED_RAIL, type RailLayout } from "../../workspace/views.ts";
import { densityPad, fontScale, railBadge, railDrawers, type Density, type RailItem } from "./logic.ts";

export type MiniView = "dash" | "pr" | "diff" | "term";
export const MINI_VIEWS: { id: MiniView; label: string }[] = [
  { id: "dash", label: "Dashboard" }, { id: "pr", label: "Pull requests" }, { id: "diff", label: "Diff" }, { id: "term", label: "Terminal" },
];

/** The rail in the shape the previews draw: the drawers a layout holds, and the views put away as "off". */
export const railItems = (l: RailLayout): RailItem[] => [
  ...l.work.map((v) => ({ id: v.id, name: v.label, zone: "top" as const })),
  ...l.utility.map((v) => ({ id: v.id, name: v.label, zone: "bottom" as const })),
  ...l.hidden.map((v) => ({ id: v.id, name: v.label, zone: "off" as const })),
];

/** The rail as it ships, in the shape the sidebar page edits. */
export const DEFAULT_RAIL: RailItem[] = railItems(SHIPPED_RAIL);

const ICONS = new Map<string, ComponentType<{ size?: number }>>(VIEWS.map((v) => [v.id, v.icon]));
const BORDER = "0.08em solid var(--surface-line)";

const CARDS: [string, string, string][] = [
  ["Fix reconnect on wake", "acme/orbit #1042", "In review"], ["Retry the upload queue", "acme/orbit #1039", "Ready"],
  ["Update the changelog", "acme/api #88", "Needs you"], ["Pin the base image", "acme/api #84", "Merged"],
];
const DIFF: [string, string][] = [
  [" ", "function reconnect(socket) {"], ["-", "  const wait = 500;"], ["+", "  const wait = backoff(attempt);"],
  [" ", "  if (!socket.open) {"], ["+", "    log.warn(\"retrying in \" + wait);"], [" ", "    return schedule(wait);"], [" ", "  }"],
];
const TERM = ["$ make check", "tranche server: 612 pass, 0 fail", "tranche web: 1,204 pass, 0 fail", "typecheck clean", "$ git status -s", " M src/net/reconnect.ts"];

/** The rail of the real window, drawn from the app's own view icons. */
export function MiniRail({ items, selected }: { items: readonly RailItem[]; selected: string }) {
  const { top, bottom } = railDrawers(items);
  const one = (i: RailItem) => {
    const Icon = ICONS.get(i.id);
    const b = railBadge(i);
    const on = i.id === selected;
    return (
      <span key={i.id} data-rail-item={i.id} title={i.name} className="agx-pv-ic relative inline-flex items-center justify-center"
        style={{ width: "2.1em", height: "2.1em", borderRadius: "0.5em", color: on ? "var(--primary)" : "var(--text3)", background: on ? "color-mix(in srgb, var(--primary) 14%, transparent)" : "transparent" }}>
        {Icon ? <Icon size={16} /> : null}
        {b !== "none" && (
          <b style={{ position: "absolute", top: "0.1em", right: "0.1em", minWidth: b === "dot" ? "0.7em" : "1.3em", height: b === "dot" ? "0.7em" : "1.3em", borderRadius: "999px", background: "var(--error)", color: "var(--bg)", fontSize: "0.7em", lineHeight: "1.3em", textAlign: "center" }}>{b === "dot" ? "" : b}</b>
        )}
      </span>
    );
  };
  return (
    <div data-mini-rail className="flex flex-col justify-between items-center shrink-0" style={{ width: "3em", padding: "0.5em 0", gap: "0.3em" }}>
      <div className="flex flex-col items-center" style={{ gap: "0.1em" }}>{top.map(one)}</div>
      <div className="flex flex-col items-center" style={{ gap: "0.1em" }}>{bottom.map(one)}</div>
    </div>
  );
}

function Chip({ text }: { text: string }) {
  const tone = text === "Needs you" ? "--warning" : text === "Merged" ? "--info" : "--success";
  return <span style={{ fontSize: "0.8em", padding: "0.1em 0.6em", borderRadius: "999px", background: `color-mix(in srgb, var(${tone}) 16%, transparent)`, color: `var(${tone}-ink)` }}>{text}</span>;
}

function Body({ view, pad }: { view: MiniView; pad: number }) {
  if (view === "diff") {
    return (
      <div style={{ fontFamily: "var(--font-mono, monospace)", fontSize: "0.9em", lineHeight: 1.7 }}>
        <div style={{ color: "var(--text3)", marginBottom: "0.4em" }}>src/net/reconnect.ts</div>
        {DIFF.map(([k, t], i) => (
          <div key={i} style={{ whiteSpace: "pre", padding: "0 0.5em", background: k === "+" ? "color-mix(in srgb, var(--success) 16%, transparent)" : k === "-" ? "color-mix(in srgb, var(--error) 16%, transparent)" : "transparent", color: k === " " ? "var(--text2)" : "var(--text)" }}>{k} {t}</div>
        ))}
      </div>
    );
  }
  if (view === "term") {
    return (
      <div style={{ fontFamily: "var(--font-mono, monospace)", fontSize: "0.9em", lineHeight: 1.7, color: "var(--text2)" }}>
        {TERM.map((l, i) => <div key={i} style={{ whiteSpace: "pre", color: l.startsWith("$") ? "var(--text)" : undefined }}>{l.startsWith("$") ? <><span style={{ color: "var(--success)" }}>$</span>{l.slice(1)}</> : l}</div>)}
        <div style={{ color: "var(--primary)" }}>▍</div>
      </div>
    );
  }
  const rows = view === "pr" ? CARDS.slice(0, 4) : CARDS;
  return (
    <div className="flex flex-col" style={{ gap: `${pad * 0.7}em` }}>
      {rows.map(([t, s, c]) => (
        <div key={t} className="flex items-center justify-between" style={{ padding: `${pad}em 0.9em`, background: "var(--surface-card)", border: BORDER, borderRadius: "0.7em", gap: "1em" }}>
          <div className="min-w-0"><div style={{ fontWeight: 600, color: "var(--text)" }}>{t}</div><div style={{ fontSize: "0.8em", color: "var(--text3)" }}>{s}</div></div>
          <Chip text={c} />
        </div>
      ))}
    </div>
  );
}

/**
 * The app's window in miniature: the rail, a header and one view, in the
 * theme, density and font size handed in. Drawn in em, so it scales with the
 * box it is in (see Scaled).
 */
export function MiniApp({ view, rail, selected, density, fontPx, translucent, style }: {
  view: MiniView; rail: readonly RailItem[]; selected?: string; density?: Density; fontPx?: number; translucent?: boolean; style?: CSSProperties;
}) {
  const sel = selected ?? (view === "dash" ? "dash" : view === "pr" ? "pr" : view === "diff" ? "diff" : "term");
  const label = MINI_VIEWS.find((v) => v.id === view)?.label ?? "";
  return (
    <div data-mini-app data-view={view} data-translucent={translucent ? "" : undefined} className="flex" style={{ background: "var(--bg)", borderRadius: "0.8em", overflow: "hidden", border: BORDER, aspectRatio: "16 / 10", fontSize: `${fontScale(fontPx)}em`, ...style }}>
      <div style={{ background: translucent ? "color-mix(in srgb, var(--bg2) 45%, transparent)" : "var(--surface-nav)", backdropFilter: translucent ? "blur(0.6em)" : undefined, borderRight: BORDER }}>
        <MiniRail items={rail} selected={sel} />
      </div>
      <div className="flex-1 min-w-0 flex flex-col" style={{ padding: "1em 1.2em", gap: "0.8em" }}>
        <div className="flex items-baseline" style={{ gap: "0.6em" }}><b style={{ fontSize: "1.25em" }}>{label}</b><span style={{ color: "var(--text3)", fontSize: "0.85em" }}>acme/orbit</span></div>
        <Body view={view} pad={densityPad(density)} />
      </div>
    </div>
  );
}
