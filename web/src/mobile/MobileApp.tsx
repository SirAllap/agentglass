import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.ts";
import { useStats } from "../lib/useStats.ts";
import { fmtUsd, fmtTokens } from "../lib/format.ts";
import { MobileChats } from "./MobileChats.tsx";
import { MOBILE_CSS, Sheet, Toasts, useToasts, Row, Act, useAsk } from "./mobileUi.tsx";
import { pollWhileVisible } from "../lib/poll.ts";
import { DIFF_CSS } from "./MobileDiff.tsx";
import { NOW_CSS, NowHero, NowStream, type NowAction } from "./MobileNow.tsx";
import { RepoList, RepoScreen, type RepoSummary } from "./MobileRepo.tsx";
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
 * battery decision as much as a layout one, and it is why the fleet's pulse is
 * fourteen CSS-animated bars rather than a canvas.
 */

type Tab = "now" | "chats" | "repos";

/** A gate is the only thing here that has an agent stopped dead, so it gets
 *  the fastest poll. Everything else moves on human timescales. */
const GATE_MS = 4_000;
const TREE_MS = 30_000;
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
  const [settings, setSettings] = useState(false);
  /** A conversation is open and owns the whole screen: no app header, no tabs. */
  const [immersive, setImmersive] = useState(false);
  const [dismissed, setDismissed] = useState<string[]>([]);

  // ── polling ──────────────────────────────────────────────────────────
  // Polled rather than streamed, deliberately. The live socket exists and
  // works, but a phone spends most of its life with the screen off, and a
  // socket reconnecting in the background is a worse deal than a few small
  // requests at the moment you look at it.
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
        .then((res) => res.prs.map((pr) => ({ root: r.root, repo: repoName(r), pr, scope })))
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

  useEffect(() => {
    api.prCapability().then((c) => setMe(c.login || "")).catch(() => {});
    api.gitRepos().then(({ repos: list }) => { setRepos(list); loadTrees(list); loadPrs(list); }).catch(() => {});
    loadDocker();
  }, [loadDocker, loadTrees, loadPrs]);

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

  const queue = useMemo(
    () => buildQueue({ gates, sessions, prs, containers, me, now: Date.now() })
      .filter((i) => !dismissed.includes(i.id)),
    [gates, sessions, prs, containers, me, dismissed]
  );

  const repoSummaries: RepoSummary[] = useMemo(() => repos.map((r) => {
    const t = trees[r.root];
    const name = repoName(r);
    return {
      ref: r, name,
      branch: t?.branch ?? "—",
      dirty: t?.dirty ?? 0, ahead: t?.ahead ?? 0, behind: t?.behind ?? 0,
      prs: prs.filter((p) => p.root === r.root).length,
      down: containers.filter((c) => (c.project ?? "") === name && c.state !== "running" && c.state !== "created").length,
    };
  }), [repos, trees, prs, containers]);

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
  const openContainerRepo = (c: DockerContainer) => {
    const r = repoSummaries.find((x) => x.name === (c.project ?? ""));
    if (r) setOpenRepo(r); else toast("That container is not in a repo agentglass knows", true);
  };

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
          { label: "Open chat", kind: "acc", run: () => { setTab("chats"); drop(it.id); } },
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
          { label: "Logs", run: () => openContainerRepo(o.container) },
          { label: "Restart", kind: "acc", run: () => settle(`Restarted ${o.container.name}`, () => api.dockerRestart(o.container.id)) },
        ];
    }
  };

  const openItem = (it: NowItem) => {
    const o = it.origin;
    if (o.t === "pr-red" || o.t === "pr-ready" || o.t === "pr-review") setOpenPr({ root: o.root, number: o.pr.number });
    else if (o.t === "container") openContainerRepo(o.container);
    else if (o.t === "session") setTab("chats");
  };

  const stacked = !!openRepo || !!openPr;
  const spend = stats?.totals ? fmtUsd(stats.totals.cost_usd) : "—";

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
        <span className="flex items-center gap-1.5 text-[11px]" style={{ color: reachable ? "var(--success)" : "var(--error)" }}>
          <span className="mb-dot pulse" style={{ background: "currentColor", color: "currentColor" }} />
          {reachable ? "Live" : "Offline"}
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
              // The bars breathe at rates derived from each agent's own tool
              // count, so the strip reads as several things working rather than
              // one animation looping.
              rates={live.map((s) => 1 + ((s.tool_count % 5) * 0.35))}
              spend={spend}
              repos={[...new Set(live.map((s) => (s.project_path || "").split("/").filter(Boolean).pop() || s.source_app))]}
            />
            <NowStream items={queue} actionsFor={actionsFor} onOpen={openItem} />
          </>
        )}
        {tab === "chats" && <MobileChats sessions={sessions} onRefresh={loadFast} onImmersive={setImmersive} />}
        {tab === "repos" && <RepoList repos={repoSummaries}
          onOpen={(r, siblings) => { setOpenCheckouts(siblings); setOpenRepo(r); }} />}
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
        containers={containers} stats={dstats}
        onBack={() => setOpenRepo(null)} toast={toast} onRefresh={refreshAll} />

      <MobilePr open={!!openPr} root={openPr?.root ?? ""} number={openPr?.number ?? null}
        onBack={() => { setOpenPr(null); refreshAll(); }} toast={toast} />

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

/** The last path segment is what anybody calls a repo. */
function repoName(r: GitRepoRef): string {
  return r.root.split("/").filter(Boolean).pop() || r.root;
}
