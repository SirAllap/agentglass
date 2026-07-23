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
  const agent = `${g.source_app}:${g.session_id.slice(0, 8)}`;
  recordNote({
    app: "gate",
    summary: `Approve ${g.tool_name}?`,
    body: g.summary ? `${agent} · ${g.summary}` : `${agent} is held until you decide`,
    urgency: 2,
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

if (typeof window !== "undefined") {
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
