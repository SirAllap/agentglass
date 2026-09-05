import { api } from "./api.ts";
import { recordNote } from "./sysNotify.ts";
import type { PendingGate } from "../../../shared/types.ts";

/**
 * Pending gate requests: the tool calls an agent is blocked on until a human
 * says yes or no.
 *
 * This is a module-level store rather than a hook because of what it is for. A
 * gate hold is the one event in agentglass with a running agent stopped at the
 * other end of it, and the panel that renders them is mounted only on the
 * dashboard. Polling from that panel meant agentglass stopped noticing new
 * holds the moment you opened the workspace, which is the same mistake
 * sysNotify.ts already documents about tying its socket to the notch.
 *
 * It also raises each new hold onto the notch. That is the part that matters:
 * the only other "come and look" signal was `notify-send`, spawned by the
 * server, which a desktop Do Not Disturb setting swallows without telling
 * anyone. An in-app note cannot be silenced by a setting agentglass does not
 * own, so the request survives whatever the desktop is doing.
 */

const POLL_MS = 2000;

const subs = new Set<() => void>();

// Compared by identity by useSyncExternalStore, so it is replaced only when
// the contents actually change. Polling every two seconds and handing back a
// fresh array each time would re-render every consumer on every tick.
let snapshot: PendingGate[] = [];

export const listGates = (): PendingGate[] => snapshot;

export function subscribeGates(fn: () => void): () => void {
  startPolling();
  subs.add(fn);
  return () => subs.delete(fn);
}

function changed() {
  for (const fn of subs) fn();
}

/**
 * Newly-arrived holds, for surfaces that show the *transition* rather than the
 * standing list. The notch's toast is the one consumer today.
 *
 * Kept here rather than re-derived by each surface so there is one answer to
 * "is this new", and so a surface that mounts late cannot mistake the backlog
 * it finds for a burst of arrivals.
 */
const arrivals = new Set<(g: PendingGate) => void>();

export function subscribeNewGates(fn: (g: PendingGate) => void): () => void {
  startPolling();
  arrivals.add(fn);
  return () => arrivals.delete(fn);
}

const sameIds = (a: PendingGate[], b: PendingGate[]) =>
  a.length === b.length && a.every((g, i) => g.id === b[i]!.id);

/**
 * Gates already announced.
 *
 * Keyed by gate id, which the server keeps stable for the life of a hold, so a
 * request that sits there for a minute is announced once rather than thirty
 * times. Ids of resolved gates are dropped as they leave the pending list, and
 * the set is therefore bounded by what is actually outstanding.
 */
const announced = new Set<string>();

/**
 * Seeded on the first successful poll without announcing anything.
 *
 * Opening agentglass onto three gates that have been waiting is a standing
 * state, and the panel shows it. A note means "this just arrived while you
 * were looking elsewhere", so the first read establishes the baseline and only
 * what appears after it is worth interrupting for.
 */
let seeded = false;

/**
 * Gates the user has just decided on, dropped from the snapshot optimistically,
 * whose removal the server has not yet confirmed.
 *
 * The poll is ~2s behind the click, so the reply already in flight when Approve
 * was pressed still lists the gate. Republishing that list verbatim would flick
 * the card the user just answered straight back onto the screen — a decision
 * that reads as not having registered. An id stays here until the server also
 * stops listing it; that absence is the confirmation, and it is what keeps a
 * genuinely re-issued hold from being suppressed forever.
 */
const forgotten = new Set<string>();

/**
 * Raise a new hold on the notch, and tell anyone watching for arrivals.
 *
 * The note is written here rather than by the notch so that it happens whether
 * or not the notch is mounted: the history behind it is the record that you
 * were asked, and leaving that to a component would mean the record existed
 * only when you were already looking at the surface that shows it.
 */
function announce(g: PendingGate) {
  // The server's name for it, not a third home-made one. This composed
  // `${source_app}:${session_id.slice(0, 8)}` — the same string the server
  // alert and the gate push both used until they stopped, and the same one that
  // was reported as identifying nothing. The fallback is only for a server old
  // enough not to send `where`.
  const agent = g.where || `${g.source_app}:${g.session_id.slice(0, 8)}`;
  recordNote({
    app: "gate",
    summary: `Approve ${g.tool_name}?`,
    body: g.summary ? `${agent} · ${g.summary}` : `${agent} is held until you decide`,
    urgency: 2,
    // Somewhere to go while you decide: the pane it is held in, so you can read
    // what it was doing before you answer. The approve buttons live in the notch
    // itself; this is the other half of the question.
    ...(g.pane ? { goto: { kind: "pane" as const, pane: g.pane } } : {}),
  });
  for (const fn of arrivals) {
    try { fn(g); } catch { /* one bad listener must not stop the rest */ }
  }
}

