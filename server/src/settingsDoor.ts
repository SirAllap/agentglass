/*
 * THE SETTINGS DOOR: an agent may ask to change any setting; the risky ones wait
 * for one click from the person.
 *
 * Which is which is shared/settingClass.ts. This file is the part that holds a
 * request: what was asked, by whom, the diff the SERVER computed from the value
 * it validated (never a sentence the agent wrote), and the one function that
 * applies it once the person says yes. Approving applies that value and nothing
 * else, and only while the setting still reads what it read when the request was
 * made: a diff against a value that moved since is not the diff the person saw.
 * Nothing here is remembered for next time; a second change is a second request.
 *
 * Who is the person is not decided here. index.ts asks the same question the
 * orchestration route always asked (mayChangePolicy, plus no agent name on the
 * request) and hands the answer in; this file only refuses to approve for a
 * caller that is not.
 *
 * Requests live in memory: a restart drops them, which is a decline, the safe
 * way to lose one. The defs are a parameter so the decision is tested without a
 * server (server/test/settings-door.test.ts).
 */
import { randomBytes } from "node:crypto";
import { REQUEST_TTL_MS, SETTING_CLASSES, agentVerdict, classOf, refusalWhy } from "../../shared/settingClass.ts";

export type Applied = { ok: true } | { ok: false; error: string };

export interface ServerSettingDef {
  id: string;
  label: string;
  /** The Settings page it lives on, for `settings list`. */
  page: string;
  /** Held per project: the request names a root. */
  scoped?: true;
  type: "boolean" | "number" | "string" | "json";
  read(root?: string): unknown;
  /** The value as it will be stored, or why not. Nothing is written here. */
  validate(raw: unknown, root?: string): { value: unknown } | { error: string };
  apply(value: unknown, root?: string): Applied | Promise<Applied>;
  /** What will be in force once `value` is applied, when that is not the value
   *  itself (a removal that falls back to a default): the diff is read against it. */
  effective?(value: unknown, root?: string): unknown;
  /** Lines the card adds below the diff, from the server's own records (a plugin's
   *  declaration): what approving also approves. Read again on approval; if they
   *  changed, nothing applies. */
  explain?(value: unknown, root?: string): string[];
}

export interface SettingRequest {
  id: string;
  setting: string;
  label: string;
  root?: string;
  /** Who asked, as the server knows them: a worker's registered name, a seat's
   *  project, or the `--as` label a CLI stamped (the closed charset callerRequestId allows). */
  who: string;
  prev: unknown;
  value: unknown;
  /** What the diff was read against on the other side (a removal's fallback), checked again on approval. */
  shownNext?: unknown;
  /** The def's `explain` lines as the card showed them. */
  explained?: string[];
  /** Lines the server wrote from prev and value. */
  diff: string[];
  at: number;
  expires: number;
  /** Who applies it: a server setting, or the window's registry (index.ts relays it). */
  where: "server" | "window";
}

export type DoorAnswer =
  | { ok: true; applied: true; setting: string; prev: unknown; value: unknown; unchanged?: true }
  | { ok: true; applied: false; pending: PublicRequest }
  | { ok: false; error: string; status: number };

/** What any reader of GET /settings/requests sees: the card's words, not the stored values. */
export type PublicRequest = Pick<SettingRequest, "id" | "setting" | "label" | "root" | "who" | "diff" | "at" | "expires">;

/** How many requests may wait at once. More is a loop, not a person's errand. */
export const MAX_PENDING = 20;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** The most a card shows: lines, and characters of one value. */
const MAX_LINES = 60;
const MAX_VALUE = 300;

/** A value as a diff line shows it: JSON, so text the value carries reads as data. */
export const shown = (v: unknown): string => {
  const s = v === undefined ? "(unset)" : JSON.stringify(v);
  // Cut, and said so. A request whose diff would be cut is refused (diffLines): a
  // tail the person cannot see is not one they approve.
  return s.length > MAX_VALUE ? `${s.slice(0, MAX_VALUE)}... (${s.length - MAX_VALUE} more characters)` : s;
};

/**
 * The leaves that differ between two values, one line each, `path: old -> new`.
 * Capped: a request with more lines than the person will read says how many
 * more there are rather than pretending to be short.
 */
export function leafDiff(prev: unknown, next: unknown, path = "", out: string[] = []): string[] {
  const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";
  // Something new or gone whole is still shown leaf by leaf, against nothing.
  if (prev === undefined && obj(next)) prev = Array.isArray(next) ? [] : {};
  if (next === undefined && obj(prev)) next = Array.isArray(prev) ? [] : {};
  if (obj(prev) && obj(next) && Array.isArray(prev) === Array.isArray(next)) {
    const keys = [...new Set([...Object.keys(prev), ...Object.keys(next)])];
    for (const k of keys) {
      const p = Array.isArray(prev) ? `${path}[${k}]` : path ? `${path}.${k}` : k;
      leafDiff(prev[k], next[k], p, out);
    }
    return out;
  }
  if (!same(prev, next)) out.push(`${path || "value"}: ${shown(prev)} -> ${shown(next)}`);
  return out;
}

