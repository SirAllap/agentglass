/*
 * How this workspace uses ClickUp, kept beside the boards it applies to.
 *
 * Two kinds of setting live here and the difference matters: how ClickUp works
 * (nothing, that is code) and how one team happens to use it (a QA column with
 * a particular name, a field for the PR link, a sprint naming habit). Only the
 * second is a preference. The defaults reproduce what the app did before this
 * file existed, except the two flows that were one team's habit, which start off.
 *
 * Plain JSON in the config directory for the reason clickup-views.json is: a
 * handful of short strings a person may want to read or edit. No secret here.
 *
 * Patterns are stored as sources and compiled by whoever uses them, so the file
 * stays editable by hand. Saving refuses one that does not compile; a file
 * edited by hand into something invalid falls back to the default for that key
 * rather than breaking every surface that reads it.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { CLICKUP_BELL_KINDS, DEFAULT_SPRINT_LIST_PATTERN, DEFAULT_READ_ONLY_FIELD_PATTERN } from "../../shared/providers.ts";
import { DEFAULT_CARD_SKILL_PATTERN } from "../../shared/cardSkills.ts";
import type { ClickUpPrefs, ClickUpBellKind, HandoffUnassign } from "../../shared/providers.ts";

const FILE = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
  "agentglass",
  "clickup-prefs.json",
);

/** Test seam, so a suite never reads or writes the developer's own settings. */
let override: string | null = null;
export function __setPrefsPath(p: string | null): void { override = p; cache = undefined; }
const path = (): string => override ?? FILE;

/** What each pattern was before it was a setting: clickup.ts, cardSkills.ts. */
export { DEFAULT_CARD_SKILL_PATTERN, DEFAULT_SPRINT_LIST_PATTERN, DEFAULT_READ_ONLY_FIELD_PATTERN };

/** A name is a few words; a list is a handful. A body past these is not a form. */
const MAX_TEXT = 200;
const MAX_ITEMS = 20;

/**
 * A pattern that can take exponential time on a name it does not match. Measured
 * with Bun: `^(a|a)+$` against "a" x 24 + "b" takes 143 ms and doubles with each
 * further character; the names it is tested against are typed by anyone in the
 * workspace, and the test runs on the server's only thread.
 *
 * A heuristic, not a proof. It refuses what that blow-up needs: a group that
 * holds an alternation or a quantifier and is itself repeated without a bound,
 * and a backreference. Nested bounded repeats (`(a{1,3}){1,3}`) and overlapping
 * adjacent quantifiers (`a*a*a*b`) are polynomial and are not caught here; the
 * length cap in `matchPref` is what bounds those.
 */