/**
 * Take a fresh pending list and reconcile it: announce what is new, forget what
 * has resolved, and publish a snapshot if the set actually moved.
 *
 * Exported because it is the seam. Everything stateful about this store is
 * decided here, which is what the tests drive, and if the server ever pushes
 * gates over a socket instead of being polled it is the one function that
 * needs to be called.
 */
export function ingestGates(gates: PendingGate[]) {
  if (seeded) {
    for (const g of gates) {
      if (announced.has(g.id)) continue;
      announced.add(g.id);
      announce(g);
    }
  } else {
    for (const g of gates) announced.add(g.id);
    seeded = true;
  }

  const live = new Set(gates.map((g) => g.id));
  for (const id of announced) if (!live.has(id)) announced.delete(id);

  // Reconcile the optimistic forgets: an id the server has finally stopped
  // listing is confirmed gone and stops being suppressed; one it still lists
  // (the reply overlapped the decision) is filtered out of the published list
  // so a resolved card cannot reappear. Announce logic above still runs off the
  // raw `gates` — a forgotten gate is already in `announced`, so it is never
  // re-announced either way.
  for (const id of forgotten) if (!live.has(id)) forgotten.delete(id);
  const next = forgotten.size ? gates.filter((g) => !forgotten.has(g.id)) : gates;

  if (sameIds(snapshot, next)) return;
  snapshot = next;
  changed();
}

/**
 * Drop a gate locally the moment its decision is sent.
 *
 * The poll is two seconds behind, and a card that stays on screen after you
 * click Approve reads as a click that did not register. Its id stays in
 * `announced` until the server also stops listing it, so a decision in flight
 * cannot be re-announced by a poll that overlaps it.
 */
export function forgetGate(id: string) {
  // Suppress it from the next ingest too, not just this snapshot: the poll that
  // overlaps the decision still lists it, and ingestGates would otherwise
  // republish it. Cleared once the server confirms it gone — see `forgotten`.
  forgotten.add(id);
  const next = snapshot.filter((g) => g.id !== id);
  if (next.length === snapshot.length) return;
  snapshot = next;
  changed();
}

/**
 * Answer a hold, and find out whether the answer landed.
 *
 * `/gate/decide` reports the interesting failure with **200** and `ok: false` —
 * the clock got there first, or somebody answered from another device, and the
 * agent has already been told the opposite. A `try/catch` never sees that, and
 * the cockpit's own alerts panel used to write the whole call as
 * `api.gateDecide(id, decision).catch(() => {})`: the card left the screen, the
 * agent stayed blocked, and nothing anywhere said so. That is the same fault
 * the phone's decide path was repaired for, on the surface that is a few feet
 * from the machine — and web/test/gate-answer-took.test.ts existed only to
 * pin the client type because the caller was still wrong.
 *
 * So the optimistic drop is undone on failure and the card comes back where it
 * was: the server's list is the truth again, which also settles the case where
 * it did resolve elsewhere — that one stops being listed and stays gone.
 *
 * The note is the same channel a new hold uses. `notify-send` is what the
 * server would have reached for, and a desktop Do Not Disturb swallows it
 * without a word; an in-app note cannot be silenced by a setting agentglass
 * does not own. Urgency 2: an agent is still stopped, which is exactly the
 * state the press was meant to end.
 */
