/*
 * What the app knows, and when it goes and finds out.
 *
 * One context, holding three things: which computer this phone is paired to,
 * whether the live socket is up, and the last answer from each of the handful
 * of endpoints the queue is built from.
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
  AlertNote, DockerContainer, DockerOverview, GitRepoRef, PendingGate, PrSummary, SessionRollup,
} from "../../../shared/types.ts";
import { dedupePrs, mainCheckouts } from "../model/prRows.ts";
import { ask, REVOKED } from "../lib/api.ts";
import { forgetHost, loadHost, saveHost, type Host } from "../lib/host.ts";
import { openLive, type LiveHandle, type LiveState } from "../lib/live.ts";
import { remember, shouldNotify } from "../notifications/policy.ts";
import { alertsDeliverable, raise } from "../notifications/notify.ts";

/** The backstop, not the mechanism. Long enough that a phone sitting in a
 *  pocket with the screen on is not talking to the network every few seconds. */
const POLL_MS = 20_000;

/** The pull-request pass. Minutes, not seconds: it costs a round trip per
 *  repository per filter, and a red build is not news that goes stale in
 *  twenty seconds. */
const SLOW_POLL_MS = 180_000;

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
  sessions: SessionRollup[];
  containers: DockerContainer[];
  /** Filled by a SECOND pass — see `loadPrs`. Empty means "not asked yet",
   *  which is why the queue draws no pull-request cards rather than claiming
   *  there are none. */
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
  host: Host | null;
  /** Null while the keystore is still being read: an app that renders "not
   *  paired" for one frame on every cold start sends people back through a
   *  handshake they already did. */
  ready: boolean;
  live: LiveState;
  fleet: Fleet;
  refresh: () => void;
  pair: (host: Host) => Promise<void>;
  forget: () => Promise<void>;
}

const EMPTY: Fleet = { gates: [], sessions: [], containers: [], prs: [], me: "", at: 0, error: null };

const HostContext = createContext<Ctx | null>(null);

export function useAgentglass(): Ctx {
  const ctx = useContext(HostContext);
  if (!ctx) throw new Error("useAgentglass outside its provider");
  return ctx;
}

