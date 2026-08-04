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
import type { GitRepoRef, IssueDetail, IssueRow, IssueWork, StartMode, LocalTask, TaskCapability, TasksListResponse } from "../../../shared/types.ts";
import { ViewHeader } from "./workspace/ViewHeader.tsx";
import { useDismiss } from "../lib/useDismiss.ts";
import { Markdown } from "../lib/markdown.tsx";
import { fmtAgo } from "../lib/format.ts";
import { requestTermIssue } from "../lib/termIssue.ts";
import { subscribeReminders, liveReminders, nudgeReminders } from "../lib/reminderStore.ts";
import { useSyncExternalStore } from "react";

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

/**
 * Where the work comes from.
 *
 * The view is called Tasks rather than Issues because "issues" names a
 * *provider* and what is being grouped here is a *category*: things you owe.
 * Once the container is named that way GitHub stops being the owner and becomes
 * one source among several — adding another later is an entry in this array
 * rather than a rename of the view.
 *
 * `all` is first because it is the only one no provider can offer: none of them
 * knows about the others.
 */
type SourceId = "all" | "github" | "local";
const SOURCES: { id: SourceId; label: string }[] = [
  { id: "all", label: "All" },
  { id: "github", label: "GitHub" },
  { id: "local", label: "Local" },
];

export function TasksView({ active }: { active: boolean }) {
  const [repos, setRepos] = useState<GitRepoRef[]>([]);
  const [root, setRoot] = useState("");
  const [repoOpen, setRepoOpen] = useState(false);
  const [source, setSource] = useState<SourceId>("all");
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
      <ViewHeader title="Tasks">
        <nav className="flex items-center gap-0.5" aria-label="Sources">
          {SOURCES.map((s) => (
            <button key={s.id} onClick={() => setSource(s.id)}
              aria-current={s.id === source ? "true" : undefined}
              className="text-[11px] px-2.5 py-1 rounded-lg whitespace-nowrap"
              style={s.id === source
                ? { background: "color-mix(in srgb, var(--primary) 16%, transparent)", color: "var(--text)",
                    boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--primary) 40%, transparent)" }
                : { color: "var(--text3)" }}>
              {s.label}
            </button>
          ))}
        </nav>
        {/* Only the GitHub half is scoped to a repository. The local list is the
            machine's, and showing a repo picker over it would imply otherwise. */}
        <div className="relative" ref={pickerRef} style={{ display: source === "local" ? "none" : undefined }}>
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
      {source === "local" ? <LocalBody active={active} /> : (
        <div className="flex flex-col flex-1 min-h-0">
          {source === "all" && <NowBand onChanged={() => {}} />}
          {source === "all" && <LocalStrip active={active} onOpen={() => setSource("local")} />}
          {root ? <IssuesBody key={root} root={root} active={active} /> : (
            <div className="p-5 text-[11.5px]" style={{ color: "var(--text3)" }}>No repository to read issues from.</div>
          )}
        </div>
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

// ---------------------------------------------------------------------------
// reminders
// ---------------------------------------------------------------------------

const hhmm = (ms: number) => {
  const d = new Date(ms); const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
};
/** How a reminder reads in a column 100px wide: the time if it is today, the
 *  day and the time if it is not, and a date once it is far enough away that
 *  the weekday stops helping. */
function remindLabel(ms: number): string {
  const d = new Date(ms), now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const days = Math.floor((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - midnight) / 86_400_000);
  if (days === 0) return hhmm(ms);
  if (days === 1) return `tomorrow ${hhmm(ms)}`;
  if (days > 1 && days < 7) return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]} ${hhmm(ms)}`;
  return `${d.getDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()]}`;
}
const civilOf = (at: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}T${p(at.getHours())}:${p(at.getMinutes())}`;
};

/** The presets, and what each resolves to now. Relative ones ("in an hour") are
 *  the common case; the two clock times are the ones people actually say. */
function presetTimes(): { label: string; at: Date }[] {
  const now = new Date();
  const at = (h: number, m: number, addDays = 0) => {
    const d = new Date(now); d.setDate(d.getDate() + addDays); d.setHours(h, m, 0, 0); return d;
  };
  const evening = at(18, 0, now.getHours() >= 18 ? 1 : 0);
  const nextMon = (() => { const d = at(9, 0); const add = ((1 - d.getDay() + 7) % 7) || 7; d.setDate(d.getDate() + add); return d; })();
  return [
    { label: "in 15 minutes", at: new Date(now.getTime() + 15 * 60_000) },
    { label: "in an hour", at: new Date(now.getTime() + 60 * 60_000) },
    { label: `this evening (${hhmm(evening.getTime())})`, at: evening },
    { label: "tomorrow 9:00", at: at(9, 0, 1) },
    { label: "next Monday 9:00", at: nextMon },
  ];
}

