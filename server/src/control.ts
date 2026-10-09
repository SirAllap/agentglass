import type { ControlCmd } from "../../shared/types.ts";
import { UI_ACTIONS, legacyToUi, parseUi, uiToLegacy, idOfLegacy, type UiActionId, type UiLevel } from "../../shared/uiActions.ts";

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

/** The highest level of door this server has built. Level 2 changes a local
 *  setting, and only the ones the window lists; 3 (an effect outside the app)
 *  is not built, so an entry that claims it is refused rather than trusted. */
export const UI_MAX_LEVEL: UiLevel = 2;

/**
 * The level this process accepts: the built ceiling, or lower when
 * AGENTGLASS_CONTROL_LEVEL says so (1 = open and read, no write). A value that
 * is not 1 or 2 is the ceiling, not an error: the switch exists to take
 * something away, and a typo must not read as "off" in one direction and "on"
 * in the other.
 */
export function controlLevel(env: Record<string, string | undefined> = process.env): UiLevel {
  return env.AGENTGLASS_CONTROL_LEVEL?.trim() === "1" ? 1 : UI_MAX_LEVEL;
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
