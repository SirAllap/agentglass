/*
 * Logging time on a Jira card: what a person types, and what Jira is told.
 *
 * The decisions live here, in one place both the server and the pane import, so
 * the sentence that refuses a bad time is the same in the pane's form, in the
 * route and at the agent's door.
 *
 *   - A time is written like Jira writes it: `1h 30m`, `90m`, `2d`, `1w 2d`.
 *     Jira reads it with the site's own working day and week, so nothing here
 *     turns it into seconds; it is checked, written once in a fixed order and
 *     sent as text.
 *   - The remaining estimate is changed by one of four modes (Jira's
 *     `adjustEstimate`): `auto` lowers it by the time logged, `leave` keeps it,
 *     `new` sets it to a value, `manual` lowers it by a value (`reduceBy`) when
 *     time is logged and raises it by a value (`increaseBy`) when an entry is
 *     deleted. Changing an entry has no `manual`: Jira's update takes the other
 *     three only.
 *
 * Ceiling: a day or a week is whatever the site says it is, so a sentence that
 * says how far an estimate moved is written for hours and minutes only when the
 * site's own answer came back; before the write it names the time as typed.
 */

export type WorklogOp = "add" | "edit" | "delete";
export type AdjustMode = "auto" | "leave" | "new" | "manual";
export interface Adjust { mode: AdjustMode; /** The time `new` sets or `manual` moves by. */ value?: string }

/** The modes each action offers, in the order the pane lists them. */
export const ADJUST_MODES: Record<WorklogOp, readonly AdjustMode[]> = {
  add: ["auto", "new", "leave", "manual"],
  edit: ["auto", "new", "leave"],
  delete: ["auto", "new", "leave", "manual"],
};

const UNITS = ["w", "d", "h", "m"] as const;
const SHAPE = "Time is written like 1h 30m (weeks w, days d, hours h, minutes m)";
const PART = /(\d{1,4})\s*([wdhm])/g;

export type Duration = { ok: true; text: string; zero: boolean } | { ok: false; error: string };

/**
 * `1h30m`, `90m`, `1w 2d 3h 4m` as the one text Jira is sent: each unit once, largest first. A unit named twice is
 * refused rather than added up, since "1h 2h" is a slip and not a sum anybody meant. Zero is a time here, and the
 * caller says whether it is allowed (a new estimate of nothing is; time logged of nothing is not).
 */
export function parseDuration(raw: unknown, o: { allowZero?: boolean } = {}): Duration {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, error: "Say how much time, like 1h 30m" };
  const text = raw.trim().toLowerCase().replace(/,/g, " ");
  const got: Partial<Record<(typeof UNITS)[number], number>> = {};
  for (const m of text.matchAll(PART)) {
    const unit = m[2] as (typeof UNITS)[number];
    if (got[unit] !== undefined) return { ok: false, error: `${SHAPE}: ${unit} is there twice` };
    got[unit] = Number(m[1]);
  }
  // Everything typed must have been read: what is left over is not a time.
  if (!Object.keys(got).length || text.replace(PART, "").trim() !== "") return { ok: false, error: SHAPE };
  const zero = Object.values(got).every((n) => n === 0);
  if (zero && !o.allowZero) return { ok: false, error: "Time must be more than zero" };
  const out = UNITS.filter((u) => got[u]).map((u) => `${got[u]}${u}`);
  return { ok: true, text: zero ? "0m" : out.join(" "), zero };
}

/**
 * A time in minutes, so "90m" and "1h 30m" are seen to be one time; null when it names days or weeks, whose length is the
 * site's own to say. Two times are the same only when this agrees, or their text does.
 */
export function minutesOf(text: string): number | null {
  const t = parseDuration(text, { allowZero: true });
  if (!t.ok || /[wd]/.test(t.text)) return null;
  let n = 0;
  for (const m of t.text.matchAll(/(\d+)([hm])/g)) n += Number(m[1]) * (m[2] === "h" ? 60 : 1);
  return n;
}

