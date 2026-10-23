/*
 * What the app knows, and when it goes and finds out.
 *
 * One context, holding three things: which computer this phone is paired to,
 * whether the live socket is up, and the last answer from each of the handful
 * of endpoints the terminal and the tab bar read.
 *
 * ── why the socket does not carry the data ────────────────────────────────
 * `/stream` says *that* something moved, in enough detail to know what kind.
 * It does not carry the queue. So the socket is used as a doorbell — an event
 * marks its area dirty and a refresh follows — rather than as a replicated
 * store. That keeps one rule about where a value came from, which is the rule
 * the dashboard learned the hard way: two paths into the same state disagree
 * eventually, and the one you are looking at is always the stale one.
 *
 * ── why there is still a poll ─────────────────────────────────────────────
 * Because a phone's socket is a lie about half the time. Android freezes the
 * process, the peer goes away, and `readyState` still says 1. The poll is slow
 * on purpose (it is a backstop, not the mechanism) and it stops entirely when
 * the app is in the background, where a wakeup costs battery to redraw a
 * screen nobody is looking at.
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from "react";
import { AppState, type AppStateStatus } from "react-native";
import type {
  AlertNote, GitRepoRef, PendingGate, PrSummary, PrTalkNote,
} from "../../../shared/types.ts";
import { talkBody, talkSummary, talkUrgency } from "../../../shared/talkWords.ts";
import { dedupePrs, mainCheckouts } from "../model/prRows.ts";
import { ask, askCached, forgetCachedAsks, REVOKED } from "../lib/api.ts";
import type { Host } from "../lib/host.ts";
import {
  addHost, loadHosts, markRevoked, removeHost, renameHost, setActive, type HostEntry, type HostList,
} from "../lib/hosts.ts";
import { openLive, type LiveHandle, type LiveState } from "../lib/live.ts";
import { remember, shouldNotify, shouldNotifyTalk } from "../notifications/policy.ts";
import { alertsDeliverable, raise } from "../notifications/notify.ts";
import { alertTitle, nameOf } from "../model/computers.ts";
import { watchHost, type WatchEvents } from "./watch-host.ts";
import { keepAliveRunning, loadKeepAlivePref, syncKeepAlive, wantKeepAlive } from "../notifications/keepAlive.ts";
import { noteChecks, noteTalk } from "./pr-talk.ts";
import { talkPref } from "../notifications/talkPref.ts";
import { applyMarks, loadPrMarks, resetMarks } from "./read-marks.ts";
import { setDeskTheme } from "../theme.ts";

/** The backstop, not the mechanism. Long enough that a phone sitting in a
 *  pocket with the screen on is not talking to the network every few seconds. */
const POLL_MS = 20_000;

/** The pull-request pass. Minutes, not seconds: it costs a round trip per
 *  repository per filter, and a red build is not news that goes stale in
 *  twenty seconds. */
const SLOW_POLL_MS = 180_000;
/** How long the tab may reuse what the pass above read (see `askCached`). */
export const PR_READ_TTL_MS = 120_000;

/** A pull request, tagged with the checkout that asked and why. `scope` is the
 *  server's own answer to "waiting on your review", so the queue's claim rests
 *  on GitHub rather than on a guess about who was asked. */
export interface PrRow {
  root: string;
  repo: string;
  pr: PrSummary;
  scope: "mine" | "review";
}

export interface Fleet {
  gates: PendingGate[];
  /** Filled by a SECOND pass — see `loadPrs`. Empty means "not asked yet",
   *  which is why the badge draws nothing rather than claiming there are
   *  none. */
  prs: PrRow[];
  /** The logins this viewer answers to, for "is this mine". */
  me: string;
  /** When the last successful load finished. Zero means "never yet". */
  at: number;
  /** Set when the last attempt failed, so a screen can say what is wrong
   *  instead of showing an empty list that looks like good news. */
  error: string | null;
}

