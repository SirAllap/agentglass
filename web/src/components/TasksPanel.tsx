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
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { RefreshIcon } from "../lib/glyphIcons.tsx";
import { api } from "../lib/api.ts";
import { FilterBuilder } from "./tasks/FilterBuilder.tsx";
import { EMPTY, apply as applyFilters, liveCount as builtCount, type FilterSet } from "./tasks/filters.ts";
import type { GitRepoRef, IssueDetail, IssuePr, IssueRow, IssueWork, StartMode, LocalTask, TaskCapability, TasksListResponse, SkillInfo } from "../../../shared/types.ts";
import type { ProviderTask, ProviderTasksResponse, SavedView, SavedFolder, ViewTasksResponse, ListStatus, ListField, ListPlace, ListMember, TaskDetail, CardEvent, CardField as CardFieldValue } from "../../../shared/providers.ts";
import { CardWrites } from "../lib/cardWrites.ts";
import { activityRows, eventLine, foldLabel, folds, spanLabel, seenActor, NO_AUTHOR_NOTE } from "../lib/cardActivity.ts";
import { layoutCard } from "../lib/cardLayout.ts";
import { dayToMs, describeWithComment, estimateText, msToDay, parseEstimate, parsePoints, sortSprints, sprintShort, tagChoices } from "../lib/cardEdits.ts";

import { branchName, checkoutCommand, commitCommand, worktreeCommand } from "../lib/cardBranch.ts";
import { neighbours, shortTitle, hopMatches } from "../lib/cardHop.ts";
import { CardFiles } from "./CardFiles.tsx";
import { Composer } from "./tasks/Composer.tsx";
import { readState } from "../lib/boardStaleness.ts";
import { ViewHeader } from "./workspace/ViewHeader.tsx";
import { useDismiss } from "../lib/useDismiss.ts";
import { Portal } from "./Portal.tsx";
import { PeoplePick } from "./PeoplePick.tsx";
import { Markdown } from "../lib/markdown.tsx";
import { fmtAgo } from "../lib/format.ts";
import { StatusPill } from "./StatusPill.tsx";
import { Spinner } from "./Spinner.tsx";
import { requestTermIssue } from "../lib/termIssue.ts";
import { openSettings } from "../lib/openSettings.ts";
import { useFindScope } from "../lib/findScope.ts";
import { handoffTo, setHandoffTo, type HandoffTo } from "../lib/handoffTo.ts";
import { openPrs, openPr, prRefFromUrl } from "../lib/openPrs.ts";
import { matchesQuery } from "../lib/boardSearch.ts";
import { openCard, type CardJump } from "../lib/openCard.ts";
import type { IssueJump } from "../lib/openIssue.ts";
import { TASK_SOURCES, shownTaskSources, subscribeTaskSources, type TaskSourceId } from "../lib/taskSources.ts";
import { CHIP } from "./workspace/Chrome.tsx";
import { useTaskConnected, visibleTaskSources } from "../lib/taskConnected.ts";
import { landingSource, rememberTaskSource } from "../lib/taskLanding.ts";
import { externalUrl, openExternal } from "../lib/externalUrl.ts";
import { LAYER } from "../lib/layers.ts";
import { ContextMenu, MenuItem } from "./ContextMenu.tsx";
import { cardSkills, skillCommand, windowName, skillModes, namedForIt, shortName } from "../../../shared/cardSkills.ts";
import { subscribeReminders, liveReminders, nudgeReminders } from "../lib/reminderStore.ts";
import { parseLocal, toLine, sortTasks, step, checkbox, toggleCheckbox, checkProgress, rootForTask, taskPrompt, lineWith, inUse, typingInto, dueBucket, bucketCounts, dueLabel, stamp, TASK_KEYS, SORTS, type SortMode, type Bucket } from "../lib/taskGrammar.ts";
import { useSyncExternalStore } from "react";
import { CloseButton, CloseIcon } from "./CloseButton.tsx";
import { ICON } from "../lib/iconSize.ts";
import { useDialogs } from "./ConfirmDialog.tsx";
import { PRIOS, prioLook, Flag } from "../lib/priority.tsx";

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


/**
 * How far back a sweep reached, said the way somebody would say it.
 *
 * The number that comes back is an epoch millisecond and the question behind
 * it is "did it look at last week". Hours and days, because that is the range
 * this actually lands in: measured on the real workspace, three pages of sweep
 * reached back less than a day.
 */
