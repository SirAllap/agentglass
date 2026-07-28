import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.ts";
import { useLive } from "../lib/useLive.ts";
import { subscribeGitChanged } from "../lib/gitBus.ts";
import { subscribeSessionChanged } from "../lib/sessionBus.ts";
import { useStats } from "../lib/useStats.ts";
import { fmtUsd, fmtTokens } from "../lib/format.ts";
import { MobileChats, type OpenChat, type Compose } from "./MobileChats.tsx";
import { MOBILE_CSS, Sheet, Toasts, useToasts, Row, Act, useAsk } from "./mobileUi.tsx";
import { pollWhileVisible } from "../lib/poll.ts";
import { DIFF_CSS } from "./MobileDiff.tsx";
import { NOW_CSS, NowHero, NowStream, type NowAction, type LiveCall } from "./MobileNow.tsx";
import { RepoList, RepoScreen, ContainerScreen, type RepoSummary } from "./MobileRepo.tsx";
import { projectRows } from "./projects.ts";
import { baseName, ownerOf } from "../../../shared/projectKey.ts";
import { MobilePr } from "./MobilePr.tsx";
import { buildQueue, type NowItem } from "./nowQueue.ts";
import type {
  PendingGate, SessionRollup, DockerContainer, DockerStat, PrSummary, GitRepoRef,
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

type Tab = "now" | "chats" | "repos";

/** Live on the socket · reachable but not streaming · nothing answering. */
type LinkState = "live" | "slow" | "offline";
const LINK_WORD: Record<LinkState, string> = { live: "Live", slow: "Catching up", offline: "Offline" };
const LINK_TONE: Record<LinkState, string> = {
  live: "var(--success)", slow: "var(--warning)", offline: "var(--error)",
};

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

export function MobileApp() {
  const [tab, setTab] = useState<Tab>("now");
  const { toasts, toast } = useToasts();
  const { ask, dialog: askDialog } = useAsk();
  const { stats } = useStats(86_400_000);

  const [gates, setGates] = useState<PendingGate[]>([]);
  const [sessions, setSessions] = useState<SessionRollup[]>([]);
  const [reachable, setReachable] = useState(true);
  const [repos, setRepos] = useState<GitRepoRef[]>([]);
  const [trees, setTrees] = useState<Record<string, { branch: string; dirty: number; ahead: number; behind: number }>>({});
  const [containers, setContainers] = useState<DockerContainer[]>([]);
  const [dstats, setDstats] = useState<DockerStat[]>([]);
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
  /** A conversation is open and owns the whole screen: no app header, no tabs. */
  const [immersive, setImmersive] = useState(false);
  const [dismissed, setDismissed] = useState<string[]>([]);

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
    api.sessions(40).then(setSessions).catch(() => { /* the gate poll reports reachability */ });
  }, []);

  const loadDocker = useCallback(() => {
    api.dockerOverview().then((o) => setContainers(o.available ? o.containers : [])).catch(() => setContainers([]));
    api.dockerStats().then((r) => setDstats(r.stats)).catch(() => setDstats([]));
  }, []);

  const loadTrees = useCallback((list: GitRepoRef[]) => {
    for (const r of list) {
      api.gitTree(r.root).then((t) => setTrees((cur) => ({
        ...cur,
        [r.root]: {
          branch: t.branch.name,
          // A file part-staged appears in both lists; counting it twice would
          // report more work outstanding than there is.
          dirty: new Set([...t.staged, ...t.unstaged].map((f) => f.file_path)).size,
          ahead: t.branch.ahead, behind: t.branch.behind,
        },
      }))).catch(() => { /* a repo that will not open is not worth a toast on a poll */ });
    }
  }, []);

  const loadPrs = useCallback((list: GitRepoRef[]) => {
    Promise.all(list.flatMap((r) => (["mine", "review"] as const).map((scope) =>
      api.prList(r.root, scope, "open")
        .then((res) => res.prs.map((pr) => ({ root: r.root, repo: baseName(r.root), pr, scope })))
        .catch(() => [] as { root: string; repo: string; pr: PrSummary; scope: "mine" | "review" }[])
    ))).then((groups) => setPrs(groups.flat()));
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

  const queue = useMemo(
    () => buildQueue({ gates, sessions, prs, containers, me, now: Date.now() })
      .filter((i) => !dismissed.includes(i.id)),
    [gates, sessions, prs, containers, me, dismissed]
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
  const drop = (id: string) => setDismissed((d) => [...d, id]);

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
          { label: "Later", run: () => { drop(it.id); toast("Snoozed"); } },
        ];
      case "pr-red":
        return [
          { label: "See the log", run: () => setOpenPr({ root: o.root, number: o.pr.number }) },
          { label: "Re-run", kind: "acc", run: () => settle("Re-running the failed checks", () => api.prRerun(o.root, o.pr.number)) },
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
        return [{ label: "Review", kind: "acc", run: () => setOpenPr({ root: o.root, number: o.pr.number }) }];
      case "container":
        return [
          { label: "Logs", run: () => openContainer(o.container) },
          { label: "Restart", kind: "acc", run: () => settle(`Restarted ${o.container.name}`, () => api.dockerRestart(o.container.id)) },
        ];
    }
  };

  const openItem = (it: NowItem) => {
    const o = it.origin;
    if (o.t === "pr-red" || o.t === "pr-ready" || o.t === "pr-review") setOpenPr({ root: o.root, number: o.pr.number });
    else if (o.t === "container") openContainer(o.container);
    else if (o.t === "session") openSession(o.session);
  };

  const stacked = !!openRepo || !!openPr;
  const spend = stats?.totals ? fmtUsd(stats.totals.cost_usd) : "—";

  /**
   * One word for the state of the link, and it distinguishes the three cases a
   * single boolean could not: the socket is carrying data, the socket is gone
   * but the server still answers (so nothing is lost, only late), and nothing
   * is reachable at all.
   */
  const link: LinkState = conn === "open" ? "live" : reachable ? "slow" : "offline";

  return (
    <div className="mb min-h-[100dvh] flex flex-col" style={{ background: "var(--bg)", color: "var(--text)" }}>
      <style>{MOBILE_CSS}{DIFF_CSS}{NOW_CSS}</style>
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
      </nav>}

      <RepoScreen open={!!openRepo && !openPr} repo={openRepo}
        checkouts={openCheckouts} onPickCheckout={setOpenRepo}
        containers={containers.filter((c) => ownerByContainer.get(c.id) === openRepo?.ref.root)} stats={dstats}
        onOpenContainer={openContainer}
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
        <div className="mb-eyebrow" style={{ margin: "16px 0 9px" }}>Queue</div>
        <Row title="Snoozed" sub={dismissed.length ? `${dismissed.length} hidden until they change` : "Nothing snoozed"}
          right={dismissed.length
            ? <Act small onAct={() => { setDismissed([]); toast("Queue restored"); }}>Restore</Act>
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
