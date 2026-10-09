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

/** A saved pattern, compiled once per source. Falls back to `fallback` when it
 *  does not compile: a hand-edited file must not break the board it applies to. */
const compiled = new Map<string, RegExp>();
export function prefPattern(src: string, fallback: string): RegExp {
  const key = `${src}\u0000${fallback}`;
  let re = compiled.get(key);
  if (!re) {
    try { re = new RegExp(src || fallback, "i"); } catch { re = new RegExp(fallback, "i"); }
    compiled.set(key, re);
  }
  return re;
}

export function defaultPrefs(): ClickUpPrefs {
  return {
    handoff: { enabled: false, statusNames: [], unassign: "none" },
    review: { statusNames: [], assignReviewer: false },
    flows: { noteOnCard: false },
    prLinkField: "",
    swatchField: "",
    cardSkillPattern: DEFAULT_CARD_SKILL_PATTERN,
    assigned: { includeSubtasks: false },
    sprintListPattern: DEFAULT_SPRINT_LIST_PATTERN,
    readOnlyFieldPattern: DEFAULT_READ_ONLY_FIELD_PATTERN,
    bell: { kinds: [...CLICKUP_BELL_KINDS] },
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
  const top = ["handoff", "review", "flows", "prLinkField", "swatchField", "cardSkillPattern", "assigned", "sprintListPattern", "readOnlyFieldPattern", "bell"];
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
    const g = groupOf("review", ["statusNames", "assignReviewer"]);
    if (!g.ok) return g;
    if ("statusNames" in g.value) { const r = names("review.statusNames", g.value.statusNames); if (!r.ok) return r; out.review.statusNames = r.value; }
    if ("assignReviewer" in g.value) { const r = bool("review.assignReviewer", g.value.assignReviewer); if (!r.ok) return r; out.review.assignReviewer = r.value; }
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
      }
    }
  } catch { /* unreadable file: the defaults are the app as it was */ }
  cache = prefs;
  return prefs;
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
