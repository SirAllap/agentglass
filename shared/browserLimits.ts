/*
 * What a worker's browser may reach, as three lists the person edits in
 * Settings ▸ Browser: the origins it may be pointed at, the named profiles it
 * may use, and which groups of verbs its credential may run.
 *
 * The first two were environment variables only. The third was a table in
 * server/src/browserdrive.ts (`WORKER_VERBS`) whose refused rows no setting
 * could lift. The defaults here are exactly what shipped: every origin, every
 * profile, and the read and act groups.
 */

import { ACT_VERBS } from "./browserActVerbs.ts";

/** Verbs a worker may run with a group on, by group. A verb in no group is never lifted: it is the person's, or it reaches past the worker's own container. */
export const WORKER_VERB_GROUPS: Readonly<Record<string, { title: string; says: string; on: boolean; lifts: readonly string[] }>> = {
  read: { title: "Read", says: "Look at a page: text, links, forms, screenshots, the console and network log.", on: true,
    lifts: [] },
  act: { title: "Act", says: "Click, type, fill, scroll, press keys, go back and forward.", on: true, lifts: [] },
  devtools: { title: "DevTools", says: "Audits, traces, HAR, coverage, throttling, emulation, request interception, init scripts.", on: false,
    lifts: ["addInitScript", "audit", "cdp", "checkup", "clock", "coverage", "debug", "emulate", "expose", "exposed", "fake", "har", "headers",
      "intercept", "listeners", "pdf", "record", "region", "screencast", "throttle", "trace"] },
  "cookies-storage": { title: "Cookies and storage", says: "Read and write the cookies, storage and permissions of its own container, and move files in and out.", on: false,
    lifts: ["clipboard", "cookies", "download", "permission", "permissions", "storage", "upload"] },
  eval: { title: "Eval", says: "Run its own JavaScript in a page of its own container.", on: false, lifts: ["eval", "script", "scrape"] },
};
export const VERB_GROUP_IDS: readonly string[] = Object.keys(WORKER_VERB_GROUPS);

/** The verbs the read and act groups turn off when they are off. Everything else a worker could always run is structure (open, tab, whoami…). */
export const READ_VERBS: readonly string[] = [
  "read", "markdown", "extract", "links", "count", "search", "interactive", "forms", "attr", "text", "html", "shot", "console", "network",
  "observe", "frames", "events", "a11y", "inspect", "vitals", "wait", "waitfor",
];
/** The worker Act group: the shared acting verbs (shared/browserActVerbs.ts) less the ones that are
 *  not this switch's to give. `open` is structure, `eval` and `upload` have their own off-by-default
 *  groups, `drag` and `navigate` are never lifted for a worker. Kept exactly as it shipped. */
const NOT_THE_ACT_GROUP = new Set(["open", "navigate", "eval", "upload", "drag"]);
export const WORKER_ACT_VERBS: readonly string[] = ACT_VERBS.filter((v) => !NOT_THE_ACT_GROUP.has(v));

export const DEFAULT_VERB_GROUPS: readonly string[] = VERB_GROUP_IDS.filter((g) => WORKER_VERB_GROUPS[g]!.on);

/** A stored list of group ids as the launch path reads it: known names only, in canonical order. Absent is the default. */
export function readVerbGroups(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [...DEFAULT_VERB_GROUPS];
  const picked = new Set(raw.filter((x): x is string => typeof x === "string"));
  return VERB_GROUP_IDS.filter((g) => picked.has(g));
}

export function cleanVerbGroups(raw: unknown): { value: string[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: `a list of verb groups: ${VERB_GROUP_IDS.join(", ")}` };
  for (const x of raw) if (typeof x !== "string" || !VERB_GROUP_IDS.includes(x)) return { error: `unknown verb group ${JSON.stringify(x)}: one of ${VERB_GROUP_IDS.join(", ")}` };
  return { value: readVerbGroups(raw) };
}

/** The group a verb belongs to, or null for a verb that is structure or never lifted. */
export function groupOfVerb(op: string): string | null {
  if (READ_VERBS.includes(op)) return "read";
  if (WORKER_ACT_VERBS.includes(op)) return "act";
  for (const [id, g] of Object.entries(WORKER_VERB_GROUPS)) if (g.lifts.includes(op)) return id;
  return null;
}

/** A list of origins or profile names: entries are trimmed, empty ones dropped, and `*` stands for all. Empty is `*`, the default. */
export function cleanAllowList(raw: unknown, what: string): { value: string[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: `a list of ${what}` };
  const out: string[] = [];
  for (const x of raw) {
    if (typeof x !== "string") return { error: `a list of ${what}` };
    const t = x.trim();
    if (t.length > 200) return { error: `an entry of ${what} is too long` };
    if (t && !out.includes(t)) out.push(t);
  }
  return { value: out.length ? out : ["*"] };
}

/** An allow list that only loses members, or stops being `*`, narrows. */
export function allowListNarrows(prev: unknown, next: unknown): boolean {
  if (!Array.isArray(prev) || !Array.isArray(next)) return false;
  if (prev.includes("*")) return !next.includes("*");
  return !next.includes("*") && next.every((x) => prev.includes(x));
}

/** Turning a verb group off, and only that, narrows. */
export function verbGroupsNarrow(prev: unknown, next: unknown): boolean {
  return Array.isArray(prev) && Array.isArray(next) && next.every((x) => prev.includes(x));
}
