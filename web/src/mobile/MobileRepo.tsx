import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.ts";
import { Screen, Sheet, Seg, Empty, Row, Act, useConfirm } from "./mobileUi.tsx";
import { MobileDiff, FileRow } from "./MobileDiff.tsx";
import { MobilePr } from "./MobilePr.tsx";
import type {
  GitRepoRef, WorkingTree, GitBranch, DockerContainer, DockerStat, PrSummary, GitFileChange,
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

export function RepoList({ repos, onOpen }: { repos: RepoSummary[]; onOpen: (r: RepoSummary) => void }) {
  if (!repos.length) {
    return <Empty glyph="◇" title="No repositories yet"
      body="agentglass finds these from the projects your agents have worked in. Run one, and it appears here." />;
  }
  return (
    <div className="flex flex-col gap-2.5">
      <div className="mb-eyebrow">Repositories</div>
      {repos.map((r) => (
        <Row key={r.ref.root}
          tint={r.down ? "var(--error)" : r.dirty || r.ahead ? "var(--warning)" : "var(--success)"}
          title={r.name}
          sub={`${r.branch}${r.ahead ? ` · ↑${r.ahead}` : ""}${r.behind ? ` ↓${r.behind}` : ""}`}
          right={[
            r.dirty ? `${r.dirty} changed` : "",
            r.prs ? `${r.prs} PR${r.prs > 1 ? "s" : ""}` : "",
            r.down ? `${r.down} down` : "",
          ].filter(Boolean).join(" · ") || "clean"}
          onClick={() => onOpen(r)}
        />
      ))}
    </div>
  );
}

export function RepoScreen({ open, repo, containers, stats, onBack, toast, onRefresh, onOpenChatWith }: {
  open: boolean;
  repo: RepoSummary | null;
  containers: DockerContainer[];
  stats: DockerStat[];
  onBack: () => void;
  toast: (m: string, bad?: boolean) => void;
  onRefresh: () => void;
  onOpenChatWith?: (cwd: string, prompt: string) => void;
}) {
  const root = repo?.ref.root ?? "";
  const [facet, setFacet] = useState<Facet>("changes");
  const [tree, setTree] = useState<WorkingTree | null>(null);
  const [prs, setPrs] = useState<PrSummary[]>([]);
  const [prsLoading, setPrsLoading] = useState(false);
  const [msg, setMsg] = useState("");
  const [branches, setBranches] = useState<GitBranch[] | null>(null);
  const [openPr, setOpenPr] = useState<number | null>(null);
  const [ctr, setCtr] = useState<DockerContainer | null>(null);
  const [diffAt, setDiffAt] = useState<number | null>(null);

  const mine = useMemo(() => containers.filter((c) => (c.project ?? "") === repo?.name), [containers, repo]);

  // Open on whatever is wrong: a container down beats uncommitted work beats
  // the pull request list. Landing on an empty tab is a wasted screen.
  useEffect(() => {
    if (!repo) return;
    setFacet(repo.down ? "containers" : repo.dirty ? "changes" : "prs");
    setTree(null); setPrs([]); setMsg(""); setBranches(null);
  }, [repo]);

  const loadTree = useCallback(() => {
    if (!root) return;
    api.gitTree(root).then(setTree).catch(() => setTree(null));
  }, [root]);

  useEffect(() => { if (open && facet === "changes") loadTree(); }, [open, facet, loadTree]);
  useEffect(() => {
    if (!open || facet !== "prs" || !root) return;
    setPrsLoading(true);
    api.prList(root, "all", "open").then((r) => setPrs(r.prs)).catch(() => setPrs([]))
      .finally(() => setPrsLoading(false));
  }, [open, facet, root]);

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
      if (r.ok) { loadTree(); onRefresh(); }
    } catch (e) { toast(String(e), true); }
  };
  const { confirm, sheet: confirmSheet } = useConfirm();

  return (
    <>
      {confirmSheet}
      <Screen open={open && !openPr && !ctr && diffAt == null} title={repo?.name ?? ""} sub={repo?.branch} onBack={onBack}>
        <Seg sticky value={facet} onPick={setFacet} options={[
          { id: "changes", label: "Changes", n: repo?.dirty || null },
          { id: "prs", label: "Pull requests", n: prs.length || null },
          { id: "containers", label: "Containers", n: mine.length || null },
        ]} />

        {facet === "changes" && (
          changed.length === 0 ? (
            <Empty glyph="◈" title="Nothing to commit"
              body={`The working tree is clean${repo?.ahead ? ` — but you are ${repo.ahead} commit${repo.ahead > 1 ? "s" : ""} ahead of the remote.` : " and level with the remote."}`} />
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
          prsLoading && !prs.length ? <div className="text-[11.5px] p-3" style={{ color: "var(--text3)" }}>Loading pull requests…</div>
          : prs.length === 0 ? <Empty glyph="⑂" title="No open pull requests" body={`Nothing is waiting to land on ${repo?.name}.`} />
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
            </div>
          )
        )}

        {facet === "containers" && (
          mine.length === 0
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
                      onClick={() => setCtr(c)} />
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
            <Act small kind="dang" onAct={() => confirm({
              verb: "Discard", subject: rel(paths[diffAt]!),
              warn: "Every change in this file goes back to HEAD. There is no undo, and it is not in git anywhere.",
              run: () => act("Discarded — back to HEAD", () => api.gitDiscard(root, [paths[diffAt]!])),
            })}>Discard</Act>
          </>
        )}
      />

      <MobilePr open={openPr != null} root={root} number={openPr} onBack={() => setOpenPr(null)}
        toast={toast} onOpenChatWith={onOpenChatWith} />

      <ContainerScreen open={!!ctr} c={ctr} stat={stats.find((s) => s.id === ctr?.id)}
        onBack={() => setCtr(null)} toast={toast} onRefresh={onRefresh} />

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
function ContainerScreen({ open, c, stat, onBack, toast, onRefresh }: {
  open: boolean; c: DockerContainer | null; stat?: DockerStat;
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
  const { confirm, sheet: confirmSheet } = useConfirm();

  return (
    <>
      {confirmSheet}
    <Screen open={open} title={c?.name ?? ""} sub={c ? `${c.image} · ${c.status}` : undefined} onBack={onBack}
      foot={c ? (up ? (
        <>
          <Act small full onAct={() => run(`Restarted ${c.name}`, () => api.dockerRestart(c.id))}>Restart</Act>
          <Act small full kind="dang" onAct={() => run(`Stopped ${c.name}`, () => api.dockerStop(c.id))}>Stop</Act>
        </>
      ) : (
        <>
          <Act small full kind="ok" onAct={() => run(`Started ${c.name}`, () => api.dockerStart(c.id))}>Start</Act>
          <Act small full kind="dang" onAct={() => confirm({
            verb: "Remove", subject: c.name,
            warn: "The container and anything written inside it that is not on a volume are gone.",
            run: () => run(`Removed ${c.name}`, () => api.dockerRm(c.id)),
          })}>Remove</Act>
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
