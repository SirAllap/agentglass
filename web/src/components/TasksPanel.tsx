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
import type { GitRepoRef, IssueDetail, IssuePr, IssueRow, IssueWork, StartMode, LocalTask, TaskCapability, TasksListResponse, SkillInfo } from "../../../shared/types.ts";
import type { ProviderTask, ProviderTasksResponse, SavedView, ViewTasksResponse, ListStatus, ListField, ListPlace, ListMember, TaskDetail } from "../../../shared/providers.ts";
import { ViewHeader } from "./workspace/ViewHeader.tsx";
import { useDismiss } from "../lib/useDismiss.ts";
import { Markdown } from "../lib/markdown.tsx";
import { fmtAgo } from "../lib/format.ts";
import { StatusPill } from "./StatusPill.tsx";
import { Spinner } from "./Spinner.tsx";
import { requestTermIssue } from "../lib/termIssue.ts";
import { openSettings } from "../lib/openSettings.ts";
import { handoffTo, setHandoffTo, type HandoffTo } from "../lib/handoffTo.ts";
import { openPrs } from "../lib/openPrs.ts";
import type { CardJump } from "../lib/openCard.ts";
import type { IssueJump } from "../lib/openIssue.ts";
import { TASK_SOURCES, shownTaskSources, subscribeTaskSources, type TaskSourceId } from "../lib/taskSources.ts";
import { externalUrl, openExternal } from "../lib/externalUrl.ts";
import { ContextMenu, MenuItem } from "./ContextMenu.tsx";
import { cardSkills, skillCommand, windowName, skillModes, namedForIt, shortName } from "../lib/cardSkills.ts";
import { subscribeReminders, liveReminders, nudgeReminders } from "../lib/reminderStore.ts";
import { parseLocal, toLine, sortTasks, step, checkbox, toggleCheckbox, checkProgress, rootForTask, taskPrompt, lineWith, inUse, typingInto, dueBucket, bucketCounts, dueLabel, stamp, TASK_KEYS, SORTS, type SortMode, type Bucket } from "../lib/taskGrammar.ts";
import { useSyncExternalStore } from "react";
import { CloseButton } from "./CloseButton.tsx";
import { ICON } from "../lib/iconSize.ts";

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
type SourceId = "all" | TaskSourceId;
/* Shown whether or not each one is CONNECTED, and that is deliberate: a tab
   that only appears once you have found Settings is a feature nobody
   discovers. Unconnected, it says what to do and links to the pane that does
   it. Which ones appear at all is a preference — see lib/taskSources.ts. */
const sourceTabs = (shown: TaskSourceId[]): { id: SourceId; label: string }[] => [
  // "All" only when there is more than one thing for it to be all of.
  ...(shown.length > 1 ? [{ id: "all" as const, label: "All" }] : []),
  ...TASK_SOURCES.filter((s) => shown.includes(s.id)).map((s) => ({ id: s.id as SourceId, label: s.label })),
];

/** What a finished bulk run says it did. Past tense, and the same words as the
 *  buttons, so the confirmation is recognisably the thing that was pressed. */
const LABEL: Record<string, string> = {
  done: "Completed", priority: "Priority set", tag: "Tagged", delete: "Deleted",
};


