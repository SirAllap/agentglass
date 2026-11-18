// Pure decisions of the Settings page shell: which pages get the "On this page"
// rail, and in what order sections appear. No React here, so tests need no DOM.

/** A page with this many sections or more gets the rail (More options and Danger zone count). */
export const RAIL_MIN_SECTIONS = 2;

/**
 * Under this width of the page's own content area (not the window: the nav and the modal
 * take ~280px, and a viewport media query never matches inside the modal) the rail becomes
 * a chip band. 820 content px is the 1100px window of the pattern minus the nav.
 */
export const RAIL_CHIP_BELOW_PX = 820;

/** With a page aside (the 380px live preview) the rows need their ~720px column too: 380 + 32 gap + 720 + padding. */
export const RAIL_CHIP_WITH_ASIDE_BELOW_PX = 1230;

/** The shell's own sizes, named once. */
export const SHELL_SIZE = { rowLabelMin: "11rem", rowControlMax: "55%", aside: 380, scoreBar: 150, fadeMask: 24 } as const;

/** The content column and the gap beside the right column (rail, spacer or aside). */
export const SHELL_COLUMN = 720;
export const SHELL_GAP = 32;

/**
 * One group width on every page: column + gap + the widest right column (the aside). The rail and the
 * one-section spacer take the aside's width too, so a centred group puts the column at the same x on a
 * rail page, a one-section page and an aside page (a 944 px rail group against a 1132 px aside group
 * moved the column ~94 px between General and Appearance).
 */
export const SHELL_GROUP_WIDTH = SHELL_COLUMN + SHELL_GAP + SHELL_SIZE.aside;

/** The right column may give way to the content column down to the rail's own entry width. */
export const SHELL_RAIL_MIN = 192;

/**
 * A wide page (one drawn as a picture across, like Browser's login vault) keeps the same group, so its
 * column starts at the same x, but gives the column the rail's spare width: a 192 px rail beside a
 * 908 px column. Under this content width the rail is hidden and the column takes the whole group:
 * at a 1132 px window the 380 px rail left the vault 700 px and every card cut its words short.
 */
export const WIDE_RAIL_FROM_PX = 1200;
export const WIDE_COLUMN_WITH_RAIL = SHELL_GROUP_WIDTH - SHELL_GAP - SHELL_RAIL_MIN;

export function wideHasRail(contentWidth: number): boolean {
  return contentWidth >= WIDE_RAIL_FROM_PX;
}

/**
 * The empty right column that keeps a rail-less page's left edge. A wide page whose rail is hidden because
 * the window is too narrow gets none: that width is the one the column needs.
 */
export function showRailSpacer(o: { rail: boolean; chips: boolean; aside: boolean; wide: boolean; wideRail: boolean }): boolean {
  return !o.rail && !o.chips && !o.aside && (!o.wide || o.wideRail);
}

export type SectionKind = "normal" | "more" | "danger";

export interface SectionMeta {
  id: string;
  title: string;
  kind: SectionKind;
  /** A short count the rail shows at the right of the entry ("12", "offline"); none when absent. */
  count?: string;
}

/** The four row kinds. A fact row exists on Inspect only. */
export type RowKind = "control" | "link" | "locked" | "fact";

export function hasRail(sectionCount: number): boolean {
  return sectionCount >= RAIL_MIN_SECTIONS;
}

export function isChipBand(contentWidth: number, hasAside = false): boolean {
  return contentWidth < (hasAside ? RAIL_CHIP_WITH_ASIDE_BELOW_PX : RAIL_CHIP_BELOW_PX);
}

const RANK: Record<SectionKind, number> = { normal: 0, more: 1, danger: 2 };

/**
 * Fixed order: normal sections (as given, most-used first), then More options,
 * then Danger zone. Stable inside a kind. Returns a new array.
 */
export function orderSections<T extends { kind: SectionKind }>(sections: readonly T[]): T[] {
  return sections
    .map((s, i) => ({ s, i }))
    .sort((a, b) => RANK[a.s.kind] - RANK[b.s.kind] || a.i - b.i)
    .map((x) => x.s);
}

/**
 * The active rail entry: the last section whose top has passed the line, or the
 * first one. `tops` are section tops relative to the scroll container top.
 */
export function activeSection(ids: readonly string[], tops: readonly number[], line = 80, atBottom = false): string | undefined {
  // At the end of the page the last section can never reach the line, so it is the active one.
  if (atBottom && ids.length) return ids[ids.length - 1];
  let active = ids[0];
  for (let i = 0; i < ids.length; i++) if (tops[i] <= line) active = ids[i];
  return active;
}