/** The card's lines, or null when they would not fit on it whole: the person
 *  approves everything a request applies, so a request they cannot see all of is
 *  not made. The agent asks in smaller steps. */
function diffLines(def: { label: string }, prev: unknown, next: unknown, root?: string, explained: string[] = []): string[] | null {
  const lines = [...leafDiff(prev, next), ...explained];
  if (lines.length > MAX_LINES || lines.some((l) => l.includes(" more characters)"))) return null;
  // The root is the caller's to name: quoted, so a folder named like a sentence reads as a path.
  return [`${def.label}${root ? ` (project ${JSON.stringify(root)})` : ""}`, ...lines];
}
const TOO_BIG = `too large to show the person on one card (at most ${MAX_LINES} changed values of ${MAX_VALUE} characters): ask for it in smaller steps`;

export interface Door {
  /** A change asked for by someone. `person` is index.ts's verdict on the caller. */
  /** `confined`: a caller held to one project (a seat): a change to anything not
   *  held per project waits for the person whatever its class. */
  change(id: string, raw: unknown, opts: { root?: string; person: boolean; who: string; confined?: boolean }): Promise<DoorAnswer>;
  /**
   * An escalation the window refused for want of the person (the window's own
   * registry holds the value, so the window decides whether it narrows). The
   * request holds the value the window validated; `apply` is index.ts relaying it back.
   */
  askForWindow(id: string, label: string, prev: unknown, value: unknown, who: string): DoorAnswer;
  /** One setting's value, never a secret's. */
  value(id: string, root?: string): { value: unknown } | { error: string };
  pending(): PublicRequest[];
  /** The person's answer. Refused for anybody else, whatever the route. */
  decide(rid: unknown, approve: boolean, person: boolean): Promise<{ ok: true; applied: boolean; setting: string } | { ok: false; error: string; status: number }>;
  list(): { id: string; label: string; page: string; scoped: boolean; type: string; class: string; why: string; value?: unknown }[];
}

