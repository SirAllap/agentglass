/*
 * A BUTTON THAT OPENS SOMETHING ON THE BENCH SAYS SO, AND ONLY OPENS IT ONCE.
 *
 * Measured: the Polaris card's "Assisted setup" opened a terminal session on the
 * bench and said nothing. Three presses opened three sessions, and they were
 * only found after leaving Settings. The same shape sat behind every other
 * button that starts a bench session — Docker's cleanup, the Lantern's chat, a
 * hand-off, a flight plan's author, a chat about a selection.
 *
 * Two rules, decided here once so no caller has to remember them:
 *
 *   one per job     a job is a string naming what was asked for, and its
 *                   session lives per CHECKOUT. Pressing the same button again
 *                   focuses the tab this checkout already has; a press in
 *                   another project is another session. Nothing is minted
 *                   twice, and two presses in the same breath share one answer.
 *   it can end      a tab outlives its session (the command exited, the engine
 *                   restarted). A job whose session is gone is a job the
 *                   button may start again, so the button comes back.
 *
 * The page-facing half — the line that says where the session went and the
 * "Show it" beside it — is BenchJobLine, which reads the same job.
 */
import { api } from "./api.ts";
import {
  activateTab, addTab, benchState, claimJob, closeTab, freeSlot, openBench, setBenchRoot, tabsFor,
  NOTE_SLOT, READER_SLOT, type BenchTab,
} from "./benchStore.ts";

/* ------------------------------------------------------------- the job keys */

/**
 * The jobs a button can start, in one place.
 *
 * A key is what the person asked for, never the tab's title: two different
 * jobs may want a similar word in the tab, and a renamed tab must not make the
 * button forget which session is its own. Keys that belong to one thing carry
 * its id (a plan, a session, a selection) so two of them are two sessions.
 */
export const JOB = {
  polarisSetup: "polaris.assisted-setup",
  dockerAnalyze: "docker.analyze-with-agent",
  lantern: "lantern.chat",
  flightAuthor: (plan: string) => `flight-plan.${plan}.author`,
  handOff: (session: string, kind: string) => `handoff.${session}.${kind}`,
  /* The whole selection, not a hash of it: two different selections once
     hashed to one key, and asking about the second reused the first chat
     without sending its text. A key is storage, and the person's selection is
     the only thing that tells two questions apart. */
  askAboutSelection: (text: string) => `ask.selection.${text}`,
} as const;

/** A press that is meant to be a NEW session — the bench's own "new shell", a
 *  recipe from the finder. Unique per press, so it never focuses an older one. */
let seq = 0;
export const newJob = (what: string): string => `${what}.${Date.now().toString(36)}${(seq++).toString(36)}`;

/* ---------------------------------------------------------------- the tab */

/** What a press answers with: the tab it put there (or focused), or why not. */
export interface BenchOpen { ok: boolean; error?: string; id?: string; reused?: boolean }

/** The tab a job already has. `root` empty means "wherever it is": a hand-off
 *  learns its checkout from the server, and the Lantern's chat is one for the
 *  whole app, so their job key is what identifies them.
 *
 *  `claim` is the title the job gives its tab, and it is only for a session
 *  opened before jobs existed: the card that opened the person's three
 *  "polaris setup" tabs must find one of them rather than seat a fourth. Only
 *  jobs that are ONE for the whole app (Assisted setup, Docker cleanup, the
 *  Lantern) may claim: a title cannot say which selection or plan a tab was
 *  for, so a job keyed by one would adopt somebody else's session. The tab
 *  keeps the job after the first press (see openBenchJob). */
export function tabForJob(root: string, job: string, claim?: string): BenchTab | null {
  const held = root ? [benchState().byRoot[root]] : Object.values(benchState().byRoot);
  for (const h of held) {
    const t = h?.tabs.find((x) => x.job === job);
    if (t) return t;
  }
  if (!claim) return null;
  for (const h of held) {
    const t = h?.tabs.find((x) => !x.job && (x.kind === "agent" || x.kind === "term") && x.title === claim);
    if (t) return t;
  }
  return null;
}

/** Which checkout the bench holds that tab on — the line says where it went. */
export function rootOfTab(id: string): string {
  for (const [root, held] of Object.entries(benchState().byRoot)) {
    if (held.tabs.some((t) => t.id === id)) return root;
  }
  return "";
}

/** Point the bench at the checkout, make the tab the one on screen, open the window. */
export function showBenchJob(root: string, tab: BenchTab): void {
  setBenchRoot(root);
  activateTab(root, tab.id);
  openBench();
}

/** Show it by id: the caller has the tab, not necessarily the checkout it is on. */
export function showBenchTab(id: string): boolean {
  const root = rootOfTab(id);
  if (!root) return false;
  const tab = tabsFor(root).find((t) => t.id === id);
  if (!tab) return false;
  showBenchJob(root, tab);
  return true;
}

