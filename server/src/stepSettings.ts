/*
 * What a settings file may say about a step, shared by every tracker that has
 * steps (ClickUp's prefs, Jira's settings). A step is a list of blocks; this is
 * the one place that decides which lists are accepted, so the two stores refuse
 * the same things in the same words and a hand-edited file cannot hold what the
 * page would not offer.
 *
 * The tracker is the only thing that differs: whose person ids are numbers
 * (ClickUp) or account ids and logins (Jira), and which kinds of block exist
 * (Jira has a link and no custom field). ClickUp's sentences are kept exactly as
 * they were when this code lived in clickupPrefs.ts; its tests pin them.
 */
import type { HandoffUnassign, StepAssign, StepBlock } from "../../shared/providers.ts";
import { MAX_BLOCKS, MAX_COMMENT, MAX_FIELD_NAME, MAX_FIELD_VALUE, blocksFromLegacy, blocksProblem, legacyFromBlocks, type StepTrigger } from "../../shared/stepBlocks.ts";

export type StepTracker = "clickup" | "jira";
export type Fail = { ok: false; error: string };
export type Ok<T> = { ok: true; value: T };
export type Res<T> = Ok<T> | Fail;
export const bad = (error: string): Fail => ({ ok: false, error });
export const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A name is a few words; a list is a handful. A body past these is not a form. */
export const MAX_TEXT = 200;
export const MAX_ITEMS = 20;

