/**
 * Lanes: private browser windows an agent drives without the person's window.
 *
 * A lane is a hidden host window (electron/main.js, createLaneHost) with one
 * webview in it. This module is the table of them and the rules about them; it
 * has no idea how a window is made or asked. browserdrive.ts hands it the two
 * things it needs (`configureLanes`), so the import only goes one way.
 *
 * Rules, each one measured or forced by something that went wrong elsewhere:
 *
 *   - A cap on how many, because every lane is a renderer plus a guest and the
 *     cost is memory the person did not agree to spend.
 *   - An idle TTL. Nobody closes a lane an agent forgot, and a hidden window
 *     cannot be seen to be forgotten.
 *   - An ask naming a lane that is not in the table is a named refusal and
 *     never falls through to the visible tab (browserdrive.ts, askOnce): an
 *     agent that lost its lane must not start clicking in the person's window.
 */

export interface Lane {
  id: string;
  /** Who asked for it — self-asserted, like every `as`. */
  as?: string;
  /** Which cookie jar the lane browses in. `private` is a fresh, empty one that
   *  is wiped when the lane closes and is the default: a lane an agent opens
   *  must not carry the person's logins unless somebody said so. `shared` is
   *  the person's own container, on purpose. `named` is one of the containers
   *  `profiles` lists, by `name`. */
  container: "private" | "shared" | "named";
  name?: string;
  created: number;
  lastAsk: number;
}

export const MAX_LANES = 4;
export const LANE_IDLE_MS = 15 * 60_000;
/** How long a new lane's host has to say it is ready. */
let hostWaitMs = 10_000;
/** Shortened by a test that would otherwise sit through it. */
export const setHostWaitForTest = (ms: number): void => { hostWaitMs = ms; };
/** A lane whose host went away is dropped after this, not at once: a reload
 *  between two heartbeats looks the same. */
const HOST_GONE_MS = 60_000;

interface Deps {
  /** Ask the window that manages lanes to make or destroy a host. */
  manage: (args: { make: string; container: Lane["container"]; name?: string } | { drop: string }) => Promise<{ ok: boolean; error?: string }>;
  /** Whether a live window registered as the host of this lane. */
  hosted: (id: string) => boolean;
  /** Forget the host's registration (and settle what it was asked). */
  forget: (id: string) => void;
}

let deps: Deps | null = null;
const table = new Map<string, Lane>();
const missingSince = new Map<string, number>();
let sweeper: ReturnType<typeof setInterval> | null = null;

export function configureLanes(d: Deps): void { deps = d; }

export const laneKnown = (id: unknown): boolean => typeof id === "string" && table.has(id);

/**
 * Why this caller may not use this lane, or null. The same rule as a tab's
 * cross-container check: only the `as` that opened a lane drives it, and a
 * caller that names nobody (the MCP with no identity, a hand-written client)
 * is "cannot tell" and allowed. Self-asserted, so forensics for accidents
 * between cooperating agents, not authentication.
 */
export function laneRefusal(id: string, as: unknown, force = false): string | null {
  const l = table.get(id);
  if (!l) return `no lane called ${id} (it was closed, or it never existed) — \`lane list\`, or \`lane new\``;
  if (!force && typeof as === "string" && as && l.as && as !== l.as) {
    return `lane ${id} was opened by ${l.as}, not ${as} — open your own with \`lane new\`, or pass --force if you mean it`;
  }
  return null;
}

/** An ask reached this lane: it is not idle. */
export function touchLane(id: unknown): void {
  const l = typeof id === "string" ? table.get(id) : undefined;
  if (l) l.lastAsk = Date.now();
}

/** Every lane, or only the ones `as` opened. A caller that names nobody sees all. */
export const listLanes = (as?: string): Lane[] =>
  [...table.values()].filter((l) => !as || !l.as || l.as === as).map((l) => ({ ...l }));

export const isLaneId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id);

export async function openLane(
  as: string | undefined, container: Lane["container"], name?: string,
): Promise<{ ok: true; lane: Lane } | { ok: false; error: string }> {
  if (!deps) return { ok: false, error: "lanes are not available" };
  if (table.size >= MAX_LANES) {
    return { ok: false, error: `${MAX_LANES} lanes are already open (the cap); close one with \`lane close <id>\`` };
  }
  const id = `l${crypto.randomUUID().slice(0, 8)}`;
  /* Reserved before the window exists, so two agents asking in the same breath
     cannot both squeeze under the cap. */
  const now = Date.now();
  const lane: Lane = { id, ...(as ? { as } : {}), container, ...(name ? { name } : {}), created: now, lastAsk: now };
  table.set(id, lane);
  const made = await deps.manage({ make: id, container, ...(name ? { name } : {}) });
  if (!made.ok) {
    table.delete(id);
    return { ok: false, error: made.error ?? "the window could not open a lane" };
  }
  const until = Date.now() + hostWaitMs;
  while (!deps.hosted(id) && Date.now() < until) await Bun.sleep(100);
  if (!deps.hosted(id)) {
    await closeLane(id);
    return { ok: false, error: "the lane's window did not come up in time" };
  }
  startSweeper();
  return { ok: true, lane: { ...lane } };
}

export async function closeLane(id: string, as?: string, force = false): Promise<{ ok: boolean; error?: string }> {
  const refused = laneRefusal(id, as, force);
  if (refused) return { ok: false, error: refused };
  table.delete(id);
  missingSince.delete(id);
  deps?.forget(id);
  /* Best effort: the table is already right, and a window that cannot be asked
     is one that is gone. */
  await deps?.manage({ drop: id }).catch(() => undefined);
  if (table.size === 0) stopSweeper();
  return { ok: true };
}

/** One pass: close what is idle, drop what lost its host. Exported for tests. */
export async function sweepLanes(now = Date.now()): Promise<void> {
  for (const l of [...table.values()]) {
    if (now - l.lastAsk > LANE_IDLE_MS) { await closeLane(l.id); continue; }
    if (deps?.hosted(l.id)) { missingSince.delete(l.id); continue; }
    const since = missingSince.get(l.id) ?? now;
    missingSince.set(l.id, since);
    if (now - since > HOST_GONE_MS) await closeLane(l.id);
  }
}

function startSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => { void sweepLanes(); }, 30_000);
  (sweeper as { unref?: () => void }).unref?.();
}
function stopSweeper(): void {
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
}

export function resetLanes(): void {
  table.clear();
  missingSince.clear();
  stopSweeper();
  hostWaitMs = 10_000;
  deps = null;
}
