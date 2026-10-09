import type { ControlCmd } from "../../shared/types.ts";
import { UI_ACTIONS, legacyToUi, parseUi, uiToLegacy, idOfLegacy, entryOfBody, levelAllows, levelRefusal, type UiActionId, type UiLevel } from "../../shared/uiActions.ts";

// The closed sets a /control body is checked against now live in
// shared/uiActions.ts, one entry per door, and this file only applies them. They
// used to be held here by hand (VIEW_IDS, OPEN_WHAT, CHAT_DO) and pinned by
// control.test.ts so a view added to the rail without being added here was
// noticed; the registry is imported by the window as well, so the two cannot
// disagree, and web/test/ui-registry-guard.test.ts pins the lists against the
// places the app itself enumerates (the rail, the Settings pages, the chords).
//
// The reason the set is closed at all is unchanged: a /control body is
// untrusted input broadcast to every window, and every field it can set must
// map to a closed set first. `understudy` and `browser` being on the view list
// is deliberate (a scorecard that acts on nothing; a view an agent driving the
// built-in browser needs mounted) and is explained where the list is kept.

/** The highest level of door this server has built. Level 3 is built as STAGE
 *  only: an entry at that level opens a dialog the person finishes with their own
 *  click, and the server runs nothing on its behalf. There are no automatic
 *  grants, so raising the switch to 3 lets an agent prepare things and nothing
 *  more. */
export const UI_MAX_LEVEL: UiLevel = 3;
/** What the switch says when it says nothing, or says something unreadable. */
export const DEFAULT_CONTROL_LEVEL: UiLevel = 2;

export interface ControlSwitch {
  /** The level this process accepts. */
  level: UiLevel;
  /** AGENTGLASS_CONTROL_READONLY is what holds it at level 1. */
  readonly: boolean;
  /** One line per variable that was set to something unreadable, for the boot log. */
  warnings: readonly string[];
}

/** A value as it is quoted in a warning: bounded and free of control characters. */
const quoted = (v: string): string => JSON.stringify(v.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 40));

/**
 * The two switches, read from the environment and nothing else: no file, no
 * route and no registry entry writes them, which is what keeps an agent from
 * raising its own level. AGENTGLASS_CONTROL_LEVEL is 1, 2 or 3 and unset is the
 * default, 2. A variable that is SET to anything else, an empty string
 * included, fails CLOSED to level 1 and says so in `warnings`: the owner who
 * wrote `0`, `off` or `none` asked for less, and a refusal that is too strict is
 * a visible 403 they correct, where one that is too loose is silent.
 * AGENTGLASS_CONTROL_READONLY takes 1/true/yes/on as read-only and
 * 0/false/no/off as not; anything else set is read-only with a warning, for the
 * same reason. Read-only is level 1 and wins over any LEVEL: the lower applies.
 */
export function controlSwitch(env: Record<string, string | undefined> = process.env): ControlSwitch {
  const warnings: string[] = [];
  const rawLevel = env.AGENTGLASS_CONTROL_LEVEL;
  let asked: UiLevel = DEFAULT_CONTROL_LEVEL;
  if (rawLevel !== undefined) {
    const t = rawLevel.trim();
    if (t === "1") asked = 1; else if (t === "2") asked = 2; else if (t === "3") asked = 3;
    else {
      asked = 1;
      warnings.push(`AGENTGLASS_CONTROL_LEVEL=${quoted(rawLevel)} is not 1, 2 or 3; holding /control at level 1 (opens and reads only) until it is fixed.`);
    }
  }
  let readonly = false;
  const rawRo = env.AGENTGLASS_CONTROL_READONLY;
  if (rawRo !== undefined) {
    const t = rawRo.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(t)) readonly = true;
    else if (!["0", "false", "no", "off"].includes(t)) {
      readonly = true;
      warnings.push(`AGENTGLASS_CONTROL_READONLY=${quoted(rawRo)} is not 1 or 0; holding /control read-only (level 1) until it is fixed.`);
    }
  }
  return Object.freeze({ level: readonly ? 1 : asked, readonly, warnings: Object.freeze(warnings) });
}
export const controlLevel = (env: Record<string, string | undefined> = process.env): UiLevel => controlSwitch(env).level;

/**
 * The sentence for a body that names a real door this server will not run, or
 * null when the body names none (an unknown id, which stays "unknown control
 * command": it must not say which doors exist above the level). The door and
 * the switch that would allow it, and nothing about the arguments.
 */