export function text(name: string, v: unknown): Res<string> {
  if (typeof v !== "string") return bad(`${name} must be text`);
  const t = v.trim();
  return t.length > MAX_TEXT ? bad(`${name} is longer than ${MAX_TEXT} characters`) : { ok: true, value: t };
}
export function names(name: string, v: unknown): Res<string[]> {
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

/** A person id a step may hold: a member id for ClickUp; for Jira an account id or login, never the default-assignee word. */
function personOk(tracker: StepTracker, id: unknown): id is number | string {
  if (tracker === "clickup") return typeof id === "number" && Number.isSafeInteger(id) && id > 0;
  // eslint-disable-next-line no-control-regex
  return typeof id === "string" && /^[^\s\u0000-\u001f\u007f]{1,255}$/.test(id) && id !== "-1";
}
const WHO_ID = (tracker: StepTracker) => (tracker === "clickup" ? "a member id" : "an account id or login");

/** One step's "also assign": replaced whole, never merged field by field, so a
 *  person left over from an earlier choice cannot survive a switch to `me`. */
export function assign(name: string, v: unknown): Res<StepAssign<number>>;
export function assign(name: string, v: unknown, tracker: StepTracker): Res<StepAssign>;
export function assign(name: string, v: unknown, tracker: StepTracker = "clickup"): Res<StepAssign> {
  if (!isObj(v)) return bad(`${name} must be an object like {"who":"me"}`);
  for (const k of Object.keys(v)) if (k !== "who" && k !== "person") return bad(`${name}.${k} is not a setting`);
  const w = v.who;
  if (w === "author") {
    return bad(tracker === "clickup"
      ? `${name}.who "author" is not offered for ClickUp: a pull request's author and a ClickUp member are different systems and never the same identity. Use { "who": "none", "ask": true } on an assign block to pick who when it runs.`
      : `${name}.who "author" is not offered for Jira: a pull request's author and a Jira user are different systems and never the same identity. Use { "who": "none", "ask": true } on an assign block to pick who when it runs.`);
  }
  if (w !== "none" && w !== "me" && w !== "person") return bad(`${name}.who must be none, me or person`);
  if (w !== "person") {
    return "person" in v && v.person != null ? bad(`${name}.person is only for who: "person"`) : { ok: true, value: { who: w } };
  }
  const p = v.person;
  if (!isObj(p)) return bad(`${name}.person must be {"id": <member id>, "name": "<name>"} when who is person`);
  for (const k of Object.keys(p)) if (k !== "id" && k !== "name") return bad(`${name}.person.${k} is not a setting`);
  if (!personOk(tracker, p.id)) return bad(`${name}.person.id must be ${tracker === "clickup" ? "a member id" : WHO_ID(tracker)}`);
  const n = text(`${name}.person.name`, p.name);
  if (!n.ok) return n;
  if (!n.value) return bad(`${name}.person.name must be the member's name`);
  return { ok: true, value: { who: "person", person: { id: p.id, name: n.value } } };
}

/**
 * A step's block list: replaced whole, in the order given. Each block is checked
 * the way the screen checks it (see blocksProblem), so a list the page would not
 * offer is not saved by hand either, and an unknown key is refused like anywhere else.
 */
export function blockList(name: string, v: unknown, trigger: StepTrigger, tracker: StepTracker = "clickup"): Res<StepBlock[]> {
  if (!Array.isArray(v)) return bad(`${name} must be a list of blocks`);
  if (v.length > MAX_BLOCKS) return bad(`${name} has more than ${MAX_BLOCKS} blocks`);
  const clickup = tracker === "clickup";
  const out: StepBlock[] = [];
  for (const [i, b] of v.entries()) {
    const at = `${name}[${i}]`;
    if (!isObj(b)) return bad(`${at} must be an object like {"type":"move","statusNames":["..."]}`);
    if (b.type === "move") {
      for (const k of Object.keys(b)) if (k !== "type" && k !== "statusNames" && (k !== "fallback" || !clickup) && k !== "ask") return bad(`${at}.${k} is not a setting`);
      const r = names(`${at}.statusNames`, "statusNames" in b ? b.statusNames : []);
      if (!r.ok) return r;
      if ("fallback" in b && typeof b.fallback !== "boolean") return bad(`${at}.fallback must be true or false`);
      if ("ask" in b && b.ask !== true && b.ask !== false) return bad(`${at}.ask must be true or false`);
      out.push({ type: "move", statusNames: r.value, ...(b.fallback === true && !r.value.length ? { fallback: true } : null), ...(b.ask === true ? { ask: true as const } : null) });
    } else if (b.type === "unassign") {
      for (const k of Object.keys(b)) if (k !== "type" && k !== "who" && k !== "ask" && k !== "people") return bad(`${at}.${k} is not a setting`);
      if ("ask" in b && b.ask !== true && b.ask !== false) return bad(`${at}.ask must be true or false`);
      if (b.who !== "none" && b.who !== "me" && b.who !== "all" && b.who !== "people") return bad(`${at}.who must be none, me, all or people`);
      let people: { id: number | string; name: string }[] | undefined;
      if (b.who === "people" || "people" in b) {
        if (b.who !== "people") return bad(`${at}.people is for who: "people"`);
        if (!Array.isArray(b.people) || b.people.length > 20) return bad(`${at}.people must be a list of up to 20 people`);
        people = [];
        for (const p of b.people) {
          if (!isObj(p) || !personOk(tracker, p.id)) return bad(`${at}.people needs {"id": <member id>, "name": "<name>"} entries`);
          const n = text(`${at}.people.name`, p.name);
          if (!n.ok) return n;
          if (!n.value) return bad(`${at}.people names must be the member's name`);
          if (!people.some((x) => x.id === p.id)) people.push({ id: p.id, name: n.value });
        }
        if (!people.length && b.ask !== true) return bad(`${at}.people is empty: remove the block to take nobody off`);
      }
      out.push({ type: "unassign", who: b.who, ...(people ? { people } : null), ...(b.ask === true ? { ask: true as const } : null) });
    } else if (b.type === "assign") {
      const { type: _t, ask, also, ...rest } = b;
      if (ask !== undefined && ask !== true && ask !== false) return bad(`${at}.ask must be true or false`);
      const r = assign(at, rest, tracker);
      if (!r.ok) return r;
      if (r.value.who === "none" && ask !== true) return bad(`${at}.who must be me, author or person: remove the block to assign nobody (or set ask: true, where none is “nobody” as the starting choice)`);
      let more: { id: number | string; name: string }[] = [];
      if (also !== undefined) {
        if (ask !== true || r.value.who !== "person") return bad(`${at}.also is for a block that asks when it runs and starts at a person`);
        if (!Array.isArray(also) || also.length > 20) return bad(`${at}.also must be a list of up to 20 people`);
        for (const p of also) {
          if (!isObj(p) || !personOk(tracker, p.id)) return bad(`${at}.also needs {"id": <member id>, "name": "<name>"} entries`);
          const n = text(`${at}.also.name`, p.name);
          if (!n.ok) return n;
          if (!n.value) return bad(`${at}.also names must be the member's name`);
          if (p.id !== r.value.person?.id && !more.some((x) => x.id === p.id)) more.push({ id: p.id, name: n.value });
        }
      }
      out.push({ type: "assign", ...(ask === true ? { ask: true as const } : null), ...r.value, ...(more.length ? { also: more } : null) });
    } else if (b.type === "comment") {
      for (const k of Object.keys(b)) if (k !== "type" && k !== "text" && k !== "ask") return bad(`${at}.${k} is not a setting`);
      if (typeof b.text !== "string" || !b.text.trim()) return bad(`${at}.text must be the comment, with {pr}, {pr_url}, {author}, {status} or {me} where they belong`);
      if (b.text.length > MAX_COMMENT) return bad(`${at}.text is longer than ${MAX_COMMENT} characters`);
      if ("ask" in b && b.ask !== true && b.ask !== false) return bad(`${at}.ask must be true or false`);
      out.push({ type: "comment", text: b.text, ...(b.ask === true ? { ask: true as const } : null) });
    } else if (b.type === "field" && clickup) {
      for (const k of Object.keys(b)) if (k !== "type" && k !== "field" && k !== "value" && k !== "ask") return bad(`${at}.${k} is not a setting`);
      const f = text(`${at}.field`, b.field);
      if (!f.ok) return f;
      if (!f.value) return bad(`${at}.field must be the name of one of the card's custom fields`);
      if (f.value.length > MAX_FIELD_NAME) return bad(`${at}.field is longer than ${MAX_FIELD_NAME} characters`);
      if (typeof b.value !== "string") return bad(`${at}.value must be text: an option's name, a number, or a date as YYYY-MM-DD`);
      if (b.value.length > MAX_FIELD_VALUE) return bad(`${at}.value is longer than ${MAX_FIELD_VALUE} characters`);
      if ("ask" in b && b.ask !== true && b.ask !== false) return bad(`${at}.ask must be true or false`);
      out.push({ type: "field", field: f.value, value: b.value.trim(), ...(b.ask === true ? { ask: true as const } : null) });
    } else if (b.type === "link" && !clickup) {
      for (const k of Object.keys(b)) if (k !== "type") return bad(`${at}.${k} is not a setting`);
      out.push({ type: "link" });
    } else return bad(clickup ? `${at}.type must be move, unassign, assign, comment or field` : `${at}.type must be move, unassign, assign, comment or link`);
  }
  const problem = blocksProblem(trigger, out, tracker);
  return problem ? bad(`${name} ${problem}`) : { ok: true, value: out };
}

export const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * A block that asks when it runs has no place in the three old keys, so a save that only knows those keys
 * must not drop it: the ask on a move survives while the names stay what they were, and an asking assign
 * survives unless the save set an assignment itself.
 */
export function carryAsk(prev: StepBlock[] | undefined, next: StepBlock[], assignSet: boolean, namesSet: boolean): StepBlock[] {
  if (!prev) return next;
  const out = [...next];
  const pm = prev.find((b) => b.type === "move" && b.ask);
  const mi = out.findIndex((b) => b.type === "move");
  if (pm && pm.type === "move" && mi >= 0 && !namesSet) out[mi] = { ...(out[mi] as Extract<StepBlock, { type: "move" }>), ask: true };
  const pa = prev.find((b) => b.type === "assign" && b.ask);
  if (pa && !assignSet && !out.some((b) => b.type === "assign")) out.push(pa);
  /* A comment and a field have no old key at all: they are only ever in the blocks, and stay. */
  for (const b of prev) if ((b.type === "comment" || b.type === "field") && !out.some((x) => x.type === b.type)) out.push(b);
  /* The order the person gave stays: kinds that were there keep their places, new ones follow. */
  const at = (b: StepBlock) => { const i = prev.findIndex((x) => x.type === b.type); return i < 0 ? prev.length + out.indexOf(b) : i; };
  return [...out].sort((x, y) => at(x) - at(y));
}

export type StepGroup = { enabled: boolean; statusNames: string[]; unassign?: HandoffUnassign; assign: StepAssign; blocks?: StepBlock[] };

/* Blocks and the three old keys are one step written two ways. Blocks given: they win, and the old keys
   are rewritten from them (a patch that sets both must agree, or it is refused rather than half kept).
   Only old keys given: the blocks are read from them, as a file from before blocks is.
   A tracker whose steps never had the old keys (Jira) has the blocks and nothing else to agree with. */
export function settle(key: string, trigger: StepTrigger, patch: Record<string, unknown>, now: StepGroup, was: StepGroup, tracker: StepTracker = "clickup"): Res<true> {
  if ("blocks" in patch) {
    const r = blockList(`${key}.blocks`, patch.blocks, trigger, tracker);
    if (!r.ok) return r;
    if (tracker === "jira") { now.blocks = r.value; return { ok: true, value: true }; }
    const l = legacyFromBlocks(r.value);
    for (const k of ["statusNames", "unassign", "assign"] as const) {
      if (k in patch && !same(now[k], l[k])) return bad(`${key}.${k} says something different from ${key}.blocks: set one of them`);
    }
    now.blocks = r.value;
    now.statusNames = l.statusNames; now.assign = l.assign;
    if ("unassign" in now) now.unassign = l.unassign;
  } else if (tracker === "jira") {
    now.blocks = was.blocks;
  } else if (["enabled", "statusNames", "unassign", "assign"].some((k) => k in patch)) {
    const next = blocksFromLegacy(trigger, { enabled: now.enabled, statusNames: now.statusNames, unassign: now.unassign, assign: now.assign });
    now.blocks = carryAsk(was.blocks, next, "assign" in patch, "statusNames" in patch);
  } else now.blocks = was.blocks;
  return { ok: true, value: true };
}
