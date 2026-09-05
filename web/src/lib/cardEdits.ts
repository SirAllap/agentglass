/*
 * What a typed edit means, away from the control that typed it.
 *
 * A points box, an estimate box and a date picker all end up as the same thing
 * — a patch to send and a sentence to say when it lands — and all three have the
 * same two ways of being wrong: a value that is not a number, and a value the
 * person cleared. Clearing is an EDIT: a due date somebody set by mistake has
 * to come off, and a control that can only ever set one cannot take it back.
 *
 * Kept here rather than inside the panel because these are the parts worth
 * testing directly: "3" is 3, "" is null, "-1" is refused, and half a day is
 * 12 hours of milliseconds and not 12.
 */

/** What the panel sends: `undefined` never leaves, `null` clears the field. */
export type EditValue = number | null;

export interface Parsed {
  ok: boolean;
  value?: EditValue;
  /** Why it was refused, in words the person can act on. */
  error?: string;
}

/** Points, and anything else that is a plain count. Empty clears it. */
export function parsePoints(raw: string): Parsed {
  const s = raw.trim();
  if (!s) return { ok: true, value: null };
  const n = Number(s);
  if (!Number.isFinite(n)) return { ok: false, error: "points have to be a number" };
  if (n < 0) return { ok: false, error: "points cannot be negative" };
  // ClickUp stores them as a number and shows halves; rounding here would
  // silently change what somebody typed.
  return { ok: true, value: n };
}

/**
 * An estimate, written the way people write one: `4h`, `30m`, `1h 30m`, `2.5h`,
 * or a bare number meaning hours. Milliseconds on the wire, because that is
 * what `time_estimate` is.
 */
export function parseEstimate(raw: string): Parsed {
  const s = raw.trim().toLowerCase();
  if (!s) return { ok: true, value: null };
  const HOUR = 3_600_000, MIN = 60_000;
  if (/^\d+(\.\d+)?$/.test(s)) return { ok: true, value: Math.round(Number(s) * HOUR) };
  const parts = [...s.matchAll(/(\d+(?:\.\d+)?)\s*([hm])/g)];
  if (!parts.length) return { ok: false, error: "write an estimate like 4h or 1h 30m" };
  // Anything not consumed by the h/m pairs is a typo worth refusing rather than
  // ignoring: "4h and a bit" should not silently become four hours.
  const eaten = parts.reduce((n, p) => n + p[0].length, 0);
  if (s.replace(/\s+/g, "").length !== eaten) return { ok: false, error: "write an estimate like 4h or 1h 30m" };
  const ms = parts.reduce((sum, p) => sum + Number(p[1]) * (p[2] === "h" ? HOUR : MIN), 0);
  if (!ms) return { ok: true, value: null };
  return { ok: true, value: Math.round(ms) };
}

/** Milliseconds back into `4h 30m`, for the box to open with what is there. */
export function estimateText(ms: number | null | undefined): string {
  if (!ms) return "";
  const mins = Math.round(ms / 60_000);
  const h = Math.floor(mins / 60), m = mins % 60;
  if (h && m) return `${h}h ${m}m`;
  return h ? `${h}h` : `${m}m`;
}

/**
 * A date box's value (`2026-08-21`) as the moment ClickUp should record.
 *
 * Noon, deliberately. Midnight local turns into the previous day for anybody
 * reading the card from a timezone behind this one, and a due date that moves
 * by a day depending on who is looking is worse than one with a made-up time on
 * it.
 */
export function dayToMs(day: string): EditValue {
  if (!day) return null;
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d, 12, 0, 0, 0).getTime();
}

/** And back, for the box: a stamp as `YYYY-MM-DD` in the reader's own day. */
export function msToDay(ms: number | null | undefined): string {
  if (!ms) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * A sprint's short name, for a picker that has thirty of them.
 *
 * Sprints are lists and their names carry the dates — "Sprint 42 (26/8/19 -
 * 26/8/25)" — which is the useful half when you are choosing and noise once you
 * have. The number is what people say out loud.
 */
export function sprintShort(name: string): string {
  const m = /^\s*sprint\s+(\d+)/i.exec(name);
  return m ? `Sprint ${m[1]}` : name;
}

/** Sprint lists, newest first — the one being planned is the one wanted. */
export function sortSprints<T extends { name: string }>(lists: T[]): T[] {
  const num = (n: string) => Number(/^\s*sprint\s+(\d+)/i.exec(n)?.[1] ?? -1);
  return [...lists].sort((a, b) => num(b.name) - num(a.name) || a.name.localeCompare(b.name));
}

/**
 * A comment, folded into the card's description.
 *
 * Appended and attributed, never merged: the description is somebody's writing
 * and the comment is somebody else's, so the join has to say where the second
 * one came from — otherwise a triage write-up moved into the description reads
 * as if the reporter had written it.
 *
 * A rule between them because these are two documents, and a card whose
 * description is empty starts with the comment rather than with a rule that
 * separates it from nothing.
 */
export function describeWithComment(
  description: string,
  comment: { text: string; who?: string; at?: number | null },
  fmtDate: (at: number) => string = (at) => new Date(at).toLocaleDateString(),
): string {
  const body = (comment.text ?? "").trim();
  if (!body) return description;
  const when = comment.at ? ` · ${fmtDate(comment.at)}` : "";
  const head = `**From a comment by ${comment.who?.trim() || "someone"}${when}**`;
  const before = (description ?? "").trimEnd();
  return before
    ? `${before}\n\n---\n\n${head}\n\n${body}\n`
    : `${head}\n\n${body}\n`;
}

/*
 * WHICH TAGS TO OFFER, and whether what was typed is a new one.
 *
 * Adding a tag used to be an empty box: you typed the name from memory, and a
 * near miss (`bug intake` for `bug-intake`) made a second tag that looks like
 * the first and filters like neither. The list is what fixes that, and the
 * three rules worth pinning are all here rather than inside the control:
 *
 * - a tag already on the card is not offered again (adding it twice is a no-op
 *   that still costs a call),
 * - matching ignores case, because ClickUp's names do not,
 * - "create it" appears only when nothing is spelled that way already — the
 *   row that offers to make `bug-intake` while `bug-intake` sits above it is
 *   exactly how the duplicate gets made.
 */
export interface TagChoices {
  /** What to draw, in order. */
  rows: string[];
  /** Where the "make this one" row is, or -1. LAST, not first: typing narrows
   *  the list, so the row under the cursor while you type has to be the tag
   *  that already exists — `ACCESS` offered above `Access Request`, with Enter
   *  on it, is the duplicate this list exists to prevent. It leads only when
   *  nothing matches, where it is the sole answer. */
  newAt: number;
  /** Whether anything here would make a tag that does not exist yet. */
  creating: boolean;
}

export function tagChoices(known: readonly string[], onCard: readonly string[], typed: string): TagChoices {
  const mine = new Set(onCard.map((t) => t.toLowerCase()));
  const free = known.filter((k) => !mine.has(k.toLowerCase()));
  const q = typed.trim().toLowerCase();
  const rows = q ? free.filter((k) => k.toLowerCase().includes(q)) : [...free];
  const creating = !!q
    && !free.some((k) => k.toLowerCase() === q)
    && !mine.has(q);
  if (!creating) return { rows, newAt: -1, creating };
  return { rows: [...rows, typed.trim()], newAt: rows.length, creating };
}
