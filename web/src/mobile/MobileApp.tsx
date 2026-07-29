import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { api, probeServer } from "../lib/api.ts";
import { useLive } from "../lib/useLive.ts";
import { subscribeGitChanged } from "../lib/gitBus.ts";
import { subscribeSessionChanged } from "../lib/sessionBus.ts";
import { useStats } from "../lib/useStats.ts";
import { fmtUsd, fmtTokens, since } from "../lib/format.ts";
import { MobileChats, type OpenChat, type Compose } from "./MobileChats.tsx";
import { MOBILE_CSS, Sheet, Toasts, useToasts, Row, Act, useAsk } from "./mobileUi.tsx";
import { pollWhileVisible } from "../lib/poll.ts";
import { DIFF_CSS } from "./MobileDiff.tsx";
import { NOW_CSS, NowHero, NowStream, type NowAction, type LiveCall } from "./MobileNow.tsx";
import { RepoList, RepoScreen, ContainerScreen, HALT_CSS, type RepoSummary } from "./MobileRepo.tsx";
import { projectRows } from "./projects.ts";
import { baseName, ownerOf } from "../../../shared/projectKey.ts";
import { MobilePr, THREAD_CSS } from "./MobilePr.tsx";
import { MobileFleet, FLEET_CSS } from "./MobileFleet.tsx";
import { sessionForInsight } from "./fleet.ts";
import { buildQueue, type NowItem } from "./nowQueue.ts";
import { dedupePrs, mainCheckouts } from "./prRows.ts";
import { deviceStore, restoreAll, snooze, unsnoozed } from "./snooze.ts";
import {
  browserPushEnv, currentPushState, disablePush, enablePush, isOpenedFromNotification,
  myDeviceId, pushCopy, type PushState,
} from "../lib/webpush.ts";
import type { PushDevice } from "../lib/api.ts";
import type {
  PendingGate, SessionRollup, DockerContainer, DockerStat, PrSummary, GitRepoRef, GitTreeState, Insight,
} from "../../../shared/types.ts";

/**
 * agentglass away from the desk.
 *
 * Not a smaller cockpit, and not a dashboard: a companion. The first pass at
 * this was three tabs, two of which you could only read. The obvious next move
 * was to add git, docker and pull requests as three more tabs — but a tab bar
 * claims its entries are equal and independent, and those three are neither.
 * They are facets of a repository, and none of them is somewhere you browse
 * to: you arrive at them because something happened.
 *
 * So the home is a queue of things that want a decision, each carrying its own
 * action, and answering one takes it out of the list. That is the whole
 * difference from a dashboard — a dashboard is something you re-read, and this
 * is something you can empty.
 *
 *   Now    — what wants you, in order. Allow, reply, merge, restart.
 *   Chats  — say something back. This part was already right.
 *   Repos  — go looking, for when you want to rather than need to.
 *
 * Nothing heavy mounts: no xterm, no charts, no radar. On a phone that is a
 * battery decision as much as a layout one.
 *
 * It is on the live socket, and that is what makes the rest of it honest. The
 * first version polled and said so in a comment here — a reasonable-sounding
 * trade that quietly gave up the product's whole premise, because a server with
 * no channel to this device cannot tell it anything. What replaced the bars
 * that used to stand in for telemetry is the server's own list of tool calls
 * still open.
 */

type Tab = "now" | "chats" | "repos" | "fleet";

/** Live on the socket · reachable but not streaming · nothing answering. */
type LinkState = "live" | "slow" | "offline";
const LINK_WORD: Record<LinkState, string> = { live: "Live", slow: "Catching up", offline: "Offline" };
const LINK_TONE: Record<LinkState, string> = {
  live: "var(--success)", slow: "var(--warning)", offline: "var(--error)",
};

/**
 * How often the phone asks whether the machine is still there.
 *
 * Separate from the data polls on purpose, and this is a correction to the
 * change that put the phone on the socket. Reachability used to be a side
 * effect of the four-second gate poll, and slowing that poll to a backstop
 * slowed the *indicator* with it — so the header went on claiming a live
 * connection for up to twenty seconds after the server stopped answering, and
 * claimed it outright whenever the socket happened to still be open while every
 * request was failing. Saying "Live" over stale numbers is the one thing an
 * availability indicator must never do.
 *
 * `/health` is a few bytes and touches no database, and this only ticks while
 * somebody is looking at the screen.
 */
const HEALTH_MS = 5_000;

/**
 * Fallback intervals, not the delivery mechanism.
 *
 * Everything below arrives on the socket now. These exist for the seconds
 * between a socket dying and the reconnect landing, so they are set to what a
 * *backstop* should cost rather than what a primary path has to be — a phone
 * pays a radio wake for each one.
 *
 * Docker and pull requests keep real intervals because nothing pushes them:
 * docker has no change feed we subscribe to, and GitHub has no route into this
 * server.
 */
const GATE_MS = 20_000;
const TREE_MS = 120_000;
const DOCKER_MS = 15_000;
const PR_MS = 60_000;
/** Insights are computed over a window of hours; asking oftener than the answer
 *  can change is a radio wake for nothing. */
const INSIGHT_MS = 90_000;

