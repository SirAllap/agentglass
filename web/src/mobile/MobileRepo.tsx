import { useCallback, useEffect, useMemo, useState } from "react";
import { baseName } from "../../../shared/projectKey.ts";
import { api } from "../lib/api.ts";
import { Screen, Sheet, Seg, Empty, Row, Act, useAsk } from "./mobileUi.tsx";
import { MobileDiff, FileRow } from "./MobileDiff.tsx";
import { MobilePr } from "./MobilePr.tsx";
import { projectRows } from "./projects.ts";
import { listState, dockerState } from "./listState.ts";
import { halt, type Halt } from "./haltState.ts";
import type {
  GitRepoRef, WorkingTree, GitBranch, DockerContainer, DockerStat, PrSummary, GitFileChange,
  PrListResponse,
} from "../../../shared/types.ts";

/**
 * A repository, and the three things you can be doing to one.
 *
 * The first pass put git, docker and pull requests on the tab bar next to
 * Chats, which claimed they were four equal, independent destinations. They
 * are not: all three are facets of a repository, and a tab bar cannot say so.
 * Picking the repo once and then the facet is also fewer decisions than three
 * separate panels each asking which repo you meant.
 */

type Facet = "changes" | "prs" | "containers";

export interface RepoSummary {
  ref: GitRepoRef;
  name: string;
  branch: string;
  dirty: number;
  ahead: number;
  behind: number;
  prs: number;
  down: number;
}

export function RepoList({ repos, onOpen }: { repos: RepoSummary[]; onOpen: (r: RepoSummary, siblings: RepoSummary[]) => void }) {
  const groups = useMemo(() => projectRows(repos), [repos]);
  if (!repos.length) {
    return <Empty glyph="◇" title="No repositories yet"
      body="agentglass finds these from the projects your agents have worked in. Run one, and it appears here." />;
  }
  return (
    <div className="flex flex-col gap-2.5">
      <div className="mb-eyebrow">Repositories</div>
      {groups.map(({ main, checkouts }) => {
        // The project's state is every checkout's state: work sitting in a
        // worktree is still work you have not committed.
        const dirty = checkouts.reduce((n, c) => n + c.dirty, 0);
        const prs = checkouts.reduce((n, c) => n + c.prs, 0);
        const down = checkouts.reduce((n, c) => n + c.down, 0);
        const others = checkouts.length - 1;
        return (
          <Row key={main.ref.root}
            tint={down ? "var(--error)" : dirty || main.ahead ? "var(--warning)" : "var(--success)"}
            title={main.name}
            sub={`${main.branch}${main.ahead ? ` · ↑${main.ahead}` : ""}${main.behind ? ` ↓${main.behind}` : ""}`
              + (others ? ` · ${others} worktree${others > 1 ? "s" : ""}` : "")}
            right={[
              dirty ? `${dirty} changed` : "",
              prs ? `${prs} PR${prs > 1 ? "s" : ""}` : "",
              down ? `${down} down` : "",
            ].filter(Boolean).join(" · ") || "clean"}
            onClick={() => onOpen(main, checkouts)}
          />
        );
      })}
    </div>
  );
}

