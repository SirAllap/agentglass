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
import type { GitRepoRef, IssueDetail, IssueRow, IssueWork, StartMode, LocalTask, TaskCapability, TasksListResponse, SkillInfo } from "../../../shared/types.ts";
import type { ProviderTask, ProviderTasksResponse, SavedView, ViewTasksResponse, ListStatus, ListField, TaskDetail } from "../../../shared/providers.ts";
import { ViewHeader } from "./workspace/ViewHeader.tsx";
import { useDismiss } from "../lib/useDismiss.ts";
import { Markdown } from "../lib/markdown.tsx";
import { fmtAgo } from "../lib/format.ts";
import { requestTermIssue } from "../lib/termIssue.ts";
import { openSettings } from "../lib/openSettings.ts";
import { cardSkills, skillCommand, windowName, skillModes, namedForIt } from "../lib/cardSkills.ts";
import { subscribeReminders, liveReminders, nudgeReminders } from "../lib/reminderStore.ts";
import { parseLocal, toLine, sortTasks, step, checkbox, toggleCheckbox, checkProgress, rootForTask, taskPrompt, lineWith, inUse, typingInto, dueBucket, bucketCounts, dueLabel, TASK_KEYS, SORTS, type SortMode, type Bucket } from "../lib/taskGrammar.ts";
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
type SourceId = "all" | "github" | "local" | "clickup";
const SOURCES: { id: SourceId; label: string }[] = [
  { id: "all", label: "All" },
  { id: "github", label: "GitHub" },
  { id: "local", label: "Local" },
  // Shown whether or not it is connected, and that is deliberate: a tab that
  // only appears once you have found Settings is a feature nobody discovers.
  // Unconnected, it says what to do and links to the pane that does it.
  { id: "clickup", label: "ClickUp" },
];

/** What a finished bulk run says it did. Past tense, and the same words as the
 *  buttons, so the confirmation is recognisably the thing that was pressed. */
const LABEL: Record<string, string> = {
  done: "Completed", priority: "Priority set", tag: "Tagged", delete: "Deleted",
};


export function TasksView({ active, onOpenChatWith }: {
  active: boolean;
  onOpenChatWith?: (cwd: string, prompt: string, title: string) => void;
}) {
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
        {/* Only the GitHub half is scoped to a repository. The local list is
            this machine's and ClickUp is a workspace's, so a repo picker over
            either would imply a scoping that does not exist. */}
        <div className="relative" ref={pickerRef}
          style={{ display: source === "local" || source === "clickup" ? "none" : undefined }}>
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
      {source === "local" ? <LocalBody active={active} repos={repos} here={root} onOpenChatWith={onOpenChatWith} />
      : source === "clickup" ? <ClickUpBody active={active} repos={repos} here={root} onOpenChatWith={onOpenChatWith} />
      : (
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
/*
 * ClickUp, as the board you are actually working from.
 *
 * The first version read "everything assigned to me across the workspace",
 * which was both slow and useless: twelve and a half seconds to produce a list
 * where half the rows were things already in production. Both problems have the
 * same cause — asking a whole organisation a question instead of opening the
 * board you had open anyway.
 *
 * So a board is added by pasting its address, and everything follows from that:
 * a view answers in about a second because it is already scoped, it applies its
 * own filters server-side so what arrives is what the browser shows you, and
 * the list behind it knows its own statuses, which is what makes a status
 * picker possible without guessing.
 */
function ClickUpBody({ active, repos, here, onOpenChatWith }: {
  active: boolean;
  repos: GitRepoRef[];
  here: string;
  onOpenChatWith?: (cwd: string, prompt: string, title: string) => void;
}) {
  const [boards, setBoards] = useState<{ views: SavedView[]; current?: string; writeEnabled: boolean } | null>(null);
  const [data, setData] = useState<ViewTasksResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [urlText, setUrlText] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [q, setQ] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const [mineOnly, setMineOnly] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Pending | null>(null);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const today = todayStr();

  // Read once when the tab opens. The set of skills on a machine does not
  // change while somebody is looking at a board, and this is a hundred-odd
  // rows filtered down to a handful.
  useEffect(() => {
    if (!active) return;
    void api.skills().then((r) => setSkills(cardSkills(r.skills ?? []))).catch(() => setSkills([]));
  }, [active]);

  const loadBoards = useCallback(async () => {
    try { setBoards(await api.clickupViews()); } catch { /* the panel still renders */ }
  }, []);

  const load = useCallback(async (id?: string, force = false) => {
    setBusy(true);
    try { setData(await api.clickupView(id, force)); }
    catch { setData({ tasks: [], statuses: [], fields: [], at: 0, error: "Could not reach the server" }); }
    finally { setBusy(false); }
  }, []);

  useEffect(() => { if (active) { void loadBoards(); void load(); } }, [active, loadBoards, load]);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => { if (!document.hidden) void load(data?.view?.id); }, 60_000);
    return () => clearInterval(t);
  }, [active, load, data?.view?.id]);

  const addBoard = async () => {
    if (!urlText.trim()) return;
    setBusy(true);
    const r = await api.clickupAddView(urlText.trim());
    setBusy(false);
    if (!r.ok) { setNote({ ok: false, text: r.error ?? "That did not work" }); return; }
    setUrlText(""); setAdding(false); setNote(null);
    await loadBoards();
    await load(r.view?.id, true);
  };

  /** Every write goes through here: it asks first, and it carries the
   *  `date_updated` the row was read at so a card that moved is refused. */
  const run = async (p: Pending) => {
    setConfirm(null);
    setBusy(true);
    const r = await p.go();
    setBusy(false);
    if (!r.ok) { setNote({ ok: false, text: r.error ?? "That did not go through" }); }
    else setNote({ ok: true, text: p.done });
    await load(data?.view?.id, true);
  };

  const rows = useMemo(() => {
    const all = data?.tasks ?? [];
    const needle = q.trim().toLowerCase();
    return all.filter((t) =>
      (showDone || t.statusKind !== "done")
      && (!mineOnly || t.mine)
      && (!tag || t.tags.includes(tag))
      && (!needle || t.title.toLowerCase().includes(needle)));
  }, [data, q, tag, mineOnly, showDone]);

  const tags = useMemo(() => {
    const seen = new Set<string>();
    for (const t of data?.tasks ?? []) for (const x of t.tags) seen.add(x);
    return [...seen].sort();
  }, [data]);

  const counts = useMemo(() => {
    const all = data?.tasks ?? [];
    return {
      mine: all.filter((t) => t.mine && t.statusKind !== "done").length,
      open: all.filter((t) => t.statusKind !== "done").length,
      done: all.filter((t) => t.statusKind === "done").length,
    };
  }, [data]);

  const picked = rows.find((t) => t.id === sel) ?? null;

  if (!boards) return <div className="p-5 text-[11.5px]" style={{ color: "var(--text3)" }}>Reading your boards…</div>;

  if (!boards.views.length) return <AddFirstBoard value={urlText} onValue={setUrlText} onAdd={addBoard} busy={busy} note={note} />;

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center gap-1.5 px-5 pt-2.5 pb-1.5 flex-wrap shrink-0">
        {boards.views.map((v) => (
          <button key={v.id} onClick={() => { setSel(null); void load(v.id); }}
            aria-pressed={data?.view?.id === v.id}
            className="flex items-center gap-1.5 text-[11px] px-2.5 py-0.5 rounded-full whitespace-nowrap max-w-[280px]"
            style={data?.view?.id === v.id
              ? { background: "color-mix(in srgb, var(--primary) 18%, transparent)",
                  border: "1px solid color-mix(in srgb, var(--primary) 50%, transparent)", color: "var(--text)" }
              : { border: edge(14), color: "var(--text2)" }}
            title={v.listName ? `${v.listName} · ${v.name}` : v.name}>
            <span className="truncate">{v.listName || v.name}</span>
          </button>
        ))}
        <button onClick={() => setAdding((o) => !o)} className="text-[11px] px-2 py-0.5 rounded-full"
          style={{ border: edge(14), color: "var(--text3)" }}>＋ board</button>
        <span className="flex-1" />
        {!boards.writeEnabled && (
          <span className="text-[10px] px-2 py-0.5 rounded-full" title="Set AGENTGLASS_CLICKUP_WRITE=1 to enable changes"
            style={{ color: "var(--text4)", border: edge(12) }}>read-only</span>
        )}
        <button onClick={() => void load(data?.view?.id, true)} disabled={busy}
          className="text-[10.5px] px-2.5 py-0.5 rounded-lg"
          style={{ border: edge(16), color: "var(--text2)", opacity: busy ? 0.5 : 1 }}>
          {busy ? "Reading…" : "Refresh"}
        </button>
      </div>

      {adding && (
        <AddBoardBar value={urlText} onValue={setUrlText} onAdd={addBoard} onClose={() => setAdding(false)} busy={busy} />
      )}

      <div className="flex items-center gap-1.5 px-5 pb-2 flex-wrap shrink-0">
        <div className="flex items-center gap-2 flex-1 min-w-[220px] rounded-lg px-2.5 py-1"
          style={{ background: "var(--bg2)", border: edge(14) }}>
          <span className="text-[11px] shrink-0" style={{ color: "var(--text3)" }}>⌕</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false}
            placeholder="Search this board"
            className="flex-1 min-w-0 bg-transparent outline-none text-[12px]"
            style={{ color: "var(--text)", caretColor: "var(--primary)" }} />
        </div>
        <button onClick={() => setMineOnly((v) => !v)} aria-pressed={mineOnly}
          className="text-[11px] px-2.5 py-0.5 rounded-full whitespace-nowrap"
          style={mineOnly
            ? { background: "color-mix(in srgb, var(--success) 18%, transparent)", border: "1px solid color-mix(in srgb, var(--success) 45%, transparent)", color: "var(--text)" }
            : { border: edge(14), color: "var(--text2)" }}>
          mine <span style={{ color: "var(--text3)" }}>{counts.mine}</span>
        </button>
        {tags.slice(0, 6).map((t) => (
          <button key={t} onClick={() => setTag((cur) => (cur === t ? null : t))} aria-pressed={tag === t}
            className="text-[11px] px-2.5 py-0.5 rounded-full"
            style={tag === t
              ? { background: "color-mix(in srgb, var(--primary) 18%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)", color: "var(--text)" }
              : { border: edge(14), color: "var(--text3)" }}>{t}</button>
        ))}
        <span className="flex-1" />
        {/* Hidden by default and counted, so nobody has to wonder where the
            finished work went. `done` here is ClickUp's own status TYPE — see
            toTask — which is why "in production" and "won't fix" fall in it. */}
        <button onClick={() => setShowDone((v) => !v)} aria-pressed={showDone}
          className="text-[10.5px] px-2 py-0.5 rounded-lg"
          style={{ border: edge(14), color: showDone ? "var(--text2)" : "var(--text4)" }}>
          {showDone ? "hiding nothing" : `${counts.done} done hidden`}
        </button>
      </div>

      {note && (
        <div className="px-5 py-1 text-[10.5px] shrink-0" style={{
          color: note.ok ? "var(--success)" : "var(--warning)",
          background: `color-mix(in srgb, var(--${note.ok ? "success" : "warning"}) 10%, transparent)`,
        }}>{note.text}</div>
      )}
      {data?.error && (
        <div className="px-5 py-1 text-[10.5px] shrink-0"
          style={{ color: "var(--warning)", background: "color-mix(in srgb, var(--warning) 10%, transparent)" }}>
          {data.error}{data.tasks.length ? " — showing what was last read" : ""}
        </div>
      )}
      {confirm && <ConfirmStrip pending={confirm} onGo={() => void run(confirm)} onCancel={() => setConfirm(null)} />}

      <div className="flex flex-1 min-h-0">
        <div className="flex flex-col flex-1 min-w-0">
          <div className="px-5 py-1 text-[8.5px] uppercase tracking-[0.16em] shrink-0"
            style={{ display: "grid", gridTemplateColumns: CU_GRID, gap: 10, color: "var(--text4)",
              borderTop: edge(10), borderBottom: edge(10) }}>
            <span>Task</span><span>Status</span><span>Due</span><span>Pts</span><span />
          </div>
          <div className="agx-scroll flex-1 min-w-0 overflow-y-auto">
            {!rows.length && (
              <div className="p-5 text-[11.5px]" style={{ color: "var(--text3)" }}>
                {data?.error ? "Nothing to show — the last read did not get through."
                  : q || tag || mineOnly ? "Nothing matches that."
                  : "This board has nothing open."}
              </div>
            )}
            {rows.map((t) => (
              <ClickUpRow key={t.id} t={t} today={today} on={t.id === sel} onPick={() => setSel(t.id)} />
            ))}
          </div>
          <div className="flex items-center gap-3 px-5 py-1.5 shrink-0 text-[10.5px]"
            style={{ borderTop: edge(10), color: "var(--text4)" }}>
            <span>{rows.length} of {data?.tasks.length ?? 0}</span>
            {data?.at ? <span>· read {fmtAgo(data.at)}</span> : null}
            <span className="flex-1" />
            {data?.view?.name && <span className="truncate max-w-[280px]">{data.view.name}</span>}
          </div>
        </div>

        <aside className="agx-scroll overflow-y-auto p-4 text-[11.5px] shrink-0"
          style={{ width: 380, borderLeft: edge(12) }}>
          {picked
            ? <CardDetail t={picked} today={today} statuses={data?.statuses ?? []} fields={data?.fields ?? []}
                writable={boards.writeEnabled} repos={repos} here={here}
                onOpenChatWith={onOpenChatWith}
                skills={skills}
                onNote={(text) => setNote({ ok: true, text })}
                onAsk={(p) => setConfirm(p)} />
            : <div className="text-center p-5" style={{ color: "var(--text3)" }}>Pick a card.</div>}
        </aside>
      </div>
    </div>
  );
}

