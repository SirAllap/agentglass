import { SERVER, authHeaders } from "./api.ts";
import { subscribeUnderstudyFrame } from "./understudyBus.ts";
import type { UnderstudyFrame } from "../../../shared/types.ts";

/*
 * The last scorecard the server sent, held where anything can read it.
 *
 * Hand-rolled, like every other store here: a module-level value, a Set of
 * listeners, a subscribe that returns its own unsubscribe, and a getter that
 * useSyncExternalStore can call. There is no context and no reducer library in
 * this app and this is not the file to introduce one.
 *
 * Two surfaces want this and they are not on screen at the same time — the
 * panel, and (later) the rail pip that says a class has met its thresholds — so
 * there is one copy of the frame rather than one per component. The frame is
 * small, infrequent and whole, so there is nothing to merge: the newest one
 * replaces the last.
 */

/**
 * The snapshot, and the ONLY object getSnapshot ever hands back.
 *
 * useSyncExternalStore compares snapshots by identity to decide whether to
 * re-render. Return a freshly built object per call — even one deep-equal to
 * the last — and every render reports a change, which schedules a render, which
 * reports a change: React gives up and paints NOTHING. That is not theoretical
 * here. This app has shipped a black window for exactly this class of mistake,
 * and the same note sits on `loadRail` in workspace/views.ts and on chatStore's
 * `snapshot` for the same reason. It is the standard way to get this wrong.
 *
 * So the frame off the wire IS the snapshot — no copying, no mapping, no
 * sorting — and `apply` refuses to install one that says nothing new. Identity
 * therefore changes exactly when the scorecard does.
 */
let snapshot: UnderstudyFrame | null = null;

const subs = new Set<() => void>();

/**
 * Whether two frames say the same thing.
 *
 * Field by field rather than JSON.stringify, which would be shorter and wrong
 * in two directions: it depends on key order (so a server that reorders a JSON
 * object would report a change nobody made) and it compares fields that mean
 * nothing to the view, so a counter the panel does not draw would repaint it.
 *
 * `asOf` IS compared, deliberately, even though it moves on every recompute:
 * the panel prints when the scorecard was computed, so a frame whose only
 * change is the clock is a change ON SCREEN. The recompute is minutes apart,
 * not milliseconds, so this costs a render nobody will notice.
 *
 * Per class it compares the five fields that decide what the row draws — its
 * identity, where it is, whether it may be offered, and the two numbers the
 * bound is computed from. `raw` and `lb` are functions of `hits` and `n`, so
 * comparing them as well would only catch a server that had made them
 * disagree, and `bank` and `blocked` move with `hits`. Comparing by INDEX and
 * checking the id at each one is what pins the order too: the panel draws the
 * classes in the order they arrive, and a reordered list is a different screen.
 */
function same(a: UnderstudyFrame | null, b: UnderstudyFrame | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.asOf !== b.asOf || a.halted !== b.halted || a.enabled !== b.enabled || a.level !== b.level) return false;
  if (a.classes.length !== b.classes.length) return false;
  for (let i = 0; i < a.classes.length; i++) {
    const x = a.classes[i]!;
    const y = b.classes[i]!;
    if (x.id !== y.id || x.mode !== y.mode || x.offered !== y.offered || x.n !== y.n || x.hits !== y.hits) return false;
  }
  return true;
}

/**
 * Install a frame, and tell everybody only if it is news.
 *
 * Exported because the socket is not the only way one arrives — `refresh`
 * below fetches the same body when a panel mounts, and a test can hand one
 * straight in without a server. The early return is the whole point of the
 * function: applying an identical frame must not fire a single listener, or the
 * server's own heartbeat becomes a repaint of thirteen rows every push.
 */
export function applyUnderstudy(next: UnderstudyFrame): void {
  if (same(snapshot, next)) return;
  snapshot = next;
  for (const fn of subs) {
    try { fn(); } catch { /* one bad listener must not stop the rest */ }
  }
}

/**
 * Wired once, at module load, rather than inside `subscribeUnderstudy`.
 *
 * A frame that arrives while nobody is looking is still worth keeping: the
 * scorecard is recomputed on the server's clock, not on the panel's, and a view
 * opened after one landed would otherwise show the state from before it and
 * wait out the next recompute to catch up. Keeping it costs one object.
 */
subscribeUnderstudyFrame(applyUnderstudy);

/** The snapshot for useSyncExternalStore. Null until the first frame — which
 *  the panel must distinguish from an empty scorecard, because "nothing has
 *  arrived yet" and "it is recording and has nothing to show" are different
 *  screens. */
export const getUnderstudy = (): UnderstudyFrame | null => snapshot;

export function subscribeUnderstudy(fn: () => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}

/**
 * Ask for the scorecard now, instead of waiting for the next push.
 *
 * THE PANEL MUST CALL THIS ON MOUNT. The socket is the normal path and this is
 * the cold start: a window opened between two recomputes has never seen a
 * frame, and a panel that renders "nothing yet" over a scorecard the server has
 * been holding for ten minutes is the panel being wrong about the only thing it
 * says.
 *
 * Not fired from `subscribeUnderstudy` the way reminderStore starts its poll,
 * and the difference is the test rather than the design: this store's whole
 * contract is that identity changes exactly when the scorecard does, and a
 * subscribe that quietly starts a fetch can land a frame in the middle of an
 * assertion about identity. A store that is deterministic under test is worth
 * one call at the top of the panel.
 *
 * `SERVER` and `authHeaders` rather than a method on `api`: the api module's
 * table is a shared surface and this route is the understudy's alone, which is
 * the same trade sysNotify.ts made for /notifications/capability. It still goes
 * through the module that owns the origin and the token, so a rotated token or
 * a moved server is picked up here exactly as it is everywhere else — the one
 * thing a hand-written fetch must not do is hardcode either.
 *
 * A failure is swallowed. There is nowhere for it to go that is better than
 * the panel continuing to show the last frame: the socket will push the next
 * recompute regardless, and an error toast for a scorecard nobody asked to
 * refresh would be noise about a view that watches.
 */
/**
 * @param windowDays  7, 30, or null for everything — the panel's window
 *   control. It narrows what is DISPLAYED; the server's gate has no window and
 *   must not grow one, or a class would lose a promotion because somebody
 *   changed a filter.
 */
export async function refreshUnderstudy(windowDays: number | null = null): Promise<void> {
  try {
    const q = windowDays ? `?window=${windowDays}` : "";
    const r = await fetch(SERVER + "/understudy/scorecard" + q, { headers: authHeaders() });
    if (!r.ok) return;
    const frame = await r.json() as UnderstudyFrame | null;
    // Shape-checked before it is installed, because this is the one path whose
    // body is not typed by the socket's own frame union. A 200 carrying
    // something else — a proxy's login page, an older server's answer — would
    // otherwise reach the panel as a frame with no `classes` to map over.
    if (!frame || typeof frame !== "object" || !Array.isArray(frame.classes)) return;
    applyUnderstudy(frame);
  } catch { /* the next push off the socket says it anyway */ }
}