/* ------------------------------------------------------------ the session */

/** A slot with no session on it, on the engine as well as in the tab list: the
 *  bench attaches with `-A`, and a leftover shell on a reused slot would be
 *  reattached instead of the agent starting. */
export async function coldSlot(root: string): Promise<number> {
  const used = new Set(tabsFor(root).filter((t) => t.slot > 0).map((t) => t.slot));
  try {
    const r = await api.benchLive(root);
    if (r.ok) for (const n of r.slots) used.add(n);
  } catch { /* tmux could not be asked; the tab list is still a floor */ }
  used.add(READER_SLOT);
  used.add(NOTE_SLOT);
  for (let n = 1; n <= 99; n++) if (!used.has(n)) return n;
  return freeSlot(root);
}

/** Seated, but the tab's terminal has not said `ready` yet.
 *
 *  The socket that starts the tmux session is opened by the tab (BenchTerm),
 *  so between addTab and that `ready` the slot exists only in the tab list.
 *  That tab is starting, not dead: asking tmux during the gap and replacing it
 *  mints a second ticket and seats a second session. Cleared by the events the
 *  terminal already has — `ready`, end and error — never by a clock. */
const starting = new Set<string>();

/** The terminal answered: its session is up, or it ended. Either way the tab is
 *  no longer waiting, and the next press may ask tmux about it. */
export function sessionSettled(id: string): void {
  starting.delete(id);
}

/** Whether the tab's session is still on the engine. A tab can outlive it, and
 *  a job whose session is gone is a job that may be started again. */
async function stillRunning(root: string, tab: BenchTab): Promise<boolean> {
  if (tab.kind !== "agent" && tab.kind !== "term") return true;
  if (starting.has(tab.id)) return true;
  if (!tab.slot) return false;
  try {
    const r = await api.benchLive(root);
    return !r.ok || r.slots.includes(tab.slot);
  } catch { return true; /* tmux could not be asked: do not seat a duplicate on a guess */ }
}

/** The tab a `create` puts on the bench, before the helper seats it. */
export type BenchJobTab = Omit<BenchTab, "id" | "slot" | "job"> & { slot?: number };

export type BenchJobAttempt = { ok: true; root: string; tab: BenchJobTab } | { ok: false; error?: string };

export interface BenchJobSpec {
  job: string;
  /** Where it opens. Empty when only the server knows. */
  root: string;
  /** The title this job gives its tab, to adopt a session opened before jobs existed. */
  claim?: string;
  create: () => Promise<BenchJobAttempt>;
}

const inFlight = new Map<string, Promise<BenchOpen>>();

/** One session is seated at a time, across every job.
 *
 *  A free slot is read from the tab list and from the engine, then the tab is
 *  seated — and both reads happen before the tab exists. Two creations in the
 *  same breath therefore saw the same free number and seated two tabs on one
 *  tmux session, so the second attached to the first's agent. Chained rather
 *  than keyed by checkout: a hand-off only learns its checkout from the server,
 *  and it shares a bench with one pressed there meanwhile. */
let seating: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const run = seating.then(fn, fn);
  seating = run.catch(() => {});
  return run;
}

/**
 * Open (or focus) the one session this job has on this checkout.
 *
 * The tab is found BEFORE anything is minted: a ticket is single-use and
 * short-lived, and one minted for a tab that is then merely brought to the
 * front is a session nobody asked for.
 */
export async function openBenchJob(o: BenchJobSpec): Promise<BenchOpen> {
  const key = `${o.root}\u0000${o.job}`;
  const running = inFlight.get(key);
  if (running) return running;
  const p = runJob(o).finally(() => { inFlight.delete(key); });
  inFlight.set(key, p);
  return p;
}

async function runJob(o: BenchJobSpec): Promise<BenchOpen> {
  const there = tabForJob(o.root, o.job, o.claim);
  if (there) {
    const root = o.root || rootOfTab(there.id);
    if (await stillRunning(root, there)) {
      if (!there.job) claimJob(root, there.id, o.job);
      showBenchJob(root, there);
      return { ok: true, id: there.id, reused: true };
    }
    closeTab(root, there.id);
    starting.delete(there.id);
  }
  const made = await oneAtATime(async () => {
    const created = await o.create().catch((e) => ({ ok: false as const, error: String(e) }));
    if (!created.ok) return created;
    const root = created.root || o.root;
    if (!root) return { ok: false as const, error: "no checkout to open a session in" };
    const tab = addTab(root, { ...created.tab, job: o.job });
    starting.add(tab.id);
    return { ok: true as const, root, tab };
  });
  if (!made.ok) return { ok: false, error: made.error };
  showBenchJob(made.root, made.tab);
  return { ok: true, id: made.tab.id };
}

/** Test seam: forget promises still running and which tabs are still starting. */
export function __resetJobs(): void {
  inFlight.clear();
  starting.clear();
}