export function RepoScreen({ open, repo, checkouts = [], onPickCheckout, containers, stats, onBack, toast, onRefresh, onOpenContainer, docker, onOpenChatWith }: {
  open: boolean;
  repo: RepoSummary | null;
  /** Every checkout of this project — the repo itself and its linked
   *  worktrees. One project, several places the work can be. */
  checkouts?: RepoSummary[];
  onPickCheckout?: (r: RepoSummary) => void;
  containers: DockerContainer[];
  stats: DockerStat[];
  onBack: () => void;
  toast: (m: string, bad?: boolean) => void;
  onRefresh: () => void;
  /** Opening a container is the shell's job: it needs no repo context, and one
   *  that belongs to no project must still have a screen. */
  onOpenContainer: (c: DockerContainer) => void;
  /** Whether docker answered, and why not. */
  docker?: { available: boolean; error: string | null };
  onOpenChatWith?: (cwd: string, prompt: string) => void;
}) {
  const root = repo?.ref.root ?? "";
  const [facet, setFacet] = useState<Facet>("changes");
  const [tree, setTree] = useState<WorkingTree | null>(null);
  /**
   * The pull request list, and everything the server said about it.
   *
   * This kept `.prs` and threw the rest away, so three completely different
   * situations all rendered as "No open pull requests": `gh` missing or logged
   * out (which the response calls out as `needsAuth` — its own type says "a
   * first-class state, not an error toast"), a request that failed, and a cache
   * that had not warmed yet. The app said a calm, confident, false thing in all
   * three, and offered nothing to do about any of them.
   */
  const [prState, setPrState] = useState<PrListResponse | null>(null);
  const prs = prState?.prs ?? [];
  const [prsLoading, setPrsLoading] = useState(false);
  const prList = useMemo(
    () => listState(prsLoading && !prState ? null : prState),
    [prState, prsLoading]
  );
  const [msg, setMsg] = useState("");
  const [branches, setBranches] = useState<GitBranch[] | null>(null);
  const [openPr, setOpenPr] = useState<number | null>(null);
  const [diffAt, setDiffAt] = useState<number | null>(null);
  const [prNonce, setPrNonce] = useState(0);

  /** The project's name, which is the main checkout's — a worktree is the same
   *  project on another branch, and titling the screen with the worktree's
   *  directory name is what made them look like separate repositories. */
  const projectName = checkouts.length > 1
    ? (checkouts.find((c) => !c.ref.worktreeOf)?.name ?? repo?.name ?? "")
    : (repo?.name ?? "");

  // Already scoped by the shell, using the same rule the server uses. This
  // used to compare a compose project name to a directory basename here, which
  // is how one project's containers ended up under another's.
  const mine = containers;
  const ctrList = useMemo(() => dockerState(docker, mine.length), [docker, mine.length]);

  /**
   * What git is in the middle of, and what is in the way of finishing it.
   *
   * The tree already carried `branch.state` and this screen ignored it, so a
   * checkout stopped half-way through a rebase rendered as "Nothing to commit —
   * the working tree is clean", which is both wrong and the most confident
   * possible way to be wrong. The conflicted paths need a second request, made
   * only when there is actually something to say.
   */
  const [stopped, setStopped] = useState<Halt | null>(null);

  // Open on whatever is wrong: a container down beats uncommitted work beats
  // the pull request list. Landing on an empty tab is a wasted screen.
  useEffect(() => {
    if (!repo) return;
    setFacet(repo.down ? "containers" : repo.dirty ? "changes" : "prs");
    setTree(null); setStopped(null); setPrState(null); setMsg(""); setBranches(null);
  }, [repo]);

  const loadTree = useCallback(() => {
    if (!root) return;
    api.gitTree(root).then(async (t) => {
      setTree(t);
      const state = t.branch.state;
      const conflicts = state && state !== "clean"
        ? await api.gitConflicts(root).then((c) => c.files).catch(() => [] as string[])
        : [];
      setStopped(halt({ state, conflicts }));
    }).catch(() => { setTree(null); setStopped(null); });
  }, [root]);

  // Whenever the screen is open, not only on the Changes facet. The banner sits
  // above the tabs and has to be there whichever one you land on — a repository
  // stopped part-way through a rebase would otherwise be invisible from the
  // pull request list, which is exactly where a clean-looking checkout opens.
  useEffect(() => { if (open) loadTree(); }, [open, facet, loadTree]);
  useEffect(() => {
    if (!open || facet !== "prs" || !root) return;
    setPrsLoading(true);
    api.prList(root, "all", "open")
      .then(setPrState)
      .catch((e) => setPrState({ ok: false, repo: null, prs: [], fetchedAt: Date.now(), stale: false, loading: false, error: String(e) }))
      .finally(() => setPrsLoading(false));
  }, [open, facet, root, prNonce]);

  /**
   * A cold cache is not an empty list.
   *
   * The server answers immediately with `loading: true` and no rows while it
   * fetches behind the response, and this was a one-shot call that treated that
   * as "none" and never asked again — so opening the tab a second too early
   * meant no pull requests until you left the screen and came back.
   */
  useEffect(() => {
    if (!open || facet !== "prs" || !prState?.loading) return;
    const t = setTimeout(() => setPrNonce((n) => n + 1), 1_500);
    return () => clearTimeout(t);
  }, [open, facet, prState?.loading]);

  // The tree hands staged and unstaged back separately; the phone shows one
  // list with a switch per row, so they are merged and deduplicated here —
  // a file can be in both when only part of it is staged.
  const changed = useMemo(() => {
    const m = new Map<string, GitFileChange>();
    for (const f of tree?.unstaged ?? []) m.set(f.file_path, f);
    for (const f of tree?.staged ?? []) m.set(f.file_path, f);
    return [...m.values()].sort((a, b) => a.file_path.localeCompare(b.file_path));
  }, [tree]);
  const staged = changed.filter((f) => f.staged);
  const byPath = useMemo(() => new Map(changed.map((f) => [f.file_path, f])), [changed]);
  const paths = changed.map((f) => f.file_path);
  /** Repo-relative. The absolute prefix is the one part of a path you already
   *  know, and on a 390px row it is the part that crowds out the rest. */
  const rel = (abs: string) => (root && abs.startsWith(root) ? abs.slice(root.length).replace(/^\//, "") : abs);

  const act = async (label: string, run: () => Promise<{ ok: boolean; error?: string }>) => {
    try {
      const r = await run();
      toast(r.ok ? label : (r.error || `${label} failed`), !r.ok);
      // Reload either way. A refused action leaves the repo as it was, and the
      // switches on screen were drawn from the state before it — re-reading is
      // what stops a failure from leaving a row showing something that never
      // happened.
      loadTree();
      if (r.ok) onRefresh();
    } catch (e) { toast(String(e), true); }
  };
  const { ask, dialog: askDialog } = useAsk();

  return (
    <>
      {askDialog}
      {/* Stays open under whatever is stacked on top of it. The screens that
          cover it are drawn later in this tree, so they paint over it anyway,
          and closing it here made it push and pop history entries every time a
          file was tapped — see useBackClose. */}
      <Screen open={open} title={projectName} sub={repo?.branch} onBack={onBack}>
        {/* Which checkout of this project you are looking at. Only drawn when
            there is a choice: one repo with no worktrees needs no picker, and
            a row of one chip is furniture. */}
        {checkouts.length > 1 && (
          <div className="flex gap-1.5 overflow-x-auto pb-2.5 -mx-1 px-1" style={{ scrollbarWidth: "none" }}>
            {checkouts.map((c) => {
              const on = c.ref.root === repo?.ref.root;
              return (
                <button key={c.ref.root} onClick={() => onPickCheckout?.(c)}
                  className="rounded-lg text-[11.5px] px-3 shrink-0"
                  style={{
                    minHeight: 36,
                    color: on ? "var(--primary-hover)" : "var(--text3)",
                    background: on ? "color-mix(in srgb, var(--primary) 16%, transparent)" : "transparent",
                    border: `1px solid color-mix(in srgb, var(--border) ${on ? 55 : 26}%, transparent)`,
                  }}>
                  {c.branch}{c.dirty ? ` · ${c.dirty}` : ""}
                </button>
              );
            })}
          </div>
        )}

        {stopped && (
          <HaltBanner halt={stopped} rel={rel}
            onAbort={async () => {
              if (!(await ask({
                title: stopped.abortLabel + "?", danger: true, confirmLabel: "Abandon",
                body: stopped.state === "bisecting"
                  ? "The search ends and the tree goes back to the commit you started from."
                  : "The tree goes back to exactly how it was before this started. Anything already resolved is lost.",
              }))) return;
              await act("Abandoned — the tree is back where it was", () => api.gitMergeAbort(root));
            }}
            onContinue={() => act("Finished — the tree is clean", () => api.gitMergeContinue(root))}
            onResolve={(path, side) => act(
              `Kept ${side === "ours" ? "this branch's" : "the other side's"} version`,
              () => api.gitResolve(root, [path], side))} />
        )}

        <Seg sticky value={facet} onPick={setFacet} options={[
          { id: "changes", label: "Changes", n: repo?.dirty || null },
          { id: "prs", label: "Pull requests", n: prs.length || null },
          { id: "containers", label: "Containers", n: mine.length || null },
        ]} />

        {facet === "changes" && (
          changed.length === 0 ? (
            // "The working tree is clean" is a false sentence in the middle of
            // a rebase, and it is the confident kind of false: it is exactly
            // what someone reads to decide it is safe to walk away.
            stopped ? (
              <Empty glyph="⚠" title="Nothing to commit yet"
                body="Git is part-way through the operation above. Finish it or abandon it, and this becomes a normal working tree again." />
            ) : (
            <Empty glyph="◈" title="Nothing to commit"
              body={`The working tree is clean${repo?.ahead ? ` — but you are ${repo.ahead} commit${repo.ahead > 1 ? "s" : ""} ahead of the remote.` : " and level with the remote."}`} />
            )
          ) : (
            <>
              <div className="flex gap-2 mb-3">
                <Act small full onAct={() => act("Pulled", () => api.gitPull(root))}>↓ Pull</Act>
                <Act small full onAct={() => act("Pushed", () => api.gitPush(root))}>↑ Push{repo?.ahead ? ` ${repo.ahead}` : ""}</Act>
                <Act small full onAct={async () => {
                  const r = await api.gitBranches(root); setBranches(r.branches);
                }}>Branch ▾</Act>
              </div>

              <div className="flex items-center gap-2 mb-2.5 text-[11px]" style={{ color: "var(--text3)" }}>
                <span className="mb-tnum">{staged.length} of {changed.length} staged</span>
                <span className="flex-1" />
                <Act small onAct={() => staged.length === changed.length
                  ? act("Unstaged everything", () => api.gitUnstageAll(root))
                  : act("Staged everything", () => api.gitStageAll(root))}>
                  {staged.length === changed.length ? "Unstage all" : "Stage all"}
                </Act>
              </div>

              <div className="flex flex-col gap-2.5 mb-3">
                {changed.map((f, i) => (
                  <FileRow key={f.file_path} path={rel(f.file_path)} add={f.additions} del={f.deletions}
                    note={f.status} on={f.staged} switchLabel={`Stage ${f.file_path}`}
                    onToggle={() => act(f.staged ? "Unstaged" : "Staged",
                      () => f.staged ? api.gitUnstage(root, [f.file_path]) : api.gitStage(root, [f.file_path]))}
                    onOpen={() => setDiffAt(i)} />
                ))}
              </div>

              <div className="mb-card overflow-hidden">
                <textarea value={msg} onChange={(e) => setMsg(e.target.value)}
                  placeholder="What changed, and why…"
                  className="w-full p-3 text-[13px] resize-none bg-transparent outline-none"
                  style={{ minHeight: 78, color: "var(--text)", lineHeight: 1.55 }} />
                <div className="flex gap-2 items-center px-3 py-2.5"
                  style={{ borderTop: "1px solid color-mix(in srgb, var(--border) 25%, transparent)", background: "color-mix(in srgb, var(--bg3) 34%, transparent)" }}>
                  <span className="text-[10.5px]" style={{ color: "var(--text3)" }}>
                    {staged.length ? `${staged.length} file${staged.length > 1 ? "s" : ""} staged` : "Nothing staged"}
                  </span>
                  <span className="flex-1" />
                  <Act small disabled={!staged.length || !msg.trim()}
                    title={!staged.length ? "Stage something first" : !msg.trim() ? "Say what changed" : undefined}
                    onAct={async () => { await act("Committed", () => api.gitCommitStaged(root, msg.trim(), "")); setMsg(""); }}>
                    Commit
                  </Act>
                  <Act small kind="acc" disabled={!staged.length || !msg.trim()}
                    title={!staged.length ? "Stage something first" : !msg.trim() ? "Say what changed" : undefined}
                    onAct={async () => {
                      const c = await api.gitCommitStaged(root, msg.trim(), "");
                      if (!c.ok) { toast(c.error || "Commit failed", true); return; }
                      setMsg("");
                      await act("Committed and pushed", () => api.gitPush(root));
                    }}>
                    Commit &amp; push
                  </Act>
                </div>
              </div>
            </>
          )
        )}

        {facet === "prs" && (
          // Four different answers, and only one of them is "there are none".
          // Which one is a decision about data, so listState() makes it.
          prList.kind === "needs-auth"
            ? <Empty glyph="⑂" title="GitHub is not signed in"
                body={`agentglass reads pull requests through the gh CLI, and it is missing or logged out on this machine. Run \`gh auth login\` there and this fills in — it is not that ${repo?.name} has none.`} />
          : prList.kind === "error"
            ? <Empty glyph="⑂" title="Could not read pull requests" body={prList.message} />
          : prList.kind === "loading"
            ? <div className="text-[11.5px] p-3" style={{ color: "var(--text3)" }}>Reading pull requests from GitHub…</div>
          : prList.kind === "empty"
            ? <Empty glyph="⑂" title="No open pull requests" body={`Nothing is waiting to land on ${repo?.name}.`} />
          : (
            <div className="flex flex-col gap-2.5">
              {prs.map((p) => (
                <Row key={p.number}
                  tint={!p.checksLoaded ? "var(--text3)" : p.checks.failure ? "var(--error)" : p.checks.pending ? "var(--warning)" : "var(--success)"}
                  title={`#${p.number} ${p.title}`}
                  sub={`${p.author} · ${!p.checksLoaded ? "checks…" : p.checks.failure ? `${p.checks.failure} failing` : p.checks.pending ? `${p.checks.pending} running` : "green"}${p.isDraft ? " · draft" : ""}`}
                  right={`+${p.additions} −${p.deletions}`}
                  onClick={() => setOpenPr(p.number)} />
              ))}
              {/* Only the first page arrived. Saying so beats a list that looks
                  complete and is not. */}
              {prList.kind === "rows" && prList.truncated && (
                <div className="text-[10.5px] px-1 pt-1" style={{ color: "var(--text3)" }}>
                  Showing {prs.length}{prState?.total ? ` of ${prState.total}` : ""} — open the repository on the desktop for the rest.
                </div>
              )}
            </div>
          )
        )}

        {facet === "containers" && (
          ctrList.kind === "unavailable"
            ? <Empty glyph="▣" title="Docker is not answering" body={ctrList.message} />
          : ctrList.kind === "empty"
            ? <Empty glyph="▣" title="No containers" body={`Nothing from ${repo?.name} is running under Docker.`} />
            : (
              <div className="flex flex-col gap-2.5">
                {mine.map((c) => {
                  const st = stats.find((s) => s.id === c.id);
                  const up = c.state === "running";
                  return (
                    <Row key={c.id} pulse={up}
                      tint={up ? "var(--success)" : c.state === "restarting" ? "var(--warning)" : "var(--text3)"}
                      title={c.service || c.name}
                      sub={`${c.status}${c.ports ? " · " + c.ports : ""}`}
                      right={up && st ? `${Math.round(st.cpu)}% cpu` : c.state}
                      onClick={() => onOpenContainer(c)} />
                  );
                })}
              </div>
            )
        )}
      </Screen>

      <MobileDiff
        open={diffAt != null} files={paths.map(rel)} index={diffAt ?? 0} onIndex={setDiffAt}
        file={diffAt != null ? byPath.get(paths[diffAt] ?? "") : undefined}
        onBack={() => setDiffAt(null)}
        extra={diffAt != null && (
          <>
            <Act small onAct={() => act("Staged", () => api.gitStage(root, [paths[diffAt]!]))}>Stage this file</Act>
            <Act small kind="dang" onAct={async () => {
              if (!(await ask({
                title: `Discard ${rel(paths[diffAt]!)}?`, danger: true, confirmLabel: "Discard",
                body: "Every change in this file goes back to HEAD. There is no undo, and it is not in git anywhere.",
              }))) return;
              await act("Discarded — back to HEAD", () => api.gitDiscard(root, [paths[diffAt]!]));
            }}>Discard</Act>
          </>
        )}
      />

      <MobilePr open={openPr != null} root={root} number={openPr} onBack={() => setOpenPr(null)}
        toast={toast} onOpenChatWith={onOpenChatWith} />

      <Sheet open={!!branches} title="Switch branch" sub="Uncommitted changes come with you."
        onClose={() => setBranches(null)}>
        <div className="flex flex-col gap-2.5">
          {(branches ?? []).slice(0, 30).map((b) => (
            <Row key={b.name} tint={b.current ? "var(--success)" : "var(--text3)"}
              title={b.name} sub={b.upstream ?? "no upstream"}
              right={b.current ? "here" : undefined}
              onClick={b.current ? undefined : async () => {
                const r = await api.gitCheckout(root, b.name);
                toast(r.ok ? `Switched to ${b.name}` : (r.error || "Could not switch"), !r.ok);
                setBranches(null);
                if (r.ok) { loadTree(); onRefresh(); }
              }} />
          ))}
        </div>
      </Sheet>
    </>
  );
}

/** One container: how hard it is working, what it has been saying, and the two
 *  or three things you would actually do to it from a phone. */
export function ContainerScreen({ open, c, stat, project, onBack, toast, onRefresh }: {
  open: boolean; c: DockerContainer | null; stat?: DockerStat;
  /** The checkout this container belongs to, or null when agentglass cannot
   *  place it — which it says rather than guessing. */
  project?: string | null;
  onBack: () => void; toast: (m: string, bad?: boolean) => void; onRefresh: () => void;
}) {
  const [logs, setLogs] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !c) return;
    setLoading(true);
    api.dockerLogs(c.id, 300)
      .then((r) => setLogs(r.ok ? r.text : (r.error || "No logs")))
      .catch((e) => setLogs(String(e)))
      .finally(() => setLoading(false));
  }, [open, c]);

  const run = async (label: string, fn: () => Promise<{ ok: boolean; error?: string }>) => {
    const r = await fn();
    toast(r.ok ? label : (r.error || `${label} failed`), !r.ok);
    if (r.ok) onRefresh();
  };
  const up = c?.state === "running";
  const { ask, dialog: askDialog } = useAsk();

  return (
    <>
      {askDialog}
    {/* The subtitle names the project, because a container screen you reached
        from a queue card gives you no other way to know which one it is — and
        when agentglass cannot place it, it says so rather than leaving the
        question open. */}
    <Screen open={open} title={c?.name ?? ""}
      sub={c ? `${project ? baseName(project) : "no project"} · ${c.image} · ${c.status}` : undefined}
      onBack={onBack}
      foot={c ? (up ? (
        <>
          <Act small full onAct={() => run(`Restarted ${c.name}`, () => api.dockerRestart(c.id))}>Restart</Act>
          <Act small full kind="dang" onAct={() => run(`Stopped ${c.name}`, () => api.dockerStop(c.id))}>Stop</Act>
        </>
      ) : (
        <>
          <Act small full kind="ok" onAct={() => run(`Started ${c.name}`, () => api.dockerStart(c.id))}>Start</Act>
          <Act small full kind="dang" onAct={async () => {
            if (!(await ask({
              title: `Remove ${c.name}?`, danger: true, confirmLabel: "Remove",
              body: "The container and anything written inside it that is not on a volume are gone.",
            }))) return;
            await run(`Removed ${c.name}`, () => api.dockerRm(c.id));
          }}>Remove</Act>
        </>
      )) : undefined}>
      <div className="grid grid-cols-2 gap-2.5 mb-3">
        <div className="mb-card px-3.5 py-3">
          <div className="mb-eyebrow">CPU</div>
          <div className="mb-fig" style={{ fontSize: 26 }}>{stat ? Math.round(stat.cpu) : "—"}<span style={{ fontSize: 14, color: "var(--text3)" }}>%</span></div>
        </div>
        <div className="mb-card px-3.5 py-3">
          <div className="mb-eyebrow">Memory</div>
          <div className="mb-fig" style={{ fontSize: 26 }}>{stat ? Math.round(stat.mem) : "—"}<span style={{ fontSize: 14, color: "var(--text3)" }}>%</span></div>
          {stat && <div className="text-[10px] mt-1" style={{ color: "var(--text3)" }}>{stat.memUsage}</div>}
        </div>
      </div>
      <div className="mb-eyebrow mb-2">Logs · last 300 lines</div>
      <pre className="mb-card p-3 text-[11px] leading-relaxed overflow-x-auto whitespace-pre-wrap break-words"
        style={{ maxHeight: "44vh", overflowY: "auto", background: "color-mix(in srgb, #000 44%, transparent)", color: "var(--text3)" }}>
        {loading ? "Reading the log…" : logs || "Nothing logged."}
      </pre>
    </Screen>
    </>
  );
}