export function patternProblem(src: string): string | null {
  if (/\\[1-9]|\\k</.test(src)) return "uses a backreference";
  for (const m of src.matchAll(/\(((?:[^()\\]|\\.)*)\)\s*(?:[+*]|\{\d+,\d*\})/g)) {
    if (/[+*|]|\{\d+,/.test(m[1]!.replace(/\\./g, ""))) return "repeats a group that already repeats or branches";
  }
  return null;
}

/** The longest name a saved pattern is tested against. Names are a few words. */
const MAX_TESTED = 200;
/** Test a saved pattern against a name typed by somebody else. */
export function matchPref(src: string, fallback: string, name: string): boolean {
  return prefPattern(src, fallback).test(name.slice(0, MAX_TESTED));
}

/** A saved pattern, compiled once per source. Falls back to `fallback` when it
 *  does not compile: a hand-edited file must not break the board it applies to. */
const compiled = new Map<string, RegExp>();
export function prefPattern(src: string, fallback: string): RegExp {
  const key = `${src}\u0000${fallback}`;
  let re = compiled.get(key);
  if (!re) {
    try {
      if (src && patternProblem(src)) throw new Error("unsafe");
      re = new RegExp(src || fallback, "i");
    } catch { re = new RegExp(fallback, "i"); }
    compiled.set(key, re);
  }
  return re;
}

export function defaultPrefs(): ClickUpPrefs {
  return {
    handoff: { enabled: false, statusNames: [], unassign: "none" },
    review: { enabled: false, statusNames: [], assignReviewer: false },
    merge: { enabled: false, statusNames: [] },
    flows: { noteOnCard: false },
    prLinkField: "",
    swatchField: "",
    cardSkillPattern: DEFAULT_CARD_SKILL_PATTERN,
    assigned: { includeSubtasks: false },
    sprintListPattern: DEFAULT_SPRINT_LIST_PATTERN,
    readOnlyFieldPattern: DEFAULT_READ_ONLY_FIELD_PATTERN,
    bell: { kinds: [...CLICKUP_BELL_KINDS] },
    statusSpaces: { counted: [] },
  };
}

type Fail = { ok: false; error: string };
type Ok<T> = { ok: true; value: T };
type Res<T> = Ok<T> | Fail;
const bad = (error: string): Fail => ({ ok: false, error });
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function bool(name: string, v: unknown): Res<boolean> {
  return typeof v === "boolean" ? { ok: true, value: v } : bad(`${name} must be true or false`);
}
function text(name: string, v: unknown): Res<string> {
  if (typeof v !== "string") return bad(`${name} must be text`);
  const t = v.trim();
  return t.length > MAX_TEXT ? bad(`${name} is longer than ${MAX_TEXT} characters`) : { ok: true, value: t };
}
function names(name: string, v: unknown): Res<string[]> {
  if (!Array.isArray(v)) return bad(`${name} must be a list of names`);
  if (v.length > MAX_ITEMS) return bad(`${name} has more than ${MAX_ITEMS} entries`);
  const out: string[] = [];
  for (const x of v) {
    const t = text(name, x);
    if (!t.ok) return t;
    if (t.value && !out.includes(t.value)) out.push(t.value);
  }
  return { ok: true, value: out };
}
function pattern(name: string, v: unknown, fallback: string): Res<string> {
  const t = text(name, v);
  if (!t.ok) return t;
  if (!t.value) return { ok: true, value: fallback };
  try { new RegExp(t.value, "i"); } catch (e) {
    return bad(`${name} is not a valid pattern: ${(e as Error).message}`);
  }
  const problem = patternProblem(t.value);
  if (problem) return bad(`${name} ${problem}, which can hang the app on a long name`);
  return { ok: true, value: t.value };
}

/**
 * Apply a partial update on top of `base`. Unknown keys are refused rather than
 * ignored: a typo that is silently dropped looks exactly like a setting that
 * was saved. Nested groups merge one level, so `{ handoff: { enabled: true } }`
 * leaves the other two hand-off keys as they were.
 */
export function applyPrefs(base: ClickUpPrefs, input: unknown): Res<ClickUpPrefs> {
  if (!isObj(input)) return bad("settings must be an object");
  const out: ClickUpPrefs = structuredClone(base);
  const groupOf = (k: string, allowed: string[]): Res<Record<string, unknown>> => {
    const g = input[k];
    if (!isObj(g)) return bad(`${k} must be an object`);
    for (const key of Object.keys(g)) if (!allowed.includes(key)) return bad(`${k}.${key} is not a setting`);
    return { ok: true, value: g };
  };
  const top = ["handoff", "review", "merge", "flows", "prLinkField", "swatchField", "cardSkillPattern", "assigned", "sprintListPattern", "readOnlyFieldPattern", "bell", "statusSpaces"];
  for (const k of Object.keys(input)) if (!top.includes(k)) return bad(`${k} is not a setting`);

  if ("handoff" in input) {
    const g = groupOf("handoff", ["enabled", "statusNames", "unassign"]);
    if (!g.ok) return g;
    if ("enabled" in g.value) { const r = bool("handoff.enabled", g.value.enabled); if (!r.ok) return r; out.handoff.enabled = r.value; }
    if ("statusNames" in g.value) { const r = names("handoff.statusNames", g.value.statusNames); if (!r.ok) return r; out.handoff.statusNames = r.value; }
    if ("unassign" in g.value) {
      const u = g.value.unassign;
      if (u !== "none" && u !== "me" && u !== "all") return bad("handoff.unassign must be none, me or all");
      out.handoff.unassign = u as HandoffUnassign;
    }
  }
  if ("review" in input) {
    const g = groupOf("review", ["enabled", "statusNames", "assignReviewer"]);
    if (!g.ok) return g;
    if ("enabled" in g.value) { const r = bool("review.enabled", g.value.enabled); if (!r.ok) return r; out.review.enabled = r.value; }
    if ("statusNames" in g.value) { const r = names("review.statusNames", g.value.statusNames); if (!r.ok) return r; out.review.statusNames = r.value; }
    if ("assignReviewer" in g.value) { const r = bool("review.assignReviewer", g.value.assignReviewer); if (!r.ok) return r; out.review.assignReviewer = r.value; }
  }
  if ("merge" in input) {
    const g = groupOf("merge", ["enabled", "statusNames"]);
    if (!g.ok) return g;
    if ("enabled" in g.value) { const r = bool("merge.enabled", g.value.enabled); if (!r.ok) return r; out.merge.enabled = r.value; }
    if ("statusNames" in g.value) { const r = names("merge.statusNames", g.value.statusNames); if (!r.ok) return r; out.merge.statusNames = r.value; }
  }
  if ("flows" in input) {
    const g = groupOf("flows", ["noteOnCard"]);
    if (!g.ok) return g;
    if ("noteOnCard" in g.value) { const r = bool("flows.noteOnCard", g.value.noteOnCard); if (!r.ok) return r; out.flows.noteOnCard = r.value; }
  }
  if ("assigned" in input) {
    const g = groupOf("assigned", ["includeSubtasks"]);
    if (!g.ok) return g;
    if ("includeSubtasks" in g.value) { const r = bool("assigned.includeSubtasks", g.value.includeSubtasks); if (!r.ok) return r; out.assigned.includeSubtasks = r.value; }
  }
  if ("bell" in input) {
    const g = groupOf("bell", ["kinds"]);
    if (!g.ok) return g;
    if ("kinds" in g.value) {
      const k = g.value.kinds;
      if (!Array.isArray(k)) return bad("bell.kinds must be a list");
      for (const x of k) if (!CLICKUP_BELL_KINDS.includes(x as ClickUpBellKind)) return bad(`bell.kinds has an unknown kind: ${String(x).slice(0, 40)}`);
      out.bell.kinds = CLICKUP_BELL_KINDS.filter((x) => k.includes(x));
    }
  }
  if ("statusSpaces" in input) {
    const g = groupOf("statusSpaces", ["counted"]);
    if (!g.ok) return g;
    if ("counted" in g.value) {
      const r = names("statusSpaces.counted", g.value.counted);
      if (!r.ok) return r;
      // A space id is digits; anything else would only ever match nothing, so it is refused loudly rather than saved.
      if (r.value.some((x) => !/^[0-9]{1,20}$/.test(x))) return bad("statusSpaces.counted must be a list of space ids");
      out.statusSpaces.counted = r.value;
    }
  }
  if ("prLinkField" in input) { const r = text("prLinkField", input.prLinkField); if (!r.ok) return r; out.prLinkField = r.value; }
  if ("swatchField" in input) { const r = text("swatchField", input.swatchField); if (!r.ok) return r; out.swatchField = r.value; }
  if ("cardSkillPattern" in input) { const r = pattern("cardSkillPattern", input.cardSkillPattern, DEFAULT_CARD_SKILL_PATTERN); if (!r.ok) return r; out.cardSkillPattern = r.value; }
  if ("sprintListPattern" in input) { const r = pattern("sprintListPattern", input.sprintListPattern, DEFAULT_SPRINT_LIST_PATTERN); if (!r.ok) return r; out.sprintListPattern = r.value; }
  if ("readOnlyFieldPattern" in input) { const r = pattern("readOnlyFieldPattern", input.readOnlyFieldPattern, DEFAULT_READ_ONLY_FIELD_PATTERN); if (!r.ok) return r; out.readOnlyFieldPattern = r.value; }
  return { ok: true, value: out };
}

let cache: ClickUpPrefs | undefined;

/** What is on disk laid over the defaults. A key that no longer validates (a
 *  hand edit, an older file) keeps its default; the rest still apply. */
export function clickupPrefs(): ClickUpPrefs {
  if (cache) return cache;
  let prefs = defaultPrefs();
  try {
    const p = path();
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
      if (isObj(raw)) {
        for (const k of Object.keys(raw)) {
          const r = applyPrefs(prefs, { [k]: raw[k] });
          if (r.ok) prefs = r.value;
        }
        /* A file from before the review menu and the merge choice were steps: both
           were always there, so they stay for anyone the file shows using ClickUp
           (a hand-off, reviewers, a note or review names set). A file of pure
           defaults is the marker `settleFirstRun` writes for a machine with no
           token yet, and that person connects later with nothing on. Only a file
           that never heard of the key reads this way; one written since says
           `enabled` itself. Ceiling: somebody who had switched all of those off
           and kept only the review item loses it once, and can add it back. */
        if (!isObj(raw.review) || !("enabled" in raw.review)) {
          const usedIt = prefs.handoff.enabled || prefs.review.assignReviewer || prefs.flows.noteOnCard || prefs.review.statusNames.length > 0;
          if (usedIt) { prefs.review.enabled = true; prefs.merge.enabled = true; }
        }
      }
    }
  } catch { /* unreadable file: the defaults are the app as it was */ }
  cache = prefs;
  return prefs;
}