export function controlRefusal(body: unknown, sw: ControlSwitch = controlSwitch()): { id: string; error: string } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const e = entryOfBody(body as Record<string, unknown>);
  if (!e || levelAllows(e.def, sw.level)) return null;
  return { id: e.id, error: levelRefusal(e.id, e.def, sw.level, sw.readonly) };
}

/**
 * One log line per caller per window for refusals (a level 403, a rate limit),
 * with a count of the ones the line stands for. The refusal itself is never
 * throttled, only the append-only /actions row: a loop of refused writes would
 * otherwise be a loop of log rows. `note` says whether to write a row now and
 * how many refusals since the last row went unwritten.
 */
export function makeRefusalThrottle(windowMs = 60_000) {
  const seen = new Map<string, { at: number; held: number }>();
  return {
    note(key: string, now = Date.now()): { log: boolean; suppressed: number } {
      const e = seen.get(key);
      if (e && now - e.at < windowMs) { e.held++; return { log: false, suppressed: 0 }; }
      const suppressed = e?.held ?? 0;
      seen.set(key, { at: now, held: 0 });
      for (const [k, v] of seen) if (k !== key && now - v.at >= windowMs) seen.delete(k);
      return { log: true, suppressed };
    },
  };
}

/** Writes one caller may send in a minute. A person's sweep through Settings is
 *  a dozen; a loop that flips a theme for fun is what this is for. */
export const SETTINGS_WRITES_PER_MINUTE = 30;

/**
 * A sliding window per key, in memory. `hit` says whether this one is allowed
 * and counts it only if it is, so a refused burst does not extend its own
 * sentence. Entries older than the window are dropped on the way past, so the
 * map holds one key per caller of the last minute, not one per caller ever.
 */
export function makeWriteLimiter(max = SETTINGS_WRITES_PER_MINUTE, windowMs = 60_000) {
  const seen = new Map<string, number[]>();
  return {
    hit(key: string, now = Date.now()): boolean {
      const recent = (seen.get(key) ?? []).filter((t) => now - t < windowMs);
      if (recent.length >= max) { seen.set(key, recent); return false; }
      recent.push(now);
      seen.set(key, recent);
      for (const [k, ts] of seen) if (k !== key && ts.every((t) => now - t >= windowMs)) seen.delete(k);
      return true;
    },
  };
}

/**
 * Validate an untrusted POST /control body into a ControlCmd, or null.
 *
 * The command rides the same socket every dashboard tab holds, so a malformed
 * or unknown cmd is turned away here rather than broadcast for each client to
 * second-guess. Nothing here executes — the worst a valid command does is open
 * a panel or repaint a theme — but a string that reached a setter unchecked
 * would still be a bug, so each field is matched against a closed set.
 */
export function parseControlCmd(body: unknown, level: UiLevel = controlLevel()): ControlCmd | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  // The general door: an id and its args. Unknown ids are refused (deny by default).
  if (b.cmd === "ui") return parseUi(UI_ACTIONS, b.do, b.args, level) as ControlCmd | null;
  // The older spellings are the same entries written the old way, and are
  // answered in the old shape so a client that predates `ui` still understands.
  const m = legacyToUi(b, level);
  return m ? (uiToLegacy(m.id, m.args) as ControlCmd | null) : null;
}

/**
 * The registry id a validated command is an instance of, for the audit line.
 * Never the arguments: a path or a row is a value, and the log records that a
 * door was opened, not what was looked at.
 */
export function controlId(cmd: ControlCmd): UiActionId | null {
  return cmd.cmd === "ui" ? cmd.do : idOfLegacy(cmd as { cmd: string } & Record<string, unknown>);
}

/** The setting a validated settings.set names, for the audit line. The setting
 *  and the fact of change, never the value: a value may be a path or a name. */
export function changedSetting(cmd: ControlCmd): string | null {
  return cmd.cmd === "ui" && cmd.do === "settings.set" ? String((cmd.args as { id: string }).id) : null;
}