/** Row kinds a page may use: Inspect allows facts, nobody else does. */
export function rowKindAllowed(kind: RowKind, page: "main" | "advanced" | "inspect"): boolean {
  return kind === "fact" ? page === "inspect" : true;
}

/** The left gap of the content+rail group centred in a pane (never negative); the right gap is the same. */
export const groupLeft = (pane: number, group: number): number => Math.max(0, Math.floor((pane - group) / 2));
export const groupRight = (pane: number, group: number): number => groupLeft(pane, group);

/**
 * The rail's entries: every top-level section the page actually drew, in page order, when it drew any;
 * the page's declaration otherwise (a static render has no DOM to read). A declared section whose
 * body is a component drawing several sections of its own (Understudy's "What it learns from") listed
 * one entry for six headings, and that entry pointed at an id nothing on the page carried.
 */
export function railEntries(declared: readonly SectionMeta[], found: readonly SectionMeta[] | null): readonly SectionMeta[] {
  return found && found.length ? found : declared;
}

/**
 * The title a drawn section gets in the rail: its own visible heading; else the title the page declared
 * for that id (a body that is a card, not a `Section`, has no heading element); else null, because a
 * node with neither is not a section and must not be listed under its raw id ("build", "opens").
 */
export function foundTitle(heading: string | null | undefined, id: string, declared: readonly SectionMeta[]): string | null {
  const own = heading?.trim();
  if (own) return own;
  return declared.find((d) => d.id === id)?.title.trim() || null;
}

/** Same entries in the same order: the rail re-renders only when the page's sections really changed. */
export function sameEntries(a: readonly SectionMeta[] | null, b: readonly SectionMeta[] | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((x, i) => x.id === b[i]!.id && x.title === b[i]!.title && x.kind === b[i]!.kind && x.count === b[i]!.count);
}

/**
 * A heading inside a section that only says the section's title again: equal, or one
 * inside the other, ignoring case and punctuation ("Services" under "Services", "ON THIS
 * MACHINE" under "Tools on this machine"). The section heading already names it.
 */
export function repeatsTitle(title: string, inner: string): boolean {
  const n = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim();
  const t = n(title), i = n(inner);
  if (!t || !i) return false;
  return t === i || (i.length > 4 && t.includes(i)) || (t.length > 4 && i.includes(t));
}

/**
 * What an `openSettings(pane, row)` id points at on the mounted page: a row (its own flash) or a
 * section (the rail entry's own jump, which marks it in "On this page"). A row wins when an id is
 * both, because rows are the finer target. `null` when the page has neither.
 */
export function jumpTarget(id: string, rowIds: Iterable<string>, sectionIds: Iterable<string>): "row" | "section" | null {
  for (const r of rowIds) if (r === id) return "row";
  for (const s of sectionIds) if (s === id) return "section";
  return null;
}

/**
 * Whether a pending row jump may be applied now. It waits for the page it was asked for to be the one on
 * screen (`front`) and the one wanted (`pane`): the page open before a switch is also `front === pane`
 * for one render, and a jump applied there finds none of its rows and is thrown away. `page` null = any.
 */
export function pendingJumpReady(page: string | null, front: string | null, pane: string): boolean {
  return front === pane && (page === null || page === front);
}

/** Run `fn` after `ms`; the returned function cancels it. A row pin uses it to let go once the page height stopped changing. */
export function afterQuiet(fn: () => void, ms: number): () => void {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
}

/** A queued row jump stays only while Settings is open and its page can ever mount; otherwise it would fire later on a hand-opened page. */
export function keepPendingJump(open: boolean, page: string | null, knownPage: (p: string) => boolean): boolean {
  return open && (page === null || knownPage(page));
}

/** `dispatchEvent` returns false when a listener called preventDefault: nobody handled the pin when it returns true, so scroll directly. */
export function needsDirectScroll(dispatchReturned: boolean): boolean {
  return dispatchReturned;
}

export interface PinState { pinned: boolean; id: string | null; row: string | null }
/** The effect re-arms (list changed) and its stable timer is gone: a row pin has nobody left to release it, so drop it; a section pin ends on input and stays. */
export function releaseOrphanRowPin(s: PinState): PinState {
  return s.row ? { pinned: false, id: null, row: null } : s;
}