export function makeDoor(deps: {
  /** Read per call: a plugin installed a minute ago has its switch here now. */
  defs(): readonly ServerSettingDef[];
  /** The person's switch: agents change escalations without asking. */
  trusted(): boolean;
  /** Apply a window request the person approved (index.ts: a granted settings.set). */
  applyWindow(id: string, value: unknown, expect: unknown): Promise<Applied>;
  /** Told whenever the list of requests changes, so the window re-reads it. */
  changed(): void;
  now?: () => number;
  /** A timer for a request's expiry; tests pass a no-op and move the clock. */
  later?: (ms: number, fn: () => void) => void;
}): Door {
  const now = deps.now ?? Date.now;
  const later = deps.later ?? ((ms, fn) => { const t = setTimeout(fn, ms); (t as { unref?: () => void }).unref?.(); });
  const defOf = (id: string) => deps.defs().find((d) => d.id === id);
  const requests = new Map<string, SettingRequest>();
  const view = (r: SettingRequest): PublicRequest => ({
    id: r.id, setting: r.setting, label: r.label, ...(r.root ? { root: r.root } : {}), who: r.who, diff: [...r.diff], at: r.at, expires: r.expires,
  });

  /** Expired requests are declined: dropped, with nothing applied. */
  const prune = () => {
    let dropped = false;
    for (const [k, r] of requests) if (r.expires <= now()) { requests.delete(k); dropped = true; }
    return dropped;
  };

  const queue = (r: Omit<SettingRequest, "id" | "at" | "expires" | "diff"> & { diff: string[] | null }): DoorAnswer => {
    if (!r.diff) return { ok: false, error: `${r.setting}: ${TOO_BIG}`, status: 413 };
    prune();
    // A newer ask for the same setting from the same caller replaces the older one.
    for (const [k, x] of requests) if (x.setting === r.setting && x.root === r.root && x.who === r.who) requests.delete(k);
    if (requests.size >= MAX_PENDING) return { ok: false, error: `${MAX_PENDING} requests are already waiting for the person; wait for an answer`, status: 429 };
    const req: SettingRequest = { ...r, diff: r.diff, id: `sr_${randomBytes(12).toString("hex")}`, at: now(), expires: now() + REQUEST_TTL_MS };
    requests.set(req.id, req);
    later(REQUEST_TTL_MS + 50, () => { if (prune()) deps.changed(); });
    deps.changed();
    return { ok: true, applied: false, pending: view(req) };
  };

  return {
    async change(id, raw, { root, person, who, confined }) {
      const def = defOf(id);
      const row = classOf(id);
      if (row?.class === "secret") return { ok: false, error: `${id} is a secret: it is never read or written through this door`, status: 403 };
      if (!def || !row) return { ok: false, error: `${id} is not a setting this door knows (settings list names them)`, status: 404 };
      if (def.scoped && !root) return { ok: false, error: `${id} is held per project: name the project root`, status: 400 };
      const v = def.validate(raw, root);
      if ("error" in v) return { ok: false, error: `${id}: ${v.error}`, status: 400 };
      const prev = def.read(root);
      if (same(prev, v.value)) return { ok: true, applied: true, setting: id, prev, value: v.value, unchanged: true };
      let verdict = person ? "apply" : agentVerdict(id, prev, v.value, deps.trusted());
      // A seat speaks for its own project: what is the whole machine's waits for the person.
      if (verdict === "apply" && !person && confined && !def.scoped && !(id === "orchestration.policy" && root)) verdict = "ask";
      if (verdict === "refuse") return { ok: false, error: `${id}: ${refusalWhy(id, prev, v.value)}. An agent cannot change it, not even by asking`, status: 403 };
      if (verdict === "ask") {
        const shownNext = def.effective ? def.effective(v.value, root) : v.value;
        const explained = def.explain?.(v.value, root);
        return queue({ setting: id, label: def.label, ...(root ? { root } : {}), who, prev, value: v.value, ...(def.effective ? { shownNext } : {}), ...(explained ? { explained } : {}), diff: diffLines(def, prev, shownNext, root, explained), where: "server" });
      }
      const r = await def.apply(v.value, root);
      if (!r.ok) return { ok: false, error: r.error, status: 400 };
      return { ok: true, applied: true, setting: id, prev, value: v.value };
    },
    askForWindow(id, label, prev, value, who) {
      const row = classOf(id);
      // Only a setting the window holds: a server one never comes this way, so a
      // socket posing as a window cannot plant a card for one.
      if (!row || row.class !== "escalation" || defOf(id)) return { ok: false, error: `${id} is not a window setting that waits for the person`, status: 400 };
      return queue({ setting: id, label, who, prev, value, diff: diffLines({ label }, prev, value), where: "window" });
    },
    value(id, root) {
      const def = defOf(id);
      const row = classOf(id);
      if (!def || !row) return { error: `${id} is not a setting this door knows` };
      if (row.class === "secret") return { error: `${id} is a secret: it is never read through this door` };
      if (def.scoped && !root) return { error: `${id} is held per project: name the project root` };
      return { value: def.read(root) };
    },
    pending() {
      if (prune()) deps.changed();
      return [...requests.values()].map(view);
    },
    async decide(rid, approve, person) {
      if (!person) return { ok: false, error: "only the person answers a settings request: an agent cannot approve or decline one, its own included", status: 403 };
      const expired = prune();
      const r = typeof rid === "string" ? requests.get(rid) : undefined;
      if (expired) deps.changed();
      if (!r) return { ok: false, error: "no such request: it was answered, it expired (declined after 30 minutes), or the server restarted", status: 404 };
      requests.delete(r.id);
      deps.changed();
      if (!approve) return { ok: true, applied: false, setting: r.setting };
      if (r.where === "window") {
        // The window applies it only while it still holds what the card was read against.
        const a = await deps.applyWindow(r.setting, r.value, r.prev);
        return a.ok ? { ok: true, applied: true, setting: r.setting } : { ok: false, error: a.error, status: 409 };
      }
      const def = defOf(r.setting);
      if (!def) return { ok: false, error: `${r.setting} is gone (a plugin removed since?), so nothing was applied`, status: 409 };
      // The person approved THIS diff: if the setting moved since, it is not the one they saw.
      if (!same(def.read(r.root), r.prev) || ("shownNext" in r && !same(def.effective!(r.value, r.root), r.shownNext))
        || ("explained" in r && !same(def.explain!(r.value, r.root), r.explained))) return { ok: false, error: `${r.setting} changed since the request was made, so nothing was applied; the agent can ask again`, status: 409 };
      const v = def.validate(r.value, r.root);
      if ("error" in v || !same(v.value, r.value)) return { ok: false, error: `${r.setting}: the value is no longer valid, so nothing was applied`, status: 409 };
      const a = await def.apply(r.value, r.root);
      return a.ok ? { ok: true, applied: true, setting: r.setting } : { ok: false, error: a.error, status: 400 };
    },
    list() {
      // The ones no agent reaches are listed too, so an agent learns the edge from the
      // app and not from a failed call: a secret says only that it exists.
      const defs = deps.defs();
      const fenced = Object.entries(SETTING_CLASSES)
        .filter(([id, row]) => !id.includes("*") && !defs.some((d) => d.id === id) && (row.class === "secret" || row.class === "personOnly"))
        .map(([id, row]) => ({ id, label: id, page: id.split(".")[0]!, scoped: false, type: "string", class: row.class, why: row.why }));
      return [...defs.map((d) => {
        const row = classOf(d.id);
        const secret = !row || row.class === "secret";
        return {
          id: d.id, label: d.label, page: d.page, scoped: !!d.scoped, type: d.type,
          class: row?.class ?? "secret", why: row?.why ?? "",
          ...(secret || d.scoped ? {} : { value: d.read() }),
        };
      }), ...fenced];
    },
  };
}