export function MobileApp() {
  const [tab, setTab] = useState<Tab>("now");
  const { toasts, toast } = useToasts();
  const { ask, dialog: askDialog } = useAsk();
  const { stats } = useStats(86_400_000);

  const [gates, setGates] = useState<PendingGate[]>([]);
  const [sessions, setSessions] = useState<SessionRollup[]>([]);
  const [reachable, setReachable] = useState(true);
  const [repos, setRepos] = useState<GitRepoRef[]>([]);
  const [trees, setTrees] = useState<Record<string, {
    branch: string; dirty: number; ahead: number; behind: number;
    /** What git is in the middle of, and what is in the way of finishing it.
     *  Read from the tree the poll already fetches; the conflicted paths cost
     *  a second request, made only for a checkout that is actually stopped. */
    state?: GitTreeState; conflicts: string[];
  }>>({});
  const [containers, setContainers] = useState<DockerContainer[]>([]);
  const [dstats, setDstats] = useState<DockerStat[]>([]);
  /** Whether docker answered at all, and what it said if not. The server
   *  distinguishes "not installed" from "daemon down" from "no answer yet"; the
   *  phone used to collapse all three into an empty list. */
  const [docker, setDocker] = useState<{ available: boolean; error: string | null }>({ available: true, error: null });
  const [prs, setPrs] = useState<{ root: string; repo: string; pr: PrSummary; scope: "mine" | "review" }[]>([]);
  const [me, setMe] = useState("");

  const [openRepo, setOpenRepo] = useState<RepoSummary | null>(null);
  /** Every checkout of the open project — the repo and its linked worktrees —
   *  so the screen can offer them instead of the list pretending they are
   *  separate projects. */
  const [openCheckouts, setOpenCheckouts] = useState<RepoSummary[]>([]);
  const [openPr, setOpenPr] = useState<{ root: string; number: number } | null>(null);
  /** A container opened from anywhere — the queue, a project, the fleet. It
   *  needs no repo context, so it does not have to have one. */
  const [openCtr, setOpenCtr] = useState<DockerContainer | null>(null);
  /**
   * The chat destinations, held here so anything can name one.
   *
   * They lived inside MobileChats, which is why every route into it was
   * approximate: the queue's "Open chat" could only reach the chats *tab*, and
   * the two hand-offs that carry a directory and a prompt had nowhere to put
   * them, so they never rendered.
   */
  const [openChat, setOpenChat] = useState<OpenChat | null>(null);
  const [compose, setCompose] = useState<Compose | null>(null);
  const [settings, setSettings] = useState(false);
  /**
   * Whether this phone gets alerts with its screen off.
   *
   * `null` while it is being worked out: three separate things decide it — the
   * browser's support, the notification permission, and whether a subscription
   * exists — and only the first is known synchronously. Rendering a guess in
   * the meantime would flash "Turn on" at a phone that is already subscribed,
   * which is exactly the mistake that ends with two of every alert.
   */
  const [pushState, setPushState] = useState<PushState | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushTesting, setPushTesting] = useState(false);
  /** A conversation is open and owns the whole screen: no app header, no tabs. */
  const [immersive, setImmersive] = useState(false);
  /**
   * Two different things used to share one list.
   *
   * `answered` is a bridge: you allowed a gate or merged a pull request, and
   * the card should go now rather than when the next poll confirms what you
   * already know. It is per-mount on purpose — the underlying row is gone from
   * the server too, so there is nothing to remember.
   *
   * "Later" is not that. It outlives the tab and it is keyed on what the card
   * reports, so it lifts itself the moment there is news — see snooze.ts.
   */
  const [answered, setAnswered] = useState<string[]>([]);
  const [insights, setInsights] = useState<Insight[]>([]);
  const snoozeStore = useMemo(() => deviceStore(), []);
  const [snoozeRev, bumpSnooze] = useReducer((n: number) => n + 1, 0);

  // ── push ─────────────────────────────────────────────────────────────
  //
  // Resolved on mount, and again whenever Settings is opened. `currentPushState`
  // registers the worker as a side effect, which is the point of doing it on
  // mount rather than only when the toggle is used: registering an unchanged
  // file is a no-op, and it means the worker that receives the next push is the
  // one that shipped, not one left over from an older build.
  const pushEnv = useMemo(() => browserPushEnv(api), []);
  useEffect(() => {
    let live = true;
    currentPushState(pushEnv).then((s) => { if (live) setPushState(s); });
    return () => { live = false; };
  }, [pushEnv, settings]);

  /**
   * Every device subscribed to this machine, not only this one.
   *
   * The row above speaks for the phone in your hand; a phone you replaced last
   * year is still on the list and still being pushed to, and the only place
   * that could ever be seen or stopped is here. Read when Settings opens
   * rather than polled — nothing about it changes while the sheet is shut.
   */
  const [devices, setDevices] = useState<PushDevice[]>([]);
  const [myDevice, setMyDevice] = useState<string | null>(null);
  const [forgetting, setForgetting] = useState<string | null>(null);
  const refreshDevices = useCallback(() => {
    api.pushDevices()
      .then((r) => setDevices(r.devices ?? []))
      .catch(() => { /* the sheet works without it; the row above is the point */ });
    myDeviceId(pushEnv).then(setMyDevice).catch(() => setMyDevice(null));
  }, [pushEnv]);
  useEffect(() => { if (settings) refreshDevices(); }, [settings, refreshDevices, pushState]);

  const forgetDevice = useCallback(async (d: PushDevice) => {
    setForgetting(d.id);
    try {
      await api.pushForget(d.id);
      // If it was this phone, the switch above has to stop saying "on" — the
      // browser still holds a subscription the server no longer knows about,
      // and that is precisely the state where alerts silently stop.
      if (d.id === myDevice) { await disablePush(pushEnv); setPushState("off"); }
      refreshDevices();
      toast(d.id === myDevice ? "Alerts off on this phone" : `${d.label || "That device"} will no longer be alerted`);
    } catch {
      toast("Could not reach the server", true);
    }
    setForgetting(null);
  }, [myDevice, pushEnv, refreshDevices]);

  const togglePush = useCallback(async () => {
    setPushBusy(true);
    // The result carries the state it ended in, including the failures: a
    // denied permission lands on "blocked", which has no button, because the
    // browser will not ask again and only the user can undo it.
    const r = pushState === "on" ? await disablePush(pushEnv) : await enablePush(pushEnv);
    setPushState(r.state);
    setPushBusy(false);
    // The second argument is what makes it a failure toast. Without it a
    // browser reporting "the push service could not be reached" arrived under
    // a green tick — which is how a real run of this looked before it was
    // fixed, and it read as though push had been turned on.
    if (r.ok) toast(r.state === "on" ? "This phone will be alerted" : "Alerts off on this phone");
    else toast(r.error, true);
  }, [pushEnv, pushState]);

  /**
   * Prove it, now, rather than the next time an agent blocks.
   *
   * Until this existed the only way to find out whether push worked was to
   * walk away and see whether anything arrived — so a silent failure was
   * indistinguishable from a quiet afternoon, and you learned by missing the
   * one thing the feature is for.
   */
  const testPush = useCallback(async () => {
    setPushTesting(true);
    try {
      const r = await api.pushTest();
      // Three different outcomes, because they need three different reactions:
      // it arrived, this device is no longer registered (turn it on again), or
      // nothing is subscribed at all.
      if (r.sent > 0) toast(r.sent === 1 ? "Sent — check your notifications" : `Sent to ${r.sent} devices`);
      else if (r.pruned > 0) { setPushState("off"); toast("This device is no longer registered — turn it on again", true); }
      else if (r.failed > 0) toast("The push service would not take it", true);
      else toast("No device is subscribed", true);
    } catch {
      toast("The server could not be reached", true);
    }
    setPushTesting(false);
  }, []);

  // ── the live channel ─────────────────────────────────────────────────
  //
  // This used to be polling only, and the reasoning was written down here: a
  // socket reconnecting behind a dark screen is a worse deal than a few small
  // requests. The battery half of that is right and is kept — the socket closes
  // with the screen and catches up on return, exactly as the polls did.
  //
  // What it got wrong is what it cost. Without a channel the server has no way
  // to say anything, so nothing on this device could ever be current: a gate
  // arrived up to four seconds late, a change made here took up to a minute to
  // reach the desk, and "what is that agent doing right now" had no answer at
  // all — which is why the home screen animated fourteen bars off a tool
  // *count* and called them vitals.
  //
  // `keepEvents: false` is the phone's half of the bargain: the same socket,
  // without the two-thousand-row event buffer the cockpit's stream needs and
  // this app never draws.
  const { conn, openTools } = useLive(false, false);

  // The polls stay, slowed right down. They are no longer how anything gets
  // here — they are what covers the gap between the socket dying and noticing.
  const loadFast = useCallback(() => {
    api.gatePending().then((r) => { setGates(r.gates); setReachable(true); }).catch(() => setReachable(false));
    // 40 was the page size while the list had no search, and it made the scope
    // called "All" mean "the newest forty" — a chat from three days ago was
    // unreachable by any route. The desktop has always taken 200; a rollup row
    // is small and this arrives once on the socket's nudge rather than on a
    // four-second poll.
    api.sessions(200).then(setSessions).catch(() => { /* the gate poll reports reachability */ });
  }, []);

  const loadDocker = useCallback(() => {
    // `available` and `error` were dropped, so "docker is not running on this
    // machine" and "this project has no containers" rendered as the same
    // sentence — and only one of them is something you can act on.
    api.dockerOverview().then((o) => {
      setContainers(o.available ? o.containers : []);
      setDocker({ available: o.available, error: o.error ?? null });
    }).catch((e) => { setContainers([]); setDocker({ available: false, error: String(e) }); });
    api.dockerStats().then((r) => setDstats(r.stats)).catch(() => setDstats([]));
  }, []);

  const loadTrees = useCallback((list: GitRepoRef[]) => {
    for (const r of list) {
      api.gitTree(r.root).then(async (t) => {
        const state = t.branch.state;
        // Only a stopped checkout pays for the second request, and normally
        // none of them are stopped — so the poll costs exactly what it did.
        const conflicts = state && state !== "clean"
          ? await api.gitConflicts(r.root).then((c) => c.files).catch(() => [] as string[])
          : [];
        setTrees((cur) => ({
          ...cur,
          [r.root]: {
            branch: t.branch.name,
            // A file part-staged appears in both lists; counting it twice would
            // report more work outstanding than there is.
            // Conflicted paths are counted too. `git diff` emits a combined
            // diff for an unmerged file and the tree parser makes no row out of
            // it, so a checkout whose only outstanding work is a conflict
            // reported nothing dirty at all — the list row was silent about the
            // one repository on the machine that could not move.
            dirty: new Set([...t.staged, ...t.unstaged].map((f) => f.file_path).concat(conflicts)).size,
            ahead: t.branch.ahead, behind: t.branch.behind,
            state, conflicts,
          },
        }));
      }).catch(() => { /* a repo that will not open is not worth a toast on a poll */ });
    }
  }, []);

  /**
   * Pull requests, once per project rather than once per checkout.
   *
   * Three worktrees of one repository are three entries in this list and one
   * repository on GitHub, so every open pull request was fetched three times
   * and queued three times — the same card, three rows apart, and a count of
   * three where there was one thing to do. `worktreeOf` names the checkout a
   * worktree belongs to, so only the mains are asked.
   *
   * Deduplicated on the answer as well, because two projects can legitimately
   * point at one GitHub repository (a fork and its upstream, a repo checked out
   * twice) and folding by path would not catch that. "mine" wins over "review":
   * a pull request that is both is one you have to fix, not one you have to
   * look at.
   */
  const loadPrs = useCallback((list: GitRepoRef[]) => {
    Promise.all(mainCheckouts(list).flatMap((r) => (["mine", "review"] as const).map((scope) =>
      api.prList(r.root, scope, "open")
        .then((res) => res.prs.map((pr) => ({ root: r.root, repo: baseName(r.root), pr, scope })))
        .catch(() => [] as { root: string; repo: string; pr: PrSummary; scope: "mine" | "review" }[])
    ))).then((groups) => setPrs(dedupePrs(groups.flat())));
  }, []);

  // Is the machine still there? Its own probe, so the answer is never as old as
  // the slowest data poll.
  useEffect(() => {
    const ping = () => probeServer(2_000).then((id) => setReachable(id === "ours")).catch(() => setReachable(false));
    ping();
    return pollWhileVisible(ping, HEALTH_MS);
  }, []);

  useEffect(() => {
    const load = () => api.insights().then((r) => setInsights(r.insights || [])).catch(() => { /* a poll */ });
    load();
    return pollWhileVisible(load, INSIGHT_MS);
  }, []);

  useEffect(() => {
    loadFast();
    // Skipped while the tab is hidden and caught up on the way back — see
    // pollWhileVisible. Nobody answers a gate they cannot see, and on a phone
    // each tick costs a radio wake as well as a round trip.
    return pollWhileVisible(loadFast, GATE_MS);
  }, [loadFast]);

  /**
   * The repository list, and everything gated on it.
   *
   * This was a single fetch on mount with an empty `catch`, and every other
   * poll is gated on `repos.length` — so one failed request at boot (a sidecar
   * still starting, a phone that woke on the wrong network) left the tree, the
   * pull requests and docker permanently empty, with no refresh control
   * anywhere on the phone to recover with. Killing the tab was the only way
   * back.
   *
   * Now it retries, and it re-reads whenever git says something changed, which
   * is also how a worktree created at the desk finally appears here.
   */
  const loadRepos = useCallback(() => {
    api.gitRepos()
      .then(({ repos: list }) => { setRepos(list); loadTrees(list); loadPrs(list); })
      .catch(() => setRepos((cur) => cur));
  }, [loadTrees, loadPrs]);

  useEffect(() => {
    api.prCapability().then((c) => setMe(c.login || "")).catch(() => {});
    loadRepos();
    loadDocker();
  }, [loadDocker, loadRepos]);

  // Retry the one fetch everything else depends on until it lands.
  useEffect(() => {
    if (repos.length) return;
    const t = setTimeout(loadRepos, 5_000);
    return () => clearTimeout(t);
  }, [repos.length, loadRepos]);

  // ── pushed, not polled ───────────────────────────────────────────────
  useEffect(() => subscribeGitChanged(() => { loadRepos(); }), [loadRepos]);

  useEffect(() => {
    // A `session` frame fires on every ingest — several a second under a busy
    // fleet — and this list only needs to be right, not instantaneous. One
    // trailing call per burst.
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = subscribeSessionChanged(() => {
      if (t) return;
      t = setTimeout(() => { t = null; loadFast(); }, 1_200);
    });
    return () => { off(); if (t) clearTimeout(t); };
  }, [loadFast]);

  useEffect(() => {
    if (!repos.length) return;
    const stop = [
      pollWhileVisible(() => loadTrees(repos), TREE_MS),
      pollWhileVisible(() => loadPrs(repos), PR_MS),
      pollWhileVisible(loadDocker, DOCKER_MS),
    ];
    return () => { for (const s of stop) s(); };
  }, [repos, loadTrees, loadPrs, loadDocker]);

  const refreshAll = useCallback(() => {
    loadFast(); loadDocker();
    if (repos.length) { loadTrees(repos); loadPrs(repos); }
  }, [loadFast, loadDocker, loadTrees, loadPrs, repos]);

  // ── derived ──────────────────────────────────────────────────────────
  const live = useMemo(
    () => sessions.filter((s) => !s.ended_at && Date.now() - s.last_seen < 120_000),
    [sessions]
  );

  /** The server's own list of calls still running, in the order that reads
   *  worst-first: the one that has been open longest is the one most likely to
   *  be stuck rather than thinking. */
  const openCalls: LiveCall[] = useMemo(() => {
    const now = Date.now();
    return [...openTools]
      .sort((a, b) => a.since - b.since)
      .map((t) => ({
        key: `${t.session_id}:${t.tool_name}:${t.since}`,
        tool: t.tool_name,
        target: t.target ?? null,
        app: t.source_app,
        openMs: Math.max(0, now - t.since),
      }));
  }, [openTools]);

  /** Everything that would be in the queue if nothing had been put away. */
  const pending = useMemo(
    () => buildQueue({ gates, sessions, prs, containers, trees, me, now: Date.now() })
      .filter((i) => !answered.includes(i.id)),
    [gates, sessions, prs, containers, trees, me, answered]
  );
  const queue = useMemo(
    () => unsnoozed(snoozeStore, pending),
    [pending, snoozeStore, snoozeRev]
  );

  /**
   * Which checkout each container belongs to, decided once by the rule the
   * server uses rather than by comparing a compose project name to a directory
   * basename. Null is a real answer and gets a real screen.
   */
  const roots = useMemo(() => repos.map((r) => r.root), [repos]);
  const ownerByContainer = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const c of containers) m.set(c.id, ownerOf(c, roots));
    return m;
  }, [containers, roots]);

  const repoSummaries: RepoSummary[] = useMemo(() => repos.map((r) => {
    const t = trees[r.root];
    return {
      ref: r, name: baseName(r.root),
      branch: t?.branch ?? "—",
      dirty: t?.dirty ?? 0, ahead: t?.ahead ?? 0, behind: t?.behind ?? 0,
      prs: prs.filter((p) => p.root === r.root).length,
      down: containers.filter((c) =>
        ownerByContainer.get(c.id) === r.root && c.state !== "running" && c.state !== "created").length,
    };
  }), [repos, trees, prs, containers, ownerByContainer]);

  /** An answered item leaves the queue at once, before the next poll confirms
   *  it. Waiting four seconds to watch your own tap take effect is what makes
   *  a companion feel like a web page. */
  const drop = (id: string) => setAnswered((d) => [...d, id]);

  /** Put it away until it has something new to say. */
  const later = (it: NowItem) => {
    snooze(snoozeStore, it);
    bumpSnooze();
    toast("Snoozed — back when it changes");
  };

  const decide = async (id: string, d: "allow" | "deny", itemId: string) => {
    try {
      await api.gateDecide(id, d);
      drop(itemId);
      toast(d === "allow" ? "Allowed — the agent is moving again" : "Denied — the agent was told no");
    } catch {
      // An answer that did not arrive must not look like one that did: the
      // agent is still blocked, and saying otherwise is the worst outcome here.
      toast("That did not reach the server — the agent is still waiting", true);
    }
  };
  const settle = async (label: string, run: () => Promise<{ ok: boolean; error?: string }>, itemId?: string) => {
    const r = await run();
    toast(r.ok ? label : (r.error || `${label} failed`), !r.ok);
    if (r.ok) { if (itemId) drop(itemId); refreshAll(); }
  };
  /** A container belongs to a repo, so open its repo rather than inventing a
   *  second route to the same screen. */
  /** Open a project's screen with all of its checkouts, however you got there —
   *  the list, a container, a queue item. Opening it without them would leave
   *  the picker showing whichever project was opened last. */
  const openProject = useCallback((r: RepoSummary) => {
    const group = projectRows(repoSummaries).find((g) => g.checkouts.some((c) => c.ref.root === r.ref.root));
    setOpenCheckouts(group?.checkouts ?? [r]);
    setOpenRepo(r);
  }, [repoSummaries]);

  /** The same screen, reached from a card that only knows a path. */
  const openRoot = useCallback((root: string) => {
    const r = repoSummaries.find((s) => s.ref.root === root);
    if (r) openProject(r);
  }, [repoSummaries, openProject]);

  /** Open one specific conversation, wherever the tap came from. */
  const openSession = useCallback((s: SessionRollup) => {
    setOpenChat({ id: s.session_id, cwd: s.cwd_path || s.project_path || "" });
    setTab("chats");
  }, []);

  /**
   * "Review locally with Claude" and "Ask Claude why".
   *
   * Both screens have offered these behind `onOpenChatWith &&` since they were
   * written, and nothing ever passed one — so neither button has ever been on
   * screen. They arrive with the checkout the server put the pull request in
   * and the prompt to open with, which is why NewChat takes a preset rather
   * than always starting on the first repo in the list.
   */
  /**
   * A notification was tapped, so show what it was about.
   *
   * Focusing the window is not enough on its own: the app is wherever it was
   * left — the fleet, a diff, a conversation — so tapping "Approval needed"
   * raised a screen showing something else, and the thing that woke you was
   * one or two taps away and unmentioned.
   *
   * Everything open is closed rather than the tab merely switched, because a
   * parked screen sits *over* the tabs: setting the tab underneath a diff
   * changes nothing anybody can see.
   */
  useEffect(() => {
    const sw = typeof navigator === "undefined" ? null : navigator.serviceWorker;
    if (!sw) return;
    const onMessage = (e: MessageEvent) => {
      if (!isOpenedFromNotification(e.data)) return;
      setOpenPr(null);
      setOpenRepo(null);
      setOpenCtr(null);
      setOpenChat(null);
      setCompose(null);
      setSettings(false);
      setTab("now");
    };
    sw.addEventListener("message", onMessage);
    return () => sw.removeEventListener("message", onMessage);
  }, []);

  const openChatWith = useCallback((cwd: string, prompt: string) => {
    setOpenPr(null);
    setOpenRepo(null);
    setCompose({ cwd, prompt });
    setTab("chats");
  }, []);

  /**
   * Open a container, whatever agentglass does or does not know about it.
   *
   * This used to look for a repo whose directory basename equalled the compose
   * project name and, failing that, raise a toast — so a container compose had
   * renamed (`My.App` → `myapp`), or one started with plain `docker run`, had
   * no screen at all. The queue offered it a "Logs" button that did nothing.
   * A container agentglass cannot place is still yours and still running.
   */
  const openContainer = useCallback((c: DockerContainer) => setOpenCtr(c), []);

  const actionsFor = (it: NowItem): NowAction[] => {
    const o = it.origin;
    switch (o.t) {
      case "gate":
        return [
          { label: "Allow", kind: "ok", run: () => decide(o.gate.id, "allow", it.id) },
          { label: "Deny", kind: "no", run: () => decide(o.gate.id, "deny", it.id) },
        ];
      case "session":
        return [
          // This used to be `setTab("chats")` and a drop — you tapped the accent
          // action on a stalled agent, landed on a list that by construction
          // could not contain it (the list opens on "working"; this card exists
          // because the agent went quiet), and the card was gone from the queue.
          { label: "Open chat", kind: "acc", run: () => openSession(o.session) },
          { label: "Later", tight: true, run: () => later(it) },
        ];
      case "pr-red":
        return [
          { label: "See the log", run: () => setOpenPr({ root: o.root, number: o.pr.number }) },
          { label: "Re-run", kind: "acc", run: () => settle("Re-running the failed checks", () => api.prRerun(o.root, o.pr.number)) },
          { label: "Later", tight: true, run: () => later(it) },
        ];
      case "pr-ready":
        return [
          {
            // The one queue action that cannot be undone. Everything else here
            // re-runs, snoozes or opens something; this rewrites history and
            // deletes a branch, from a card the thumb is already scrolling past.
            label: "Squash & merge", kind: "ok",
            run: async () => {
              if (!(await ask({
                title: `Squash & merge #${o.pr.number}?`, danger: true, confirmLabel: "Squash & merge",
                body: "Every commit becomes one, and the head branch is deleted straight after. Neither step is reversible from here.",
              }))) return;
              await settle(`Merged #${o.pr.number}`, () => api.prMerge(o.root, o.pr.number, "squash", { deleteBranch: true }), it.id);
            },
          },
          { label: "Review", run: () => setOpenPr({ root: o.root, number: o.pr.number }) },
        ];
      case "pr-review":
        return [
          { label: "Review", kind: "acc", run: () => setOpenPr({ root: o.root, number: o.pr.number }) },
          { label: "Later", tight: true, run: () => later(it) },
        ];
      case "container":
        return [
          { label: "Logs", run: () => openContainer(o.container) },
          { label: "Restart", kind: "acc", run: () => settle(`Restarted ${o.container.name}`, () => api.dockerRestart(o.container.id)) },
          { label: "Later", tight: true, run: () => later(it) },
        ];
      case "halt": {
        const h = o.halt;
        return [
          {
            // Abandoning is the move that is always safe and the one people
            // reach for first — but it throws away whatever was resolved, so
            // from a phone it asks.
            label: h.abortLabel, kind: "no",
            run: async () => {
              if (!(await ask({
                title: h.abortLabel + "?", danger: true, confirmLabel: "Abandon",
                body: h.state === "bisecting"
                  ? "The search ends and the tree goes back to the commit you started from."
                  : "The tree goes back to exactly how it was before this started. Anything already resolved is lost.",
              }))) return;
              await settle(`Abandoned — ${baseName(o.root)} is back where it was`,
                () => api.gitMergeAbort(o.root), it.id);
            },
          },
          ...(h.canContinue
            ? [{
                label: h.continueLabel!, kind: "ok" as const,
                run: () => settle(`Finished — ${baseName(o.root)} is clean`,
                  () => api.gitMergeContinue(o.root), it.id),
              }]
            : []),
          // No "Later": a repository nothing can move until somebody decides is
          // not a thing to put off, and hiding it is how you find it tomorrow.
          ...(h.conflicts.length
            ? [{ label: "Resolve", kind: "acc" as const, run: () => openRoot(o.root) }]
            : []),
        ];
      }
    }
  };

  const openItem = (it: NowItem) => {
    const o = it.origin;
    if (o.t === "pr-red" || o.t === "pr-ready" || o.t === "pr-review") setOpenPr({ root: o.root, number: o.pr.number });
    else if (o.t === "container") openContainer(o.container);
    else if (o.t === "session") openSession(o.session);
    else if (o.t === "halt") openRoot(o.root);
  };

  const stacked = !!openRepo || !!openPr;
  const spend = stats?.totals ? fmtUsd(stats.totals.cost_usd) : "—";
  /**
   * How many cards the queue is hiding *right now*.
   *
   * Not the size of the store, which is the number I reached for first and is a
   * different claim: a snoozed agent that has since ended is an entry nobody
   * can restore, and counting it would put a Restore button on the sheet that
   * changes nothing when you press it. The difference between the two lists is
   * the only figure that survives being acted on.
   */
  const snoozed = pending.length - queue.length;

  /**
   * One word for the state of the link, and it distinguishes the three cases a
   * single boolean could not: the socket is carrying data, the socket is gone
   * but the server still answers (so nothing is lost, only late), and nothing
   * is reachable at all.
   */
  const link: LinkState = !reachable ? "offline" : conn === "open" ? "live" : "slow";

  return (
    <div className="mb min-h-[100dvh] flex flex-col" style={{ background: "var(--bg)", color: "var(--text)" }}>
      <style>{MOBILE_CSS}{DIFF_CSS}{NOW_CSS}{HALT_CSS}{THREAD_CSS}{FLEET_CSS}</style>
      {askDialog}
      <div className="mb-sky" />

      {!immersive && <header className="sticky top-0 z-40 flex items-center gap-2 px-4"
        style={{
          paddingTop: "calc(env(safe-area-inset-top) + 11px)", paddingBottom: 10,
          background: "color-mix(in srgb, var(--bg) 80%, transparent)", backdropFilter: "blur(16px) saturate(1.4)",
          borderBottom: "1px solid var(--mb-line)",
        }}>
        <span className="text-[17.5px] font-bold tracking-tight">
          agent<span style={{ color: "var(--primary-hover)" }}>glass</span>
        </span>
        <span className="flex-1" />
        {/* What this said before was that one four-second poll had succeeded,
            on an app with no live connection — "Live" meant "the last request
            came back". It is the socket now, so it can mean what it says. */}
        <span className="flex items-center gap-1.5 text-[11px]" style={{ color: LINK_TONE[link] }}>
          <span className="mb-dot pulse" style={{ background: "currentColor", color: "currentColor" }} />
          {LINK_WORD[link]}
        </span>
        <button className="mb-press grid place-items-center" aria-label="Settings"
          style={{ minHeight: 40, minWidth: 40, borderRadius: 11, fontSize: 15, color: "var(--text3)", background: "transparent" }}
          onClick={() => setSettings(true)}>⚙</button>
      </header>}

      {/* No padding while a conversation owns the screen: it is a fixed
          full-height surface of its own, and the reserve for a tab bar that is
          not being drawn would only push its composer off the bottom. */}
      <main className="flex-1 relative"
        style={{ zIndex: 1, padding: immersive ? 0 : "14px 15px calc(var(--nav) + env(safe-area-inset-bottom) + 22px)" }}>
        {tab === "now" && (
          <>
            <NowHero
              pending={queue.length} working={live.length}
              live={openCalls}
              spend={spend}
              repos={[...new Set(live.map((s) => (s.project_path || "").split("/").filter(Boolean).pop() || s.source_app))]}
            />
            <NowStream items={queue} actionsFor={actionsFor} onOpen={openItem} />
          </>
        )}
        {tab === "chats" && <MobileChats sessions={sessions} onRefresh={loadFast} onImmersive={setImmersive}
          openChat={openChat} onOpenChat={setOpenChat} compose={compose} onCompose={setCompose} />}
        {tab === "repos" && <RepoList repos={repoSummaries} onOpen={(r, siblings) => { setOpenCheckouts(siblings); setOpenRepo(r); }} />}
        {tab === "fleet" && <MobileFleet insights={insights} stats={stats}
          onOpenInsight={(i) => {
            const found = sessionForInsight(i.session, sessions);
            // Nothing to open is a real answer here: the label is eight hex
            // characters and an app name, and two sessions can share them.
            if (found) openSession(found);
            else toast(i.session ? "That agent is no longer in the list" : "This one is about the fleet, not one agent");
          }} />}
      </main>

      {!immersive && <nav className="fixed left-0 right-0 bottom-0 z-40 flex"
        style={{
          background: "color-mix(in srgb, var(--bg2) 84%, transparent)", backdropFilter: "blur(20px) saturate(1.5)",
          borderTop: "1px solid color-mix(in srgb, var(--border) 48%, transparent)",
          paddingBottom: "env(safe-area-inset-bottom)",
        }}>
        <TabBtn id="now" tab={tab} onPick={setTab} glyph="◎" label="Now" badge={queue.length} />
        <TabBtn id="chats" tab={tab} onPick={setTab} glyph="▤" label="Chats" />
        <TabBtn id="repos" tab={tab} onPick={setTab} glyph="◇" label="Repos" />
        {/* Everything on this tab was computed and served from the beginning
            and had no route to a phone. The badge is what is misbehaving. */}
        <TabBtn id="fleet" tab={tab} onPick={setTab} glyph="◈" label="Fleet"
          badge={insights.filter((i) => i.severity === "bad").length} />
      </nav>}

      <RepoScreen open={!!openRepo && !openPr} repo={openRepo}
        checkouts={openCheckouts} onPickCheckout={setOpenRepo}
        containers={containers.filter((c) => ownerByContainer.get(c.id) === openRepo?.ref.root)} stats={dstats}
        onOpenContainer={openContainer} docker={docker}
        onBack={() => setOpenRepo(null)} toast={toast} onRefresh={refreshAll}
        onOpenChatWith={openChatWith} />

      <ContainerScreen open={!!openCtr} c={openCtr} stat={dstats.find((s) => s.id === openCtr?.id)}
        project={openCtr ? ownerByContainer.get(openCtr.id) ?? null : null}
        onBack={() => setOpenCtr(null)} toast={toast} onRefresh={refreshAll} />

      <MobilePr open={!!openPr} root={openPr?.root ?? ""} number={openPr?.number ?? null}
        onBack={() => { setOpenPr(null); refreshAll(); }} toast={toast}
        onOpenChatWith={openChatWith} />

      <Sheet open={settings} title="Settings" sub="This device only." onClose={() => setSettings(false)}>
        <div className="flex flex-col gap-2.5">
          <Row title="Spend today" sub={stats?.totals ? `${fmtTokens(stats.totals.input_tokens + stats.totals.output_tokens)} tokens` : "—"} right={spend} />
          <Row title="Sessions" sub="In the last 24 hours" right={stats?.totals ? String(stats.totals.sessions) : "—"} />
          <Row title="Tool errors" sub="In the last 24 hours" right={stats?.totals ? String(stats.totals.errors) : "—"} />
        </div>
        <div className="mb-eyebrow" style={{ margin: "16px 0 9px" }}>Alerts</div>
        {/* The one channel that reaches a phone in a pocket. The socket closes
            with the screen on purpose, and a webhook or a desktop toast needs
            somebody already looking — so without this, the case the companion
            exists for is the one case nothing covers. */}
        <Row title="Push to this phone"
          sub={pushState === null ? "Checking…" : pushCopy(pushState).sub}
          right={pushState === null ? undefined : (
            <span className="flex items-center gap-1.5">
              {/* Only once it is on: a Test that could only ever fail is not a
                  test, it is a second way to be told no. */}
              {pushState === "on" && (
                <Act small disabled={pushTesting || pushBusy} onAct={testPush}>
                  {pushTesting ? "…" : "Test"}
                </Act>
              )}
              {pushCopy(pushState).action && (
                <Act small disabled={pushBusy || pushTesting} onAct={togglePush}>
                  {pushBusy ? "…" : pushCopy(pushState).action}
                </Act>
              )}
            </span>
          )} />
        {/* Every device, not only this one. A phone you replaced last year is
            still subscribed and still being pushed to, and this is the only
            place it can be seen — or stopped. Hidden when there is nothing to
            manage: one device is already fully described by the row above. */}
        {devices.length > 1 && (
          <div className="flex flex-col gap-2.5" style={{ marginTop: 10 }}>
            {devices.map((d) => (
              <Row key={d.id}
                title={`${d.label || "A device"}${d.id === myDevice ? " · this phone" : ""}`}
                sub={d.lastOkAt
                  ? `Last alerted ${since(d.lastOkAt)}`
                  // Added but never delivered to is worth saying plainly: it is
                  // what a subscription that never worked looks like, and it is
                  // otherwise indistinguishable from a quiet week.
                  : `Added ${since(d.addedAt)} · never alerted`}
                right={
                  <Act small disabled={forgetting === d.id} onAct={() => forgetDevice(d)}>
                    {forgetting === d.id ? "…" : "Forget"}
                  </Act>
                } />
            ))}
          </div>
        )}
        <div className="mb-eyebrow" style={{ margin: "16px 0 9px" }}>Queue</div>
        <Row title="Snoozed" sub={snoozed ? `${snoozed} hidden until they change` : "Nothing snoozed"}
          right={snoozed
            ? <Act small onAct={() => { restoreAll(snoozeStore); bumpSnooze(); toast("Queue restored"); }}>Restore</Act>
            : undefined} />
        <p className="text-[10.5px] mt-4 leading-relaxed" style={{ color: "var(--text3)" }}>
          The cockpit stays at the desk. This is the part of agentglass worth having in a pocket.
        </p>
      </Sheet>

      <Toasts toasts={toasts} raised={stacked} />
    </div>
  );
}