const pad = (n: number): string => String(n).padStart(2, "0");
const dayOf = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * When the work was done, in Jira's `started` format, from a day the person picked. No day is no field: Jira takes the
 * moment of the request. Today keeps the clock's time; another day is at 09:00, the hour a day's work starts. A day
 * that has not happened is refused: a work log is what was done.
 */
export function startedStamp(raw: unknown, now: Date): { ok: true; started?: string } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === "") return { ok: true };
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { ok: false, error: "That is not a day" };
  const [y, m, d] = raw.split("-").map(Number) as [number, number, number];
  const at = new Date(y, m - 1, d, 9, 0, 0);
  if (at.getFullYear() !== y || at.getMonth() !== m - 1 || at.getDate() !== d) return { ok: false, error: "That is not a day" };
  if (raw > dayOf(now)) return { ok: false, error: "Time is logged for work that has happened: pick today or an earlier day" };
  const clock = raw === dayOf(now) ? now : at;
  const off = -clock.getTimezoneOffset();
  const zone = `${off < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(off) / 60))}${pad(Math.abs(off) % 60)}`;
  return { ok: true, started: `${raw}T${pad(clock.getHours())}:${pad(clock.getMinutes())}:${pad(clock.getSeconds())}.000${zone}` };
}

/** The Adjust a caller sent, or the sentence that says what is wrong with it. No mode is Jira's own default, `auto`. */
export function adjustOf(raw: unknown, op: WorklogOp): { ok: true; adjust: Adjust } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, adjust: { mode: "auto" } };
  const r = typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  const mode = r?.mode;
  if (typeof mode !== "string" || !(ADJUST_MODES[op] as readonly string[]).includes(mode)) {
    return { ok: false, error: `The remaining estimate can be changed by: ${ADJUST_MODES[op].join(", ")}` };
  }
  if (mode === "auto" || mode === "leave") return { ok: true, adjust: { mode } };
  const t = parseDuration(r?.value, { allowZero: mode === "new" });
  if (!t.ok) return { ok: false, error: mode === "new" ? `The new remaining estimate: ${t.error}` : `The time to ${op === "delete" ? "add back" : "take off"} the estimate: ${t.error}` };
  return { ok: true, adjust: { mode: mode as AdjustMode, value: t.text } };
}

/** The query string Jira's work-log endpoints take for an Adjust: `adjustEstimate`, and the value its mode names. */
export function adjustQuery(op: WorklogOp, adjust: Adjust): string {
  const p = new URLSearchParams({ adjustEstimate: adjust.mode });
  if (adjust.mode === "new") p.set("newEstimate", adjust.value ?? "");
  if (adjust.mode === "manual") p.set(op === "delete" ? "increaseBy" : "reduceBy", adjust.value ?? "");
  return p.toString();
}

/** What an Adjust will do to the remaining estimate, said before the press. `time` is the entry's own time as the card wrote it. */
export function adjustEffect(op: WorklogOp, adjust: Adjust, time: string): string {
  switch (adjust.mode) {
    case "leave": return "The remaining estimate stays as it is";
    case "new": return `The remaining estimate is set to ${adjust.value || "…"}`;
    case "manual": return op === "delete" ? `The remaining estimate goes up by ${adjust.value || "…"}` : `The remaining estimate goes down by ${adjust.value || "…"}`;
    default:
      if (op === "add") return `The remaining estimate goes down by ${time || "the time logged"}`;
      if (op === "delete") return `The remaining estimate goes back up by ${time || "the entry's time"}`;
      return "The remaining estimate moves by the difference between the old time and the new";
  }
}

const left = (s: string): string => s || "none";

/** What happened to the remaining estimate, from the two readings of it either side of the write. */
export function remainingNow(before: string, after: string): string {
  return before === after ? `The remaining estimate is still ${left(after)}` : `The remaining estimate went from ${left(before)} to ${left(after)}`;
}

/** The sentence said after a write landed. */
export function workSaid(op: WorklogOp, time: string, before: string, after: string): string {
  const what = op === "add" ? `Logged ${time}` : op === "edit" ? `Changed the entry to ${time}` : `Deleted the entry of ${time}`;
  return `${what}. ${remainingNow(before, after)}.`;
}