/**
 * Everything that has fired and not been answered, at the top of the list.
 *
 * It reads the stored rows rather than anything that arrived over the wire, so
 * a reminder whose every transport failed is still here, in red, with the time
 * it fired. That is the answer to "what if the notification never lands".
 */
function NowBand({ onChanged }: { onChanged: () => void }) {
  const live = useSyncExternalStore(subscribeReminders, liveReminders, liveReminders);
  if (!live.length) return null;
  const act = async (fn: Promise<unknown>) => { await fn; await nudgeReminders(); onChanged(); };
  return (
    <div className="shrink-0" style={{ borderBottom: edge(12), background: "color-mix(in srgb, var(--error) 8%, transparent)" }}>
      <div className="text-[8.5px] uppercase tracking-[0.2em] px-5 pt-2.5 pb-1" style={{ color: "var(--error)" }}>Now</div>
      {live.map((r) => (
        <div key={r.id} className="flex items-center gap-2.5 px-5 py-2">
          <span className="tabular-nums shrink-0 text-[12px] font-semibold" style={{ color: "var(--error)" }}>
            {hhmm(r.firedAt ?? r.due)}
          </span>
          <span className="flex-1 min-w-0 truncate text-[11.5px]" style={{ color: "var(--text)" }} title={r.title}>{r.title}</span>
          <button onClick={() => void act(api.reminderAck(r.id))}
            className="shrink-0 text-[10px] px-2 py-0.5 rounded"
            style={{ background: "color-mix(in srgb, var(--primary) 12%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)", color: "var(--text)" }}>
            Done
          </button>
          <button onClick={() => void act(api.reminderSnooze(r.id, 15))}
            className="shrink-0 text-[10px] px-2 py-0.5 rounded" style={{ border: edge(20), color: "var(--text2)" }}>15m</button>
          <button onClick={() => void act(api.reminderSnooze(r.id, 60))}
            className="shrink-0 text-[10px] px-2 py-0.5 rounded" style={{ border: edge(20), color: "var(--text2)" }}>1h</button>
        </div>
      ))}
    </div>
  );
}