interface Ctx {
  /** The computer in use. Everything the 28 screens read hangs off this one;
   *  the rest of the list is for the switcher and the Computers screen. */
  host: HostEntry | null;
  /** Every paired computer, most recently used first. */
  hosts: HostEntry[];
  /** Null while the keystore is still being read: an app that renders "not
   *  paired" for one frame on every cold start sends people back through a
   *  handshake they already did. */
  ready: boolean;
  live: LiveState;
  fleet: Fleet;
  /** Agents waiting on a person, per computer: the one in front from its fleet,
   *  the others from the socket kept for each (watch-host.ts). */
  waiting: Record<string, number>;
  /** Whether each computer's socket is up, the one in front included. */
  states: Record<string, LiveState>;
  refresh: () => void;
  /** Pair a computer and make it the one in use. */
  pair: (host: Host) => Promise<void>;
  /** Forget the computer in use (the phone's half only). */
  forget: () => Promise<void>;
  switchTo: (id: string) => Promise<void>;
  rename: (id: string, name: string) => Promise<void>;
  /** Forget any computer on the list. When it is the one in use, the next most
   *  recent takes its place, or the phone lands on Connect if none is left. */
  forgetComputer: (id: string) => Promise<void>;
}

const NO_HOSTS: HostList = { active: null, hosts: [] };
const EMPTY: Fleet = { gates: [], prs: [], me: "", at: 0, error: null };

const HostContext = createContext<Ctx | null>(null);

export function useAgentglass(): Ctx {
  const ctx = useContext(HostContext);
  if (!ctx) throw new Error("useAgentglass outside its provider");
  return ctx;
}

/** The alert as the notification will say it: the computer named only when
 *  there are two or more on the phone. */
const titled = (from: HostEntry, alert: AlertNote, paired: number): AlertNote => ({
  ...alert,
  title: alertTitle(alert.title, nameOf(from), paired),
});

type Bridge = {
  onState: (id: string, state: LiveState) => void;
  onWaiting: (id: string, n: number) => void;
  onGone: (id: string) => void;
  onAlert: (id: string, alert: AlertNote) => void;
  onRevoked: (id: string) => void;
};

/**
 * The one socket for a computer that is not in front (watch-host.ts), as a
 * component so React does the diff: switching from A to B opens A's and closes
 * B's, and the other computers' sockets are not touched. Keyed by id, address
 * and key by the caller, so a rename never rebuilds it.
 */