/**
 * The first start after the settings existed, decided once.
 *
 * A person who already had ClickUp connected had the review menu's move, the
 * reviewer list, the merge dialog's card choice, the Note on card and the hand-off
 * to the QA column; the defaults above switch all five off, so an update would take them away until
 * Settings was opened. So when there is no file and a token exists, the file is
 * written with those five on
 * — the hand-off clearing every assignee, as it always did — and every other
 * key at its default.
 *
 * Everyone else gets the defaults written as a marker, and that is the point of
 * writing anything at all: without it the first start with no token and the
 * first start after connecting look the same, and somebody who connected today
 * would be handed another team's habits. The file is read by nothing but this
 * app, and a fresh machine sees no difference.
 *
 * The ceiling: it runs once per start, so a file deleted by hand while a token
 * exists is seeded again on the next start.
 */
export function settleFirstRun(connected: boolean): "seeded" | "defaults" | "kept" {
  const p = path();
  if (existsSync(p)) return "kept";
  const first = defaultPrefs();
  if (connected) {
    first.handoff.enabled = true;
    first.handoff.unassign = "all";
    first.review.enabled = true;
    first.merge.enabled = true;
    first.review.assignReviewer = true;
    first.flows.noteOnCard = true;
  }
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(first, null, 2) + "\n");
  } catch { return "kept"; /* unwritable: the defaults stand, and the next start asks again */ }
  cache = undefined;
  return connected ? "seeded" : "defaults";
}

/** Validate, merge and write. Nothing is written when anything is refused. */
export function setClickupPrefs(input: unknown): { ok: true; prefs: ClickUpPrefs } | { ok: false; error: string } {
  const r = applyPrefs(clickupPrefs(), input);
  if (!r.ok) return r;
  const p = path();
  try {
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(r.value, null, 2) + "\n");
    renameSync(tmp, p);
  } catch (e) {
    return { ok: false, error: `could not save the settings: ${(e as Error).message}` };
  }
  cache = r.value;
  return { ok: true, prefs: r.value };
}