/** A change that has been proposed but not made. Held rather than run, because
 *  everything here is visible to somebody else's board. */
interface Pending {
  what: string;
  from?: string;
  to?: string;
  done: string;
  go: () => Promise<{ ok: boolean; error?: string; conflict?: boolean }>;
}

function ConfirmStrip({ pending, onGo, onCancel }: { pending: Pending; onGo: () => void; onCancel: () => void }) {
  return (
    <div className="px-5 py-2 shrink-0 flex items-center gap-3 flex-wrap"
      style={{ background: "color-mix(in srgb, var(--warning) 9%, transparent)", borderBottom: edge(10) }}>
      <div className="text-[11.5px]" style={{ color: "var(--text2)" }}>
        <b style={{ color: "var(--warning)" }}>{pending.what}</b>
        {pending.from && pending.to && <> · <code>{pending.from}</code> → <code>{pending.to}</code></>}
        <div className="text-[10.5px]" style={{ color: "var(--text3)" }}>
          Your team sees this. It is not undoable from here.
        </div>
      </div>
      <span className="flex-1" />
      <button onClick={onGo} className="text-[11px] px-3 py-1 rounded-lg"
        style={{ background: "color-mix(in srgb, var(--warning) 22%, transparent)",
          border: "1px solid color-mix(in srgb, var(--warning) 50%, transparent)", color: "var(--text)" }}>
        Do it
      </button>
      <button onClick={onCancel} className="text-[11px] px-2 py-1 rounded-lg" style={{ color: "var(--text3)" }}>Cancel</button>
    </div>
  );
}

