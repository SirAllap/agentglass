// GitHub issues, and somewhere to work on one.
//
// The list and the detail are the pull-request panel with a different query
// behind them, which is why this is short. What is new is the button: an issue
// here is not something to read, it is something to start — and, just as
// importantly, something to FINISH.
//
// Starting cuts a worktree named after the issue and puts an agent in a tmux
// window in it, which is the gesture this app's own review flow already uses.
// Finishing removes the worktree, deletes the branch and kills the window. The
// second half is the half nobody builds, and it is the reason a machine ends up
// with fourteen checkouts nobody can name.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import type { GitRepoRef, IssueDetail, IssueRow, IssueWork, StartMode } from "../../../shared/types.ts";
import { ViewHeader } from "./workspace/ViewHeader.tsx";
import { useDismiss } from "../lib/useDismiss.ts";
import { Markdown } from "../lib/markdown.tsx";
import { fmtAgo } from "../lib/format.ts";
import { requestTermIssue } from "../lib/termIssue.ts";

const edge = (pct: number) => `1px solid color-mix(in srgb, var(--text) ${pct}%, transparent)`;

/**
 * What the button can do, in the order somebody would reach for them.
 *
 * The first is the default and the one on the button; the rest live behind the
 * chevron. Every one of them is a gesture people already do by hand — the point
 * is that it takes one press and that the app then knows it happened, which is
 * what makes putting it away possible.
 */
const MODES: { id: StartMode; label: string; hint: string }[] = [
  { id: "claude", label: "Worktree + Claude", hint: "Cuts the worktree and opens a tmux window with Claude in it, the prompt written and not sent" },
  { id: "shell", label: "Worktree + shell", hint: "The same worktree and window, with your shell instead of an agent" },
  { id: "worktree", label: "Just the worktree", hint: "Cuts it and points the app at it. Nothing is opened" },
  { id: "plan", label: "Plan it first", hint: "A read-only pass over the issue. The worktree is cut anyway, so the plan has somewhere to land" },
  { id: "branch", label: "Branch here", hint: "No worktree — switches this checkout to a new branch. Refused if it is dirty" },
];

