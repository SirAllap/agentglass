/*
 * Searching settings by row, not just by page.
 *
 * settings-search-reaches-every-row.test.ts kept every page's `kw` bag honest
 * about the rows drawn on it, but `kw` answers a narrower question than the
 * one people actually type: "sound" finds Notifications because "sound" is a
 * word IN it, but "chime" does not, because nobody writes every synonym of
 * every row into a keyword bag by hand — that bag is already the second
 * place a row's words have to be kept in sync, after the row itself. This
 * module is pure (no React, no DOM) so it can be driven by settingsRows.gen.ts
 * — the rows read out of the pages, not typed twice — and unit-tested without
 * mounting a component.
 *
 * Two things live here that a `kw` bag cannot do at all: a synonym ("chime"
 * for "sound") and an honest "no" for a setting that was never going to
 * exist ("proxy" — there is no proxy setting, and there will not be one; the
 * app reads HTTPS_PROXY from its own environment).
 */
import { SETTINGS_ROWS, SETTINGS_PAGES } from "./settingsRows.gen.ts";

export type { SettingsRowRaw as SettingsRow } from "./settingsRows.gen.ts";
export { SETTINGS_ROWS, SETTINGS_PAGES };

/*
 * Bidirectional groups: typing any word in a group should find every row
 * carrying any OTHER word in the group. Picked from the words this app's own
 * `kw` bags and row labels already use for the same thing (`notifications`
 * says "chime", `budgets` says "spend" and "cost") plus the two or three a
 * person reaches for that this app happens not to use anywhere ("beep",
 * "alarm" for what the row calls a "reminder alarm").
 */
export const SYNONYMS: string[][] = [
  ["sound", "chime", "alert", "beep", "alarm", "audio"],
  ["delete", "retention", "remove", "prune", "clear"],
  ["key", "keys", "shortcut", "shortcuts", "binding", "chord", "keyboard"],
  ["cost", "budget", "spend", "limit", "money"],
  ["zoom", "scale", "display size"],
  ["editor", "open"],
  ["dark", "light", "theme", "mode"],
];

/** Every spelling `w` can also be typed as: itself, plus each other word in
 *  whichever synonym group it belongs to (it can be in none, or more than
 *  one — "limit" is only in the budget group, "keyboard" only in the
 *  shortcuts one). `synonym: false` for `w` itself, `true` for the rest, so
 *  a caller can score a direct hit above a synonym one. */
export function expandWord(w: string): { word: string; synonym: boolean }[] {
  const lw = w.toLowerCase();
  const out: { word: string; synonym: boolean }[] = [{ word: lw, synonym: false }];
  for (const group of SYNONYMS) {
    if (!group.includes(lw)) continue;
    for (const g of group) if (g !== lw && !out.some((o) => o.word === g)) out.push({ word: g, synonym: true });
  }
  return out;
}

/**
 * Known-absent features, answered in words instead of silence.
 *
 * "No setting matches" is the right answer to a typo. It is the wrong answer
 * to a question with a real answer that happens not to be a setting — the
 * two read identically to someone who cannot tell "not built" from "you
 * misspelled it", and only one of them is worth a sentence instead of a shrug.
 */
export const ABSENT: { words: string[]; say: string }[] = [
  { words: ["proxy"], say: "No setting for a proxy: agentglass reads HTTPS_PROXY from the environment it starts in." },
  { words: ["language", "locale"], say: "No language setting: the app is English only." },
];

/** The absent-feature entry a query names, if any — every one of its words
 *  has to appear in the query (so "proxy server" still finds it, but "pro"
 *  on its own does not claim to answer a real question it merely resembles). */
export function absentFor(ql: string): { words: string[]; say: string } | null {
  const q = ql.toLowerCase();
  return ABSENT.find((a) => a.words.every((w) => q.includes(w))) ?? null;
}

/** `"Reminder alarm"` -> `"reminder-alarm"`. The row's own anchor: an id
 *  `SettingRow` renders as `data-row`, and `openSettings(pane, row)` and the
 *  command palette both scroll and flash by it. Derived from the label text
 *  rather than hand-assigned, so a row can never carry an id nobody kept in
 *  sync with its label. */