export async function answerGate(gate: PendingGate, decision: "allow" | "deny"): Promise<boolean> {
  const at = snapshot.findIndex((g) => g.id === gate.id);
  forgetGate(gate.id);
  const r = await api
    .gateDecide(gate.id, decision)
    // A rejection is the transport, not the decision: no answer reached the
    // server at all, so the hold is certainly still held.
    .catch(() => ({ ok: false, error: "the server could not be reached — nothing was sent" }));
  if (r.ok) return true;

  // Un-suppress before anything else. `forgotten` is cleared by an ingest that
  // no longer lists the id, so leaving it in there for a gate the server still
  // holds would hide that card until the hold timed out — the failure would
  // have cost the very thing it needs to show.
  forgotten.delete(gate.id);
  if (!snapshot.some((g) => g.id === gate.id)) {
    const next = snapshot.slice();
    next.splice(at < 0 ? next.length : at, 0, gate);
    snapshot = next;
    changed();
  }
  const agent = `${gate.source_app}:${gate.session_id.slice(0, 8)}`;
  recordNote({
    app: "gate",
    summary: `${decision === "allow" ? "Approve" : "Deny"} ${gate.tool_name} did not take`,
    // The server's own sentence, not a paraphrase: it distinguishes "already
    // allowed by somebody else" from "already denied by the timeout", and those
    // need different things done about them.
    body: `${agent} · ${r.error || "the server refused the answer without saying why"}`,
    urgency: 2,
  });
  return false;
}

/**
 * Test seam: forget everything this module remembers.
 *
 * The store is a singleton whose behaviour is deliberately history-dependent --
 * it announces a hold once and seeds a baseline on its first read -- so a test
 * file that touches it changes what the next one sees. Without this the suite
 * passes or fails on file ordering, which is how CI caught it and a local run
 * did not.
 */
export function __resetGateStore(): void {
  snapshot = [];
  announced.clear();
  forgotten.clear();
  seeded = false;
  /*
   * And STOP THE POLL, which this did not and had to.
   *
   * Never stopping is right for the app and is explained where the poll lives:
   * tying it to a panel's lifetime meant agentglass stopped noticing new holds
   * the moment you opened the workspace. It is wrong for a test process, where
   * "never" outlives the file that started it — and a two-second /gate/pending
   * then lands in whatever suite happens to be running.
   *
   * It cost an evening: a `runStore` test failed only in the full suite with
   * "it kept listening after the last watcher let go", and the read it was
   * counting was this poll, from a module that test never mentions. Two wrong
   * hypotheses went by before a stack on every read named it.
   *
   * `started` is cleared too, so the next subscriber begins a fresh poll
   * rather than finding the flag set and never polling again.
   */
  if (timer) { clearTimeout(timer); timer = null; }
  started = false;
}

// ---------------------------------------------------------------------------
// The poll.
//
// Always on while the page is, and paused while the tab is hidden: nobody is
// going to approve anything they cannot see, and the note raised on the way
// back in is the same note either way. A failed request is left alone rather
// than clearing the list, since "the server blinked" and "nothing is pending"
// must not look alike when one of them means an agent is still waiting.
// ---------------------------------------------------------------------------

let timer: ReturnType<typeof setTimeout> | null = null;

async function tick() {
  timer = null;
  if (typeof document === "undefined" || !document.hidden) {
    try {
      const { gates } = await api.gatePending();
      ingestGates(gates);
    } catch { /* offline or starting up: keep the last known list */ }
  }
  timer = setTimeout(tick, POLL_MS);
}

let started = false;

/**
 * Begin polling. Idempotent, and once begun it never stops.
 *
 * Called from the two subscribe functions rather than at import, which is the
 * whole point. `main.tsx` used to import the desktop tree unconditionally so it
 * could choose between it and a phone one, so on a phone this module was
 * loaded, this poll was started, and `/gate/pending` was fetched every two
 * seconds *for a store nothing on that device ever read* — the browser
 * companion kept its own gate list. A whole loop of waste on the one device
 * where it cost a battery.
 *
 * That fork is gone with the companion, so the specific waste cannot recur, and
 * the shape stays anyway: a module that polls on import bills every page that
 * merely touches it, and the next surface to import this one for a type will
 * not be reviewed with that in mind.
 *
 * Never stopping is deliberate and is the property the module comment is about:
 * tying the poll to a panel's lifetime meant agentglass stopped noticing new
 * holds the moment you opened the workspace. Starting on the first subscriber
 * and never stopping keeps that guarantee exactly — on the desktop the alerts
 * panel mounts on the first paint, so the poll begins when it always did.
 */
function startPolling() {
  if (started || typeof window === "undefined") return;
  started = true;
  void tick();
  // Coming back to a hidden tab should not wait out the remaining interval:
  // a gate raised while you were away is exactly what you returned to answer.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden || !timer) return;
    clearTimeout(timer);
    timer = null;
    void tick();
  });
}