/** Pick a time, or type one. Anchored to the row it was opened from. */
function RemindPopover({ task, onClose, onSet }: {
  task: LocalTask; onClose: () => void; onSet: (civil: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [free, setFree] = useState("");
  useDismiss(true, ref, onClose);
  const parsed = useMemo(() => {
    const m = free.trim().match(/^(?:(\d{1,2})[:h](\d{2}))$/);
    if (!m) return null;
    const d = new Date(); d.setHours(+m[1]!, +m[2]!, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d;
  }, [free]);
  return (
    <div ref={ref} className="absolute right-0 top-full mt-1 rounded-lg text-[11px] shadow-2xl flex flex-col"
      style={{ zIndex: 40, background: "var(--bg2)", border: edge(28), minWidth: 240, padding: 4 }}>
      {presetTimes().map((p) => (
        <button key={p.label} onClick={() => onSet(civilOf(p.at))}
          className="text-left px-2.5 py-1.5 rounded hover:bg-white/5" style={{ color: "var(--text2)" }}>
          {p.label}
        </button>
      ))}
      <div style={{ borderTop: edge(14), margin: "4px 0" }} />
      <input value={free} autoFocus onChange={(e) => setFree(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && parsed) { e.preventDefault(); onSet(civilOf(parsed)); } }}
        placeholder="8:30" spellCheck={false}
        className="mx-1 mb-1 px-2 py-1 rounded text-[11px] outline-none"
        style={{ background: "color-mix(in srgb, var(--bg3) 55%, transparent)", border: edge(14), color: "var(--text)" }} />
      <div className="px-2 pb-1 text-[9.5px]" style={{ color: "var(--text4)", minHeight: 13 }}>
        {parsed ? `→ ${remindLabel(parsed.getTime())}` : free.trim() ? "a time like 8:30" : ""}
      </div>
      <span className="sr-only">{task.description}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// the local list
// ---------------------------------------------------------------------------

/**
 * Read out of Taskwarrior, which the user already writes to from their editor.
 *
 * Nothing here is ours: the list is re-read rather than mirrored, so a task
 * added in Neovim shows up without anything having to be reconciled. Read-only
 * for now — the write path needs a lock and a compare-and-swap against a store
 * with a second writer, and none of that is needed to put the list on screen.
 */
function useLocalTasks(active: boolean) {
  const [data, setData] = useState<TasksListResponse | null>(null);
  const load = useCallback(() => {
    api.tasksList().then(setData).catch(() => {});
  }, []);
  // Re-read when a reminder is set or answered, so the row agrees with the
  // click that just happened rather than waiting out the poll.
  useEffect(() => {
    if (!active) return;
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [active, load]);
  return { data, reload: load };
}

const overdue = (t: LocalTask, today: string) => !!t.due && t.due < today;
const todayStr = () => {
  const d = new Date(); const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** What the panel says when there is no list to show, which on a fresh machine
 *  is the first thing anybody sees. Each cause gets its own sentence because
 *  each has a different next step — "install it" and "answer its question" are
 *  not the same instruction. */
function LocalEmpty({ cap, done }: { cap: TaskCapability; done: number }) {
  const box = (title: string, body: React.ReactNode) => (
    <div className="p-5 text-[11.5px] leading-relaxed" style={{ color: "var(--text3)", maxWidth: "56ch" }}>
      <b className="block mb-1.5 text-[12.5px]" style={{ color: "var(--text)" }}>{title}</b>
      {body}
    </div>
  );
  if (!cap.available) {
    return box("Taskwarrior isn't installed.", <>
      agentglass reads this list with the <code>task</code> command. Install it, then refresh.
    </>);
  }
  if (!cap.configured) {
    return box("Taskwarrior is installed but not set up.", <>
      Run <code>task</code> once in a terminal and answer its question. agentglass will not
      write your <code>~/.taskrc</code> for you.
    </>);
  }
  return box("Nothing open.", done > 0
    ? <>{done} finished. Add one from your editor and it shows up here.</>
    : <>Nothing here yet.</>);
}

function LocalBody({ active }: { active: boolean }) {
  const { data, reload } = useLocalTasks(active);
  const [sel, setSel] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [remindFor, setRemindFor] = useState<string | null>(null);
  const today = todayStr();
  const byTask = data?.byTask ?? {};
  const setRemind = useCallback(async (t: LocalTask, civil: string) => {
    setRemindFor(null);
    await api.remind({ taskUuid: t.uuid, title: t.description, civil });
    await nudgeReminders();
    reload();
  }, [reload]);

  const { open, done } = useMemo(() => {
    const all = data?.tasks ?? [];
    return {
      open: all.filter((t) => t.status === "pending"),
      done: all.filter((t) => t.status === "completed"),
    };
  }, [data]);

  if (!data) return <div className="p-5 text-[11.5px]" style={{ color: "var(--text3)" }}>Reading your task list…</div>;
  const cap = data.capability;
  const picked = [...open, ...done].find((t) => t.uuid === sel) ?? null;

  if (!open.length && !done.length) return <LocalEmpty cap={cap} done={0} />;

  const od = open.filter((t) => overdue(t, today));
  const rest = open.filter((t) => !overdue(t, today));

  const rowProps = (t: LocalTask) => ({
    t, today, on: t.uuid === sel, onPick: () => setSel(t.uuid),
    reminder: byTask[t.uuid] ?? null,
    remindOpen: remindFor === t.uuid,
    onRemind: () => setRemindFor((cur) => (cur === t.uuid ? null : t.uuid)),
    onCloseRemind: () => setRemindFor(null),
    onSetRemind: (civil: string) => void setRemind(t, civil),
  });

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <NowBand onChanged={reload} />
      <div className="flex flex-1 min-h-0">
      <div className="agx-scroll flex-1 min-w-0 overflow-y-auto">
        {!open.length && <LocalEmpty cap={cap} done={done.length} />}
        {!!od.length && <Section label="Overdue" tone="var(--error)" />}
        {od.map((t) => <TaskRow key={t.uuid} {...rowProps(t)} />)}
        {rest.map((t) => <TaskRow key={t.uuid} {...rowProps(t)} />)}
        {!!done.length && (
          <button onClick={() => setShowDone((v) => !v)}
            className="w-full text-left text-[8.5px] uppercase tracking-[0.2em] px-5 pt-3 pb-1"
            style={{ color: "var(--text3)" }}>
            {showDone ? "▾" : "▸"} {done.length} done
          </button>
        )}
        {showDone && done.slice(0, 200).map((t) => (
          <TaskRow key={t.uuid} {...rowProps(t)} />
        ))}
      </div>
      <aside className="agx-scroll overflow-y-auto p-5 text-[11.5px] shrink-0"
        style={{ width: 380, borderLeft: edge(12) }}>
        {picked ? <TaskDetail t={picked} today={today} reminder={byTask[picked.uuid] ?? null}
          onCancel={async () => { const r = byTask[picked.uuid]; if (r) { await api.reminderCancel(r.id); await nudgeReminders(); reload(); } }} /> : (
          <div className="text-center p-5" style={{ color: "var(--text3)" }}>Pick a task.</div>
        )}
      </aside>
      </div>
    </div>
  );
}

const Section = ({ label, tone }: { label: string; tone: string }) => (
  <div className="text-[8.5px] uppercase tracking-[0.2em] px-5 pt-3 pb-1" style={{ color: tone }}>{label}</div>
);

function TaskRow({ t, today, on, onPick, reminder, remindOpen, onRemind, onCloseRemind, onSetRemind }: {
  t: LocalTask; today: string; on: boolean; onPick: () => void;
  reminder?: import("../../../shared/types.ts").Reminder | null;
  remindOpen?: boolean; onRemind?: () => void; onCloseRemind?: () => void; onSetRemind?: (civil: string) => void;
}) {
  const isDone = t.status === "completed";
  const late = overdue(t, today);
  const dueToday = t.due === today;
  return (
    <button onClick={onPick}
      className="w-full text-left flex items-center gap-2.5 px-4 py-2 text-[11.5px] hover:bg-white/5"
      style={{
        borderBottom: edge(7),
        background: on ? "color-mix(in srgb, var(--primary) 15%, transparent)" : undefined,
        boxShadow: on ? "inset 2px 0 0 0 var(--primary)" : undefined,
      }}>
      <span className="w-3.5 text-center shrink-0"
        style={{ color: isDone ? "var(--text3)" : t.priority === "H" ? "var(--warning)" : t.priority ? "var(--text3)" : "var(--text4)" }}>
        {isDone ? "✓" : t.priority ? "●" : "○"}
      </span>
      <span className="flex-1 min-w-0 truncate" title={t.description}
        style={isDone ? { textDecoration: "line-through", color: "var(--text3)" } : { color: "var(--text)" }}>
        {t.description}
      </span>
      {t.project && <span className="shrink-0 text-[10px]" style={{ color: "var(--info)" }}>@{t.project}</span>}
      {t.tags.slice(0, 2).map((tag) => (
        <span key={tag} className="shrink-0 text-[9px] px-1.5 rounded" style={{ color: "var(--text3)", border: edge(14) }}>{tag}</span>
      ))}
      <span className="shrink-0 tabular-nums text-right" style={{
        width: 72,
        color: late ? "var(--error)" : dueToday ? "var(--warning)" : "var(--text3)",
        fontWeight: late || dueToday ? 600 : undefined,
      }}>
        {t.due ? (dueToday ? "today" : t.due.slice(5)) : "—"}
      </span>
      {/* The reminder column, and the offer where there is none. A due date
          says when something is wanted; only a reminder will actually tell
          you — so a task with a due date and no reminder says so rather than
          leaving a blank that reads as "handled". */}
      <span className="shrink-0 relative tabular-nums text-right group" style={{ width: 116 }}>
        {reminder ? (
          <span style={{ color: reminder.firedAt ? "var(--error)" : reminder.due - Date.now() < 3_600_000 ? "var(--warning)" : "var(--text3)" }}>
            ⏰ {remindLabel(reminder.due)}
          </span>
        ) : isDone ? null : (
          <button onClick={(e) => { e.stopPropagation(); onRemind?.(); }}
            className="text-[10px] px-1 rounded hover:bg-white/5"
            style={{ color: t.due ? "var(--warning)" : "var(--text4)" }}
            title="Set a reminder for this task">
            {t.due ? "⌁ nothing will tell you" : "⌁ remind me…"}
          </button>
        )}
        {remindOpen && onSetRemind && onCloseRemind && (
          <RemindPopover task={t} onClose={onCloseRemind} onSet={onSetRemind} />
        )}
      </span>
    </button>
  );
}

function TaskDetail({ t, today, reminder, onCancel }: {
  t: LocalTask; today: string;
  reminder?: import("../../../shared/types.ts").Reminder | null;
  onCancel?: () => void;
}) {
  return (
    <div>
      <h2 className="text-[16px] font-semibold leading-snug mb-2.5" style={{ color: "var(--text)", textWrap: "balance" }}>
        {t.description}
      </h2>
      <div className="flex flex-wrap items-center gap-1.5 mb-2">
        {t.priority && (
          <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--warning)", border: edge(16) }}>
            {t.priority === "H" ? "High" : t.priority === "M" ? "Medium" : "Low"}
          </span>
        )}
        {t.project && <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--info)", border: edge(16) }}>@{t.project}</span>}
        {t.tags.map((tag) => (
          <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--text3)", border: edge(16) }}>{tag}</span>
        ))}
      </div>
      <div className="text-[10px] mb-4" style={{ color: overdue(t, today) ? "var(--error)" : "var(--text3)" }}>
        {[
          t.due && `due ${t.due}${overdue(t, today) ? " · overdue" : ""}`,
          t.completed && `done ${t.completed}`,
          t.created && `created ${t.created}`,
        ].filter(Boolean).join(" · ")}
      </div>
      {reminder && (
        <div className="flex items-center gap-2 mb-4 text-[11px]">
          <span style={{ color: reminder.firedAt ? "var(--error)" : "var(--primary)" }}>⏰ {remindLabel(reminder.due)}</span>
          <span className="flex-1" />
          <button onClick={onCancel} className="text-[10px] px-2 py-0.5 rounded" style={{ border: edge(20), color: "var(--text2)" }}>
            remove
          </button>
        </div>
      )}
      {!!t.notes.length && (
        <>
          <div className="text-[8.5px] uppercase tracking-[0.2em] mb-1.5" style={{ color: "var(--text3)" }}>Notes</div>
          {t.notes.map((n, i) => <div key={i} className="mb-3"><Markdown text={n} /></div>)}
        </>
      )}
      {!!t.urls.length && (
        <>
          <div className="text-[8.5px] uppercase tracking-[0.2em] mt-4 mb-1.5" style={{ color: "var(--text3)" }}>Links</div>
          {t.urls.map((u) => (
            <a key={u} href={u} target="_blank" rel="noreferrer"
              className="block text-[10px] break-all mb-1" style={{ color: "var(--info)" }}>{u}</a>
          ))}
        </>
      )}
    </div>
  );
}

/**
 * The local list, on the All tab, above the issues.
 *
 * Capped and collapsed rather than shown whole: this tab's job is to answer
 * "what do I owe" at a glance, and a hundred-row local list under a
 * hundred-row issue list answers it worse than either alone. Overdue first,
 * because that is the part that cannot wait for the user to switch tabs.
 */
function LocalStrip({ active, onOpen }: { active: boolean; onOpen: () => void }) {
  const { data } = useLocalTasks(active);
  const today = todayStr();
  const byTask = data?.byTask ?? {};
  const open = (data?.tasks ?? []).filter((t) => t.status === "pending");
  if (!open.length) return null;
  const sorted = [...open].sort((a, b) =>
    Number(overdue(b, today)) - Number(overdue(a, today)) || (a.due ?? "9").localeCompare(b.due ?? "9"));
  const shown = sorted.slice(0, 5);
  return (
    <div className="shrink-0" style={{ borderBottom: edge(12) }}>
      <button onClick={onOpen}
        className="w-full text-left text-[8.5px] uppercase tracking-[0.2em] px-5 pt-3 pb-1 hover:bg-white/5"
        style={{ color: "var(--text3)" }}>
        Yours · {open.length}
      </button>
      {shown.map((t) => <TaskRow key={t.uuid} t={t} today={today} on={false} onPick={onOpen} reminder={byTask[t.uuid] ?? null} />)}
      {open.length > shown.length && (
        <button onClick={onOpen} className="w-full text-left text-[10px] px-5 py-1.5 hover:bg-white/5"
          style={{ color: "var(--text4)" }}>
          and {open.length - shown.length} more — open the Local tab
        </button>
      )}
    </div>
  );
}
