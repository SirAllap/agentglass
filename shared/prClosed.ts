import type { PrClosedFacts, PrSummary } from "./types.ts";

/**
 * The words on a finished pull request's card. Pure and shared, so the server
 * test and the card read the same sentences.
 *
 * A finished pull request never changes, so nothing here has a "loading" form:
 * a row whose details have not arrived says what it already knows (merged or
 * closed) and leaves the rest out, rather than drawing a placeholder.
 */

/** Merged, closed without merging, or still open. */
export type FinishedKind = "merged" | "closed" | null;
export const finishedKind = (p: Pick<PrSummary, "state">): FinishedKind =>
  p.state === "MERGED" ? "merged" : p.state === "CLOSED" ? "closed" : null;

/** A row that still owes the details a finished card shows. */
export const needsClosedFacts = (p: Partial<Pick<PrSummary, "state" | "closed">>): boolean => p.state != null && p.state !== "OPEN" && !p.closed;

/**
 * How long it was open, in the two largest units that are not zero: "2d 3h",
 * "4d", "35m", "1h 20m". Under a minute is "<1m". Unreadable dates say nothing.
 * Ceiling: months are not a unit; a pull request open for 90 days reads "90d".
 */
export function openFor(openedAt: string, at: string): string {
  const ms = Date.parse(at) - Date.parse(openedAt);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "<1m";
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

/**
 * "Merged <date> · by <login> · squash · open for 2d 3h", or
 * "Closed <date> · by <login> · no merge · open for 4d". `stamp` turns the ISO
 * time into the card's own date format (injected: the web owns that formatter).
 * Parts that are not known are left out, never replaced by a dash.
 */
export function closedHeader(p: Pick<PrSummary, "state" | "closed">, stamp: (iso: string) => string): string {
  const kind = finishedKind(p);
  if (!kind) return "";
  const f = p.closed;
  const head = kind === "merged" ? "Merged" : "Closed";
  if (!f) return head;
  const parts = [`${head} ${stamp(f.at)}`.trim()];
  if (f.by) parts.push(`by ${f.by}`);
  if (kind === "closed") parts.push("no merge");
  else if (f.method) parts.push(f.method);
  const open = openFor(f.openedAt, f.at);
  if (open) parts.push(`open for ${open}`);
  return parts.join(" · ");
}

export type ChecksLine = { text: string; tone: "ok" | "ko" | "dim"; detail: string };

/**
 * The final checks, as they stood at the end:
 *  - all green: "74/75 checks passed" with "1 skipped" as the detail
 *  - red, merged: "2 checks failed: build, lint" (up to two names)
 *  - red, closed: "3 checks failed at close" (the names ride in the detail)
 *  - none ran: "no checks"
 */
export function checksLine(p: Pick<PrSummary, "state">, f: PrClosedFacts): ChecksLine {
  const c = f.checks;
  const skipped = c.skipped > 0 ? `${c.skipped} skipped` : "";
  if (c.total === 0) return { text: "no checks", tone: "dim", detail: "" };
  if (c.failure > 0) {
    const names = c.failing.slice(0, 2).join(", ");
    const n = `${c.failure} ${c.failure === 1 ? "check" : "checks"} failed`;
    if (p.state === "CLOSED") return { text: `${n} at close`, tone: "ko", detail: names };
    return { text: names ? `${n}: ${names}` : n, tone: "ko", detail: skipped };
  }
  return { text: `${c.success}/${c.total} checks passed`, tone: "ok", detail: skipped };
}

/** "+271 −64 · 11 files · 3 commits" with singular forms. */
export function sizeLine(p: Pick<PrSummary, "additions" | "deletions" | "changedFiles">, f: PrClosedFacts): string {
  const files = `${p.changedFiles} ${p.changedFiles === 1 ? "file" : "files"}`;
  const commits = `${f.commits} ${f.commits === 1 ? "commit" : "commits"}`;
  return `+${p.additions} −${p.deletions} · ${files} · ${commits}`;
}

/** "2 rounds · 9 comments", "none asked · 3 comments"; the people are chips beside it. */
export function reviewsTail(f: PrClosedFacts): string {
  const r = f.reviews;
  const rounds = r.rounds > 0 ? `${r.rounds} ${r.rounds === 1 ? "round" : "rounds"}` : "";
  const talk = `${r.comments} ${r.comments === 1 ? "comment" : "comments"}`;
  return [rounds, talk].filter(Boolean).join(" · ");
}

/** The last comment as one line of at most `max` characters. */
export function whyLine(body: string | null | undefined, max = 120): string | null {
  const one = String(body ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/[`*>]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (!one) return null;
  return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`;
}