// ── replies ─────────────────────────────────────────────────────────────────
//
// A command that carries an `id` (and every read, which is pointless without
// one) is parked here until a window answers it. The pattern is settleBrowser's
// in browserdrive.ts: a pending map keyed by an unguessable id, a timeout, the
// first answer wins and a later one is dropped, and a window that goes away
// settles what it was holding. What differs is the audience. A browser ask is
// addressed to ONE window; a control frame goes to every window, because /control
// has always been a broadcast, so any window may answer and the first to do so
// settles it. A second window's answer finds nothing parked and is ignored.
//
// POST /control/result is how a window answers. It is NOT an agent-facing route:
// it sits behind the same trustedCaller gate as the window's other calls
// (/browser/result), and what stops one caller answering another's ask is the
// request id, which is minted here, travels only on the sockets the windows hold,
// and is never given to the caller of /control. A caller that has the machine
// token can already do anything this route can be made to do by ringing /control
// itself, so the route widens nothing; it is documented so nobody builds an agent
// feature on it.

import { stripSecrets } from "../../shared/scrub.ts";
import { UI_REPLY_MAX_BYTES, type UiReply } from "../../shared/uiActions.ts";

/** How long a command waits for a window. A read is a few store lookups, an open
 *  is one setState; five seconds is a window that is gone or frozen. */
export const CONTROL_REPLY_MS = 5_000;
export const CONTROL_TIMEOUT_ERROR = "no window answered in time";

interface Parked { resolve: (r: UiReply) => void; timer: ReturnType<typeof setTimeout> }
const parked = new Map<string, Parked>();
let seq = 0;

/** Unguessable, like the browser relay's: a caller that can POST /control/result
 *  must not be able to answer an ask it was never sent by counting. */
export const nextControlRid = (): string => `c${++seq}-${crypto.randomUUID()}`;

/**
 * Park a request and hand the caller its eventual reply. `send` puts the frame on
 * the sockets; it runs after the request is parked, so an answer that races it
 * still finds its entry. A timeout settles `{ok:false, applied:false}`.
 */
export function awaitControl(rid: string, send: () => void, timeoutMs = CONTROL_REPLY_MS): Promise<UiReply> {
  return new Promise<UiReply>((resolve) => {
    const timer = setTimeout(() => {
      parked.delete(rid);
      resolve({ ok: false, applied: false, error: CONTROL_TIMEOUT_ERROR });
    }, timeoutMs);
    parked.set(rid, { resolve, timer });
    try { send(); } catch {
      parked.delete(rid);
      clearTimeout(timer);
      resolve({ ok: false, applied: false, error: "could not reach a window" });
    }
  });
}

/** Strings in a reply are scrubbed for token-shaped text before the agent sees
 *  them: the window redacts by construction, this is the second look. */
function scrub(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return stripSecrets(v);
  if (depth > 12 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => scrub(x, depth + 1));
  const o: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = scrub(x, depth + 1);
  return o;
}

/** What a window posted, as a reply: a closed shape, bounded, scrubbed. */
export function parseReply(b: unknown): UiReply | null {
  if (!b || typeof b !== "object" || Array.isArray(b)) return null;
  const r = b as Record<string, unknown>;
  const reply: UiReply = { ok: r.ok === true, applied: r.applied === true };
  if (r.queued === true && reply.ok && !reply.applied) reply.queued = true;
  if (typeof r.error === "string") reply.error = stripSecrets(r.error).slice(0, 300);
  if (r.value !== undefined) {
    let size = 0;
    try { size = JSON.stringify(r.value)?.length ?? 0; } catch { return { ok: false, applied: false, error: "reply was not plain data" }; }
    if (size > UI_REPLY_MAX_BYTES) return { ok: false, applied: false, error: `reply over ${UI_REPLY_MAX_BYTES / 1024} KB was refused` };
    reply.value = scrub(r.value);
  }
  return reply;
}

/** A window answering. True when it settled something; false for an unknown id,
 *  one already settled, or one that timed out (all ordinary, none an error). */
export function settleControl(rid: unknown, reply: UiReply): boolean {
  if (typeof rid !== "string") return false;
  const p = parked.get(rid);
  if (!p) return false;
  parked.delete(rid);
  clearTimeout(p.timer);
  p.resolve(reply);
  return true;
}

/** For tests, and for a shutdown that should not leave timers behind. */
export function resetControl(): void {
  for (const [, p] of parked) { clearTimeout(p.timer); p.resolve({ ok: false, applied: false, error: "cancelled" }); }
  parked.clear();
  seq = 0;
}
export const pendingControlCount = (): number => parked.size;

/** A caller's own label for a request, echoed back: a slug, so it can be logged. */
export function callerRequestId(raw: unknown): string | null {
  return typeof raw === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(raw) ? raw : null;
}