function sinceWords(ms: number): string {
  const mins = Math.max(1, Math.round((Date.now() - ms) / 60_000));
  if (mins < 90) return `the last ${mins} minutes`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `the last ${hours} hours`;
  return `the last ${Math.round(hours / 24)} days`;
}

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
  /* What is actually set up on this machine. Null while the answer is in the
     air, which `visibleTaskSources` reads as "change nothing yet" — the bar
     draws the preference and then only ever loses tabs, never gains them, so
     it cannot be seen rearranging itself. See taskConnected.ts. */
  const connected = useTaskConnected();
  const tabs = useMemo(() => {
    const live = visibleTaskSources(shown, connected);
    // A forced source is an errand and outranks both the preference and the
    // connection check: it got here because something asked for a card by id.
    return sourceTabs(forced && !live.includes(forced) ? [...live, forced] : live);
  }, [shown, connected, forced]);

  /*
   * Where this opens, which used to be "all" and nothing else — see
   * taskLanding.ts for why that was the wrong constant rather than the wrong
   * default.
   *
   * Computed once, lazily, from the bar as it stands at first render. That is
   * enough to land on: the preference is a synchronous localStorage read, and
   * the connection check can only ever REMOVE tabs afterwards — so the worst
   * case is landing on a pinned source that turns out not to be set up, which
   * the reconcile effect below then steps off. One frame, self-correcting, and
   * no deferral machinery for the ordinary case.
   */
  const [source, setSource] = useState<SourceId>(() => landingSource(tabs.map((t) => t.id)) as SourceId);

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
            // borrowed tab back off the bar — see `forced`. It is also the only
            // gesture that writes the remembered tab: a jump is somebody
            // following a link, not moving house. See taskLanding.ts.
            <button key={s.id} onClick={() => { setForced(null); setSource(s.id); rememberTaskSource(s.id); }}
              aria-current={s.id === source ? "true" : undefined}
              className={CHIP}
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
  const [note, setNote] = useState<{ ok: boolean; text: string; go?: { label: string; run: () => void } } | null>(null);

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
        <button onClick={load} title="Refresh" className="agx-btn text-[11px] px-2 py-1 rounded-lg"
          style={{ color: "var(--text2)", border: edge(20) }}><RefreshIcon /></button>
      </div>

      {note && <NoteStrip note={note} onClose={() => setNote(null)} />}

      <div className="flex-1 min-h-0 flex">
        <div className="flex flex-col min-w-0" style={{ width: "48%", borderRight: edge(12) }}>
          {error && <div className="p-4 text-[11.5px]" style={{ color: "var(--error)" }}>{error}</div>}
          {!rows && !error && <div className="p-4"><Spinner label="Asking GitHub…" className="" /></div>}
          {rows?.length === 0 && <div className="p-5 text-[11.5px]" style={{ color: "var(--text3)" }}>Nothing matches.</div>}
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
            className="agx-btn text-[10px] px-2 py-1 rounded-lg" style={{ color: "var(--text2)", border: edge(20) }}>Assign to me</button>
          <button disabled={busy} onClick={() => void act(() => api.issueState(root, number, d.state === "OPEN"))}
            className="agx-btn text-[10px] px-2 py-1 rounded-lg" style={{ color: "var(--text2)", border: edge(20) }}>
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
              className="agx-btn ml-auto text-[10px] px-2 py-1 rounded-lg"
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
          <div className={`${EYEBROW} mb-1.5 flex items-center gap-2`} style={{ color: "var(--text4)" }}>
            Pull requests {!!prs.length && <span>{prs.length}</span>}
            {prsErr && <span style={{ color: "var(--warning)" }}>· could not ask GitHub — this is not “none”</span>}
          </div>
          {prs.map((p) => (
            <div key={p.number} className="flex items-center gap-2 py-1">
              {/* The pull request itself, not a search for its number. The row
                  carries the URL, and the URL carries the repository — which is
                  the half `openPrs` was missing, and why pressing this landed on
                  a filtered list instead of on the pull request. */}
              <button onClick={() => {
                const ref = prRefFromUrl(p.url);
                if (ref) openPr(ref.repo, p.number);
                else openPrs(String(p.number), p.state === "OPEN" ? "open" : "all");
              }}
                className="text-left flex-1 min-w-0 rounded px-1 -mx-1 hover:bg-white/5"
                title="Open this pull request">
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

/* `min-w-0` and a clip, for the same reason the card's band needed them: this
   holds joined lists (`assignees.join(", ")`) in a three-column grid, and a
   grid cell without `min-w-0` refuses to shrink below its content — so the
   long one pushes into its neighbour instead of being cut. The overlap was
   found on the other strip; this one had it waiting. */
const Field = ({ k, children }: { k: string; children: React.ReactNode }) => (
  <div className="min-w-0">
    <div className={`${EYEBROW} mb-1 truncate`} style={{ color: "var(--text3)" }} title={k}>{k}</div>
    <div className="text-[10.5px] min-w-0" style={{ color: "var(--text2)", overflowWrap: "anywhere" }}>{children}</div>
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
      <div className={`${EYEBROW} px-5 pt-2.5 pb-1`} style={{ color: "var(--error)" }}>Now</div>
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
/**
 * The reminder picker, drawn OUT of the row it belongs to.
 *
 * It was `position: absolute` inside the row, and a row lives in a scroller —
 * so the popover was clipped to a few pixels of itself and could not be used at
 * all. Reported that way: "that reminder is sort of inside the line and I can't
 * use it".
 *
 * Through a Portal, positioned against the button that opened it, which is what
 * every other menu in the app does. A popover anchored inside content that
 * scrolls is a popover that will be clipped by something eventually.
 */
function RemindPopover({ task, anchor, onClose, onSet }: {
  task: LocalTask;
  /** The control it hangs off, measured when it opens. */
  anchor: HTMLElement | null;
  onClose: () => void; onSet: (civil: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [free, setFree] = useState("");
  useDismiss(true, ref, onClose);
  /* Measured once, on open. Following the row while it scrolls would need a
     listener per popover for a box that is dismissed on the next click
     anywhere — and a menu that drifts under the pointer is worse than one that
     stays put. */
  const box = anchor?.getBoundingClientRect();
  const top = Math.min((box?.bottom ?? 0) + 6, (typeof window === "undefined" ? 800 : window.innerHeight) - 220);
  const right = Math.max(8, (typeof window === "undefined" ? 1200 : window.innerWidth) - (box?.right ?? 0));
  const parsed = useMemo(() => {
    const m = free.trim().match(/^(?:(\d{1,2})[:h](\d{2}))$/);
    if (!m) return null;
    const d = new Date(); d.setHours(+m[1]!, +m[2]!, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d;
  }, [free]);
  return (
    <Portal>
      {/* A catcher, so a click anywhere else closes it — the same shape the
          facet menus use. */}
      <div className="fixed inset-0" style={{ zIndex: 9998 }} onClick={onClose} />
      <div ref={ref} className="fixed rounded-lg text-[11px] shadow-2xl flex flex-col"
        style={{ top, right, zIndex: 9999, background: "var(--bg2)", border: edge(28), minWidth: 240, padding: 4 }}>
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
    </Portal>
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
  const [boards, setBoards] = useState<{ views: SavedView[]; folders?: SavedFolder[]; current?: string; writeEnabled: boolean; writeForced?: boolean } | null>(null);
  const [data, setData] = useState<ViewTasksResponse | null>(null);
  const [busy, setBusy] = useState(false);
  /** The board somebody just clicked, before its answer arrives. See `load`. */
  const [wanted, setWanted] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  /* Right-click on a board pill. `editing` is set when the errand is "change
     this board's address" rather than "add another", so the same bar serves
     both — prefilled, and replacing instead of appending. */
  const [menu, setMenu] = useState<{ v: SavedView; x: number; y: number } | null>(null);
  /** The same idea one level up: right-click a folder heading to take the whole
   *  folder off the sidebar. */
  const [folderMenu, setFolderMenu] = useState<{ f: SavedFolder; x: number; y: number } | null>(null);
  /** The card dialog, when it is open over the table: what a find searches. */
  const cardBox = useRef<HTMLDivElement>(null);
  /*
   * A list's own tabs, hung under it in the rail.
   *
   * ClickUp calls them views and a list can have several — `Eng list view`,
   * `Blue Eng list view`, `Frontend` — each a different filter over the same
   * cards, and they are what a team actually works from. Read on demand rather
   * than up front: one call per list somebody opens, cached for the session,
   * instead of one per list on every board load.
   */
  const [aboutOpen, setAboutOpen] = useState(false);
  /* A brief belongs to the board it describes: switching boards with it open
     would leave the last one's on screen over the new one's rows. Keyed on the
     loaded board rather than on `lit`, which is defined below the panel's early
     returns — and a hook cannot live down there. */
  useEffect(() => { setAboutOpen(false); }, [data?.view?.id]);
  const [listViews, setListViews] = useState<Record<string, { id: string; name: string }[]>>({});
  /** The views this app cannot draw — a Gantt, a dashboard — as shortcuts out
   *  to ClickUp, hung under the same list. */
  const [listLinks, setListLinks] = useState<Record<string, { id: string; name: string; type: string }[]>>({});
  const [openLists, setOpenLists] = useState<Record<string, boolean>>({});
  /** Ask once, remember for the session. Safe to call for a list already
   *  known or already in flight. */
  const asked = useRef(new Set<string>());
  const ensureListViews = useCallback((listId: string) => {
    if (!listId || asked.current.has(listId)) return;
    asked.current.add(listId);
    api.clickupListViews(listId)
      .then((r) => {
        setListViews((m) => ({ ...m, [listId]: r.views ?? [] }));
        setListLinks((m) => ({ ...m, [listId]: r.links ?? [] }));
      })
      .catch(() => setListViews((m) => ({ ...m, [listId]: [] })));
  }, []);

  const openList = useCallback((v: SavedView) => {
    if (!v.listId) return;
    setOpenLists((m) => ({ ...m, [v.id]: !m[v.id] }));
    ensureListViews(v.listId);
  }, [ensureListViews]);
  const [editing, setEditing] = useState<SavedView | null>(null);
  /** Put the address bar away, whatever it was in the middle of. */
  const closeAddBar = useCallback(() => { setAdding(false); setEditing(null); setUrlText(""); }, []);
  const [urlText, setUrlText] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string; go?: { label: string; run: () => void } } | null>(null);
  const [q, setQ] = useState("");
  /** The search box itself, so clearing it can hand the caret straight back. */
  const searchBox = useRef<HTMLInputElement | null>(null);
  const [tag, setTag] = useState<string | null>(null);
  const [mineOnly, setMineOnly] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [statusPick, setStatusPick] = useState<string[]>([]);
  /** The built filter — field, is/is not, values — see tasks/filters.ts. */
  const [built, setBuilt] = useState<FilterSet>(EMPTY);
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
  /*
   * How wide the card pane is, in pixels, dragged by its edge.
   *
   * It used to be a boolean behind a `narrow`/`wider` button — two widths,
   * 380 and 720, and nothing in between. The button is gone because a drag does
   * its whole job and more; double-clicking the handle is what is left of its
   * one useful property, getting back to the usual width in one press.
   *
   * Global rather than per board: this is about your screen, not about the
   * list. The opposite of the folds and the filters, which belong to a board
   * because a board is a place.
   */
  /* The list menu. Open by default and remembered: with twenty boards it is the
     way you move, and a navigation that hides itself between sessions makes
     people learn the search box instead. */
  const [railOpen, setRailOpen] = useState(() => {
    try { return localStorage.getItem(RAIL_KEY) !== "0"; } catch { return true; }
  });
  useEffect(() => { try { localStorage.setItem(RAIL_KEY, railOpen ? "1" : "0"); } catch { /* private mode */ } }, [railOpen]);
  const [railQ, setRailQ] = useState("");
  /* Filtered on both names a board has: what ClickUp calls the list and what it
     calls the view. The rail draws `listName || name`, so matching only the
     drawn one would leave a board findable by a word that is not on screen and
     unfindable by the one that is. */
  const railViews = useMemo(() => {
    const needle = railQ.trim().toLowerCase();
    const all = boards?.views ?? [];
    if (!needle) return all;
    return all.filter((v) => `${v.listName ?? ""} ${v.name}`.toLowerCase().includes(needle));
  }, [boards, railQ]);

  /*
   * The sidebar as ClickUp draws it: space › folder › list.
   *
   * A flat column of list names is fine at four boards and unreadable at
   * twenty — which is what adding a folder whole produces, since a real one
   * holds a dozen. The grouping is not a preference: `Orbit v2 – Phase 1`
   * and `Grasshopper V1` mean different things depending on which folder they
   * are in, and the folder is the thing somebody actually navigates by.
   *
   * Two kinds of heading, and they behave differently on purpose:
   *   - a SAVED folder, which can be taken off the sidebar whole;
   *   - the folder a pasted list happens to live in, which is only a heading.
   * The built-in board and anything with no folder yet stay ungrouped at the
   * top, where they were.
   */
  const railGroups = useMemo(() => {
    const saved = new Map((boards?.folders ?? []).map((f) => [f.id, f]));
    /* A saved folder, found by NAME — for the rows that only know their
       breadcrumb. A pasted view carries the folder's name and not its id, and
       keying those separately drew the same folder twice: once with the five
       lists it holds, once with the one view somebody had saved over it. */
    const byName = new Map((boards?.folders ?? []).map((f) => [f.name, f.id]));
    const loose: SavedView[] = [];
    const groups = new Map<string, { key: string; folderId?: string; folder: string; space?: string; views: SavedView[] }>();
    for (const v of railViews) {
      const folder = v.folderName || "";
      if (v.builtin || !folder) { loose.push(v); continue; }
      const id = v.folderId ?? byName.get(folder);
      const key = id ? `f:${id}` : `n:${v.spaceName ?? ""}/${folder}`;
      const g = groups.get(key) ?? { key, folderId: id, folder, space: v.spaceName, views: [] };
      g.views.push(v);
      groups.set(key, g);
    }
    /* Saved folders first and in the order they were added — they are the ones
       somebody chose — then the folders inferred from pasted lists. */
    const rank = (g: { folderId?: string }) => (g.folderId && saved.has(g.folderId) ? saved.get(g.folderId)!.addedAt : Number.MAX_SAFE_INTEGER);
    return { loose, groups: [...groups.values()].sort((a, b) => rank(a) - rank(b) || a.folder.localeCompare(b.folder)) };
  }, [railViews, boards]);

  /*
   * One row of the sidebar, at a depth.
   *
   * A function rather than a component so the grouped and ungrouped halves
   * cannot drift: they were one `.map` and everything about a row — the
   * right-click menu, the busy dots, which one is lit — belongs to both.
   */
  /**
   * A list, with its own views folded underneath it.
   *
   * The twisty is separate from the row on purpose: opening a list's tabs and
   * opening the list are different intentions, and one target that did both
   * would mean every glance at the tabs also spent a board read.
   */
  const railList = (v: SavedView) => {
    const kids = v.listId ? listViews[v.listId] : undefined;
    const links = v.listId ? listLinks[v.listId] ?? [] : [];
    const open = !!openLists[v.id];
    return (
      <Fragment key={v.id}>
        <div className="flex items-stretch">
          {/* Only when there is something behind it. The views are read for
              every list in an open folder, so "no arrow" means "asked, and it
              has none" rather than "not looked yet" — and an arrow that opens a
              line saying "no other views" is a control that exists to
              disappoint. */}
          {kids?.length || links.length ? (
            <button onClick={() => openList(v)} aria-expanded={open}
              title={open ? "Hide this list's views" : `${(kids?.length ?? 0) + links.length} more view${(kids?.length ?? 0) + links.length === 1 ? "" : "s"} on this list in ClickUp`}
              className="shrink-0 grid place-items-center agx-btn"
              style={{ width: 16, color: "var(--text4)" }}>
              <svg viewBox="0 0 16 16" width={ICON.xs} height={ICON.xs} fill="currentColor" aria-hidden
                style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 120ms ease" }}>
                <path d="M6 3.5 10.5 8 6 12.5Z" />
              </svg>
            </button>
          ) : <span aria-hidden style={{ width: 16 }} />}
          <div className="min-w-0 flex-1">{railRow(v, 1)}</div>
        </div>
        {open && (!!kids?.length || !!links.length) && (
          /* Their own guide line, indented past the list's glyph: without it
             they sat at the list's own indent and read as siblings of it rather
             than as what it holds. */
          <div style={{ marginLeft: 24, borderLeft: `1px solid color-mix(in srgb, var(--text) 12%, transparent)` }}>
            {kids?.map((view) => railRow({
              id: view.id, name: view.name, listId: v.listId, listName: v.listName ?? v.name,
              url: "", addedAt: 0, folderId: v.folderId, folderName: v.folderName, spaceName: v.spaceName,
            }, 1))}
            {/* And the ones that only exist over there. Marked with the arrow
                this app uses everywhere for "this leaves", because a row that
                looks like the others and opens a browser is a small betrayal. */}
            {links.filter((l) => clickupViewUrl(boards?.folders ?? [], l)).map((l) => (
              <button key={l.id}
                onClick={() => { const u = clickupViewUrl(boards?.folders ?? [], l); if (u) openExternal(u); }}
                title={`${l.name} — opens in ClickUp (${l.type})`}
                className="w-full text-left flex items-center gap-1.5 py-1 text-[11.5px] agx-btn"
                style={{ paddingLeft: 8, paddingRight: 10, color: "var(--text4)" }}>
                <span aria-hidden className="shrink-0 grid place-items-center" style={{ width: 13 }}>
                  <svg viewBox="0 0 16 16" width={ICON.xs} height={ICON.xs} fill="none" stroke="currentColor"
                    strokeWidth={1.6} strokeLinecap="round" aria-hidden>
                    {l.type === "gantt"
                      ? <path d="M2.5 4h6M4.5 8h7M2.5 12h4" />
                      : <path d="M2.5 12.5V8M6.5 12.5V4M10.5 12.5V6M14 12.5V9.5" />}
                  </svg>
                </span>
                <span className="truncate min-w-0 flex-1">{l.name}</span>
                <span aria-hidden className="shrink-0 text-[9px]" style={{ opacity: 0.7 }}>↗</span>
              </button>
            ))}
          </div>
        )}
      </Fragment>
    );
  };

  const railRow = (v: SavedView, depth: number) => (
    <button key={v.id}
      onClick={() => { setSel(null); setOnLooked(false); closeAddBar(); void load(v.id, false, true); }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu({ v, x: e.clientX, y: e.clientY }); }}
      aria-current={!onLooked && lit === v.id}
      aria-busy={wanted === v.id}
      className="w-full text-left flex items-center gap-1.5 py-1 text-[11.5px]"
      style={{
        // Inside a folder the guide line already carries the indent, so the row
        // only owes it a small step. Outside one it starts where the folder
        // glyph does, so the two columns line up rather than nearly line up.
        paddingLeft: depth ? 8 : 10, paddingRight: 10,
        /* The built-in board gets its OWN tint, warm against the boards'
           primary. It behaves differently from everything under it — it asks
           the whole workspace rather than reading one board — and it is the
           row you come back to, so telling it apart at a glance is worth a
           second colour. */
        ...(!onLooked && lit === v.id
          ? v.builtin
            ? { background: "color-mix(in srgb, var(--success) 18%, transparent)", color: "var(--text)" }
            : { background: "color-mix(in srgb, var(--primary) 16%, transparent)", color: "var(--text)" }
          : { color: v.builtin ? "var(--text2)" : "var(--text3)" }),
      }}
      title={v.builtin
        ? "Every card assigned to you, across the workspace — the same list as ClickUp's My Work. Slower than a board (it asks the whole workspace), so it opens on what you last saw."
        : v.listName ? `${v.listName} · ${v.name}` : v.name}>
      {/* The built-in one stays marked: beside four board names it reads as a
          fifth board somebody added, and it is the one that behaves
          differently. */}
      {/* YOUR FACE ON THE BUILT-IN ONE. It is the board about a person, and it
          was marked with the same 6px ring every other "this is different" mark
          in the app uses — which told you it was different and not what it was.
          The ring stays as the fallback: no picture, no empty circle. */}
      {v.builtin && (myFace
        ? (
          <img src={myFace} alt="" loading="lazy" referrerPolicy="no-referrer"
            className={`shrink-0 rounded-full${wanted === v.id ? " animate-pulse" : ""}`}
            style={{
              width: 15, height: 15, objectFit: "cover",
              outline: lit === v.id ? "1.5px solid var(--primary)" : "none", outlineOffset: 1,
            }} />
        )
        : (
          <span aria-hidden className={`shrink-0${wanted === v.id ? " animate-pulse" : ""}`} style={{
            width: 6, height: 6, borderRadius: 999,
            border: `1.5px solid ${lit === v.id ? "var(--primary)" : "var(--text4)"}`,
          }} />
        ))}
      {/*
        * A saved ClickUp VIEW draws its own name, not its list's.
        *
        * The rail drew `listName || name` for everything, which is right for a
        * list and wrong for a view: `Eng list by start date view` over
        * `Orbit v2 – Phases 2 & 3` appeared as a second row called
        * `Orbit v2 – Phases 2 & 3`, directly under the folder's copy of that
        * same list. A tag saying "view" was the first attempt and it did not
        * help — two rows with one name and a badge is still two rows with one
        * name. The name is what tells them apart, so the name is what changes;
        * which list it is over is in the tooltip, where it was already.
        */}
      {/* A list glyph beside every row that is one, so a list and the folder
          above it are told apart by shape and not only by indent. The built-in
          board keeps its own ring — it is not a list and does not behave like
          one. */}
      {/* THE LIST'S OWN COLOUR, when the tracker gave it one. Not its icon —
          the emoji is not in the v2 API — but the colour behind that icon is,
          and it is the half that does the work: `Bugs` is a red one, and a red
          dot finds it across a rail faster than a name in grey. Falls back to
          the generic list glyph, which is still what tells a list from the
          folder above it when there is no colour. */}
      {/* depth > 0 was wrong: a list pasted by address sits at the ROOT of the
          bar, not under a folder, and it is the one most likely to be a list
          somebody picked out on purpose — so it was the one row with no mark
          at all. Every board that is not the built-in one gets it now. */}
      {!v.builtin && (
        <span aria-hidden className="shrink-0 grid place-items-center" style={{ width: 14, color: "var(--text4)" }}>
          {v.color
            ? <span className="rounded-full" style={{ width: 8, height: 8, background: v.color }} />
            : (
              <svg viewBox="0 0 16 16" width={ICON.xs} height={ICON.xs} fill="none" stroke="currentColor"
                strokeWidth={1.6} strokeLinecap="round" aria-hidden>
                <path d="M2.5 4.5h2M2.5 8h2M2.5 11.5h2M6.75 4.5h6.75M6.75 8h6.75M6.75 11.5h6.75" />
              </svg>
            )}
        </span>
      )}
      <span className="truncate min-w-0 flex-1">{v.name && v.listName && v.name !== v.listName ? v.name : (v.listName || v.name)}</span>
      {wanted === v.id && <span className="shrink-0 animate-pulse" style={{ color: "var(--text3)" }}>…</span>}
    </button>
  );

  /**
   * What the folded rail says: the board on screen, by the name the rail would
   * draw for it.
   *
   * `wanted ?? data?.view?.id` written out rather than reading `lit`, which is
   * the same expression five hundred lines below this one. Reading it here
   * threw `Cannot access 'lit' before initialization` the moment this panel
   * rendered — a blank window, every time, with the whole app gone.
   *
   * TypeScript did not catch it and could not: the read sits inside the
   * callback of a `.find`, and a callback is only a temporal-dead-zone error
   * when it happens to run immediately, which this one does. The rule that
   * follows is the cheap one — a value used at the top of a component is
   * DEFINED at the top of it.
   */
  const railActive = (() => {
    const on = wanted ?? data?.view?.id;
    const v = (boards?.views ?? []).find((x) => x.id === on);
    if (!v) return "Lists";
    return v.name && v.listName && v.name !== v.listName ? v.name : (v.listName || v.name);
  })();

  /** Which folders are folded shut. By folder key and kept across restarts: a
   *  sidebar that reopens with twelve folders expanded is the flat list again. */
  const [railShut, setRailShut] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem(RAIL_SHUT_KEY) || "{}") as Record<string, boolean>; } catch { return {}; }
  });
  useEffect(() => { try { localStorage.setItem(RAIL_SHUT_KEY, JSON.stringify(railShut)); } catch { /* private mode */ } }, [railShut]);

  /*
   * Ask every visible list what views it has, once.
   *
   * The alternative is asking when somebody clicks the arrow — but then the
   * arrow has to be drawn before the answer is known, on every list, and half
   * of them open a line saying "no other views". Knowing costs one small call
   * per list in an OPEN folder, cached for the session, and it is what lets the
   * rail draw an arrow only where there is something behind it.
   */
  useEffect(() => {
    if (!railOpen) return;
    for (const g of railGroups.groups) {
      if (railShut[g.key]) continue;
      for (const v of g.views) if (v.listId) ensureListViews(v.listId);
    }
  }, [railOpen, railGroups, railShut, ensureListViews]);

  /* Sidebar or modal. Global for the same reason the width is: how you like to
     read a card is about you, not about which list you are on. Full screen was
     offered and turned down — it covers the table entirely, and in an app that
     already lives in tabs it does nothing the modal does not. */
  const [cardMode, setCardMode] = useState<"side" | "modal">(() => {
    try { return localStorage.getItem(CARD_MODE_KEY) === "modal" ? "modal" : "side"; } catch { return "side"; }
  });
  useEffect(() => { try { localStorage.setItem(CARD_MODE_KEY, cardMode); } catch { /* private mode */ } }, [cardMode]);
  /* While the card is a dialog over the table, it IS the screen — a find that
     also walked the hundred rows behind it would be answering a question
     nobody asked. In the sidebar it is part of the same screen, so it is not
     scoped. */
  useFindScope(cardBox, cardMode === "modal" && sel !== null);
  /* Escape closes the modal, and only the modal: in the sidebar the card is
     part of the layout rather than something laid over it, and a key that
     empties a pane you did not open is a key that loses your place. */
  useEffect(() => {
    if (cardMode !== "modal" || !sel) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSel(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cardMode, sel]);
  const [cardW, setCardW] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(CARD_W_KEY));
      if (Number.isFinite(saved) && saved > 0) return clampCardW(saved);
      // The old two-state setting, read once so nobody who liked it wide
      // arrives narrow the first time.
      return localStorage.getItem(WIDE_KEY) === "1" ? 720 : CARD_W_DEFAULT;
    } catch { return CARD_W_DEFAULT; }
  });
  useEffect(() => { try { localStorage.setItem(CARD_W_KEY, String(cardW)); } catch { /* private mode */ } }, [cardW]);
  /*
   * The card's own layout asks one question — "have I got room for two columns"
   * — and it is a question about pixels.
   *
   * Which pixels, though: this read the SIDEBAR's width in both shells, so a
   * card in the modal, at nine tenths of a 2000px screen, laid itself out as a
   * narrow column whenever the pane behind it happened to be dragged small.
   * Found by comparing the two shells side by side, which is the only way that
   * kind of thing is ever found.
   */
  const wide = cardMode === "modal" || cardW >= 560;
  const dragging = useRef(false);
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

  /*
   * Which board was asked for last, so a slow answer cannot win.
   *
   * Reported: open one board, step to another and come back quickly, and a few
   * seconds later the panel moves you to the one you left. That is the first
   * board's answer landing after the second — and the settle loop behind it,
   * which keeps re-reading for up to 45 seconds and painting whatever it finds.
   * Neither of them checked whether you were still looking.
   */
  const asking = useRef(0);
  const load = useCallback(async (id?: string, force = false, asked = false) => {
    const ticket = ++asking.current;
    /* Any settle still running belongs to the board being left. Bumping the
       counter is how it is told to stand down — see `settle`. */
    settling.current++;
    setBusy(true);
    if (asked && id) setWanted(id);
    try {
      const r = await api.clickupView(id, force);
      if (ticket !== asking.current) return; // a later board already won
      setData(r);
      if (r.revalidating && r.view?.id) void settle(r.view.id, r.at);
    } catch {
      if (ticket !== asking.current) return;
      /*
       * Keep the board, and keep its rows.
       *
       * This used to replace everything with an empty answer, which cost two
       * things at once. The rows: an empty list reads as "nothing to do" and
       * gets acted on, and the same rule is written down two screens up about
       * a failed read at the other end. And the BOARD: `view` went with them,
       * so the next Refresh had no id to send and the server fell back to
       * whichever board was last opened — you press Refresh on the list in
       * front of you and something else gets re-read.
       *
       * A server we could not reach for one request has not moved anybody's
       * cards. Say so in the strip and leave the screen alone.
       */
      setData((d) => (d
        ? { ...d, error: "Could not reach the server" }
        : { tasks: [], statuses: [], fields: [], at: 0, error: "Could not reach the server" }));
    } finally {
      if (ticket === asking.current) { setBusy(false); setWanted(null); }
    }
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


  /*
   * A filter belongs to the board it was set on.
   *
   * They were panel state, so narrowing one board to `backend` and stepping to
   * another arrived with `backend` still on — over a board where it means
   * something else, or nothing. Reported that way. Kept per board instead: what
   * you set is still there when you come back, and never travels.
   */
  const filtersByBoard = useRef<Record<string, {
    q: string; tag: string | null; mineOnly: boolean; statusPick: string[]; readyOnly: boolean;
    /* Which status groups are rolled up. It rode on the status NAME alone and
       nothing said which board — so folding "In development" away on one list
       folded it on every other list that happens to use the same word, which is
       all of them: the statuses come from one workspace. Reported as boards
       sharing what you do on them, and it belongs here for the same reason the
       filters do — a board is a place, and what you set in it stays in it. */
    folded: Record<string, boolean>;
  }>>({});
  const landedOn = useRef<string | null>(null);
  useEffect(() => {
    const id = data?.view?.id;
    if (!id || landedOn.current === id) return;
    const leaving = landedOn.current;
    if (leaving) filtersByBoard.current[leaving] = { q, tag, mineOnly, statusPick, readyOnly, folded };
    landedOn.current = id;
    const kept = filtersByBoard.current[id];
    setQ(kept?.q ?? "");
    setTag(kept?.tag ?? null);
    setMineOnly(kept?.mineOnly ?? false);
    setStatusPick(kept?.statusPick ?? []);
    setReadyOnly(kept?.readyOnly ?? false);
    // Nothing kept means a board arrives fully expanded, which is what you want
    // the first time you open one.
    setFolded(kept?.folded ?? {});
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

  /* One list that sits directly in a space. The picker sends its id and
     nothing else — the resolver takes a bare list id, which is the whole
     address there is for a list with no folder around it. */
  const addList = async (listId: string) => {
    setBusy(true);
    const r = await api.clickupAddView(listId);
    setBusy(false);
    if (!r.ok) { setNote({ ok: false, text: r.error ?? "That did not work" }); return; }
    setAdding(false); setNote(null);
    await loadBoards();
    await load(r.view?.id, true);
  };

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

  /**
   * Add a folder whole.
   *
   * Not a shortcut for adding its lists: what is stored is the FOLDER, so a
   * list created in it next month turns up here without anybody coming back to
   * this dialog. Nothing is opened afterwards — a folder is a heading, and
   * jumping into an arbitrary one of its twelve lists is a decision the app
   * does not get to make.
   */
  const addFolder = async (id: string, spaceName: string) => {
    setBusy(true);
    const r = await api.clickupAddFolder(id, spaceName);
    setBusy(false);
    if (!r.ok) { setNote({ ok: false, text: r.error ?? "That folder did not go on" }); return; }
    setNote({ ok: true, text: `${r.folder?.name ?? "Folder"} added — ${r.folder?.lists?.length ?? 0} list${r.folder?.lists?.length === 1 ? "" : "s"}` });
    await loadBoards();
  };

  /** Take a folder off the sidebar. Its lists go with it; ClickUp is not
   *  touched, and a list you had ALSO pasted by hand stays. */
  const dropFolder = async (f: SavedFolder) => {
    setFolderMenu(null);
    await api.clickupRemoveFolder(f.id).catch(() => {});
    setNote({ ok: true, text: `${f.name} is off the sidebar — untouched in ClickUp` });
    await loadBoards();
    if (data?.view?.id && (f.lists ?? []).some((l) => `list:${l.id}` === data.view?.id)) await load(undefined, true);
  };

  /** Take a board off the bar. The built-in one has no address and cannot go. */
  const dropBoard = async (v: SavedView) => {
    setMenu(null);
    await api.clickupRemoveView(v.id).catch(() => {});
    setNote({ ok: true, text: `${v.listName || v.name} is off this bar — untouched in ClickUp` });
    await loadBoards();
    if (data?.view?.id === v.id) await load(undefined, true);
  };

  /*
   * A field write lands on the press.
   *
   * There used to be a strip across the top asking "Do it / Cancel" in front of
   * every one of these, and it made triage slower than the website: two presses
   * and a read for a decision that was made when the menu was opened. It is gone
   * for FIELD writes — status, assignees — which are the ones you make dozens of
   * in a morning and which ClickUp itself applies on the click. Nothing else about
   * the safety changed: the stamp guard still refuses a card somebody else moved,
   * and what did not land says so.
   *
   * Everything about ordering, stamps and what is in flight lives in cardWrites.ts;
   * see the top of that file for why a second write from the same screen used to be
   * refused with somebody else's name on it.
   */
  const [wrote, setWrote] = useState(0);
  /** Cards as the server has them after a write, over whatever the board last
   *  read. Cleared by a load, which is the authority. */
  const [over, setOver] = useState<Record<string, ProviderTask>>({});
  const writes = useRef<CardWrites | null>(null);
  if (!writes.current) {
    writes.current = new CardWrites({
      onTask: (task) => setOver((m) => ({ ...m, [task.id]: task })),
      onNote: (n) => setNote(n),
      /* The value drawn before the answer came back was a guess, and it was
         wrong: back to whatever the board really read. */
      onRollback: (w) => setOver((m) => { const { [w.id]: _gone, ...rest } = m; return rest; }),
      onChange: () => setWrote((n) => n + 1),
    });
  }
  const queue = writes.current;

  /** Draw this now, before the answer arrives. Replaced by the server's own copy
   *  the moment it lands, and dropped if the write is refused. */
  const guess = (t: ProviderTask, patch: Partial<ProviderTask>) =>
    setOver((m) => ({ ...m, [t.id]: { ...t, ...patch } }));

  /** The one write path. `Pending` is still the shape — it carries what to say
   *  when it lands — with the key of the control that is saving. */
  const apply = (t: ProviderTask, key: string, p: Pending) => {
    if (p.optimistic) guess(t, p.optimistic);
    void queue.run({
      id: t.id, key, readAt: t.updated, done: p.done,
      go: (stamp) => p.go(stamp),
    });
  };

  /*
   * The board is re-read when the writes stop, not after each one.
   *
   * Each write already answers with the card it changed, so the row on screen is
   * right without asking again — and asking after every one of them would put a
   * full board fetch behind every keystroke of a triage session. This is the
   * catch-up for everything a write touches indirectly: a status that moved the
   * card into another list's group, an automation that fired on it.
   */
  useEffect(() => {
    if (queue.pending > 0) return;
    if (!Object.keys(over).length) return;
    const timer = setTimeout(() => { void load(data?.view?.id, true); }, 1200);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wrote, over]);

  /** Writes that are still to come must not be sent against a stamp from before
   *  a fresh read. */
  useEffect(() => { queue.reset(); setOver({}); }, [data, queue]);



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
  /*
   * The board's cards, with anything a write has changed drawn over them.
   *
   * One place, because every count, filter and the card pane itself read from it:
   * a status applied on the press has to move the row, the group heading and the
   * pill in the card at the same moment, or the panel looks like it half-worked.
   */
  const tasks = useMemo(
    () => (data?.tasks ?? []).map((t) => over[t.id] ?? t),
    [data, over],
  );

  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  /*
   * Whether a failed read is worth a word or a warning. The rule and its thresholds
   * live in boardStaleness.ts, with a suite on them: this is the thing that was
   * getting it wrong, and it was getting it wrong in the direction that costs
   * somebody's attention every week.
   */
  const reads = readState({ error: data?.error, at: data?.at, rows: tasks.length, pollMs });
  const softFail = reads === "retrying";
  const alarming = reads === "stale";
  const blockedBy = useCallback((t: ProviderTask) =>
    (t.waitsOn ?? []).map((id) => byId.get(id)).filter((x): x is ProviderTask => !!x && x.statusKind !== "done"),
  [byId]);

  /*
   * WHAT THE LAST SEARCH FOUND, so the query cannot hide it.
   *
   * A card that mentions `9175` does not contain the text `9175` in its title
   * or its id — the mention is in its body, which is the whole point of that
   * search. The box then filtered the drawer by the same query and hid every
   * one of them: the banner said "2 cards mention 9175 — in Looked up" and
   * Looked up looked empty until the box was cleared by hand. "it's all weird",
   * and it was.
   *
   * So the results of a search are exempt from the filter that produced them,
   * until the next search or a different query.
   */
  /*
   * WHAT A SEARCH FOUND, ON TOP OF THE BOARD.
   *
   * The answers used to be pushed into the Looked-up drawer and the reader had
   * to go and find them: "that Looked up is really stupid and pointless". Every
   * other tool he uses — ClickUp's own Ctrl+K among them — answers a search
   * with a LIST YOU PICK FROM, over whatever you were looking at, and puts you
   * where you chose. So the drawer stays as the place a card lives once it is
   * open, and stops being the way results are delivered.
   */
  const [results, setResults] = useState<{ asked: string; rows: ProviderTask[]; looking: boolean } | null>(null);

  /*
   * THE EXPENSIVE HALF, READ BEFORE IT IS ASKED FOR.
   *
   * A search that has to read three hundred cards with their bodies takes
   * about 45 seconds; the same search a minute later takes 24ms. Nobody wants
   * to be the one who pays for the first read, so the board pays it quietly
   * when it opens. Once per mount, never awaited, and the server does nothing
   * when its sweep is still warm.
   */
  useEffect(() => { void api.clickupWarm(); }, []);
  const [foundBySearch, setFoundBySearch] = useState<Set<string>>(new Set());
  const exempt = useCallback((t: ProviderTask) => foundBySearch.has(t.id), [foundBySearch]);

  const rows = useMemo(() => {
    const all = tasks;
    /* The built filter runs FIRST and on the whole set, so the chips above it
       narrow what it left rather than the other way round. Both orders give
       the same rows; this one keeps `apply` reading a plain list of cards,
       which is what its tests give it. */
    const base = applyFilters(all, built);
    return base.filter((t) =>
      // An explicit pick overrides the done/not-done default: asking to see
      // "in production" and getting nothing would be absurd.
      (statusPick.length ? statusPick.includes(t.status) : (showDone || t.statusKind !== "done"))
      && (!mineOnly || t.mine)
      && (!tag || t.tags.includes(tag))
      && (!readyOnly || !blockedBy(t).length)
      && (matchesQuery(t, q) || exempt(t)));
  }, [tasks, q, tag, mineOnly, showDone, statusPick, readyOnly, blockedBy, built, exempt]);

  const tags = useMemo(() => {
    const seen = new Set<string>();
    for (const t of tasks) for (const x of t.tags) seen.add(x);
    return [...seen].sort();
  }, [tasks]);

  /*
   * THE SWATCH COLUMN, as a filter.
   *
   * "I need more filters, to filter only by the cards of one squad." The tags
   * along the top are ClickUp's TAGS; a squad is a custom field, which is why
   * it had a column and no chip — the board could show you which squad every
   * card belonged to and could not show you one squad's cards.
   *
   * Not hardcoded to the word "squad": `swatch` already finds whichever
   * coloured field this board has (squad, team, pod, tribe, or the first
   * coloured one there is), and the chips take their name and their colour
   * from it. A board with no such field gets no chips at all, which is the
   * right amount of chrome for a board that has nothing to filter by.
   *
   * Counted over open cards, like the tag chips beside them: a squad whose
   * every card is done is not a filter anybody wants offered.
   */
  /*
   * MY FACE, for the one chip that means "you".
   *
   * Off the cards first, which costs nothing: the board is already drawing
   * everybody's avatar in the WHO column, so if any card is assigned to you
   * the picture is already here.
   *
   * And when none is — the common case on a board where `mine` reads 0, which
   * is exactly when you are about to press it — ask the list for its members
   * once. Cached per list, because membership changes far more slowly than the
   * board does, and skipped entirely once a face has been found.
   */
  const [myAvatar, setMyAvatar] = useState("");
  const faceOnBoard = useMemo(() => {
    for (const t of tasks) for (const p of t.people ?? []) if (p.me && p.avatar) return p.avatar;
    return "";
  }, [tasks]);
  const listForFace = tasks.find((t) => t.listId)?.listId ?? "";
  const askedFace = useRef("");
  useEffect(() => {
    if (faceOnBoard || !listForFace || askedFace.current === listForFace) return;
    askedFace.current = listForFace;
    let live = true;
    api.clickupMembers(listForFace)
      .then((r) => { if (live && r.ok) setMyAvatar(r.members?.find((m) => m.me)?.avatar ?? ""); })
      .catch(() => { /* no face is a fine answer — the chip keeps its word */ });
    return () => { live = false; };
  }, [faceOnBoard, listForFace]);
  const myFace = faceOnBoard || myAvatar;


  const counts = useMemo(() => {
    const all = tasks;
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
  /**
   * Search the whole workspace by text.
   *
   * Deliberately a separate act from typing in the box. ClickUp's API has no
   * text search with a personal token, so this sweeps the most recently updated
   * few hundred cards and filters them here — MEASURED at sixteen seconds for
   * the first page on his workspace, ten minutes of cache after that. A search
   * box that stalls for sixteen seconds without a word is a broken search box;
   * one that says "this will take a moment" and then answers is a feature.
   */
  const [searching, setSearching] = useState(false);
  /*
   * A search you can change your mind about, which this could not.
   *
   * Reported: "I made a mistake… I want to cancel the search", with the spinner
   * turning. Neither × cancelled anything — the one in the box only emptied it
   * (`setQ("")`) and the one on the banner only closed the note. The request
   * ran to the end and then WROTE ITS RESULT: it opened Looked up and replaced
   * the note, for a search that had been abandoned. And Enter never checked
   * `searching` (the button did, the key did not), so a second Enter started a
   * second sweep alongside the first, and the one that finished LAST won —
   * not the one asked for last.
   *
   * TWO mechanisms, because they answer different failures and neither covers
   * the other:
   *
   *   the controller  stops the request. Nothing more is spent on it.
   *   the stamp       stops the ANSWER. A response can already be in flight,
   *                   or resolved and queued, when the abort lands — and it
   *                   would paint over what the person asked for instead.
   *
   * The stamp is the one people leave out, and it is the one that shows on
   * screen. `run !== searchRun.current` is the whole of it: only the newest
   * search may touch the drawer, the note or the spinner.
   *
   * The SERVER is deliberately not told. The sweep it is running is cached for
   * ten minutes and shared by every query, so a search abandoned here still
   * pays for the next one — stopping it would throw away the expensive half of
   * work already done. What is cancelled is our waiting for it, which is the
   * part that was showing.
   */
  const searchRun = useRef(0);
  const searchAbort = useRef<AbortController | null>(null);
  /** The person taking it back: the ×, Escape, or asking for something else. */
  const cancelSearch = useCallback(() => {
    if (!searchAbort.current) return;
    searchAbort.current.abort();
    searchAbort.current = null;
    // Nothing is coming, so nothing should still say it is on its way.
    searchRun.current++;
    setSearching(false);
    setNote(null);
  }, []);
  useEffect(() => () => searchAbort.current?.abort(), []);

  const searchAll = useCallback(async (text?: string) => {
    const asked = (text ?? q).trim();
    if (asked.length < 2) return;
    // A new search replaces the old one rather than racing it.
    searchAbort.current?.abort();
    const ac = new AbortController();
    searchAbort.current = ac;
    const run = ++searchRun.current;
    const mine = () => run === searchRun.current;
    setSearching(true);
    setFoundBySearch(new Set());
    /*
     * THE LIST OPENS ON ENTER, not when the workspace has been read.
     *
     * The sweep it needs is the slowest thing this panel does — three pages
     * with every card's body, forty seconds when the cache is cold — and the
     * old behaviour was a green line saying "Looking through the workspace…"
     * with nothing on screen until it finished: "when I would expect the
     * modal to appear instantly the moment I press enter".
     *
     * So the list is drawn immediately, and fills as answers arrive.
     */
    setResults({ asked, rows: [], looking: true });
    setNote(null);
    /*
     * AND THE CARD ITSELF, WHICH THE SWEEP MAY NOT HOLD.
     *
     * The sweep reads the most recently updated cards; a card touched five
     * days ago is not among them. Searching `9175` therefore listed the two
     * cards that MENTION it and not the card itself — the one thing he
     * certainly meant. Asked for by id, directly, which is one call and about
     * 700ms, and it arrives long before the sweep does.
     */
    /*
     * AWAITED BEFORE THE "NOTHING FOUND" NOTE, not fired and forgotten.
     *
     * `void`-ing this used to race the sweep below: the id lookup answers in
     * ~700ms and the sweep can answer just as fast with zero rows of its own,
     * so "nothing found" was set from `cur.rows.length` at a moment this
     * promise had not yet added its row. The card was really there — found by
     * the row appearing once the id lookup's own `setResults` landed a beat
     * later, by the clear-and-refilter, by Ctrl+F — the note was just wrong
     * about it. Keeping the reference and awaiting it before that check is
     * what makes "nothing found" mean it.
     */
    let idLookup: Promise<void> | null = null;
    if (/^\s*([A-Za-z][\w]*-)?\d{3,}\s*$/.test(asked)) {
      /*
       * ASKED OF THE FETCHER, NOT OF THE CACHE.
       *
       * This used `clickupWhere`, which only answers "is this card already on
       * a board you have" — so the prefixed form was instant (it was cached)
       * and a bare number came back empty and left him watching a spinner.
       * `find` is the one that normalises a bare number against the
       * workspace's own id shape and then goes and gets the card. Measured on
       * a real id: `/clickup/where?id=1042` answers {ok:false} while
       * `/clickup/find?q=1042` returns the card.
       */
      idLookup = api.clickupFind(asked).then((w) => {
        if (!mine() || !w.ok || !w.task) return;
        setResults((cur) => (cur && cur.asked === asked && !cur.rows.some((t) => t.id === w.task!.id)
          ? { ...cur, rows: [w.task!, ...cur.rows] }
          : cur));
      }).catch(() => { /* the sweep may still find it */ });
    }
    try {
      /* Read as it arrives: each batch the server matches goes straight into
         the list. The whole answer is still collected, for the sentence at the
         end that says how much was read. */
      const all: ProviderTask[] = [];
      const r = await api.clickupSearchStream(asked, false, (batch) => {
        if (!mine()) return;
        all.push(...batch);
        setResults((cur) => {
          if (!cur || cur.asked !== asked) return cur;
          const fresh = batch.filter((t) => !cur.rows.some((h) => h.id === t.id));
          return fresh.length ? { ...cur, rows: [...cur.rows, ...fresh] } : cur;
        });
      }, ac.signal);
      /* Only the search still on screen may speak, and never one the reader
         cancelled: a query typed over another aborts it, and that is not a
         failure to report. */
      if (!mine() || ac.signal.aborted) return;
      /*
       * THE STREAM IS THE FAST PATH, NOT THE ONLY ONE.
       *
       * Reading a response body a piece at a time is the thing most likely to
       * behave differently between the browser this was written in and the
       * shell it ships in — and when it did, the list sat on "looking" for ever
       * with a yellow banner behind it while the very same search answered in
       * 33ms on the command line. A search has one job, so the whole-answer
       * route is asked when the streamed one comes back empty-handed, and what
       * went wrong is said rather than swallowed.
       */
      if (!r.ok || !all.length) {
        const whole = await api.clickupSearch(asked, false, ac.signal);
        if (!mine() || ac.signal.aborted) return;
        if (whole.ok) {
          all.push(...(whole.tasks ?? []));
        } else if (!r.ok) {
          setResults((cur) => (cur && cur.asked === asked ? { ...cur, looking: false } : cur));
          setNote({ ok: false, text: whole.error ?? r.error ?? "That search could not run" });
          return;
        }
      }
      /* On the id path the card itself has just been jumped to, so listing it
         again below is a second copy of what is already selected. Everything
         else in the answer is what refers to it. */
      const found = all;
      if (!found.length) {
        // The id lookup may still be the one holding the card the sweep
        // missed — let it land before asking whether the list is really empty.
        if (idLookup) await idLookup;
        if (!mine() || ac.signal.aborted) return;
        setResults((cur) => (cur && cur.asked === asked ? { ...cur, looking: false } : cur));
        /* Said only when the list has nothing in it either — the card asked
           for by id may already be sitting there. */
        setResults((cur) => {
          if (cur && cur.asked === asked && !cur.rows.length) {
            /* "Nothing matched" and "nothing matched in the part of the
               workspace I could reach" are different sentences, and a count
               cannot tell them apart: a sweep that lost a page just looks like
               a smaller workspace. Saying so is the difference between a
               reader who stops looking and one who tries again. */
            /*
             * SAY THE WINDOW IN TIME, not in cards.
             *
             * "Nothing in the last 300 cards" reads as "it does not exist",
             * and it is not the same claim. Measured against the real
             * workspace by walking the pages by hand: page 7 still came back
             * full, so there are more than 800 cards to walk — and the 300th,
             * where the sweep stops, had been updated THE SAME DAY. On that
             * workspace this search covers today. A reader cannot convert a
             * card count into that; a date they can.
             */
            const window = r.since ? sinceWords(r.since) : null;
            const reach = r.partial
              ? " — and one page of the sweep did not answer, so this is not all of it"
              : r.capped && window ? ` — this search covers ${window}, which is as far back as it reaches`
                : "";
            setNote(r.partial || r.capped
              ? { ok: true, text: `Nothing matching “${asked}”${reach}` }
              : { ok: false, text: `Nothing in the last ${r.scanned ?? 0} cards matches “${asked}”` });
            return null;
          }
          return cur;
        });
        return;
      }
      /* The answer is a list to pick from, over the board. Nothing is moved,
         nothing is filed anywhere, and the reader chooses what to open. Merged
         rather than assigned: the card asked for by id may already be in it. */
      setResults((cur) => {
        const had = cur && cur.asked === asked ? cur.rows : [];
        const fresh = found.filter((t) => !had.some((h) => h.id === t.id));
        return { asked, rows: [...had, ...fresh], looking: false };
      });
      setFoundBySearch(new Set(found.map((t) => t.id)));
      setNote(null);
    } catch {
      /* An abort is not a failure to report — it is what was asked for. Any
         other throw is, but only while this is still the search on screen. */
      if (mine()) setNote({ ok: false, text: "That search could not run" });
    } finally {
      if (mine()) { setSearching(false); searchAbort.current = null; }
    }
  }, [q]);

  /** Open one of the search's answers. A card that is not on this board has to
   *  live somewhere for the panel to draw it, and the Looked-up list is that
   *  somewhere — but it is storage now, not a destination: the board stays
   *  where it was and the card opens beside it. */
  const openResult = useCallback((t: ProviderTask) => {
    setResults(null);
    setLooked((cur) => (cur.some((c) => c.id === t.id) ? cur : [t, ...cur].slice(0, LOOKED_MAX)));
    setSel(t.id);
  }, []);

  const reveal = useCallback(async (text?: string) => {
    const asked = (text ?? q).trim();
    if (!asked) return;
    const want = asked.toLowerCase();
    const here = tasks.find((t) =>
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

  const picked = [...tasks, ...looked].find((t) => t.id === sel) ?? null;

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

  /* Everybody who appears on a card of this board — the people the assignee
     picker shows first. A workspace answers with five hundred names; these are
     the dozen who actually work here. */
  const boardPeople = useMemo(() => {
    const ids = new Set<number>();
    for (const t of tasks) for (const p of t.people ?? []) if (p.id != null) ids.add(p.id);
    return ids;
  }, [data?.tasks]);
  const anyWho = tasks.some((t) => t.assignees.length);
  const anySprint = tasks.some((t) => t.sprint);
  const anyEst = tasks.some((t) => t.estimateHours);
  /* The swatch column names itself after the field it is showing — "Squad" on
     one board, "Pod" on the next — so the heading is the board's word rather
     than ours. Taken from the first row that has one; they are all the same
     field, since `swatch` picks by name across every card. */
  const squadLabel = tasks.map(swatch).find(Boolean)?.name ?? "";
  const grid = cuGrid(anyWho, !!squadLabel, anySprint, anyEst, onLooked);

  /* The looked-up cards, by where each one lives. The search box filters these
     too — it is the only chip that still means anything on this board. */
  const lookedGroups = useMemo(() => {
    const by = new Map<string, ProviderTask[]>();
    for (const t of looked) {
      if (!matchesQuery(t, q) && !exempt(t)) continue;
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
    /*
     * Inside a status group, ClickUp's own order: priority first.
     *
     * Read off the list's default view rather than guessed — its `sorting` is
     * `{ field: "priority" }`, which is what makes `URGENT` sit at the top of a
     * column in ClickUp and looked arbitrary here. Cards with no priority keep
     * the order the workspace sent them in, which is its own ranking, so this
     * only ever LIFTS the flagged ones.
     */
    const RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
    const byPriority = (list: ProviderTask[]) => [...list]
      .map((t, i) => ({ t, i }))
      .sort((a, b) => (RANK[a.t.priority ?? ""] ?? 2.5) - (RANK[b.t.priority ?? ""] ?? 2.5) || a.i - b.i)
      .map((x) => x.t);

    /*
     * EVERY STATUS THE LIST HAS, not only the ones that happen to hold a card.
     *
     * A board drew a group per status it SAW in the rows, so a workflow step
     * with nothing in it right now simply was not there — and a person reading
     * the board cannot tell "no cards in TO DO" from "this list has no TO DO".
     * ClickUp's own page draws all fifteen, empty ones included, because the
     * empty ones are half of what a workflow tells you. "I need every status
     * to show up in the lists… otherwise, what is the point."
     *
     * Seeded before the rows are folded in, so the order is the workflow's own
     * and an empty group lands exactly where it belongs between two full ones.
     */
    for (const s of data?.statuses ?? []) if (!by.has(s.status)) by.set(s.status, []);

    return [...by.entries()]
      .map(([status, list]) => ({
        status,
        rows: byPriority(list),
        color: order.get(status)?.color ?? list[0]?.statusColor,
        done: (order.get(status)?.type ?? "") === "done" || (order.get(status)?.type ?? "") === "closed",
        points: list.reduce((n, t) => n + (t.points ?? 0), 0),
        i: order.get(status)?.i ?? 999,
      }))
      .sort((a, b) => a.i - b.i);
  }, [rows, data?.statuses]);

  /* The board as one list, in the order the table draws it: status groups in the
     workflow's order, priority first inside each. What the modal's next/previous
     walks — so "next" means the row under the one you opened, and nothing has to
     re-derive that order a second way. */
  const cardOrder = useMemo(
    () => (onLooked ? lookedGroups : groups).flatMap((g) => g.rows),
    [onLooked, lookedGroups, groups],
  );

  if (!boards) return <div className="p-5"><Spinner label="Reading your boards…" className="" /></div>;

  /* There is always at least one board now — the built-in one — so the question
     the first screen answers is no longer "have you added anything" but "did the
     one you did not have to add come back with nothing". Which, on a machine
     where ClickUp is not connected yet, it will. */
  if (!boards.views.some((v) => !v.builtin) && data?.error && !tasks.length) {
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
  /* The card, built once and put in whichever shell is chosen. Two copies of
     this would be two places for a field to go stale. */
  const cardBody = (
    picked
    ? <CardDetail t={picked} today={today} statuses={cardStatuses} fields={cardFields} place={cardPlaceShown}
    writable={boards.writeEnabled} repos={repos} here={here}
    onOpenChatWith={onOpenChatWith}
    wide={wide}
    byId={byId} onGo={(id) => setSel(id)} boardPeople={boardPeople}
    skills={skills}
    onNote={(text) => setNote({ ok: true, text })}
    onFresh={(task) => setOver((m) => ({ ...m, [task.id]: task }))}
    onApply={(key, p) => picked && apply(picked, key, p)}
    saving={(key) => queue.busy(picked?.id ?? "", key)}
    /* Offered only when it goes somewhere: a card on the board you are already
       looking at has nowhere to take you, and the panel reads any list by id
       whether or not it is on the bar — so this does not require adding it. */
    /* Only in the modal. In the sidebar the table is right there beside the
       card, and a second way to reach a row you can already click is clutter. */
    nav={cardMode === "modal" ? <CardHop list={cardOrder} id={picked.id} onGo={setSel} /> : undefined}
    onClose={cardMode === "modal" ? () => setSel(null) : undefined}
    onOpenList={picked?.listId && data?.view?.id !== `list:${picked.listId}`
      ? () => { const id = `list:${picked.listId}`; setSel(null); void load(id, false, true); }
      : undefined} />
    : <div className="text-center p-5" style={{ color: "var(--text3)" }}>Pick a card.</div>
  );

  const veiled = !!wanted && (stale || !data?.tasks.length);

  return (
    /* `relative` for the card modal, which is laid over the WHOLE panel — the
       board bar and the filters included. Anchored to the table alone it started
       a fifth of the way down the window, with the two bars above it lit and the
       card squeezed into what was left. */
    <div className="relative flex flex-col flex-1 min-h-0">
      {/* One bar, not three. The old layout spent 216 pixels before the first
          task — boards, then search, then filters, then column headings — on a
          list of 36 rows of which 13 fitted. Boards and controls now share a
          line, and the search shares the next with the filters. */}
      <div className="flex items-center gap-1.5 px-4 pt-2 pb-1.5 flex-wrap shrink-0">
        {/* The boards themselves moved into the rail on the left — see the
            note there. What is left on this line is the things that act on the
            board you are already on. */}
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
        {/* The brief, as a chip on a row that already exists.
            It was a fold above the table, and opening it pushed the rows down
            by two hundred pixels — the reference material shoving aside the
            thing you came to read. A dialog costs the table nothing, which is
            also what ClickUp does with it. */}
        {!onLooked && !!data?.description?.trim() && (
          <button onClick={() => setAboutOpen(true)}
            title="What this list is for — the brief, the docs, the team"
            className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full agx-btn"
            style={{ border: edge(14), color: "var(--text3)" }}>
            About
          </button>
        )}
        {/* THE SEARCH, IN THE MIDDLE OF THE BAR.
            It sat on the chips row underneath, where it stretched to whatever
            was left over and pushed the filters around as it grew. Up here it
            has a fixed centre and a ceiling, which is where every tool he uses
            puts it. */}
        <div className="flex-1 flex justify-center min-w-0 px-3">
          <div className="w-full max-w-[560px]">
        <div className="flex items-center gap-2 w-full rounded-lg pl-2.5 py-1 overflow-hidden"
          style={{ background: "var(--bg2)", border: edge(14) }}>
          {/* The house floor for an icon-only glyph, which this was well under:
              a text ⌕ at 11px. */}
          <span className="shrink-0 grid place-items-center" style={{ width: 20, height: 20, color: "var(--text3)" }}>
            <svg width={ICON.md} height={ICON.md} viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth={2.2} strokeLinecap="round" aria-hidden>
              <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.6-3.6" />
            </svg>
          </span>
          <input ref={searchBox} value={q}
            /* Typing again drops the exemption the last search earned: those
               rows are only allowed past the filter while the query that found
               them is still the one in the box. */
            onChange={(e) => { setQ(e.target.value); setFoundBySearch(new Set()); }}
            onKeyDown={(e) => {
              /* Escape empties it. The same thing the × does, for the hand that
                 is already on the keyboard — and it stops here rather than
                 bubbling, or the view behind takes it as "go back". */
              if (e.key === "Escape" && (q || searching)) {
                e.preventDefault(); e.stopPropagation();
                // Escape means "never mind", and a sweep in flight is the
                // biggest thing there is to never-mind. It cancels even when
                // the box is already empty, which is exactly the state the ×
                // leaves behind.
                cancelSearch(); setQ(""); return;
              }
              if (e.key !== "Enter") return;
              /* An id is a jump — one card, and the panel knows how to go to
                 it. Anything else is a search, which is a different promise and
                 a much slower one, so it happens on Enter and never on a
                 keystroke. */
              /*
               * An id JUMPS, and then says who else points at it.
               *
               * "not only that card has to come up but also the ones that
               * reference that card" — and the jump is the
               * gesture he already uses, so it stays first and the references
               * arrive under it. In that order on purpose: `reveal` ends by
               * clearing the note, so a search that had already written one
               * would have it wiped a moment later.
               */
              /*
               * ONE ANSWER, WHICHEVER IT IS.
               *
               * An id used to JUMP and then quietly file its references in a
               * drawer, so the reader landed on one card with no idea the
               * other two existed. Now the search runs for both cases and the
               * answers come back as a list to choose from — the card itself
               * marked as such, the ones that merely mention it marked as
               * that. `reveal` is still the fallback for an id the sweep has
               * not seen, and only then.
               */
              void searchAll();
            }}
            spellCheck={false}
            placeholder={onLooked ? "Filter what you have looked up" : "Filter this board · Enter searches the workspace"}
            className="flex-1 min-w-0 bg-transparent outline-none text-[12px]"
            style={{ color: "var(--text)", caretColor: "var(--primary)" }} />
          {searching && <span className="agx-spin shrink-0" aria-label="Searching" style={{ width: 11, height: 11, borderWidth: 1.5, borderColor: "var(--text3)", borderTopColor: "transparent" }} />}
          {/* EMPTYING IT IS ONE CLICK. Selecting a card id by hand to type over
              it is the kind of small tax that gets paid twenty times a day:
              "having to clear the input by hand is really annoying". Drawn only
              when there is something to clear, so an empty box stays empty of
              controls too — and the focus goes back to the box, because the
              next thing after clearing a search is always typing another. */}
          {(q || searching) && (
            /*
             * Drawn while a search is running even with the box empty, because
             * the first × he presses empties it — and if the button went away
             * at that moment, the only thing still on screen would be a
             * spinner with no way to stop it.
             *
             * PART OF THE FIELD, not a badge sitting in it.
             *
             * Twice wrong before this. First the reddish CLOSE box with a
             * negative margin, which ate the field's padding and sat on the
             * border — "to feo, to pisado". Then a quiet circle floating
             * inside, which is what he pointed at and said: make it part of
             * the input, like the button welded to the right end of a
             * subscribe field.
             *
             * So it is a segment: full height of the box, flush against its
             * right edge, its corners clipped by the field's own radius
             * (`overflow-hidden` above), and a hairline where it meets the
             * text. The vertical margins cancel the field's padding so it
             * spans the whole border box rather than the content box, which is
             * the difference between "attached" and "nearly attached".
             *
             * A target 34px wide and the full height of the control: no aim
             * required, which was the whole ask.
             */
            <button onClick={() => { cancelSearch(); setQ(""); searchBox.current?.focus(); }}
              aria-label="Clear the search" title="Clear · Esc"
              className="agx-hover shrink-0 grid place-items-center self-stretch"
              style={{
                width: 34, marginTop: -4, marginBottom: -4,
                borderLeft: edge(14), color: "var(--text3)",
                background: "color-mix(in srgb, var(--text) 4%, transparent)",
              }}>
              <CloseIcon size={ICON.md} />
            </button>
          )}
        </div>
          </div>
        </div>
        {/* Only when writes are OFF, which is the only state worth a chip:
            "that can edit button should go away, since it is editable by
            default ALWAYS". Saying "can edit" on a board you can edit is a
            label for the normal case, and the row it sits on is full. Turned
            off, it is a fact worth knowing and a way back. */}
        {!boards.writeEnabled && <button onClick={async () => {
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
          read-only
        </button>}
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
              /* A poll that did not land, said where the age of the answer is
                 already stated and in the same quiet hand. This used to be an amber
                 strip across the board, and it worried somebody weekly for a thing
                 that costs nothing: the rows are right, the next poll is coming, and
                 what actually happened is that one request out of every few hundred
                 took longer than its timeout. See `alarming`. */
              : softFail
              ? <span title={`${data.error} — the rows above are the last answer, from ${new Date(data.at).toLocaleTimeString()}. The next read is automatic; Refresh forces one now.`}
                  style={{ color: "var(--text3)" }}>· retrying</span>
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
        {/* Where a card opens. Two, not three: full screen was offered and
            turned down — it covers the table entirely, and in an app that
            already lives in tabs it does nothing the modal does not. */}
        <div className="flex rounded-lg overflow-hidden shrink-0" style={{ border: edge(16) }}>
          {([["side", "Sidebar"], ["modal", "Modal"]] as const).map(([id, label]) => (
            <button key={id} onClick={() => setCardMode(id)}
              aria-pressed={cardMode === id}
              title={id === "side"
                ? "Open a card beside the list, in a pane you can drag wider"
                : "Open a card over the list, with room for a long description"}
              className="text-[10.5px] px-2 py-0.5"
              style={cardMode === id
                ? { background: "color-mix(in srgb, var(--primary) 18%, transparent)", color: "var(--text)" }
                : { color: "var(--text3)" }}>
              {label}
            </button>
          ))}
        </div>
        {/* THIS board, and only this board. Asked out loud — "I expect the
            refresh to update only the assigned to me view" — so the button says
            which one it is going to re-read rather than leaving somebody to
            wonder whether pressing it costs the whole sidebar. */}
        <button onClick={() => void load(data?.view?.id, true, true)} disabled={busy}
          title={data?.view?.name
            ? `Read ${data.view.name} again now — no other board is touched`
            : "Read this board again now"}
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
      {/* The progress line is ALWAYS here, and only sometimes visible.
          Two pixels, which sounds like nothing and is the whole complaint: as a
          conditional block it appeared on every board you clicked, pushed the
          table down by its own height and pulled it back. A gap that is always
          the same size cannot move anything, so the track is drawn either way
          and only its contents come and go. */}
      <div className="shrink-0" role="status" aria-live="polite" style={{ paddingBottom: 4 }}>
        {/* The 4px below is part of the reserved gap, not a margin that comes
            and goes: the line sat directly on the search box, and a progress
            bar touching an input reads as the input's own underline. */}
        <div aria-hidden style={{ height: 2, overflow: "hidden", background: wanted ? "color-mix(in srgb, var(--primary) 12%, transparent)" : "transparent" }}>
          {wanted && <div className="agx-indeterminate" style={{ height: "100%", background: "var(--primary)" }} />}
        </div>
      </div>
      {wanted && (
        <div className="shrink-0">
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
      {/* Right-click on a folder heading. One item, because there is only one
          thing a folder can do that its lists cannot: leave. */}
      {folderMenu && (
        <ContextMenu x={folderMenu.x} y={folderMenu.y} onClose={() => setFolderMenu(null)}>
          <div className="px-2 py-1.5 text-[10.5px] max-w-[240px]" style={{ color: "var(--text4)" }}>
            {folderMenu.f.spaceName ? `${folderMenu.f.spaceName} · ` : ""}{folderMenu.f.name}
          </div>
          <MenuItem danger onClick={() => void dropFolder(folderMenu.f)}>Take this folder off the sidebar</MenuItem>
          <div className="px-2 pb-1 text-[9.5px] max-w-[240px]" style={{ color: "var(--text4)" }}>
            Only here — the folder and its lists stay exactly as they are in ClickUp.
          </div>
        </ContextMenu>
      )}
      {adding && (
        <AddBoardBar value={urlText} onValue={setUrlText} onAdd={addBoard}
          onClose={closeAddBar}
          busy={busy} editing={editing?.listName || editing?.name || null}
          folders={boards?.folders ?? []} onAddFolder={addFolder} onAddList={addList} />
      )}

      <div className="flex items-center gap-1.5 px-4 pb-1.5 flex-wrap shrink-0">
        {/* The box, with `overflow-hidden` so anything attached to its right
            end is clipped to the same corner the field has — see the clear
            button below, which is a SEGMENT of this control rather than a
            glyph floating inside it. */}
        {/* The other half of the box, said out loud: what you typed filters the
            board, and Enter goes and looks through the workspace. Only when
            there is something to look for, and never for an id — that is a
            jump, and it has its own path. */}
        {!onLooked && q.trim().length >= 2 && !looksLikeId && (
          <button onClick={() => void searchAll()} disabled={searching}
            title="ClickUp has no text search for this token, so this sweeps the most recently updated cards. The first one takes a moment."
            className="text-[11px] px-2.5 py-0.5 rounded-full whitespace-nowrap disabled:opacity-50"
            style={{ border: edge(14), color: "var(--text2)" }}>
            {searching ? "searching…" : "search the workspace ⏎"}
          </button>
        )}
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
            ? ON_CHIP
            : { border: edge(14), color: "var(--text2)" }}>
          {/* The count has to survive the fill: --text3 on the accent is a
              number you cannot read. */}
          ready <span style={{ color: readyOnly ? "var(--bg)" : "var(--text3)", opacity: readyOnly ? 0.75 : 1 }}>{counts.ready}</span>
        </button>
        {/* YOUR FACE ON IT. The board already draws everybody's avatar in the
            WHO column, so the one chip that means "you" was the only place a
            person was named in words instead. Falls back to the word alone
            when the workspace has no picture for you — an empty circle would
            be a worse label than the word it replaced. */}
        <button onClick={() => setMineOnly((v) => !v)} aria-pressed={mineOnly}
          className="text-[11px] pr-2.5 py-0.5 rounded-full whitespace-nowrap inline-flex items-center gap-1.5"
          style={{
            ...(mineOnly ? ON_CHIP_OK : { border: edge(14), color: "var(--text2)" }),
            paddingLeft: myFace ? 3 : 10,
          }}>
          {myFace && (
            <img src={myFace} alt="" loading="lazy" referrerPolicy="no-referrer"
              className="rounded-full shrink-0"
              style={{ width: 15, height: 15, objectFit: "cover" }} />
          )}
          mine <span style={{ color: mineOnly ? "var(--bg)" : "var(--text3)", opacity: mineOnly ? 0.75 : 1 }}>{counts.mine}</span>
        </button>
        {tags.slice(0, 6).map((t) => (
          <button key={t} onClick={() => setTag((cur) => (cur === t ? null : t))} aria-pressed={tag === t}
            className="text-[11px] px-2.5 py-0.5 rounded-full"
            style={tag === t
              ? ON_CHIP
              : { border: edge(14), color: "var(--text3)" }}>{t}</button>
        ))}
        <StatusFilter statuses={data?.statuses ?? []} tasks={tasks}
          picked={statusPick} onPick={setStatusPick} />
        {/* The chips are the shortcuts; this is everything else. A squad, an
            impacted application, an assignee, any custom field this workspace
            invented — none of which could be a chip, because which fields
            exist is the board's business and not ours. */}
        <FilterBuilder tasks={tasks} value={built} onChange={setBuilt} />
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

      {/* Over the board, not above it — see AboutList. */}
      {aboutOpen && !!data?.description?.trim() && (
        <AboutList
          name={data.view?.listName || data.view?.name || "This list"}
          text={data.description}
          url={data.view?.url}
          onClose={() => setAboutOpen(false)} />
      )}

      {/* The × on the banner is the one a hand reaches for while a sweep is
          running — the banner is what says it is running. It used to only close
          the note and leave the search going behind it. */}
      {note && <NoteStrip note={note} onClose={() => { cancelSearch(); setNote(null); }} />}
      {results && (
        <SearchHits asked={results.asked} rows={results.rows} looking={results.looking}
          onAsk={(text) => { setQ(text); void searchAll(text); }}
          onPick={openResult} onClose={() => { cancelSearch(); setResults(null); }} />
      )}
      {/*
        * The strip is for a board you cannot trust, not for a slow request.
        *
        * It used to appear on any failed read, in amber, saying "ClickUp did not
        * answer in time — showing what was last read". Reported as arriving often
        * and meaning nothing: "I don't even know what it means… since everything
        * seems fine… it causes worry or confusion". It was right about the request
        * and wrong about the situation — the rows on screen were minutes old and
        * correct, and the next poll was seconds away.
        *
        * So a failure with fresh rows behind it is a word in the header (see
        * `softFail`), and this stays for the two cases where somebody really is
        * looking at something they should not trust: nothing on screen at all, or an
        * answer old enough that the board may have moved on without it.
        */}
      {data?.error && alarming && (
        <div className="px-5 py-1 text-[10.5px] shrink-0 flex items-center gap-2"
          style={{ color: "var(--warning)", background: "color-mix(in srgb, var(--warning) 10%, transparent)" }}>
          <span className="min-w-0">
            {tasks.length
              ? `Nothing has been read since ${stamp(data.at)} — ${data.error.replace(/\.$/, "")}. These rows may have moved.`
              : data.error}
          </span>
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
      {/* The write itself. It takes a round trip to ClickUp and then a reload
          of the board, which is long enough that "Do it" followed by nothing
          reads as a button that did not work — and the second press is a
          second write. */}
      {/*
       * A lane for the panel to say it is busy, whose height never changes.
       *
       * Reported twice, and the second time is what settled the shape: a status
       * bar that appears pushes everything below it down by its own height and
       * pulls it back a moment later, and on a list you click all day that
       * reads as the whole page flinching. Told to keep the gap and hide the
       * contents, which is exactly right — a reserved lane cannot move anything
       * because it is always the same size.
       *
       * Reads say nothing in it. The list you clicked already wears its own
       * spinner in the rail, where you are looking; a second, louder answer
       * across the panel is not more information. A write has no such home — it
       * is started from a menu that closes behind it — so it says so here.
       */}
      <div className="px-5 shrink-0 flex items-center overflow-hidden" aria-live="polite"
        style={{ height: 22, background: busy && !confirm && !wanted ? "color-mix(in srgb, var(--primary) 10%, transparent)" : "transparent" }}>
        {busy && !confirm && !wanted && <Spinner label="Telling ClickUp…" className="" />}
      </div>

      <div className="flex flex-1 min-h-0 relative">
        {/*
         * The lists, down the side.
         *
         * They used to be a row of chips above the table, which works at four
         * and stops working well before twenty: they wrap onto a second and
         * third line, push the table down, and there is no way to search them.
         * Down the side they are a column that scrolls, with a filter box —
         * and the filter is the part that actually scales, not the shape.
         *
         * Grouped by folder now, which it was not: the note that used to sit
         * here said the tree would cost a call per board because a board's
         * folder was only learned when it was opened. Two things changed. A
         * folder can be added WHOLE — and then every list under it arrives
         * knowing where it lives, for no calls at all — and a pasted list's
         * breadcrumb, which was already being kept beside its cached page, is
         * now read back out of it. So the day we hold the places came, and the
         * shape ClickUp draws is the shape here.
         */}
        <nav aria-label="Lists" className="flex flex-col shrink-0 min-w-0"
          style={{ width: railOpen ? 214 : 34, borderRight: edge(12), transition: "width 120ms ease" }}>
          <div className="flex items-center gap-1 px-1.5 shrink-0"
            style={{ height: HEAD_H, borderBottom: edge(10) }}>
            <button onClick={() => setRailOpen((o) => !o)}
              aria-expanded={railOpen}
              title={railOpen ? "Fold the list menu" : "Show the lists"}
              className="shrink-0 grid place-items-center rounded"
              style={{ width: 22, height: 22, border: edge(14), color: "var(--text3)" }}>
              {/* Drawn rather than typed. `‹` is a text glyph and sits on a text
                  baseline, so centring the box still left it riding high inside
                  it — the alignment cannot be fixed by the box because the gap
                  is inside the glyph. An SVG has no baseline to fight. */}
              <svg viewBox="0 0 16 16" width={12} height={12} fill="none" stroke="currentColor"
                strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
                <path d={railOpen ? "M10 3.5 5.5 8l4.5 4.5" : "M6 3.5 10.5 8 6 12.5"} />
              </svg>
            </button>
            {railOpen && (
              <input value={railQ} onChange={(e) => setRailQ(e.target.value)} placeholder="Filter lists…" spellCheck={false}
                aria-label="Filter lists"
                className="min-w-0 flex-1 px-2 py-1 rounded text-[11px] outline-none"
                style={{ background: "color-mix(in srgb, var(--text) 8%, transparent)", color: "var(--text)", border: edge(14) }} />
            )}
          </div>
          {/*
            * Folded, it was 34 pixels of nothing but the button that unfolds
            * it — asked about as "is it normal that nothing shows". A column
            * that is empty when closed teaches people it holds nothing, and
            * the one thing worth knowing at a glance is which list you are on:
            * the breadcrumb says it too, above a table that scrolls away from
            * it.
            *
            * Vertical rather than truncated to four characters: `Orbit v2 –
            * Phases 2 & 3` and `Orbit v2 – Phase 1` share their first
            * twenty. Bottom-to-top is the direction editors put a folded
            * sidebar's label in, and it reads without turning your head.
            */}
          {!railOpen && (
            <button onClick={() => setRailOpen(true)} title={`${railActive} — show the lists`}
              className="flex-1 min-h-0 w-full flex justify-center pt-2 pb-3 overflow-hidden"
              style={{ color: "var(--text4)" }}>
              <span className="truncate" style={{
                writingMode: "vertical-rl", transform: "rotate(180deg)",
                fontSize: 10.5, letterSpacing: "0.06em", maxHeight: "100%",
              }}>{railActive}</span>
            </button>
          )}
          {railOpen && (
            <div className="agx-scroll flex-1 min-h-0 overflow-y-auto py-1">
              {railViews.length === 0 && (
                <div className="px-2.5 py-2 text-[10.5px]" style={{ color: "var(--text3)" }}>No list by that name.</div>
              )}
              {/* Ungrouped first: the built-in board, and any list whose
                  folder we do not know yet — a pasted one is only filed once it
                  has been opened and told us its breadcrumb. */}
              {railGroups.loose.map((v) => railRow(v, 0))}
              {railGroups.groups.map((g) => {
                const shut = railShut[g.key] === true;
                const savedFolder = (boards?.folders ?? []).find((f) => f.id === g.folderId);
                return (
                  /*
                   * A folder has to look like a folder, and its lists have to
                   * look like they are inside it.
                   *
                   * The first version was a dim caption over rows at the same
                   * indent, and it read as one flat column with the odd label
                   * in it — "there is no margin for error, I keep clicking
                   * where I should not". ClickUp's own sidebar answers this with three
                   * things and they are all here: a folder glyph, brighter type
                   * for the folder than for its lists, and a guide line down
                   * the left of the children so the eye can follow the nesting
                   * without counting pixels.
                   */
                  <div key={g.key} className="mt-1.5">
                    <button
                      onClick={() => setRailShut((m) => ({ ...m, [g.key]: !shut }))}
                      onContextMenu={(e) => {
                        if (!savedFolder) return;
                        e.preventDefault(); e.stopPropagation();
                        setFolderMenu({ f: savedFolder, x: e.clientX, y: e.clientY });
                      }}
                      className="w-full text-left flex items-center gap-1.5 pl-1.5 pr-2 py-1 text-[11px] agx-btn rounded"
                      style={{ color: "var(--text2)" }}
                      title={savedFolder
                        ? `${g.space ? `${g.space} · ` : ""}${g.folder} — added whole, so a list created in it turns up here on its own. Right-click to take it off.`
                        : `${g.space ? `${g.space} · ` : ""}${g.folder}`}>
                      {/* The twisty and the folder are one target: 20px of it,
                          which is the smallest square this rail has room for
                          and still wider than the 9px caret it replaced. */}
                      <span aria-hidden className="shrink-0 grid place-items-center" style={{ width: 14, color: "var(--text4)" }}>
                        <svg viewBox="0 0 16 16" width={ICON.xs} height={ICON.xs} fill="currentColor" aria-hidden
                          style={{ transform: shut ? "none" : "rotate(90deg)", transition: "transform 120ms ease" }}>
                          <path d="M6 3.5 10.5 8 6 12.5Z" />
                        </svg>
                      </span>
                      <span aria-hidden className="shrink-0 grid place-items-center" style={{ width: 14, color: "var(--primary)" }}>
                        <svg viewBox="0 0 16 16" width={ICON.sm} height={ICON.sm} fill="none" stroke="currentColor"
                          strokeWidth={1.5} strokeLinejoin="round" aria-hidden>
                          <path d="M1.75 4.25A1.5 1.5 0 0 1 3.25 2.75h2.4l1.3 1.5h5.8a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H3.25a1.5 1.5 0 0 1-1.5-1.5Z" />
                        </svg>
                      </span>
                      <span className="truncate min-w-0 flex-1" style={{ letterSpacing: "0.01em" }}>{g.folder}</span>
                      <span className="tabular-nums shrink-0 text-[10px]" style={{ color: "var(--text4)" }}>{g.views.length}</span>
                    </button>
                    {!shut && (
                      /* The guide line sits on the children, not on the folder:
                         it has to stop where the folder's contents stop. */
                      <div style={{ marginLeft: 14, borderLeft: `1px solid color-mix(in srgb, var(--text) 14%, transparent)` }}>
                        {g.views.map((v) => railList(v))}
                      </div>
                    )}
                  </div>
                );
              })}
              {/* Where you have been, beside the lists rather than inside one —
                  a card from another list sitting in somebody's sprint reads as
                  being IN it. Dashed and only while it holds something. */}
              {looked.length > 0 && (
                <button onClick={() => { setOnLooked(true); setSel(looked[0]?.id ?? null); }}
                  aria-current={onLooked}
                  className="w-full text-left flex items-center gap-1.5 px-2.5 py-1 mt-1 text-[11.5px]"
                  style={{ color: onLooked ? "var(--text)" : "var(--text3)",
                    background: onLooked ? "color-mix(in srgb, var(--primary) 14%, transparent)" : "transparent",
                    borderTop: `1px dashed color-mix(in srgb, var(--text) 22%, transparent)` }}
                  title="Cards you have opened by id. They are not on any of your boards — this is where you have been, and it is forgotten when the app closes.">
                  <span className="truncate min-w-0 flex-1">Looked up</span>
                  <span className="tabular-nums text-[10px]" style={{ color: "var(--text4)" }}>{looked.length}</span>
                </button>
              )}
            </div>
          )}
        </nav>
        <div className="flex flex-col flex-1 min-w-0">
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
          {/* One scroller for the heading AND the rows. They used to be
              siblings, which is fine while nothing moves sideways and wrong the
              moment something does: two boxes scrolled independently put the
              heading over the wrong column. */}
          <div className="agx-scroll flex-1 min-w-0 overflow-auto">
            <div className={`pr-5 ${EYEBROW} sticky top-0 z-10`}
                style={{ display: "grid", gridTemplateColumns: grid, gap: 14, color: "var(--text4)",
                  alignItems: "center", height: HEAD_H,
                  minWidth: TABLE_MIN_W, background: "var(--bg)",
                  borderBottom: edge(10) }}>
              <span className="agx-stick-head">Task</span>
              {anyWho && <span className="text-center">Who</span>}
              {!!squadLabel && <span className="text-center truncate" title={squadLabel}>{squadLabel}</span>}
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
              {onLooked && <span />}
            </div>

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
                  <span className={`${EYEBROW}`} style={{ color: "var(--text4)" }}>
                    {g.place}
                  </span>
                  <span className="text-[10.5px] tabular-nums" style={{ color: "var(--text3)" }}>{g.rows.length}</span>
                </div>
                {g.rows.map((t) => (
                  // One card at a time, because a history you can only throw
                  // away whole is one nobody prunes.
                  <ClickUpRow key={t.id} t={t} today={today} on={t.id === sel} onPick={() => setSel(t.id)}
                    grid={grid} showWho={anyWho} showSquad={!!squadLabel} showSprint={anySprint} showEst={anyEst} blocked={[]} onHand={handCard}
                    onForget={() => { setLooked((cur) => { const left = cur.filter((x) => x.id !== t.id); if (!left.length) setOnLooked(false); return left; }); if (sel === t.id) setSel(null); }} />
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
                  /*
                   * "Nothing open" on a board that holds twelve finished cards
                   * reads as a board that failed to load — asked about exactly
                   * that, against a ClickUp list whose every card sits in
                   * "won't fix / obsolete". The count is already on a chip at
                   * the top of the panel, which is the one place somebody
                   * looking at an empty table is not looking.
                   */
                  : !showDone && counts.done > 0 ? (
                    <>
                      Nothing open here — {counts.done} card{counts.done === 1 ? " is" : "s are"} done or dropped.{" "}
                      <button onClick={() => setShowDone(true)} style={{ color: "var(--primary)" }}>Show them</button>
                    </>
                  )
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
                  className="agx-group-head w-full flex items-center py-2 text-left hover:bg-white/5"
                  style={{ borderTop: gi ? edge(9) : undefined }}>
                  <span className="agx-stick-group flex items-center gap-2">
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
                  </span>
                </button>
                {!folded[g.status] && g.rows.map((t) => (
                  <ClickUpRow key={t.id} t={t} today={today} on={t.id === sel} onPick={() => setSel(t.id)}
                    grid={grid} showWho={anyWho} showSquad={!!squadLabel} showSprint={anySprint} showEst={anyEst} blocked={blockedBy(t)} onHand={handCard} />
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
        {/* Two shells, one card.
            Chosen from a mockup: the sidebar, which is what this always was,
            and a modal for a card that is a page of prose rather than six
            fields — where the pane's width is the thing in the way. Full screen
            was in the mockup too and was turned down: it covers the table
            entirely, and in an app that already lives in tabs it does nothing
            the modal does not.

            The card itself is the same element in both, built once above. Two
            copies of it would be two places for a field to be wrong. */}
        {/* The handle lives in the gap, wide enough for a pointer even though
            the line it draws is one pixel. */}
        {cardMode === "side" && picked && <div role="separator" aria-orientation="vertical" tabIndex={0}
          aria-label="Drag to resize the card pane"
          title="Drag to resize · double-click for the usual width"
          onDoubleClick={() => setCardW(CARD_W_DEFAULT)}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") { e.preventDefault(); setCardW((w) => clampCardW(w + (e.shiftKey ? 40 : 12))); }
            else if (e.key === "ArrowRight") { e.preventDefault(); setCardW((w) => clampCardW(w - (e.shiftKey ? 40 : 12))); }
            else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setCardW(CARD_W_DEFAULT); }
          }}
          onPointerDown={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            dragging.current = true;
            /* Measured against the window's right edge rather than by adding up
               deltas: a drag that accumulates drifts away from the pointer the
               moment one move is dropped. */
            const right = window.innerWidth;
            const move = (ev: PointerEvent) => { if (dragging.current) setCardW(clampCardW(right - ev.clientX)); };
            const up = () => {
              dragging.current = false;
              window.removeEventListener("pointermove", move);
              window.removeEventListener("pointerup", up);
            };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", up);
          }}
          className="shrink-0 self-stretch"
          style={{ width: 5, marginRight: -5, cursor: "col-resize", zIndex: 5 }} />}
        {/* Only with a card in it. An empty pane saying "Pick a card." spent
            380px telling you to do the thing you were already doing, and took
            that width from the table you were reading to choose. */}
        {cardMode === "side" && picked && (
        <aside className="flex flex-col shrink-0 min-w-0"
          style={{ width: cardW, borderLeft: edge(12) }}>
          {/* No eyebrow over this pane. It said the word "Card" above a card,
              which was already earning its keep only by carrying the width
              button beside it — and the width is dragged from the edge now. A
              heading that labels the obvious costs the card its first line, and
              this pane starts level with the table's own heading instead. */}
          <div className="agx-scroll flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-4 pb-0 text-[11.5px] flex flex-col"
            style={{ paddingTop: 0 }}>
            {cardBody}
          </div>
        </aside>
        )}
      </div>
      {/* Laid over the panel, with the list dimmed behind rather than gone:
          you are reading one card OUT of a list, and the list is the context
          that makes it mean anything. Click the dimmed part or press Escape
          to come back.

          Over the WHOLE panel, not over the table inside it: as a child of the
          table's row it began below the board bar and the filter bar, so a card
          got the bottom three quarters of a window that had already been given
          over to it. */}
        {cardMode === "modal" && picked && (
          <div className="absolute inset-0 z-30 flex items-stretch justify-center p-2"
            style={{ background: "color-mix(in srgb, var(--bg) 62%, transparent)" }}
            onClick={() => setSel(null)}>
            {/* The card is what "this screen" means while it is open — see
                findScope.ts. Without this, a search over the board would walk
                the hundred rows behind it as well. */}
            <div role="dialog" aria-modal="true" aria-label={picked.title}
              ref={cardBox}
              onClick={(e) => e.stopPropagation()}
              className="flex flex-col min-h-0 rounded-xl overflow-hidden"
              /* Nine tenths of the window rather than 760px. A card in modal mode is
                 the whole screen's worth of attention — the board behind it is dimmed
                 — and on a wide monitor 760px was a column of text with two thirds of
                 the screen dark around it. The cap keeps a line of prose readable on a
                 very wide display, where a full-width paragraph is its own problem. */
              /* Height as well as width. It used to be content-height inside a
                 24px inset, so a long card left a band of dimmed board above and
                 below it and the reading area was the smaller half of a screen
                 that had already been given over to one card. */
              style={{ width: "min(1500px, 92vw)", height: "100%", maxHeight: "100%",
                background: "var(--bg)", border: edge(22), boxShadow: "0 18px 50px rgba(0,0,0,0.45)" }}>
              <div className="agx-scroll flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-4 pb-0 text-[11.5px] flex flex-col">
              {cardBody}
          </div>
            </div>
          </div>
        )}
    </div>
  );
}

/**
 * One write, described.
 *
 * It used to be "a change that has been proposed but not made", held behind a
 * strip that said "Your team sees this. It is not undoable from here." That strip
 * is gone: it stood in front of every field write on the board, and a confirmation
 * you press dozens of times in a morning is not a safeguard, it is a tax — the
 * panel felt slower than the website it exists to replace. What remains of the
 * safety is the part that works without asking: the stamp guard, which refuses a
 * card somebody else moved, and a refusal that puts the old value back and says so.
 *
 * `what`, `from` and `to` went with the strip. What a write still needs to carry is
 * the sentence for when it lands.
 */
interface Pending {
  done: string;
  /**
   * What the card looks like the moment the press happens, before the answer.
   *
   * Drawn immediately and replaced by the card the server answers with. This is
   * the other half of losing the confirmation: without it the value on screen does
   * not move until the round trip lands, which reads as a press that did nothing —
   * and then everything jumps at once. Dropped if the write is refused, so a value
   * nobody accepted is never left sitting there.
   */
  optimistic?: Partial<ProviderTask>;
  /**
   * `stamp` is the `date_updated` to write against — the one the last write to
   * this card answered with, or the one the row was read at. Optional because the
   * writes that go through the confirmation strip have only ever had the second.
   */
  go: (stamp?: number) => Promise<{ ok: boolean; error?: string; conflict?: boolean; task?: ProviderTask }>;
}

/**
 * A run of things that happened to the card, with nothing said in between.
 *
 * Folded past three, which is ClickUp's own behaviour and not decoration: a bug
 * card opens with a dozen automation rows in front of the first sentence a person
 * wrote, and unfolded they push the conversation off the screen — "that way the
 * scroll doesn't get huge and you go to what matters, which is the comments". Under
 * three there is nothing to hide and a press to read one line is a press wasted.
 *
 * Dim, small, and not in a card of its own: these are the margin of the
 * conversation. A status change drawn with the weight of a comment is a timeline
 * where you cannot find what somebody said.
 */
function EventRun({ events, open, onToggle, faceFor }: {
  events: CardEvent[]; open: boolean; onToggle: () => void;
  /** A face for the person a line names, when the board knows one. The API
   *  never says who did anything; these sentences do, and a name deserves the
   *  same face the creation row gets. */
  faceFor?: (name: string) => NonNullable<ProviderTask["people"]>[number] | null;
}) {
  const foldable = folds({ kind: "events", at: events[0]?.at ?? 0, events, id: "" });
  const rows = foldable && !open ? [] : events;
  return (
    <div className="mb-3">
      {rows.map((e, i) => (
        <div key={`${e.at}-${i}`} className="flex items-baseline gap-2 py-0.5 text-[10.5px]"
          style={{ color: "var(--text3)" }}
          /* Why the moves have no name on them, on the row itself rather than
             in a footnote nobody reads. */
          title={e.kind === "status" ? NO_AUTHOR_NOTE : undefined}>
          {/* The face, where ClickUp gives one — the creation does, a move does
              not. Same round 14px as everywhere else, and the bullet keeps the
              rows that have no face aligned with the ones that do. */}
          {(() => {
            const seenWho = e.kind === "seen" ? seenActor(e.text ?? "").who : "";
            const person = seenWho ? faceFor?.(seenWho) : null;
            if (e.avatar) {
              return (
                <img src={e.avatar} alt="" loading="lazy" referrerPolicy="no-referrer" title={e.who}
                  className="shrink-0 self-center rounded-full"
                  style={{ width: 14, height: 14, objectFit: "cover" }} />
              );
            }
            /* The face for a name the sentence carries. Initials in the
               workspace's own colour when there is no picture — the same
               fallback every other face in this panel uses. */
            if (person) {
              return person.avatar
                ? <img src={person.avatar} alt="" loading="lazy" referrerPolicy="no-referrer" title={person.name}
                    className="shrink-0 self-center rounded-full"
                    style={{ width: 14, height: 14, objectFit: "cover" }} />
                : <span className="shrink-0 self-center rounded-full inline-flex items-center justify-center"
                    title={person.name}
                    style={{ width: 14, height: 14, fontSize: 8, background: person.color || "var(--bg4)", color: "#fff" }}>
                    {person.initials}
                  </span>;
            }
            return <span aria-hidden className="shrink-0 text-center" style={{ width: 14, color: "var(--text4)" }}>·</span>;
          })()}
          <span className="min-w-0 flex-1">
            {e.kind === "seen" && seenActor(e.text ?? "").who
              ? (() => {
                  const { who, rest } = seenActor(e.text ?? "");
                  return (<><span style={{ color: "var(--text2)", fontWeight: 600 }}>{who}</span> {rest}</>);
                })()
              : eventLine(e)}
            {/* The status in its own colour, the way every other pill in this app
                shows one — the words alone made a move to "Ready for QA" and a move
                to "Won't fix" read the same. */}
            {e.status && (
              <span className="ml-1.5 px-1 rounded"
                style={{ color: e.color || "var(--text2)", border: `1px solid color-mix(in srgb, ${e.color || "var(--text)"} 40%, transparent)` }}>
                {e.status}
              </span>
            )}
            {/* How long it sat where it was. The public API's one addition over
                the payload, and it is what makes a move readable: "moved to qa
                complete" after two hours is a different story from the same
                move after four days. */}
            {/* Where it came from, said once and quietly: this line was read
                off a notification on this machine, not from the API. */}
            {e.kind === "seen" && (
              <span className="ml-1.5 px-1 rounded text-[9.5px]"
                style={{ color: "var(--text4)", border: edge(14) }}>seen here</span>
            )}
            {e.kind === "status" && e.from && e.mins ? (
              <span className="ml-1.5" style={{ color: "var(--text4)" }}>
                after {spanLabel(e.mins)}
              </span>
            ) : null}
          </span>
          <span className="shrink-0 tabular-nums" style={{ color: "var(--text4)" }}
            title={new Date(e.at).toLocaleString()}>
            {new Date(e.at).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
          </span>
        </div>
      ))}
      {foldable && (
        <button onClick={onToggle}
          className="agx-btn w-full text-left flex items-center gap-1.5 py-1 text-[10.5px]"
          style={{ color: "var(--text4)" }}>
          <span aria-hidden style={{ display: "inline-block", transform: open ? "none" : "rotate(-90deg)" }}>▾</span>
          {open ? "Hide" : `Show ${foldLabel(events.length)}`}
        </button>
      )}
    </div>
  );
}

/**
 * A field's name, without the parenthetical the workspace keeps in it.
 *
 * Real names on a real board: "Support Tool URL (MPL)", "Service Tier (DO NOT EDIT)".
 * The part in brackets is a note to whoever maintains the list, not to whoever reads
 * the card, and at this size it costs the half of the name that identifies it. The
 * whole thing stays on the row's title.
 */
function fieldLabel(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/, "").trim() || name;
}

/**
 * One field's value, drawn as what it is.
 *
 * Five shapes, because that is how many the card really does differently — see
 * CardFieldKind. The dates are formatted HERE rather than on the server, in the
 * reader's own locale: the server has no idea where they are.
 */
function FieldValue({ f }: { f: CardFieldValue }) {
  if (f.kind === "date" && f.at) {
    return (
      <span className="text-[11.5px] tabular-nums inline-block max-w-full truncate align-bottom"
      style={{ color: "var(--text2)" }} title={new Date(f.at).toLocaleString()}>
        {new Date(f.at).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })}
      </span>
    );
  }
  if (f.kind === "url" && f.href) {
    return (
      <a href={externalUrl(f.href) || undefined} target="_blank" rel="noreferrer noopener"
        className="text-[11.5px] truncate inline-block max-w-full align-bottom"
        style={{ color: "var(--primary)" }} title={f.href}>
        {f.value} <span aria-hidden style={{ color: "var(--text4)" }}>↗</span>
      </a>
    );
  }
  if (f.color) {
    /* The workspace's own colour, at low alpha rather than ClickUp's solid block: this
       sits in a column of values, and a saturated rectangle here would outshout the
       status pill, which is the thing on the card that actually changes. */
    return (
      <span className="text-[10.5px] px-1.5 py-0.5 rounded-md inline-block max-w-full truncate align-bottom" title={f.value}
        style={{
          color: f.color,
          background: `color-mix(in srgb, ${f.color} 15%, transparent)`,
          border: `1px solid color-mix(in srgb, ${f.color} 34%, transparent)`,
        }}>
        {f.value}
      </span>
    );
  }
  /*
   * BOUNDED, like the other two branches of this function.
   *
   * The url and coloured-choice branches carry `max-w-full truncate`; this one
   * carried neither, only `overflow-wrap`. Its cell sets `min-w-0` — which is
   * what lets a flex item be squeezed narrower than its content — and nothing
   * in the chain clips, so a long multi-value list ("Checkout, Dashboard,
   * Notifications") painted straight over the field beside it. Seen on a
   * real card, with the date underneath it unreadable.
   *
   * `title` because truncating hides something: the full value is one hover
   * away rather than gone.
   */
  const text = String(f.value ?? "");
  return (
    <span className={`text-[11.5px] inline-block max-w-full truncate align-bottom ${f.kind === "number" ? "tabular-nums" : ""}`}
      title={text}
      style={{ color: "var(--text2)" }}>{f.value}</span>
  );
}

/**
 * A drop-down field, set from here.
 *
 * The same shape as the status control above it, and through the same queue: one
 * control goes busy, the value moves on the press, and a refusal puts it back. Only
 * where it would really work — the list says which options it accepts, and a field
 * marked read-only by its own name is left as text however tempting it looks.
 */
/**
 * A date custom field, set from the card.
 *
 * The native picker, not one of ours: it is the one the operating system knows,
 * it speaks the keyboard, and a calendar written here would be a month of
 * edge cases for a control that already exists.
 *
 * The wire wants MILLISECONDS and refuses a string — see setField — and what
 * comes back from the input is a plain `YYYY-MM-DD`, which is midnight in the
 * reader's own zone. That is the right reading: a due date is a day, not an
 * instant, and turning it into UTC midnight moves it a day for half the world.
 */
function FieldDate({ t, f, busy, onApply }: {
  t: ProviderTask; f: CardFieldValue; busy: boolean;
  onApply: (p: Pending) => void;
}) {
  const asDay = (raw: string): string => {
    const ms = Number(raw);
    if (!Number.isFinite(ms) || !ms) return "";
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  // `f.at` is the raw stamp when the server could read one; the drawn value is
  // already a human date and cannot be parsed back reliably.
  const current = asDay(String(f.at ?? ""));
  return (
    <input type="date" value={current} disabled={busy}
      onChange={(e) => {
        const v = e.target.value;
        if (!v) return;
        const [y, m, d] = v.split("-").map(Number);
        const ms = new Date(y!, (m ?? 1) - 1, d ?? 1, 12, 0, 0).getTime();
        onApply({
          done: `${fieldLabel(f.name)} set to ${v}`,
          go: () => api.clickupField(t.id, f.id, String(ms), "date"),
        });
      }}
      className="text-[11px] px-1.5 py-0.5 rounded outline-none"
      style={{ background: "transparent", color: "var(--text2)", border: edge(16), colorScheme: "dark" }} />
  );
}

function FieldPick({ t, f, spec, busy, onApply }: {
  t: ProviderTask; f: CardFieldValue; spec: ListField; busy: boolean;
  onApply: (p: { done: string; optimistic?: Partial<ProviderTask>; go: (stamp?: number) => Promise<{ ok: boolean; error?: string; conflict?: boolean; task?: ProviderTask }> }) => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);
  return (
    <div className="relative inline-block max-w-full" ref={box}>
      <button onClick={() => !busy && setOpen((v) => !v)} disabled={busy}
        className="agx-btn inline-flex items-center gap-1 max-w-full rounded"
        title={busy ? `Setting ${spec.name}…` : `Set ${spec.name}`}>
        <FieldValue f={f} />
        {busy
          ? <span className="agx-spin shrink-0" aria-label="Applying" style={{ width: 10, height: 10, borderWidth: 1.5, borderColor: "var(--text3)", borderTopColor: "transparent" }} />
          : <span className="shrink-0 text-[9px]" style={{ color: "var(--text4)" }}>▾</span>}
      </button>
      {open && (
        <div className="agx-scroll absolute left-0 mt-1 rounded-lg shadow-2xl flex flex-col overflow-y-auto py-1"
          style={{ zIndex: 30, background: "var(--bg2)", border: edge(28), minWidth: 180, maxHeight: 280 }}>
          {(spec.options ?? []).map((o) => (
            <button key={o.id} className="text-left px-2 py-1.5 hover:bg-white/5"
              onClick={() => {
                setOpen(false);
                onApply({
                  done: `${spec.name} → ${o.name}`,
                  /* The chip changes on the press, in the option's own colour — the
                     card is read by those colours, and a value that arrives a second
                     later reads as a press that did nothing. */
                  optimistic: {
                    custom: (t.custom ?? []).map((x) => (x.id === f.id
                      ? { ...x, value: o.name, ...(o.color ? { color: o.color } : { color: undefined }) }
                      : x)),
                  },
                  go: () => api.clickupField(t.id, spec.id, o.id),
                });
              }}>
              {o.color
                ? <span className="text-[10.5px] px-1.5 py-0.5 rounded-md"
                    style={{ color: o.color, background: `color-mix(in srgb, ${o.color} 15%, transparent)`, border: `1px solid color-mix(in srgb, ${o.color} 34%, transparent)` }}>{o.name}</span>
                : <span className="text-[11px]" style={{ color: "var(--text2)" }}>{o.name}</span>}
            </button>
          ))}
        </div>
      )}
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
/**
 * What a list is for, as ClickUp's own dialog is: over the board, not above it.
 *
 * The text is all the API gives — measured twice, including with
 * `include_markdown_description`: ClickUp's rich chips (a Google Doc, a Figma
 * file, a Slack channel) are blocks it renders in the browser and does not
 * publish, so they arrive as their labels with nothing behind them. What DOES
 * arrive is every plain URL, the branch name and the card ids, and those are
 * the ones worth wiring: a pull request opens in this app's own pull-request
 * view rather than in a browser, a card id opens the card, and a branch offers
 * to take you to it in Git.
 */
/**
 * Where a view lives on the web.
 *
 * ClickUp's own addresses are `/{workspace}/v/{kind}/{viewId}`, and the kind is
 * a two-or-three letter code per view type. Only the two that were asked for
 * are mapped: a Gantt and a dashboard. Anything else gets no shortcut rather
 * than a guessed one — the last invented address in this file answered "This
 * page is unavailable", which reads as a permission problem rather than as our
 * typo.
 *
 * The workspace comes off a saved folder, which is where it was written when
 * the folder was added; without one there is no address to build and the row
 * is not drawn.
 */
const VIEW_KIND: Record<string, string> = { gantt: "g", dashboard: "dsb" };
function clickupViewUrl(folders: SavedFolder[], view: { id: string; type: string }): string {
  const kind = VIEW_KIND[view.type];
  const workspace = folders.find((f) => f.workspaceId)?.workspaceId;
  if (!kind || !workspace) return "";
  return `https://app.clickup.com/${workspace}/v/${kind}/${encodeURIComponent(view.id)}`;
}

function AboutList({ name, text, url, onClose }: {
  name: string; text: string; url?: string; onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  useDismiss(true, box, onClose);
  return (
    <Portal find z={LAYER.viewer}>
      <div className="fixed inset-0" style={{ background: "color-mix(in srgb, var(--bg) 62%, transparent)" }} onClick={onClose} />
      <div ref={box} role="dialog" aria-modal="true" aria-label={`About ${name}`}
        onClick={(e) => e.stopPropagation()}
        className="fixed left-1/2 top-1/2 flex flex-col min-h-0 rounded-xl overflow-hidden"
        style={{
          transform: "translate(-50%, -50%)", width: "min(760px, 92vw)", maxHeight: "82vh",
          background: "var(--bg)", border: edge(22), boxShadow: "0 18px 50px rgba(0,0,0,0.45)",
        }}>
        <div className="flex items-center gap-2 px-4 py-2.5 shrink-0" style={{ borderBottom: edge(12) }}>
          <span className="text-[12.5px]" style={{ color: "var(--text)" }}>{name}</span>
          <span className="text-[10px]" style={{ color: "var(--text4)" }}>what this list is for</span>
          <span className="flex-1" />
          {externalUrl(url ?? "") && (
            <button onClick={() => openExternal(url!)} className="text-[10.5px] px-2 py-0.5 rounded-lg"
              style={{ border: edge(16), color: "var(--text3)" }}>Open in ClickUp ↗</button>
          )}
          <CloseButton onClick={onClose} title="Close (Esc)" />
        </div>
        <div className="agx-scroll flex-1 min-h-0 overflow-y-auto px-4 py-3 text-[12px]" style={{ color: "var(--text2)" }}>
          <AboutBody text={text} />
        </div>      </div>
    </Portal>
  );
}

/**
 * The brief, laid out as the label/value pairs it actually is.
 *
 * The first attempt printed it line by line and shouted every heading in
 * capitals, which turned `Project requirements document:` into a banner and the
 * whole thing into a wall. It is a form: a label, and what is on the other side
 * of the colon. Two columns read it in a glance.
 *
 * The empty halves are the ones ClickUp keeps to itself — a Doc, a Figma file,
 * a Slack channel are rich blocks its API does not publish — so they are shown
 * greyed rather than dropped (a missing row reads as a brief that never had
 * one) and counted once at the foot, where the way to see them is offered.
 */
function AboutBody({ text }: { text: string }) {
  const rows = text.split("\n").map((l) => l.trimEnd()).filter((l, i, all) => l.trim() || (i > 0 && all[i - 1]!.trim()));
  const blanks = rows.filter((l) => /^[^:]{1,40}:\s*$/.test(l.trim())).length;
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 12rem) 1fr", columnGap: 12, rowGap: 3 }}>
        {rows.map((line, i) => {
          const t = line.trim();
          if (!t) return <div key={i} style={{ gridColumn: "1 / -1", height: 6 }} />;
          const m = /^([^:]{1,40}):\s*(.*)$/.exec(t);
          if (!m) return <div key={i} style={{ gridColumn: "1 / -1" }}><AboutValue text={t} /></div>;
          const [, label, value] = m;
          return (
            <Fragment key={i}>
              <div className="truncate" style={{ color: value!.trim() ? "var(--text3)" : "var(--text4)" }}>{label}</div>
              <div className="min-w-0">
                {value!.trim()
                  ? <AboutValue text={value!} />
                  : <span style={{ color: "var(--text4)" }}>—</span>}
              </div>
            </Fragment>
          );
        })}
      </div>
      {blanks >= 2 && (
        /* No count: the empty rows are a mix of section headings (`Docs:`,
           `Team:`) and genuinely missing chips, and a number that lumps them
           together is a number that is wrong. */
        <div className="mt-3 pt-2 text-[10.5px]" style={{ borderTop: edge(10), color: "var(--text4)" }}>
          The blanks are ClickUp's own cards — a Doc, a Figma file, a Slack channel. Its API publishes the words and keeps those to itself; open the list there to follow them.
        </div>
      )}
    </>
  );
}

/** A value, with the parts this app can act on turned into buttons. */
function AboutValue({ text }: { text: string }) {
  /* Split on anything addressable. The card pattern is a workspace prefix and a
     number — the shape `cardRef` looks for — and a branch is recognised by
     carrying one. */
  const parts = text.split(/(https?:\/\/[^\s)]+|\b[A-Z][A-Z0-9]+-\d{3,}[\w-]*)/g).filter(Boolean);
  return (
    <span className="break-words">
      {parts.map((p, i) => {
        const pr = prRefFromUrl(p);
        if (pr) {
          return (
            <button key={i} onClick={() => openPr(pr.repo, pr.number)} title={`Open #${pr.number} here`}
              className="underline underline-offset-2" style={{ color: "var(--primary)" }}>
              #{pr.number} <span style={{ color: "var(--text4)" }}>{pr.repo}</span>
            </button>
          );
        }
        if (/^https?:\/\//.test(p)) {
          return (
            <button key={i} onClick={() => openExternal(p)} title={p}
              className="underline underline-offset-2 break-all" style={{ color: "var(--primary)" }}>{p}</button>
          );
        }
        /* A card id, or a branch that carries one. Both open the card: a branch
           name is how a team says which card a branch is for, and there is
           nothing else here a bare branch name can open. */
        if (/^[A-Z][A-Z0-9]+-\d{3,}/.test(p)) {
          const id = p.match(/^[A-Z][A-Z0-9]+-\d+/)?.[0] ?? p;
          return (
            <button key={i} onClick={() => openCard(id, id)} title={p.length > id.length ? `${p} — open ${id}` : `Open ${id}`}
              className="underline underline-offset-2" style={{ color: "var(--primary)" }}>{p}</button>
          );
        }
        return <span key={i}>{p}</span>;
      })}
    </span>
  );
}

function Breadcrumb({ place, className, onList }: {
  place?: ListPlace; className?: string;
  /**
   * Open the LIST this card is on.
   *
   * Only the list, and only when there is somewhere to go: a space and a folder are
   * context here — this panel has no view of either — and a breadcrumb where two of
   * three parts do nothing when pressed is worse than one that never offered. Absent
   * when the card is already on the board you are looking at, which is the other way
   * to promise nothing.
   */
  onList?: () => void;
}) {
  if (!place) return null;
  const parts = [place.space, place.folder, place.list].filter(Boolean) as string[];
  if (!parts.length) return null;
  return (
    <div className={`flex items-center gap-1 min-w-0 text-[10px] ${className ?? ""}`}
      title={parts.join("  /  ")}>
      {parts.map((p, i) => {
        const last = i === parts.length - 1;
        const go = last && onList ? onList : undefined;
        return (
          <span key={`${p}-${i}`} className="flex items-center gap-1 min-w-0">
            {i > 0 && <span aria-hidden style={{ color: "var(--text4)", opacity: 0.7 }}>/</span>}
            {/* The last one is where you are; the ones before it are context, and
                dimmer, which is what makes a breadcrumb readable at a glance. */}
            {go
              ? (
                <button onClick={go} title={`Open ${p}`}
                  className="agx-btn truncate rounded px-1 -mx-1 hover:underline"
                  style={{ color: "var(--primary)" }}>{p}</button>
              )
              : <span className="truncate" style={{ color: last ? "var(--text2)" : "var(--text4)" }}>{p}</span>}
          </span>
        );
      })}
    </div>
  );
}

/**
 * Two ways to put something on the sidebar, on one bar.
 *
 * Pasting an address was the only way, and it is the wrong shape for the common
 * case: somebody who wants their team's boards wants a FOLDER — eleven lists
 * that change over the quarter — and pasting eleven addresses is both tedious
 * and stale by the next sprint.
 *
 * The picker is two reads and no more, because `/space/{id}/folder` answers
 * with the lists inside each folder: pick a space, see its folders with their
 * sizes, add one.
 */
function AddBoardBar({ value, onValue, onAdd, onClose, busy, editing, folders, onAddFolder, onAddList }: {
  value: string; onValue: (v: string) => void; onAdd: () => void; onClose: () => void; busy: boolean;
  /** The board whose address is being changed, when that is the errand. */
  editing?: string | null;
  /** Already on the sidebar, so the picker can say so instead of offering it
   *  again. */
  folders: SavedFolder[];
  onAddFolder: (id: string, spaceName: string) => void;
  /** Add ONE list that sits directly in a space. A folder is added whole; a
   *  loose list has no folder to be added with, so it goes on its own. */
  onAddList: (listId: string) => void;
}) {
  /* Changing an address is about ONE board, so the picker is not offered then:
     a tab strip on a bar that exists to edit a single row is a way to lose what
     you were doing. */
  const [tab, setTab] = useState<"folder" | "url">(editing ? "url" : "folder");
  return (
    <div className="px-5 pb-2 flex flex-col gap-1.5 shrink-0">
      {!editing && (
        <div className="flex items-center gap-3 text-[10px] uppercase tracking-[0.14em]">
          {([["folder", "A folder"], ["url", "By address"]] as const).map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)}
              className="pb-0.5"
              style={{
                color: tab === id ? "var(--text)" : "var(--text4)",
                borderBottom: `2px solid ${tab === id ? "var(--primary)" : "transparent"}`,
              }}>{label}</button>
          ))}
          <span className="flex-1" />
          <button onClick={onClose} className="text-[10px]" style={{ color: "var(--text4)", textTransform: "none", letterSpacing: 0 }}>Close</button>
        </div>
      )}
      {tab === "url" || editing ? (
        <div className="flex items-center gap-2">
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
      ) : (
        <FolderPicker folders={folders} busy={busy} onAdd={onAddFolder} onAddList={onAddList} />
      )}
    </div>
  );
}

/**
 * Space, then folder.
 *
 * Both reads are cached for as long as the bar is open — a workspace's spaces
 * do not change while somebody picks one — and the folder list carries its own
 * count, which is the number that decides whether you want it on a sidebar at
 * all: `Projects (Backlog)` holds 144 lists and is not a thing anybody wants
 * expanded in a column 200 pixels wide.
 */
function FolderPicker({ folders, busy, onAdd, onAddList }: {
  folders: SavedFolder[]; busy: boolean;
  onAdd: (id: string, spaceName: string) => void;
  onAddList: (listId: string) => void;
}) {
  const [spaces, setSpaces] = useState<{ id: string; name: string }[] | null>(null);
  const [space, setSpace] = useState("");
  const [found, setFound] = useState<{ id: string; name: string; lists: { id: string; name: string; tasks?: number }[]; folderless?: boolean }[] | null>(null);
  const [err, setErr] = useState("");
  /** Which list is showing its views. One at a time: two open at once is a
   *  wall of forty chips and no way to tell which belongs to which. */
  const [openList, setOpenList] = useState("");
  const seen = useRef(new Map<string, { id: string; name: string; lists: { id: string; name: string; tasks?: number }[]; folderless?: boolean }[]>());

  useEffect(() => {
    let live = true;
    api.clickupSpaces().then((r) => {
      if (!live) return;
      if (!r.ok) { setErr(r.error || "ClickUp did not answer"); return; }
      const list = r.spaces ?? [];
      setSpaces(list);
      /* The space the sidebar already draws from, when there is one: somebody
         adding a second folder is almost always adding it from the same place
         as the first. */
      setSpace(folders[0]?.spaceName ? (list.find((x) => x.name === folders[0]!.spaceName)?.id ?? list[0]?.id ?? "") : list[0]?.id ?? "");
    }).catch((e) => { if (live) setErr(String(e)); });
    return () => { live = false; };
  }, [folders]);

  useEffect(() => {
    if (!space) { setFound(null); return; }
    const had = seen.current.get(space);
    if (had) { setFound(had); return; }
    let live = true;
    setFound(null);
    api.clickupFolders(space).then((r) => {
      if (!live) return;
      if (!r.ok) { setErr(r.error || "ClickUp did not answer"); return; }
      seen.current.set(space, r.folders ?? []);
      setFound(r.folders ?? []);
    }).catch((e) => { if (live) setErr(String(e)); });
    return () => { live = false; };
  }, [space]);

  const on = new Set(folders.map((f) => f.id));
  const spaceName = spaces?.find((x) => x.id === space)?.name ?? "";

  if (err) return <div className="text-[11px] py-1" style={{ color: "var(--error)" }}>{err}</div>;
  if (!spaces) return <div className="text-[11px] py-1" style={{ color: "var(--text4)" }}>Reading your workspace…</div>;

  return (
    <div className="flex flex-col gap-1.5">
      <select value={space} onChange={(e) => setSpace(e.target.value)}
        className="text-[11.5px] px-2 py-1.5 rounded-lg self-start min-w-[200px]"
        style={{ background: "var(--bg2)", border: edge(18), color: "var(--text)" }}>
        {spaces.map((sp) => <option key={sp.id} value={sp.id}>{sp.name}</option>)}
      </select>
      {!found ? (
        <div className="text-[11px] py-1" style={{ color: "var(--text4)" }}>Reading its folders…</div>
      ) : !found.length ? (
        <div className="text-[11.5px] py-1" style={{ color: "var(--text3)" }}>Nothing in that space.</div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {/*
            THE LOOSE LISTS ARE PEERS, drawn one by one.
           *
            They arrived from the server gathered under one entry, which kept
            the shape simple here and hid the thing somebody was looking for:
            a chip reading "Lists in this space 5" answers "where is Bugs?"
            with "somewhere in here". The tracker's own sidebar draws them
            individually below the folders, each with its name and its count,
            and that is the arrangement that lets you find one.
           *
            A folder is added WHOLE, so its chip stays one chip. A loose list
            is added on its own — there is nothing to add it with.
          */}
          {found.flatMap((f): PickRow[] => (
            f.folderless ? f.lists.map((l) => ({ list: l })) : [{ folder: f }]
          )).map((row) => (
            row.list ? (
              <button key={`l:${row.list.id}`} disabled={busy}
                onClick={() => setOpenList(openList === row.list!.id ? "" : row.list!.id)}
                title={`A list sitting directly in this space${typeof row.list.tasks === "number" ? ` — ${row.list.tasks} task${row.list.tasks === 1 ? "" : "s"}` : ""}. Open it to pick which of its views to add.`}
                className="text-[11px] px-2 py-1 rounded-lg flex items-center gap-1.5"
                style={{
                  border: openList === row.list.id ? "1px solid color-mix(in srgb, var(--primary) 45%, transparent)" : edge(18),
                  color: openList === row.list.id ? "var(--text)" : "var(--text2)",
                  opacity: busy ? 0.5 : 1,
                }}>
                <span className="text-[9.5px] shrink-0" style={{ color: "var(--text4)" }}>▤</span>
                <span className="truncate max-w-[190px]">{row.list.name}</span>
                {typeof row.list.tasks === "number" && (
                  <span className="tabular-nums text-[9.5px]" style={{ color: "var(--text4)" }}>{row.list.tasks}</span>
                )}
              </button>
            ) : <Folder key={`f:${row.folder!.id}`} f={row.folder!} on={on.has(row.folder!.id)} busy={busy} onAdd={() => onAdd(row.folder!.id, spaceName)} />
          ))}
        </div>
      )}
      {/*
        A LIST IS NOT A BOARD — it is a place that holds boards.
       *
        Measured on a real one: twenty-six views on a single list, four of them
        named some variant of the list's own name, and the one its owner works
        from every day is called the same thing the list is. Adding "the list"
        gets you whichever view the tracker considers default, which is none of
        those — which is exactly the reported problem: the address he pasted
        was the view he needed, and the menu could only offer him the list.
       *
        So the chip opens instead of adding, and this is what it opens. The
        filter is not decoration at twenty-six.
       *
        `/clickup/list-views` already existed for the sidebar, which has hung
        views under a list for as long as it has had one. This asks it the same
        question.
      */}
      {openList && <ListViews listId={openList} busy={busy} onPick={onAddList} />}
    </div>
  );
}

/** The views inside one list, to pick one from. */
function ListViews({ listId, busy, onPick }: { listId: string; busy: boolean; onPick: (id: string) => void }) {
  const [views, setViews] = useState<{ id: string; name: string }[] | null>(null);
  const [links, setLinks] = useState<{ id: string; name: string; type: string }[]>([]);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");

  useEffect(() => {
    let live = true;
    setViews(null); setErr(""); setQ("");
    api.clickupListViews(listId).then((r) => {
      if (!live) return;
      if (!r.ok) { setErr(r.error || "ClickUp did not answer"); return; }
      setViews(r.views ?? []); setLinks(r.links ?? []);
    }).catch((e) => { if (live) setErr(String(e)); });
    return () => { live = false; };
  }, [listId]);

  if (err) return <div className="text-[11px] py-1" style={{ color: "var(--error)" }}>{err}</div>;
  if (!views) return <div className="text-[11px] py-1" style={{ color: "var(--text4)" }}>Reading its views…</div>;

  const ql = q.trim().toLowerCase();
  const shown = ql ? views.filter((v) => v.name.toLowerCase().includes(ql)) : views;

  return (
    <div className="flex flex-col gap-1.5 mt-1 p-2 rounded-lg" style={{ border: edge(18), background: "var(--bg2)" }}>
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-[0.12em]" style={{ color: "var(--text4)" }}>views in this list</span>
        <span className="tabular-nums text-[10px]" style={{ color: "var(--text4)" }}>{views.length}</span>
        {views.length > 8 && (
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter…"
            className="ml-auto text-[11px] px-2 py-0.5 rounded outline-none w-[140px]"
            style={{ background: "var(--bg)", border: edge(18), color: "var(--text)" }} />
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {/* The list itself first, which is the old behaviour kept as a choice —
            sometimes the default view IS what somebody wants. */}
        <button disabled={busy} onClick={() => onPick(listId)}
          title="The list, on whichever view ClickUp treats as its default"
          className="text-[11px] px-2 py-1 rounded-lg"
          style={{ border: edge(18), color: "var(--text3)", opacity: busy ? 0.5 : 1 }}>the list itself</button>
        {shown.map((v) => (
          <button key={v.id} disabled={busy} onClick={() => onPick(v.id)}
            className="text-[11px] px-2 py-1 rounded-lg"
            style={{ border: edge(18), color: "var(--text2)", opacity: busy ? 0.5 : 1 }}>
            <span className="truncate max-w-[190px] inline-block align-bottom">{v.name}</span>
          </button>
        ))}
        {!shown.length && <span className="text-[11px] py-1" style={{ color: "var(--text4)" }}>Nothing matches “{q.trim()}”.</span>}
      </div>
      {links.length > 0 && (
        /* Named, not hidden. A Gantt or a dashboard is a real view and this app
           cannot draw one — saying so is better than a list that quietly omits
           four of the twenty-six and looks complete. */
        <div className="text-[10.5px]" style={{ color: "var(--text4)" }}>
          {links.length} more this app cannot draw ({[...new Set(links.map((l) => l.type))].join(", ")}) — open those in ClickUp.
        </div>
      )}
    </div>
  );
}

/** A row in the picker: either a folder (added whole) or one loose list. The
 *  union is explicit because `flatMap` over a mixed shape widens to the first
 *  branch it sees otherwise. */
type PickRow =
  | { folder: { id: string; name: string; lists: { id: string; name: string; tasks?: number }[]; folderless?: boolean }; list?: undefined }
  | { list: { id: string; name: string; tasks?: number }; folder?: undefined };

/** One folder, added whole — so new lists inside it turn up on their own. */
function Folder({ f, on, busy, onAdd }: {
  f: { id: string; name: string; lists: { id: string; name: string }[] };
  on: boolean; busy: boolean; onAdd: () => void;
}) {
  return (
    <>
      {[f].map((f) => (
            <button key={f.id} disabled={busy || on}
              onClick={onAdd}
              /* A folderless entry is not a folder and must not claim to be
                 one: the lists inside it sit directly in the space, and "new
                 ones turn up on their own" is true of both but for a different
                 reason. Saying which is which is what stops somebody looking
                 for a folder that does not exist. */
              title={on ? "Already on the sidebar"
                : `${f.lists.length} list${f.lists.length === 1 ? "" : "s"} — added whole, so new ones turn up on their own`}
              className="text-[11px] px-2 py-1 rounded-lg flex items-center gap-1.5"
              style={{
                border: on ? "1px solid color-mix(in srgb, var(--success) 40%, transparent)" : edge(18),
                color: on ? "var(--success)" : "var(--text2)",
                opacity: busy ? 0.5 : 1,
              }}>
              <span className="truncate max-w-[190px]">{f.name}</span>
              <span className="tabular-nums text-[9.5px]" style={{ color: "var(--text4)" }}>{on ? "on" : f.lists.length}</span>
            </button>
          ))}
    </>
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
const CARD_W_KEY = "agentglass.clickup.cardWidth";
const RAIL_KEY = "agentglass.clickup.listRail";
/** Which folders in that rail are folded shut, by folder key. */
const RAIL_SHUT_KEY = "agentglass.clickup.listRail.shut";
const CARD_MODE_KEY = "agentglass.clickup.cardMode";
/** The width it goes back to. The old narrow setting, kept as the default
 *  because it is the one most cards are read at. */
const CARD_W_DEFAULT = 380;
/**
 * How wide the side card may be.
 *
 * The floor is readability: under 280 the card stops being one. The CEILING used to be
 * a flat 720, which on a 2000px screen is the app refusing to use the room it has — it
 * was reported as not being able to drag the pane wider, and the grip was working
 * perfectly. What the ceiling is really protecting is the TABLE beside it, so it is
 * measured from the window: leave the list its 420px and the rest is the card's.
 *
 * `window` is read at call time rather than captured, so the bound follows a window
 * being resized rather than the one it happened to open at; and a headless render
 * (a test, an SSR pass) falls back to the old flat number instead of throwing.
 */
const clampCardW = (w: number): number => {
  const room = typeof window === "undefined" ? 1100 : window.innerWidth - 420;
  const max = Math.max(720, Math.min(1400, room));
  return Math.max(280, Math.min(max, Math.round(w)));
};
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
/*
 * A filter that is ON has to look ON.
 *
 * The old treatment was the accent at 18% behind a normal-weight label, which
 * beside five identical outlined chips reads as "slightly warmer", not as "this
 * one is doing something". Reported as not being able to tell what was picked.
 * Filled, in the accent'"'"'s own colour, with the panel'"'"'s background for the text —
 * the same way the app marks a pressed control everywhere else.
 */
const ON_CHIP = {
  background: "var(--primary)", border: "1px solid var(--primary)", color: "var(--bg)", fontWeight: 600,
} as const;
const ON_CHIP_OK = {
  background: "var(--success)", border: "1px solid var(--success)", color: "var(--bg)", fontWeight: 600,
} as const;

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
/**
 * The width below which the table scrolls sideways instead of squeezing.
 *
 * The title track is `1fr`, so without a floor the columns just get narrower
 * and narrower as the card pane is dragged open — sprint names clip, the point
 * count lands under its own heading, and nothing tells you it happened. Past
 * this the row keeps its shape and the columns move off the right instead,
 * with Task held still. Which is what ClickUp does, and for the same reason.
 *
 * The number is the fixed tracks plus their gaps plus a title wide enough to
 * read: it is not a preference, it is the point where the row stops working.
 */
const TABLE_MIN_W = 720;

/**
 * The height both headers share.
 *
 * The rail's filter box and the table's column titles start at the same line
 * and used to end at different ones, so the two rules under them were a few
 * pixels apart across the whole panel — the kind of thing you cannot unsee once
 * it is pointed at. One number, used by both, is what keeps them level when
 * either changes.
 *
 * Set by the taller of the two: the rail holds a real input and a button, and
 * shrinking those to meet a text label would cost a control to save a rule.
 */
const HEAD_H = 34;

const cuGrid = (who: boolean, squad: boolean, sprint: boolean, est: boolean, forget: boolean) =>
  // The comments column is unconditional, unlike Who and Sprint. Those come and
  // go because a board where nobody is assigned has nothing to put in them; a
  // count of zero is a real answer and worth the 30px — "nobody has said
  // anything about this card" is exactly the thing a glance is looking for.
  // The comment count sits BEFORE Due, not beside Pts. Next to it they were two
  // narrow right-aligned integers touching, told apart only by a heading eight
  // pixels tall — so a card with 3 points and 8 comments read as either. Two
  // columns of the same shape need something between them, and Due is the
  // widest thing on the row.
  // The swatch track is 36px for a dot that is 18: the width belongs to the
  // HEADING, not the dot. A colour with no word over it is a code the reader has
  // to have been told, and this column is the one thing on the row that is pure
  // colour — so it pays for the label that says which field it is.
  // Looked-up rows carry a "forget this one" control the board rows do not.
  // Its own track, not a floating overlay on top of the last column: a button
  // with nothing under it is easy, a button on top of the ↗ chip is the thing
  // this table stopped doing.
  ["1fr", who ? "50px" : "", squad ? "36px" : "", sprint ? "88px" : "", "34px", "72px", est ? "38px" : "", "30px", "40px", forget ? "30px" : ""].filter(Boolean).join(" ");

/**
 * The one custom field worth a column of its own: a coloured drop-down.
 *
 * A squad, a pod, a team — whatever the board calls it, it is the field people
 * scan a board BY, and ClickUp itself renders it as a block of colour rather
 * than as a word. Picked by name first, so a board with several coloured
 * drop-downs shows the one that means "whose work is this"; otherwise the first
 * coloured one, which on a board with exactly one is the same answer without
 * anybody having to configure it.
 *
 * Null for a field nobody coloured: a grey dot in a colour column is a value
 * pretending to be a category, and the card still spells the value out.
 */
function swatch(t: ProviderTask): { name: string; value: string; color: string } | null {
  const coloured = (t.custom ?? []).filter((c) => c.color);
  const hit = coloured.find((c) => /squad|team|pod|tribe/i.test(c.name)) ?? coloured[0];
  // The "(DO NOT EDIT!!!)" kind of parenthesis is a note to whoever edits the
  // field, not part of its name, and the card already strips it. A heading is
  // three characters wide here — it cannot carry an aside as well.
  return hit ? { name: hit.name.replace(/\s*\(.*\)\s*$/, ""), value: hit.value, color: hit.color! } : null;
}

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
function NoteStrip({ note, onClose }: { note: { ok: boolean; text: string; go?: { label: string; run: () => void } }; onClose: () => void }) {
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
      {/* A note that names a place has to be able to take you there. It said
          "in Looked up" and left the reader to find the drawer and then empty
          the box by hand before anything showed. */}
      {note.go && (
        <button onClick={() => { note.go!.run(); onClose(); }}
          className="shrink-0 px-1.5 rounded hover:bg-white/10 underline underline-offset-2"
          style={{ color: tone }}>{note.go.label}</button>
      )}
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
     *
     * Then it was 4, and the frozen Task column is a layer too: scrolling the
     * board sideways slid a face over the titles. Three is below both, and the
     * faces still order themselves.
     */
    zIndex: 3 - n,
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
/**
 * One shape for every chip on a card's identity line.
 *
 * Not the toolbar's `CHIP` from workspace/Chrome: that one is a CONTROL — 11px in a
 * 32px bar, sized to be pressed among other controls. These sit in a dense header
 * beside a title, and two of them are not controls at all. Same idea, one rung down,
 * and written once so the four cannot drift again.
 *
 * There were four of them and three type sizes: the id at 10.5px, ClickUp's own id at
 * 9.5px, the priority at 8.5px with no vertical padding at all, and "yours" at 8.5px
 * with some. Four chips in a row at four heights reads as four unrelated things —
 * reported as exactly that. The only thing that varies now is colour, which is the one
 * difference that carries meaning.
 */
const ID_CHIP = "text-[10px] px-1.5 py-0.5 rounded-md leading-[1.35] whitespace-nowrap";

/**
 * The micro-label above a section or beside a value.
 *
 * There were nine spellings of this one thing in this file — 8.5px, 9px and 10px, at
 * `tracking-wider`, `0.14em`, `0.16em`, `0.18em` and `0.2em` — so "Fields", "Pull
 * requests", the column headings, the sidebar's groups and the band's own labels all
 * sat at slightly different sizes and slightly different rhythms. None of it was
 * deliberate and all of it was visible. Colour and padding still belong to each site;
 * the type does not.
 */
const EYEBROW = "text-[8.5px] uppercase tracking-[0.18em]";

/**
 * A chip on a BOARD ROW, which is a rung below the one on a card.
 *
 * A row is 26 pixels of vertical space carrying a title, faces, a squad, a sprint and
 * four numbers; a card chip at 10.5px in it pushes the row taller than the line it is
 * part of. There were three sizes and three radii in one row — a tag at 9.5px and
 * fully round, a squad at 10.5px and `rounded-lg`, a blocker at 8.5px and `rounded` —
 * which is what made a row of them look assembled rather than designed.
 */
const ROW_CHIP = "text-[9.5px] px-1.5 py-0.5 rounded-md whitespace-nowrap";

/**
 * A TAG, which is round on purpose.
 *
 * The one place a different shape earns itself: ClickUp draws tags as pills, everybody
 * who uses that board reads them as pills, and a tag is not a value of a field — it is
 * a label somebody stuck on. Same size and padding as a row chip; the radius is the
 * whole difference, and the fill was 7% in one place and 8% in another for no reason.
 */
/*
 * A tag on a row.
 *
 * Was 9.5px in a fully round pill with a flat wash behind it: at that size the
 * round ends eat the padding, two tags run together, and the whole group reads
 * as grey noise under the title. A hair larger, a softer corner and a hairline
 * of its own — the border is what separates two chips sitting side by side, and
 * it is what the wash alone could never do.
 */
const TAG_PILL = "text-[10px] px-1.5 py-0.5 rounded-md whitespace-nowrap leading-none";
const TAG_FILL = "color-mix(in srgb, var(--text) 6%, transparent)";
const TAG_EDGE = "1px solid color-mix(in srgb, var(--text) 13%, transparent)";
/** The id is a chip too, and a slightly cooler one, so the eye can still pick
 *  it out of a row of tags without it being a different KIND of thing. */
const ID_FILL = "color-mix(in srgb, var(--primary) 9%, transparent)";

/*
 * Two rules, and only two: `edge(10)` parts the SECTIONS of a card, `edge(14)` parts
 * the groups inside a menu. There were three, the third being an `edge(12)` in two
 * popovers that nobody chose — a hairline a shade darker than the identical one in the
 * menu beside it.
 */

/**
 * The four priorities, in ClickUp's own colours.
 *
 * Its flag is red for urgent, yellow for high, blue for normal and grey for
 * low, and that is a language somebody reads without looking at the word —
 * which is the entire point of a flag. This app painted high red as well, so
 * the two states that mean "drop what you are doing" and "do it this week"
 * were the same colour on the row, in the header and on the board.
 */
/* Moved to lib/priority.tsx so the board and the pull request panel can draw
   the same flag in the same colour — see the note there on why three surfaces
   had three different answers. */

function PriorityChip({ p }: { p: NonNullable<ProviderTask["priority"]> }) {
  const look = prioLook(p);
  return (
    <span className={`${ID_CHIP} tracking-[0.08em]`}
      style={{ color: look.c, background: `color-mix(in srgb, ${look.c} 15%, transparent)` }}>{look.label.toUpperCase()}</span>
  );
}

/**
 * The flag, as a control — ClickUp's own field, first class on the card.
 *
 * It was on the row and in the header and could not be changed from here, which
 * made the one field a ClickUp board is ordered by the one field this app could
 * only read. And a card whose list has no "Urgency" drop-down showed no
 * priority ANYWHERE on the card body: the header chip was the whole of it.
 *
 * "None" is offered like any other value. Most cards have no priority, and a
 * picker that can only raise the flag cannot put it back down.
 */
function PriorityPick({ t, writable, busy, onApply }: {
  t: ProviderTask; writable: boolean; busy: boolean;
  onApply: (key: string, p: Pending) => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => { setOpen(false); }, [t.id]);
  const look = prioLook(t.priority);
  const choose = (id: string, label: string) => {
    setOpen(false);
    onApply("priority", {
      done: id ? `Priority set to ${label}` : "Priority cleared",
      optimistic: { priority: (id || null) as ProviderTask["priority"] },
      go: (stamp) => api.clickupPriority(t.id, id || null, stamp),
    });
  };
  return (
    <div className="relative">
      <button onClick={() => writable && !busy && setOpen((o) => !o)}
        disabled={!writable || busy}
        title={busy ? "Moving the flag…" : writable ? "Set this card's priority" : undefined}
        className="text-left rounded flex items-center gap-1.5 px-1.5 py-0.5 -mx-1.5 hover:bg-white/5 disabled:cursor-default disabled:hover:bg-transparent"
        style={{ color: look.c }}>
        <Flag c={look.c} on={!!t.priority} />
        <span className="text-[11px]" style={{ color: t.priority ? look.c : "var(--text4)" }}>{look.label}</span>
        {busy
          ? <span className="agx-spin shrink-0" aria-label="Applying" style={{ width: 10, height: 10, borderWidth: 1.5, borderColor: "var(--text3)", borderTopColor: "transparent" }} />
          : writable ? <span className="shrink-0" style={{ color: "var(--text4)" }}>▾</span> : null}
      </button>
      {open && (
        <div className="absolute left-0 mt-1 rounded-lg shadow-2xl flex flex-col overflow-hidden"
          style={{ zIndex: 30, background: "var(--bg2)", border: edge(28), minWidth: 150 }}>
          {[...PRIOS, { id: "", label: "None", c: "var(--text4)" } as const]
            .filter((o) => o.id !== (t.priority ?? ""))
            .map((o) => (
              <button key={o.id || "none"} className="text-left px-2 py-1.5 flex items-center gap-2 hover:bg-white/5"
                onClick={() => choose(o.id, o.label)}>
                <Flag c={o.c} on={!!o.id} />
                <span className="text-[11px]" style={{ color: o.id ? o.c : "var(--text3)" }}>{o.label}</span>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

function ClickUpRow({ t, today, on, onPick, grid, showWho, showSquad, showSprint, showEst, blocked, onHand, onForget }: {
  t: ProviderTask; today: string; on: boolean; onPick: () => void;
  grid: string; showWho: boolean; showSquad: boolean; showSprint: boolean; showEst: boolean;
  /** Unfinished cards this one is waiting on. Empty means it can be started. */
  blocked: ProviderTask[];
  /** Hand this card over without opening it. Absent where there is no checkout
   *  to hand it to, and the item then does not appear. */
  onHand?: (t: ProviderTask) => void;
  /** Drop this card from Looked up. Only that section's rows get the column —
   *  the board proper has nothing to forget. */
  onForget?: () => void;
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
  const sq = showSquad ? swatch(t) : null;
  return (
    <div role="row" tabIndex={0} aria-current={on ? "true" : undefined} onClick={onPick}
      onKeyDown={(e) => { if (e.key === "Enter") onPick(); }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY }); }}
      className="agx-row w-full text-left pr-4 py-1.5 hover:bg-white/5 cursor-pointer items-center"
      style={{
        /* 8px of gap put a two-character number a hair from the next one, and
           with everything right-aligned the columns read as one ragged block.
           14 plus the hairlines below is what separates them; the numbers are
           centred in their own track rather than crowded against its edge. */
        display: "grid", gridTemplateColumns: grid, gap: 14, borderBottom: edge(6), position: "relative",
        /* Matches the heading above it. Without it the row squeezes while the
           heading scrolls, and the two stop lining up. */
        minWidth: TABLE_MIN_W,
        background: on ? "color-mix(in srgb, var(--primary) 13%, transparent)" : undefined,
        boxShadow: on ? "inset 2px 0 0 0 var(--primary)" : undefined,
      }}>
      {/* Held still while the columns to its right scroll under it — see
          `.agx-stick` for why its background has to be opaque. */}
      <div className="min-w-0 agx-stick">
        <div className="flex items-baseline gap-1.5 min-w-0">
          {/* Blocked first, because it changes whether the rest is worth
              reading. 28 of 30 cards on a real board have dependencies and none
              of them were shown; the ones that matter are the unfinished ones. */}
          {/* WHAT it waits on, not that it waits. On a real board 30 of 36
              cards are blocked, so the word alone is a label every row wears —
              which is a label nobody reads. The name of the thing in the way is
              different on every row and is the part you can act on. */}
          {!!blocked.length && (
            <span className={`${ROW_CHIP} tracking-[0.06em] shrink-0 tabular-nums`}
              title={`Waiting on ${blocked.map((b) => `${shortName(b.title, b.customId ?? b.id)} — ${b.title}`).join("\n")}`}
              style={{ color: "var(--error)", background: "color-mix(in srgb, var(--error) 14%, transparent)" }}>
              ⛔ {shortName(blocked[0]!.title, blocked[0]!.customId ?? blocked[0]!.id)}
              {blocked.length > 1 ? ` +${blocked.length - 1}` : ""}
            </span>
          )}
          {/* The flag, before the title, on every row.
              It used to be a word — HIGH — on the line below, and only for the
              two loud ones: "normal was on nine rows in ten, which is a column
              of noise pretending to be information". True of a WORD. A flag is
              not read, it is glanced at, and the colour is ClickUp's own
              language; drawn on every row it also keeps the titles on one left
              edge instead of ragged. A card with no priority gets the outline
              one, which is what its own picker shows for none. */}
          <span className="shrink-0" title={`Priority: ${prioLook(t.priority).label}`}>
            <Flag c={prioLook(t.priority).c} on={!!t.priority} />
          </span>
          <span className="truncate text-[12.5px] leading-snug" style={{ color: done ? "var(--text3)" : "var(--text)" }}
            title={t.title}>{t.title}</span>
        </div>
        {/*
            Which list this card is on, under its title.

            A board of everything assigned to you is a board of cards from eight
            different lists, and the row named none of them: "each of the
            cards can belong to one specific list". It is the card's
            home list, in the card's own words, small and quiet — it answers
            "which project is this" without competing with the title above it or
            the tags below.
          */}
        {t.list && (
          <div className="text-[10px] leading-tight truncate mt-0.5" style={{ color: "var(--text4)" }}
            title={t.alsoIn?.length ? `${t.list} · also in ${t.alsoIn.map((l) => l.name).join(", ")}` : t.list}>
            {t.list}
          </div>
        )}
        <div className="flex items-center gap-1 mt-1 flex-wrap">
          {/* The id wears the same shape as the tags rather than floating naked
              beside them — three kinds of small text on one line read as
              leftovers. Its own colour keeps it the id. */}
          {t.customId && (
            <span className={`${TAG_PILL} tabular-nums`}
              style={{ color: "var(--text3)", background: ID_FILL, border: TAG_EDGE }}>{t.customId}</span>
          )}
          {/* The word is gone: the flag at the title says it, and two marks for
              one fact on one row is the duplication this board keeps shedding. */}
          {!!t.subtasks && (
            <span className="text-[10px]" style={{ color: "var(--text4)" }} title={`${t.subtasks} subtasks`}>⌥{t.subtasks}</span>
          )}
          {t.tags.map((tag) => (
            <span key={tag} className={TAG_PILL}
              style={{ color: "var(--text3)", background: TAG_FILL, border: TAG_EDGE }}>{tag}</span>
          ))}
        </div>
      </div>
      {showWho && (
        <span className="flex items-center pl-1">
          {(t.people ?? []).slice(0, 3).map((p, n) => <Face key={n} p={p} n={n} />)}
          {(t.people?.length ?? 0) > 3 && (
            <span className="text-[8.5px] ml-1" style={{ color: "var(--text4)" }}>+{(t.people!.length) - 3}</span>
          )}
        </span>
      )}
      {/* The squad as the board paints it, at the size of a face.
          Colour is how a multi-squad board is read — ClickUp itself gives that
          field a solid block of it — and the word was one click deep, on the
          card. A dot the size of an avatar sits on the same optical line as the
          faces beside it, so the two columns read as one glance. The name and
          the value are both on hover, because a colour on its own is only
          learnable by someone who already knows the board. */}
      {showSquad && (
        <span className="flex items-center justify-center">
          {sq && (
            <span title={`${sq.name}: ${sq.value}`} aria-label={`${sq.name}: ${sq.value}`}
              style={{
                width: 18, height: 18, borderRadius: 999, background: sq.color,
                // The same ring the faces wear, so a pale option does not float
                // off a dark row and a dark one does not sink into it.
                boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--text) 22%, transparent)",
              }} />
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
      {/* 11px like every other number in the row. It was 10.5, which on a line of
          figures reads as a column somehow less certain than the ones beside it. */}
      {showEst && (
        <span className="text-[11px] tabular-nums text-center" style={{ color: "var(--text4)" }}
          title={t.estimateHours ? `${t.estimateHours}h estimated${t.spentHours ? `, ${t.spentHours}h logged` : ""}` : ""}>
          {t.estimateHours ? `${t.estimateHours}h` : ""}
        </span>
      )}
      <span className="text-[11px] tabular-nums text-center"
        style={{ color: "var(--text4)", borderLeft: edge(6), paddingLeft: 8, marginLeft: -8 }}>{t.points ?? ""}</span>
      <span className="text-right">
        {t.url && (
          <a href={t.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
            className={`agx-onrow ${ROW_CHIP} inline-block`}
            style={{ border: edge(16), color: "var(--text2)" }}>↗</a>
        )}
      </span>
      {/* Its own track, not a layer on top of the ↗ chip above: a row you can
          forget lives in the grid like every other cell, and only its opacity
          — never its position — answers the hover. */}
      {onForget && (
        <CloseButton onClick={(e) => { e.stopPropagation(); onForget(); }} title="Forget this one"
          className="agx-onrow justify-self-end"
          style={{ color: "var(--text3)", background: "var(--bg2)", border: edge(14) }} />
      )}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {t.customId && (
            <MenuItem onClick={() => copy(t.customId!, t.customId!)}>Copy {t.customId}</MenuItem>
          )}
          <MenuItem onClick={() => copy(t.id, "the ClickUp id")}>
            Copy {t.id} <span style={{ color: "var(--text4)" }}>· ClickUp&apos;s own</span>
          </MenuItem>
          {/* The link, not the id. Pasting a card into a message, a commit or a
              PR body wants the address somebody can click — and until now the
              only way to get it was to open the card in a browser and read it
              out of the bar. Next to the ids because it is the third thing this
              row can hand you, and above "Open" because copying is what you
              came to the menu for; opening has a ↗ on the row itself. */}
          {t.url && (
            <MenuItem onClick={() => copy(t.url, "the card link")}>Copy card URL</MenuItem>
          )}
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
        style={picked.length ? ON_CHIP : { border: edge(14), color: "var(--text2)" }}>
        {picked.length ? `${picked.length} selected` : "Status"}
        <span style={{ color: picked.length ? "var(--bg)" : "var(--text4)", opacity: picked.length ? 0.7 : 1 }}>▾</span>
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
            <div className={`px-2.5 pt-2 pb-1 ${EYEBROW}`}
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
/**
 * One thing you can do to a comment.
 *
 * They were four bare words in a row — Reply Edit Resolve Delete — under the
 * paragraph, which reads as a line of text somebody forgot to delete rather
 * than as controls: "no parecen ni botones". An icon, a label, a border and a
 * 24px hit area each; the destructive one keeps its own colour and is held
 * apart from the other three by a rule.
 */
function CommentAction({ label, title, d, onClick, busy, on, tone }: {
  label: string; title: string; d: string;
  onClick: () => void;
  busy?: boolean;
  /** Already in that state — Resolve on a resolved comment. */
  on?: boolean;
  tone?: string;
}) {
  const colour = on ? (tone ?? "var(--success, #98c379)") : tone && label === "Delete" ? tone : "var(--text3)";
  return (
    <button onClick={onClick} disabled={busy} title={title} aria-label={title} aria-pressed={on || undefined}
      className="agx-btn inline-flex items-center gap-1 rounded-md px-1.5 text-[10.5px]"
      style={{
        height: 24,
        color: colour,
        border: `1px solid color-mix(in srgb, ${on ? (tone ?? "var(--success, #98c379)") : "var(--text)"} ${on ? 40 : 14}%, transparent)`,
        background: on ? `color-mix(in srgb, ${tone ?? "var(--success, #98c379)"} 12%, transparent)` : "transparent",
      }}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d={d} />
      </svg>
      {label}
    </button>
  );
}

/**
 * One line of the GitHub panel: a label, a value, and a way to take it.
 *
 * ClickUp's own is a boxed field with a copy button on its right, and the value
 * is what you came for — so the whole row is the button. The label is above it
 * in small type, because a branch name is long and a label beside it would push
 * it off the row.
 */
function CopyRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1200);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      onClick={() => { void navigator.clipboard.writeText(value).then(() => setDone(true)).catch(() => setDone(false)); }}
      title={`Copy: ${value}`}
      className="agx-btn w-full text-left rounded-md px-2 py-1.5 flex items-start gap-2"
      style={{ border: edge(12), background: "color-mix(in srgb, var(--text) 3%, transparent)" }}>
      <span className="min-w-0 flex-1">
        <span className="block text-[9.5px] uppercase tracking-wider" style={{ color: "var(--text4)" }}>{label}</span>
        <span className={`block text-[11px] break-all ${mono ? "font-mono" : ""}`} style={{ color: "var(--text2)" }}>{value}</span>
      </span>
      <span className="shrink-0 text-[10px] mt-2" style={{ color: done ? "var(--success)" : "var(--text4)" }}>
        {done ? "Copied" : "⧉"}
      </span>
    </button>
  );
}

function CardField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      {/* A value that wraps to two lines needs normal leading and 6px under the
       *  label, or the second line reads as the next field's label. */}
      <div className={`${EYEBROW} mb-1.5 truncate`} style={{ color: "var(--text4)" }} title={label}>
        {label}
      </div>
      <div className="text-[11.5px] leading-normal break-words">{children}</div>
    </div>
  );
}

/**
 * A value on the card that can be typed over.
 *
 * Reads as text until it is clicked, which is the point: the card is READ far
 * more often than it is edited, and a column of input boxes turns a card into a
 * form. Enter saves, Escape puts it back, and leaving the box saves too —
 * because a value typed and then clicked away from is a value somebody meant.
 *
 * An empty box is a CLEAR, not a cancel. See cardEdits.ts: taking a due date
 * off is an edit people need, and a control that can only ever set one cannot.
 */
function EditText({ value, empty, title, width, busy, parse, onSave }: {
  value: string;
  /** What to draw when there is nothing — the invitation, not a dash. */
  empty: string;
  title: string;
  width?: number;
  busy: boolean;
  /** Refuse a value here rather than sending it and reporting ClickUp's 400. */
  parse: (raw: string) => { ok: boolean; error?: string };
  onSave: (raw: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [why, setWhy] = useState("");
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);
  useEffect(() => { if (editing) box.current?.select(); }, [editing]);

  const save = () => {
    const check = parse(draft);
    if (!check.ok) { setWhy(check.error ?? "that is not a value"); return; }
    setWhy("");
    setEditing(false);
    if (draft.trim() !== value.trim()) onSave(draft);
  };

  if (!editing) {
    return (
      <button className="agx-btn rounded text-left max-w-full truncate" title={busy ? "Saving…" : title}
        disabled={busy} onClick={() => setEditing(true)}
        style={{ color: value ? "var(--text2)" : "var(--text4)" }}>
        {busy
          ? <span className="agx-spin inline-block align-middle" aria-label="Saving" style={{ width: 10, height: 10, borderWidth: 1.5, borderColor: "var(--text3)", borderTopColor: "transparent" }} />
          : (value || empty)}
      </button>
    );
  }
  return (
    <span className="inline-flex flex-col gap-0.5">
      <input ref={box} value={draft} autoFocus
        onChange={(e) => { setDraft(e.target.value); setWhy(""); }}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); save(); }
          // Escape closes the box and nothing else: it must not reach the modal
          // behind it, which would close the whole card mid-edit.
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setDraft(value); setWhy(""); setEditing(false); }
        }}
        className="text-[11.5px] px-1.5 py-0.5 rounded outline-none"
        style={{ background: "var(--bg)", color: "var(--text)", border: edge(22), width: width ?? 90 }} />
      {why && <span className="text-[10px]" style={{ color: "var(--error)" }}>{why}</span>}
    </span>
  );
}

/** A date on the card, in the reader's own day. The button beside it is how a
 *  date comes OFF, which the picker itself has no way to say. */
function EditDay({ value, busy, title, onSave }: {
  value: number | null; busy: boolean; title: string; onSave: (ms: number | null) => void;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <input type="date" value={msToDay(value)} disabled={busy} title={title}
        onChange={(e) => onSave(dayToMs(e.target.value))}
        className="text-[11px] px-1.5 py-0.5 rounded outline-none"
        style={{ background: "transparent", color: "var(--text2)", border: edge(16), colorScheme: "dark" }} />
      {value != null && !busy && (
        <button className="agx-btn rounded text-[10px]" style={{ color: "var(--text4)" }}
          title="Clear this date" onClick={() => onSave(null)}>Clear</button>
      )}
      {busy && <span className="agx-spin" aria-label="Saving" style={{ width: 10, height: 10, borderWidth: 1.5, borderColor: "var(--text3)", borderTopColor: "transparent" }} />}
    </span>
  );
}

/**
 * The sprint, as a picker.
 *
 * A sprint is a LIST, so choosing one is a move — the card joins the new list
 * and leaves the old. The options are fetched when the menu OPENS, never with
 * the card: it is two calls against a rate budget shared with the board, and a
 * card changes sprint about once.
 */
function SprintPick({ t, busy, onApply }: {
  t: ProviderTask; busy: boolean;
  onApply: (p: Pending) => void;
}) {
  const [open, setOpen] = useState(false);
  const [lists, setLists] = useState<{ id: string; name: string }[] | null>(null);
  const [why, setWhy] = useState("");
  const [loading, setLoading] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  /* The list it is LEAVING. Without it the card ends up in the new sprint and
     the old one at the same time, which is how a board grows cards that are in
     two sprints and nobody knows which. */
  const currentSprint = (t.alsoIn ?? []).find((l) => /^\s*sprint\b/i.test(l.name));

  const openMenu = () => {
    setOpen((v) => !v);
    if (lists || loading) return;
    setLoading(true);
    void api.clickupSprints(t.id).then((r) => {
      setLists(r.ok ? sortSprints(r.lists ?? []) : []);
      setWhy(r.ok ? "" : (r.error ?? "could not read the sprints"));
    }).catch(() => setWhy("could not read the sprints")).finally(() => setLoading(false));
  };

  return (
    <div className="relative inline-block max-w-full" ref={box}>
      <button className="agx-btn inline-flex items-center gap-1 max-w-full rounded" disabled={busy}
        onClick={openMenu} title={busy ? "Moving…" : "Move this card to another sprint"}>
        <span className="truncate" style={{ color: t.sprint ? "var(--info)" : "var(--text4)" }}>{t.sprint ?? "None"}</span>
        {busy
          ? <span className="agx-spin shrink-0" aria-label="Moving" style={{ width: 10, height: 10, borderWidth: 1.5, borderColor: "var(--text3)", borderTopColor: "transparent" }} />
          : <span className="shrink-0 text-[9px]" style={{ color: "var(--text4)" }}>▾</span>}
      </button>
      {open && (
        <div className="agx-scroll absolute left-0 mt-1 rounded-lg shadow-2xl flex flex-col overflow-y-auto py-1"
          style={{ zIndex: 30, background: "var(--bg2)", border: edge(28), minWidth: 210, maxHeight: 300 }}>
          {loading && <div className="px-2.5 py-2 text-[10.5px]" style={{ color: "var(--text3)" }}>Reading the sprints…</div>}
          {!loading && why && <div className="px-2.5 py-2 text-[10.5px]" style={{ color: "var(--warning)" }}>{why}</div>}
          {(lists ?? []).map((l) => (
            <button key={l.id} className="text-left px-2.5 py-1.5 hover:bg-white/5 text-[11px] truncate"
              style={{ color: l.id === currentSprint?.id ? "var(--info)" : "var(--text2)" }}
              title={l.name}
              onClick={() => {
                setOpen(false);
                if (l.id === currentSprint?.id) return;
                onApply({
                  done: `Moved to ${sprintShort(l.name)}`,
                  optimistic: { sprint: sprintShort(l.name) },
                  go: () => api.clickupMove(t.id, l.id, currentSprint?.id),
                });
              }}>
              {sprintShort(l.name)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The card's tags, with the two things a tag needs: taking one off, and adding
 *  one. Both by NAME — ClickUp has no id for a tag. */
/*
 * ADDING ONE USED TO BE TYPING IT BLIND.
 *
 * "the ones already created don't show up for me to pick from properly… it just
 * opens an input". It did: an empty box, and whatever you typed became a tag. Two
 * things go wrong with that on a board somebody else set up — you cannot
 * remember the names, and a near miss (`bug intake` for `bug-intake`) makes a
 * second tag that looks like the first and filters like neither.
 *
 * So it offers what the board already uses and keeps the typing for the case
 * that has no answer yet: a name nobody has used, which is still one keystroke
 * away because ClickUp creates a tag by being told to put it on a card.
 *
 * The names come from the cards already loaded rather than from a call: the
 * board in front of you is exactly the set you are about to pick from, and it
 * is already in memory. A tag that exists in the space and is on no card is
 * the one case this does not offer — and typing it still works.
 */
function TagEdit({ t, busy, onApply, board }: {
  t: ProviderTask; busy: boolean;
  onApply: (key: string, p: Pending) => void;
  /** The board's cards, for the names it already uses. */
  board?: Map<string, ProviderTask>;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [hot, setHot] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!adding) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) { setAdding(false); setDraft(""); } };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [adding]);

  /** Every tag the board uses, minus the ones already on this card. */
  const known = useMemo(() => {
    const seen = new Set<string>();
    for (const c of board?.values() ?? []) for (const x of c.tags) seen.add(x);
    for (const x of t.tags) seen.delete(x);
    return [...seen].sort((a, b) => a.localeCompare(b));
  }, [board, t.tags]);

  const typed = draft.trim();
  const { rows, newAt, creating: canCreate } = useMemo(() => tagChoices(known, t.tags, typed), [known, t.tags, typed]);

  const add = (name: string) => {
    setDraft("");
    setHot(0);
    setAdding(false);
    const tag = name.trim();
    if (!tag || t.tags.includes(tag)) return;
    onApply(`tag:${tag}`, {
      done: `Tagged ${tag}`,
      optimistic: { tags: [...t.tags, tag] },
      go: () => api.clickupTag(t.id, tag, true),
    });
  };

  return (
    <span className="flex flex-wrap items-center gap-1">
      {t.tags.map((tag) => (
        <span key={tag} className="inline-flex items-center gap-1 text-[10.5px] px-1.5 py-0.5 rounded-md"
          style={{ color: "var(--text2)", background: "color-mix(in srgb, var(--text) 7%, transparent)", border: edge(14) }}>
          {tag}
          <button className="agx-btn rounded" title={`Remove ${tag}`} disabled={busy}
            style={{ color: "var(--text4)", lineHeight: 1 }}
            onClick={() => onApply(`tag:${tag}`, {
              done: `Removed ${tag}`,
              optimistic: { tags: t.tags.filter((x) => x !== tag) },
              go: () => api.clickupTag(t.id, tag, false),
            })}>×</button>
        </span>
      ))}
      <span className="relative inline-block" ref={box}>
        {adding
          ? <input value={draft} autoFocus placeholder={known.length ? "Filter or type a new one" : "tag"}
              onChange={(e) => { setDraft(e.target.value); setHot(0); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  /* What is highlighted, and the typed name when the list is
                     empty — Enter on a name nobody uses is the whole point. */
                  const pick = rows[hot] ?? (canCreate ? typed : "");
                  if (pick) add(pick);
                  return;
                }
                if (e.key === "ArrowDown") { e.preventDefault(); setHot((h) => Math.min(h + 1, Math.max(rows.length - 1, 0))); return; }
                if (e.key === "ArrowUp") { e.preventDefault(); setHot((h) => Math.max(h - 1, 0)); return; }
                /* Stopped, or Escape closes the card behind this list. */
                if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setDraft(""); setAdding(false); }
              }}
              className="text-[11px] px-1.5 py-0.5 rounded outline-none"
              style={{ background: "var(--bg)", color: "var(--text)", border: edge(22), width: 170 }} />
          : <button className="agx-btn rounded text-[10.5px]" style={{ color: "var(--text4)" }}
              title="Add a tag" disabled={busy} onClick={() => { setAdding(true); setHot(0); }}>+ tag</button>}
        {adding && (
          <div className="agx-scroll absolute left-0 mt-1 rounded-lg shadow-2xl flex flex-col overflow-y-auto py-1"
            style={{ zIndex: 30, background: "var(--bg2)", border: edge(28), minWidth: 190, maxHeight: 260 }}>
            {!rows.length && (
              <div className="px-2.5 py-2 text-[10.5px]" style={{ color: "var(--text3)" }}>
                {known.length ? "Nothing on this board is called that." : "This board has no tags yet — type one."}
              </div>
            )}
            {rows.map((name, i) => {
              const isNew = i === newAt;
              return (
                <button key={`${isNew ? "new:" : ""}${name}`} type="button"
                  onMouseEnter={() => setHot(i)}
                  /* mousedown, not click: the input's blur would close this
                     list before a click landed on it. */
                  onMouseDown={(e) => { e.preventDefault(); add(name); }}
                  className="text-left px-2.5 py-1.5 text-[11px] truncate flex items-center gap-1.5"
                  style={{ background: i === hot ? "color-mix(in srgb, var(--text) 8%, transparent)" : "transparent" }}>
                  {isNew && <span className="shrink-0 text-[10px]" style={{ color: "var(--info)" }}>+</span>}
                  <span className="truncate" style={{ color: isNew ? "var(--info)" : "var(--text2)" }}>{name}</span>
                  {isNew && <span className="shrink-0 text-[9.5px]" style={{ color: "var(--text4)" }}>new tag</span>}
                </button>
              );
            })}
          </div>
        )}
      </span>
    </span>
  );
}

function CardHop({ list, id, onGo }: { list: ProviderTask[]; id: string; onGo: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  useEffect(() => { setOpen(false); setQ(""); }, [id]);
  const hop = useMemo(() => neighbours(list, id), [list, id]);
  const shown = useMemo(() => list.filter((t) => hopMatches(t, q)), [list, q]);
  if (list.length < 2) return null;

  const arrow = "inline-flex items-center justify-center rounded shrink-0 disabled:opacity-30 disabled:cursor-default hover:bg-white/10 disabled:hover:bg-transparent";
  const box = { width: 20, height: 20, color: "var(--text3)" };

  return (
    <span className="flex items-center gap-1">
      <button className={arrow} style={box} disabled={!hop.prev}
        onClick={() => hop.prev && onGo(hop.prev.id)}
        title={hop.prev ? `Previous: ${hop.prev.title}` : "This is the first card on the board"}>‹</button>
      <button
        className="max-w-[280px] flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[10.5px] disabled:opacity-40 disabled:cursor-default hover:bg-white/10 disabled:hover:bg-transparent"
        style={{ border: edge(14), color: "var(--text2)" }}
        disabled={!hop.next}
        onClick={() => hop.next && onGo(hop.next.id)}
        title={hop.next ? `Next: ${hop.next.title}` : "This is the last card on the board"}>
        <span className="shrink-0" style={{ color: "var(--text4)" }}>next</span>
        <span className="truncate">{hop.next ? shortTitle(hop.next.title) : "—"}</span>
        <span aria-hidden className="shrink-0" style={{ color: "var(--text4)" }}>›</span>
      </button>
      <div className="relative">
        <button onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] tabular-nums hover:bg-white/10"
          style={{ border: edge(14), color: "var(--text3)" }}
          title="Open another card of this board, without closing this one">
          {/* A card looked up by id is not in the board's list, and saying
              "0 of 29" would be a lie about where you are rather than a count. */}
          {hop.i ? `${hop.i}/${hop.n}` : `${hop.n}`}
          <span aria-hidden style={{ color: "var(--text4)" }}>▾</span>
        </button>
        {open && (<>
          {/* Anywhere else closes the picker and nothing else: the modal's own
              backdrop is outside this dialog, so a click here must not reach it. */}
          <div className="fixed inset-0" style={{ zIndex: 40 }} onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-1 rounded-lg shadow-2xl flex flex-col overflow-hidden"
            style={{ zIndex: 41, background: "var(--bg2)", border: edge(28), width: 380, maxHeight: 360 }}>
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Filter by id or title"
              /* Escape closes the picker and stops there. Without this it reaches
                 the window listener that closes the modal, so cancelling a filter
                 threw away the card as well. */
              onKeyDown={(e) => {
                if (e.key === "Escape") { e.stopPropagation(); setOpen(false); }
                else if (e.key === "Enter" && shown[0]) { e.stopPropagation(); onGo(shown[0].id); }
              }}
              className="px-2.5 py-1.5 text-[11px] outline-none shrink-0"
              style={{ background: "transparent", color: "var(--text)", borderBottom: edge(16) }} />
            <div className="agx-scroll overflow-y-auto overflow-x-hidden">
              {shown.length === 0 && (
                <div className="px-2.5 py-2 text-[10.5px]" style={{ color: "var(--text4)" }}>Nothing on this board matches.</div>
              )}
              {shown.map((c) => (
                <button key={c.id} onClick={() => { setOpen(false); onGo(c.id); }}
                  className="text-left px-2.5 py-1.5 flex items-center gap-2 hover:bg-white/5"
                  style={c.id === id ? { background: "color-mix(in srgb, var(--primary) 12%, transparent)" } : undefined}>
                  <span className="text-[10px] tabular-nums shrink-0" style={{ color: "var(--primary)" }}>{c.customId || c.id}</span>
                  <span className="truncate text-[11px]" style={{ color: "var(--text2)" }}>{c.title}</span>
                </button>
              ))}
            </div>
          </div>
        </>)}
      </div>
    </span>
  );
}

function CardDetail({ t, today, statuses, fields, place, writable, repos, here, onOpenChatWith, onApply, saving, skills, onNote, onFresh, wide, byId, onGo, onOpenList, boardPeople, nav, onClose }: {
  t: ProviderTask; today: string;
  statuses: ListStatus[]; fields: ListField[];
  /** Space / Folder / List, for the card in hand. */
  place?: ListPlace;
  writable: boolean;
  repos: GitRepoRef[]; here: string;
  onOpenChatWith?: (cwd: string, prompt: string, title: string) => void;
  /**
   * Apply one field, now.
   *
   * `key` names the control that is saving (`status`, `who:12345`) so the spinner
   * lands on it and on nothing else — which is what lets somebody move a card and,
   * without waiting, take themselves off it and put two other people on.
   */
  onApply: (key: string, p: Pending) => void;
  /** Is that control saving? */
  saving: (key: string) => boolean;
  /** Show the list this card lives on. Absent when it is the board already on
   *  screen — see Breadcrumb. */
  onOpenList?: () => void;
  /** Only the skills that take a card — see lib/cardSkills.ts. */
  skills: SkillInfo[];
  onNote: (text: string) => void;
  /*
   * THE FRESH CARD, BACK ONTO THE BOARD'S ROW.
   *
   * "Refresh card" read the card again and only replaced the half this panel
   * owns — the description, the comments, the files. Status, tags, assignee,
   * sprint and points are the BOARD's copy of the card, so they went on
   * showing what the last board poll had read: pressing it appeared to do
   * nothing, and the change turned up a minute later when the board caught up.
   * Measured: the read itself takes about 750ms, so what was slow was never
   * the call.
   */
  onFresh?: (t: ProviderTask) => void;
  wide: boolean;
  /** The board's own cards, for resolving dependencies without a call each. */
  byId: Map<string, ProviderTask>;
  onGo: (id: string) => void;
  /** Everybody already on a card of the board being shown. They go to the top
   *  of the people picker, which is what ClickUp does with its own list. */
  boardPeople?: Set<number>;
  /** Moving to another card without leaving this one — the modal's, because
   *  the modal is what covers the table you would otherwise click. Drawn in the
   *  sticky band at the top, so it survives the scroll like the ids do. */
  nav?: React.ReactNode;
  /** Only in the modal, where the dimmed board and Escape were the whole way out. */
  onClose?: () => void;
}) {
  /* The app's own dialog rather than the browser's — see
     no-native-dialogs.test.ts. Two `window.confirm` calls lived here and the
     lint could not see either: its lookbehind skipped every receiver, `window`
     included. */
  const { ask, dialog } = useDialogs();
  const [full, setFull] = useState<(Partial<TaskDetail> & { ok?: boolean; error?: string }) | null>(null);

  /*
   * A FACE FOR A NAME A SENTENCE CARRIES.
   *
   * The "seen here" rows are notifications, and ClickUp writes them starting
   * with the person: "Irra assigned this task to: javi". The API says who
   * created a card and nothing else, so this is the only other place a name
   * appears on the timeline — and it should look like the creation row rather
   * than like a bullet with grey text.
   *
   * Built from everybody the board already knows, matched on the whole name
   * first and then on the first word, because a notification says "javi" where
   * the board says "Javier Ortega".
   */
  const faceByName = useCallback((name: string) => {
    const want = name.trim().toLowerCase();
    if (!want) return null;
    const people = [...byId.values()].flatMap((c) => c.people ?? []);
    return people.find((p) => p.name?.toLowerCase() === want)
      ?? people.find((p) => p.name?.toLowerCase().split(/\s+/)[0] === want)
      ?? null;
  }, [byId]);
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
  const whoBtn = useRef<HTMLButtonElement>(null);
  /* Measured when it opens, and clamped to the window on both axes: the card can be a
     narrow sidebar or a wide modal, and the same menu has to land on screen in both. */
  const [whoPos, setWhoPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  useLayoutEffect(() => {
    if (!whoOpen || !whoBtn.current) return;
    const r = whoBtn.current.getBoundingClientRect();
    const W = 260, H = 320, PAD = 8;
    setWhoPos({
      top: Math.max(PAD, Math.min(r.bottom + 6, window.innerHeight - H - PAD)),
      left: Math.max(PAD, Math.min(r.left, window.innerWidth - W - PAD)),
    });
  }, [whoOpen]);
  /** What is typed into the people filter. A real workspace answers with five
   *  hundred names; without this the picker is a scroll, not a choice. */
  const [whoQ, setWhoQ] = useState("");
  const [members, setMembers] = useState<ListMember[] | null>(null);
  const [membersBusy, setMembersBusy] = useState(false);
  /*
   * Who to show first: the people this board already runs on.
   *
   * `/list/{id}/member` answered with twenty names that included none of the
   * six ClickUp itself offers for these cards, so the picker now takes the
   * workspace too — and a workspace here is five hundred and twenty-seven
   * people. The ones already on the cards in front of you are the answer nine
   * times in ten, and they are the group ClickUp puts at the top of its own
   * picker.
   */
  const onBoard = useMemo(() => {
    const ids = new Set<number>();
    for (const p of t.people ?? []) if (p.id != null) ids.add(p.id);
    for (const id of boardPeople ?? []) ids.add(id);
    return ids;
  }, [t.people, boardPeople]);
  const shownMembers = useMemo(() => {
    const needle = whoQ.trim().toLowerCase();
    return (members ?? [])
      .filter((m) => m.name && (!needle || m.name.toLowerCase().includes(needle)))
      .sort((a, b) => {
        const ah = onBoard.has(a.id) ? 0 : 1, bh = onBoard.has(b.id) ? 0 : 1;
        if (ah !== bh) return ah - bh;
        if (a.me !== b.me) return a.me ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  }, [members, whoQ, onBoard]);
  /** The card this answer is for, so a click on the next card cannot be
   *  answered by the last card's request. */
  const asked = useRef<string | null>(null);
  /** The list's people, fetched once per card. Two things ask for them now —
   *  the assignee picker and the `@` in a comment — and neither should pay for
   *  the other's call or start a second one. */
  const loadMembers = useCallback(() => {
    if (members || membersBusy || !t.listId) return;
    const forCard = t.id;
    asked.current = forCard;
    setMembersBusy(true);
    api.clickupMembers(t.listId)
      .then((r) => { if (asked.current === forCard) setMembers(r.ok ? (r.members ?? []) : []); })
      .catch(() => { if (asked.current === forCard) setMembers([]); })
      .finally(() => { if (asked.current === forCard) setMembersBusy(false); });
  }, [members, membersBusy, t.listId, t.id]);

  const openWho = () => {
    setWhoOpen((o) => !o);
    if (whoOpen) return;
    loadMembers();
  };

  // A different card is a different question: forget the last card's people,
  // and disown any answer still on its way.
  useEffect(() => { setWhoOpen(false); setMembers(null); setMembersBusy(false); asked.current = null; }, [t.id]);
  const [askOpen, setAskOpen] = useState(false);
  /** Where a hand-off goes. Read once and kept, so the pills reflect it. */
  const [to, setTo] = useState<HandoffTo>(handoffTo);
  const [copied, setCopied] = useState<"human" | "raw" | "url" | "title" | null>(null);
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
  const [tab, setTab] = useState<"card" | "activity" | "files" | "github">("card");
  useEffect(() => { setTab("card"); }, [t.id]);
  const nComments = full?.comments?.length ?? 0;
  /*
   * One timeline: what people said, and what happened to it.
   *
   * The count on the tab stays COMMENTS — a card with four comments and thirty
   * status changes is a card with four comments, and that number is what a board is
   * scanned with. See cardActivity.ts.
   */
  const rows = useMemo(
    /* Named explicitly: with `?? []` on both sides the element type is inferred
       from an empty array as often as from the real one, and a comment row would
       arrive at the rendering knowing only its id and its timestamp. */
    () => activityRows<TaskDetail["comments"][number]>(full?.comments ?? [], full?.events ?? []),
    [full?.comments, full?.events],
  );
  /* Derived rather than corrected in state: a refresh that returns a card with
     nothing on it must not leave the pane showing a tab that is no longer there,
     with nothing under it. */
  const files = full?.attachments ?? [];
  /* A tab that is not there cannot be the one you are on. The card is always there;
     the other two appear when they have something in them. */
  const view = (tab === "activity" && !rows.length) || (tab === "files" && !files.length) ? "card" : tab;
  /** Which folded runs somebody has opened. Keyed by the run's first event, so a
   *  poll that adds a comment does not close what is open. */
  const [openRuns, setOpenRuns] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => { setOpenRuns(new Set()); }, [t.id]);
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

  /* Re-read the card after anything that changes the conversation. The board's
     own poll does not carry comments — they are fetched per card, on demand —
     so a comment posted here would otherwise not appear until the card was
     closed and opened again. */
  const reread = useCallback(() => {
    void api.clickupTask(t.id).then(setFull).catch(() => { /* the card stays as it was */ });
  }, [t.id]);

  /** Whether THIS card is being re-read, so its own button can say so without
   *  the board's Refresh claiming the work. */
  const [rereading, setRereading] = useState(false);

  /** What is typed into the card's own comment box, kept per card: switching
   *  card and coming back must not lose a half-written note. */
  const [say, setSay] = useState("");
  const [saying, setSaying] = useState(false);
  const [sayErr, setSayErr] = useState("");
  useEffect(() => { setSay(""); setSayErr(""); }, [t.id]);
  /** Which comment is being answered or edited, and with what. One at a time:
   *  two open boxes on the same thread is a way to post the wrong one. */
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [busyComment, setBusyComment] = useState<string | null>(null);
  /** Which comment's menu is open, and where it was opened from. */
  const [commentMenu, setCommentMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  /**
   * The card's own sticky band — the chips, the title and the tabs — and how
   * tall it is right now.
   *
   * Published as a CSS variable so every comment header below can stick
   * directly beneath it, which is where ClickUp puts it and the only place it
   * is any use: at `top: 0` a comment header sticks behind this band, opaque and
   * z-20, and disappears exactly as if it had never stuck at all.
   */
  const cardHead = useRef<HTMLDivElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const head = cardHead.current;
    const root = shell.current;
    if (!head || !root) return;
    const put = () => root.style.setProperty("--cu-head-h", `${Math.round(head.getBoundingClientRect().height)}px`);
    put();
    const ro = new ResizeObserver(put);
    ro.observe(head);
    return () => ro.disconnect();
  }, [t.id, view]);
  useEffect(() => setCommentMenu(null), [t.id]);

  const lab = { color: "var(--text4)", width: 62 };
  const val = "text-left rounded px-1.5 py-0.5 -mx-1.5 hover:bg-white/5 truncate max-w-full";
  const line = edge(16);

  /* The statuses that are worth offering: this list's own, minus the one it is
     already in. Never a text box — an invalid status is a 400, and a status
     from another list means something else entirely. */
  const options = statuses.filter((s) => s.status !== t.status);
  const statusSaving = saving("status");
  /* Where every custom field goes — the band, the body, or a row. One decision, in
     one tested place: see cardLayout.ts. */
  const shape = useMemo(
    () => layoutCard(t.custom ?? [], full?.description ?? "", t.priority),
    [t.custom, full?.description, t.priority],
  );
  const [fieldsOpen, setFieldsOpen] = useState(true);
  useEffect(() => { setFieldsOpen(true); }, [t.id]);
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
  const copyIt = async (v: string, which: "human" | "raw" | "url" | "title") => {
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
    <div ref={shell} className="flex flex-col min-h-full shrink-0">
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
      {/* …and it says how tall it is, in a variable the comment headers below
          read. That is the whole reason the first two attempts failed: a comment
          header sticky at `top: 0` sticks UNDER this block, which is opaque and
          z-20, so it was working and invisible. Measured rather than written
          down — this band holds chips, a title that wraps and a tab row, and its
          height changes with every one of them. */}
      <div ref={cardHead} className="sticky top-0 z-20 pb-1.5" style={{ background: "var(--bg)" }}>
        {/* The identity chips sit in the SAME band as the table's column titles
            beside them — one height, centred, rather than a top padding chosen
            to look about right. A padding is a guess that has to be re-guessed
            every time either side changes its type size; a shared band cannot
            drift because there is only one number. */}
        <div className="flex items-center gap-1.5 flex-wrap" style={{ minHeight: HEAD_H }}>
          <button onClick={() => void copyIt(t.customId || t.id, "human")} className={`${ID_CHIP} tabular-nums`}
            style={{ color: "var(--primary)", background: "color-mix(in srgb, var(--primary) 12%, transparent)" }}
            title={`Copy ${t.customId || t.id} — the id for a branch, a commit or a colleague`}>
            {copied === "human" ? "copied ✓" : (t.customId || t.id)}
          </button>
          {/* Only when there are genuinely two. A workspace without custom ids
              would otherwise get the same string twice. */}
          {t.customId && t.customId !== t.id && (
            <button onClick={() => void copyIt(t.id, "raw")} className={`${ID_CHIP} tabular-nums`}
              style={{ color: "var(--text4)", border: edge(16) }}
              title={`Copy ${t.id} — ClickUp's own id, the one its API and URLs take`}>
              {copied === "raw" ? "copied ✓" : t.id}
            </button>
          )}
          {t.priority && <PriorityChip p={t.priority} />}
          {t.mine && (
            <span className={`${ID_CHIP} tracking-[0.08em]`}
              style={{ color: "var(--success)", background: "color-mix(in srgb, var(--success) 15%, transparent)" }}>YOURS</span>
          )}
          {/* Pushed to the right of the same band rather than laid over the
              header: an overlay would sit on top of a title long enough to
              reach it, and this row already has the height and the opaque
              background the nav needs. */}
          {nav && <span className="ml-auto shrink-0">{nav}</span>}
          {/* The way out, with a target you can hit. Closing was a click on the
              dimmed board or the Escape key: one of them is invisible and the
              other is a keystroke nobody is told about, and neither is a thing
              on screen that says "this closes". Red because that is what it is,
              and its own box because a bare glyph is a 10px target. */}
          {onClose && (
            <button onClick={onClose} aria-label="Close the card"
              title="Close the card (Esc)"
              className={`shrink-0 grid place-items-center rounded-md text-[13px] leading-none ${nav ? "" : "ml-auto"}`}
              style={{ width: 26, height: 26, color: "var(--error)",
                background: "color-mix(in srgb, var(--error) 14%, transparent)",
                border: "1px solid color-mix(in srgb, var(--error) 34%, transparent)" }}>
              {/* The house's own glyph rather than a bare ✕ character: the lock
                  in icon-scale.test.ts exists because a text ✕ has no size of
                  its own and ends up a 10px target on somebody's screen. */}
              <CloseIcon size={ICON.sm} />
            </button>
          )}
        </div>
        <h2 className="text-[13px] font-semibold leading-snug mt-1.5" style={{ color: "var(--text)", textWrap: "balance" }}>
          {t.title}
          {/* The title is the other half of what you paste beside the id — a
              branch name, a commit subject, the line you send a colleague. The
              ids had a button each and the title had none, so the only way to
              take it was to select 60 characters of a balanced, wrapping
              heading by hand.

              Inside the <h2> and after the last word rather than in the chip
              row above: it belongs to this string, and an icon parked at the
              far right of a two-line heading points at whitespace. Being
              inline also means it follows the wrap instead of fighting it.

              20x20 around a 14px glyph. The glyph alone would be a target the
              height of a 13px line box, which is the mistake the icon ladder
              was written for; 20 is what fits inside a heading that sets its
              own line height. */}
          <button onClick={() => void copyIt(t.title, "title")}
            className="inline-flex items-center justify-center align-middle ml-1.5 rounded hover:bg-white/10"
            style={{ width: 20, height: 20, color: copied === "title" ? "var(--success)" : "var(--text4)" }}
            title="Copy the title"
            aria-label={copied === "title" ? "Title copied" : "Copy the title"}>
            {copied === "title" ? (
              <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M4 12.5l5.2 5.2L20 6.9" />
              </svg>
            ) : (
              <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
          </button>
        </h2>
        {/* Only when there is a second thing to switch to. One tab is not a tab,
            it is a label — and a card with no conversation should look exactly
            the way it always did. */}
        {(!!rows.length || !!files.length) && (
          <div className="flex items-center gap-1.5 mt-2.5" style={{ borderBottom: edge(12) }}>
            {([
              ["card", "Card"],
              ...(rows.length ? [["activity", nComments ? `Activity ${nComments}` : "Activity"] as const] : []),
              /* The count is free — it rides on the payload the card already fetched —
                 and nothing behind this tab is fetched until it is opened. See
                 CardFiles. */
              ...(files.length ? [["files", `Files ${files.length}`] as const] : []),
              /* GitHub: the pull requests that name this card, and the four
                 strings ClickUp's own panel hands you for starting the work.
                 Always there for a card with an id — the branch name is the
                 thing you want BEFORE there is a pull request to show. */
              ...(t.customId ? [["github", prs.length ? `GitHub ${prs.length}` : "GitHub"] as const] : []),
            ] as const).map(([id, label]) => (
              /* A tab that reads as a tab: its own box, a lit ground when it is the one
                 you are on, and room around the words. They were three uppercase runs a
                 few pixels apart under a hairline — legible, and not obviously pressable
                 or obviously three separate things. */
              <button key={id} onClick={() => setTab(id)}
                aria-current={view === id ? "page" : undefined}
                className="agx-btn text-[10px] uppercase tracking-[0.14em] px-2.5 py-1.5 -mb-px rounded-t-md"
                style={{
                  color: view === id ? "var(--text)" : "var(--text3)",
                  background: view === id ? "color-mix(in srgb, var(--primary) 12%, transparent)" : "transparent",
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
      <Breadcrumb place={place} className="mb-3" onList={onOpenList} />

      {/*
        * The band: what a triage pass reads, in the colours the workspace gave it.
        *
        * Status first, and it is the control rather than a copy of one — two Statuses
        * on a card is exactly the duplication this redesign is about. Then up to five
        * fields the workspace itself marked as read-at-a-glance: a coloured choice, a
        * date, a quantity. Which ones is decided in cardLayout.ts, not by a list of
        * names here, because a workspace calls its fields whatever it likes.
        */}
      <div className="mb-3 rounded-lg px-3 py-2.5 flex flex-wrap items-start"
        style={{ gap: "14px 20px", background: "color-mix(in srgb, var(--text) 4%, transparent)", border: edge(12) }}>
        <div className="flex flex-col gap-1 min-w-0">
          <span className={`${EYEBROW}`} style={{ color: "var(--text4)" }}>status</span>
          <div className="relative">
            <button onClick={() => writable && !statusSaving && setStatusOpen((o) => !o)}
              disabled={!writable || !options.length || statusSaving}
              title={statusSaving ? `Moving this card to ${t.status}…` : undefined}
              className="text-left rounded flex items-center gap-2 disabled:cursor-default">
              <StatusPill status={t.status} color={t.statusColor} />
              {statusSaving
                ? <span className="agx-spin shrink-0" aria-label="Applying" style={{ width: 10, height: 10, borderWidth: 1.5, borderColor: "var(--text3)", borderTopColor: "transparent" }} />
                : writable && options.length ? <span className="shrink-0" style={{ color: "var(--text4)" }}>▾</span> : null}
            </button>
            {statusOpen && (
              <div className="agx-scroll absolute left-0 mt-1 rounded-lg shadow-2xl flex flex-col overflow-y-auto"
                style={{ zIndex: 30, background: "var(--bg2)", border: edge(28), minWidth: 210, maxHeight: 300 }}>
                {options.map((o) => (
                  <button key={o.status} className="text-left px-2 py-1.5 hover:bg-white/5"
                    onClick={() => {
                      setStatusOpen(false);
                      onApply("status", {
                        done: `Moved to ${o.status}`,
                        optimistic: {
                          status: o.status, statusColor: o.color,
                          ...(o.type === "done" || o.type === "closed" ? { statusKind: "done" as const } : { statusKind: "open" as const }),
                        },
                        go: (stamp) => api.clickupStatus(t.id, o.status, stamp),
                      });
                    }}>
                    <StatusPill status={o.status} color={o.color} dim={o.type === "done" || o.type === "closed"} />
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        {/* The flag, beside the status — ClickUp's own two card-level fields, in
            the order ClickUp puts them. Drawn even when the card has no
            priority: "none" is the commonest value on a board, and a control
            that only appears once a value exists is a control you cannot use to
            set the first one. A list's own "Urgency" drop-down, where there is
            one, is no longer repeated in this band — see cardLayout.ts. */}
        <div className="flex flex-col gap-1 min-w-0">
          <span className={`${EYEBROW}`} style={{ color: "var(--text4)" }}>priority</span>
          <PriorityPick t={t} writable={writable} busy={saving("priority")} onApply={onApply} />
        </div>
        {shape.band.map((c) => (
          /*
           * Capped at 210, and the value STRETCHES to that cap rather than
           * sizing to its own content.
           *
           * It used to be `alignSelf: "flex-start"` — the value only as wide
           * as itself — so a long one ("Checkout, Dashboard,
           * Notifications") was measured at its full, untruncated width before
           * the flex algorithm ever saw the 210px cap: percentage max-width
           * is ignored for that intrinsic-size pass, so `max-w-full` inside
           * FieldValue had nothing definite to clip against and the chip
           * painted over the field beside it. Stretching gives the wrapper a
           * DEFINITE 210px, which is what `max-w-full` needs to actually
           * cap the value and let `truncate` engage. A short value ("Yes",
           * "Crimson") looks identical either way — the wrapper is invisible.
           */
          <div key={c.id} className="flex flex-col gap-1 min-w-0" style={{ maxWidth: 210 }}>
            <span className={`${EYEBROW} truncate`} style={{ color: "var(--text4)" }}
              title={c.name}>{fieldLabel(c.name)}</span>
            <span className="min-w-0"><FieldValue f={c} /></span>
          </div>
        ))}
      </div>

      {/* Two columns of label-above-value rather than one of label|value. In a
          380px pane the second shape leaves the value about ninety pixels, which
          is where "ready for engineering" became "to…". */}
      <div className="mb-3" style={{ display: "grid", gridTemplateColumns: wide ? "repeat(3, minmax(0,1fr))" : "1fr 1fr", gap: "12px 12px" }}>
        {/* Status is in the band above, as the control. It was here as well, which is
            the same field twice on one card — the thing this layout is for. */}
        <CardField label="Assigned">
          {/* A picker, not a toggle.
              This was "put yourself on / take yourself off" with a caret beside
              it that opened nothing — the API only ever knew one person's id,
              your own, so the caret was a promise the control could not keep.
              Now it lists the people on the card's own list and each one is a
              switch: ClickUp holds several assignees, so adding somebody must
              not quietly take off whoever else was on it. */}
          <div className="relative">
            <button ref={whoBtn} disabled={!writable} onClick={() => writable && openWho()}
              className="w-full text-left rounded px-1 -mx-1 py-0.5 hover:bg-white/5 text-[11.5px] leading-tight flex items-center gap-1.5"
              style={{ color: t.mine ? "var(--success)" : "var(--text2)" }}>
              {!!t.people?.length && (
                <span className="inline-flex items-center shrink-0 pl-1">
                  {t.people.slice(0, 4).map((p, n) => <Face key={n} p={p} n={n} />)}
                </span>
              )}
              <span className="min-w-0 truncate">{t.mine ? "you" : (t.assignees.join(", ") || "nobody")}</span>
              {writable && <span className="ml-auto shrink-0" style={{ color: "var(--text4)" }}>▾</span>}
            </button>
            {whoOpen && (
              /* The app's one people picker — see components/PeoplePick. It
                 grew here (527 names, a filter box, a Portal and a clamp) and
                 then a second, worse one appeared beside the pull request; this
                 is the same component in both places now. The optimistic write
                 stays here, where the card it is guessing about lives. */
              <PeoplePick
                anchor={whoBtn}
                members={shownMembers}
                busy={membersBusy}
                isOn={(m) => (t.people ?? []).some((p) => p.id === m.id)}
                isSaving={(m) => saving(`who:${m.id}`)}
                dividerBefore={(m, prev) => onBoard.has(m.id) !== onBoard.has(prev.id)}
                onClose={() => setWhoOpen(false)}
                face={(m) => <Face p={{ name: m.name, initials: m.initials, color: m.color, avatar: m.avatar, me: m.me }} n={0} />}
                onPick={(m) => {
                  const on = (t.people ?? []).some((p) => p.id === m.id);
                  onApply(`who:${m.id}`, {
                    done: on ? `${m.me ? "You are" : m.name + " is"} off it` : `${m.me ? "You are" : m.name + " is"} on it`,
                    /* The face appears or goes on the press. `mine` with it, or
                       the card would still say "you" after you have taken
                       yourself off — that word is what the row is read by. */
                    optimistic: on
                      ? {
                          people: (t.people ?? []).filter((p) => p.id !== m.id),
                          assignees: t.assignees.filter((a) => a !== m.name),
                          ...(m.me ? { mine: false } : null),
                        }
                      : {
                          people: [...(t.people ?? []), { id: m.id, name: m.name, initials: m.initials, color: m.color, avatar: m.avatar, me: m.me }],
                          assignees: [...t.assignees, m.name],
                          ...(m.me ? { mine: true } : null),
                        },
                    go: (stamp) => api.clickupAssign(t.id, !on, stamp, m.id),
                  });
                }}
              />
            )}
          </div>
        </CardField>

        {/*
            Sprint, points, dates and the estimate are EDITABLE now, and they are
            drawn whether or not the card has them: a field that only appears
            once it has a value is a field you cannot set. Read-only when writing
            is off, which is the same rule as the status pill.
          */}
        {(writable || t.sprint) && (
          <CardField label="Sprint">
            {writable
              ? <SprintPick t={t} busy={saving("sprint")} onApply={(p) => onApply("sprint", p)} />
              : <span style={{ color: "var(--info)" }}>{t.sprint}</span>}
          </CardField>
        )}
        {(writable || t.points != null) && (
          <CardField label="Points">
            {writable
              ? <EditText value={t.points == null ? "" : String(t.points)} empty="Set" title="Sprint points" width={64}
                  busy={saving("points")} parse={parsePoints}
                  onSave={(raw) => {
                    const got = parsePoints(raw);
                    if (!got.ok) return;
                    onApply("points", {
                      done: got.value == null ? "Points cleared" : `Points → ${got.value}`,
                      optimistic: { points: got.value ?? null },
                      go: (stamp) => api.clickupEdit(t.id, { points: got.value ?? null }, stamp),
                    });
                  }} />
              : <span className="tabular-nums" style={{ color: "var(--text2)" }}>{t.points}</span>}
          </CardField>
        )}
        {(writable || t.due) && (
          <CardField label="Due">
            {writable
              /* The card carries the day as `YYYY-MM-DD` in the reader's own
                 calendar, and ClickUp wants milliseconds — see cardEdits.ts for
                 why the moment is noon rather than midnight. */
              ? <EditDay value={dayToMs(t.due ?? "")} busy={saving("due")} title="Due date"
                  onSave={(ms) => onApply("due", {
                    done: ms == null ? "Due date cleared" : `Due ${msToDay(ms)}`,
                    optimistic: { due: ms == null ? null : msToDay(ms) },
                    go: (stamp) => api.clickupEdit(t.id, { due: ms }, stamp),
                  })} />
              : <span style={{ color: t.due! < today ? "var(--error)" : t.due === today ? "var(--warning)" : "var(--text2)" }}>
                  {dueLabel(t.due!, today)}
                </span>}
          </CardField>
        )}
        {(writable || t.estimateHours != null) && (
          <CardField label="Estimate">
            {writable
              ? <span className="inline-flex items-center gap-1.5">
                  <EditText value={estimateText(t.estimateHours == null ? null : Math.round(t.estimateHours * 3_600_000))}
                    empty="Set" title="Time estimate — 4h, 1h 30m" width={80}
                    busy={saving("estimate")} parse={parseEstimate}
                    onSave={(raw) => {
                      const got = parseEstimate(raw);
                      if (!got.ok) return;
                      onApply("estimate", {
                        done: got.value == null ? "Estimate cleared" : `Estimate → ${estimateText(got.value)}`,
                        optimistic: { estimateHours: got.value == null ? undefined : got.value / 3_600_000 },
                        go: (stamp) => api.clickupEdit(t.id, { estimate: got.value }, stamp),
                      });
                    }} />
                  {t.spentHours ? <span className="tabular-nums text-[10.5px]" style={{ color: "var(--text4)" }}>{t.spentHours}h logged</span> : null}
                </span>
              : <span className="tabular-nums" style={{ color: "var(--text2)" }}>
                  {t.estimateHours}h{t.spentHours ? ` · ${t.spentHours}h logged` : ""}
                </span>}
          </CardField>
        )}
        {(writable || t.start) && (
          <CardField label="Starts">
            {writable
              ? <EditDay value={dayToMs(t.start ?? "")} busy={saving("start")} title="Start date"
                  onSave={(ms) => onApply("start", {
                    done: ms == null ? "Start date cleared" : `Starts ${msToDay(ms)}`,
                    optimistic: { start: ms == null ? null : msToDay(ms) },
                    go: (stamp) => api.clickupEdit(t.id, { start: ms }, stamp),
                  })} />
              : <span style={{ color: "var(--text2)" }}>{dueLabel(t.start!, today)}</span>}
          </CardField>
        )}
        {t.list && (
          /*
             Every list this card is in, not only the one it was filed under.
             ClickUp lets a card live in several, and on a team that uses it the
             home list is routinely not the one you are looking at — the card
             said "Bugs" while you were reading it on a squad's board, which is
             true and useless. The home first, in the brighter colour, and the
             others after it.
           */
          <CardField label={t.alsoIn?.length ? "Lists" : "List"}>
            <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
              <span style={{ color: "var(--text2)" }}>{t.list}</span>
              {(t.alsoIn ?? []).map((l) => (
                <span key={l.id} className="flex items-center gap-1.5" style={{ color: "var(--text3)" }}>
                  <span aria-hidden style={{ color: "var(--text4)" }}>·</span>
                  {l.name}
                </span>
              ))}
            </span>
          </CardField>
        )}
        {t.updated ? (
          <CardField label="Last moved">
            <span style={{ color: "var(--text3)" }} title={new Date(t.updated).toLocaleString()}>{fmtAgo(t.updated)}</span>
          </CardField>
        ) : null}
      </div>

      {/* Tags on their own full-width line. They were competing with a value
          column and losing, and they are how this board gets navigated. */}
      {(writable || !!t.tags.length) && (
        <div className="flex items-center gap-1.5 flex-wrap mb-3">
          {writable
            ? <TagEdit t={t} busy={saving("tags")} onApply={onApply} board={byId} />
            : t.tags.map((x) => (
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
              <div className={`${EYEBROW} mb-1.5`} style={{ color: waitsOpen.length ? "var(--error)" : "var(--text4)" }}>
                {waitsOpen.length ? `Blocked by ${waitsOpen.length}` : "Was waiting on"}
              </div>
              {waits.map((d) => <DepRow key={d.id} d={d} onGo={onGo} />)}
            </>
          )}
          {!!blocksThese.length && (
            <>
              <div className={`${EYEBROW} mt-2 mb-1.5`} style={{ color: "var(--text4)" }}>
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
      {/* No heading of ours: these cards open with their own "Description"
          heading, and stacking a label above it read as a stutter. */}
      {full?.description ? (
        <div className="mb-3 pt-2.5 agx-cu-body" style={{ borderTop: edge(10) }}>
          <Markdown text={full.description} />
        </div>
      ) : null}

      {/*
        * The long fields, drawn ONCE.
        *
        * A bug form writes "Steps to reproduce" into a custom field and into the
        * description, word for word, and the card used to draw both — one of them
        * squeezed into a 150px column. What the description already says is counted
        * and not repeated; what it does not say is a section here, in the body, where
        * a paragraph belongs. See cardLayout.ts for how the two are told apart.
        */}
      {!!shape.long.length && (
        <div className="mb-3 pt-2.5 flex flex-col gap-3" style={{ borderTop: edge(10) }}>
          {shape.long.map((c) => (
            <div key={c.id} className="flex flex-col gap-1">
              <span className={`${EYEBROW}`} style={{ color: "var(--text4)" }}>{fieldLabel(c.name)}</span>
              <div className="agx-cu-body" style={{ color: "var(--text2)" }}><Markdown text={c.value} /></div>
            </div>
          ))}
        </div>
      )}
      {!!shape.echoed.length && (
        <div className="mb-3 text-[10px]" style={{ color: "var(--text4)" }}
          title={shape.echoed.map((c) => c.name).join("\n")}>
          {shape.echoed.length} field{shape.echoed.length === 1 ? "" : "s"} say the same as the description and {shape.echoed.length === 1 ? "is" : "are"} not repeated.
        </div>
      )}

      {/*
        * Fields: the record, one row each, in the workspace's own order.
        *
        * A row rather than a column, because a value here is a name, a date or an
        * address — none of which fit a 150px cell — and because this is the shape
        * somebody who uses the website already knows how to read. Open by default, as
        * it is there; folded away in one press when a card has thirteen of them and
        * you came for the conversation.
        */}
      {!!shape.rows.length && (
        <div className="mb-3 pt-2.5" style={{ borderTop: edge(10) }}>
          <button onClick={() => setFieldsOpen((v) => !v)}
            className={`agx-btn w-full text-left flex items-center gap-2 ${EYEBROW} pb-1.5`}
            style={{ color: "var(--text4)" }}>
            <span aria-hidden style={{ display: "inline-block", transform: fieldsOpen ? "none" : "rotate(-90deg)" }}>▾</span>
            Fields <span style={{ color: "var(--text3)" }}>{shape.rows.length}</span>
          </button>
          {fieldsOpen && (
            <div className="flex flex-col">
              {shape.rows.map((c) => {
                /* What the LIST says about this field, which the card's own copy of the
                   value cannot know: the options it accepts, and whether somebody has
                   marked it off-limits by name — "(DO NOT EDIT!!!)" is a real field on
                   a real board, and a tool that ignores that breaks a convention its
                   reader relies on. */
                const spec = fields.find((f) => f.id === c.id);
                const canPick = writable && !spec?.readOnly && !!spec?.options?.length;
                /* A date is the other kind you can set from here, and it needs
                   no list of options: it needs a calendar. Same guard as a
                   drop-down — writing switched on, and not a field somebody has
                   marked off-limits by its own name. */
                const canDate = writable && !spec?.readOnly && spec?.type === "date";
                return (
                  <div key={c.id} className="grid gap-3 py-1.5 items-baseline"
                    style={{ gridTemplateColumns: wide ? "200px 1fr" : "minmax(110px, 42%) 1fr", borderBottom: edge(8) }}>
                    <span className="text-[10.5px] min-w-0 truncate flex items-center gap-1" style={{ color: "var(--text4)" }} title={spec?.readOnly ? `${c.name} — marked read-only by its own name` : c.name}>
                      <span className="truncate">{fieldLabel(c.name)}</span>
                      {spec?.readOnly && <span aria-hidden title="Marked read-only by its own name">🔒</span>}
                    </span>
                    <span className="min-w-0">
                      {canPick
                        ? <FieldPick t={t} f={c} spec={spec!} busy={saving(`field:${c.id}`)}
                            onApply={(p) => onApply(`field:${c.id}`, p)} />
                        : canDate
                          ? <FieldDate t={t} f={c} busy={saving(`field:${c.id}`)}
                              onApply={(p) => onApply(`field:${c.id}`, p)} />
                          : <FieldValue f={c} />}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {!!full?.subtasks?.length && (
        <div className="mb-3 pt-2.5" style={{ borderTop: edge(10) }}>
          <div className={`${EYEBROW} mb-1.5`} style={{ color: "var(--text4)" }}>
            Subtasks {full.subtasks.length}
          </div>
          {full.subtasks.map((s) => (
            <div key={s.id} className="flex items-center gap-2 py-1 text-[11px]">
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
          <div className={`${EYEBROW} mb-1.5`} style={{ color: "var(--text4)" }}>{cl.name}</div>
          {cl.items.map((it, j) => (
            <div key={j} className="flex items-center gap-2 py-1 text-[11px]">
              <span style={{ color: it.done ? "var(--success)" : "var(--text4)" }}>{it.done ? "☑" : "☐"}</span>
              <span style={{ color: it.done ? "var(--text4)" : "var(--text2)", textDecoration: it.done ? "line-through" : undefined }}>{it.name}</span>
            </div>
          ))}
        </div>
      ))}
      </>)}

      {view === "files" && <CardFiles files={files} />}

      {view === "github" && (<>
        {/*
          * What ClickUp's own GitHub panel gives you, and the pull requests it
          * would list.
          *
          * The four strings are copied to the letter rather than improved on:
          * the FORM is the contract. The id inside the branch name is what
          * ClickUp looks for later and what this app's own search looks for, so
          * a branch named any other way stops being found by either side — see
          * cardBranch.ts.
          */}
        <div className="mb-3 rounded-lg overflow-hidden" style={{ border: edge(14) }}>
          <div className="px-3 py-2 text-[11px]" style={{ background: "color-mix(in srgb, var(--text) 4%, transparent)", borderBottom: edge(10), color: "var(--text2)" }}>
            Quick start
            <div className="text-[10px] mt-0.5" style={{ color: "var(--text4)" }}>
              Put the card id in a branch, a commit or a pull request title and both sides link it by themselves.
            </div>
          </div>
          <div className="p-2 flex flex-col gap-1.5">
            <CopyRow label="Task ID" value={t.customId || t.id} />
            <CopyRow label="Branch name" value={branchName(t.customId || t.id, t.title)} />
            <CopyRow label="Create & checkout a new branch" value={checkoutCommand(t.customId || t.id, t.title)} mono />
            <CopyRow label="Link a single commit" value={commitCommand(t.customId || t.id, t.title)} mono />
            {/* Ours, and the one this app is actually for: a worktree beside the
                checkout rather than a branch on top of whatever you had out. */}
            {here && <CopyRow label="…or a worktree beside this checkout" value={worktreeCommand(here, t.customId || t.id, t.title)} mono />}
          </div>
        </div>
      {(!!prs.length || prsErr) && (
        <div className="mb-3 pt-2.5" style={{ borderTop: edge(10) }}>
          <div className={`${EYEBROW} mb-1.5 flex items-center gap-2`} style={{ color: "var(--text4)" }}>
            Pull requests {!!prs.length && <span>{prs.length}</span>}
            {prsErr && (
              <span style={{ color: "var(--warning)" }}>
                {prs.length ? "· search failed, showing what the card states" : "· could not search GitHub — this is not “none”"}
              </span>
            )}
          </div>
          {prs.map((p) => (
            <div key={p.number} className="flex items-center gap-2 py-1">
              <button onClick={() => {
                const ref = prRefFromUrl(p.url);
                if (ref) openPr(ref.repo, p.number);
                else openPrs(String(p.number), p.state === "OPEN" || !p.state ? "open" : "all");
              }}
                className="text-left flex-1 min-w-0 rounded px-1 -mx-1 hover:bg-white/5"
                title="Open this pull request">
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

        {!prs.length && !prsErr && (
          <div className="text-[11px] px-1 pb-2" style={{ color: "var(--text4)" }}>
            No pull request names this card yet.
          </div>
        )}
      </>)}

      {view === "activity" && (<>
      {/* No heading and no rule of its own any more: the tab above already says
          "Activity 4", and repeating it under a divider read as a second section
          inside a pane that holds exactly one. Only the ordering survives,
          because a thread read in the wrong direction is a thread nobody can
          follow and there is nothing else on screen left to say it. */}
      {!!rows.length && (
        <div className="mb-3 pt-2">
          <div className={`${EYEBROW} mb-1.5`} style={{ color: "var(--text4)" }}>
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
          {rows.map((row) => {
            /* What happened to the card, in the place it happened. A run of these
               with nothing said between them is one row — folded past three, or a
               bug card opens with fifteen of them in front of the first sentence a
               person wrote. See cardActivity.ts. */
            if (row.kind === "events") {
              return (
                <EventRun key={row.id} events={row.events} open={openRuns.has(row.id)}
                  faceFor={faceByName}
                  onToggle={() => setOpenRuns((set) => {
                    const next = new Set(set);
                    if (next.has(row.id)) next.delete(row.id); else next.add(row.id);
                    return next;
                  })} />
              );
            }
            const c = row.comment;
            return (
            /* Room to breathe. These were mb-1.5/px-2.5/py-2 — a stack of
               paragraphs a millimetre apart, where the gap BETWEEN two comments
               was smaller than the gap between two lines inside one, so the
               eye had nothing to cut on and the column read as one block. */
            <div key={c.id} className="mb-3 rounded-lg px-3.5 py-3"
              style={{ background: "color-mix(in srgb, var(--bg3) 30%, transparent)", border: edge(10) }}>
              {/*
                * Who wrote it, kept under the card's own band for as long as
                * what they wrote — ClickUp's behaviour, and the reason it took
                * three tries here: `sticky top-0` DOES stick in this pane, it
                * just sticks behind the title-and-tabs block, which is opaque
                * and z-20. So it sticks below it instead, at the height that
                * block reports, and one rung under it.
                *
                * Opaque ground, or two screens of code slide under the name and
                * neither is readable. The negative margins take it to the
                * card's edges so nothing shows through at the sides.
                */}
              <div className="sticky z-[5] -mx-3.5 -mt-3 px-3.5 pt-3 pb-2 mb-2 flex items-center gap-2 flex-wrap rounded-t-lg"
                style={{ top: "var(--cu-head-h, 0px)", background: "color-mix(in srgb, var(--bg3) 30%, var(--bg))" }}>
                {/* The face beside the name, which is how the same comment reads
                    in ClickUp itself — "I miss seeing who made those changes,
                    with avatar and name if possible". The API carries it for a
                    comment's author; for a status change it carries nobody. */}
                <Face n={0} p={{ name: c.who || "—", initials: c.initials ?? "", color: c.color, avatar: c.avatar }} />
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
                {/* Everything else you can do to a comment, out of the way.
                    Four buttons under every paragraph is a control panel; the
                    ones that are one press from ruining something stay below,
                    and the quiet ones live here. */}
                {/* A box, not a glyph. Three dots 24px wide with no ground are
                    a target you aim at rather than press — "it is NOT centred and
                    it is hard to click". Same size and the same hover as the
                    bench's controls: 28×26, bordered, and the dots centred in
                    it by the flexbox rather than by their own baseline. */}
                <button
                  onClick={(e) => setCommentMenu({ id: c.id, x: e.clientX, y: e.clientY })}
                  title="More for this comment"
                  aria-label="More for this comment"
                  className="agx-bench-hit ml-auto shrink-0 rounded-md text-[14px] leading-none flex items-center justify-center"
                  style={{ width: 28, height: 26, color: "var(--text3)", border: edge(16) }}>…</button>
              </div>
              {/* Through the markdown renderer, like the description: these
                  carry code spans and tables, and printing them raw is what
                  made the one comment worth reading unreadable. */}
              {/* Same body treatment as the description: a comment on these
                  cards is a paragraph of prose with symbol names through it,
                  and it is read for exactly the same reasons. Slightly tighter,
                  because it sits inside a card of its own. */}
              {editing === c.id
                ? <Composer value={noteDraft} onChange={setNoteDraft} busy={busyComment === c.id} autoFocus
                    placeholder="Edit this comment" sendLabel="Save"
                    people={members} onNeedPeople={loadMembers}
                    onCancel={() => { setEditing(null); setNoteDraft(""); }}
                    onSend={() => {
                      setBusyComment(c.id);
                      void api.clickupCommentEdit(c.id, noteDraft).then((r) => {
                        if (r.ok) { setEditing(null); setNoteDraft(""); reread(); }
                        else onNote(r.error ?? "ClickUp refused the edit");
                      }).finally(() => setBusyComment(null));
                    }} />
                : <div className="agx-cu-body agx-cu-note" style={{ color: "var(--text2)" }}><Markdown text={c.text} /></div>}

              {/* What you can do to a comment, and only what ClickUp will
                  actually allow: it refuses an edit or a delete on somebody
                  else's, so those two are drawn for your own only. Quiet until
                  the comment is hovered — a row of four buttons under every
                  paragraph turns a conversation into a control panel. */}
              {writable && editing !== c.id && (
                <div className="agx-hover-show flex items-center gap-1 mt-2">
                  {/* Controls, not a sentence.
                      These were four words in a row under the paragraph and read
                      as text somebody forgot to delete — "no parecen ni botones".
                      An icon, a label, a border and a 24px hit area each, with
                      the destructive one held apart from the other three. */}
                  <CommentAction label="Reply" title="Answer in this thread"
                    d="M9 14l-5-5 5-5M4 9h9a7 7 0 0 1 7 7v4"
                    onClick={() => { setReplyTo(replyTo === c.id ? null : c.id); setNoteDraft(""); }} />
                  {c.mine && (
                    <CommentAction label="Edit" title="Edit this comment"
                      d="M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16v4z"
                      onClick={() => { setEditing(c.id); setNoteDraft(c.text); setReplyTo(null); }} />
                  )}
                  <CommentAction label={c.resolved ? "Resolved" : "Resolve"}
                    title={c.resolved ? "Mark it unresolved" : "Mark it resolved"}
                    d="M4 12l5 5L20 6" on={!!c.resolved} tone="var(--success, #98c379)"
                    busy={busyComment === c.id}
                    onClick={() => {
                      setBusyComment(c.id);
                      void api.clickupCommentResolve(c.id, !c.resolved).then((r) => {
                        if (r.ok) reread(); else onNote(r.error ?? "ClickUp refused that");
                      }).finally(() => setBusyComment(null));
                    }} />
                  {c.mine && (
                    <>
                      <span aria-hidden className="mx-0.5" style={{ width: 1, height: 16, background: "color-mix(in srgb, var(--text) 12%, transparent)" }} />
                      <CommentAction label="Delete" title="Delete this comment" tone="var(--error)"
                        d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v6M14 11v6"
                        busy={busyComment === c.id}
                        onClick={async () => {
                          /* Asked once. This one is not undoable and it is a
                             press away from Resolve. */
                          if (!(await ask({
                            title: "Delete this comment?",
                            body: "It cannot be undone.",
                            confirmLabel: "Delete",
                            danger: true,
                          }))) return;
                          setBusyComment(c.id);
                          void api.clickupCommentDelete(c.id).then((r) => {
                            if (r.ok) reread(); else onNote(r.error ?? "ClickUp refused the delete");
                          }).finally(() => setBusyComment(null));
                        }} />
                    </>
                  )}
                </div>
              )}

              {replyTo === c.id && (
                <div className="mt-2" style={{ marginLeft: 4, paddingLeft: 12, borderLeft: edge(18) }}>
                  <Composer value={noteDraft} onChange={setNoteDraft} busy={busyComment === c.id} autoFocus
                    placeholder={`Answer ${c.who || "this"}`} sendLabel="Reply"
                    people={members} onNeedPeople={loadMembers}
                    onCancel={() => { setReplyTo(null); setNoteDraft(""); }}
                    onSend={() => {
                      setBusyComment(c.id);
                      void api.clickupCommentReply(c.id, noteDraft).then((r) => {
                        if (r.ok) {
                          setReplyTo(null); setNoteDraft("");
                          /* Opened, because a reply you cannot see is a reply
                             you post twice. */
                          setOpenThreads((set) => new Set(set).add(c.id));
                          reread();
                        } else onNote(r.error ?? "ClickUp refused the reply");
                      }).finally(() => setBusyComment(null));
                    }} />
                </div>
              )}
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
                      {/* A reply is a comment with a parent — ClickUp edits and
                          deletes it through the very same endpoints, and its
                          own `…` menu offers both. Ours offered neither, so a
                          typo in an answer meant leaving the app. */}
                      {editing === r.id
                        ? <Composer value={noteDraft} onChange={setNoteDraft} busy={busyComment === r.id} autoFocus
                            placeholder="Edit this reply" sendLabel="Save"
                            people={members} onNeedPeople={loadMembers}
                            onCancel={() => { setEditing(null); setNoteDraft(""); }}
                            onSend={() => {
                              setBusyComment(r.id);
                              void api.clickupCommentEdit(r.id, noteDraft).then((res) => {
                                if (res.ok) { setEditing(null); setNoteDraft(""); reread(); }
                                else onNote(res.error ?? "ClickUp refused the edit");
                              }).finally(() => setBusyComment(null));
                            }} />
                        : <Markdown text={r.text} />}
                      {writable && r.mine && editing !== r.id && (
                        <div className="agx-hover-show flex items-center gap-1 mt-1.5">
                          <CommentAction label="Edit" title="Edit this reply"
                            d="M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16v4z"
                            onClick={() => { setEditing(r.id); setNoteDraft(r.text); setReplyTo(null); }} />
                          <CommentAction label="Delete" title="Delete this reply" tone="var(--error)"
                            d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v6M14 11v6"
                            busy={busyComment === r.id}
                            onClick={async () => {
                              if (!(await ask({
                                title: "Delete this reply?",
                                body: "It cannot be undone.",
                                confirmLabel: "Delete",
                                danger: true,
                              }))) return;
                              setBusyComment(r.id);
                              void api.clickupCommentDelete(r.id).then((res) => {
                                if (res.ok) reread(); else onNote(res.error ?? "ClickUp refused the delete");
                              }).finally(() => setBusyComment(null));
                            }} />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
            );
          })}
        </div>
      )}

      {/*
       * The quiet half of a comment's actions.
       *
       * ClickUp puts eight things behind a `…` on every comment; four of them
       * are AI features we have a better answer to (the card's own Hand to
       * Claude) and two are notification settings that belong in ClickUp. These
       * three are the ones that do work here — and every one of them is a thing
       * he does by hand today: copying a link to a comment to paste in a PR,
       * copying its text into a prompt, and moving a triage write-up from a
       * comment into the description where the next person will actually read
       * it.
       */}
      {commentMenu && (() => {
        const c = (full?.comments ?? []).find((x) => x.id === commentMenu.id);
        if (!c) return null;
        const close = () => setCommentMenu(null);
        return (
          <ContextMenu x={commentMenu.x} y={commentMenu.y} onClose={close}>
            <MenuItem onClick={() => {
              /* The card's URL with the comment on it. ClickUp opens the card
                 and scrolls to it; without the fragment it is still the card,
                 which is the useful half. */
              const link = t.url ? `${t.url}${t.url.includes("?") ? "&" : "?"}comment=${encodeURIComponent(c.id)}` : "";
              if (!link) { onNote("This card has no URL to copy"); close(); return; }
              void navigator.clipboard?.writeText(link)
                .then(() => onNote("Link to the comment copied"))
                .catch(() => onNote("Could not reach the clipboard"));
              close();
            }}>
              Copy link <span style={{ color: "var(--text4)" }}>· to this comment</span>
            </MenuItem>
            <MenuItem onClick={() => {
              void navigator.clipboard?.writeText(c.text ?? "")
                .then(() => onNote("Comment copied"))
                .catch(() => onNote("Could not reach the clipboard"));
              close();
            }}>
              Copy the text <span style={{ color: "var(--text4)" }}>· markdown, as written</span>
            </MenuItem>
            {writable && (
              <MenuItem onClick={() => {
                close();
                if (!(c.text ?? "").trim()) { onNote("There is nothing in that comment to add"); return; }
                const next = describeWithComment(full?.description ?? "", c);
                onApply("description", {
                  done: "Added to the description",
                  go: (st) => api.clickupEdit(t.id, { description: next }, st),
                });
              }}>
                Add to the description <span style={{ color: "var(--text4)" }}>· with who said it</span>
              </MenuItem>
            )}
          </ContextMenu>
        );
      })()}

      {/* Saying something, from here.
          The card could be read and could not be answered — every note went
          through the website, which is the thing this panel exists to make
          unnecessary. Below the conversation on purpose: a box above it is a
          box you write in before reading what is already there. */}
      {writable && (
        <div className="mb-3 pt-2" style={{ borderTop: rows.length ? edge(10) : undefined }}>
          <Composer value={say} onChange={(v) => { setSay(v); setSayErr(""); }} busy={saying}
            placeholder="Say something on this card. Markdown, and @ to call somebody."
            sendLabel="Comment"
            people={members}
            onNeedPeople={loadMembers}
            onSend={() => {
              setSaying(true); setSayErr("");
              /* No `assignee` any more, and that is the fix rather than a
                 removal. `@Name` used to go up as plain text — it read as a
                 mention and notified nobody — so the comment was HANDED to the
                 person instead, which lands in their "assigned comments" as a
                 to-do rather than as being mentioned. The name is now a real
                 mention op on the wire (see clickupDelta), which is what
                 ClickUp itself writes and what actually notifies. */
              void api.clickupComment(t.id, say).then((r) => {
                if (r.ok) { setSay(""); reread(); }
                /* Kept, not cleared: a comment refused by the workspace is
                   still the comment somebody wrote, and losing it to a failed
                   request is how people stop trusting the box. */
                else setSayErr(r.error ?? "ClickUp refused the comment");
              }).catch(() => setSayErr("Could not reach ClickUp")).finally(() => setSaying(false));
            }} />
          {sayErr && <div className="text-[10.5px] mt-1" style={{ color: "var(--error)" }}>{sayErr}</div>}
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
                    <span className={`${EYEBROW}`} style={{ color: "var(--text4)" }}>
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
                        <div className={`px-2.5 pt-2 pb-1 ${EYEBROW}`}
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
                    <div className="px-2.5 py-2 text-[10.5px]" style={{ color: "var(--text3)" }}>No skill matches that.</div>
                  )}
                  <div style={{ borderTop: edge(14) }} />
                </>
              )}
              <div className="px-2.5 pt-2 pb-1 flex items-center gap-2">
                <span className={`${EYEBROW}`} style={{ color: "var(--text4)" }}>
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
                  style={{ borderTop: edge(14) }}>
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
        {/* Beside the id it belongs with, and before Open: the two buttons are
            the two ways to take this card somewhere else, and the one that
            leaves the app should not be the only way to get its address. */}
        {t.url && (
          <button onClick={() => void copyIt(t.url, "url")} className="text-[10.5px] px-2 py-1 rounded-lg"
            style={{ border: line, color: "var(--text2)" }}
            title={t.url}>{copied === "url" ? "copied ✓" : "Copy URL"}</button>
        )}
        {t.url && (
          <a href={t.url} target="_blank" rel="noreferrer" className="text-[10.5px] px-2 py-1 rounded-lg"
            style={{ border: line, color: "var(--text2)" }}>Open ↗</a>
        )}
        {/*
          THIS CARD, and only this card.
         *
          The Refresh at the top of the board re-reads every card on it — which
          on a board of 123 is seconds of waiting to see whether one comment
          landed. `reread` already existed for exactly this shape (it runs after
          a comment is posted, because the board's poll does not carry
          comments); it simply had no way to be pressed.
         *
          Its own spinner rather than the board's, so it is obvious WHICH thing
          is being re-read. */}
        <button onClick={() => {
          setRereading(true);
          void api.clickupTask(t.id)
            .then((r) => {
              setFull(r);
              /* And the fields the BOARD owns, or half the card stays as it was
                 read a minute ago while the other half is current. */
              if (r.ok && r.task) onFresh?.(r.task);
            })
            .catch(() => { /* keep what we have */ })
            .finally(() => setRereading(false));
        }}
          disabled={rereading}
          title="Read this card again — the board keeps whatever it had"
          className="text-[10.5px] px-2 py-1 rounded-lg flex items-center gap-1.5 disabled:opacity-50"
          style={{ border: line, color: "var(--text2)" }}>
          {/* ICON.xs — below twelve a stroked glyph stops resolving at 1x, and
              the suite says so. It caught this one too. */}
          <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}
            strokeLinecap="round" strokeLinejoin="round" aria-hidden
            style={rereading ? { animation: "agx-spin 1s linear infinite" } : undefined}>
            <path d="M21 12a9 9 0 1 1-2.6-6.4" /><path d="M21 3v6h-6" />
          </svg>
          {rereading ? "reading…" : "Refresh card"}
        </button>
      </div>
      {dialog}
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
  const [note, setNote] = useState<{ ok: boolean; text: string; go?: { label: string; run: () => void } } | null>(null);
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
    // every field in this panel, so typing "cheap coffee" into the new-task
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
        <div className={`px-5 py-1 ${EYEBROW} shrink-0`}
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
      <aside className="agx-scroll overflow-y-auto overflow-x-hidden p-5 text-[11.5px] shrink-0"
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
  <div className={`${EYEBROW} px-5 pt-3 pb-1`} style={{ color: tone }}>{label}</div>
);

function TaskRow({ t, today, on, onPick, marked, onMark, reminder, remindOpen, onRemind, onCloseRemind, onSetRemind, onToggle, writable, onFilter }: {
  t: LocalTask; today: string; on: boolean; onPick: () => void;
  reminder?: import("../../../shared/types.ts").Reminder | null;
  remindOpen?: boolean; onRemind?: () => void; onCloseRemind?: () => void; onSetRemind?: (civil: string) => void;
  onToggle?: () => void; writable?: boolean;
  marked?: boolean; onMark?: () => void;
  onFilter?: (kind: "tag" | "project", value: string) => void;
}) {
  /* The cell the reminder popover hangs off. It is portalled out of this row —
     a row lives in a scroller, and a popover inside one gets clipped — so the
     only thing left here is where it should point. */
  const remindAnchor = useRef<HTMLSpanElement>(null);
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
                className={TAG_PILL}
                style={{ color: "var(--text3)", background: TAG_FILL, border: TAG_EDGE }}
                title={`Only +${tag}`}>{tag}</button>
            ))}
            {progress.total > 0 && (
              <span className={`${TAG_PILL} tabular-nums`}
                style={progress.done === progress.total
                  ? { color: "var(--success)", background: "color-mix(in srgb, var(--success) 13%, transparent)", border: "1px solid color-mix(in srgb, var(--success) 30%, transparent)" }
                  : { color: "var(--text3)", background: TAG_FILL, border: TAG_EDGE }}>
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
      <span ref={remindAnchor} className="relative text-[11px] tabular-nums">
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
          <RemindPopover task={t} anchor={remindAnchor.current} onClose={onCloseRemind} onSet={onSetRemind} />
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
          <div className={`${EYEBROW} mb-1.5 flex items-center gap-2`} style={{ color: "var(--text3)" }}>
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
          <div className={`${EYEBROW} mt-4 mb-1.5`} style={{ color: "var(--text3)" }}>Links</div>
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
        className={`w-full text-left ${EYEBROW} px-5 pt-3 pb-1 hover:bg-white/5`}
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


/*
 * WHAT A SEARCH FOUND, AS A LIST YOU PICK FROM.
 *
 * "that Looked up is really stupid and pointless… it should work the way
 * ClickUp does: when I search, that search modal comes up where I can pick which
 * one I want to open". So: over the board, one row per answer, the keyboard already
 * on it, and nothing filed anywhere until something is chosen.
 *
 * Why a card is here is on the row. A card whose id you typed and a card that
 * merely mentions it are two different answers to the same question, and
 * telling them apart is the difference between "the search is confused" and
 * "there are three of these".
 */
function SearchHits({ asked, rows, looking, onAsk, onPick, onClose }: {
  asked: string; rows: ProviderTask[];
  /** Still reading the workspace. The list opens on Enter and fills as answers
   *  arrive, so without this it opened saying "0 cards" over an empty box and
   *  looked like an answer rather than a wait. */
  looking: boolean;
  /** Search again for what is typed HERE. The box moved into this list —
   *  "I need to have the input inside the modal, the way ClickUp does" — so the list is
   *  the whole search surface once it is open, and the board's own box goes on
   *  filtering the board. */
  onAsk: (text: string) => void;
  onPick: (t: ProviderTask) => void; onClose: () => void;
}) {
  const [hot, setHot] = useState(0);
  const [text, setText] = useState(asked);
  /* What was asked LAST, so a re-render caused by rows arriving does not look
     like the reader typing. */
  const asking = useRef(asked);
  useEffect(() => { setText(asked); asking.current = asked; }, [asked]);
  useEffect(() => {
    const t = text.trim();
    if (t.length < 2 || t === asking.current) return;
    /* Typed, not pressed: a keystroke should not fire a sweep of the whole
       workspace, and 400ms is about where a phrase stops changing. */
    const timer = setTimeout(() => { asking.current = t; onAsk(t); }, 400);
    return () => clearTimeout(timer);
  }, [text, onAsk]);
  const want = asked.trim().toLowerCase();
  const isTheCard = (t: ProviderTask) =>
    t.id.toLowerCase() === want || (t.customId ?? "").toLowerCase() === want
    || (t.customId ?? "").toLowerCase().endsWith(`-${want}`);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); return; }
      if (e.key === "ArrowDown") { e.preventDefault(); setHot((h) => Math.min(h + 1, rows.length - 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setHot((h) => Math.max(h - 1, 0)); return; }
      if (e.key === "Enter") {
        e.preventDefault();
        /*
         * ENTER MEANS "SEARCH THIS" UNTIL IT HAS BEEN SEARCHED.
         *
         * The box lives in the list now, so Enter has two jobs and they were
         * collapsed into one: typing `9175` over `ORBIT-9175` and pressing
         * Enter OPENED the highlighted row and closed the list — with the
         * board's own box still showing the query from before. Only once what
         * is typed is what was searched does Enter mean "open this one".
         */
        const typed = text.trim();
        if (typed.length >= 2 && typed !== asking.current) { asking.current = typed; onAsk(typed); return; }
        const t = rows[hot];
        if (t) onPick(t);
      }
    };
    /* Capture, because the search box still has the focus — the reader typed
       to get here and the arrows belong to this list from that moment on. */
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [rows, hot, text, onAsk, onPick, onClose]);

  return (
    <div className="absolute inset-0 z-30 flex justify-center px-5 pt-2"
      style={{ background: "color-mix(in srgb, var(--bg) 55%, transparent)" }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="agx-scroll w-full max-w-[720px] max-h-[70%] overflow-y-auto rounded-lg shadow-2xl flex flex-col"
        style={{ background: "var(--bg2)", border: edge(28) }}>
        {/* The box, at the top of the list, the way every command palette does
            it: what you typed is here, and typing again searches again. */}
        <div className="px-3 pt-2.5 pb-2 flex items-center gap-2 shrink-0" style={{ borderBottom: edge(18) }}>
          <span className="shrink-0 grid place-items-center" style={{ width: 20, height: 20, color: "var(--text3)" }}>
            <svg width={ICON.md} height={ICON.md} viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth={2.2} strokeLinecap="round" aria-hidden>
              <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.6-3.6" />
            </svg>
          </span>
          <input autoFocus value={text} onChange={(e) => setText(e.target.value)}
            placeholder="Search the workspace"
            spellCheck={false}
            className="flex-1 min-w-0 bg-transparent outline-none text-[13px]"
            style={{ color: "var(--text)", caretColor: "var(--primary)" }} />
          <button onClick={onClose} className="agx-btn rounded px-1 shrink-0" title="Close · Esc" aria-label="Close"
            style={{ color: "var(--text3)" }}>×</button>
        </div>
        <div className="px-3 py-1.5 flex items-center gap-2 text-[10.5px] shrink-0"
          style={{ color: "var(--text3)", borderBottom: edge(12) }}>
          {looking && (
            <span className="agx-spin shrink-0" aria-label="Searching"
              style={{ width: 11, height: 11, borderWidth: 1.5, borderColor: "var(--text3)", borderTopColor: "transparent" }} />
          )}
          <span className="min-w-0 flex-1 truncate">
            {looking
              /* What it is doing and why it takes a moment. ClickUp has no text
                 search, so this is a sweep of the workspace and the first one
                 is slow; saying so is the difference between waiting and
                 wondering. */
              ? `Looking through the workspace for “${asked}”…${rows.length ? ` · ${rows.length} so far` : ""}`
              : `${rows.length} ${rows.length === 1 ? "card" : "cards"} for “${asked}” · ↑↓ to move, Enter to open`}
          </span>
        </div>
        {!rows.length && (
          <div className="px-3 py-6 text-[11.5px]" style={{ color: "var(--text3)" }}>
            {looking
              ? "ClickUp has no text search, so this reads the workspace itself. The first one takes a few seconds."
              : `Nothing mentions “${asked}”.`}
          </div>
        )}
        {rows.map((t, i) => (
          <button key={t.id} type="button"
            onMouseEnter={() => setHot(i)}
            onMouseDown={(e) => { e.preventDefault(); onPick(t); }}
            className="text-left px-3 py-2 flex items-center gap-2 min-w-0"
            style={{ background: i === hot ? "color-mix(in srgb, var(--text) 8%, transparent)" : "transparent" }}>
            <span className="shrink-0 text-[9.5px] px-1 rounded tabular-nums"
              style={{ color: "var(--primary)", border: edge(22) }}>{t.customId ?? t.id}</span>
            <span className="min-w-0 flex-1 truncate text-[12px]" style={{ color: "var(--text)" }}>{t.title}</span>
            <span className="shrink-0 text-[10px] truncate" style={{ color: "var(--text4)", maxWidth: 160 }}>{t.list}</span>
            {/* The reason it is on this list, which is the thing a plain list of
                results cannot say. */}
            <span className="shrink-0 text-[9.5px]" style={{ color: isTheCard(t) ? "var(--success)" : "var(--text4)" }}>
              {isTheCard(t) ? "the card" : "mentions it"}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
