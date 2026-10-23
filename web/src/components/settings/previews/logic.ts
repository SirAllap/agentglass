/** Pure decisions the previews make from the settings they are handed. */

export type Density = "compact" | "comfortable" | "roomy";
/** Row padding in em, per density: the preview's rows breathe the way the app's do. */
export const DENSITY_PAD: Record<Density, number> = { compact: 0.35, comfortable: 0.6, roomy: 0.9 };
export const densityPad = (d: Density | undefined): number => DENSITY_PAD[d ?? "comfortable"] ?? DENSITY_PAD.comfortable;

/** The interface font size setting (12-15 px) as a multiplier of the 13 px the miniature is drawn at. */
export const fontScale = (px: number | undefined): number => {
  const n = Math.min(15, Math.max(12, Math.round(px ?? 13)));
  return n / 13;
};

/** Display size 90-125 %: clamped to what the setting offers, as a multiplier. */
export const zoomScale = (pct: number | undefined): number => Math.min(125, Math.max(90, pct ?? 100)) / 100;

export type RailZone = "top" | "bottom" | "off";
export interface RailItem { id: string; name: string; zone: RailZone; badge?: boolean; count?: number }

/** The rail as drawn: the drawers in order, the hidden ones not at all. */
export function railDrawers(items: readonly RailItem[]): { top: RailItem[]; bottom: RailItem[] } {
  return { top: items.filter((i) => i.zone === "top"), bottom: items.filter((i) => i.zone === "bottom") };
}

/** A count badge shows its number, or a bare dot when the view only has something that needs you. */
export const railBadge = (i: RailItem): "none" | "dot" | string =>
  !i.badge ? "none" : i.count && i.count > 0 ? String(i.count) : "dot";

// ---- Jev Inbox ----

export type JevMode = "off" | "shadow" | "live";
export interface InboxRow { title: string; repo: string; p: number; reason: string }

/** Demo inbox, invented: owner and repo names are placeholders. */
export const DEMO_INBOX: InboxRow[] = [
  { title: "Review requested: Retry the uploader", repo: "acme/orbit", p: 0.94, reason: "review_requested" },
  { title: "@ana mentioned you: can you check https://acme.dev/runs/88 ?", repo: "acme/orbit", p: 0.82, reason: "mention" },
  { title: "CI failed on main: make check", repo: "acme/api", p: 0.77, reason: "ci_activity" },
  { title: "Dependabot: bump bun to 1.3.14", repo: "acme/api", p: 0.31, reason: "subscribed" },
  { title: "Release v0.22.3 published", repo: "acme/orbit", p: 0.12, reason: "subscribed" },
  { title: "Your pull request was merged: Pin the base image", repo: "acme/api", p: 0.08, reason: "author" },
];

/** What is removed from a title before it leaves the machine: links and @names. */
export const redactTitle = (t: string): string => t.replace(/https?:\/\/\S+/g, "[link]").replace(/@\w+/g, "[name]");
export const removedCounts = (t: string): { links: number; names: number } =>
  ({ links: (t.match(/https?:\/\/\S+/g) ?? []).length, names: (t.match(/@\w+/g) ?? []).length });

/** The title as sent: redacted, then cut at the longest the setting allows. */
export function sentTitle(t: string, maxLen: number): { text: string; cut: boolean } {
  const r = redactTitle(t);
  return r.length > maxLen ? { text: r.slice(0, Math.max(0, maxLen)), cut: true } : { text: r, cut: false };
}

/** Live sorts by probability and badges rows at or over the threshold; shadow and off leave the Inbox as GitHub sent it. */
export function jevRows(mode: JevMode, threshold: number, rows: readonly InboxRow[] = DEMO_INBOX): { row: InboxRow; hot: boolean }[] {
  const ordered = mode === "live" ? [...rows].sort((a, b) => b.p - a.p) : [...rows];
  return ordered.map((row) => ({ row, hot: mode === "live" && row.p >= threshold }));
}

/** Jev scores nothing until there is a key and the person agreed the title leaves the machine. */
export const jevReady = (hasKey: boolean, consent: boolean): boolean => hasKey && consent;

// ---- Context Diet ----

export type CapLabel = "100K" | "200K" | "500K";
/** Share of re-read context a per-turn cap would save, on the demo tally. */
export const CAP_SAVES: Record<CapLabel, number> = { "100K": 61, "200K": 37, "500K": 12 };
export const CAP_BAR_SCALE: Record<CapLabel, number> = { "100K": 1, "200K": 0.8, "500K": 0.55 };
export const DEMO_TURNS = [62, 88, 74, 95, 81, 69, 90, 77, 98, 84];

/** Bar heights (0-100) for the ten demo turns, shrunk by the cap; a bar over 78 is the one the cap would trim. */
export function ledgerBars(cap: CapLabel): { h: number; over: boolean }[] {
  const k = CAP_BAR_SCALE[cap] ?? 1;
  return DEMO_TURNS.map((v) => ({ h: v * k, over: v * k > 78 }));
}
export const rereadShare = (countSubagents: boolean): number => (countSubagents ? 98.2 : 91.4);

// ---- Lantern ----

/** The watch's one line under the title, as the Lantern words it. */
export const watchLine = (on: boolean, everyMin: number): string =>
  on ? `· watched every ${everyMin} min, last look 2 min ago, 1 flagged` : "· watch off";

// ---- Browser ----

/** The search box's hint: the engine by name, or a plain address prompt when none is chosen. */
export const searchPlaceholder = (engine: string): string =>
  engine.trim() ? `Search ${engine.trim()} or type an address` : "Type an address";