/**
 * A repository git stopped half-way through, and the two ways out.
 *
 * Loud on purpose. This is not a status line: nothing in this checkout moves
 * again — not a commit, not a branch switch, not an agent working in it — until
 * somebody finishes or abandons, and the screen said "the working tree is
 * clean" instead.
 *
 * Conflicts are listed with the two resolutions that need no editor and cover
 * most of them: a lockfile, a generated migration, a file the other side
 * deleted. Anything needing real judgement is a job for the desk, and saying so
 * is better than a text box in a card.
 */
function HaltBanner({ halt: h, rel, onAbort, onContinue, onResolve }: {
  halt: Halt;
  rel: (abs: string) => string;
  onAbort: () => void;
  onContinue: () => void;
  onResolve: (path: string, side: "ours" | "theirs") => void;
}) {
  return (
    <div className="mb-halt">
      <div className="hh">
        <b>{h.title}</b>
        <span>{h.sub}</span>
      </div>
      {h.conflicts.length > 0 && (
        <div className="hc">
          {h.conflicts.map((p) => (
            <div className="cr" key={p}>
              <span className="p" title={rel(p)}>{rel(p)}</span>
              <Act small onAct={() => onResolve(p, "ours")}>Keep ours</Act>
              <Act small onAct={() => onResolve(p, "theirs")}>Keep theirs</Act>
            </div>
          ))}
        </div>
      )}
      <div className="ha">
        <Act small full kind="no" onAct={onAbort}>{h.abortLabel}</Act>
        {h.continueLabel && (
          <Act small full kind="ok" disabled={!h.canContinue}
            title={h.canContinue ? undefined : "Resolve everything above first"}
            onAct={onContinue}>{h.continueLabel}</Act>
        )}
      </div>
    </div>
  );
}