export function HostProvider({ children }: { children: ReactNode }): ReactNode {
  const [host, setHost] = useState<Host | null>(null);
  const [ready, setReady] = useState(false);
  const [live, setLive] = useState<LiveState>("offline");
  const [fleet, setFleet] = useState<Fleet>(EMPTY);

  // A load in flight when another is asked for, so the newer one wins and the
  // older one cannot land on top of it.
  const generation = useRef(0);
  const liveRef = useRef<LiveHandle | null>(null);
  /** When each alert last buzzed. Held across reconnects because the socket is
   *  torn down and rebuilt for reasons that have nothing to do with the alerts
   *  — a screen waking, a network changing — and a dedupe window that reset
   *  with it would be no window at all. NOT because a reconnect replays
   *  anything: it does not, see SAME_ALERT_MS. */
  const seen = useRef(new Map<string, number>());

  useEffect(() => {
    void (async () => {
      setHost(await loadHost());
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

  const load = useCallback(async (which: Host): Promise<void> => {
    const mine = ++generation.current;
    /*
     * The three shapes, and they are not the same shape.
     *
     * `/gate/pending` and `/docker/overview` answer an OBJECT with the list
     * inside it; `/sessions` answers the ARRAY. That is not a wart worth
     * fixing here — the dashboard has relied on all three for a long time —
     * but it is worth writing down, because assuming the wrapper on all three
     * is exactly what shipped a red screen: `buildQueue` got `undefined` for
     * its sessions and threw "Cannot convert undefined value to object" out of
     * a `for…of`, which takes the whole app down rather than one card.
     *
     * `mobile/test/fleet-shapes.test.ts` holds all three against a real server
     * so this cannot drift back.
     */
    const [gates, sessions, docker] = await Promise.all([
      ask<{ gates: PendingGate[] }>(which, "/gate/pending"),
      ask<SessionRollup[]>(which, "/sessions?limit=100"),
      ask<DockerOverview>(which, "/docker/overview"),
    ]);
    if (mine !== generation.current) return;

    // A revoked credential is the one failure that is not worth retrying: the
    // person at the computer took this phone off the list, and every request
    // from here on is a 401. Drop it and land on the pairing screen.
    if ([gates, sessions, docker].some((r) => !r.ok && r.error === REVOKED)) {
      await forgetHost();
      setHost(null);
      setFleet(EMPTY);
      return;
    }

    // Partial success is kept. Docker being unavailable — no daemon, or a
    // device scoped to reading sessions only — must not blank out the gates,
    // which are the thing somebody is actually waiting on.
    const failed = [gates, sessions, docker].find((r) => !r.ok);
    /*
     * Every list is checked for being a list, even though the types above say
     * it is. The types describe what the server promises; this runs against
     * whatever answered, which may be an older build, a proxy, or a route that
     * changed shape — and the consumer is `buildQueue`, which iterates all
     * three. One `undefined` there is a render error over the whole app, not a
     * missing card, so the cheap guard buys the difference between "docker is
     * not saying anything" and a red screen.
     */
    const list = <T,>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
    setFleet((prev) => ({
      gates: gates.ok ? list<PendingGate>(gates.value.gates) : [],
      sessions: sessions.ok ? list<SessionRollup>(sessions.value) : [],
      containers: docker.ok ? list<DockerContainer>(docker.value.containers) : [],
      // Carried, not cleared. The pull-request pass runs on a slower clock, and
      // blanking its answer on every fast refresh would make those cards flash
      // in and out of the queue every twenty seconds.
      prs: prev.prs,
      me: prev.me,
      at: Date.now(),
      error: failed && !failed.ok ? failed.error : null,
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
  const loadPrs = useCallback(async (which: Host): Promise<void> => {
    const repos = await ask<{ repos: GitRepoRef[] }>(which, "/git/repos");
    if (!repos.ok) return;

    // One entry per repository: linked worktrees of one repo answer with the
    // same pull requests, and asking six of them produces one card six times.
    const roots = mainCheckouts(Array.isArray(repos.value.repos) ? repos.value.repos : []).slice(0, 6);

    const answers = await Promise.all(roots.flatMap((repo) =>
      (["mine", "review"] as const).map(async (scope) => {
        const query = `root=${encodeURIComponent(repo.root)}&filter=${scope}&state=open`;
        const answer = await ask<{ ok: boolean; prs: PrSummary[]; repo?: { nameWithOwner?: string } }>(
          which, `/prs/list?${query}`,
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
    if (!host) { setLive("offline"); return; }
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
    const slow = setInterval(() => { void loadPrs(host); }, SLOW_POLL_MS);

    const handle = openLive(host, {
      onState: (state) => {
        setLive(state);
        // A socket that has just come up may have been down for a while, and
        // what it missed is exactly what the queue is made of.
        if (state === "open") { dirty = true; settle(); }
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
        if (frame.type === "alert" && frame.data) {
          const alert = frame.data as AlertNote;
          const now = Date.now();
          const verdict = shouldNotify(alert, {
            foreground: AppState.currentState === "active",
            lastSeen: seen.current,
            now,
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
            const undo = remember(alert, { lastSeen: seen.current, now });
            void raise(alert).then((d) => { if (!d.ok) undo(); });
          }
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
    if (!host) return;
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = (): void => {
      if (timer) return;
      timer = setInterval(() => { void load(host); }, POLL_MS);
    };
    const stop = (): void => {
      if (timer) { clearInterval(timer); timer = null; }
    };

    const onChange = (state: AppStateStatus): void => {
      if (state === "active") { liveRef.current?.wake(); void load(host); start(); }
      else stop();
    };

    if (AppState.currentState === "active") start();
    const sub = AppState.addEventListener("change", onChange);
    return () => { stop(); sub.remove(); };
  }, [host, load]);

  const value = useMemo<Ctx>(() => ({
    host,
    ready,
    live,
    fleet,
    refresh,
    pair: async (next: Host): Promise<void> => {
      await saveHost(next);
      setFleet(EMPTY);
      setHost(next);
    },
    forget: async (): Promise<void> => {
      await forgetHost();
      setFleet(EMPTY);
      setHost(null);
    },
  }), [host, ready, live, fleet, refresh]);

  return <HostContext.Provider value={value}>{children}</HostContext.Provider>;
}