export function rowId(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Does this row's text answer this query?
 *
 * Every typed word (split on whitespace) has to hit — directly, or through a
 * synonym — somewhere in `text` (AND across words, substring per word). This
 * is what SettingRow.tsx's live filter calls instead of the `.includes(q)` it
 * used to run on the WHOLE query as one string, which is why "sound alert"
 * used to match nothing: "sound alert" is never a substring of a hint that
 * has the two words apart, or only one of them.
 */
export function rowMatches(text: string, ql: string): boolean {
  const words = ql.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const t = text.toLowerCase();
  return words.every((w) => expandWord(w).some(({ word }) => t.includes(word)));
}

/** Exact word (in a whitespace-split haystack) beats a word merely prefixed
 *  by the query, which beats the query buried mid-word — the same three
 *  tiers `tabScore` used, now with the row's OWN label as the top tier
 *  instead of only the page's title and `kw` bag. */
function tier(haystack: string, needle: string, exact: number, prefix: number, sub: number): number {
  if (!haystack) return 0;
  if (haystack === needle) return exact;
  const words = haystack.split(/\s+/);
  if (words.includes(needle)) return exact;
  if (haystack.startsWith(needle) || words.some((w) => w.startsWith(needle))) return prefix;
  if (haystack.includes(needle)) return sub;
  return 0;
}

/** Added when a row's whole label is the query: small next to a tier, enough to settle a tie. */
const LABEL_IS_QUERY = 50;

/** A flat contains-or-not score, for the fields that get one tier rather
 *  than three (a hint, a section title, a page's kw bag). */
function flat(haystack: string, needle: string, value: number): number {
  return haystack && haystack.includes(needle) ? value : 0;
}

/** The best score a single typed word `w` gets against `score(word)`, tried
 *  against `w` itself and every synonym of it, a synonym hit scaled to 0.8 of
 *  what a direct hit would have scored in the same tier — a synonym is a
 *  good answer, not as good as the word actually typed being the word
 *  actually there. */
function bestOverSynonyms(w: string, score: (word: string) => number): { score: number; synonym: boolean } {
  let best = 0;
  let bestSynonym = false;
  for (const { word, synonym } of expandWord(w)) {
    const raw = score(word);
    const scaled = synonym ? raw * 0.8 : raw;
    if (scaled > best) { best = scaled; bestSynonym = synonym && raw > 0; }
  }
  return { score: best, synonym: bestSynonym };
}

export interface RowResult {
  pane: string;
  section: string;
  label: string;
  row: string;
  score: number;
  viaSynonym: boolean;
}

export interface SettingsPage { id: string; label: string; kw: string }

/**
 * Every row (or, for a page whose only hit is its title or `kw` bag and no
 * row of its own, a page-level entry with `row: ""`) that answers `ql`,
 * ranked highest first.
 *
 * `pages` carries each page's `label`/`kw` — kept in SettingsModal.tsx
 * alongside its icon, so this stays free of a dependency on that file (and
 * of the whole component tree it pulls in) at the cost of taking that little
 * bit as an argument instead of importing it.
 */
export function searchSettings(ql: string, pages: SettingsPage[]): RowResult[] {
  const words = ql.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const out: RowResult[] = [];
  // A row on a page the caller does not have (the Browser page where there is
  // no browser) would rank, count and open onto nothing.
  const known = new Set(pages.map((p) => p.id));

  for (const row of SETTINGS_ROWS) {
    if (!known.has(row.pane)) continue;
    let total = 0;
    let viaSynonym = false;
    let ok = true;
    for (const w of words) {
      const { score, synonym } = bestOverSynonyms(w, (word) => Math.max(
        tier(row.label.toLowerCase(), word, 1000, 950, 900),
        flat(row.hint.toLowerCase(), word, 600),
        flat(row.section.toLowerCase(), word, 500),
      ));
      if (!score) { ok = false; break; }
      total += score;
      if (synonym) viaSynonym = true;
    }
    if (!ok) continue;
    // The row named by the whole query beats one that merely contains it ("Font size" over "Interface font size").
    if (row.label.toLowerCase() === words.join(" ")) total += LABEL_IS_QUERY;
    out.push({ pane: row.pane, section: row.section, label: row.label, row: rowId(row.label), score: total, viaSynonym });
  }

  // A page with no row of its own that matches, but whose title or `kw` bag
  // does — "Window" answering "fullscreen" through its kw, with no single
  // row literally labelled that. Represented with `row: ""` so a caller can
  // tell "land on the page" apart from "land on this row".
  const panesWithRowHit = new Set(out.map((r) => r.pane));
  for (const page of pages) {
    if (panesWithRowHit.has(page.id)) continue;
    let total = 0;
    let viaSynonym = false;
    let ok = true;
    for (const w of words) {
      const { score, synonym } = bestOverSynonyms(w, (word) => Math.max(
        flat(page.label.toLowerCase(), word, 900),
        page.kw.toLowerCase().split(/\s+/).includes(word) ? 300 : 0,
      ));
      if (!score) { ok = false; break; }
      total += score;
      if (synonym) viaSynonym = true;
    }
    if (!ok) continue;
    out.push({ pane: page.id, section: "", label: page.label, row: "", score: total, viaSynonym });
  }

  return out.sort((a, b) => b.score - a.score);
}

/**
 * How well one PAGE answers a query — the replacement for `tabScore`, now
 * scoring a page by the best of its own title/`kw` and every row on it,
 * instead of by title/`kw` alone. A page that owns the row a query names
 * (Notifications, for "sound") now outranks a page that merely mentions the
 * word in a paragraph (Window, whose old `kw` carried "sound" for a row that
 * has since moved) without that second page needing to lie about not having
 * the word at all.
 */
export function pageScore(page: SettingsPage, ql: string): number {
  if (!ql.trim()) return 0;
  const rows = SETTINGS_ROWS.filter((r) => r.pane === page.id);
  const words = ql.trim().toLowerCase().split(/\s+/).filter(Boolean);
  let total = rows.some((r) => r.label.toLowerCase() === words.join(" ")) ? LABEL_IS_QUERY : 0;
  for (const w of words) {
    let best = bestOverSynonyms(w, (word) => Math.max(
      flat(page.label.toLowerCase(), word, 900),
      page.kw.toLowerCase().split(/\s+/).includes(word) ? 300 : 0,
    )).score;
    for (const row of rows) {
      const s = bestOverSynonyms(w, (word) => Math.max(
        tier(row.label.toLowerCase(), word, 1000, 950, 900),
        flat(row.hint.toLowerCase(), word, 600),
        flat(row.section.toLowerCase(), word, 500),
      )).score;
      if (s > best) best = s;
    }
    if (!best) return 0;
    total += best;
  }
  return total;
}