export const HALT_CSS = `
.mb-halt{border-radius:16px;margin-bottom:13px;overflow:hidden;
  background:color-mix(in srgb,var(--warning) 11%,var(--bg2));
  border:1px solid color-mix(in srgb,var(--warning) 46%,transparent);
  box-shadow:var(--mb-edge),0 12px 30px -18px color-mix(in srgb,var(--warning) 55%,#000)}
.mb-halt .hh{padding:13px 15px 0}
.mb-halt .hh b{display:block;font-size:13.5px;color:var(--warning);font-weight:650}
.mb-halt .hh span{display:block;font-size:11.5px;color:var(--text3);margin-top:3px}
.mb-halt .hc{margin:11px 15px 0;padding-top:9px;display:flex;flex-direction:column;gap:7px;
  border-top:1px solid color-mix(in srgb,var(--border) 40%,transparent)}
.mb-halt .cr{display:flex;align-items:center;gap:7px;min-width:0}
/* The path shrinks and the two verbs do not: a long path must not push
   "Keep theirs" off the right edge, which is where it ends up when every child
   of a flex row is allowed to size itself. */
.mb-halt .cr .p{flex:1;min-width:0;font-size:11px;color:var(--text2);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:ltr}
.mb-halt .cr .mb-btn{flex:none}
.mb-halt .ha{display:flex;gap:9px;padding:13px 15px 14px}
`;