function Watcher({ host, bridge }: { host: HostEntry; bridge: Bridge }): null {
  useEffect(() => {
    const events: WatchEvents = {
      onState: (state) => bridge.onState(host.id, state),
      onWaiting: (n) => bridge.onWaiting(host.id, n),
      onAlert: (alert) => bridge.onAlert(host.id, alert),
      onRevoked: () => bridge.onRevoked(host.id),
    };
    const stop = watchHost(host, events);
    return () => { stop(); bridge.onGone(host.id); };
    // The entry's name can change under a live socket; only its address and key
    // are what the socket was made for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host.id, host.origin, host.token, bridge]);
  return null;
}

export function HostProvider({ children }: { children: ReactNode }): ReactNode {
  const [list, setList] = useState<HostList>(NO_HOSTS);
  const [ready, setReady] = useState(false);
  const [live, setLive] = useState<LiveState>("offline");
  const [fleet, setFleet] = useState<Fleet>(EMPTY);
  const [others, setOthers] = useState<{ waiting: Record<string, number>; states: Record<string, LiveState> }>(
    { waiting: {}, states: {} },
  );
  /** Sockets for the computers not in front are kept while the app is on screen
   *  or the foreground service is running, and not otherwise: a socket nothing
   *  can act on is battery for nothing. */
  const [watching, setWatching] = useState(() => AppState.currentState === "active");

  // A load in flight when another is asked for, so the newer one wins and the
  // older one cannot land on top of it.
  const generation = useRef(0);
  /** When the pull-request pass last started, for the return-to-foreground check. */
  const prsAt = useRef(0);
  const liveRef = useRef<LiveHandle | null>(null);
  /** When each alert last buzzed. Held across reconnects because the socket is
   *  torn down and rebuilt for reasons that have nothing to do with the alerts
   *  — a screen waking, a network changing — and a dedupe window that reset
   *  with it would be no window at all. NOT because a reconnect replays
   *  anything: it does not, see SAME_ALERT_MS. */
  const seen = useRef(new Map<string, number>());

  /* The entry in use, with an identity that moves only when something the
     effects below depend on moves: its id, address, key, or removal. A rename
     or a switch of `lastUsed` hands out a new object in `list`, and an effect
     keyed on that would tear down and rebuild the socket for nothing. */
  const active = list.hosts.find((h) => h.id === list.active) ?? null;
  const host = useMemo(
    () => active,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [active?.id, active?.origin, active?.token, active?.revoked],
  );

  /** What callbacks that outlive a render read, so a rename, a new computer or
   *  a switch reaches the next alert and the next action without rebuilding the
   *  sockets or the value every screen reads. */
  const listRef = useRef(list);
  listRef.current = list;

  /** Raise one alert for a computer. Opened in the dedupe window first and
   *  rolled back if the OS never drew it — see the alert branch of the socket
   *  effect for why that order. Stable: it reads refs. */
  const buzz = useCallback((from: HostEntry, alert: AlertNote, now: number): void => {
    const undo = remember(alert, { lastSeen: seen.current, now, hostId: from.id });
    void raise(titled(from, alert, listRef.current.hosts.length), from.id).then((d) => { if (!d.ok) undo(); });
  }, []);

  /** What the sockets of the computers not in front report. Stable, and a
   *  report that changes nothing changes nothing: a reconnect flap or a repeated
   *  count would otherwise re-render the whole tree for no new fact. */
  const bridge = useMemo(() => ({
    onState: (id: string, state: LiveState): void =>
      setOthers((p) => (p.states[id] === state ? p : { ...p, states: { ...p.states, [id]: state } })),
    onWaiting: (id: string, n: number): void =>
      setOthers((p) => (p.waiting[id] === n ? p : { ...p, waiting: { ...p.waiting, [id]: n } })),
    // A count or a dot from a socket that is gone is a claim with nothing
    // behind it; the next socket says it again when it opens.
    onGone: (id: string): void =>
      setOthers((p) => {
        if (!(id in p.states) && !(id in p.waiting)) return p;
        const { [id]: _s, ...states } = p.states;
        const { [id]: _w, ...waiting } = p.waiting;
        return { states, waiting };
      }),
    onAlert: (id: string, alert: AlertNote): void => {
      const from = listRef.current.hosts.find((h) => h.id === id);
      if (!from) return;
      // Never "foreground": the person is looking at another computer, which
      // is the case this socket exists for.
      const now = Date.now();
      if (shouldNotify(alert, { foreground: false, lastSeen: seen.current, now, hostId: id }).notify) buzz(from, alert, now);
    },
    onRevoked: (id: string): void => {
      void markRevoked(id).then((next) => {
        setList(next);
        if (!next.hosts.some((x) => !x.revoked)) syncKeepAlive(false);
      });
    },
  }), [buzz]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      setWatching(state === "active" || keepAliveRunning());
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    void (async () => {
      setList(await loadHosts());
      setReady(true);
    })();

    /*
     * Re-arm notifications on every cold start.
     *
     * `alertsDeliverable` installs the foreground handler and the Android
     * channel and then asks the OS what can actually be drawn. It never
     * PROMPTS — the ask lives behind the switch in Settings — so this cannot
     * produce a dialog on launch. Without it, a phone that granted permission
     * last week raises nothing until somebody happens to open Settings, which
     * is the failure that looks exactly like the feature not working.
     *
     * Its answer is not stored here. It goes stale the moment somebody changes
     * a switch in Android's settings, and that is precisely the state the old
     * `ready` latch got wrong — so every raise asks again.
     */
    void alertsDeliverable();
  }, []);

  const load = useCallback(async (which: HostEntry): Promise<void> => {
    const mine = ++generation.current;
    /*
     * The gates, and only the gates.
     *
     * This used to read `/sessions` and `/docker/overview` as well, for the
     * Now screen's queue. Now is gone and nothing else draws either, so the
     * phone stopped asking: two requests every twenty seconds for lists no
     * screen shows is radio spent on nothing.
     *
     * The lesson of those three stays, because it is about the server and not
     * the screen: they are not the same shape. `/gate/pending` and
     * `/docker/overview` answer an OBJECT with the list inside it; `/sessions`
     * answers the ARRAY. Assuming the wrapper on all three is exactly what
     * shipped a red screen: the queue got `undefined` for its sessions and
     * threw "Cannot convert undefined value to object" out of a `for…of`,
     * which takes the whole app down rather than one card.
     * `mobile/test/fleet-shapes.test.ts` still holds all three against a real
     * server, for whichever screen reads them next.
     */
    const gates = await ask<{ gates: PendingGate[] }>(which, "/gate/pending");
    if (mine !== generation.current) return;

    // A revoked credential is the one failure that is not worth retrying: the
    // person at the computer took this phone off the list, and every request
    // from here on is a 401. Drop it and land on the pairing screen.
    if (!gates.ok && gates.error === REVOKED) {
      // MARKED, not forgotten: the entry stays so the list can say "Removed at
      // the computer" and offer to forget it, and the other computers on the
      // phone keep their keys and their alerts. Forgetting here lost the only
      // record of what happened, and with one computer paired sent the phone
      // back to the first-run screen without a word.
      const next = await markRevoked(which.id);
      if (mine !== generation.current) return;
      setList(next);
      setFleet(EMPTY);
      // Stopped explicitly, and only when nothing usable is left: a revoke is
      // usually noticed while the phone is in the background, where the
      // service is still running and its notification still up, and one
      // removed computer must not silence the others.
      if (!next.hosts.some((h) => !h.revoked)) syncKeepAlive(false);
      return;
    }

    /*
     * The list is checked for being a list, even though the type above says
     * it is. The type describes what the server promises; this runs against
     * whatever answered, which may be an older build, a proxy, or a route that
     * changed shape — and the terminal and the tab bar both iterate it. One
     * `undefined` there is a render error over the whole app, not a missing
     * card, so the cheap guard buys the difference between "no gates" and a
     * red screen.
     */
    const list = <T,>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
    setFleet((prev) => ({
      gates: gates.ok ? list<PendingGate>(gates.value.gates) : [],
      // Carried, not cleared. The pull-request pass runs on a slower clock, and
      // blanking its answer on every fast refresh would make the badge flash
      // on and off every twenty seconds.
      prs: prev.prs,
      me: prev.me,
      at: Date.now(),
      error: gates.ok ? null : gates.error,
    }));
  }, []);

  /**
   * The pull requests, on their own slower clock.
   *
   * Separate from the load above because it costs a round trip PER REPOSITORY
   * and per filter, and the queue's other three sources cost one each. Running
   * it at the same cadence would have the phone making a dozen GitHub-backed
   * requests every twenty seconds for cards that change on the scale of
   * minutes.
   *
   * Capped at the six most recently touched checkouts. That cap is a real
   * limit and is stated rather than hidden: a machine with thirty repositories
   * would otherwise spend a minute of radio to find one red build.
   */
  const loadPrs = useCallback(async (which: HostEntry): Promise<void> => {
    prsAt.current = Date.now();
    /* `force`: this IS the refresh. What it reads is kept for the Pull requests
       tab, which no longer asks the same lists again when it opens. */
    const repos = await askCached<{ repos: GitRepoRef[] }>(which, "/git/repos", PR_READ_TTL_MS, true);
    if (!repos.ok) return;

    // One entry per repository: linked worktrees of one repo answer with the
    // same pull requests, and asking six of them produces one card six times.
    const roots = mainCheckouts(Array.isArray(repos.value.repos) ? repos.value.repos : []).slice(0, 6);

    const answers = await Promise.all(roots.flatMap((repo) =>
      (["mine", "review"] as const).map(async (scope) => {
        const query = `root=${encodeURIComponent(repo.root)}&filter=${scope}&state=open`;
        const answer = await askCached<{ ok: boolean; prs: PrSummary[]; repo?: { nameWithOwner?: string } }>(
          which, `/prs/list?${query}`, PR_READ_TTL_MS, true,
        );
        if (!answer.ok || !answer.value.ok) return [];
        const name = answer.value.repo?.nameWithOwner ?? repo.name;
        return (Array.isArray(answer.value.prs) ? answer.value.prs : [])
          .map((pr) => ({ root: repo.root, repo: name, pr, scope }));
      }),
    ));

    // One row per pull request however many checkouts answered with it, and
    // `mine` kept over `review` when both did — a pull request you own and were
    // also asked to review is a thing to fix, and the queue should say so.
    setFleet((prev) => ({ ...prev, prs: dedupePrs(answers.flat()) }));
  }, []);

  /** Who the viewer is, for "is this mine". Asked once per host: it is the
   *  GitHub login the machine is signed in as and it does not change under us. */
  const loadMe = useCallback(async (which: Host): Promise<void> => {
    const answer = await ask<{ providers: { id: string; detail?: string }[] }>(which, "/providers");
    if (!answer.ok) return;
    const github = (answer.value.providers ?? []).find((p) => p.id === "github");
    // "Signed in as SirAllap" is what the pane reports; the login is the last
    // word of it. Parsed rather than plumbed because there is no other route to
    // it, and a wrong answer here only costs the "yours and broken" tagging.
    const login = /as\s+(\S+)/.exec(github?.detail ?? "")?.[1] ?? "";
    if (login) setFleet((prev) => ({ ...prev, me: login }));
  }, []);

  const refresh = useCallback((): void => {
    if (host) void load(host);
  }, [host, load]);

  // The socket. Torn down and rebuilt when the host changes, which is the only
  // time its URL or credential can differ.
  useEffect(() => {
    if (!host || host.revoked) { setLive("offline"); return; }
    resetMarks(); // another computer's marks are not this one's
    let dirty = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // Events arrive in bursts — a session writing a file produces several in a
    // second — and each one is not a reason to ask the server three questions.
    const settle = (): void => {
      if (timer) return;
      timer = setTimeout(() => { timer = null; if (dirty) { dirty = false; void load(host); } }, 400);
    };

    // The slow pass, once on connect and then rarely. Pull-request state moves
    // on the scale of minutes and every tick of it is several GitHub-backed
    // requests, so it does not ride the socket's doorbell.
    void loadMe(host);
    void loadPrs(host);
    /* Foreground only. `POLL_MS` stopped in the background and this did not:
       21 requests in 10 minutes at three repositories, 100% identical, for a
       screen nobody had open. Returning to the app asks at once when the last
       pass is older than the interval (the AppState effect below). */
    const slow = setInterval(() => { if (AppState.currentState === "active") void loadPrs(host); }, SLOW_POLL_MS);

    const handle = openLive(host, {
      onState: (state) => {
        setLive(state);
        // A socket that has just come up may have been down for a while, and
        // what it missed is exactly what the queue is made of.
        if (state === "open") { dirty = true; settle(); void loadPrMarks(host); }
      },
      onFrame: (frame) => {
        /*
         * An alert is the one frame with content worth acting on rather than
         * a doorbell. It is the same note the server hands to `notify-send`
         * on the desk — a gate holding, a tool that failed, a run that
         * stopped — so the phone raises it locally.
         *
         * The decision is in policy.ts and not here: whether to buzz is the
         * whole feature, and a companion that notifies too much is one people
         * silence.
         */
        // A read on another device: the desk, or another phone. See state/read-marks.ts.
        if (frame.type === "marks") applyMarks(frame.data);

        if (frame.type === "alert" && frame.data) {
          const alert = frame.data as AlertNote;
          const now = Date.now();
          const verdict = shouldNotify(alert, {
            foreground: AppState.currentState === "active",
            lastSeen: seen.current,
            now,
            hostId: host.id,
          });
          if (verdict.notify) {
            /*
             * Remembered NOW, and un-remembered if the raise failed.
             *
             * `remember` opens a 90-second window in which this exact alert
             * counts as already shown. This line was moved behind `await
             * raise(…)` so that a phone whose channel had been switched off in
             * Android's settings did not mark an alert delivered that it never
             * drew — a real failure, with a wrong reason attached: the commit
             * said "the server re-broadcasts on reconnect, which is the app's
             * one natural retry". Grepped: `{type:"alert"}` has one producer,
             * `index.ts:502`, reached only when an alert happens; a socket that
             * attaches is sent `{type:"initial"}`, which is events. There is no
             * re-broadcast and there was no retry to protect.
             *
             * Deferring it also cost something. `raise` is async, so between
             * the decision and the write the map still says nothing about this
             * alert — and two identical alerts arriving in that gap both pass
             * `shouldNotify` and both buzz. That is the duplicate the window
             * exists to prevent, reintroduced by the fix for the other one.
             *
             * Opening it first and rolling back on `!d.ok` has both properties
             * and neither cost. See `remember`, which hands back the undo.
             *
             * `now` is the moment of the DECISION, not of the delivery: the
             * window is about how recently the user was told about this text,
             * and an await in between would drift it.
             */
            buzz(host, alert, now);
          }
        }
        /*
         * Somebody spoke on a pull request of yours. Unlike an alert, the
         * live tick fires ALWAYS — it is what moves the "N new" badge on the
         * list and refetches a pane already open on it — and only the
         * system notification is behind a gate, because that gate is a
         * per-device preference (talkPref.ts) the server has no opinion on.
         * See shouldNotifyTalk.
         */
        if (frame.type === "talk" && frame.data) {
          const note = frame.data as PrTalkNote;
          noteTalk(note);
          const now = Date.now();
          const verdict = shouldNotifyTalk(note, {
            pref: talkPref(),
            foreground: AppState.currentState === "active",
            lastSeen: seen.current,
            now,
            hostId: host.id,
          });
          if (verdict.notify) {
            const alert: AlertNote = { title: talkSummary(note), body: talkBody(note), urgency: talkUrgency(note) };
            // Same remember/undo shape as the alert branch above: opened
            // before the await so two notes arriving inside it cannot both
            // pass, rolled back if the OS never actually drew it.
            buzz(host, alert, now);
          }
        }
        // The checks of a pull request moved: an open detail re-reads.
        if ((frame.type === "ci" || frame.type === "prchecks") && frame.data) {
          const d = frame.data as { repo?: string; number?: number };
          if (typeof d.repo === "string" && typeof d.number === "number") noteChecks(d.repo, d.number);
        }
        dirty = true;
        settle();
      },
    });
    liveRef.current = handle;
    void load(host);

    return () => {
      if (timer) clearTimeout(timer);
      clearInterval(slow);
      handle.close();
      liveRef.current = null;
    };
  }, [host, load, loadPrs, loadMe]);

  // Foreground/background. Both halves matter: stopping the poll is the
  // battery half, and waking the socket is the correctness half — after the OS
  // has frozen the process the connection is usually dead and says otherwise.
  useEffect(() => {
    // Stopped, not merely skipped: an unpaired phone (forget(), or a 401
    // REVOKED landing while this app sat in the background — see load()'s own
    // syncKeepAlive(false)) must not be left running the service from before.
    // `forget()` already calls it directly; this is the backstop for every
    // OTHER way `host` can go null, so there is one place a stray keep-alive
    // cannot survive rather than one per caller.
    if (!host || host.revoked) { syncKeepAlive(false); return; }
    let timer: ReturnType<typeof setInterval> | null = null;
    // Set false in cleanup and checked before every syncKeepAlive call this
    // effect makes. `syncNow` awaits two promises with nothing to cancel them:
    // without this flag, a sync started just before `host` changes or this
    // effect tears down can still resolve afterwards and call start() —
    // restarting the service right after forget()'s syncKeepAlive(false), or
    // after a newer host's own effect instance already decided otherwise.
    let alive = true;

    const start = (): void => {
      if (timer) return;
      timer = setInterval(() => { void load(host); }, POLL_MS);
    };
    const stop = (): void => {
      if (timer) { clearInterval(timer); timer = null; }
    };

    /*
     * The foreground keep-alive service, synced to the same ACTIVE edge as
     * the poll above and for a related reason: Android refuses to START a
     * foreground service from a process that is not itself in the
     * foreground, so this can only ever be attempted here, not from a
     * background wakeup. It is re-synced on every return to ACTIVE (not just
     * once) because the two things `wantKeepAlive` depends on besides pairing
     * — whether alerts can be delivered at all, and the owner's own switch in
     * Settings — are both things that change while this app is in someone's
     * pocket and are only ever noticed again when it comes back.
     */
    const syncNow = (): void => {
      void (async () => {
        const [alerts, pref] = await Promise.all([alertsDeliverable(), loadKeepAlivePref()]);
        if (!alive) return;
        syncKeepAlive(wantKeepAlive({ alertsOk: alerts.ok, pref }));
      })();
    };

    const onChange = (state: AppStateStatus): void => {
      if (state === "active") {
        liveRef.current?.wake(); void load(host); start(); syncNow();
        if (Date.now() - prsAt.current >= SLOW_POLL_MS) void loadPrs(host);
      }
      else stop();
    };

    if (AppState.currentState === "active") { start(); syncNow(); }
    const sub = AppState.addEventListener("change", onChange);
    return () => { alive = false; stop(); sub.remove(); };
  }, [host, load, loadPrs]);

  /* What a change of computer drops, in one place: the data and the colours of
     the one left must not show under the one arrived at. The socket, the polls
     and the marks are rebuilt by the effects keyed on `host`. */
  const leave = useCallback((): void => {
    generation.current++;
    forgetCachedAsks();
    setDeskTheme(null);
    setFleet(EMPTY);
  }, []);

  const forgetComputer = useCallback(async (id: string): Promise<void> => {
    const after = await removeHost(id);
    // Only the one in use takes data with it. Forgetting another computer
    // leaves what is on screen alone.
    if (id === listRef.current.active) leave();
    if (!after.hosts.some((h) => !h.revoked)) syncKeepAlive(false);
    setList(after);
  }, [leave]);

  /* Stable, and reading the list through a ref: the screens and the tap
     listener that hold these are not rebuilt on every fleet poll. */
  const actions = useMemo(() => ({
    pair: async (next: Host): Promise<void> => {
      const after = await addHost(next);
      forgetCachedAsks();
      generation.current++;
      setFleet(EMPTY);
      // Another computer than the one on screen: its colours do not carry over.
      if (after.active !== listRef.current.active) setDeskTheme(null);
      setList(after);
    },
    forget: async (): Promise<void> => {
      if (listRef.current.active) await forgetComputer(listRef.current.active);
    },
    switchTo: async (id: string): Promise<void> => {
      if (id === listRef.current.active) return;
      const after = await setActive(id);
      leave();
      setList(after);
    },
    rename: async (id: string, name: string): Promise<void> => {
      setList(await renameHost(id, name));
    },
    forgetComputer,
  }), [leave, forgetComputer]);

  const value = useMemo<Ctx>(() => ({
    host,
    hosts: list.hosts,
    ready,
    live,
    fleet,
    waiting: host ? { ...others.waiting, [host.id]: fleet.gates.length } : others.waiting,
    states: host ? { ...others.states, [host.id]: live } : others.states,
    refresh,
    ...actions,
  }), [host, list.hosts, ready, live, fleet, others, refresh, actions]);

  return (
    <HostContext.Provider value={value}>
      {watching
        ? list.hosts
          .filter((h) => h.id !== list.active && !h.revoked)
          .map((h) => <Watcher key={`${h.id}\0${h.origin}\0${h.token}`} host={h} bridge={bridge} />)
        : null}
      {children}
    </HostContext.Provider>
  );
}