export function IssuesView({ active }: { active: boolean }) {
  const [repos, setRepos] = useState<GitRepoRef[]>([]);
  const [root, setRoot] = useState("");
  const [repoOpen, setRepoOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  useDismiss(repoOpen, pickerRef, () => setRepoOpen(false));
  const repo = repos.find((r) => r.root === root) ?? null;

  useEffect(() => {
    if (!active) return;
    api.gitRepos().then(({ repos: r }) => {
      setRepos(r);
      setRoot((cur) => (cur && r.some((x) => x.root === cur) ? cur : (r[0]?.root ?? "")));
    }).catch(() => {});
  }, [active]);

  return (
    <div className="flex flex-col h-full min-h-0">
      <ViewHeader title="Issues">
        <div className="relative" ref={pickerRef}>
          <button onClick={() => setRepoOpen((o) => !o)}
            className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-lg max-w-[280px] whitespace-nowrap"
            style={{ background: "color-mix(in srgb, var(--bg3) 50%, transparent)", border: edge(20), color: "var(--text)" }}
            title={repo?.root}>
            <span className="font-medium truncate">{repo ? (repo.worktreeOf ? repo.branch : repo.name) : "Pick a repo"}</span>
            <span style={{ color: "var(--text3)" }}>▾</span>
          </button>
          {repoOpen && (
            <div className="absolute left-0 mt-1 rounded-lg text-[11px] shadow-2xl flex flex-col"
              style={{ zIndex: 30, background: "var(--bg2)", border: edge(30), minWidth: 320, maxHeight: 420, overflow: "auto" }}>
              {repos.map((r) => (
                <button key={r.root} onClick={() => { setRoot(r.root); setRepoOpen(false); }}
                  className="w-full text-left px-2.5 py-1.5 flex items-center gap-2 hover:bg-white/5"
                  style={{ background: r.root === root ? "color-mix(in srgb, var(--primary) 15%, transparent)" : "transparent" }}>
                  <span className="truncate flex-1" style={{ color: "var(--text)" }}>{r.worktreeOf ? r.branch : r.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </ViewHeader>
      {root ? <IssuesBody key={root} root={root} active={active} /> : (
        <div className="p-5 text-[11.5px]" style={{ color: "var(--text3)" }}>No repository to read issues from.</div>
      )}
    </div>
  );
}

function IssuesBody({ root, active }: { root: string; active: boolean }) {
  const [state, setState] = useState<"open" | "closed" | "all">("open");
  const [mine, setMine] = useState(false);
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<IssueRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [work, setWork] = useState<IssueWork[]>([]);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(() => {
    api.issuesList(root, state, q.trim(), mine ? "@me" : "")
      .then((r) => { if (r.ok) { setRows(r.issues); setError(null); } else setError(r.error ?? "could not list issues"); })
      .catch((e) => setError(String(e)));
    api.issuesWork().then((r) => setWork(r.work)).catch(() => {});
  }, [root, state, q, mine]);

  useEffect(() => {
    if (!active) return;
    load();
    // Slow: an issue list is not a live feed, and every poll is a `gh` spawn.
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [active, load]);

  const workFor = useMemo(() => new Map(work.map((w) => [w.number, w])), [work]);
  const say = (ok: boolean, text: string) => { setNote({ ok, text }); setTimeout(() => setNote(null), 6000); };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex items-center gap-2 px-4 py-2 shrink-0" style={{ borderBottom: edge(12) }}>
        <span className="inline-flex rounded-md overflow-hidden" style={{ border: edge(20) }}>
          {(["open", "closed", "all"] as const).map((s) => (
            <button key={s} onClick={() => setState(s)} className="text-[10.5px] px-2.5 py-1 capitalize"
              style={s === state
                ? { background: "color-mix(in srgb, var(--primary) 20%, transparent)", color: "var(--text)" }
                : { color: "var(--text3)" }}>{s}</button>
          ))}
        </span>
        <button onClick={() => setMine((m) => !m)} className="text-[10.5px] px-2.5 py-1 rounded-md"
          style={mine
            ? { color: "var(--primary)", border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)", background: "color-mix(in srgb, var(--primary) 12%, transparent)" }
            : { color: "var(--text3)", border: edge(20) }}>Assigned to me</button>
        <span className="flex items-center gap-1.5 flex-1 min-w-0 px-2 py-1 rounded-md" style={{ background: "var(--bg)", border: edge(20) }}>
          <span style={{ color: "var(--text3)" }}>⌕</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") load(); }}
            placeholder="Search issues — press ↵" spellCheck={false}
            className="flex-1 min-w-0 bg-transparent outline-none text-[11px]" style={{ color: "var(--text)" }} />
        </span>
        <button onClick={load} title="Refresh" className="agx-btn text-[11px] px-2 py-1 rounded"
          style={{ color: "var(--text2)", border: edge(20) }}>⟳</button>
      </div>

      {note && (
        <div className="px-4 py-1.5 text-[10.5px] shrink-0"
          style={{ color: note.ok ? "var(--success)" : "var(--error)", background: `color-mix(in srgb, ${note.ok ? "var(--success)" : "var(--error)"} 10%, transparent)` }}>
          {note.text}
        </div>
      )}

      <div className="flex-1 min-h-0 flex">
        <div className="flex flex-col min-w-0" style={{ width: "48%", borderRight: edge(12) }}>
          {error && <div className="p-4 text-[11.5px]" style={{ color: "var(--error)" }}>{error}</div>}
          {!rows && !error && <div className="p-4 text-[11.5px]" style={{ color: "var(--text3)" }}>Asking GitHub…</div>}
          {rows?.length === 0 && <div className="p-4 text-[11.5px]" style={{ color: "var(--text3)" }}>Nothing matches.</div>}
          <div className="flex-1 min-h-0 overflow-y-auto agx-scroll">
            {rows?.map((i) => (
              <Row key={i.number} i={i} on={sel === i.number} work={workFor.get(i.number)}
                onPick={() => setSel(i.number)}
                onStart={(mode) => void start(root, i.number, mode, say, load)} />
            ))}
          </div>
        </div>
        <div className="flex-1 min-w-0">
          {sel == null
            ? <div className="p-5 text-[11.5px]" style={{ color: "var(--text3)" }}>Pick an issue.</div>
            : <Detail root={root} number={sel} onSay={say} onChanged={load} />}
        </div>
      </div>
    </div>
  );
}

/**
 * Start work, and put whatever it produced where it belongs.
 *
 * The server cuts the worktree and hands back a path and a prompt; the tmux
 * window is asked for through the terminal socket, exactly as a pull-request
 * review is. Two components that can both spawn windows is two components that
 * disagree about which session is yours.
 */
async function start(root: string, number: number, mode: StartMode, say: (ok: boolean, t: string) => void, reload: () => void) {
  const r = await api.issueStart(root, number, mode);
  if (!r.ok || !r.work) { say(false, r.error ?? "could not start"); return; }
  if ((mode === "claude" || mode === "shell" || mode === "plan") && r.cwd) {
    // A shell opens with nothing in it; the other two carry the prompt the
    // server wrote.
    requestTermIssue(r.cwd, `i${number}`, mode === "shell" ? "" : (r.prompt ?? ""), mode !== "shell");
    say(true, `${r.work.branch} — opening a tmux window`);
  } else {
    say(true, `${r.work.branch} at ${r.work.path}`);
  }
  reload();
}

function Row({ i, on, work, onPick, onStart }: {
  i: IssueRow; on: boolean; work?: IssueWork; onPick: () => void; onStart: (m: StartMode) => void;
}) {
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(menu, ref, () => setMenu(false));
  const closed = i.state !== "OPEN";
  return (
    <div className="w-full flex items-center gap-2.5 px-4 py-2 hover:bg-white/5"
      style={{
        borderBottom: edge(7),
        background: on ? "color-mix(in srgb, var(--primary) 12%, transparent)" : undefined,
        boxShadow: on ? "inset 2px 0 0 0 var(--primary)" : undefined,
      }}>
      <button onClick={onPick} className="flex-1 min-w-0 text-left">
        <div className="flex items-center gap-2">
          <span className="text-[10px] tabular-nums shrink-0" style={{ color: closed ? "var(--purple, var(--text3))" : "var(--success)" }}>
            {closed ? "⊘" : "⊙"} #{i.number}
          </span>
          <span className="truncate text-[11.5px]" style={{ color: "var(--text)" }}>{i.title}</span>
          {work && <span className="shrink-0 text-[9px] px-1.5 rounded-full"
            style={{ color: "var(--warning)", border: "1px solid color-mix(in srgb, var(--warning) 45%, transparent)" }}>in progress</span>}
        </div>
        <div className="flex items-center gap-1.5 mt-1 flex-wrap">
          {i.labels.slice(0, 4).map((l) => (
            <span key={l.name} className="text-[8.5px] px-1.5 rounded-full"
              style={{ color: `#${l.color || "8b949e"}`, border: `1px solid color-mix(in srgb, #${l.color || "8b949e"} 45%, transparent)` }}>{l.name}</span>
          ))}
          <span className="text-[9px] ml-auto" style={{ color: "var(--text4)" }}>{fmtAgo(new Date(i.updatedAt).getTime())}</span>
        </div>
      </button>
      {/* The default on the button, the rest behind the chevron — a five-way
          menu on every row is five decisions per row. */}
      <div className="relative shrink-0 flex items-center" ref={ref}>
        <button onClick={() => onStart(MODES[0].id)} title={MODES[0].hint}
          className="agx-btn text-[9.5px] px-2 py-1 rounded-l"
          style={{ color: "var(--primary)", border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)", background: "color-mix(in srgb, var(--primary) 12%, transparent)" }}>
          Start →
        </button>
        <button onClick={() => setMenu((m) => !m)} aria-label="Other ways to start"
          className="agx-btn text-[9.5px] px-1 py-1 rounded-r"
          style={{ color: "var(--primary)", borderTop: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)", borderRight: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)", borderBottom: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)", background: "color-mix(in srgb, var(--primary) 12%, transparent)" }}>▾</button>
        {menu && (
          <div className="absolute right-0 top-full mt-1 rounded-lg overflow-hidden shadow-2xl"
            style={{ zIndex: 40, background: "var(--bg2)", border: edge(28), minWidth: 260 }}>
            {MODES.map((m) => (
              <button key={m.id} onClick={() => { setMenu(false); onStart(m.id); }}
                className="w-full text-left px-3 py-1.5 hover:bg-white/5">
                <div className="text-[11px]" style={{ color: "var(--text)" }}>{m.label}</div>
                <div className="text-[9.5px]" style={{ color: "var(--text3)" }}>{m.hint}</div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Detail({ root, number, onSay, onChanged }: {
  root: string; number: number; onSay: (ok: boolean, t: string) => void; onChanged: () => void;
}) {
  const [d, setD] = useState<IssueDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<string[] | null>(null);

  const load = useCallback(() => {
    setD(null); setErr(null);
    api.issueDetail(root, number)
      .then((r) => (r.ok && r.issue ? setD(r.issue) : setErr(r.error ?? "could not read it")))
      .catch((e) => setErr(String(e)));
  }, [root, number]);
  useEffect(load, [load]);

  const act = async (fn: () => Promise<{ ok: boolean; error?: string; detail?: string; dirty?: string[] }>) => {
    setBusy(true);
    const r = await fn();
    setBusy(false);
    if (!r.ok && r.dirty) { setConfirm(r.dirty); return; }
    onSay(r.ok, r.ok ? (r.detail ?? "done") : (r.error ?? "failed"));
    if (r.ok) { load(); onChanged(); }
  };

  if (err) return <div className="p-5 text-[11.5px]" style={{ color: "var(--error)" }}>{err}</div>;
  if (!d) return <div className="p-5 text-[11.5px]" style={{ color: "var(--text3)" }}>Reading…</div>;

  return (
    <div className="h-full overflow-y-auto agx-scroll p-5">
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <span className="text-[10px] px-2 py-0.5 rounded-full"
          style={{ color: d.state === "OPEN" ? "var(--success)" : "var(--text3)", border: `1px solid color-mix(in srgb, ${d.state === "OPEN" ? "var(--success)" : "var(--text3)"} 45%, transparent)` }}>
          {d.state === "OPEN" ? "⊙ Open" : "⊘ Closed"}
        </span>
        <span className="text-[10px]" style={{ color: "var(--text3)" }}>{d.author} opened this · updated {fmtAgo(new Date(d.updatedAt).getTime())}</span>
        <span className="ml-auto flex items-center gap-1.5">
          <button disabled={busy} onClick={() => void act(() => api.issueClaim(root, number, "Picking this up."))}
            className="agx-btn text-[10px] px-2 py-1 rounded" style={{ color: "var(--text2)", border: edge(20) }}>Assign to me</button>
          <button disabled={busy} onClick={() => void act(() => api.issueState(root, number, d.state === "OPEN"))}
            className="agx-btn text-[10px] px-2 py-1 rounded" style={{ color: "var(--text2)", border: edge(20) }}>
            {d.state === "OPEN" ? "Close" : "Reopen"}
          </button>
        </span>
      </div>

      <h3 className="text-[16px] font-semibold mb-3" style={{ color: "var(--text)" }}>
        {d.title} <span style={{ color: "var(--text4)" }}>#{d.number}</span>
      </h3>

      {/* The work, when there is some. This block is the whole argument for the
          feature: an issue you started is a place on disk, and the way back out
          is right here rather than in a terminal you have to go and find. */}
      {d.work ? (
        <div className="rounded-lg p-3 mb-4"
          style={{ border: "1px solid color-mix(in srgb, var(--warning) 40%, transparent)", background: "color-mix(in srgb, var(--warning) 8%, transparent)" }}>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px]" style={{ color: "var(--warning)" }}>in progress</span>
            <span className="text-[10.5px]" style={{ color: "var(--text)" }}>{d.work.branch}</span>
            <span className="text-[9.5px] truncate" style={{ color: "var(--text3)" }}>{d.work.path}</span>
            <button disabled={busy} onClick={() => void act(() => api.issueFinish(root, number, false))}
              className="agx-btn ml-auto text-[10px] px-2 py-1 rounded"
              style={{ color: "var(--warning)", border: "1px solid color-mix(in srgb, var(--warning) 50%, transparent)" }}>
              Finish & clean up
            </button>
          </div>
          {confirm && (
            <div className="mt-2 text-[10px]" style={{ color: "var(--error)" }}>
              {confirm.length} uncommitted change{confirm.length === 1 ? "" : "s"} there — {confirm.slice(0, 4).join(", ")}
              {confirm.length > 4 ? "…" : ""}.
              <button onClick={() => { setConfirm(null); void act(() => api.issueFinish(root, number, true)); }}
                className="agx-btn ml-2 px-2 py-0.5 rounded"
                style={{ color: "var(--error)", border: "1px solid color-mix(in srgb, var(--error) 50%, transparent)" }}>
                Throw them away and remove it
              </button>
              <button onClick={() => setConfirm(null)} className="agx-btn ml-1.5 px-2 py-0.5 rounded"
                style={{ color: "var(--text3)", border: edge(20) }}>Keep it</button>
            </div>
          )}
        </div>
      ) : null}

      <div className="grid gap-3 mb-4" style={{ gridTemplateColumns: "repeat(3, minmax(0,1fr))" }}>
        <Field k="Assignees">{d.assignees.length ? d.assignees.join(", ") : "No one assigned"}</Field>
        <Field k="Labels">
          <span className="flex flex-wrap gap-1">
            {d.labels.length ? d.labels.map((l) => (
              <span key={l.name} className="text-[8.5px] px-1.5 rounded-full"
                style={{ color: `#${l.color || "8b949e"}`, border: `1px solid color-mix(in srgb, #${l.color || "8b949e"} 45%, transparent)` }}>{l.name}</span>
            )) : "None"}
          </span>
        </Field>
        <Field k="Milestone">{d.milestone ?? "None"}</Field>
      </div>

      <div className="text-[11.5px]" style={{ color: "var(--text2)" }}>
        {d.body.trim() ? <Markdown text={d.body} /> : <span style={{ color: "var(--text3)" }}>No description.</span>}
      </div>
    </div>
  );
}

const Field = ({ k, children }: { k: string; children: React.ReactNode }) => (
  <div>
    <div className="text-[8.5px] uppercase tracking-wider mb-1" style={{ color: "var(--text3)" }}>{k}</div>
    <div className="text-[10.5px]" style={{ color: "var(--text2)" }}>{children}</div>
  </div>
);