function AddBoardBar({ value, onValue, onAdd, onClose, busy }: {
  value: string; onValue: (v: string) => void; onAdd: () => void; onClose: () => void; busy: boolean;
}) {
  return (
    <div className="px-5 pb-2 flex items-center gap-2 shrink-0">
      <input autoFocus value={value} onChange={(e) => onValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") onAdd(); if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}
        placeholder="Paste the address of a ClickUp board — the one in your browser's bar"
        spellCheck={false} autoComplete="off"
        className="flex-1 min-w-0 text-[11.5px] px-2.5 py-1.5 rounded-lg outline-none"
        style={{ background: "var(--bg2)", border: edge(18), color: "var(--text)" }} />
      <button onClick={onAdd} disabled={busy || !value.trim()}
        className="text-[11.5px] px-3 py-1.5 rounded-lg"
        style={{ background: "color-mix(in srgb, var(--primary) 20%, transparent)",
          border: "1px solid color-mix(in srgb, var(--primary) 48%, transparent)",
          color: "var(--text)", opacity: busy || !value.trim() ? 0.4 : 1 }}>
        {busy ? "Checking…" : "Add"}
      </button>
    </div>
  );
}

function AddFirstBoard({ value, onValue, onAdd, busy, note }: {
  value: string; onValue: (v: string) => void; onAdd: () => void; busy: boolean;
  note: { ok: boolean; text: string } | null;
}) {
  return (
    <div className="flex flex-col items-center justify-center flex-1 gap-3 p-8 text-center">
      <div className="text-[13px]" style={{ color: "var(--text)" }}>Add the board you work from</div>
      <div className="text-[11.5px] max-w-[52ch]" style={{ color: "var(--text3)" }}>
        Open it in ClickUp and paste the address here. Its own filters come with it, so what you see
        here is what you see there — and it loads in about a second instead of trawling the whole
        workspace.
      </div>
      <div className="flex items-center gap-2 w-full max-w-[560px]">
        <input autoFocus value={value} onChange={(e) => onValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") onAdd(); }}
          placeholder="Paste a board address" spellCheck={false} autoComplete="off"
          className="flex-1 min-w-0 text-[11.5px] px-2.5 py-1.5 rounded-lg outline-none"
          style={{ background: "var(--bg2)", border: edge(18), color: "var(--text)" }} />
        <button onClick={onAdd} disabled={busy || !value.trim()}
          className="text-[11.5px] px-3 py-1.5 rounded-lg"
          style={{ background: "color-mix(in srgb, var(--primary) 20%, transparent)",
            border: "1px solid color-mix(in srgb, var(--primary) 48%, transparent)",
            color: "var(--text)", opacity: busy || !value.trim() ? 0.4 : 1 }}>
          {busy ? "Checking…" : "Add"}
        </button>
      </div>
      {note && <div className="text-[11px]" style={{ color: note.ok ? "var(--success)" : "var(--error)" }}>{note.text}</div>}
      <button onClick={() => openSettings("integrations")} className="text-[10.5px] px-2 py-1 rounded-lg mt-1"
        style={{ border: edge(16), color: "var(--text3)" }}>ClickUp settings</button>
    </div>
  );
}

const CU_GRID = "1fr 150px 80px 40px 66px";
const YOLO_KEY = "agentglass.clickup.skipPermissions";

function ClickUpRow({ t, today, on, onPick }: { t: ProviderTask; today: string; on: boolean; onPick: () => void }) {
  const late = !!t.due && t.due < today;
  const now = t.due === today;
  return (
    <div role="row" tabIndex={0} aria-current={on ? "true" : undefined} onClick={onPick}
      onKeyDown={(e) => { if (e.key === "Enter") onPick(); }}
      className="agx-row w-full text-left px-5 py-1.5 hover:bg-white/5 cursor-pointer items-center"
      style={{
        display: "grid", gridTemplateColumns: CU_GRID, gap: 10, borderBottom: edge(6),
        background: on ? "color-mix(in srgb, var(--primary) 13%, transparent)" : undefined,
        boxShadow: on ? "inset 2px 0 0 0 var(--primary)" : undefined,
      }}>
      <div className="min-w-0">
        <div className="truncate text-[12.5px] leading-snug" style={{ color: "var(--text)" }} title={t.title}>{t.title}</div>
        {(t.mine || t.priority || t.tags.length) && (
          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
            {t.mine && (
              <span className="text-[8.5px] tracking-[0.08em] px-1.5 rounded"
                style={{ color: "var(--success)", background: "color-mix(in srgb, var(--success) 14%, transparent)" }}>YOU</span>
            )}
            {t.priority && (t.priority === "urgent" || t.priority === "high") && (
              <span className="text-[8.5px] tracking-[0.08em] px-1.5 rounded"
                style={{ color: "var(--error)", background: "color-mix(in srgb, var(--error) 13%, transparent)" }}>
                {t.priority.toUpperCase()}
              </span>
            )}
            {t.tags.slice(0, 3).map((tag) => (
              <span key={tag} className="text-[9.5px] px-1.5 rounded-full"
                style={{ color: "var(--text3)", background: "color-mix(in srgb, var(--text) 7%, transparent)" }}>{tag}</span>
            ))}
          </div>
        )}
      </div>
      <span className="truncate text-[11px]" style={{ color: t.statusKind === "done" ? "var(--text4)" : "var(--text3)" }} title={t.status}>{t.status}</span>
      <span className="text-[11px] tabular-nums" style={{ color: late ? "var(--error)" : now ? "var(--warning)" : "var(--text3)" }}>
        {dueLabel(t.due, today)}
      </span>
      <span className="text-[11px] tabular-nums text-right" style={{ color: "var(--text4)" }}>{t.points ?? ""}</span>
      <span className="text-right">
        {t.url && (
          <a href={t.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
            className="agx-onrow text-[10.5px] px-2 py-0.5 rounded-lg inline-block"
            style={{ border: edge(16), color: "var(--text2)" }}>↗</a>
        )}
      </span>
    </div>
  );
}

/*
 * One card, and the few things you can do to it.
 *
 * The description, subtasks and comments are fetched on demand — never for
 * every row — because they are what make going to the browser unnecessary and
 * they cost a call each.
 *
 * Every control that WRITES proposes rather than acts: it hands a `Pending` up,
 * the strip at the top says what will change and from what to what, and only
 * then does anything leave this machine. That is not ceremony. A status change
 * here fires automations and notifies people, and there is no undo.
 */
function CardDetail({ t, today, statuses, fields, writable, repos, here, onOpenChatWith, onAsk, skills, onNote }: {
  t: ProviderTask; today: string;
  statuses: ListStatus[]; fields: ListField[];
  writable: boolean;
  repos: GitRepoRef[]; here: string;
  onOpenChatWith?: (cwd: string, prompt: string, title: string) => void;
  onAsk: (p: Pending) => void;
  /** Only the skills that take a card — see lib/cardSkills.ts. */
  skills: SkillInfo[];
  onNote: (text: string) => void;
}) {
  const [full, setFull] = useState<(Partial<TaskDetail> & { ok?: boolean; error?: string }) | null>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [skillQ, setSkillQ] = useState("");
  // Remembered across cards and restarts: whoever wants this once usually wants
  // it for the rest of the afternoon, and re-ticking it every time is how it
  // ends up left on by habit instead of by choice.
  const [yolo, setYolo] = useState(() => {
    try { return localStorage.getItem(YOLO_KEY) === "1"; } catch { return false; }
  });
  useEffect(() => { try { localStorage.setItem(YOLO_KEY, yolo ? "1" : "0"); } catch { /* private mode */ } }, [yolo]);

  useEffect(() => {
    let live = true;
    setFull(null); setStatusOpen(false); setAskOpen(false);
    void api.clickupTask(t.id).then((r) => { if (live) setFull(r); }).catch(() => { if (live) setFull({ ok: false, error: "Could not read the card" }); });
    return () => { live = false; };
  }, [t.id]);

  const lab = { color: "var(--text4)", width: 62 };
  const val = "text-left rounded px-1.5 py-0.5 -mx-1.5 hover:bg-white/5 truncate max-w-full";
  const line = edge(16);

  /* The statuses that are worth offering: this list's own, minus the one it is
     already in. Never a text box — an invalid status is a 400, and a status
     from another list means something else entirely. */
  const options = statuses.filter((s) => s.status !== t.status);

  const shown = useMemo(() => {
    const needle = skillQ.trim().toLowerCase();
    if (!needle) return skills;
    return skills.filter((s) => s.name.toLowerCase().includes(needle) || (s.description ?? "").toLowerCase().includes(needle));
  }, [skills, skillQ]);

  const copyId = async () => {
    try { await navigator.clipboard.writeText(t.id); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch { /* no clipboard */ }
  };

  return (
    <div>
      <h2 className="text-[14px] font-semibold leading-snug mb-1" style={{ color: "var(--text)", textWrap: "balance" }}>
        {t.title}
      </h2>
      <button onClick={() => void copyId()} className="text-[10px] mb-3 rounded px-1 -mx-1 hover:bg-white/5"
        style={{ color: "var(--text4)" }} title="Copy the card id">
        {copied ? "copied" : t.id}
      </button>

      <div className="flex flex-col gap-1 mb-3 text-[11.5px]">
        <div className="flex items-center gap-2">
          <span className="text-[10px] shrink-0" style={lab}>Status</span>
          <div className="relative">
            <button onClick={() => writable && setStatusOpen((o) => !o)} disabled={!writable || !options.length}
              className={val} style={{ color: "var(--text2)", border: writable && options.length ? line : "1px solid transparent" }}>
              {t.status || "—"}{writable && options.length ? " ▾" : ""}
            </button>
            {statusOpen && (
              <div className="absolute left-0 mt-1 rounded-lg text-[11px] shadow-2xl flex flex-col overflow-auto"
                style={{ zIndex: 30, background: "var(--bg2)", border: edge(28), minWidth: 190, maxHeight: 280 }}>
                {options.map((s) => (
                  <button key={s.status} className="text-left px-2.5 py-1.5 hover:bg-white/5 whitespace-nowrap"
                    style={{ color: s.type === "done" || s.type === "closed" ? "var(--text3)" : "var(--text2)" }}
                    onClick={() => {
                      setStatusOpen(false);
                      onAsk({
                        what: "Move this card", from: t.status, to: s.status,
                        done: `Moved to ${s.status}`,
                        go: () => api.clickupStatus(t.id, s.status, t.updated),
                      });
                    }}>{s.status}</button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[10px] shrink-0" style={lab}>Assigned</span>
          <button disabled={!writable} className={val}
            style={{ color: t.mine ? "var(--success)" : "var(--text3)", border: writable ? line : "1px solid transparent" }}
            onClick={() => onAsk({
              what: t.mine ? "Take yourself off this card" : "Put yourself on this card",
              done: t.mine ? "Taken off" : "Assigned to you",
              go: () => api.clickupAssign(t.id, !t.mine, t.updated),
            })}>
            {t.mine ? "you ✓" : (t.assignees.join(", ") || "nobody")}
          </button>
        </div>

        {t.due && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] shrink-0" style={lab}>Due</span>
            <span className="text-[11px]" style={{ color: t.due < today ? "var(--error)" : "var(--text2)" }}>
              {dueLabel(t.due, today)}
            </span>
          </div>
        )}
        {t.points != null && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] shrink-0" style={lab}>Points</span>
            <span className="text-[11px]" style={{ color: "var(--text2)" }}>{t.points}</span>
          </div>
        )}
        {!!t.tags.length && (
          <div className="flex items-start gap-2">
            <span className="text-[10px] shrink-0 mt-0.5" style={lab}>Tags</span>
            <div className="flex gap-1 flex-wrap">
              {t.tags.map((x) => (
                <span key={x} className="text-[10px] px-1.5 py-0.5 rounded-full"
                  style={{ color: "var(--text2)", background: "color-mix(in srgb, var(--text) 8%, transparent)" }}>{x}</span>
              ))}
            </div>
          </div>
        )}
        {/* Custom fields, values already resolved from ids to the words on the
            board. A field whose own NAME says not to edit it is shown and never
            offered — that warning is somebody telling every reader something the
            API has nowhere to say. */}
        {t.custom?.map((c) => {
          const spec = fields.find((f) => f.id === c.id);
          return (
            <div key={c.id} className="flex items-center gap-2">
              <span className="text-[10px] shrink-0 truncate" style={lab} title={c.name}>{c.name}</span>
              <span className="text-[11px] truncate" style={{ color: "var(--text2)" }}>
                {c.value}{spec?.readOnly ? " 🔒" : ""}
              </span>
            </div>
          );
        })}
      </div>

      {full?.description ? (
        <div className="mb-3 pt-2.5" style={{ borderTop: edge(10) }}>
          <div className="text-[8.5px] uppercase tracking-[0.18em] mb-1.5" style={{ color: "var(--text4)" }}>Description</div>
          <Markdown text={full.description} />
        </div>
      ) : full && !full.error ? null : null}

      {!!full?.subtasks?.length && (
        <div className="mb-3 pt-2.5" style={{ borderTop: edge(10) }}>
          <div className="text-[8.5px] uppercase tracking-[0.18em] mb-1.5" style={{ color: "var(--text4)" }}>
            Subtasks {full.subtasks.length}
          </div>
          {full.subtasks.map((s) => (
            <div key={s.id} className="flex items-center gap-2 py-0.5 text-[11px]">
              <span style={{ color: s.statusKind === "done" ? "var(--success)" : "var(--text4)" }}>
                {s.statusKind === "done" ? "✓" : "○"}
              </span>
              <span className="truncate" style={{ color: s.statusKind === "done" ? "var(--text4)" : "var(--text2)" }}>{s.title}</span>
            </div>
          ))}
        </div>
      )}

      {!!full?.checklists?.length && full.checklists.map((cl, i) => (
        <div key={i} className="mb-3 pt-2.5" style={{ borderTop: edge(10) }}>
          <div className="text-[8.5px] uppercase tracking-[0.18em] mb-1.5" style={{ color: "var(--text4)" }}>{cl.name}</div>
          {cl.items.map((it, j) => (
            <div key={j} className="flex items-center gap-2 py-0.5 text-[11px]">
              <span style={{ color: it.done ? "var(--success)" : "var(--text4)" }}>{it.done ? "☑" : "☐"}</span>
              <span style={{ color: it.done ? "var(--text4)" : "var(--text2)", textDecoration: it.done ? "line-through" : undefined }}>{it.name}</span>
            </div>
          ))}
        </div>
      ))}

      {!!full?.comments?.length && (
        <div className="mb-3 pt-2.5" style={{ borderTop: edge(10) }}>
          <div className="text-[8.5px] uppercase tracking-[0.18em] mb-1.5" style={{ color: "var(--text4)" }}>
            Comments {full.comments.length}
          </div>
          {full.comments.slice(-6).map((c) => (
            <div key={c.id} className="mb-2">
              <div className="text-[9.5px]" style={{ color: "var(--text4)" }}>{c.who}{c.at ? ` · ${fmtAgo(c.at)}` : ""}</div>
              <div className="text-[11px] whitespace-pre-wrap" style={{ color: "var(--text2)" }}>{c.text}</div>
            </div>
          ))}
        </div>
      )}

      {full === null && <div className="text-[10.5px] mb-3" style={{ color: "var(--text4)" }}>Reading the card…</div>}

      <div className="flex items-center gap-1.5 flex-wrap pt-2.5" style={{ borderTop: edge(10) }}>
        <div className="relative">
          <button onClick={() => setAskOpen((o) => !o)} className="text-[10.5px] px-2 py-1 rounded-lg"
            style={{ border: "1px solid color-mix(in srgb, var(--warning) 40%, transparent)", color: "var(--warning)" }}>
            Hand to Claude ▾
          </button>
          {askOpen && (
            <div className="agx-scroll absolute left-0 bottom-full mb-1 rounded-lg text-[11px] shadow-2xl flex flex-col overflow-y-auto"
              style={{ zIndex: 30, background: "var(--bg2)", border: edge(28), minWidth: 260, maxHeight: 340 }}>
              {/* Your own skills first, because running one is the thing being
                  reached for — the plain hand-offs below are the fallback for a
                  card no skill covers. */}
              {!!skills.length && (
                <>
                  <div className="px-2.5 pt-2 pb-1 flex items-center gap-2">
                    <span className="text-[8.5px] uppercase tracking-[0.16em]" style={{ color: "var(--text4)" }}>
                      Run a skill on this card
                    </span>
                    <span className="flex-1" />
                    <input value={skillQ} onChange={(e) => setSkillQ(e.target.value)} placeholder="filter"
                      spellCheck={false} autoComplete="off"
                      className="text-[10px] px-1.5 py-0.5 rounded outline-none"
                      style={{ background: "var(--bg3)", border: edge(16), color: "var(--text)", width: 92 }} />
                  </div>
                  {shown.map((sk, i) => {
                    // One heading between the ones named for it and the rest,
                    // rather than a filter that would have to be right about
                    // which of the others take a card. See namedForIt.
                    const firstOther = !namedForIt(sk) && (i === 0 || namedForIt(shown[i - 1]!));
                    const modes = skillModes(sk.argument_hint);
                    const run = (mode?: string) => {
                      setAskOpen(false);
                      const cwd = rootForTask(t.list, repos, here);
                      if (!cwd) { onNote("No checkout to run it in — give the board's list a project name that matches a repo"); return; }
                      const cmd = skillCommand(sk.name, t) + (mode ? ` ${mode}` : "");
                      // A tmux window with the agent already running it, which
                      // is the gesture the issues panel uses.
                      requestTermIssue(cwd, windowName(t), cmd, true, yolo);
                      onNote(`${cmd}${yolo ? " · permissions off" : ""} — opening a window`);
                    };
                    return (
                      <div key={sk.name}>
                      {firstOther && (
                        <div className="px-2.5 pt-2 pb-1 text-[8.5px] uppercase tracking-[0.16em]"
                          style={{ color: "var(--text4)", borderTop: edge(10) }}>Also mention ClickUp</div>
                      )}
                      <div className="px-2.5 py-1.5 hover:bg-white/5">
                        <button className="text-left w-full" title={sk.description} onClick={() => run()}>
                          <div style={{ color: "var(--warning)" }}>
                            /{sk.name.replace(/^\//, "")} <span style={{ color: "var(--text3)" }}>{t.customId || t.id}</span>
                          </div>
                          {sk.description && (
                            <div className="text-[9.5px] line-clamp-2" style={{ color: "var(--text4)" }}>{sk.description}</div>
                          )}
                        </button>
                        {/* The gears the skill itself advertises. Parsed from
                            its own invocation line, so a skill that grows a
                            third mode grows a third button here for free. */}
                        {!!modes.length && (
                          <div className="flex items-center gap-1 mt-1">
                            {modes.map((m) => (
                              <button key={m} onClick={() => run(m)}
                                className="text-[9.5px] px-1.5 py-0.5 rounded-full"
                                style={{ color: "var(--text3)", border: edge(16) }}>{m}</button>
                            ))}
                          </div>
                        )}
                      </div>
                      </div>
                    );
                  })}
                  {!shown.length && (
                    <div className="px-2.5 py-2 text-[10.5px]" style={{ color: "var(--text4)" }}>No skill matches that.</div>
                  )}
                  <div style={{ borderTop: edge(12) }} />
                </>
              )}
              <div className="px-2.5 pt-2 pb-1 text-[8.5px] uppercase tracking-[0.16em]" style={{ color: "var(--text4)" }}>
                Or hand it over to write your own
              </div>
              {HANDOFFS.map((h) => (
                <button key={h.id} className="text-left px-2.5 py-1.5 hover:bg-white/5"
                  style={{ color: "var(--text2)" }}
                  onClick={() => {
                    setAskOpen(false);
                    const cwd = rootForTask(t.list, repos, here);
                    if (!cwd) { onNote("No checkout to open a chat in"); return; }
                    onOpenChatWith?.(cwd, h.build(t, full?.description ?? ""), t.title.slice(0, 60));
                  }}>
                  <div>{h.label}</div>
                  <div className="text-[9.5px]" style={{ color: "var(--text4)" }}>{h.hint}</div>
                </button>
              ))}
              {/* Applies to a skill run, which spawns an agent — not to the
                  hand-offs above, which only put text in a composer. Sticky,
                  because whoever wants it once usually wants it all afternoon,
                  and loud, because it is the setting that lets an agent edit
                  files without asking. */}
              {!!skills.length && (
                <label className="flex items-start gap-2 px-2.5 py-2 cursor-pointer"
                  style={{ borderTop: edge(12) }}>
                  <input type="checkbox" checked={yolo} onChange={(e) => setYolo(e.target.checked)}
                    style={{ accentColor: "var(--error)", marginTop: 2 }} />
                  <span>
                    <span style={{ color: yolo ? "var(--error)" : "var(--text2)" }}>Skip permission prompts</span>
                    <span className="block text-[9.5px]" style={{ color: "var(--text4)" }}>
                      The agent edits and runs without asking. Only for a card you already trust.
                    </span>
                  </span>
                </label>
              )}
            </div>
          )}
        </div>
        <button onClick={() => void copyId()} className="text-[10.5px] px-2 py-1 rounded-lg"
          style={{ border: line, color: "var(--text2)" }}>Copy id</button>
        {t.url && (
          <a href={t.url} target="_blank" rel="noreferrer" className="text-[10.5px] px-2 py-1 rounded-lg"
            style={{ border: line, color: "var(--text2)" }}>Open ↗</a>
        )}
      </div>
    </div>
  );
}

/*
 * The ways a card can become a conversation.
 *
 * All of them land in the composer WITHOUT being sent — the property
 * `openChatWith` already guarantees and the one that matters here: a card
 * should never start a paid run because somebody clicked near it.
 *
 * The shortest one exists because it was asked for by name: sometimes all you
 * want to hand over is the id, because your own skill knows what to do with it.
 */
const HANDOFFS: { id: string; label: string; hint: string; build: (t: ProviderTask, body: string) => string }[] = [
  { id: "id", label: "Just the id", hint: "for a skill that knows what to do with it",
    build: (t) => t.id },
  { id: "brief", label: "Id and title", hint: "one line of context",
    build: (t) => `${t.id} — ${t.title}` },
  { id: "full", label: "The whole card", hint: "title, status, tags and description",
    build: (t, body) => [
      `${t.title}`,
      `card: ${t.id}${t.url ? ` · ${t.url}` : ""}`,
      [t.list ? `list: ${t.list}` : "", t.status ? `status: ${t.status}` : "", t.tags.length ? `tags: ${t.tags.join(", ")}` : ""]
        .filter(Boolean).join(" · "),
      body ? `\n${body}` : "",
    ].filter(Boolean).join("\n") },
];

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

function LocalBody({ active, repos, here, onOpenChatWith }: {
  active: boolean;
  repos: GitRepoRef[];
  /** The checkout the header is pointed at — what "here" means everywhere else. */
  here: string;
  onOpenChatWith?: (cwd: string, prompt: string, title: string) => void;
}) {
  const { data, reload } = useLocalTasks(active);
  const [sel, setSel] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [remindFor, setRemindFor] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [copiedTags, setCopiedTags] = useState<string[]>([]);
  const [sort, setSort] = useState<SortMode>("reminder");
  const [filter, setFilter] = useState<{ kind: "tag" | "project"; value: string } | null>(null);
  const [marked, setMarked] = useState<Set<string>>(() => new Set());
  const [adding, setAdding] = useState(false);
  const [bucket, setBucket] = useState<Bucket | "all" | null>(null);
  const [prio, setPrio] = useState<"H" | "M" | "L" | null>(null);
  const [keysOpen, setKeysOpen] = useState(false);
  const [tagFor, setTagFor] = useState<string>("");
  const [tagging, setTagging] = useState(false);
  const barRef = useRef<HTMLInputElement>(null);
  // Written by `takeFrame` below, so it is the nullable form rather than the
  // read-only one React hands a plain `ref={}`.
  const frameRef = useRef<HTMLDivElement | null>(null);
  const today = todayStr();
  const byTask = data?.byTask ?? {};
  const fp = data?.fingerprint;

  /**
   * Every write carries the fingerprint this list was read at.
   *
   * A conflict is not retried and not swallowed: the store moved, so the row
   * that was on screen is not the row the click meant, and the only honest
   * thing is to say so and re-render from what came back.
   */
  const write = useCallback(async (fn: () => Promise<{ ok: boolean; error?: string; conflict?: boolean }>) => {
    const r = await fn();
    if (!r.ok) setNote({ ok: false, text: r.error ?? "that did not go through" });
    else setNote(null);
    reload();
    return r.ok;
  }, [reload]);
  /*
   * Focused the moment the list enters the DOM, so the keys work without having
   * to click something first — the gesture the editor's own picker has.
   *
   * A callback ref rather than an effect, and the difference is not style: the
   * first render is a placeholder while the store is read, so an effect keyed
   * on `active` looks for the frame before it exists, finds nothing, and never
   * runs again once the tasks arrive. Measured — the frame was still null in
   * the one pass that effect ever got. A callback ref fires exactly when the
   * node is attached, so there is no instant left to guess at.
   *
   * Not while the caret is in the bar: stealing focus mid-word is worse than
   * needing one click. `preventScroll` because focusing a list must not also
   * move it.
   */
  const takeFrame = useCallback((n: HTMLDivElement | null) => {
    frameRef.current = n;
    if (!n || !active) return;
    if (document.activeElement === barRef.current) return;
    n.focus({ preventScroll: true });
  }, [active]);

  const setRemind = useCallback(async (t: LocalTask, civil: string) => {
    setRemindFor(null);
    await api.remind({ taskUuid: t.uuid, title: t.description, civil });
    await nudgeReminders();
    reload();
  }, [reload]);

  // Offered in the pickers, so a project is chosen rather than retyped — which
  // is how `@web` and `@Web` become two projects. Off the WHOLE list, not the
  // filtered one: the projects you can pick must not depend on what is being
  // shown, or filtering to one of them hides all the others.
  const picker = useMemo(() => inUse(data?.tasks ?? []), [data]);

  /*
   * Two lists, and the counts the pills show.
   *
   * The counts are taken AFTER the tag/project/search filters and BEFORE the
   * date pill, which is the only combination that reads correctly: picking
   * "Today" must not change the number on "Today", and filtering to a project
   * must change every one of them.
   */
  const { open, done, counts } = useMemo(() => {
    const all = data?.tasks ?? [];
    const keep = (t: LocalTask) => (!filter
      || (filter.kind === "tag" ? t.tags.includes(filter.value) : t.project === filter.value))
      && (!prio || t.priority === prio);
    const q = input.trim().toLowerCase();
    const matches = (t: LocalTask) => !q || t.description.toLowerCase().includes(q);
    const pending = all.filter((t) => t.status === "pending" && keep(t) && matches(t));
    const inBucket = (t: LocalTask) =>
      !bucket || bucket === "all" || dueBucket(t.due, today) === bucket;
    return {
      counts: bucketCounts(pending, today),
      open: sortTasks(pending.filter(inBucket), sort),
      done: all.filter((t) => t.status === "completed" && keep(t) && matches(t)),
    };
  }, [data, filter, prio, sort, input, bucket, today]);

  /**
   * One handler on the panel, in the capture phase.
   *
   * The bare letters are the ones his editor has; they fire only when the caret
   * is not in the bar, because a task called "done" has to be typeable. `/` and
   * `i` reach for the bar and `Escape` leaves it, which is the vocabulary the
   * rest of this app already uses.
   */
  /*
   * The rows a bulk action will act on.
   *
   * Separate from `sel`, which is where the cursor is: those are two different
   * questions and conflating them means arrowing past a row silently changes
   * what the next press will do to. Held as uuids rather than indices, because
   * the list re-sorts under you — a reminder coming due moves rows — and an
   * index set would then be pointing at whatever slid into place.
   */
  const toggleMark = useCallback((uuid: string) => {
    setMarked((cur) => {
      const next = new Set(cur);
      if (!next.delete(uuid)) next.add(uuid);
      return next;
    });
  }, []);

  /**
   * One change, applied to everything marked.
   *
   * The count comes back from the server rather than being assumed from what
   * was sent: a run can stop part-way on a store somebody else moved, and
   * "applied to 7" when three landed is the report that gets believed.
   */
  const bulk = useCallback(async (action: "done" | "priority" | "tag" | "delete", value: string | null = null) => {
    const uuids = [...marked];
    if (!uuids.length) return;
    const r = await api.taskBulk(uuids, action, value, fp);
    if (!r.ok) setNote({ ok: false, text: r.error ?? "that did not go through" });
    else {
      const n = r.applied ?? uuids.length;
      setNote({ ok: true, text: `${LABEL[action]} — ${n} task${n === 1 ? "" : "s"}` });
      setMarked(new Set());
    }
    reload();
  }, [marked, fp, reload]);

  /**
   * Somewhere to actually do the task, in the checkout it is about.
   *
   * `w` opens a plain shell there; `c` opens a chat with the task already in
   * the composer and NOT sent — a Claude run costs real tokens and should not
   * begin because a key was pressed next to the one that sorts a list. Both go
   * through machinery that already exists: the terminal is asked for a
   * directory, never for a command.
   */
  const openFor = useCallback((t: LocalTask, how: "shell" | "chat") => {
    const cwd = rootForTask(t.project, repos, here);
    if (!cwd) {
      setNote({ ok: false, text: "No checkout to open this in — give the task a project that names one" });
      return;
    }
    const name = `t${t.uuid.slice(0, 6)}`;
    if (how === "shell") { requestTermIssue(cwd, name, "", false); return; }
    if (!onOpenChatWith) { setNote({ ok: false, text: "Chat is not available here" }); return; }
    onOpenChatWith(cwd, taskPrompt(t), t.description.slice(0, 60));
  }, [repos, here, onOpenChatWith]);

  const onKey = useCallback((e: React.KeyboardEvent) => {
    // Asked of the element the key went to, not of one input we happen to know
    // about. The shortcuts are bare letters bound on the frame that CONTAINS
    // every field in this panel, so typing "comprar café" into the new-task
    // form used to run `c`, `p`, `a`, `e` — and `d`, which deletes the selected
    // task. A field added later is covered by this without anyone remembering.
    const typing = typingInto(e.target as HTMLElement | null);
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Escape") {
      barRef.current?.blur(); setEditing(null); setRemindFor(null);
      setTagging(false); setMarked(new Set());
      return;
    }
    if (typing) return;
    const list = open.concat(showDone ? done : []);
    const at = list.findIndex((t) => t.uuid === sel);
    const cur = at >= 0 ? list[at] : undefined;
    const go = (n: number) => {
      const next = list[step(at, n, list.length)];
      if (next) setSel(next.uuid);
    };
    const k = e.key;
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    // Tab marks and moves on, the gesture the editor's picker uses. It costs
    // tabbing out of the panel, which Escape gives back — and a list where the
    // only way to act on nine tasks is nine presses of the same key is the
    // reason that trade is worth making.
    if (k === "Tab" && !e.shiftKey) {
      if (!cur) { stop(); go(1); return; }
      stop(); toggleMark(cur.uuid); go(1);
    }
    else if (k === "j" || k === "ArrowDown") { stop(); go(1); }
    else if (k === "k" || k === "ArrowUp") { stop(); go(-1); }
    else if (k === "g") { stop(); if (list[0]) setSel(list[0].uuid); }
    else if (k === "G") { stop(); if (list.length) setSel(list[list.length - 1]!.uuid); }
    else if (k === "/" || k === "i") { stop(); barRef.current?.focus(); }
    else if (k === "Enter" || k === " ") {
      if (!cur) return; stop();
      void write(() => (cur.status === "completed" ? api.taskReopen(cur.uuid, fp) : api.taskDone(cur.uuid, fp)));
    }
    else if (k === "s") { stop(); setSort((m) => SORTS[(SORTS.indexOf(m) + 1) % SORTS.length]!); }
    else if (k === "f") { stop(); setFilter(null); }
    else if (k === "p") { if (!cur) return; stop(); void write(() => api.taskPriority(cur.uuid, cur.priority, fp)); }
    else if (k === "r") { if (!cur || cur.status === "completed") return; stop(); setRemindFor(cur.uuid); }
    else if (k === "e") {
      if (!cur) return; stop();
      setEditing(cur.uuid);
      setInput(toLine(cur));
      requestAnimationFrame(() => barRef.current?.focus());
    }
    else if (k === "t") {
      if (!cur) return; stop();
      setCopiedTags(cur.tags);
      setNote({ ok: true, text: cur.tags.length ? `Copied ${cur.tags.map((x) => "+" + x).join(" ")}` : "That task has no tags" });
    }
    else if (k === "v") {
      if (!cur || !copiedTags.length) { if (!copiedTags.length) setNote({ ok: false, text: "No tags copied yet — press t on a task that has some" }); return; }
      stop();
      void write(() => api.taskTags(cur.uuid, copiedTags, fp));
    }
    else if (k === "w") { if (!cur) return; stop(); openFor(cur, "shell"); }
    else if (k === "c") { if (!cur) return; stop(); openFor(cur, "chat"); }
    else if (k === "d") { if (!cur) return; stop(); void write(() => api.taskDelete(cur.uuid, fp)); }
  }, [open, done, showDone, sel, fp, write, copiedTags, toggleMark, openFor]);

  if (!data) return <div className="p-5 text-[11.5px]" style={{ color: "var(--text3)" }}>Reading your task list…</div>;
  const cap = data.capability;
  const picked = [...open, ...done].find((t) => t.uuid === sel) ?? null;


  // Every hook this component has is ABOVE this line, and must stay there. An
  // early return with a `useCallback` after it renders a different number of
  // hooks depending on whether the list is empty, which React answers with a
  // blank screen and error #310 — twice, in this file, for exactly this reason.
  if (!open.length && !done.length) return <LocalEmpty cap={cap} done={0} />;

  const od = open.filter((t) => overdue(t, today));
  const rest = open.filter((t) => !overdue(t, today));



  const rowProps = (t: LocalTask) => ({
    t, today, on: t.uuid === sel, onPick: () => setSel(t.uuid),
    marked: marked.has(t.uuid),
    onMark: () => toggleMark(t.uuid),
    reminder: byTask[t.uuid] ?? null,
    remindOpen: remindFor === t.uuid,
    onRemind: () => setRemindFor((cur) => (cur === t.uuid ? null : t.uuid)),
    onCloseRemind: () => setRemindFor(null),
    onSetRemind: (civil: string) => void setRemind(t, civil),
    onToggle: () => void write(() => (t.status === "completed" ? api.taskReopen(t.uuid, fp) : api.taskDone(t.uuid, fp))),
    writable: cap.configured,
    onFilter: (kind: "tag" | "project", value: string) => setFilter({ kind, value }),
  });

  return (
    <div ref={takeFrame} tabIndex={-1} onKeyDown={onKey}
      className="flex flex-col flex-1 min-h-0 outline-none">
      <NowBand onChanged={reload} />
      {marked.size > 0 && (
        <BulkBar n={marked.size} tagging={tagging} tag={tagFor}
          onTag={setTagFor} onTagging={setTagging}
          onRun={bulk} onClear={() => { setMarked(new Set()); setTagging(false); }} />
      )}
      {/* One field: filter and compose are the same box, because the thing you
          typed and could not find is usually the thing you meant to add. */}
      {/* Pills, a filter, then the drop-downs — the shape Pull Requests uses,
          because it is the same job: narrow a list without typing a query
          language. Everything a key does, a pointer can now do too. */}
      <div className="flex items-center gap-1.5 px-5 pt-2.5 pb-1.5 flex-wrap shrink-0">
        {BUCKETS.map((b) => (
          <button key={b.id} onClick={() => setBucket((cur) => (cur === b.id ? null : b.id))}
            aria-pressed={bucket === b.id}
            className="flex items-center gap-1.5 text-[11px] px-2.5 py-0.5 rounded-full whitespace-nowrap"
            style={bucket === b.id
              ? { background: "color-mix(in srgb, var(--primary) 18%, transparent)",
                  border: "1px solid color-mix(in srgb, var(--primary) 50%, transparent)", color: "var(--text)" }
              : { border: edge(14), color: "var(--text2)" }}>
            {b.tone && <span aria-hidden style={{ width: 6, height: 6, borderRadius: 999, background: b.tone }} />}
            {b.label}
            <span style={{ color: "var(--text3)" }}>{counts[b.id]}</span>
          </button>
        ))}
        <span className="flex-1" />
        <div className="flex rounded-lg overflow-hidden" style={{ border: edge(14) }}>
          {([false, true] as const).map((d) => (
            <button key={String(d)} onClick={() => setShowDone(d)} aria-pressed={showDone === d}
              className="text-[10.5px] px-2.5 py-0.5"
              style={showDone === d
                ? { background: "color-mix(in srgb, var(--primary) 18%, transparent)", color: "var(--text)" }
                : { color: "var(--text3)" }}>
              {d ? `Done ${done.length}` : "Open"}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2 px-5 pb-1.5 shrink-0">
        <div className="flex items-center gap-2 flex-1 min-w-0 rounded-lg px-2.5 py-1"
          style={{ background: "var(--bg2)", border: edge(14) }}>
          <span className="text-[11px] shrink-0" style={{ color: "var(--text3)" }}>⌕</span>
          <input ref={barRef} value={input} onChange={(e) => setInput(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key === "Escape") { setEditing(null); setInput(""); barRef.current?.blur(); return; }
              if (e.key !== "Enter" || !input.trim()) return;
              e.preventDefault();
              const target = editing ? [...open, ...done].find((t) => t.uuid === editing) : null;
              const ok = target
                ? await write(() => api.taskEdit(target.uuid, input, target.tags, fp))
                : await write(() => api.taskAdd(input, fp));
              if (ok) { setInput(""); setEditing(null); }
            }}
            spellCheck={false}
            placeholder={editing
              ? "Re-state the task and press Enter — what you leave out is cleared"
              : "Search your tasks"}
            className="flex-1 min-w-0 bg-transparent outline-none text-[12px]"
            style={{ color: "var(--text)", caretColor: "var(--primary)" }} />
          <ParseStrip input={input} />
        </div>
        {cap.configured && (
          <button onClick={() => setAdding((o) => !o)} aria-expanded={adding}
            className="shrink-0 text-[11.5px] px-3 py-1 rounded-lg font-medium"
            style={{ background: "color-mix(in srgb, var(--primary) 18%, transparent)",
              border: "1px solid color-mix(in srgb, var(--primary) 48%, transparent)", color: "var(--text)" }}>
            + New task
          </button>
        )}
      </div>

      <div className="flex items-center gap-1.5 px-5 pb-2 flex-wrap shrink-0">
        <Drop label="Priority" value={prio ? PRIO_NAME[prio] : null} onClear={() => setPrio(null)}
          options={(["H", "M", "L"] as const).map((p) => ({ id: p, label: PRIO_NAME[p] }))}
          onPick={(id) => setPrio(id as "H" | "M" | "L")} />
        <Drop label="Project" value={filter?.kind === "project" ? filter.value : null}
          onClear={() => setFilter(null)}
          options={picker.projects.map((x) => ({ id: x, label: x }))}
          onPick={(id) => setFilter({ kind: "project", value: id })} />
        <Drop label="Tag" value={filter?.kind === "tag" ? filter.value : null}
          onClear={() => setFilter(null)}
          options={picker.tags.map((x) => ({ id: x, label: x }))}
          onPick={(id) => setFilter({ kind: "tag", value: id })} />
        <span className="flex-1" />
        <Drop label="Sort" value={sort} onClear={null}
          options={SORTS.map((x) => ({ id: x, label: x }))}
          onPick={(id) => setSort(id as SortMode)} />
      </div>
      {adding && (
        <NewTask projects={picker.projects} tags={picker.tags}
          onAdd={(line) => write(() => api.taskAdd(line, fp))}
          onClose={() => setAdding(false)} />
      )}
      {note && (
        <div className="px-5 py-1 text-[10.5px] shrink-0" style={{
          color: note.ok ? "var(--success)" : "var(--warning)",
          background: `color-mix(in srgb, var(--${note.ok ? "success" : "warning"}) 10%, transparent)`,
        }}>{note.text}</div>
      )}
      <div className="flex flex-1 min-h-0">
      <div className="flex flex-col flex-1 min-w-0">
        {/* Named columns, so what is in each one stops being a guess. The same
            grid drives every row — see GRID. */}
        <div className="px-5 py-1 text-[8.5px] uppercase tracking-[0.16em] shrink-0"
          style={{ display: "grid", gridTemplateColumns: GRID, gap: 10, color: "var(--text4)",
            borderTop: edge(10), borderBottom: edge(10) }}>
          <span /><span>Task</span><span>Project</span><span>Due</span><span>Reminder</span><span />
        </div>
        <div className="agx-scroll flex-1 min-w-0 overflow-y-auto">
          {!open.length && !showDone && <LocalEmpty cap={cap} done={done.length} />}
          {showDone
            ? done.slice(0, 200).map((t) => <TaskRow key={t.uuid} {...rowProps(t)} />)
            : GROUPS.map(({ id, label, tone }) => {
              const rows = open.filter((t) => dueBucket(t.due, today) === id);
              if (!rows.length) return null;
              return (
                <div key={id}>
                  {/* Only when the list is actually mixed: a heading over the
                      only group there is says nothing. */}
                  {!bucket && <Section label={label} tone={tone} />}
                  {rows.map((t) => <TaskRow key={t.uuid} {...rowProps(t)} />)}
                </div>
              );
            })}
        </div>
      </div>
      <aside className="agx-scroll overflow-y-auto p-5 text-[11.5px] shrink-0"
        style={{ width: 380, borderLeft: edge(12) }}>
        {picked ? <TaskDetail t={picked} today={today} reminder={byTask[picked.uuid] ?? null}
          writable={cap.configured}
          projects={picker.projects} tags={picker.tags}
          onEdit={(patch) => { void write(() => api.taskEdit(picked.uuid, lineWith(picked, patch), picked.tags, fp)); }}
          onShell={() => openFor(picked, "shell")}
          onChat={onOpenChatWith ? () => openFor(picked, "chat") : undefined}
          onToggleNote={(oldText, newText) => { void write(() => api.taskNote(picked.uuid, oldText, newText, fp)); }}
          onCancel={async () => { const r = byTask[picked.uuid]; if (r) { await api.reminderCancel(r.id); await nudgeReminders(); reload(); } }} /> : (
          <div className="text-center p-5" style={{ color: "var(--text3)" }}>Pick a task.</div>
        )}
      </aside>
      </div>
      {/* The status bar is gone. The shortcuts still exist and still matter —
          they are just no longer the widest thing on screen, which is what made
          the panel read as a terminal. */}
      <div className="flex items-center gap-3 px-5 py-1.5 shrink-0 text-[10.5px]"
        style={{ borderTop: edge(10), color: "var(--text4)" }}>
        <span>{open.length} {open.length === 1 ? "task" : "tasks"}{counts.today ? ` · ${counts.today} today` : ""}</span>
        <span className="flex-1" />
        {keysOpen && (
          <div className="agx-scroll flex items-center gap-3 overflow-x-auto">
            {TASK_KEYS.map((k) => (
              <span key={k.keys.join()} className="whitespace-nowrap">
                <kbd style={{ color: "var(--text2)" }}>
                  {k.keys.map((x) => (x === "Escape" ? "Esc" : x)).join(" / ")}
                </kbd> {k.what}
              </span>
            ))}
          </div>
        )}
        <button onClick={() => setKeysOpen((o) => !o)} aria-expanded={keysOpen}
          className="shrink-0 px-2 py-0.5 rounded-lg" style={{ border: edge(14), color: "var(--text3)" }}>
          ⌨ {keysOpen ? "Hide" : "Shortcuts"}
        </button>
      </div>
    </div>
  );
}

const Section = ({ label, tone }: { label: string; tone: string }) => (
  <div className="text-[8.5px] uppercase tracking-[0.2em] px-5 pt-3 pb-1" style={{ color: tone }}>{label}</div>
);

function TaskRow({ t, today, on, onPick, marked, onMark, reminder, remindOpen, onRemind, onCloseRemind, onSetRemind, onToggle, writable, onFilter }: {
  t: LocalTask; today: string; on: boolean; onPick: () => void;
  reminder?: import("../../../shared/types.ts").Reminder | null;
  remindOpen?: boolean; onRemind?: () => void; onCloseRemind?: () => void; onSetRemind?: (civil: string) => void;
  onToggle?: () => void; writable?: boolean;
  marked?: boolean; onMark?: () => void;
  onFilter?: (kind: "tag" | "project", value: string) => void;
}) {
  const isDone = t.status === "completed";
  const late = overdue(t, today);
  const dueToday = t.due === today;
  const progress = checkProgress(t.notes);
  // Two different states, announced as the two different things they are:
  // `aria-current` is where the cursor sits, `aria-selected` is what a bulk
  // action would act on. Saying either with a stripe alone leaves a screen
  // reader following `j` down a list where nothing ever appears to change.
  //
  // Modifier-click marks, which is what every list does, and it means the row
  // needs no permanent checkbox competing with the one that completes it.
  const glyph = isDone ? "\u2713" : t.priority ? "\u25cf" : "\u25cb";
  const glyphTone = isDone ? "var(--text3)"
    : t.priority === "H" ? "var(--error)"
    : t.priority === "M" ? "var(--warning)" : t.priority ? "var(--text3)" : "var(--text4)";

  return (
    <div role="row" tabIndex={0}
      aria-current={on ? "true" : undefined} aria-selected={!!marked}
      onClick={(e) => { if (e.metaKey || e.ctrlKey) onMark?.(); else onPick(); }}
      onKeyDown={(e) => { if (e.key === "Enter") onPick(); }}
      className="agx-row w-full text-left px-5 py-1.5 hover:bg-white/5 cursor-pointer items-center"
      style={{
        display: "grid", gridTemplateColumns: GRID, gap: 10,
        borderBottom: edge(6),
        background: marked
          ? "color-mix(in srgb, var(--primary) 20%, transparent)"
          : on ? "color-mix(in srgb, var(--primary) 13%, transparent)" : undefined,
        boxShadow: on ? "inset 2px 0 0 0 var(--primary)" : undefined,
      }}>
      {/* The glyph is the switch. Completing is the thing done most and it
          should not need a menu; reopening is the same press, because undoing a
          misclick must be as cheap as the misclick. Marked rows put their tick
          here rather than stealing a column nobody would recognise. */}
      {marked ? (
        <button onClick={(e) => { e.stopPropagation(); onMark?.(); }} aria-label="Unmark"
          className="text-center text-[11px]" style={{ color: "var(--primary)" }}>\u2713</button>
      ) : onToggle && writable ? (
        <button onClick={(e) => { e.stopPropagation(); onToggle(); }}
          title={isDone ? "Reopen" : "Mark done"}
          aria-label={isDone ? `Reopen ${t.description}` : `Mark ${t.description} done`}
          className="text-center text-[11px] rounded" style={{ color: glyphTone }}>
          {glyph}
        </button>
      ) : (
        <span className="text-center text-[11px]" style={{ color: glyphTone }}>{glyph}</span>
      )}

      {/* The task, and under it only what qualifies it. One size larger than
          everything around it, because it is the thing being read. */}
      <div className="min-w-0">
        <div className="truncate text-[12.5px] leading-snug" title={t.description}
          style={isDone ? { textDecoration: "line-through", color: "var(--text3)" } : { color: "var(--text)" }}>
          {t.description}
        </div>
        {(t.priority || t.tags.length || progress.total > 0) && (
          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
            {t.priority && (
              <span className="text-[8.5px] tracking-[0.08em] px-1.5 rounded"
                style={t.priority === "H"
                  ? { color: "var(--error)", background: "color-mix(in srgb, var(--error) 13%, transparent)" }
                  : t.priority === "M"
                  ? { color: "var(--warning)", background: "color-mix(in srgb, var(--warning) 13%, transparent)" }
                  : { color: "var(--text3)", background: "color-mix(in srgb, var(--text) 8%, transparent)" }}>
                {t.priority === "H" ? "HIGH" : t.priority === "M" ? "MED" : "LOW"}
              </span>
            )}
            {t.tags.slice(0, 3).map((tag) => (
              <button key={tag} onClick={(e) => { e.stopPropagation(); onFilter?.("tag", tag); }}
                className="text-[9.5px] px-1.5 rounded-full"
                style={{ color: "var(--text3)", background: "color-mix(in srgb, var(--text) 7%, transparent)" }}
                title={`Only +${tag}`}>{tag}</button>
            ))}
            {progress.total > 0 && (
              <span className="text-[9.5px] px-1.5 rounded-full tabular-nums"
                style={progress.done === progress.total
                  ? { color: "var(--success)", background: "color-mix(in srgb, var(--success) 13%, transparent)" }
                  : { color: "var(--text3)", background: "color-mix(in srgb, var(--text) 7%, transparent)" }}>
                {progress.done}/{progress.total}
              </span>
            )}
          </div>
        )}
      </div>

      <span className="truncate text-[11px]">
        {t.project && (
          <button onClick={(e) => { e.stopPropagation(); onFilter?.("project", t.project!); }}
            className="truncate max-w-full" style={{ color: "var(--info)" }}
            title={`Only @${t.project}`}>{t.project}</button>
        )}
      </span>

      <span className="text-[11px] tabular-nums" style={{
        color: late ? "var(--error)" : dueToday ? "var(--warning)" : "var(--text3)",
      }}>
        {dueLabel(t.due, today)}
      </span>

      {/* A due date says when something is wanted; only a reminder will
          actually tell you. So the offer sits here rather than a blank that
          reads as "handled" — and it is an offer, not the announcement that
          nothing is going to happen. */}
      <span className="relative text-[11px] tabular-nums">
        {reminder ? (
          <span style={{ color: reminder.firedAt ? "var(--error)" : reminder.due - Date.now() < 3_600_000 ? "var(--warning)" : "var(--primary)" }}>
            ⏰ {remindLabel(reminder.due)}
          </span>
        ) : isDone ? null : (
          <button onClick={(e) => { e.stopPropagation(); onRemind?.(); }}
            className="agx-onrow px-1 rounded hover:bg-white/5"
            style={{ color: t.due ? "var(--warning)" : "var(--text4)" }}
            title="Set a reminder for this task">
            ＋ remind
          </button>
        )}
        {remindOpen && onSetRemind && onCloseRemind && (
          <RemindPopover task={t} onClose={onCloseRemind} onSet={onSetRemind} />
        )}
      </span>

      {/* One action per row, revealed on approach — the gesture the
          pull-request list already teaches with its "Review →". */}
      <span className="text-right">
        <button onClick={(e) => { e.stopPropagation(); onPick(); }}
          className="agx-onrow text-[10.5px] px-2 py-0.5 rounded-lg"
          style={{ border: edge(16), color: "var(--text2)" }}>Open →</button>
      </span>
    </div>
  );
}

/*
 * One note, with its checklist live.
 *
 * A note is one string in the store and it is replaced wholesale, so a click on
 * a box sends the WHOLE note back with one line flipped. That is why the lines
 * are rendered here rather than handed to the markdown renderer with a
 * checkbox plugin: what has to survive the round trip is the note's exact text,
 * including the lines nobody clicked, and the only way to be sure of that is to
 * never take it apart in the first place.
 *
 * Runs of prose between checklist items are kept together and given to
 * `Markdown` as one block, so a paragraph that happens to sit between two boxes
 * is still a paragraph.
 */
function Note({ text, writable, onToggle }: {
  text: string; writable?: boolean; onToggle?: (next: string) => void;
}) {
  const lines = text.split("\n");
  const boxes = lines.map((l) => checkbox(l));
  if (!boxes.some(Boolean)) return <div className="mb-3"><Markdown text={text} /></div>;

  const out: React.ReactNode[] = [];
  let prose: string[] = [];
  const flush = (key: string) => {
    if (!prose.length) return;
    const block = prose.join("\n");
    if (block.trim()) out.push(<Markdown key={key} text={block} />);
    prose = [];
  };
  lines.forEach((line, i) => {
    const box = boxes[i];
    if (!box) { prose.push(line); return; }
    flush(`p${i}`);
    const flip = () => { const next = toggleCheckbox(text, i); if (next !== null) onToggle?.(next); };
    out.push(
      <button key={`b${i}`} onClick={flip} disabled={!writable || !onToggle}
        className="w-full text-left flex items-start gap-2 py-0.5 rounded hover:bg-white/5 disabled:hover:bg-transparent"
        style={{ cursor: writable && onToggle ? "pointer" : "default" }}>
        <span aria-hidden className="shrink-0 leading-[1.45]"
          style={{ color: box.checked ? "var(--ok)" : "var(--text3)" }}>{box.checked ? "\u2611" : "\u2610"}</span>
        <span className="leading-[1.45]" style={{
          color: box.checked ? "var(--text3)" : "var(--text)",
          textDecoration: box.checked ? "line-through" : undefined,
        }}>{box.label}</span>
      </button>,
    );
  });
  flush("pEnd");
  return <div className="mb-3">{out}</div>;
}

/**
 * A filter you pick rather than type.
 *
 * The panel had one filter mechanism and it was a grammar in a text box, which
 * works beautifully once somebody has told you it exists. This is the same
 * filter with its options on screen — the pattern the pull-request view already
 * uses for Author, Label and Checks, so it is not a new idea to learn either.
 *
 * Shows the CHOSEN value in the button rather than only highlighting it: a
 * filter you cannot see is how a list ends up looking empty for no reason.
 */
function Drop({ label, value, options, onPick, onClear }: {
  label: string;
  value: string | null;
  options: { id: string; label: string }[];
  onPick: (id: string) => void;
  /** Null when the filter cannot be cleared — Sort always has a value. */
  onClear: (() => void) | null;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(open, box, () => setOpen(false));
  const on = value !== null;
  return (
    <div className="relative" ref={box}>
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} disabled={!options.length}
        className="flex items-center gap-1.5 text-[11px] px-2.5 py-0.5 rounded-lg whitespace-nowrap disabled:opacity-40"
        style={on
          ? { background: "color-mix(in srgb, var(--primary) 14%, transparent)",
              border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)", color: "var(--text)" }
          : { border: edge(14), color: "var(--text2)" }}>
        {label}{on && <span style={{ color: "var(--primary)" }}>{value}</span>}
        <span style={{ color: "var(--text4)" }}>▾</span>
      </button>
      {open && (
        <div className="absolute left-0 mt-1 rounded-lg text-[11.5px] shadow-2xl flex flex-col overflow-auto"
          style={{ zIndex: 30, background: "var(--bg2)", border: edge(28), minWidth: 160, maxHeight: 300 }}>
          {onClear && (
            <button onClick={() => { onClear(); setOpen(false); }}
              className="text-left px-2.5 py-1.5 hover:bg-white/5" style={{ color: "var(--text3)" }}>
              Any {label.toLowerCase()}
            </button>
          )}
          {options.map((o) => (
            <button key={o.id} onClick={() => { onPick(o.id); setOpen(false); }}
              className="text-left px-2.5 py-1.5 hover:bg-white/5 whitespace-nowrap"
              style={{ color: o.label === value ? "var(--text)" : "var(--text2)",
                background: o.label === value ? "color-mix(in srgb, var(--primary) 14%, transparent)" : undefined }}>
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The four answers to "when", plus everything. Ordered by how soon it matters,
 *  which is also the order somebody scans them in. */
const BUCKETS: { id: Bucket | "all"; label: string; tone?: string }[] = [
  { id: "late", label: "Overdue", tone: "var(--error)" },
  { id: "today", label: "Today", tone: "var(--warning)" },
  { id: "week", label: "This week" },
  { id: "none", label: "No date" },
  { id: "all", label: "All" },
];

const PRIO_NAME: Record<"H" | "M" | "L", string> = { H: "High", M: "Medium", L: "Low" };

/** One column definition for the header and every row, so they cannot drift
 *  apart — which is the failure that makes a table look broken rather than
 *  merely misaligned. */
const GRID = "22px 1fr 120px 86px 104px 74px";

/** The order the list is read in: what is late, what is now, then the rest. */
const GROUPS: { id: Bucket; label: string; tone: string }[] = [
  { id: "late", label: "Overdue", tone: "var(--error)" },
  { id: "today", label: "Today", tone: "var(--warning)" },
  { id: "week", label: "This week", tone: "var(--text3)" },
  { id: "later", label: "Later", tone: "var(--text3)" },
  { id: "none", label: "No date", tone: "var(--text3)" },
];

/*
 * Making a task without knowing the grammar.
 *
 * The bar can already do this — `!h #3 +tag @project` and Enter — and that is
 * the fast way once you know it. It is also invisible: the bar wears a
 * magnifying glass and its placeholder starts with the word "Filter", so
 * somebody who has not read it has no reason to believe a task can be made
 * there at all. This is the same act with the fields named.
 *
 * It builds the very line the bar would have been given and hands it to the
 * same verb, so there is one write path rather than two that drift.
 *
 * Inline rather than a modal: the list stays on screen, which is what tells you
 * whether the thing you are adding is already there three rows down.
 */
function NewTask({ projects, tags, onAdd, onClose }: {
  projects: string[]; tags: string[];
  onAdd: (line: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<"H" | "M" | "L" | null>(null);
  const [project, setProject] = useState("");
  const [tagText, setTagText] = useState("");
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { first.current?.focus(); }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!description.trim() || busy) return;
    setBusy(true);
    const line = lineWith(
      { description: "", priority: null, project: null, due: null, tags: [] } as unknown as LocalTask,
      {
        description: description.trim(),
        priority,
        project: project.trim() || null,
        due: due || null,
        // Split on spaces and commas both, because both are what people type.
        tags: tagText.split(/[,\s]+/).map((x) => x.replace(/^\+/, "").trim()).filter(Boolean),
      },
    );
    const ok = await onAdd(line);
    setBusy(false);
    if (ok) onClose();
  };

  const field = { background: "var(--bg2)", border: edge(18), color: "var(--text)" };
  const label = "text-[8.5px] uppercase tracking-[0.18em] mb-1 block";
  return (
    <form id="agx-new" onSubmit={submit} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}
      className="px-5 py-3 flex flex-col gap-2.5"
      style={{ borderBottom: edge(12), background: "color-mix(in srgb, var(--primary) 6%, transparent)" }}>
      <div>
        <label className={label} style={{ color: "var(--text3)" }} htmlFor="nt-desc">What needs doing</label>
        <input id="nt-desc" ref={first} value={description} onChange={(e) => setDescription(e.target.value)}
          placeholder="Describe the task" spellCheck={false} autoComplete="off"
          className="w-full text-[12px] px-2 py-1.5 rounded-lg outline-none" style={field} />
      </div>
      <div className="flex items-end gap-2 flex-wrap">
        <div>
          <span className={label} style={{ color: "var(--text3)" }}>Priority</span>
          <div className="flex items-center gap-1">
            {([null, "L", "M", "H"] as const).map((p) => (
              <button key={p ?? "none"} type="button" onClick={() => setPriority(p)}
                aria-pressed={priority === p}
                className="text-[10.5px] px-2 py-1 rounded-lg"
                style={priority === p
                  ? { background: "color-mix(in srgb, var(--primary) 20%, transparent)",
                      border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)", color: "var(--text)" }
                  : { border: edge(18), color: "var(--text3)" }}>
                {p === null ? "None" : p === "L" ? "Low" : p === "M" ? "Medium" : "High"}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className={label} style={{ color: "var(--text3)" }} htmlFor="nt-proj">Project</label>
          <input id="nt-proj" list="agx-projects" value={project} onChange={(e) => setProject(e.target.value)}
            placeholder="none" spellCheck={false} autoComplete="off"
            className="text-[11px] px-2 py-1 rounded-lg outline-none" style={{ ...field, width: 150 }} />
        </div>
        <div>
          <label className={label} style={{ color: "var(--text3)" }} htmlFor="nt-tags">Tags</label>
          <input id="nt-tags" list="agx-tags" value={tagText} onChange={(e) => setTagText(e.target.value)}
            placeholder="space separated" spellCheck={false} autoComplete="off"
            className="text-[11px] px-2 py-1 rounded-lg outline-none" style={{ ...field, width: 170 }} />
        </div>
        <div>
          <label className={label} style={{ color: "var(--text3)" }} htmlFor="nt-due">Due</label>
          <input id="nt-due" type="date" value={due} onChange={(e) => setDue(e.target.value)}
            className="text-[11px] px-2 py-1 rounded-lg outline-none" style={field} />
        </div>
        <datalist id="agx-projects">{projects.map((p) => <option key={p} value={p} />)}</datalist>
        <datalist id="agx-tags">{tags.map((t) => <option key={t} value={t} />)}</datalist>
        <div className="flex items-center gap-1.5 ml-auto">
          <button type="button" onClick={onClose} className="text-[10.5px] px-2.5 py-1 rounded-lg"
            style={{ color: "var(--text3)" }}>Cancel</button>
          <button type="submit" disabled={!description.trim() || busy}
            className="text-[10.5px] px-3 py-1 rounded-lg disabled:opacity-40"
            style={{ background: "color-mix(in srgb, var(--primary) 20%, transparent)",
              border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)", color: "var(--text)" }}>
            {busy ? "Adding…" : "Add task"}
          </button>
        </div>
      </div>
    </form>
  );
}

/*
 * What to do with the rows you marked.
 *
 * Only on screen when something is marked: a permanently visible strip of
 * destructive buttons over a list is a thing to mis-click, and this one carries
 * Delete. Deleting is placed apart from the rest and coloured for the same
 * reason — it is the only one of these that Taskwarrior cannot undo from here.
 *
 * The count is the heading rather than a footnote, because the whole risk of a
 * bulk action is acting on more than you thought you had.
 */
function BulkBar({ n, tagging, tag, onTag, onTagging, onRun, onClear }: {
  n: number; tagging: boolean; tag: string;
  onTag: (v: string) => void; onTagging: (v: boolean) => void;
  onRun: (action: "done" | "priority" | "tag" | "delete", value?: string | null) => void;
  onClear: () => void;
}) {
  const btn = "text-[10.5px] px-2 py-1 rounded-lg whitespace-nowrap";
  const quiet = { border: edge(18), color: "var(--text2)" };
  return (
    <div className="flex items-center gap-1.5 px-4 py-2 flex-wrap"
      style={{ borderBottom: edge(10), background: "color-mix(in srgb, var(--primary) 8%, transparent)" }}>
      <span className="text-[11px] font-medium mr-1" style={{ color: "var(--text)" }}>
        {n} selected
      </span>
      {tagging ? (
        <form className="flex items-center gap-1.5"
          onSubmit={(e) => { e.preventDefault(); if (tag.trim()) { onRun("tag", tag.trim()); onTagging(false); onTag(""); } }}>
          <input autoFocus value={tag} onChange={(e) => onTag(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onTagging(false); onTag(""); } }}
            placeholder="tag to add" spellCheck={false}
            className="text-[10.5px] px-2 py-1 rounded-lg outline-none"
            style={{ background: "var(--bg2)", border: edge(20), color: "var(--text)", width: 140 }} />
          <button type="submit" className={btn} style={quiet}>Add</button>
        </form>
      ) : (
        <>
          <button className={btn} style={quiet} onClick={() => onRun("done")}>Complete</button>
          {(["H", "M", "L"] as const).map((p) => (
            <button key={p} className={btn} style={quiet} onClick={() => onRun("priority", p)}>
              {p === "H" ? "High" : p === "M" ? "Medium" : "Low"}
            </button>
          ))}
          <button className={btn} style={quiet} onClick={() => onRun("priority", "")}>No priority</button>
          <button className={btn} style={quiet} onClick={() => onTagging(true)}>Tag…</button>
          <button className={btn} onClick={() => onRun("delete")}
            style={{ border: "1px solid color-mix(in srgb, var(--bad) 40%, transparent)", color: "var(--bad)" }}>
            Delete
          </button>
        </>
      )}
      <button className={`${btn} ml-auto`} style={{ color: "var(--text3)" }} onClick={onClear}>
        Clear
      </button>
    </div>
  );
}

/*
 * The task's fields, as controls rather than as a caption.
 *
 * These were chips that only reported. Everything they report was settable —
 * by `p`, by `e`, by retyping the line — and only by somebody who had been told
 * which keys those were. Each control here rebuilds the whole line through
 * `lineWith` and sends it to the same `edit` verb the bar uses, so the pointer
 * and the keyboard cannot drift apart.
 *
 * Nothing is staged and there is no Save: a click IS the edit. Staging would
 * mean holding a copy of a task that another writer is free to change
 * underneath, which is the state this whole panel is built to avoid.
 */
function TaskFields({ t, today, projects, tags, onEdit }: {
  t: LocalTask; today: string; projects: string[]; tags: string[];
  onEdit: (patch: Partial<Pick<LocalTask, "priority" | "project" | "due" | "tags">>) => void;
}) {
  const [addingTag, setAddingTag] = useState(false);
  const [tagText, setTagText] = useState("");
  const [editingProject, setEditingProject] = useState(false);
  const [projectText, setProjectText] = useState(t.project ?? "");
  const [editingDue, setEditingDue] = useState(false);

  const lab = { color: "var(--text4)", width: 62 };
  const field = { background: "var(--bg2)", border: edge(18), color: "var(--text)" };
  /* A value you can change looks like one: quiet until the pointer is on it,
     then it shows its edge. A row of boxed inputs reads as a settings screen,
     which is what this pane looked like. */
  const val = "text-left rounded px-1.5 py-0.5 -mx-1.5 hover:bg-white/5 truncate max-w-full";

  return (
    <div className="flex flex-col gap-1 mb-3.5 text-[11.5px]">
      <div className="flex items-center gap-2">
        <span className="text-[10px] shrink-0" style={lab}>Priority</span>
        <div className="flex items-center gap-1">
          {([null, "L", "M", "H"] as const).map((p) => (
            <button key={p ?? "none"} onClick={() => onEdit({ priority: p })} aria-pressed={t.priority === p}
              className="text-[10px] px-2 py-0.5 rounded-lg"
              style={t.priority === p
                ? { background: "color-mix(in srgb, var(--primary) 20%, transparent)",
                    border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)", color: "var(--text)" }
                : { border: edge(14), color: "var(--text3)" }}>
              {p === null ? "None" : PRIO_NAME[p]}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-[10px] shrink-0" style={lab}>Due</span>
        {editingDue ? (
          <input autoFocus type="date" value={t.due ?? ""}
            onChange={(e) => { onEdit({ due: e.target.value || null }); setEditingDue(false); }}
            onBlur={() => setEditingDue(false)}
            className="text-[11px] px-1.5 py-0.5 rounded-lg outline-none" style={field} />
        ) : (
          <div className="flex items-center gap-1 min-w-0">
            <button className={val} onClick={() => setEditingDue(true)}
              style={{ color: t.due ? (overdue(t, today) ? "var(--error)" : t.due === today ? "var(--warning)" : "var(--text2)") : "var(--text4)" }}>
              {t.due ? `${dueLabel(t.due, today)}${overdue(t, today) ? " · overdue" : ""}` : "no date"}
            </button>
            {t.due && (
              <button onClick={() => onEdit({ due: null })} title="Clear the due date"
                className="agx-onrow text-[11px] px-1" style={{ color: "var(--text4)" }}>×</button>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <span className="text-[10px] shrink-0" style={lab}>Project</span>
        {editingProject ? (
          <form onSubmit={(e) => { e.preventDefault(); onEdit({ project: projectText.trim() || null }); setEditingProject(false); }}>
            <input autoFocus list="agx-projects" value={projectText} spellCheck={false} autoComplete="off"
              onChange={(e) => setProjectText(e.target.value)}
              onBlur={() => { onEdit({ project: projectText.trim() || null }); setEditingProject(false); }}
              onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setEditingProject(false); setProjectText(t.project ?? ""); } }}
              className="text-[11px] px-1.5 py-0.5 rounded-lg outline-none" style={{ ...field, width: 150 }} />
          </form>
        ) : (
          <button className={val} onClick={() => { setProjectText(t.project ?? ""); setEditingProject(true); }}
            style={{ color: t.project ? "var(--info)" : "var(--text4)" }}>
            {t.project || "none"}
          </button>
        )}
      </div>

      <div className="flex items-start gap-2">
        <span className="text-[10px] shrink-0 mt-1" style={lab}>Tags</span>
        <div className="flex items-center gap-1 flex-wrap min-w-0">
          {t.tags.map((tag) => (
            <span key={tag} className="text-[10px] pl-2 pr-1 py-0.5 rounded-full flex items-center gap-1"
              style={{ color: "var(--text2)", background: "color-mix(in srgb, var(--text) 8%, transparent)" }}>
              {tag}
              <button onClick={() => onEdit({ tags: t.tags.filter((x) => x !== tag) })}
                title={`Remove ${tag}`} style={{ color: "var(--text4)" }}>×</button>
            </span>
          ))}
          {addingTag ? (
            <form onSubmit={(e) => {
              e.preventDefault();
              const fresh = tagText.split(/[,\s]+/).map((x) => x.replace(/^\+/, "").trim()).filter(Boolean);
              if (fresh.length) onEdit({ tags: [...new Set([...t.tags, ...fresh])] });
              setTagText(""); setAddingTag(false);
            }}>
              <input autoFocus list="agx-tags" value={tagText} spellCheck={false} autoComplete="off"
                onChange={(e) => setTagText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setAddingTag(false); setTagText(""); } }}
                placeholder="tag" className="text-[11px] px-1.5 py-0.5 rounded-lg outline-none"
                style={{ ...field, width: 110 }} />
            </form>
          ) : (
            <button onClick={() => setAddingTag(true)} className="text-[10px] px-1.5 py-0.5 rounded-full"
              style={{ color: "var(--text4)" }}>＋ tag</button>
          )}
        </div>
        <datalist id="agx-projects">{projects.map((p) => <option key={p} value={p} />)}</datalist>
        <datalist id="agx-tags">{tags.map((x) => <option key={x} value={x} />)}</datalist>
      </div>
    </div>
  );
}

function TaskDetail({ t, today, reminder, onCancel, writable, onToggleNote, onShell, onChat, onEdit, projects, tags }: {
  t: LocalTask; today: string;
  reminder?: import("../../../shared/types.ts").Reminder | null;
  onCancel?: () => void;
  writable?: boolean;
  onToggleNote?: (oldText: string, newText: string) => void;
  onShell?: () => void;
  onChat?: () => void;
  /** One field changed. The line is rebuilt from the whole task, so nothing
   *  that was not touched is lost — see `lineWith`. */
  onEdit?: (patch: Partial<Pick<LocalTask, "priority" | "project" | "due" | "tags">>) => void;
  projects?: string[]; tags?: string[];
}) {
  const progress = checkProgress(t.notes);
  return (
    <div>
      <h2 className="text-[16px] font-semibold leading-snug mb-2.5" style={{ color: "var(--text)", textWrap: "balance" }}>
        {t.description}
      </h2>
      {onEdit && writable
        ? <TaskFields t={t} today={today} projects={projects ?? []} tags={tags ?? []} onEdit={onEdit} />
        : (
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
        )}
      {/* Grey, always. This line used to inherit the overdue colour, so a task
          that was late reported the day it was CREATED in error red. */}
      <div className="text-[10px] mb-4" style={{ color: "var(--text4)" }}>
        {[
          t.completed && `completed ${dueLabel(t.completed, today)}`,
          t.created && `created ${dueLabel(t.created, today)}`,
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
      {(onShell || onChat) && (
        <div className="flex items-center gap-1.5 mb-4">
          {onShell && (
            <button onClick={onShell} className="text-[10.5px] px-2 py-1 rounded-lg"
              style={{ border: edge(18), color: "var(--text2)" }} title="w">
              Shell here
            </button>
          )}
          {onChat && (
            <button onClick={onChat} className="text-[10.5px] px-2 py-1 rounded-lg"
              style={{ border: edge(18), color: "var(--text2)" }} title="c — the prompt waits in the composer, unsent">
              Ask Claude
            </button>
          )}
        </div>
      )}
      {!!t.notes.length && (
        <>
          <div className="text-[8.5px] uppercase tracking-[0.2em] mb-1.5 flex items-center gap-2" style={{ color: "var(--text3)" }}>
            Notes
            {progress.total > 0 && (
              <span style={{ color: progress.done === progress.total ? "var(--ok)" : "var(--text3)" }}>
                {progress.done}/{progress.total}
              </span>
            )}
          </div>
          {t.notes.map((n, i) => (
            <Note key={i} text={n} writable={writable}
              onToggle={onToggleNote ? (next) => onToggleNote(n, next) : undefined} />
          ))}
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

/**
 * What the parser is about to keep, shown before Enter.
 *
 * The grammar is lossy by design — `+word` becomes a tag and leaves the text —
 * and the only place that is dangerous is when the user meant the literal
 * characters. Rendering the parse as it is typed makes that visible while it
 * can still be undone, which is the difference between a shortcut and a trap.
 */
function ParseStrip({ input }: { input: string }) {
  const p = useMemo(() => parseLocal(input), [input]);
  if (!input.trim()) return null;
  const seg = (text: string, color: string) => (
    <span key={text} style={{ color }}>{text}</span>
  );
  const bits = [
    p.description ? seg(`"${p.description}"`, "var(--text2)") : null,
    p.priority ? seg(`!${p.priority}`, "var(--warning)") : null,
    ...p.tags.map((t) => seg(`+${t}`, "var(--text3)")),
    p.project ? seg(`@${p.project}`, "var(--info)") : null,
    p.due ? seg(`→ ${p.due.slice(5)}`, "var(--text3)") : null,
  ].filter(Boolean);
  if (!p.description && bits.length) {
    return <span className="text-[10px] shrink-0" style={{ color: "var(--error)" }}>That is all labels and no task.</span>;
  }
  return (
    <span className="text-[10px] shrink-0 flex items-center gap-2 overflow-hidden whitespace-nowrap">
      {bits}
    </span>
  );
}