export function TasksView({ active, onOpenChatWith, cardJump, issueJump }: {
  active: boolean;
  onOpenChatWith?: (cwd: string, prompt: string, title: string) => void;
  /** A pull request asking for the card it came from — see lib/openCard.ts.
   *  It arrives as a prop rather than a subscription because this view is
   *  mounted the first time somebody comes here, which may be the click that
   *  sent it: a store read at mount would be a race, a prop is not. */
  cardJump?: CardJump | null;
  /** A pull request asking for the issue it closes. Same arrangement and same
   *  reason as `cardJump` — see lib/openIssue.ts. */
  issueJump?: IssueJump | null;
}) {
  const [repos, setRepos] = useState<GitRepoRef[]>([]);
  const [root, setRoot] = useState("");
  const shown = useSyncExternalStore(subscribeTaskSources, shownTaskSources, shownTaskSources);
  /*
   * A source somebody hid, put back for as long as they are being shown a card
   * from it.
   *
   * Without this the jump lands nowhere and says nothing: the effect below sets
   * the source to "clickup", the reconcile effect above finds no such tab on
   * the next render and steps to the first one there is, and pressing a card id
   * on a pull request quietly opens GitHub Issues instead. Hiding a source is a
   * preference about the TAB BAR, not a refusal to ever see a card again — and
   * the person most likely to have hidden ClickUp is exactly the person a
   * ClickUp address in a pull-request body can still send here.
   *
   * The preference itself is never rewritten. The tab is here while the errand
   * is, and gone again the moment they pick another one.
   */
  const [forced, setForced] = useState<TaskSourceId | null>(null);
  const tabs = useMemo(
    () => sourceTabs(forced && !shown.includes(forced) ? [...shown, forced] : shown),
    [shown, forced],
  );
  const [source, setSource] = useState<SourceId>("all");
  /* Standing on a source that has just been hidden — or on "All" when only one
     source is left — is standing on a tab that is no longer there. Step to the
     first one that is. */
  useEffect(() => {
    if (!tabs.some((t) => t.id === source)) setSource(tabs[0]?.id ?? "all");
  }, [tabs, source]);

  useEffect(() => {
    if (!active) return;
    api.gitRepos().then(({ repos: r }) => {
      setRepos(r);
      setRoot((cur) => (cur && r.some((x) => x.root === cur) ? cur : (r[0]?.root ?? "")));
    }).catch(() => {});
  }, [active]);

  /* Somebody asked for a ClickUp card, so show them the ClickUp tab. Only the
     tab is decided here — WHICH card is the board's business, and it is handed
     the same errand to finish. The count is watched rather than the object, so
     asking for the card you are already looking at still puts you back on this
     tab if you have since wandered to another source. */
  useEffect(() => {
    if (!cardJump) return;
    setForced("clickup");
    setSource("clickup");
  }, [cardJump?.n]);

  /* The same errand for a GitHub issue. "All" would do — it renders the issue
     list too — but the tab it belongs to is the honest place to land: what
     arrives is one issue, and "All" is where you go to see everything at once.
     Neither this nor the card jump writes the remembered tab. */
  useEffect(() => {
    if (!issueJump) return;
    setForced("github");
    setSource("github");
  }, [issueJump?.n]);

  return (
    <div className="flex flex-col h-full min-h-0">
      <ViewHeader label="Tasks">
        <nav className="flex items-center gap-0.5" aria-label="Sources">
          {tabs.map((s) => (
            // Picking a tab by hand ends the errand, which is what takes a
            // borrowed tab back off the bar — see `forced`.
            <button key={s.id} onClick={() => { setForced(null); setSource(s.id); }}
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
        {/*
          * No repo picker. Switching checkout here never changed which issues
          * you saw: they come from the GitHub remote, and every worktree of a
          * project shares that one remote — so the control offered a dozen ways
          * to look at the same list. All it really moved was the directory `gh`
          * ran in and where `issueStart` would cut a worktree, and for both of
          * those the answer that is always right is the project itself, which
          * is what `repos[0]` already is under an open project.
          */}
      </ViewHeader>
      {source === "local" ? <LocalBody active={active} repos={repos} here={root} onOpenChatWith={onOpenChatWith} />
      : source === "clickup" ? <ClickUpBody active={active} repos={repos} here={root} onOpenChatWith={onOpenChatWith} jump={cardJump} />
      : (
        <div className="flex flex-col flex-1 min-h-0">
          {source === "all" && <NowBand onChanged={() => {}} />}
          {source === "all" && <LocalStrip active={active} onOpen={() => setSource("local")} />}
          {root ? <IssuesBody key={root} root={root} active={active} jump={issueJump} /> : (
            <div className="p-5 text-[11.5px]" style={{ color: "var(--text3)" }}>No repository to read issues from.</div>
          )}
        </div>
      )}
    </div>
  );
}


function IssuesBody({ root, active, jump }: { root: string; active: boolean; jump?: IssueJump | null }) {
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

  /*
   * Serve a "show me this issue" from the pull-request panel.
   *
   * Waits for the list, and not out of politeness: an issue that is closed —
   * which is most of what a merged pull request points at — has no row under
   * the default "open" filter, so selecting it would open the detail beside a
   * list that visibly does not contain it. Widening to "all" is the same
   * courtesy the ClickUp board does when a jump lands on a card its filters
   * hide.
   *
   * `n` is what is compared, so the same issue asked for twice is served twice;
   * the ref starts at 0, which no request ever is.
   */
  const served = useRef(0);
  useEffect(() => {
    if (!jump || !rows || jump.n === served.current) return;
    served.current = jump.n;
    setSel(jump.number);
    if (!rows.some((r) => r.number === jump.number)) setState("all");
  }, [jump?.n, rows]);

  const workFor = useMemo(() => new Map(work.map((w) => [w.number, w])), [work]);
  // No timer here any more: NoteStrip owns its own life, and two timers over
  // one note is the first one cutting the second one short.
  const say = (ok: boolean, text: string) => setNote({ ok, text });

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

      {note && <NoteStrip note={note} onClose={() => setNote(null)} />}

      <div className="flex-1 min-h-0 flex">
        <div className="flex flex-col min-w-0" style={{ width: "48%", borderRight: edge(12) }}>
          {error && <div className="p-4 text-[11.5px]" style={{ color: "var(--error)" }}>{error}</div>}
          {!rows && !error && <div className="p-4"><Spinner label="Asking GitHub…" className="" /></div>}
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
          {work && <span className="shrink-0 text-[10px] px-1.5 rounded-full"
            style={{ color: "var(--warning)", border: "1px solid color-mix(in srgb, var(--warning) 45%, transparent)" }}>in progress</span>}
        </div>
        <div className="flex items-center gap-1.5 mt-1 flex-wrap">
          {i.labels.slice(0, 4).map((l) => (
            <span key={l.name} className="text-[8.5px] px-1.5 rounded-full"
              style={{ color: `#${l.color || "8b949e"}`, border: `1px solid color-mix(in srgb, #${l.color || "8b949e"} 45%, transparent)` }}>{l.name}</span>
          ))}
          <span className="text-[10px] ml-auto" style={{ color: "var(--text4)" }}>{fmtAgo(new Date(i.updatedAt).getTime())}</span>
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

  /* The pull requests for this issue, asked for separately so the description
     is on screen without waiting on a second round trip to GitHub. */
  const [prs, setPrs] = useState<IssuePr[]>([]);
  const [prsErr, setPrsErr] = useState(false);
  useEffect(() => {
    let live = true;
    setPrs([]); setPrsErr(false);
    api.issuePrs(root, number)
      .then((r) => { if (live) { setPrs(r.prs ?? []); setPrsErr(!r.ok); } })
      .catch(() => { if (live) setPrsErr(true); });
    return () => { live = false; };
  }, [root, number]);

  const act = async (fn: () => Promise<{ ok: boolean; error?: string; detail?: string; dirty?: string[] }>) => {
    setBusy(true);
    const r = await fn();
    setBusy(false);
    if (!r.ok && r.dirty) { setConfirm(r.dirty); return; }
    onSay(r.ok, r.ok ? (r.detail ?? "done") : (r.error ?? "failed"));
    if (r.ok) { load(); onChanged(); }
  };

  if (err) return <div className="p-5 text-[11.5px]" style={{ color: "var(--error)" }}>{err}</div>;
  if (!d) return <div className="p-5"><Spinner label="Reading…" className="" /></div>;

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

      {/* The pull requests this issue produced.
          The mirror of the pull-request sidebar's "Merging this closes", and
          the reason the pair is worth having: standing on an issue, the
          question is almost always "is somebody already on this", and the
          answer was a trip to a browser.

          Better founded than the ClickUp version of the same row. That one
          searches GitHub for a card id and depends on the team naming its
          branches after it; this is a real edge in GitHub's own graph. Which
          is why the two claims are kept apart — a pull request LINKED to this
          issue will close it, one that merely mentions it has promised
          nothing. */}
      {(!!prs.length || prsErr) && (
        <div className="mb-4 pt-3" style={{ borderTop: edge(10) }}>
          <div className="text-[8.5px] uppercase tracking-[0.18em] mb-1.5 flex items-center gap-2" style={{ color: "var(--text4)" }}>
            Pull requests {!!prs.length && <span>{prs.length}</span>}
            {prsErr && <span style={{ color: "var(--warning)" }}>· could not ask GitHub — this is not “none”</span>}
          </div>
          {prs.map((p) => (
            <div key={p.number} className="flex items-center gap-2 py-1">
              <button onClick={() => openPrs(String(p.number), p.state === "OPEN" ? "open" : "all")}
                className="text-left flex-1 min-w-0 rounded px-1 -mx-1 hover:bg-white/5"
                title="Open this in Pull Requests">
                <span className="tabular-nums" style={{ color: "var(--primary)" }}>#{p.number}</span>
                <span className="ml-1.5 text-[10px] tracking-[0.06em] px-1.5 rounded"
                  style={p.state === "MERGED"
                    ? { color: "#a371f7", background: "#a371f721" }
                    : p.state === "CLOSED"
                    ? { color: "var(--error)", background: "color-mix(in srgb, var(--error) 13%, transparent)" }
                    : { color: "var(--success)", background: "color-mix(in srgb, var(--success) 13%, transparent)" }}>
                  {p.draft ? "DRAFT" : p.state}
                </span>
                {/* Said only of the ones it is true of. A row with nothing here
                    mentioned the issue and made no promise about it. */}
                {p.linked && (
                  <span className="ml-1.5 text-[10px]" style={{ color: "var(--text4)" }}
                    title="linked to this issue on GitHub — merging it closes this">closes this</span>
                )}
                <div className="truncate text-[10.5px]" style={{ color: "var(--text3)" }}>{p.title || p.url}</div>
              </button>
              <a href={externalUrl(p.url)} target="_blank" rel="noreferrer noopener"
                className="agx-btn text-[10px] px-1.5 py-0.5 rounded shrink-0"
                style={{ color: "var(--text3)", border: edge(20) }} title="Open on GitHub">↗</a>
            </div>
          ))}
        </div>
      )}

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
function ClickUpBody({ active, repos, here, onOpenChatWith, jump }: {
  active: boolean;
  repos: GitRepoRef[];
  here: string;
  onOpenChatWith?: (cwd: string, prompt: string, title: string) => void;
  /** "Show me this card" — from the pull-request masthead. See lib/openCard.ts. */
  jump?: CardJump | null;
}) {
  const [boards, setBoards] = useState<{ views: SavedView[]; current?: string; writeEnabled: boolean; writeForced?: boolean } | null>(null);
  const [data, setData] = useState<ViewTasksResponse | null>(null);
  const [busy, setBusy] = useState(false);
  /** The board somebody just clicked, before its answer arrives. See `load`. */
  const [wanted, setWanted] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  /* Right-click on a board pill. `editing` is set when the errand is "change
     this board's address" rather than "add another", so the same bar serves
     both — prefilled, and replacing instead of appending. */
  const [menu, setMenu] = useState<{ v: SavedView; x: number; y: number } | null>(null);
  const [editing, setEditing] = useState<SavedView | null>(null);
  /** Put the address bar away, whatever it was in the middle of. */
  const closeAddBar = useCallback(() => { setAdding(false); setEditing(null); setUrlText(""); }, []);
  const [urlText, setUrlText] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [q, setQ] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const [mineOnly, setMineOnly] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Pending | null>(null);
  const [statusPick, setStatusPick] = useState<string[]>([]);
  const [confirmWrite, setConfirmWrite] = useState(false);
  const [readyOnly, setReadyOnly] = useState(false);
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  /*
   * The cards you have gone and fetched by id, which are not a board.
   *
   * They used to be shown at the top of whichever board happened to be open,
   * under "fetched by id". Every word of that was true and the picture was
   * still wrong: a card from `Platform / Bugs` sitting inside
   * `Guest checkout v2` reads as a card that IS in Guest checkout v2 — one row
   * above the real ones, in the same list, on a board it has nothing to do
   * with.
   *
   * So they get a place of their own: a provisional board beside the real ones,
   * grouped by where each card actually lives, each removable, and gone when
   * the app closes. It is a history of what you looked up, not a list anybody
   * owns — which is exactly what it should look like.
   */
  const [looked, setLooked] = useState<ProviderTask[]>([]);
  /** Whether that provisional board is the one on screen. Held apart from the
   *  real selection (`data.view.id`) because it is not one of them. */
  const [onLooked, setOnLooked] = useState(false);
  /* What each list this board has shown us accepts, keyed by list id. Filled on
     demand — see the effect below — and kept for the session, because opening
     the same card twice should not cost the rate budget twice. */
  const [listMeta, setListMeta] = useState<Record<string, { statuses: ListStatus[]; fields: ListField[]; place?: ListPlace }>>({});
  /* Some cards are a page of prose with tables in them. Remembered, because
     whoever needs the room needs it for the whole board, not for one card. */
  const [wide, setWide] = useState(() => {
    try { return localStorage.getItem(WIDE_KEY) === "1"; } catch { return false; }
  });
  useEffect(() => { try { localStorage.setItem(WIDE_KEY, wide ? "1" : "0"); } catch { /* private mode */ } }, [wide]);
  const [finding, setFinding] = useState(false);
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

  /*
   * `asked` is what somebody CLICKED, held separately from what is on screen.
   *
   * Without it a board switch is invisible: the chip's selected state comes from
   * the response, so the one you pressed stays unlit and the previous board's
   * rows stay put until the answer lands. On a view that is a second, which
   * reads as a lag. On "Assigned to me" it is twelve, which reads as a dead
   * button — and the second click sends a second request.
   *
   * The background poll deliberately does NOT set it. A progress bar that
   * appears every sixty seconds on its own is not progress, it is a flicker.
   */
  /**
   * Watch our own server until the background read lands.
   *
   * The server answers from its cache and starts a read behind it; nobody would
   * ever SEE that read arrive without asking again. So we ask — our own server,
   * which costs ClickUp nothing and answers in a millisecond. It stops the
   * moment the timestamp moves, and gives up rather than waiting forever on a
   * read that failed.
   *
   * Declared before `load` uses it, deliberately: a `const` read from a closure
   * is safe, and this file has already cost this app a black screen once over
   * exactly that kind of ordering question. Not worth making a reader check.
   */
  const settling = useRef<number>(0);
  const settle = useCallback(async (id: string, was: number) => {
    const run = ++settling.current;
    // 45s: past the twelve the workspace-wide read takes, and past a retry.
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      if (settling.current !== run) return; // something else was asked for
      try {
        const r = await api.clickupView(id, false);
        if (settling.current !== run) return;
        if (r.at > was || !r.revalidating) { setData(r); return; }
      } catch { return; }
    }
  }, []);

  const load = useCallback(async (id?: string, force = false, asked = false) => {
    setBusy(true);
    if (asked && id) setWanted(id);
    try {
      const r = await api.clickupView(id, force);
      setData(r);
      if (r.revalidating && r.view?.id) void settle(r.view.id, r.at);
    } catch {
      setData({ tasks: [], statuses: [], fields: [], at: 0, error: "Could not reach the server" });
    } finally { setBusy(false); setWanted(null); }
  }, [settle]);

  useEffect(() => { if (active) { void loadBoards(); void load(); } }, [active, loadBoards, load]);

  /*
   * Whether finished work is hidden is a property of the BOARD, not of the tab.
   *
   * On a board you work from, hiding it is right: "in production" and "won't
   * fix" are not work you owe, and they outnumber the rest within a month.
   * On "Assigned to me" it is wrong, and visibly so — it is meant to be the My
   * Work page, and that page shows all thirteen. Hiding six of them silently
   * turned it into a different list that happens to share a name, which is
   * exactly how it was read: as statuses that had gone missing.
   *
   * Set once per board you land on, so an explicit toggle survives the poll.
   */
  /** What this board costs to ask, which is what decides how often we do. */
  const pollMs = data?.view?.builtin ? CU_POLL_SLOW_MS : CU_POLL_MS;

  const landedOn = useRef<string | null>(null);
  useEffect(() => {
    const id = data?.view?.id;
    if (!id || landedOn.current === id) return;
    landedOn.current = id;
    setShowDone(!!data?.view?.builtin);
    /* An open address bar belongs to the board it was opened from. Left alone
       it stays on screen carrying the PREVIOUS board's address, over a board it
       has nothing to do with — and "Change" would then edit the one you are no
       longer looking at. Closing it is the only reading that cannot be wrong. */
    closeAddBar();
  }, [data?.view?.id, data?.view?.builtin]);
  /*
   * One minute, matching the server's own cache.
   *
   * Polling faster cannot produce a fresher answer — the server would serve the
   * same snapshot — it can only spend the rate budget finding that out. Paused
   * while the tab is hidden, like everything else here.
   */
  useEffect(() => {
    if (!active) return;
    /*
     * `document.hidden` was the whole test, and useLive.ts already wrote down
     * why that is not enough: a desktop window has no tab to background, so the
     * flag is false for the entire life of the process. This panel's normal
     * place is behind the terminal the agent runs in — so the old test meant a
     * board re-read itself every minute, all day, for nobody. Focus is the
     * signal that works in both a browser and the app.
     */
    const looking = () => !document.hidden && document.hasFocus();
    const tick = () => {
      if (!looking()) return;
      // Age, not ticks. Asking our own server is free, but it is the thing that
      // makes the server ask ClickUp, so the client keeps its own floor too.
      if (data?.at && Date.now() - data.at < pollMs) return;
      void load(data?.view?.id);
    };
    /*
     * Two minutes, and it usually decides to do nothing.
     *
     * This is no longer a poll in any meaningful sense: the server serves from
     * disk and refreshes on its own schedule, so a tick that finds the data
     * inside its window returns without a single request leaving the machine.
     * What is left is a heartbeat that catches the case nothing else does — a
     * window left focused and untouched for hours.
     *
     * The listener does the real work. Coming back to the window is when a
     * stale board matters, and it is exactly when nothing else would notice.
     */
    const t = setInterval(tick, 120_000);
    window.addEventListener("focus", tick);
    return () => { clearInterval(t); window.removeEventListener("focus", tick); };
  }, [active, load, data?.view?.id, data?.at, pollMs]);

  const addBoard = async () => {
    if (!urlText.trim()) return;
    setBusy(true);
    // The same bar, two errands. Replacing resolves the new address before it
    // drops the old board, so a typo leaves the bar exactly as it was.
    const r = editing
      ? await api.clickupReplaceView(editing.id, urlText.trim())
      : await api.clickupAddView(urlText.trim());
    setBusy(false);
    if (!r.ok) { setNote({ ok: false, text: r.error ?? "That did not work" }); return; }
    setUrlText(""); setAdding(false); setEditing(null); setNote(null);
    await loadBoards();
    await load(r.view?.id, true);
  };

  /** Take a board off the bar. The built-in one has no address and cannot go. */
  const dropBoard = async (v: SavedView) => {
    setMenu(null);
    await api.clickupRemoveView(v.id).catch(() => {});
    setNote({ ok: true, text: `${v.listName || v.name} is off this bar — untouched in ClickUp` });
    await loadBoards();
    if (data?.view?.id === v.id) await load(undefined, true);
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

  /*
   * What is standing in a card's way, resolved against the board itself.
   *
   * Dependencies arrive as ids. Almost all of them are cards on the same board,
   * so they are looked up here rather than fetched — a list of 36 would
   * otherwise mean 36 extra calls against a 100-a-minute budget. Only the ones
   * that are NOT finished count: a card waiting on something already in
   * production is not blocked, it is ready, and saying otherwise is the kind of
   * warning people learn to ignore.
   */
  const byId = useMemo(() => new Map((data?.tasks ?? []).map((t) => [t.id, t])), [data]);
  const blockedBy = useCallback((t: ProviderTask) =>
    (t.waitsOn ?? []).map((id) => byId.get(id)).filter((x): x is ProviderTask => !!x && x.statusKind !== "done"),
  [byId]);

  const rows = useMemo(() => {
    const all = data?.tasks ?? [];
    const needle = q.trim().toLowerCase();
    return all.filter((t) =>
      // An explicit pick overrides the done/not-done default: asking to see
      // "in production" and getting nothing would be absurd.
      (statusPick.length ? statusPick.includes(t.status) : (showDone || t.statusKind !== "done"))
      && (!mineOnly || t.mine)
      && (!tag || t.tags.includes(tag))
      && (!readyOnly || !blockedBy(t).length)
      && (!needle || t.title.toLowerCase().includes(needle)));
  }, [data, q, tag, mineOnly, showDone, statusPick, readyOnly, blockedBy]);

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
      ready: all.filter((t) => t.statusKind !== "done" && !blockedBy(t).length).length,
    };
  }, [data, blockedBy]);

  // A bare number, or a prefixed id. Loose on purpose — the server decides
  // what is really a card, and being asked is cheaper than not being offered.
  const looksLikeId = /^\s*([A-Za-z][\w]*-)?\d{3,}\s*$/.test(q);

  /**
   * Show a card by id, wherever it turns out to live.
   *
   * Three answers, in the order that costs least and tells the truth soonest:
   *
   *   on the board you are looking at   select the row. Nothing else moves.
   *   on another board you have         go to that board and select it there.
   *   anywhere else                     fetch it, and put it in Looked up.
   *
   * The middle one is the point. Somebody who opens a card from a pull request
   * should land where that card actually is when the app already knows — a
   * stray copy above an unrelated board would be a second, worse answer to a
   * question that had a good one. It is free: the server answers from the cache
   * it already holds.
   */
  const reveal = useCallback(async (text?: string) => {
    const asked = (text ?? q).trim();
    if (!asked) return;
    const want = asked.toLowerCase();
    const here = (data?.tasks ?? []).find((t) =>
      t.id.toLowerCase() === want || (t.customId ?? "").toLowerCase() === want);
    if (here) { setOnLooked(false); setSel(here.id); setNote(null); return; }
    setFinding(true);
    try {
      const held = await api.clickupWhere(asked).catch(() => ({ ok: false } as { ok: boolean; viewId?: string; task?: ProviderTask }));
      if (held.ok && held.viewId && held.task) {
        setOnLooked(false);
        setNote(null);
        setSel(held.task.id);
        await load(held.viewId, false, true);
        return;
      }
      const r = await api.clickupFind(asked);
      if (r.ok && r.task) {
        const task = r.task;
        // Newest first, and only once however many times you ask for it: this
        // is a history of what you looked at, not a tally of how often.
        setLooked((cur) => [task, ...cur.filter((t) => t.id !== task.id)].slice(0, LOOKED_MAX));
        setOnLooked(true);
        setSel(task.id);
        setNote(null);
      } else setNote({ ok: false, text: r.error ?? "Could not find that card" });
    } catch { setNote({ ok: false, text: "Could not reach the server" }); }
    finally { setFinding(false); }
  }, [q, data, load]);

  /*
   * Serve a "show me this card" from the pull-request panel.
   *
   * The board is asked first, and not as an optimisation: a card that is on it
   * is shown in its own row, in its own status group, with everything around it
   * — which is what somebody who pressed a card id was going to look at. Only a
   * card that is genuinely elsewhere is fetched on its own.
   *
   * `data` has to have arrived, or the board would be asked before it knows
   * anything and every jump would become a fetch. `n` is what is compared, so
   * the same card asked for twice is served twice; the ref starts at 0, which no
   * request ever is, so one that arrived while this was still mounting is not
   * dropped.
   */
  const served = useRef(0);
  useEffect(() => {
    if (!jump || !data || jump.n === served.current) return;
    served.current = jump.n;
    void reveal(jump.query);
  }, [jump?.n, data, reveal]);

  /* `data.tasks`, not `rows`: a card can be selected without being visible —
     a jump can land on one the board's filters hide — and reading the selection
     out of the FILTERED list would blank the detail pane. */
  /*
   * Hand a card over from its row, without opening it.
   *
   * The same two destinations and the same remembered preference the card's own
   * hand-off uses — one answer in this panel to "where does this go", so the
   * choice you made in the card is still the choice a fortnight later in a row.
   * The row can only send the whole card: the three shapes are something you
   * weigh while reading one, and a right-click is not that moment.
   */
  const handCard = useCallback((t: ProviderTask) => {
    const cwd = rootForTask(t.list, repos, here);
    if (!cwd) { setNote({ ok: false, text: "No checkout to hand this to — no repo matches that list" }); return; }
    const text = `${t.customId || t.id} — ${t.title}`;
    if (handoffTo() === "term") {
      requestTermIssue(cwd, windowName(t), text, true, false, t.title);
      setNote({ ok: true, text: `${t.customId || t.id} handed to a pane` });
    } else if (onOpenChatWith) onOpenChatWith(cwd, text, t.title.slice(0, 60));
    else setNote({ ok: false, text: "Chat is not available here" });
  }, [repos, here, onOpenChatWith]);

  const picked = [...(data?.tasks ?? []), ...looked].find((t) => t.id === sel) ?? null;

  /*
   * A card from a list this board is not.
   *
   * On "Assigned to me" that is every card — its rows come from a dozen lists —
   * and on any board it is the one you fetched by id. Both cases had the same
   * bug: the status picker offered the BOARD's statuses, so moving such a card
   * either 400s ("Status not found") or, worse, lands it in a status that means
   * something else on the list it actually lives in.
   *
   * So the card's own list is asked, once, when you open it. Two calls against a
   * hundred-a-minute budget, on an explicit click, remembered for the session.
   */
  const otherList = picked?.listId && picked.listId !== data?.view?.listId ? picked.listId : null;
  useEffect(() => {
    if (!otherList || listMeta[otherList]) return;
    let gone = false;
    void api.clickupList(otherList)
      .then((r) => {
        if (gone || !r.ok) return;
        setListMeta((m) => ({ ...m, [otherList]: { statuses: r.statuses ?? [], fields: r.fields ?? [], place: r.place } }));
      })
      .catch(() => { /* the card still reads; it just cannot be moved from here */ });
    return () => { gone = true; };
  }, [otherList, listMeta]);
  const cardStatuses = otherList ? (listMeta[otherList]?.statuses ?? []) : (data?.statuses ?? []);
  const cardFields = otherList ? (listMeta[otherList]?.fields ?? []) : (data?.fields ?? []);
  /* The card's own breadcrumb once its list has answered, and the list NAME the
     task already carries until then — so the line appears immediately and fills
     in, rather than popping into existence two calls later. */
  const cardPlace: ListPlace | undefined = otherList
    ? (listMeta[otherList]?.place ?? (picked?.list ? { list: picked.list } : undefined))
    : data?.place;
  /* …but only on the card when it says something the bar does not. On a pasted
     board every row is from the board's own list, so the two breadcrumbs would
     be the same three words twice on one screen; on the built-in board they are
     never the same, which is the whole reason the card carries one. */
  const cardPlaceShown = otherList || !data?.place ? cardPlace : undefined;

  const anyWho = (data?.tasks ?? []).some((t) => t.assignees.length);
  const anySprint = (data?.tasks ?? []).some((t) => t.sprint);
  const anyEst = (data?.tasks ?? []).some((t) => t.estimateHours);
  const grid = cuGrid(anyWho, anySprint, anyEst);

  /* The looked-up cards, by where each one lives. The search box filters these
     too — it is the only chip that still means anything on this board. */
  const lookedGroups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const by = new Map<string, ProviderTask[]>();
    for (const t of looked) {
      if (needle && !t.title.toLowerCase().includes(needle) && !(t.customId ?? "").toLowerCase().includes(needle)) continue;
      const k = t.list || "Elsewhere";
      (by.get(k) ?? by.set(k, []).get(k)!).push(t);
    }
    return [...by.entries()].map(([place, rows]) => ({ place, rows }));
  }, [looked, q]);

  /* One group per status that HAS something, ordered by the board's own
     workflow rather than alphabetically or by count — a board is read in the
     order work moves through it. */
  const groups = useMemo(() => {
    const order = new Map((data?.statuses ?? []).map((s, i) => [s.status, { i, color: s.color, type: s.type }]));
    const by = new Map<string, ProviderTask[]>();
    for (const t of rows) {
      const k = t.status || "—";
      (by.get(k) ?? by.set(k, []).get(k)!).push(t);
    }
    return [...by.entries()]
      .map(([status, list]) => ({
        status,
        rows: list,
        color: order.get(status)?.color ?? list[0]?.statusColor,
        done: (order.get(status)?.type ?? "") === "done" || (order.get(status)?.type ?? "") === "closed",
        points: list.reduce((n, t) => n + (t.points ?? 0), 0),
        i: order.get(status)?.i ?? 999,
      }))
      .sort((a, b) => a.i - b.i);
  }, [rows, data?.statuses]);

  if (!boards) return <div className="p-5"><Spinner label="Reading your boards…" className="" /></div>;

  /* There is always at least one board now — the built-in one — so the question
     the first screen answers is no longer "have you added anything" but "did the
     one you did not have to add come back with nothing". Which, on a machine
     where ClickUp is not connected yet, it will. */
  if (!boards.views.some((v) => !v.builtin) && data?.error && !data.tasks.length) {
    return <AddFirstBoard value={urlText} onValue={setUrlText} onAdd={addBoard} busy={busy}
      note={note} why={data.error} />;
  }

  /* What the bar should look pressed on: what you asked for if you asked for
     something, and otherwise what is actually loaded. */
  const lit = wanted ?? data?.view?.id;
  /* The rows on screen belong to a board other than the one being fetched. */
  const stale = !!wanted && wanted !== data?.view?.id;
  /*
   * Whether to draw the wait over the list, rather than beside it.
   *
   * Not `stale` alone, which is what the first version used and what a probe
   * caught: switching boards was covered, but opening the panel cold was not —
   * there is no PREVIOUS board then, so nothing was "stale", and a first read
   * of the built-in board spent twelve seconds showing an empty list under a
   * two-pixel line. Empty is the case that needs the explanation most.
   *
   * The exception is a re-read of the board you are already looking at: its
   * rows are real and still true, so they stay uncovered and the bar carries it.
   */
  const veiled = !!wanted && (stale || !data?.tasks.length);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* One bar, not three. The old layout spent 216 pixels before the first
          task — boards, then search, then filters, then column headings — on a
          list of 36 rows of which 13 fitted. Boards and controls now share a
          line, and the search shares the next with the filters. */}
      <div className="flex items-center gap-1.5 px-4 pt-2 pb-1.5 flex-wrap shrink-0">
        {boards.views.map((v) => (
          <button key={v.id} onClick={() => { setSel(null); setOnLooked(false); closeAddBar(); void load(v.id, false, true); }}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu({ v, x: e.clientX, y: e.clientY }); }}
            aria-pressed={!onLooked && lit === v.id}
            aria-busy={wanted === v.id}
            className="flex items-center gap-1.5 text-[11px] px-2.5 py-0.5 rounded-full whitespace-nowrap max-w-[240px]"
            style={lit === v.id
              ? { background: "color-mix(in srgb, var(--primary) 18%, transparent)",
                  border: "1px solid color-mix(in srgb, var(--primary) 50%, transparent)", color: "var(--text)" }
              : { border: edge(14), color: "var(--text2)" }}
            title={v.builtin
              ? "Every card assigned to you, across the workspace — the same list as ClickUp's My Work. Slower than a board (it asks the whole workspace), so it opens on what you last saw."
              : v.listName ? `${v.listName} · ${v.name}` : v.name}>
            {/* The built-in one is marked, because "Assigned to me" beside four
                board names reads as a fifth board somebody added — and it is the
                one that behaves differently: no address, no removing it, and it
                takes ten seconds rather than one. */}
            {v.builtin && (
              <span aria-hidden className={`shrink-0${wanted === v.id ? " animate-pulse" : ""}`} style={{
                width: 7, height: 7, borderRadius: 999,
                border: `1.5px solid ${lit === v.id ? "var(--primary)" : "var(--text4)"}`,
              }} />
            )}
            <span className="truncate">{v.listName || v.name}</span>
            {/* On the chip itself, because that is where the eye is when the
                click lands — and where it stays for the next twelve seconds. */}
            {wanted === v.id && (
              <span className="shrink-0 animate-pulse" style={{ color: "var(--text3)" }}>…</span>
            )}
          </button>
        ))}
        {/* The same button both ways round. It used to open the address bar and
            then keep saying "＋", so the only way out was Escape — a key nobody
            is told about, on a bar with no other exit. */}
        <button onClick={() => { setAdding((o) => !o); if (adding) { setUrlText(""); setNote(null); } }}
          aria-expanded={adding}
          className="text-[11px] px-2 py-0.5 rounded-full"
          style={{ border: edge(14), color: adding ? "var(--text2)" : "var(--text3)" }}
          title={adding ? "Never mind" : "Add a board by pasting its address"}>
          {adding ? "✕" : "＋"}
        </button>
        {/* The cards you went and fetched, as their own board.
            Dashed, and only there while it holds something: this is not a list
            anybody owns, it is where you have been. Beside the real boards
            rather than inside one, which is the whole point — a card from
            another list sitting in someone's sprint reads as being IN it. */}
        {looked.length > 0 && (
          <span className="flex items-center rounded-full"
            style={onLooked
              ? { background: "color-mix(in srgb, var(--primary) 14%, transparent)", border: "1px dashed color-mix(in srgb, var(--primary) 55%, transparent)" }
              : { border: `1px dashed color-mix(in srgb, var(--text) 26%, transparent)` }}>
            <button onClick={() => { setOnLooked(true); setSel(looked[0]?.id ?? null); }}
              aria-pressed={onLooked}
              className="flex items-center gap-1.5 text-[11px] pl-2.5 pr-1.5 py-0.5 whitespace-nowrap"
              style={{ color: onLooked ? "var(--text)" : "var(--text2)" }}
              title="Cards you have opened by id. They are not on any of your boards — this is where you have been, and it is forgotten when the app closes.">
              <span aria-hidden style={{ color: "var(--text3)" }}>⌕</span>
              Looked up
              <span className="tabular-nums" style={{ color: "var(--text3)" }}>{looked.length}</span>
            </button>
            <CloseButton onClick={() => { setLooked([]); setOnLooked(false); }} title="Forget them" style={{ color: "var(--text4)" }} className="pr-2 pl-0.5" />
          </span>
        )}
        {/* Where this board sits, beside the chip that chose it — which is where
            ClickUp puts it and where it was first asked for. It shares the
            chips' line rather than taking one of its own: this panel spent 216
            pixels above the first task once, and the way back was refusing to
            add rows. The built-in board has no single place, so it shows none
            rather than inventing one. */}
        {/* Nothing, rather than the LAST board's, while another is on its way.
            A breadcrumb is a claim about where you are; keeping the previous
            one through a switch makes it a wrong one. */}
        <Breadcrumb place={stale ? undefined : data?.place} className="min-w-0 max-w-[420px] pl-1" />
        <span className="flex-1" />
        <button onClick={async () => {
            const on = !boards.writeEnabled;
            if (on && !confirmWrite) { setConfirmWrite(true); return; }
            setConfirmWrite(false);
            await api.clickupSetWrites(on);
            await loadBoards();
            setNote({ ok: true, text: on ? "Changes to ClickUp are now allowed" : "Back to read-only" });
          }}
          title={boards.writeForced ? "Forced on by AGENTGLASS_CLICKUP_WRITE=1" : boards.writeEnabled ? "Changes are allowed — click to stop that" : "Let this app change cards on your board"}
          className="text-[10px] px-2 py-0.5 rounded-full"
          style={boards.writeEnabled
            ? { color: "var(--warning)", border: "1px solid color-mix(in srgb, var(--warning) 40%, transparent)" }
            : { color: "var(--text4)", border: edge(12) }}>
          {boards.writeEnabled ? "can edit" : "read-only"}
        </button>
        {/* When it was read AND how long that answer stands for. A timestamp on
            its own answers half the question: the other half is whether the
            thing is about to correct itself or has been sitting there since
            this morning. Both are stated, and the exact instant is on hover. */}
        {data?.at ? (
          <span className="text-[10px] flex items-center gap-1"
            title={`Read at ${new Date(data.at).toLocaleString()}. Re-reads itself every ${Math.round(pollMs / 60_000) || 1}${pollMs >= 60_000 ? " min" : "s"} while this window has focus, and when you come back to it — never behind your back. Refresh forces it now.`}
            style={{ color: "var(--text4)" }}>
            <span>{stamp(data.at)}</span>
            {/* A read running behind rows that are already good. Said quietly
                and next to their age, which is the thing it is about to fix —
                not as a spinner over content nobody asked to have taken away. */}
            {data.revalidating
              ? <span className="animate-pulse" style={{ color: "var(--primary)" }}>· refreshing</span>
              : <span style={{ opacity: 0.65 }}>· auto {pollMs >= 60_000 ? `${Math.round(pollMs / 60_000)}m` : `${Math.round(pollMs / 1000)}s`}</span>}
          </span>
        ) : null}
        {/* The board itself, in a browser. Every row already links to its own
            card; the thing that had no way out was the board — which is where
            you go to do anything this panel does not do. Rendered only when
            there is an address to open: the built-in board has none until it
            has been read once, and a link that goes nowhere is worse than no
            link. `externalUrl` rather than the raw string — see its file. */}
        {externalUrl(data?.view?.url) && (
          <a href={externalUrl(data?.view?.url)} target="_blank" rel="noreferrer noopener"
            title={`Open ${data?.view?.name ?? "this board"} in ClickUp`}
            className="text-[10.5px] px-2 py-0.5 rounded-lg"
            style={{ border: edge(16), color: "var(--text2)" }}>
            Open ↗
          </a>
        )}
        <button onClick={() => void load(data?.view?.id, true, true)} disabled={busy}
          className="text-[10.5px] px-2 py-0.5 rounded-lg"
          style={{ border: edge(16), color: "var(--text2)", opacity: busy ? 0.5 : 1 }}>
          {busy ? <span className="inline-block animate-spin">⟳</span> : "Refresh"}
        </button>
      </div>

      {/*
        * A read in progress, said in the two ways it needs saying.
        *
        * The bar is the "something is happening" that a click owes you back
        * within a frame. The sentence is the part a spinner cannot carry: this
        * particular board asks an entire workspace and takes about ten seconds,
        * and a person who does not know that reads a long spinner as a hang.
        * Only for a read somebody ASKED for — the sixty-second poll stays
        * silent, because a bar that appears on its own is a flicker, not
        * progress.
        */}
      {wanted && (
        <div className="shrink-0" role="status" aria-live="polite">
          <div aria-hidden style={{ height: 2, overflow: "hidden", background: "color-mix(in srgb, var(--primary) 12%, transparent)" }}>
            <div className="agx-indeterminate" style={{ height: "100%", background: "var(--primary)" }} />
          </div>
          {/* Only when nothing else is saying it. A board being re-read has its
              own rows on screen and no veil over them, so this line is the only
              sign; a board that gets the veil is already told, at more length. */}
          {!veiled && boards.views.find((v) => v.id === wanted)?.builtin && (
            <div className="px-5 py-1 text-[10.5px]" style={{ color: "var(--text3)" }}>
              Re-reading everything assigned to you across the workspace — about ten seconds.
            </div>
          )}
        </div>
      )}

      {confirmWrite && (
        <div className="px-5 py-2 shrink-0 flex items-center gap-3 flex-wrap"
          style={{ background: "color-mix(in srgb, var(--warning) 9%, transparent)", borderBottom: edge(10) }}>
          <div className="text-[11.5px]" style={{ color: "var(--text2)" }}>
            <b style={{ color: "var(--warning)" }}>Allow changes to this board?</b>
            <div className="text-[10.5px]" style={{ color: "var(--text3)" }}>
              Moving a card or assigning yourself fires your workspace's automations and notifies your
              team. Each change still asks first. There is no undo from here.
            </div>
          </div>
          <span className="flex-1" />
          <button onClick={async () => { setConfirmWrite(false); await api.clickupSetWrites(true); await loadBoards(); }}
            className="text-[11px] px-3 py-1 rounded-lg"
            style={{ background: "color-mix(in srgb, var(--warning) 22%, transparent)",
              border: "1px solid color-mix(in srgb, var(--warning) 50%, transparent)", color: "var(--text)" }}>
            Allow
          </button>
          <button onClick={() => setConfirmWrite(false)} className="text-[11px] px-2 py-1 rounded-lg"
            style={{ color: "var(--text3)" }}>Cancel</button>
        </div>
      )}
      {/* Right-click on a board. The app has had a good context menu since the
          rail was built and it was private to that file — this is the second
          surface to use it, and the first that needed something the bar had no
          room for. */}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {menu.v.builtin ? (
            <div className="px-2 py-1.5 text-[10.5px] max-w-[220px]" style={{ color: "var(--text4)" }}>
              This one is built in — no address to change, and it cannot be removed.
            </div>
          ) : (
            <>
              <MenuItem onClick={() => { setEditing(menu.v); setUrlText(menu.v.url); setAdding(true); setNote(null); setMenu(null); }}>
                Change address…
              </MenuItem>
              {externalUrl(menu.v.url) && (
                <MenuItem onClick={() => { void navigator.clipboard?.writeText(menu.v.url).catch(() => {}); setMenu(null); setNote({ ok: true, text: "Address copied" }); }}>
                  Copy address
                </MenuItem>
              )}
            </>
          )}
          {externalUrl(menu.v.url) && (
            <MenuItem onClick={() => { openExternal(menu.v.url); setMenu(null); }}>Open in ClickUp ↗</MenuItem>
          )}
          {/* Named for what it does and, more importantly, for what it does
              not. "Remove" beside a board that lives in somebody's company
              workspace is a word worth being precise about: this writes to a
              file on this machine and never calls ClickUp. The line underneath
              says so, because a destructive-looking red item with no
              reassurance is one people do not press even when they want to. */}
          {!menu.v.builtin && (
            <>
              <MenuItem danger onClick={() => void dropBoard(menu.v)}>Take off this bar</MenuItem>
              <div className="px-2 pb-1 text-[9.5px] max-w-[220px]" style={{ color: "var(--text4)" }}>
                Only here — the board and its cards stay exactly as they are in ClickUp.
              </div>
            </>
          )}
        </ContextMenu>
      )}
      {adding && (
        <AddBoardBar value={urlText} onValue={setUrlText} onAdd={addBoard}
          onClose={closeAddBar}
          busy={busy} editing={editing?.listName || editing?.name || null} />
      )}

      <div className="flex items-center gap-1.5 px-4 pb-1.5 flex-wrap shrink-0">
        <div className="flex items-center gap-2 flex-1 min-w-[220px] rounded-lg px-2.5 py-1"
          style={{ background: "var(--bg2)", border: edge(14) }}>
          <span className="text-[11px] shrink-0" style={{ color: "var(--text3)" }}>⌕</span>
          <input value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && looksLikeId) void reveal(); }}
            spellCheck={false}
            placeholder={onLooked ? "Filter what you have looked up" : "Search this board, or type a card id"}
            className="flex-1 min-w-0 bg-transparent outline-none text-[12px]"
            style={{ color: "var(--text)", caretColor: "var(--primary)" }} />
        </div>
        {/* Every chip from here on reads the BOARD — its ready count, its
            statuses, its tags. On Looked up they would be filtering a list they
            know nothing about, so they stand down rather than sit there inert. */}
        {!onLooked && <>
        {/* The six of thirty-six that nothing is in the way of. On a board this
            dependent, that is the only question worth asking first: what can I
            actually start? */}
        <button onClick={() => setReadyOnly((v) => !v)} aria-pressed={readyOnly}
          title="Cards nothing unfinished is blocking"
          className="text-[11px] px-2.5 py-0.5 rounded-full whitespace-nowrap"
          style={readyOnly
            ? { background: "color-mix(in srgb, var(--primary) 18%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)", color: "var(--text)" }
            : { border: edge(14), color: "var(--text2)" }}>
          ready <span style={{ color: "var(--text3)" }}>{counts.ready}</span>
        </button>
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
        <StatusFilter statuses={data?.statuses ?? []} tasks={data?.tasks ?? []}
          picked={statusPick} onPick={setStatusPick} />
        <span className="flex-1" />
        {/* Named by what pressing it DOES, not by what is true.
            "6 done hidden" is a caption, and it was read as one: six statuses
            looked like they had gone missing from the board rather than like
            something one click brings back. `done` here is ClickUp's own status
            TYPE — see toTask — which is why "in production", "ready for
            deployment" and "won't fix" all fall in it. */}
        <button onClick={() => setShowDone((v) => !v)} aria-pressed={showDone}
          title={showDone
            ? "Every status this board has, finished ones included"
            : `Bring back ${counts.done} card${counts.done === 1 ? "" : "s"} in a finished status — in production, released, won't fix`}
          className="text-[10.5px] px-2 py-0.5 rounded-lg"
          style={showDone
            ? { border: edge(14), color: "var(--text3)" }
            : { border: "1px solid color-mix(in srgb, var(--text) 22%, transparent)", color: "var(--text2)" }}>
          {showDone ? "showing everything" : `show ${counts.done} done`}
        </button>
        </>}
        {onLooked && (
          <>
            <span className="flex-1" />
            <button onClick={() => { setLooked([]); setOnLooked(false); }}
              title="Forget every card you have looked up"
              className="text-[10.5px] px-2 py-0.5 rounded-lg"
              style={{ border: edge(14), color: "var(--text3)" }}>
              clear
            </button>
          </>
        )}
      </div>

      {note && <NoteStrip note={note} onClose={() => setNote(null)} />}
      {data?.error && (
        <div className="px-5 py-1 text-[10.5px] shrink-0 flex items-center gap-2"
          style={{ color: "var(--warning)", background: "color-mix(in srgb, var(--warning) 10%, transparent)" }}>
          <span className="min-w-0">{data.error}{data.tasks.length ? " — showing what was last read" : ""}</span>
          {/* A way out of the wait.
              After a failed read the board rests before trying again — a minute,
              doubling to five — so a service having one bad second does not turn
              into a request per glance. That is right, and it means this strip
              can sit there after the problem has passed. Refresh forces past the
              rest, so the answer to "is it still broken?" is one click rather
              than a minute of staring at a warning. */}
          <button onClick={() => void load(data.view?.id, true, true)} disabled={busy}
            className="shrink-0 text-[10px] px-1.5 py-0.5 rounded"
            style={{ border: "1px solid color-mix(in srgb, var(--warning) 45%, transparent)",
              color: "var(--warning)", opacity: busy ? 0.5 : 1 }}>
            {busy ? <span className="inline-block animate-spin">⟳</span> : "Try now"}
          </button>
        </div>
      )}
      {confirm && <ConfirmStrip pending={confirm} onGo={() => void run(confirm)} onCancel={() => setConfirm(null)} />}
      {/* The write itself. It takes a round trip to ClickUp and then a reload
          of the board, which is long enough that "Do it" followed by nothing
          reads as a button that did not work — and the second press is a
          second write. */}
      {busy && !confirm && (
        <div className="px-5 py-1 shrink-0" style={{ background: "color-mix(in srgb, var(--primary) 8%, transparent)" }}>
          <Spinner label="Telling ClickUp…" className="" />
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        <div className="flex flex-col flex-1 min-w-0">
          <div className="px-5 py-1 text-[8.5px] uppercase tracking-[0.16em] shrink-0"
            style={{ display: "grid", gridTemplateColumns: grid, gap: 14, color: "var(--text4)",
              borderTop: edge(10), borderBottom: edge(10) }}>
            <span>Task</span>
            {anyWho && <span className="text-center">Who</span>}
            {anySprint && <span>Sprint</span>}
            {/* Centred over the columns they label, because those columns hold
                two-character numbers in a 30px track — a heading hard against
                the left of it sits above nothing, and the eye stops pairing the
                two. `Task` and the rest stay left: they label text that starts
                at the left. */}
            {/* Hairlines before Cmts and before Pts, and only there. A rule
                between every column stripes the table and reads as a grid you
                are meant to study; two of them just say "the numbers start
                here" and "this one is not that one" — which is the whole
                complaint, since a count and a point score are the same shape.
                `edge(6)` is the same weight as the row separators, so it reads
                as part of the table rather than as decoration. */}
            <span className="text-center" style={{ borderLeft: edge(6), paddingLeft: 8, marginLeft: -8 }}>Cmts</span>
            <span>Due</span>
            {anyEst && <span className="text-center">Est</span>}
            <span className="text-center" style={{ borderLeft: edge(6), paddingLeft: 8, marginLeft: -8 }}>Pts</span>
            <span />
          </div>
          {/*
            * The wait is drawn ON TOP of the old rows, not applied to them.
            *
            * The first attempt dimmed the list to 40% while another board
            * loaded. It said the right thing and looked like the wrong one:
            * faded content is the universal signal for DISABLED, so a board
            * that was merely busy read as a board that had been switched off.
            * A veil with a spinner in the middle of it says "working" — and it
            * leaves the rows legible underneath, which is the part worth
            * keeping through a ten-second read.
            */}
          <div className="relative flex flex-col flex-1 min-h-0 min-w-0">
          <div className="agx-scroll flex-1 min-w-0 overflow-y-auto">
            {/* Looks like a card number and is not on this board — so offer to
                go and get it, rather than reporting nothing and leaving you to
                work out that "not here" is not "does not exist". */}
            {!onLooked && looksLikeId && !rows.some((t) => (t.customId ?? "").endsWith(q.trim())) && (
              <button onClick={() => void reveal()} disabled={finding}
                className="w-full text-left px-5 py-3 hover:bg-white/5"
                style={{ borderBottom: edge(8) }}>
                <span className="text-[11.5px]" style={{ color: "var(--primary)" }}>
                  {finding ? `Looking for ${q.trim()}…` : `Fetch card ${q.trim()} from ClickUp →`}
                </span>
                <span className="block text-[10px]" style={{ color: "var(--text4)" }}>
                  Not on this board. It opens under Looked up, beside your boards — or on the board that
                  turns out to hold it.
                </span>
              </button>
            )}
            {/*
              * The provisional board: what you have fetched by id.
              *
              * Grouped by where each card actually lives rather than by status,
              * because that is the question these rows raise. Two cards from
              * two lists have no shared workflow to be ordered by, and the
              * heading is the answer to "why is this here and not on a board" —
              * so it says the list, not a status the reader would have to map
              * back to somewhere.
              */}
            {onLooked && lookedGroups.map((g, gi) => (
              <div key={g.place} style={{ marginTop: gi ? 18 : 4 }}>
                <div className="px-5 py-2 flex items-center gap-2.5" style={{ borderTop: gi ? edge(9) : undefined }}>
                  <span className="text-[8.5px] uppercase tracking-[0.16em]" style={{ color: "var(--text4)" }}>
                    {g.place}
                  </span>
                  <span className="text-[10.5px] tabular-nums" style={{ color: "var(--text3)" }}>{g.rows.length}</span>
                </div>
                {g.rows.map((t) => (
                  <div key={t.id} className="relative group">
                    <ClickUpRow t={t} today={today} on={t.id === sel} onPick={() => setSel(t.id)}
                      grid={grid} showWho={anyWho} showSprint={anySprint} showEst={anyEst} blocked={[]} onHand={handCard} />
                    {/* One card at a time, because a history you can only throw
                        away whole is one nobody prunes. */}
                    <CloseButton onClick={() => { setLooked((cur) => { const left = cur.filter((x) => x.id !== t.id); if (!left.length) setOnLooked(false); return left; }); if (sel === t.id) setSel(null); }} title="Forget this one" style={{ color: "var(--text3)", background: "var(--bg2)", border: edge(14) }} className="absolute top-1.5 right-1.5 rounded opacity-0 group-hover:opacity-100" />
                  </div>
                ))}
              </div>
            ))}
            {onLooked && !lookedGroups.length && (
              <div className="p-5 text-[11.5px]" style={{ color: "var(--text3)" }}>Nothing matches that.</div>
            )}
            {!onLooked && !rows.length && !looksLikeId && (
              <div className="p-5 text-[11.5px]" style={{ color: "var(--text3)" }}>
                {data?.error ? "Nothing to show — the last read did not get through."
                  : q || tag || mineOnly || statusPick.length ? "Nothing matches that."
                  : "This board has nothing open."}
              </div>
            )}
            {/* Grouped by status, in the board's own workflow order, each group
                foldable with its count — the shape ClickUp itself uses, and the
                one that answers "what is in review" without a filter. */}
            {!onLooked && groups.map((g, gi) => (
              <div key={g.status} style={{ marginTop: gi ? 18 : 4 }}>
                {/* The whole heading is the control, not a glyph beside it. A
                    nine-pixel triangle is a target you aim at; a row you can hit
                    anywhere is one you use. */}
                <button onClick={() => setFolded((f) => ({ ...f, [g.status]: !f[g.status] }))}
                  aria-expanded={!folded[g.status]}
                  title={folded[g.status] ? "Show these" : "Hide these"}
                  className="w-full flex items-center gap-2 px-4 py-2 text-left hover:bg-white/5"
                  style={{ borderTop: gi ? edge(9) : undefined }}>
                  {/* A drawn chevron, not a text glyph. `▸` at a readable size
                      renders as a speck in this font — it was still a speck
                      after being told to be eleven pixels — and the thing it
                      controls is a section of the board. This is a real 20px
                      target with a stroke somebody can see. */}
                  <span aria-hidden className="inline-flex items-center justify-center shrink-0"
                    style={{ width: 20, height: 20, borderRadius: 6, background: "color-mix(in srgb, var(--text) 6%, transparent)" }}>
                    <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 12 12" fill="none"
                      style={{ transform: folded[g.status] ? "none" : "rotate(90deg)", transition: "transform 120ms ease" }}>
                      <path d="M4 2.5 L8.5 6 L4 9.5" stroke="var(--text2)" strokeWidth="1.8"
                        strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                  <StatusPill status={g.status} color={g.color} dim={g.done} />
                  <span className="text-[10.5px] tabular-nums" style={{ color: "var(--text3)" }}>{g.rows.length}</span>
                  {g.points > 0 && (
                    <span className="text-[10.5px] tabular-nums" style={{ color: "var(--text4)" }}>· {g.points} pts</span>
                  )}
                  {folded[g.status] && (
                    <span className="text-[10px]" style={{ color: "var(--text4)" }}>· hidden</span>
                  )}
                </button>
                {!folded[g.status] && g.rows.map((t) => (
                  <ClickUpRow key={t.id} t={t} today={today} on={t.id === sel} onPick={() => setSel(t.id)}
                    grid={grid} showWho={anyWho} showSprint={anySprint} showEst={anyEst} blocked={blockedBy(t)} onHand={handCard} />
                ))}
              </div>
            ))}
          </div>
          {veiled && (
            <div className="agx-veil absolute inset-0 flex items-center justify-center px-8"
              role="status" aria-live="polite"
              style={{ background: "color-mix(in srgb, var(--bg) 92%, transparent)" }}>
              {/* The message sits on its own ground rather than straight on the
                  veil. Measured, not guessed: at 76% the rows behind it showed
                  through the words and neither was readable — a loading state
                  that looks like a rendering fault. The card settles it whatever
                  happens to be underneath. */}
              <div className="flex flex-col items-center gap-3 text-center rounded-xl px-6 py-5"
                style={{ background: "var(--bg2)", border: edge(20), boxShadow: "0 8px 30px rgba(0,0,0,0.28)" }}>
                <span className="agx-spin" aria-hidden style={{ width: 26, height: 26, borderWidth: 2.5 }} />
                <div className="text-[12px]" style={{ color: "var(--text)" }}>
                  Reading {boards.views.find((v) => v.id === wanted)?.name ?? "that board"}…
                </div>
                {boards.views.find((v) => v.id === wanted)?.builtin && (
                  <div className="text-[11px] max-w-[42ch] leading-relaxed" style={{ color: "var(--text3)" }}>
                    Asking ClickUp for every card assigned to you across the workspace. That question
                    takes about ten seconds — a board takes one, because it is already scoped.
                  </div>
                )}
              </div>
            </div>
          )}
          </div>
          <div className="flex items-center gap-3 px-5 py-1.5 shrink-0 text-[10.5px]"
            style={{ borderTop: edge(10), color: "var(--text4)" }}>
            {/* The provisional board counts itself, and says what it is: "9 of
                9 · read just now" would be describing a board nobody is looking
                at. */}
            {onLooked
              ? <span>{lookedGroups.reduce((n, g) => n + g.rows.length, 0)} looked up · not on your boards</span>
              : <span>{rows.length} of {data?.tasks.length ?? 0}</span>}
            {/* Said, rather than left as a list that stops. */}
            {data?.truncated && (
              <span style={{ color: "var(--warning)" }}
                title="More than this was waiting. Open the board in ClickUp to see the rest.">
                · and more behind it
              </span>
            )}
            {/* When, not only how long ago: a board opened from a cache written
                this morning has to say so in a way you can check against a clock. */}
            {!onLooked && data?.at ? <span title={new Date(data.at).toLocaleString()}>· read {stamp(data.at)}</span> : null}
            <span className="flex-1" />
            {/* The VIEW's name, which the breadcrumb does not carry: one list
                can have several views, and this says which one you are in.
                Where the list itself sits is on the card, once — putting it
                here too printed the same three words twice on one screen. */}
            {data?.view?.name && <span className="truncate max-w-[280px]">{data.view.name}</span>}
          </div>
        </div>

        {/* `overflow-x: hidden` and `minWidth: 0`, together. Without the second
            a grid child takes its content's width as its minimum, so one long
            unbroken URL in a card pushed the whole pane sideways and dragged the
            list with it — which is the horizontal scrollbar that appeared under
            everything. */}
        <aside className="flex flex-col shrink-0 min-w-0"
          style={{ width: wide ? 720 : 380, borderLeft: edge(12), transition: "width 120ms ease" }}>
          {/* The width control belongs to the PANE, not to whatever is in it.
              Inside the card it was unreachable the moment you deselected: the
              pane stayed at 720px around the words "Pick a card", with the only
              button that could narrow it hidden behind picking one again. */}
          <div className="flex items-center gap-2 px-4 pt-3 shrink-0">
            <span className="text-[8.5px] uppercase tracking-[0.16em] truncate" style={{ color: "var(--text4)" }}>
              {picked ? "Card" : ""}
            </span>
            <span className="flex-1" />
            <button onClick={() => setWide((w) => !w)}
              title={wide ? "Narrow this pane" : "Some cards are a page of prose — give it room"}
              className="text-[10px] px-1.5 py-0.5 rounded shrink-0"
              style={{ border: edge(16), color: "var(--text3)" }}>
              {wide ? "⇥ narrow" : "⇤ wider"}
            </button>
          </div>
          <div className="agx-scroll flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-4 pb-0 pt-0 text-[11.5px] flex flex-col">
            {picked
              ? <CardDetail t={picked} today={today} statuses={cardStatuses} fields={cardFields} place={cardPlaceShown}
                  writable={boards.writeEnabled} repos={repos} here={here}
                  onOpenChatWith={onOpenChatWith}
                  wide={wide}
                  byId={byId} onGo={(id) => setSel(id)}
                  skills={skills}
                  onNote={(text) => setNote({ ok: true, text })}
                  onAsk={(p) => setConfirm(p)} />
              : <div className="text-center p-5" style={{ color: "var(--text3)" }}>Pick a card.</div>}
          </div>
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

/**
 * Where a card lives, the way ClickUp's own header says it: Space / Folder / List.
 *
 * The question this answers is the one a list of thirteen cards from eight
 * different lists asks on every row — "which board is this even on" — and until
 * now the only way to answer it was to open the card in a browser. It costs no
 * request of its own: `GET /list/{id}` carries its space and folder, and that
 * call was already being made for the statuses.
 *
 * Text rather than links. ClickUp's space and folder addresses are a shape this
 * app has never verified, and a breadcrumb of dead links is worse than one that
 * never promised to be clickable.
 */
function Breadcrumb({ place, className }: { place?: ListPlace; className?: string }) {
  if (!place) return null;
  const parts = [place.space, place.folder, place.list].filter(Boolean) as string[];
  if (!parts.length) return null;
  return (
    <div className={`flex items-center gap-1 min-w-0 text-[10px] ${className ?? ""}`}
      title={parts.join("  /  ")}>
      {parts.map((p, i) => (
        <span key={`${p}-${i}`} className="flex items-center gap-1 min-w-0">
          {i > 0 && <span aria-hidden style={{ color: "var(--text4)", opacity: 0.7 }}>/</span>}
          {/* The last one is where you are; the ones before it are context, and
              dimmer, which is what makes a breadcrumb readable at a glance. */}
          <span className="truncate" style={{ color: i === parts.length - 1 ? "var(--text2)" : "var(--text4)" }}>{p}</span>
        </span>
      ))}
    </div>
  );
}

function AddBoardBar({ value, onValue, onAdd, onClose, busy, editing }: {
  value: string; onValue: (v: string) => void; onAdd: () => void; onClose: () => void; busy: boolean;
  /** The board whose address is being changed, when that is the errand. */
  editing?: string | null;
}) {
  return (
    <div className="px-5 pb-2 flex items-center gap-2 shrink-0">
      <input autoFocus value={value} onChange={(e) => onValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") onAdd(); if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}
        placeholder={editing ? `New address for ${editing} — the board itself is untouched` : "Paste the address of a ClickUp board — the one in your browser's bar"}
        spellCheck={false} autoComplete="off"
        className="flex-1 min-w-0 text-[11.5px] px-2.5 py-1.5 rounded-lg outline-none"
        style={{ background: "var(--bg2)", border: edge(18), color: "var(--text)" }} />
      <button onClick={onAdd} disabled={busy || !value.trim()}
        className="text-[11.5px] px-3 py-1.5 rounded-lg"
        style={{ background: "color-mix(in srgb, var(--primary) 20%, transparent)",
          border: "1px solid color-mix(in srgb, var(--primary) 48%, transparent)",
          color: "var(--text)", opacity: busy || !value.trim() ? 0.4 : 1 }}>
        {busy ? "Checking…" : editing ? "Change" : "Add"}
      </button>
    </div>
  );
}

function AddFirstBoard({ value, onValue, onAdd, busy, note, why }: {
  value: string; onValue: (v: string) => void; onAdd: () => void; busy: boolean;
  note: { ok: boolean; text: string } | null;
  /** Why the built-in board came back with nothing — almost always "not
   *  connected yet", which is a thing to fix in Settings rather than here. */
  why?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center flex-1 gap-3 p-8 text-center">
      <div className="text-[13px]" style={{ color: "var(--text)" }}>Nothing to read yet</div>
      {why && <div className="text-[11.5px]" style={{ color: "var(--warning)" }}>{why}</div>}
      <div className="text-[11.5px] max-w-[52ch]" style={{ color: "var(--text3)" }}>
        Once ClickUp is connected, <b style={{ color: "var(--text2)" }}>Assigned to me</b> is here
        without adding anything. To work from a particular board as well, open it in ClickUp and
        paste the address — its own filters come with it, and it loads in about a second instead of
        trawling the whole workspace.
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
      <button onClick={() => openSettings("connections")} className="text-[10.5px] px-2 py-1 rounded-lg mt-1"
        style={{ border: edge(16), color: "var(--text3)" }}>ClickUp settings</button>
    </div>
  );
}

/*
 * The columns, and the two that come and go.
 *
 * A sprint column on a board where nothing has been sprinted is a column of
 * blanks, and a "who" column on one nobody has been assigned on is the same.
 * Both appear only once some card actually has one, so the title keeps the
 * width until there is something to spend it on.
 */
const YOLO_KEY = "agentglass.clickup.skipPermissions";
const WIDE_KEY = "agentglass.clickup.wideCard";
/*
 * Where a hand-off goes, remembered.
 *
 * The skills in this same menu have always asked — they go to a tmux pane
 * through `requestTermIssue`, with a mode and a permissions switch. The three
 * "write your own" rows underneath them did not: they opened a chat in the app
 * and that was that. Two behaviours in one dropdown, and the one that decides
 * for you is the one that cannot be undone by closing a pane.
 *
 * A preference rather than a question per card, because it is one: you either
 * work in the app's chat or you work in your terminal. And it is worth being a
 * setting at all because the chat may not always be here — a destination that
 * can be deprecated should never be the only one wired in.
 */

/*
 * How often a board re-reads itself, priced by what it costs to ask.
 *
 * A view answers in about a second because it is already scoped, so a minute is
 * free. The built-in board asks an entire workspace and takes twelve, and the
 * answer to "what is assigned to me" does not turn over inside a minute — so
 * re-asking it sixty times an hour spends somebody else's service to learn
 * nothing. Five minutes, plus a read the moment the window is focused, plus
 * Refresh whenever a person actually wants to know.
 *
 * Measured against a stub that counts: this takes the panel from ~1.5 requests
 * a minute to ~0.3 while focused, and to none at all while it is not.
 */
/** How many looked-up cards to keep. A history you have to scroll is not a
 *  history, and these are all one click from being fetched again. */
const LOOKED_MAX = 12;
const CU_POLL_MS = 60_000;
const CU_POLL_SLOW_MS = 300_000;

/*
 * The columns, and the ones that come and go.
 *
 * No status column: the rows are grouped BY status, so every row in a group
 * would carry the same pill its own heading already shows. That is 170px of
 * repetition, taken from the one column whose content varies — the title.
 *
 * `Who` and `Sprint` appear only once some card actually has one. A column of
 * blanks costs the title its width and tells you nothing.
 */
const cuGrid = (who: boolean, sprint: boolean, est: boolean) =>
  // The comments column is unconditional, unlike Who and Sprint. Those come and
  // go because a board where nobody is assigned has nothing to put in them; a
  // count of zero is a real answer and worth the 30px — "nobody has said
  // anything about this card" is exactly the thing a glance is looking for.
  // The comment count sits BEFORE Due, not beside Pts. Next to it they were two
  // narrow right-aligned integers touching, told apart only by a heading eight
  // pixels tall — so a card with 3 points and 8 comments read as either. Two
  // columns of the same shape need something between them, and Due is the
  // widest thing on the row.
  ["1fr", who ? "50px" : "", sprint ? "88px" : "", "34px", "72px", est ? "38px" : "", "30px", "40px"].filter(Boolean).join(" ");

/**
 * A status, spelled and coloured the way the board spells and colours it.
 *
 * Upper case and a pill because that is what ClickUp shows, and the colour is
 * the workspace's own — it arrives on every task. Mapping it to a palette of
 * ours would make this panel disagree with the tool it is displaying, which is
 * the one thing a second window onto somebody's board must not do.
 *
 * The colour is used at low alpha for the fill and full strength for the text,
 * so a pale yellow status is legible on a dark ground and a red one does not
 * shout louder than the task's own title.
 */
/*
 * One person, as a face.
 *
 * Initials are not enough on a real board: two people here share `AG`, and a
 * column of identical grey squares is a column that tells you nothing. So the
 * picture when there is one, the person's OWN colour behind their initials when
 * there is not, and the full name on hover either way.
 *
 * Overlapped slightly, the way every tool draws a row of assignees, so three of
 * them still fit in the width of one.
 */
/**
 * The strip that says what just happened.
 *
 * It used to sit there until the next thing replaced it — on the ClickUp board
 * there was no timer at all, so "Assigned to you" stayed on screen for the rest
 * of the session, and after a while nobody reads a line that is always there.
 *
 * So it goes on its own, and it can be sent away. Both, deliberately: the timer
 * is for the nine times out of ten you have already moved on, and the × is for
 * the tenth, when it is covering something. A failure is given twice as long —
 * an error is read, a confirmation is only glanced at.
 */
function NoteStrip({ note, onClose }: { note: { ok: boolean; text: string }; onClose: () => void }) {
  const tone = note.ok ? "var(--success)" : "var(--warning)";
  useEffect(() => {
    const t = setTimeout(onClose, note.ok ? 6000 : 12000);
    return () => clearTimeout(t);
    // The text as well as the flag: two confirmations in a row are two notes,
    // and the second one deserves its own six seconds rather than the remains
    // of the first one's.
  }, [note.ok, note.text, onClose]);
  return (
    <div className="px-5 py-1 text-[10.5px] shrink-0 flex items-center gap-2"
      style={{ color: tone, background: `color-mix(in srgb, ${tone} 10%, transparent)` }}>
      <span className="min-w-0 flex-1">{note.text}</span>
      <button onClick={onClose} title="Dismiss" aria-label="Dismiss"
        className="shrink-0 px-1 rounded hover:bg-white/10" style={{ color: tone }}>×</button>
    </div>
  );
}

function Face({ p, n }: { p: NonNullable<ProviderTask["people"]>[number]; n: number }) {
  const ring = p.me ? "var(--success)" : "transparent";
  const base = {
    width: 18, height: 18, borderRadius: 999, marginLeft: n ? -5 : 0,
    boxShadow: `0 0 0 1.5px ${ring}, 0 0 0 3px var(--bg)`,
    /*
     * Small, and deliberately so. This orders the faces AMONG THEMSELVES — the
     * first over the second, so the overlap reads left to right — and that is
     * all it is for. It used to start at 10, which is the sticky card header's
     * own layer: same stacking context, and the faces come later in the DOM, so
     * an assignee slid OVER the header on the way past it rather than under it.
     */
    zIndex: 4 - n,
  } as const;
  if (p.avatar) {
    return (
      <img src={p.avatar} alt="" title={p.me ? `${p.name} — you` : p.name}
        loading="lazy" referrerPolicy="no-referrer"
        style={{ ...base, objectFit: "cover", position: "relative" }} />
    );
  }
  return (
    <span title={p.me ? `${p.name} — you` : p.name}
      className="inline-flex items-center justify-center text-[10px] font-medium"
      style={{ ...base, position: "relative", background: p.color || "var(--bg4)", color: "#fff" }}>
      {p.initials}
    </span>
  );
}

/** Priority in the four colours it has. Shown at every level, not only the loud
 *  ones: "normal" is a decision somebody made, and hiding it read as nobody
 *  having made one. */
function PriorityChip({ p }: { p: NonNullable<ProviderTask["priority"]> }) {
  const look = p === "urgent" ? { c: "var(--error)", t: "URGENT" }
    : p === "high" ? { c: "var(--error)", t: "HIGH" }
    : p === "normal" ? { c: "var(--info)", t: "NORMAL" }
    : { c: "var(--text4)", t: "LOW" };
  return (
    <span className="text-[8.5px] tracking-[0.08em] px-1.5 rounded"
      style={{ color: look.c, background: `color-mix(in srgb, ${look.c} 13%, transparent)` }}>{look.t}</span>
  );
}

function ClickUpRow({ t, today, on, onPick, grid, showWho, showSprint, showEst, blocked, onHand }: {
  t: ProviderTask; today: string; on: boolean; onPick: () => void;
  grid: string; showWho: boolean; showSprint: boolean; showEst: boolean;
  /** Unfinished cards this one is waiting on. Empty means it can be started. */
  blocked: ProviderTask[];
  /** Hand this card over without opening it. Absent where there is no checkout
   *  to hand it to, and the item then does not appear. */
  onHand?: (t: ProviderTask) => void;
}) {
  /*
   * The three things you want from a row without opening it.
   *
   * Everything here already existed one click deeper, in the card: both ids,
   * the link out, the hand-off. A row is where you are when you want them —
   * scanning twenty-nine of these for the one whose number goes in a branch —
   * and opening a card to copy an id you can already read is a detour.
   *
   * Right-click, because a row is a target for the pointer and its left button
   * already means "show me this one". Same menu component as the rail, the
   * board pills and the pinned chips.
   */
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [said, setSaid] = useState("");
  const copy = (v: string, what: string) => {
    void navigator.clipboard?.writeText(v).catch(() => {});
    setSaid(what); setTimeout(() => setSaid(""), 1400); setMenu(null);
  };
  const late = !!t.due && t.due < today;
  const now = t.due === today;
  const done = t.statusKind === "done";
  return (
    <div role="row" tabIndex={0} aria-current={on ? "true" : undefined} onClick={onPick}
      onKeyDown={(e) => { if (e.key === "Enter") onPick(); }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY }); }}
      className="agx-row w-full text-left px-4 py-1.5 hover:bg-white/5 cursor-pointer items-center"
      style={{
        /* 8px of gap put a two-character number a hair from the next one, and
           with everything right-aligned the columns read as one ragged block.
           14 plus the hairlines below is what separates them; the numbers are
           centred in their own track rather than crowded against its edge. */
        display: "grid", gridTemplateColumns: grid, gap: 14, borderBottom: edge(6), position: "relative",
        background: on ? "color-mix(in srgb, var(--primary) 13%, transparent)" : undefined,
        boxShadow: on ? "inset 2px 0 0 0 var(--primary)" : undefined,
      }}>
      <div className="min-w-0">
        <div className="flex items-baseline gap-1.5 min-w-0">
          {/* Blocked first, because it changes whether the rest is worth
              reading. 28 of 30 cards on a real board have dependencies and none
              of them were shown; the ones that matter are the unfinished ones. */}
          {/* WHAT it waits on, not that it waits. On a real board 30 of 36
              cards are blocked, so the word alone is a label every row wears —
              which is a label nobody reads. The name of the thing in the way is
              different on every row and is the part you can act on. */}
          {!!blocked.length && (
            <span className="text-[8.5px] tracking-[0.06em] px-1.5 rounded shrink-0 tabular-nums"
              title={`Waiting on ${blocked.map((b) => `${shortName(b.title, b.customId ?? b.id)} — ${b.title}`).join("\n")}`}
              style={{ color: "var(--error)", background: "color-mix(in srgb, var(--error) 14%, transparent)" }}>
              ⛔ {shortName(blocked[0]!.title, blocked[0]!.customId ?? blocked[0]!.id)}
              {blocked.length > 1 ? ` +${blocked.length - 1}` : ""}
            </span>
          )}
          <span className="truncate text-[12.5px] leading-snug" style={{ color: done ? "var(--text3)" : "var(--text)" }}
            title={t.title}>{t.title}</span>
        </div>
        <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
          {t.customId && <span className="text-[10px] tabular-nums" style={{ color: "var(--text4)" }}>{t.customId}</span>}
          {/* Only a priority worth acting on. "Normal" was on nine rows in ten,
              which is a column of noise pretending to be information. */}
          {t.priority && t.priority !== "normal" && <PriorityChip p={t.priority} />}
          {!!t.subtasks && (
            <span className="text-[10px]" style={{ color: "var(--text4)" }} title={`${t.subtasks} subtasks`}>⌥{t.subtasks}</span>
          )}
          {t.tags.map((tag) => (
            <span key={tag} className="text-[9.5px] px-1.5 rounded-full"
              style={{ color: "var(--text3)", background: "color-mix(in srgb, var(--text) 8%, transparent)" }}>{tag}</span>
          ))}
        </div>
      </div>
      {showWho && (
        <span className="flex items-center" style={{ paddingLeft: 3 }}>
          {(t.people ?? []).slice(0, 3).map((p, n) => <Face key={n} p={p} n={n} />)}
          {(t.people?.length ?? 0) > 3 && (
            <span className="text-[8.5px] ml-1" style={{ color: "var(--text4)" }}>+{(t.people!.length) - 3}</span>
          )}
        </span>
      )}
      {showSprint && (
        <span className="truncate text-[10.5px]" style={{ color: t.sprint ? "var(--info)" : "var(--text4)" }}
          title={t.sprint ?? ""}>{t.sprint ?? ""}</span>
      )}
      {/* Blank when the count is not known, 0 when it is known to be zero. The
          two are different facts and the workspace does not report either on a
          task — it costs a call per card, so "not counted yet" is a real state
          on the first sight of a board. Dimmer at zero, because a card nobody
          has commented on is the uninteresting case and should not draw the
          eye the way a thread does. */}
      <span className="text-[11px] tabular-nums text-center"
        title={t.comments == null ? "Not counted yet" : `${t.comments} comment${t.comments === 1 ? "" : "s"}`}
        // The rule runs the height of the table because every row draws its own
        // segment; the heading draws the top one.
        style={{
          borderLeft: edge(6), paddingLeft: 8, marginLeft: -8,
          color: t.comments ? "var(--text3)" : "var(--text4)", opacity: t.comments ? 1 : 0.55,
        }}>
        {t.comments ?? ""}
      </span>
      <span className="text-[11px] tabular-nums" style={{ color: late ? "var(--error)" : now ? "var(--warning)" : "var(--text3)" }}>
        {dueLabel(t.due, today)}
      </span>
      {showEst && (
        <span className="text-[10.5px] tabular-nums text-center" style={{ color: "var(--text4)" }}
          title={t.estimateHours ? `${t.estimateHours}h estimated${t.spentHours ? `, ${t.spentHours}h logged` : ""}` : ""}>
          {t.estimateHours ? `${t.estimateHours}h` : ""}
        </span>
      )}
      <span className="text-[11px] tabular-nums text-center"
        style={{ color: "var(--text4)", borderLeft: edge(6), paddingLeft: 8, marginLeft: -8 }}>{t.points ?? ""}</span>
      <span className="text-right">
        {t.url && (
          <a href={t.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
            className="agx-onrow text-[10.5px] px-1.5 py-0.5 rounded-lg inline-block"
            style={{ border: edge(16), color: "var(--text2)" }}>↗</a>
        )}
      </span>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {t.customId && (
            <MenuItem onClick={() => copy(t.customId!, t.customId!)}>Copy {t.customId}</MenuItem>
          )}
          <MenuItem onClick={() => copy(t.id, "the ClickUp id")}>
            Copy {t.id} <span style={{ color: "var(--text4)" }}>· ClickUp&apos;s own</span>
          </MenuItem>
          {externalUrl(t.url) && (
            <MenuItem onClick={() => { openExternal(t.url); setMenu(null); }}>Open in ClickUp ↗</MenuItem>
          )}
          {onHand && (
            <MenuItem onClick={() => { onHand(t); setMenu(null); }}>
              Hand to Claude <span style={{ color: "var(--text4)" }}>· the whole card</span>
            </MenuItem>
          )}
        </ContextMenu>
      )}
      {/* Said on the row itself: a clipboard write is invisible, and a menu
          that closes without a word leaves you wondering whether it took. */}
      {said && (
        /* Out of the grid: this row's columns are measured across every row on
           the board, and a fifth child would shift them all for a second. */
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[9.5px] px-1.5 py-0.5 rounded pointer-events-none"
          style={{ color: "var(--success)", background: "color-mix(in srgb, var(--success) 16%, var(--bg2))" }}>
          {said} copied
        </span>
      )}
    </div>
  );
}