function TabBtn({ id, tab, onPick, glyph, label, badge }: {
  id: Tab; tab: Tab; onPick: (t: Tab) => void; glyph: string; label: string; badge?: number;
}) {
  const on = tab === id;
  return (
    <button onClick={() => onPick(id)} aria-current={on}
      className="flex-1 flex flex-col items-center justify-center gap-1 relative"
      style={{ minHeight: "var(--nav)", fontSize: 10.5, color: on ? "var(--primary-hover)" : "var(--text3)", background: "transparent" }}>
      <span style={{ fontSize: 17, lineHeight: 1, transform: on ? "translateY(-2px) scale(1.12)" : undefined, transition: "transform .3s cubic-bezier(.3,1.4,.5,1)" }}>{glyph}</span>
      {label}
      {on && <span style={{ position: "absolute", top: 0, width: 30, height: 2, borderRadius: "0 0 3px 3px", background: "var(--primary-hover)", boxShadow: "0 0 12px var(--primary)" }} />}
      {!!badge && (
        <span className="mb-tnum" style={{
          position: "absolute", top: 10, right: "calc(50% - 23px)", minWidth: 17, height: 17, borderRadius: 9,
          fontSize: 9.5, display: "grid", placeItems: "center", padding: "0 5px", fontWeight: 700,
          background: "var(--warning)", color: "#2a1d02", boxShadow: "0 0 0 2px color-mix(in srgb, var(--bg2) 88%, transparent)",
        }}>{badge}</span>
      )}
    </button>
  );
}

/** Naming a project is shared/projectKey.ts's job now — see baseName. This was
 *  one of three copies of it on the phone, and they did not agree. */