/*
 * Filter by the board's own statuses.
 *
 * Multi-select, because the question people have is "what is in review OR
 * blocked" and a single-select turns that into two passes. Each carries how
 * many cards are in it, so an empty status is visibly empty rather than a click
 * that produces nothing. Ordered by the board's `orderindex` — its workflow
 * order — and split at the finished ones, so five kinds of done are not
 * interleaved with the work.
 */
function StatusFilter({ statuses, tasks, picked, onPick }: {
  statuses: ListStatus[]; tasks: ProviderTask[];
  picked: string[]; onPick: (v: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(open, box, () => setOpen(false));
  if (!statuses.length) return null;

  const count = (name: string) => tasks.filter((t) => t.status === name).length;
  const working = statuses.filter((s) => s.type !== "done" && s.type !== "closed");
  const finished = statuses.filter((s) => s.type === "done" || s.type === "closed");
  const toggle = (name: string) =>
    onPick(picked.includes(name) ? picked.filter((x) => x !== name) : [...picked, name]);

  const Row = ({ s }: { s: ListStatus }) => {
    const n = count(s.status);
    const on = picked.includes(s.status);
    return (
      <button onClick={() => toggle(s.status)}
        className="flex items-center gap-2 text-left px-2.5 py-1 hover:bg-white/5 whitespace-nowrap">
        <span aria-hidden style={{
          width: 9, height: 9, borderRadius: 999, flexShrink: 0,
          background: on ? (s.color || "var(--primary)") : "transparent",
          border: `1.5px solid ${s.color || "var(--text4)"}`,
        }} />
        <span className="flex-1 text-[10.5px] tracking-[0.04em]"
          style={{ color: on ? "var(--text)" : "var(--text2)" }}>{s.status.toUpperCase()}</span>
        <span className="tabular-nums text-[10px]" style={{ color: n ? "var(--text3)" : "var(--text4)" }}>{n}</span>
      </button>
    );
  };

  return (
    <div className="relative" ref={box}>
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="flex items-center gap-1.5 text-[11px] px-2.5 py-0.5 rounded-full whitespace-nowrap"
        style={picked.length
          ? { background: "color-mix(in srgb, var(--primary) 16%, transparent)",
              border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)", color: "var(--text)" }
          : { border: edge(14), color: "var(--text2)" }}>
        {picked.length ? `${picked.length} selected` : "Status"}
        <span style={{ color: "var(--text4)" }}>▾</span>
      </button>
      {open && (
        <div className="agx-scroll absolute left-0 mt-1 rounded-lg shadow-2xl flex flex-col overflow-y-auto"
          style={{ zIndex: 30, background: "var(--bg2)", border: edge(28), minWidth: 236, maxHeight: 380 }}>
          {!!picked.length && (
            <button onClick={() => { onPick([]); setOpen(false); }}
              className="text-left px-2.5 py-1.5 text-[10.5px] hover:bg-white/5" style={{ color: "var(--text3)" }}>
              Clear
            </button>
          )}
          {working.map((s) => <Row key={s.status} s={s} />)}
          {!!finished.length && (
            <div className="px-2.5 pt-2 pb-1 text-[8.5px] uppercase tracking-[0.16em]"
              style={{ color: "var(--text4)", borderTop: edge(10) }}>Done</div>
          )}
          {finished.map((s) => <Row key={s.status} s={s} />)}
        </div>
      )}
    </div>
  );
}

/** A dependency, as a row you can jump to. Its status decides whether it is an
 *  obstacle or a note: a card waiting on something already in production is
 *  ready, and colouring it red is how a warning gets ignored. */
function DepRow({ d, onGo }: { d: ProviderTask; onGo: (id: string) => void }) {
  const done = d.statusKind === "done";
  return (
    <button onClick={() => onGo(d.id)}
      className="w-full text-left flex items-center gap-2 py-1 px-1 -mx-1 rounded hover:bg-white/5">
      <StatusPill status={d.status} color={d.statusColor} dim={done} />
      <span className="truncate text-[11px]" style={{ color: done ? "var(--text4)" : "var(--text2)" }}
        title={d.title}>{d.title}</span>
    </button>
  );
}

/** One metadatum: a quiet label with its value beneath. Named apart from the
 *  issues panel's own `Field`, which takes a different prop — two components
 *  with one name is how a rename breaks a panel three hundred lines away. */
function CardField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[8.5px] uppercase tracking-[0.16em] mb-1 truncate" style={{ color: "var(--text4)" }} title={label}>
        {label}
      </div>
      <div className="text-[11.5px] leading-tight break-words">{children}</div>
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
function CardDetail({ t, today, statuses, fields, place, writable, repos, here, onOpenChatWith, onAsk, skills, onNote, wide, byId, onGo }: {
  t: ProviderTask; today: string;
  statuses: ListStatus[]; fields: ListField[];
  /** Space / Folder / List, for the card in hand. */
  place?: ListPlace;
  writable: boolean;
  repos: GitRepoRef[]; here: string;
  onOpenChatWith?: (cwd: string, prompt: string, title: string) => void;
  onAsk: (p: Pending) => void;
  /** Only the skills that take a card — see lib/cardSkills.ts. */
  skills: SkillInfo[];
  onNote: (text: string) => void;
  wide: boolean;
  /** The board's own cards, for resolving dependencies without a call each. */
  byId: Map<string, ProviderTask>;
  onGo: (id: string) => void;
}) {
  const [full, setFull] = useState<(Partial<TaskDetail> & { ok?: boolean; error?: string }) | null>(null);
  /** Which comment threads are open, by comment id. Closed by default: a card
   *  with five threaded comments would otherwise open as a wall. */
  const [openThreads, setOpenThreads] = useState<Set<string>>(new Set());
  const [statusOpen, setStatusOpen] = useState(false);
  /**
   * The assignee picker, and the people it offers.
   *
   * Fetched when the menu is OPENED rather than with the card: a board is read
   * far more often than it is re-assigned, and the membership of a list changes
   * about once a quarter.
   *
   * Deliberately not an effect. The first version was, with `membersBusy` among
   * its dependencies — so setting that flag re-ran the effect, the re-run's
   * cleanup set the previous run's `live` to false, and the answer arrived to a
   * closure that had been told to ignore it. The spinner span for ever. An
   * effect that cancels itself by announcing that it started is a shape to
   * avoid, not to tune; the request belongs to the click that asked for it.
   */
  const [whoOpen, setWhoOpen] = useState(false);
  const [members, setMembers] = useState<ListMember[] | null>(null);
  const [membersBusy, setMembersBusy] = useState(false);
  /** The card this answer is for, so a click on the next card cannot be
   *  answered by the last card's request. */
  const asked = useRef<string | null>(null);
  const openWho = () => {
    setWhoOpen((o) => !o);
    if (whoOpen || members || membersBusy || !t.listId) return;
    const forCard = t.id;
    asked.current = forCard;
    setMembersBusy(true);
    api.clickupMembers(t.listId)
      .then((r) => { if (asked.current === forCard) setMembers(r.ok ? (r.members ?? []) : []); })
      .catch(() => { if (asked.current === forCard) setMembers([]); })
      .finally(() => { if (asked.current === forCard) setMembersBusy(false); });
  };

  // A different card is a different question: forget the last card's people,
  // and disown any answer still on its way.
  useEffect(() => { setWhoOpen(false); setMembers(null); setMembersBusy(false); asked.current = null; }, [t.id]);
  const [askOpen, setAskOpen] = useState(false);
  /** Where a hand-off goes. Read once and kept, so the pills reflect it. */
  const [to, setTo] = useState<HandoffTo>(handoffTo);
  const [copied, setCopied] = useState<"human" | "raw" | null>(null);
  /*
   * Which half of the card you are reading.
   *
   * The comments sat under the description, and on a triaged bug the
   * description runs to two screens — so the conversation, which is the part
   * that changes and the part you came back for, was the part you had to scroll
   * past everything else to reach. A tab is the honest shape for that: two
   * things of comparable weight, one on screen at a time, and the count on the
   * tab answers "is there anything new here" without opening it.
   *
   * Reset when the card changes, or pressing through a board would land you on
   * the comments of a card you have not read yet.
   */
  const [tab, setTab] = useState<"card" | "comments">("card");
  useEffect(() => { setTab("card"); }, [t.id]);
  const nComments = full?.comments?.length ?? 0;
  /* Derived rather than corrected in state: a refresh that returns a card with
     no comments must not leave the pane showing a tab that is no longer there,
     with nothing under it. */
  const view = nComments ? tab : "card";
  const [skillQ, setSkillQ] = useState("");
  // Remembered across cards and restarts: whoever wants this once usually wants
  // it for the rest of the afternoon, and re-ticking it every time is how it
  // ends up left on by habit instead of by choice.
  const [yolo, setYolo] = useState(() => {
    try { return localStorage.getItem(YOLO_KEY) === "1"; } catch { return false; }
  });
  useEffect(() => { try { localStorage.setItem(YOLO_KEY, yolo ? "1" : "0"); } catch { /* private mode */ } }, [yolo]);

  const [prs, setPrs] = useState<{ number: number; title: string; state: string; draft?: boolean; url: string; stated?: boolean }[]>([]);
  const [prsErr, setPrsErr] = useState(false);

  useEffect(() => {
    let live = true;
    setPrs([]); setPrsErr(false);
    const field = t.custom?.find((c) => /github/i.test(c.name))?.value ?? "";
    const cwd = rootForTask(t.list, repos, here) ?? here;
    void api.clickupPrs(t.customId || "", field, cwd)
      .then((r) => { if (live) { setPrs(r.prs ?? []); setPrsErr(!r.ok); } })
      .catch(() => { if (live) setPrsErr(true); });
    return () => { live = false; };
  }, [t.id, t.customId, t.custom, t.list, repos, here]);

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
  const waits = (t.waitsOn ?? []).map((id) => byId.get(id)).filter((x): x is ProviderTask => !!x);
  const waitsOpen = waits.filter((x) => x.statusKind !== "done");
  const blocksThese = (t.blocks ?? []).map((id) => byId.get(id)).filter((x): x is ProviderTask => !!x);

  const shown = useMemo(() => {
    const needle = skillQ.trim().toLowerCase();
    if (!needle) return skills;
    return skills.filter((s) => s.name.toLowerCase().includes(needle) || (s.description ?? "").toLowerCase().includes(needle));
  }, [skills, skillQ]);

  /*
   * Two ids, and which one you need depends on who you are handing it to.
   *
   * `WEB-1042` is the one people recognise — it goes in a branch name, a
   * commit, a message to a colleague, and it is what every skill written
   * against this workspace asks for. `86e2gw3v4x` is ClickUp's own, and it is
   * what the API and a URL take.
   *
   * The button copied the internal one only, which is the one you want least
   * of the time. Both are offered, and both are SHOWN — the internal id was
   * invisible before, so there was no way to read it off the screen at all.
   */
  const copyIt = async (v: string, which: "human" | "raw") => {
    try { await navigator.clipboard.writeText(v); setCopied(which); setTimeout(() => setCopied(null), 1200); } catch { /* no clipboard */ }
  };

  return (
    /*
     * `min-h-full`, a column, and `shrink-0` — and the third is not optional.
     *
     * The first two are for the footer: without a height to fill, `margin-top:
     * auto` has nothing to push against and the bar sits wherever the content
     * happens to end.
     *
     * `shrink-0` is for the header. The scroller above is itself `flex
     * flex-col`, so this is a flex ITEM, and a flex item's default
     * `flex-shrink: 1` squashed it to exactly the scroller's height while its
     * content overflowed — measured on a real card: the box reported 435px
     * around 1913px of content. A `position: sticky` element only sticks while
     * its containing block is in view, so the header stuck for one screen and
     * then left with a box that had already ended, which is exactly what "at
     * the bottom of the card the header goes away" looks like. The footer never
     * showed it, because `bottom-0` holds it to the bottom of that same short
     * box either way.
     */
    <div className="flex flex-col min-h-full shrink-0">
      {/* The id somebody recognises, first and copyable: it is what goes in a
          branch name, a commit and a message to a colleague. The internal one is
          a fallback, not the headline. */}
      {/* Sticky, so the two things that say WHICH card this is survive the
          scroll. A long card is exactly where you lose track of that — you
          scroll into a table of event names and the only thing identifying
          what you are reading has gone off the top. Opaque, for the same
          reason the action bar is: text slides under it. */}
      {/*
        * The padding belongs to the header, not to the scroller.
        *
        * With `pt-2` on the container there were eight pixels above a `top-0`
        * sticky element that it could never cover, and content slid through
        * them — which reads as a translucent bar rather than as the gap it is.
        * Same reason the footer carries its own bottom padding.
        */}
      <div className="sticky top-0 z-20 pt-2.5 pb-1.5" style={{ background: "var(--bg)" }}>
        <div className="flex items-center gap-1.5 flex-wrap">
          <button onClick={() => void copyIt(t.customId || t.id, "human")} className="text-[10.5px] tabular-nums rounded px-1.5 py-0.5"
            style={{ color: "var(--primary)", background: "color-mix(in srgb, var(--primary) 12%, transparent)" }}
            title={`Copy ${t.customId || t.id} — the id for a branch, a commit or a colleague`}>
            {copied === "human" ? "copied ✓" : (t.customId || t.id)}
          </button>
          {/* Only when there are genuinely two. A workspace without custom ids
              would otherwise get the same string twice. */}
          {t.customId && t.customId !== t.id && (
            <button onClick={() => void copyIt(t.id, "raw")} className="text-[9.5px] rounded px-1.5 py-0.5"
              style={{ color: "var(--text4)", border: edge(16) }}
              title={`Copy ${t.id} — ClickUp's own id, the one its API and URLs take`}>
              {copied === "raw" ? "copied ✓" : t.id}
            </button>
          )}
          {t.priority && <PriorityChip p={t.priority} />}
          {t.mine && (
            <span className="text-[8.5px] tracking-[0.08em] px-1.5 py-0.5 rounded"
              style={{ color: "var(--success)", background: "color-mix(in srgb, var(--success) 15%, transparent)" }}>YOURS</span>
          )}
        </div>
        <h2 className="text-[13px] font-semibold leading-snug mt-1.5" style={{ color: "var(--text)", textWrap: "balance" }}>
          {t.title}
        </h2>
        {/* Only when there is a second thing to switch to. One tab is not a tab,
            it is a label — and a card with no conversation should look exactly
            the way it always did. */}
        {!!nComments && (
          <div className="flex items-center gap-3 mt-2" style={{ borderBottom: edge(12) }}>
            {([["card", "Card"], ["comments", `Comments ${nComments}`]] as const).map(([id, label]) => (
              <button key={id} onClick={() => setTab(id)}
                className="text-[10px] uppercase tracking-[0.16em] pb-1.5 -mb-px"
                style={{
                  color: view === id ? "var(--text)" : "var(--text4)",
                  borderBottom: `2px solid ${view === id ? "var(--primary)" : "transparent"}`,
                }}>
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
      {/* One at a time. Unmounting the other half is safe here: what the card
          knows — `full`, the fetch, the status options — lives on CardDetail
          itself, not in this subtree, so switching tabs re-renders and never
          re-fetches. */}
      {view === "card" && (<>
      {/* Above the title, the way ClickUp puts it. On the built-in board this is
          the only thing on screen that answers "which board is this card even
          on" — its thirteen rows come from eight different lists. */}
      <Breadcrumb place={place} className="mb-3" />

      {/* Two columns of label-above-value rather than one of label|value. In a
          380px pane the second shape leaves the value about ninety pixels, which
          is where "ready for engineering" became "to…". */}
      <div className="mb-3" style={{ display: "grid", gridTemplateColumns: wide ? "repeat(3, minmax(0,1fr))" : "1fr 1fr", gap: "11px 12px" }}>
        <CardField label="Status">
          <div className="relative">
            {/* Full width, and the caret at the edge.
                These two fields sit side by side in one grid and were built
                separately: Assigned took the whole column and Status shrank to
                its pill, so one read as a control and the other as a label that
                happened to be clickable. The caret went with them — a chevron
                tucked against the text says "there is more text", where one at
                the far edge says "this opens". Same shape for both. */}
            <button onClick={() => writable && setStatusOpen((o) => !o)} disabled={!writable || !options.length}
              className="w-full text-left rounded -mx-0.5 px-0.5 py-0.5 hover:bg-white/5 flex items-center gap-2">
              <span className="min-w-0 truncate"><StatusPill status={t.status} color={t.statusColor} /></span>
              {writable && options.length ? <span className="ml-auto shrink-0" style={{ color: "var(--text4)" }}>▾</span> : null}
            </button>
            {statusOpen && (
              <div className="agx-scroll absolute left-0 mt-1 rounded-lg shadow-2xl flex flex-col overflow-y-auto"
                style={{ zIndex: 30, background: "var(--bg2)", border: edge(28), minWidth: 210, maxHeight: 300 }}>
                {options.map((o) => (
                  <button key={o.status} className="text-left px-2 py-1.5 hover:bg-white/5"
                    onClick={() => {
                      setStatusOpen(false);
                      onAsk({
                        what: "Move this card", from: t.status, to: o.status,
                        done: `Moved to ${o.status}`,
                        go: () => api.clickupStatus(t.id, o.status, t.updated),
                      });
                    }}>
                    <StatusPill status={o.status} color={o.color} dim={o.type === "done" || o.type === "closed"} />
                  </button>
                ))}
              </div>
            )}
          </div>
        </CardField>

        <CardField label="Assigned">
          {/* A picker, not a toggle.
              This was "put yourself on / take yourself off" with a caret beside
              it that opened nothing — the API only ever knew one person's id,
              your own, so the caret was a promise the control could not keep.
              Now it lists the people on the card's own list and each one is a
              switch: ClickUp holds several assignees, so adding somebody must
              not quietly take off whoever else was on it. */}
          <div className="relative">
            <button disabled={!writable} onClick={() => writable && openWho()}
              className="w-full text-left rounded px-1 -mx-1 py-0.5 hover:bg-white/5 text-[11.5px] leading-tight flex items-center gap-1.5"
              style={{ color: t.mine ? "var(--success)" : "var(--text2)" }}>
              {!!t.people?.length && (
                <span className="inline-flex items-center shrink-0" style={{ paddingLeft: 3 }}>
                  {t.people.slice(0, 4).map((p, n) => <Face key={n} p={p} n={n} />)}
                </span>
              )}
              <span className="min-w-0 truncate">{t.mine ? "you" : (t.assignees.join(", ") || "nobody")}</span>
              {writable && <span className="ml-auto shrink-0" style={{ color: "var(--text4)" }}>▾</span>}
            </button>
            {whoOpen && (
              /* Anchored right, and capped.
                 Assigned sits in the right-hand column of a 380px pane, so a
                 menu growing rightwards from the label runs off the edge — it
                 did, and "David Pallarés Robaina" arrived as "David Pallarés
                 Robain". Names are people's names; they get truncated with an
                 ellipsis and a title, not cropped by a container. */
              <div className="agx-scroll absolute right-0 mt-1 rounded-lg shadow-2xl flex flex-col overflow-y-auto py-1"
                style={{ zIndex: 30, background: "var(--bg2)", border: edge(28), minWidth: 200, maxWidth: 260, maxHeight: 300 }}>
                {membersBusy && <Spinner label="Reading the team…" />}
                {!membersBusy && members?.length === 0 && (
                  <div className="px-2.5 py-2 text-[10.5px]" style={{ color: "var(--text3)" }}>
                    Nobody is a member of this list.
                  </div>
                )}
                {!membersBusy && members?.map((m) => {
                  const on = (t.people ?? []).some((p) => p.id === m.id);
                  return (
                    <button key={m.id} className="text-left px-2 py-1.5 hover:bg-white/5 flex items-center gap-2"
                      onClick={() => {
                        setWhoOpen(false);
                        onAsk({
                          what: on ? `Take ${m.me ? "yourself" : m.name} off this card` : `Put ${m.me ? "yourself" : m.name} on this card`,
                          done: on ? `${m.me ? "You are" : m.name + " is"} off it` : `${m.me ? "You are" : m.name + " is"} on it`,
                          go: () => api.clickupAssign(t.id, !on, t.updated, m.id),
                        });
                      }}>
                      <Face p={{ name: m.name, initials: m.initials, color: m.color, avatar: m.avatar, me: m.me }} n={0} />
                      <span className="flex-1 min-w-0 truncate text-[11.5px]" title={m.name}
                        style={{ color: on ? "var(--success)" : "var(--text2)" }}>
                        {m.name}{m.me ? " · you" : ""}
                      </span>
                      {on && <span className="text-[10px]" style={{ color: "var(--success)" }}>✓</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </CardField>

        {t.sprint && <CardField label="Sprint"><span style={{ color: "var(--info)" }}>{t.sprint}</span></CardField>}
        {t.points != null && <CardField label="Points"><span className="tabular-nums" style={{ color: "var(--text2)" }}>{t.points}</span></CardField>}
        {t.due && (
          <CardField label="Due">
            <span style={{ color: t.due < today ? "var(--error)" : t.due === today ? "var(--warning)" : "var(--text2)" }}>
              {dueLabel(t.due, today)}
            </span>
          </CardField>
        )}
        {t.estimateHours != null && (
          <CardField label="Estimate">
            <span className="tabular-nums" style={{ color: "var(--text2)" }}>
              {t.estimateHours}h{t.spentHours ? ` · ${t.spentHours}h logged` : ""}
            </span>
          </CardField>
        )}
        {t.start && <CardField label="Starts"><span style={{ color: "var(--text2)" }}>{dueLabel(t.start, today)}</span></CardField>}
        {t.list && <CardField label="List"><span style={{ color: "var(--text2)" }}>{t.list}</span></CardField>}
        {t.updated ? (
          <CardField label="Last moved">
            <span style={{ color: "var(--text3)" }} title={new Date(t.updated).toLocaleString()}>{fmtAgo(t.updated)}</span>
          </CardField>
        ) : null}
        {t.custom?.map((c) => {
          const spec = fields.find((f) => f.id === c.id);
          return (
            <CardField key={c.id} label={c.name.replace(/\s*\(.*\)\s*$/, "")}>
              <span style={{ color: "var(--text2)" }}>{c.value}{spec?.readOnly ? " 🔒" : ""}</span>
            </CardField>
          );
        })}
      </div>

      {/* Tags on their own full-width line. They were competing with a value
          column and losing, and they are how this board gets navigated. */}
      {!!t.tags.length && (
        <div className="flex items-center gap-1.5 flex-wrap mb-3">
          {t.tags.map((x) => (
            <span key={x} className="text-[10px] px-2 py-0.5 rounded-full"
              style={{ color: "var(--text2)", background: "color-mix(in srgb, var(--text) 10%, transparent)" }}>{x}</span>
          ))}
        </div>
      )}

      {/* What is in the way, and what this is in the way of.
          The most actionable thing on an engineering board — 28 of 30 cards on
          a real one have these — and it was the one thing not being shown.
          Resolved against the board's own rows, so naming them costs nothing.
          A dependency already finished is listed quietly rather than as a
          block: it is history, not an obstacle. */}
      {(!!waits.length || !!blocksThese.length) && (
        <div className="mb-3 pt-2.5" style={{ borderTop: edge(10) }}>
          {!!waits.length && (
            <>
              <div className="text-[8.5px] uppercase tracking-[0.18em] mb-1.5" style={{ color: waitsOpen.length ? "var(--error)" : "var(--text4)" }}>
                {waitsOpen.length ? `Blocked by ${waitsOpen.length}` : "Was waiting on"}
              </div>
              {waits.map((d) => <DepRow key={d.id} d={d} onGo={onGo} />)}
            </>
          )}
          {!!blocksThese.length && (
            <>
              <div className="text-[8.5px] uppercase tracking-[0.18em] mt-2 mb-1.5" style={{ color: "var(--text4)" }}>
                Blocking {blocksThese.length}
              </div>
              {blocksThese.map((d) => <DepRow key={d.id} d={d} onGo={onGo} />)}
            </>
          )}
        </div>
      )}

      {/* The pull requests this card produced.
          ClickUp's own GitHub panel knows them and its API does not expose
          them, so they are found the way the team already names things: the
          card id is in the branch, so GitHub's search finds them. Whatever the
          card's own field says is kept too — a link typed by hand outranks a
          search, and a PR in another repository would never be found by one.

          Shown when the search FAILED as well as when it found something, and
          those are different sentences. A card with no pull requests and a card
          whose search could not run both used to render as nothing at all —
          `gh` missing, `gh` not logged in, a checkout that is not this card's
          repository — so "we could not look" was displayed as "there are
          none", which is the one thing a panel like this must not say. A card
          that genuinely produced nothing still renders nothing: that is an
          answer, and it is correct. */}
      {(!!prs.length || prsErr) && (
        <div className="mb-3 pt-2.5" style={{ borderTop: edge(10) }}>
          <div className="text-[8.5px] uppercase tracking-[0.18em] mb-1.5 flex items-center gap-2" style={{ color: "var(--text4)" }}>
            Pull requests {!!prs.length && <span>{prs.length}</span>}
            {prsErr && (
              <span style={{ color: "var(--warning)" }}>
                {prs.length ? "· search failed, showing what the card states" : "· could not search GitHub — this is not “none”"}
              </span>
            )}
          </div>
          {prs.map((p) => (
            <div key={p.number} className="flex items-center gap-2 py-1">
              <button onClick={() => openPrs(String(p.number), p.state === "OPEN" || !p.state ? "open" : "all")}
                className="text-left flex-1 min-w-0 rounded px-1 -mx-1 hover:bg-white/5"
                title="Open this in Pull Requests">
                <span className="tabular-nums" style={{ color: "var(--primary)" }}>#{p.number}</span>
                {p.state && (
                  <span className="ml-1.5 text-[10px] tracking-[0.06em] px-1.5 rounded"
                    style={p.state === "MERGED"
                      ? { color: "#a371f7", background: "#a371f721" }
                      : p.state === "CLOSED"
                      ? { color: "var(--error)", background: "color-mix(in srgb, var(--error) 13%, transparent)" }
                      : { color: "var(--success)", background: "color-mix(in srgb, var(--success) 13%, transparent)" }}>
                    {p.draft ? "DRAFT" : p.state}
                  </span>
                )}
                {p.stated && (
                  <span className="ml-1.5 text-[10px]" style={{ color: "var(--text4)" }} title="named on the card itself">on the card</span>
                )}
                <div className="truncate text-[10.5px]" style={{ color: "var(--text3)" }}>{p.title || p.url}</div>
              </button>
              <a href={p.url} target="_blank" rel="noreferrer" className="text-[10px] px-1.5 py-0.5 rounded shrink-0"
                style={{ border: edge(16), color: "var(--text3)" }}>↗</a>
            </div>
          ))}
        </div>
      )}

      {/* No heading of ours: these cards open with their own "Description"
          heading, and stacking a label above it read as a stutter. */}
      {full?.description ? (
        <div className="mb-3 pt-2.5 agx-cu-body" style={{ borderTop: edge(10) }}>
          <Markdown text={full.description} />
        </div>
      ) : null}

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
      </>)}

      {view === "comments" && (<>
      {/* No heading and no rule of its own any more: the tab above already says
          "Comments 1", and repeating it under a divider read as a second section
          inside a pane that holds exactly one. Only the ordering survives,
          because a thread read in the wrong direction is a thread nobody can
          follow and there is nothing else on screen left to say it. */}
      {!!full?.comments?.length && (
        <div className="mb-3 pt-2">
          <div className="text-[8.5px] uppercase tracking-[0.18em] mb-1.5" style={{ color: "var(--text4)" }}>
            Oldest first
          </div>
          {/*
            * A conversation, not a list of strings.
            *
            * These were six paragraphs stacked with nothing between them, in
            * the order ClickUp happened to return — newest first — so a reply
            * sat above the thing it replied to and the whole thread read
            * backwards. Now they are oldest-first (fixed at the source) and
            * each one is a card with its author, so the eye can count turns.
            *
            * `1d` is how long ago; `3 Aug 18:21` is when. A thread is read
            * against a working day — "before or after the deploy" — and only
            * the second answers that. Both, since neither replaces the other.
            */}
          {full.comments.map((c) => (
            /* Room to breathe. These were mb-1.5/px-2.5/py-2 — a stack of
               paragraphs a millimetre apart, where the gap BETWEEN two comments
               was smaller than the gap between two lines inside one, so the
               eye had nothing to cut on and the column read as one block. */
            <div key={c.id} className="mb-3 rounded-lg px-3.5 py-3"
              style={{ background: "color-mix(in srgb, var(--bg3) 30%, transparent)", border: edge(10) }}>
              <div className="flex items-baseline gap-2 flex-wrap mb-2">
                <span className="text-[10.5px] font-semibold" style={{ color: "var(--text2)" }}>{c.who || "—"}</span>
                {!!c.at && (
                  <span className="text-[10px]" style={{ color: "var(--text4)" }}
                    title={new Date(c.at).toLocaleString()}>
                    {new Date(c.at).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                    {" · "}{fmtAgo(c.at)}
                  </span>
                )}
                {!!c.replies && (
                  /* Was "1 reply in ClickUp", and said neither of the two
                     things worth saying: who answered, and what they said. The
                     "in ClickUp" was the app apologising for not having them —
                     it has them now, so the words go and the thread opens. */
                  <button
                    onClick={() => setOpenThreads((s) => {
                      const n = new Set(s);
                      if (n.has(c.id)) n.delete(c.id); else n.add(c.id);
                      return n;
                    })}
                    disabled={!c.replyList?.length}
                    title={c.replyList?.length ? "Show the replies" : "This thread could not be loaded"}
                    className="text-[10px] px-1.5 py-0.5 rounded inline-flex items-center gap-1.5 hover:opacity-80 disabled:opacity-50"
                    style={{ color: "var(--primary)", border: "1px solid color-mix(in srgb, var(--primary) 35%, transparent)" }}>
                    <span style={{ transform: openThreads.has(c.id) ? "none" : "rotate(-90deg)", display: "inline-block" }}>▾</span>
                    {c.replies} {c.replies === 1 ? "reply" : "replies"}
                    {/* The faces, before anything is expanded. Most of what the
                        count is for is "did the person I asked answer, or was
                        it the bot again", and that is answerable at a glance. */}
                    {/* The existing Face, fed the reply's author. One avatar renderer for
                        the whole panel: a second one would drift from it the
                        first time either changed. */}
                    {c.replyList?.slice(0, 3).map((r, i) => (
                      <Face key={r.id} n={i} p={{ name: r.who, initials: r.initials ?? "", color: r.color, avatar: r.avatar }} />
                    ))}
                  </button>
                )}
              </div>
              {/* Through the markdown renderer, like the description: these
                  carry code spans and tables, and printing them raw is what
                  made the one comment worth reading unreadable. */}
              {/* Same body treatment as the description: a comment on these
                  cards is a paragraph of prose with symbol names through it,
                  and it is read for exactly the same reasons. Slightly tighter,
                  because it sits inside a card of its own. */}
              <div className="agx-cu-body agx-cu-note" style={{ color: "var(--text2)" }}><Markdown text={c.text} /></div>
              {/* The thread, when it is open. Indented and hung off a rule, so
                  a reply is never mistaken for the next comment — which is
                  exactly what a flat list of both would produce. */}
              {openThreads.has(c.id) && !!c.replyList?.length && (
                <div className="mt-3 flex flex-col gap-3"
                  style={{ marginLeft: 4, paddingLeft: 12, borderLeft: edge(18) }}>
                  {c.replyList.map((r) => (
                    <div key={r.id}>
                      <div className="flex items-center gap-2 flex-wrap mb-1.5">
                        <Face n={0} p={{ name: r.who, initials: r.initials ?? "", color: r.color, avatar: r.avatar }} />
                        <span className="text-[10.5px] font-semibold" style={{ color: "var(--text2)" }}>{r.who || "—"}</span>
                        {!!r.at && (
                          <span className="text-[10px]" style={{ color: "var(--text4)" }}
                            title={new Date(r.at).toLocaleString()}>
                            {new Date(r.at).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                          </span>
                        )}
                      </div>
                      <Markdown text={r.text} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      </>)}

      {full === null && <div className="mb-3"><Spinner label="Reading the card…" className="" /></div>}

      {/*
        * Pinned to the bottom of the pane, in as little height as it can hold.
        *
        * These three are what you press AFTER reading, and a card whose
        * description runs to two screens put them below all of it — so the last
        * thing a long card asked of you was to scroll back down past what you
        * had just read. Sticky costs nothing when the card is short (it sits
        * where it always did) and saves the scroll when it is not.
        *
        * Opaque, not translucent: it has comment text sliding under it, and a
        * blur here would be a per-frame composite on a pane that scrolls.
        */}
      <div className="flex items-center gap-1.5 flex-wrap pt-2 pb-3 mt-auto sticky bottom-0 z-20"
        style={{ borderTop: edge(10), background: "var(--bg)" }}>
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
                      requestTermIssue(cwd, windowName(t), cmd, true, yolo, t.title);
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
              <div className="px-2.5 pt-2 pb-1 flex items-center gap-2">
                <span className="text-[8.5px] uppercase tracking-[0.16em]" style={{ color: "var(--text4)" }}>
                  Or hand it over to write your own
                </span>
                <span className="flex-1" />
                {/* Where it lands. Sits with the rows it governs rather than in
                    Settings: it is the kind of choice you change because of what
                    you are about to do, not once a year. */}
                {(["chat", "term"] as const).map((d) => (
                  <button key={d} onClick={(e) => { e.stopPropagation(); setHandoffTo(d); setTo(d); }}
                    title={d === "chat" ? "Open it in the app's chat" : "Open it in a tmux pane, like a skill"}
                    className="text-[10px] px-1.5 py-0.5 rounded"
                    style={to === d
                      ? { background: "color-mix(in srgb, var(--primary) 20%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)", color: "var(--text)" }
                      : { border: edge(14), color: "var(--text4)" }}>
                    {d === "chat" ? "💬 chat" : "🖥 pane"}
                  </button>
                ))}
              </div>
              {HANDOFFS.map((h) => (
                <button key={h.id} className="text-left px-2.5 py-1.5 hover:bg-white/5"
                  style={{ color: "var(--text2)" }}
                  onClick={() => {
                    setAskOpen(false);
                    const cwd = rootForTask(t.list, repos, here);
                    if (!cwd) { onNote("No checkout to hand this to"); return; }
                    const text = h.build(t, full?.description ?? "");
                    // The same two destinations a skill offers, through the same
                    // two paths — nothing new is invented here.
                    if (to === "term") { requestTermIssue(cwd, windowName(t), text, true, yolo, t.title); onNote(`${t.customId || t.id} handed to a pane`); }
                    else onOpenChatWith?.(cwd, text, t.title.slice(0, 60));
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
        <button onClick={() => void copyIt(t.customId || t.id, "human")} className="text-[10.5px] px-2 py-1 rounded-lg"
          style={{ border: line, color: "var(--text2)" }}>Copy {t.customId ? "PROJ id" : "id"}</button>
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

  if (!data) return <div className="p-5"><Spinner label="Reading your task list…" className="" /></div>;
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

