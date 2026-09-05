/*
 * The work loop, on screen.
 *
 * Everything else in this panel was built around a different question. The
 * scorecard measures whether the understudy DECIDES like him; the queue shows
 * what it would ask for and waits. Both are instruments, and his answer to what
 * they added up to was that he still could not leave it working on his issues
 * for a day. That is what this tab is for.
 *
 * IT EXISTED ONLY OVER HTTP UNTIL NOW. The loop, the queue he fills by hand,
 * which project is open, the runs it has done — all of it was reachable with
 * curl and invisible in the application, which meant the only person who could
 * work the feature was the one holding the routes in their head. A capability
 * nobody can see is a capability nobody uses.
 *
 * THE THREE THINGS THIS SCREEN HAS TO MAKE PLAIN, because each of them is a
 * promise the loop makes and a person cannot verify from a transcript:
 *
 *   WHERE it may work — the open project, and the checkouts inside it. The
 *     fence is a setting rather than a constant, so it has to be legible.
 *   WHAT IT LEFT BEHIND — every run cuts a disposable worktree, and a failed
 *     one is kept on disk because it is the evidence. A path nobody can see is
 *     a directory nobody will ever clean up or read.
 *   WHAT THE TESTS SAID — not what the agent claimed. The two are printed as
 *     different things on purpose.
 *
 * Nothing here pushes. There is no button for it and the loop has no verb for
 * it; this repository has a great deal of local work that has never gone to a
 * remote and that decision is not the machine's to make.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { SERVER, authHeaders } from "../../lib/api.ts";
import { Empty, wash, edge } from "../git/ui.tsx";
import { Chip } from "../workspace/Chrome.tsx";
import type {
  UnderstudyAsked, UnderstudyShift, UnderstudyWorkItem, UnderstudyWorkRun, UnderstudyHelp,
} from "../../../../shared/types.ts";

const when = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/*
 * How long a run took, in the units a person actually says it in — and a live
 * one counts up rather than saying "running".
 *
 * A task can take three quarters of an hour, so the one row somebody is
 * actually watching was the only one that did not say how long it had been at
 * it. The word is not lost: the state chip beside this on every row already
 * says "running", in the colour it says it in.
 *
 * IT READS THE CLOCK, IT DOES NOT KEEP ONE. `now` is a parameter because a
 * ticking run has to be assertable, not because anything passes it — the tab
 * already reloads every six seconds while work is in flight, and each of those
 * re-renders this, so the number moves without a timer of its own. Idle polling
 * is cost this application has already had to go and remove once.
 */
/**
 * WHERE SOMEBODY IS, the first time they open this.
 *
 * His words, looking at the panel: "none of the 3 tabs make sense, they are full
 * of overwhelming info, and you don't want to touch anything in case it breaks". He
 * commissioned this feature; if it does not tell him where to start, it tells
 * nobody.
 *
 * The three tabs are three real, separate jobs, and they read left to right in
 * the REVERSE of the order they are used in: you teach it, then you check its
 * judgement, then you hand it work. `Its work` is the tab that opens, so a
 * first visit lands on the last step — a screen full of live controls attached
 * to a machine that has been taught nothing.
 *
 * So the panel says which step you are on, in one line, with one button. It is
 * not a wizard and it hides nothing: the whole panel is underneath it the
 * entire time, and the line disappears for good once a run has finished.
 *
 * The numbers are a real dependency rather than decoration, which is the only
 * thing that earns them: it cannot answer from precedents it has not read, and
 * handing work to something whose judgement you have not checked is precisely
 * the "I do not want to touch anything" this exists to answer.
 */
/* Whether the Try-it tab has ever been opened from here. Kept in this browser
   rather than on the server: it exists only to advance a three-step line that
   disappears, and a column in the database for that is a migration nobody
   should have to reason about later. Reads defensively — a private window, or
   storage the viewer has switched off, must not break the panel. */
const ASKED_KEY = "agx.understudy.asked";
function askedBefore(): boolean {
  try { return localStorage.getItem(ASKED_KEY) === "1"; } catch { return false; }
}
function noteAsked(goes: "teach" | "ask" | "work"): void {
  if (goes !== "ask") return;
  try { localStorage.setItem(ASKED_KEY, "1"); } catch { /* nothing is lost that matters */ }
}

export type Onboarding = {
  step: 1 | 2 | 3;
  title: string;
  why: string;
  does: string;
  /** Which tab that button leads to. */
  goes: "teach" | "ask" | "work";
};

export function onboarding(s: {
  precedents: number;
  rules: number;
  runsDone: number;
  asked: boolean;
}): Onboarding | null {
  /* Finished for good once it has actually delivered something. Not on the
     first click of a button — a run that fails still teaches you more about
     the thing than any tour would, and the line has done its job by then. */
  if (s.runsDone > 0) return null;
  if (!s.precedents && !s.rules) {
    return {
      step: 1, goes: "teach",
      title: "Show it how you work",
      why: "Point it at a repository and it reads the decisions you have already made. Nothing leaves this machine, and nothing outside the folder you name is read.",
      does: "Show it a repository",
    };
  }
  if (!s.asked) {
    return {
      step: 2, goes: "ask",
      title: "Check that it thinks like you",
      why: "Ask it something you already know the answer to, and read what it says against what you would have said. It answers from your own decisions, not from a guess.",
      does: "Ask it something",
    };
  }
  return {
    step: 3, goes: "work",
    title: "Give it something small",
    why: "One task, its own worktree off the current tip, and the tests decide. It is left on disk either way, and nothing is ever pushed.",
    does: "Write the first task",
  };
}

/**
 * THE TITLE BLOCK — three fields, always the same three, always in this order.
 *
 * Every drawing carries a block naming the project, the scale, the revision and
 * who signed it. It sits in the same place on every sheet and you read it before
 * you read the drawing. This panel authorises work somebody will not watch
 * happen, inside a boundary that has to hold — the same problem, so the same
 * device: WHERE it may cut, WHAT is on the set, and WHAT HAPPENS on release.
 *
 * It does not change shape when work starts. The values change and one cell
 * lights; there is no second layout to learn and no separate running banner.
 *
 * Pure and exported because every combination below is a state somebody lands
 * in, including the ones nobody plans for: no fence, empty set, cutting.
 */
export type Block = {
  where: { k: string; v: string; sub: string; lit: boolean };
  what: { k: string; v: string; sub: string; lit: boolean };
  after: { k: string; v: string; sub: string; lit: boolean };
};

export function titleBlock(s: {
  project: string;
  checkouts: number;
  queued: number;
  cutting: boolean;
  minsLeft: number;
  sheetsLeft: number;
  cuttingIn?: string;
}): Block {
  const fence = s.project
    ? { k: s.cutting ? "cutting in" : "may cut in", v: s.cutting ? (s.cuttingIn || s.project) : s.project,
        sub: s.checkouts === 1 ? "1 checkout" : `${s.checkouts} checkouts`, lit: false }
    /* No fence is not a quiet default: it is the one state where every control
       below will refuse, so the cell is the lit one until it is answered. */
    : { k: "may cut in", v: "nowhere yet", sub: "it will decline every sheet", lit: true };

  const set = s.cutting
    ? { k: "sheets left", v: String(s.sheetsLeft), sub: `of ${s.sheetsLeft + 1}`, lit: false }
    : { k: "sheets on the set", v: s.queued ? String(s.queued) : "none", sub: s.queued ? "in order" : "add one below", lit: Boolean(s.project) && s.queued > 0 };

  const rel = s.cutting
    ? { k: "time on the clock", v: `${s.minsLeft} min`, sub: "hold after this one", lit: true }
    : { k: "on release", v: "1 hour", sub: "4 sheets at most", lit: false };

  return { where: fence, what: set, after: rel };
}

/**
 * WHY IT HAS NOWHERE TO WORK, and the one thing that fixes it.
 *
 * The banner said it would decline every task and never said why. The morning
 * it mattered, the why was "the server was started outside a git checkout, so
 * discovery found nothing" — which is not something a person can guess from a
 * red line, and not something the control beside it (a checkout list built
 * from that same empty discovery) could have led them out of.
 *
 * The server sends the reason; this only decides what to print when it did
 * not. An older server, or a case its own rules call fine, must still leave a
 * sentence on the screen — a banner that says "nowhere" and stops is the bug
 * being fixed here, so the fallback is the general truth rather than nothing.
 */
export function nowhereLine(reason: { why?: string; fix?: string } | null | undefined): { why: string; fix: string } {
  return {
    why: reason?.why?.trim() || "No checkout matched the project it is fenced to.",
    fix: reason?.fix?.trim() || "Pick the project it may work in.",
  };
}

/**
 * What a finished run is stamped with.
 *
 * A drawing register has needed exactly these three for as long as drawings
 * have been issued, and `void` carries what `failed` does not: the sheet is
 * kept — the worktree is still on disk, deliberately — it is simply not to be
 * built from. `on hold` is the one nobody had a word for: interrupted, put
 * back, nobody's fault.
 */
export function stampFor(state: string): { word: string; tone: "success" | "warning" | "primary" | "error" } {
  if (state === "done") return { word: "approved", tone: "success" };
  if (state === "abandoned") return { word: "on hold", tone: "warning" };
  if (state === "running") return { word: "cutting", tone: "primary" };
  /*
   * A RUN THAT LEFT NOTHING IS NOT A FAILURE, and it should not be printed in
   * the same red as one.
   *
   * `empty` is what an interrupted run settles to once git has been asked and
   * the branch is gone — merged and tidied, swept, or thrown away. There is
   * nothing to build from, which is the register's own definition of void, but
   * a page of red says "it all went wrong" about a night where almost nothing
   * did. Its own quiet word, and the tone the state deserves: nothing to do,
   * nothing to worry about.
   */
  if (state === "empty") return { word: "nothing left", tone: "primary" };
  return { word: "void", tone: "error" };
}

/**
 * THE RUN BUTTON: what it says, and whether it does anything.
 *
 * His words about the tab this replaces: "it is not intuitive at all... it is very
 * hard". The fault was not one control. Four ways to start were laid out
 * above the box you type the task into, and one empty setting — an eyebrow
 * called "May work in" — silently disabled all four while every button still
 * looked live.
 *
 * Measured over 108 runs: 107 were worked under a shift and exactly one was
 * not, and all 108 came from the hand-written list. So there is one button, it
 * starts a shift, and it names what it is about to work. The rest of the
 * screen is the list it works and what it did.
 *
 * Pure and exported because every branch is a state somebody lands in, and the
 * empty one is the state a first-time reader lands in first.
 */
export type RunBar = {
  /** null while it is already working — there is nothing to press. */
  does: string | null;
  says: string;
  enabled: boolean;
  stopping: boolean;
};

export function runBar(s: {
  working: boolean;
  minsLeft: number;
  tasksLeft: number;
  queued: number;
  hasNext: boolean;
  busy: boolean;
  allowed: number;
}): RunBar {
  if (s.working) {
    return {
      does: null, stopping: true, enabled: true,
      /* The clock lives in the title block now; this line only has to say what
         pressing the one control would do. */
      says: "It stops after the sheet it is cutting.",
    };
  }
  if (!s.allowed) {
    return { does: "Release for construction", says: "It has nowhere to cut yet.", enabled: false, stopping: false };
  }
  if (!s.queued && !s.hasNext) {
    return { does: "Release for construction", says: "Nothing on the set yet.", enabled: false, stopping: false };
  }
  return {
    /*
     * "RELEASE FOR CONSTRUCTION" is the phrase a drawing set uses for the
     * moment paper becomes building, and it says what pressing this means far
     * better than "start": it is the point where a machine begins writing
     * files in a checkout. The limits move to the title block, so this line
     * carries the promise instead.
     */
    does: "Release for construction",
    says: "It cuts a worktree per sheet. Nothing is ever pushed.",
    enabled: !s.busy,
    stopping: false,
  };
}

/**
 * The verdict out of an outcome, which is its first non-empty line.
 *
 * An outcome is the agent's own words followed by what the tests said, and it
 * runs to thousands of characters. The first line is what a person scanning a
 * list of eighty runs is actually reading — "4251 pass, 0 fail", "tests failed
 * and failed again", "the server restarted while this was running".
 */
export function firstLine(outcome: string, limit = 120): string {
  /*
   * THE FIRST LINE THAT SAYS SOMETHING, which is not the same as the first
   * non-empty one.
   *
   * Seen on the real list: four rows in ten rendered as "… · more" and nothing
   * else. An outcome is stored capped, so a great many of them open with a
   * bare ellipsis marking the cut — and a row whose whole verdict is "…" is
   * worse than the block it replaced, because it costs a click to learn there
   * was never anything there.
   *
   * So: skip anything with no letters or digits in it at all, and strip a
   * leading ellipsis off the line that survives.
   */
  const line = outcome
    .split("\n")
    .map((l) => l.replace(/^[…\.\s]+/, "").trim())
    .find((l) => /[\p{L}\p{N}]/u.test(l)) ?? "";
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/**
 * How many commits `sweepEmptyWorktrees` (server/src/understudy-watchdog.ts)
 * found still sitting on a spared branch, read back from the line it left in
 * the outcome — 0 when the sweep never said so, whether because there were
 * none or it hasn't looked yet. The two sides share the sentence, not a
 * module: the server writes it into a SQLite column, the browser reads it out
 * of one.
 */
export function commitsSpared(outcome: string): number {
  const m = /^Left (\d+) commits? on \S+ that nobody has merged/m.exec(outcome || "");
  return m ? Number(m[1]) : 0;
}

export function took(run: UnderstudyWorkRun, now = Date.now()): string {
  const s = Math.max(0, Math.round(((run.finishedAt ?? now) - run.startedAt) / 1000));
  return s < 90 ? `${s}s` : `${Math.round(s / 60)} min`;
}

const STATE_TONE: Record<UnderstudyWorkRun["state"], string> = {
  running: "var(--primary)",
  done: "var(--success)",
  failed: "var(--error)",
  abandoned: "var(--text4)",
  // Neither green nor red: the tests passed, but it never committed, which is
  // the shape a run leaves when it ends its turn waiting on something that was
  // never coming back to it. Warning rather than error because the work itself
  // is fine — it is sitting in the worktree, not gone.
  uncommitted: "var(--warning)",
  // Not `--success`: nothing was delivered. Not `--error` either: nothing went
  // wrong, an agent just stopped after "investigating" with no commit and no
  // argument for why that was the right place to stop. Same warning tint as
  // `uncommitted` — both mean "a person should look", neither means "broken".
  empty: "var(--warning)",
};

/** The last path segment, which is the part that differs. Full path in the
 *  title, because that is the thing somebody pastes into a terminal. */
const leaf = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

/*
 * WHERE ITS WORK MAY COME FROM, beside where it may work.
 *
 * `open-only` keeps the task-tracker sources silent; `everywhere` lets them
 * offer cards. It could be changed over HTTP and never read, so the switch
 * deciding whether the clone reaches somebody's employer was invisible in the
 * application — and it is the setting people most want to check before leaving
 * it running.
 *
 * IT LOOKED LIKE A CAPTION. A chip with an on/off state draws no body, because
 * for a toggle the tint IS the state — which is right in a row of toggles and
 * wrong here: this one sits alone beside the open-project chip, and off it was
 * transparent grey text next to that chip's border. The one control on the row
 * that changes what the clone may reach read as the label for the one that does
 * not. `resting` is what this application already has for exactly that — a
 * toggle that must look pressable while it is off — and it is what the posture
 * rungs and the window filter use, so the fence borrows a shape people have
 * already learned rather than a new one.
 *
 * Off it takes the neighbour's border and nothing else; on it keeps the error
 * tint, so the state that widens the fence is still the one that stands out,
 * and the widening is still the deliberate click whose label says what it
 * turned on.
 *
 * Split out of the row so both states can be rendered and asserted. The row
 * around it needs a server, four pieces of state and a tmux pane; the fence
 * needs which way it is set.
 */
export function TrackerFence({ scope, onFlip }: {
  scope: "open-only" | "everywhere";
  onFlip: () => void;
}) {
  const open = scope === "everywhere";
  return (
    <Chip
      on={open}
      resting
      danger={open}
      onClick={onFlip}
      title={open
        ? "Task-tracker sources may offer work. Click to keep them silent."
        : "Task-tracker sources are silent. Click to let them offer work."}>
      {open ? "tracker: on" : "tracker: silent"}
    </Chip>
  );
}

export function Work({ active, standing, goTo }: {
  active: boolean;
  /** What the header already fetched: how much it has been taught, and how
   *  much it has finished. Passed down rather than fetched again. */
  standing?: { precedents: number; rules: number; done: number; failed: number; stuck: number } | null;
  goTo?: (tab: "work" | "ask" | "teach") => void;
}) {
  const [queued, setQueued] = useState<UnderstudyAsked[] | null>(null);
  const [allowed, setAllowed] = useState<string[]>([]);
  const [openProject, setOpenProject] = useState("");
  /** The projects this machine has actually seen, so the fence can be picked
   *  rather than typed. See the note on the endpoint for why that matters. */
  const [projects, setProjects] = useState<{ name: string; checkouts: number }[]>([]);
  /** Why the list above is empty, straight from the server. Null while there
   *  is nothing wrong to explain. */
  const [reason, setReason] = useState<{ why?: string; fix?: string } | null>(null);
  /** Whether the task-tracker sources may offer work at all. */
  const [scope, setScope] = useState<"open-only" | "everywhere">("open-only");
  const [runs, setRuns] = useState<UnderstudyWorkRun[]>([]);
  /** Panes this server has a run going in, newest wins. */
  const [panes, setPanes] = useState<{ runId: number; paneId?: string; why?: string }[]>([]);
  /** What is on that pane right now. */
  const [over, setOver] = useState("");
  const [next, setNext] = useState<UnderstudyWorkItem | null>(null);
  const [shift, setShift] = useState<UnderstudyShift | null>(null);
  /** Asleep until the agent's session limit resets — the server's hold. */
  const [hold, setHold] = useState<{ until: number; why: string } | null>(null);
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [repo, setRepo] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  /* What it is doing right now, in words. A run is an agent with a shell for up
     to twenty-five minutes, so the request this tab made is still open while
     nothing on screen would otherwise move. Silence there reads as broken. */
  const [busy, setBusy] = useState<string | null>(null);
  /** Null while nobody is editing which project is open. */
  const [renaming, setRenaming] = useState<string | null>(null);
  /* The detail box is opened by ⇧⏎ rather than always shown: most tasks are
     one line, and a permanently open second field made the common case look
     like a form. */
  const [detailOpen, setDetailOpen] = useState(false);
  /** Which run has its full outcome open. One at a time: the point is a list
   *  that can be read as a list. */
  const [openOutcome, setOpenOutcome] = useState<number | null>(null);
  /** Whether the three-line explanation is showing. Closed: it is the same
   *  three lines every time, and this tab is opened daily. */
  const [howOpen, setHowOpen] = useState(false);
  /*
   * Whether the last read got an answer at all.
   *
   * Without this the two are indistinguishable on screen. A failed read leaves
   * `allowed` empty, and an empty `allowed` prints "no checkout matches, so it
   * will decline everything" in red — which sends somebody to fix a fence that
   * was never wrong. Writes already say the server's own sentence; reads said
   * nothing and let the emptiness speak for them.
   */
  const [answered, setAnswered] = useState(true);
  /* What it is stuck on. Loaded with everything else, and drawn at the top:
     26 of 108 runs ended having delivered nothing and none of them said what
     they needed, which is the failure the whole panel is downstream of. */
  const [help, setHelp] = useState<UnderstudyHelp[]>([]);
  const [openHelp, setOpenHelp] = useState(false);
  const taskBox = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try {
      const ar = await fetch(SERVER + "/understudy/work/ask", { headers: authHeaders() });
      const ab = (await ar.json()) as
        {
          queued?: UnderstudyAsked[]; allowed?: string[]; openProject?: string; scope?: string;
          projects?: { name: string; checkouts: number }[];
          reason?: { why?: string; fix?: string } | null;
        };
      setQueued(ab?.queued ?? []);
      setAllowed(ab?.allowed ?? []);
      setOpenProject(ab?.openProject ?? "");
      setProjects(ab?.projects ?? []);
      setReason(ab?.reason ?? null);
      // Anything but the explicit widening is the narrow one: a value this
      // client did not recognise must never read as "it may go everywhere".
      setScope(ab?.scope === "everywhere" ? "everywhere" : "open-only");
      setRepo((r) => r || ab?.allowed?.[0] || "");

      const nr = await fetch(SERVER + "/understudy/work/next", { headers: authHeaders() });
      const nb = (await nr.json()) as {
        item?: UnderstudyWorkItem | null; runs?: UnderstudyWorkRun[];
        watching?: { runId: number; paneId?: string; why?: string }[];
      };
      setNext(nb?.item ?? null);
      setRuns(nb?.runs ?? []);
      setPanes(nb?.watching ?? []);

      const sr = await fetch(SERVER + "/understudy/shift", { headers: authHeaders() });
      const sb = (await sr.json()) as { current?: UnderstudyShift | null; hold?: { until: number; why: string } | null };
      setShift(sb?.current ?? null);
      setHold(sb?.hold ?? null);

      const hr = await fetch(SERVER + "/understudy/help", { headers: authHeaders() });
      const hb = (await hr.json()) as { open?: UnderstudyHelp[] };
      setHelp(hb?.open ?? []);
      setAnswered(true);
    } catch {
      setQueued([]);
      setAnswered(false);
    }
  }, []);

  useEffect(() => { if (active) void load(); }, [active, load]);

  /*
   * While something is running, keep looking — and only then.
   *
   * A run finishes on the server's clock, not on a click, so a tab that only
   * loads on mount shows the same screen for twenty minutes and then everything
   * at once. Polling when nothing is happening is idle cost this application
   * has already had to go and remove once.
   */
  /*
   * A boolean rather than the objects it comes from, and that is the whole
   * point. `load` replaces `shift` and `runs` with fresh values every time, so
   * depending on them re-ran this effect on every poll — tearing the interval
   * down and building a new one six seconds into its own cycle, for ever. The
   * derived answer only changes when something actually starts or stops.
   */
  const working = busy !== null || shift?.state === "running" || runs.some((r) => r.state === "running");
  useEffect(() => {
    if (!active || !working) return;
    const t = setInterval(() => { void load(); }, 6000);
    return () => clearInterval(t);
  }, [active, working, load]);

  /*
   * THE COUNTER, and it reads on its own clock.
   *
   * The rest of this tab polls every six seconds — those are rows that change
   * when a run ends. This is a terminal with an agent typing into it, and six
   * seconds of stillness on a live screen reads as frozen. Two is close enough
   * to watching without asking tmux to redraw for nothing.
   *
   * Only while there IS a pane: no run, no timer.
   */
  /*
   * The counter scrolls itself to the bottom.
   *
   * It is a live log: the line that matters is always the last one, and a box
   * that keeps its scroll position shows the beginning of a task for the
   * twenty-five minutes after it stopped being the interesting part.
   */
  const overRef = useRef<HTMLPreElement | null>(null);
  const latest = panes[panes.length - 1];
  const pane = latest?.paneId ?? "";
  // A run with no pane says why rather than showing an empty box. Measured the
  // first time this ran: an over-long socket path made tmux refuse, the work
  // went ahead in a hidden spawn, and the screen simply had nothing on it.
  const noPaneWhy = !pane && latest?.why ? latest.why : "";
  useEffect(() => {
    if (!active || !pane) { setOver(""); return; }
    let gone = false;
    const read = async () => {
      try {
        const r = await fetch(`${SERVER}/understudy/work/watch?pane=${encodeURIComponent(pane)}`,
          { headers: authHeaders() });
        const b = (await r.json()) as { ok?: boolean; text?: string };
        if (!gone && b?.ok) setOver(b.text ?? "");
      } catch { /* the pane went; the next load drops it from the list */ }
    };
    void read();
    const t = setInterval(() => { void read(); }, 2000);
    return () => { gone = true; clearInterval(t); };
  }, [active, pane]);

  useEffect(() => {
    const el = overRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [over]);

  const post = useCallback(async (path: string, body?: unknown): Promise<{ ok: boolean; error?: string }> => {
    setProblem(null);
    try {
      const r = await fetch(SERVER + path, {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const b = (await r.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!r.ok || b?.ok === false) {
        // The server's own sentence, always. Every refusal on these routes says
        // what to do about it — "hand over first", "it may only work in: …" —
        // and replacing that with a generic failure throws the answer away.
        setProblem(b?.error ?? "It would not.");
        return { ok: false, error: b?.error };
      }
      return { ok: true };
    } catch {
      setProblem("The server did not answer.");
      return { ok: false };
    }
  }, []);

  const handOver = async () => {
    /* The goal used to be a free-text field beside the button, and it was the
       first thing on screen: "what should it get through while you are away?".
       Nobody was answering a different question than the list already answers,
       so the list IS the goal now and the field is gone. */
    await post("/understudy/shift/start", { goal: "work through the list", minutes: 60, maxActions: 4 });
    void load();
  };

  const takeBack = async () => {
    await post("/understudy/shift/stop");
    void load();
  };

  const queue = async () => {
    if (!title.trim()) return;
    const r = await post("/understudy/work/ask", { title: title.trim(), detail: detail.trim(), repo });
    if (r.ok) { setTitle(""); setDetail(""); setDetailOpen(false); }
    void load();
  };



  const discard = async (run: UnderstudyWorkRun) => {
    await post("/understudy/work/discard", { worktree: run.worktree, repo: run.repo });
    void load();
  };

  /*
   * An inline field, NOT `window.prompt`.
   *
   * Electron's renderer does not implement it — it returns nothing and logs
   * that it never will — so a dialog here would be a control that silently does
   * nothing in the only place this application actually runs.
   */
  const rename = async () => { await renameTo((renaming ?? "").trim()); };

  /* Split out so picking a row and typing a name go through one path — the
     server has a rule about names that match everything, and a picked row must
     meet it exactly as a typed one does. */
  const renameTo = async (name: string) => {
    if (!name) return;
    await post("/understudy/open-project", { name });
    setRenaming(null);
    void load();
  };

  if (!active) return null;
  if (queued === null) return <Empty what="what it has been given to do" busy where="" />;

  return (
    <div className="min-h-0 overflow-y-auto">
      {/*
        * ONE LINE, and the rest behind it.
        *
        * Three lines of explanation opened this tab every single time, for
        * somebody who has read them eighty times. What survives is the half a
        * person keeps checking — that it never pushes — and the rest is one
        * click away for a first visit.
        */}
      <p className="m-0 px-4 py-2 text-[11.5px] leading-relaxed" style={{ color: "var(--text3)" }}>
        One task, its own worktree, and the tests decide.{" "}
        <b style={{ fontWeight: 400, color: "var(--text2)" }}>Nothing is ever pushed.</b>{" "}
        <button className="agx-linkish" style={{ color: "var(--text4)" }}
          onClick={() => setHowOpen((v) => !v)}>
          {howOpen ? "less" : "how it works"}
        </button>
      </p>
      {howOpen && (
        <p className="m-0 px-4 pb-2.5 text-[11.5px] leading-relaxed" style={{ color: "var(--text3)", maxWidth: "72ch" }}>
          It takes one task, cuts its own worktree off the current tip, does the work with every tool you have, and
          runs the tests. The tests decide — not what it says about itself. A run that fails is left on disk so you
          can go and look at it.
        </p>
      )}

      {/*
        * THE TITLE BLOCK. See `titleBlock` above for why a drawing set.
        *
        * It replaces three separate things: the first-run step strip, the
        * "may work in" line, and the run bar's status sentence. They were three
        * answers to one question — what is set up, what is queued, what happens
        * if I press this — and a person had to assemble that from three places
        * on the screen.
        */}
      {(() => {
        const blk = titleBlock({
          project: openProject,
          checkouts: allowed.length,
          queued: queued?.length ?? 0,
          cutting: shift?.state === "running",
          minsLeft: Math.ceil((shift?.msLeft ?? 0) / 60_000),
          sheetsLeft: shift?.actionsLeft ?? 0,
        });
        const cell = (f: Block["where"], onClick?: () => void) => (
          <div className={f.lit ? "on" : undefined}>
            <div className="agx-tb-k">{f.k}</div>
            <div className="agx-tb-v">
              {onClick
                ? <button className="agx-linkish" style={{ fontSize: "inherit", fontWeight: "inherit", color: "inherit" }}
                    onClick={onClick}>{f.v}</button>
                : f.v}
              {" "}<small>{f.sub}</small>
            </div>
          </div>
        );
        return (
          <div className="agx-tb">
            {cell(blk.where, () => setRenaming(openProject))}
            {cell(blk.what)}
            {cell(blk.after)}
          </div>
        );
      })()}

      {/*
        * ASLEEP, AND UNTIL WHEN. The agent's session limit was hit; the CLI
        * said when it resets and the loop is holding until then rather than
        * paying for the same answer three more times. A person opening this
        * view during the nap sees the hour, not a shift that looks stuck.
        */}
      {hold && hold.until > Date.now() && (
        <div data-understudy-asleep className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-[11.5px]"
          style={{ background: wash("--warning", 9), border: `1px solid ${wash("--warning", 35)}`, color: "var(--text2)" }}>
          <span aria-hidden style={{ fontSize: 14 }}>🌙</span>
          <span><b style={{ color: "var(--text)" }}>Asleep until {new Date(hold.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</b> — {hold.why}. It picks the work up again on its own.</span>
        </div>
      )}

      {/*
        * IT HAS NOWHERE TO WORK, and nothing else matters until it does.
        *
        * This used to be an 11px red line beside a control that still looked
        * clickable, under a heading called "May work in". Every button on the
        * screen was live and every one of them would have declined.
        */}
      {answered && allowed.length === 0 && (
        <div className="px-4 py-3 flex items-center gap-3 flex-wrap"
          style={{ borderBottom: edge(10), background: wash("--error", 8), boxShadow: "inset 2px 0 0 var(--error)" }}>
          <div className="flex-1 min-w-[240px]">
            <span className="text-[12.5px]" style={{ color: "var(--error)" }}>
              It has nowhere to work, so it will decline every task — including the ones you add below.
            </span>
            {/* The why and the one action that ends it, under the line that
                states the consequence. Without these two the banner names a
                state and leaves the reader to guess how they got into it. */}
            <div className="text-[11.5px] mt-1" style={{ color: "var(--text3)" }}>
              {nowhereLine(reason).why}{" "}
              <span style={{ color: "var(--text2)" }}>{nowhereLine(reason).fix}</span>
            </div>
          </div>
          {renaming === null
            ? <Chip on onClick={() => setRenaming(openProject)}>Pick a checkout</Chip>
            : null}
        </div>
      )}

      {/*
        * A REVISION CLOUD, which is how a drawing says "this changed and you
        * need to look". Drawn AROUND the row rather than filling it, so a set
        * with one question in it still reads as a set — a full-width banner
        * never does. The numbered diamond beside it is the drawing's own mark.
        *
        * This is the only place this panel uses red. Everything else that went
        * wrong is stamped `void`, and void is grey: the sheet is kept, it is
        * simply not to be built from. Red means a person is being asked.
        */}
      {help.length > 0 && (
        <div className="px-4 py-3" style={{ borderBottom: edge(10) }}>
          {help.map((h, i) => (
            <div key={h.id} className="agx-cloud px-3 py-2.5 mb-1.5 flex gap-3 items-start">
              <span className="agx-revtag"><span>{i + 1}</span></span>
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px]" style={{ fontWeight: 600 }}>{h.title}</div>
                <div className="text-[12px] mt-0.5" style={{ color: "var(--error)" }}>{h.question}</div>
                {openHelp && h.tried && (
                  <pre className="m-0 mt-1.5 p-1.5 overflow-auto agx-scroll text-[10.5px] leading-snug whitespace-pre-wrap"
                    style={{ background: wash("--text", 4), border: edge(8), borderRadius: 4, maxHeight: 150, color: "var(--text3)" }}>
                    {h.tried}
                  </pre>
                )}
                <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                  <span className="text-[10.5px] tabular-nums" style={{ color: "var(--text4)" }}>{when(h.at)}</span>
                  {h.tried && (
                    <button className="agx-linkish text-[11px]" style={{ color: "var(--text4)" }}
                      onClick={() => setOpenHelp((v) => !v)}>
                      {openHelp ? "hide what it tried" : "read what it tried"}
                    </button>
                  )}
                  <Chip onClick={() => {
                    /* The answer to "I could not" is almost always a better
                       written sheet, and that box is directly below. */
                    setTitle(h.title);
                    setDetail(h.question);
                    void post("/understudy/help/answered", { id: h.id }).then(load);
                    taskBox.current?.focus();
                  }}>Reissue with a note</Chip>
                  <Chip onClick={() => void post("/understudy/help/answered", { id: h.id }).then(load)}>Answered</Chip>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {!answered && (
        <div className="px-4 py-3" style={{ borderBottom: edge(10), background: wash("--error", 8) }}>
          <span className="text-[12.5px]" style={{ color: "var(--error)" }}>
            The server did not answer, so nothing here is current.
          </span>
        </div>
      )}

      {/*
        * SAY WHAT TO DO. One line, and it is the first thing under the header
        * because it is the only thing anybody comes here to type.
        *
        * Measured before this: 108 of 108 runs came from this box and none
        * from any other source, and the box sat BELOW the buttons that run it,
        * under a heading called "Give it something", with the list it fills
        * invisible. Enter queues, Shift+Enter opens the detail — so the common
        * case is one line and one key.
        */}
      <div className="px-4 pt-4 pb-3.5">
        <div className="flex items-stretch">
          <input
            ref={taskBox}
            className="agx-input flex-1 min-w-0"
            style={{ borderRadius: "7px 0 0 7px", borderRight: 0, fontSize: 13.5, padding: "10px 12px" }}
            placeholder="What should it do next? One feature, one branch."
            value={title}
            maxLength={300}
            disabled={!allowed.length}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              /* Shift+Enter opens the detail rather than queueing: the second
                 box is for the file and the reasoning, and a task that needs
                 them is exactly the task you do not want queued half-written. */
              if (e.shiftKey) { setDetailOpen(true); return; }
              void queue();
            }}
          />
          <select className="agx-input" style={{ borderRadius: "0 7px 7px 0", fontSize: 12 }}
            value={repo} onChange={(e) => setRepo(e.target.value)}
            aria-label="Which checkout" title={repo} disabled={!allowed.length}>
            {allowed.length
              ? allowed.map((r) => <option key={r} value={r}>{leaf(r)}</option>)
              : <option>—</option>}
          </select>
        </div>
        {detailOpen && (
          <textarea
            className="agx-input w-full mt-1.5"
            rows={2}
            autoFocus
            placeholder="The reasoning, the file, what done looks like."
            value={detail}
            maxLength={8000}
            onChange={(e) => setDetail(e.target.value)}
          />
        )}
        <div className="flex items-center gap-3.5 mt-1.5 text-[10.5px]" style={{ color: "var(--text4)" }}>
          {allowed.length ? (
            <>
              <span><kbd className="agx-kbd">⏎</kbd> adds it to the list</span>
              <span><kbd className="agx-kbd">⇧⏎</kbd> {detailOpen ? "detail is open below" : "adds the detail underneath"}</span>
            </>
          ) : (
            <span>Nothing can be queued until it has somewhere to work.</span>
          )}
          <span className="flex-1" />
          {/*
            * THE FENCE, NAMED. "3 checkouts · change" is a status line, and
            * this is the setting that decides where a machine may write —
            * asked in as many words: "where is that config that limits it?".
            * It says what it is, and what it is currently set to.
            */}
          {renaming === null && allowed.length > 0 && (
            <button className="agx-linkish" onClick={() => setRenaming(openProject)}
              style={{ color: "var(--text4)" }}
              title={`It may only work inside ${openProject || "the open project"}:\n${allowed.join("\n")}`}>
              may work in: {openProject || "(not set)"} · change
            </button>
          )}
        </div>
        {renaming !== null && (
          <div className="mt-2">
            {/*
              * PICK, DO NOT TYPE.
              *
              * This was an empty text field: no list of what was valid, no sense
              * of what existed on the machine, and a name matching every
              * checkout refused by a rule nobody could see. It is the setting
              * that decides where a machine writes files.
              *
              * Each row says what choosing it would open up, BEFORE it is
              * chosen. Typing stays underneath as the escape hatch it was always
              * meant to be — for a project the app has never met.
              */}
            <div className="text-[11px] mb-1.5" style={{ color: "var(--text3)" }}>
              It may only cut inside the checkouts of one project. Everything else is refused by the routes,
              whatever is on the set.
            </div>
            {projects.map((p) => (
              <button
                key={p.name}
                className="agx-work-item flex items-baseline gap-2.5 w-full text-left px-2 py-1.5"
                style={{
                  border: 0, cursor: "pointer",
                  background: p.name === openProject ? wash("--primary", 8) : "transparent",
                  boxShadow: p.name === openProject ? "inset 2px 0 0 var(--primary)" : undefined,
                }}
                onClick={() => { setRenaming(p.name); void renameTo(p.name); }}>
                <span style={{ color: p.name === openProject ? "var(--primary)" : "var(--text4)", fontSize: 11 }}>
                  {p.name === openProject ? "●" : "○"}
                </span>
                <span className="flex-1 min-w-0 text-[12.5px]" style={{ fontWeight: p.name === openProject ? 600 : 400 }}>
                  {p.name}
                </span>
                <span className="text-[10.5px]" style={{ color: "var(--text4)" }}>
                  {p.checkouts === 1 ? "1 checkout" : `${p.checkouts} checkouts`}
                </span>
              </button>
            ))}
            <div className="flex items-center gap-2 flex-wrap mt-2">
            <input
              className="agx-input flex-1 min-w-[220px]"
              value={renaming}
              autoFocus
              placeholder="a project this machine has not seen yet…"
              onChange={(e) => setRenaming(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void rename();
                if (e.key === "Escape") setRenaming(null);
              }}
            />
            <Chip on onClick={() => void rename()}>Use that</Chip>
            <Chip onClick={() => setRenaming(null)}>Cancel</Chip>
            <TrackerFence
              scope={scope}
              onFlip={() => { void post("/understudy/propose-scope",
                { scope: scope === "everywhere" ? "open-only" : "everywhere" }).then(load); }}
            />
            </div>
          </div>
        )}
      </div>

      {/*
        * PUT IT TO WORK. One button, and it starts a shift.
        *
        * Measured: 107 of 108 runs were worked under a shift and exactly one
        * was not, so the two controls that competed with it — "work the next
        * one" and "keep going until there is nothing left" — were a choice
        * nobody was making, laid out as if it mattered. The shift's own limits
        * are what it says beside the button instead of a separate row.
        *
        * Stopping is deliberately NOT the primary button. The blue one is
        * whatever moves the work forward, and while it is already working
        * that is nothing at all.
        */}
      {(() => {
        const bar = runBar({
          working: shift?.state === "running",
          minsLeft: Math.ceil((shift?.msLeft ?? 0) / 60_000),
          tasksLeft: shift?.actionsLeft ?? 0,
          queued: queued?.length ?? 0,
          hasNext: Boolean(next),
          busy: busy !== null,
          allowed: allowed.length,
        });
        return (
          <div className="px-4 pb-4 flex items-center gap-3 flex-wrap">
            {bar.stopping
              ? <Chip onClick={() => void takeBack()}>Hold after this sheet</Chip>
              : <Chip primary disabled={!bar.enabled} onClick={() => void handOver()}>{bar.does}</Chip>}
            <span className="text-[11.5px]" style={{ color: "var(--text3)" }}>{bar.says}</span>
          </div>
        );
      })()}

      {problem && (
        <p role="alert" className="m-0 px-4 py-2 text-[11.5px]"
          style={{ color: "var(--error)", background: wash("--error", 8), borderBottom: edge(10) }}>
          {problem}
        </p>
      )}

      {busy && (
        <p role="status" className="m-0 px-4 py-2 text-[11.5px]"
          style={{ color: "var(--primary)", background: wash("--primary", 8), borderBottom: edge(10) }}>
          {busy} You can close this — it does not stop when the tab does.
        </p>
      )}

      {/*
        * WATCHING IT WORK, rather than being told it is working.
        *
        * The run happens in a real tmux window in this project's engine
        * session, and this is that window, read every two seconds. Before it,
        * a task was twenty-five minutes of one fixed sentence: no file, no
        * step, no way to tell working from stuck.
        *
        * Read-only on purpose. It is a picture of a pane, not the pane — the
        * command to sit down at it properly is underneath, because taking over
        * an agent mid-task is a thing to do deliberately.
        */}
      {noPaneWhy && (
        <p className="m-0 px-4 py-2 text-[11.5px]" style={{ color: "var(--text3)", borderBottom: edge(10) }}>
          Working, but not where you can watch it — {noPaneWhy}. The run itself is unaffected.
        </p>
      )}

      {pane && (
        <div className="px-4 py-2.5" style={{ borderBottom: edge(10) }}>
          <div className="flex items-baseline gap-2 flex-wrap" style={{ marginBottom: 6 }}>
            <span className="panel-eyebrow" style={{ margin: 0 }}>Over its shoulder</span>
            <span className="chip" style={{ color: "var(--primary)" }}>{pane}</span>
            <span className="flex-1" />
            <code className="text-[10.5px]" style={{ color: "var(--text4)" }}>
              tmux select-pane -t {pane}
            </code>
          </div>
          {/* 12px and a taller box. At 10.5 in a 260px window this was
              legible only by leaning in — "very tiny and nothing can be made out" —
              and the pane it reads is 200 columns now, so there is width to
              spend on the text rather than on truncating it. */}
          <pre ref={overRef} className="m-0 p-2.5 overflow-auto agx-scroll text-[12px] leading-relaxed"
            style={{
              background: wash("--text", 4), border: edge(8), borderRadius: 4,
              maxHeight: 340, color: "var(--text2)", whiteSpace: "pre",
            }}>
            {over || "waiting for it to print something…"}
          </pre>
        </div>
      )}

      {/*
        * THE LIST, which is the screen.
        *
        * It was invisible: the queue you fill was rendered as a footnote under
        * the box that fills it, and the panel's own "next up" showed one item
        * with no sense of what came after. The numbers are earned here — they
        * are the order it will work them in, which is information, not
        * decoration.
        */}
      {(queued ?? []).length > 0 && (
        <ul className="list-none p-0 m-0" style={{ borderTop: edge(8) }}>
          {(queued ?? []).map((q, i) => (
            <li key={q.id} className="agx-work-item flex items-baseline gap-2.5 px-4 py-2"
              style={{ borderBottom: edge(6) }}>
              <span className="text-[11px] tabular-nums text-right" style={{ width: 14, color: "var(--text4)" }}>
                {i + 1}
              </span>
              <span className="flex-1 min-w-0 text-[12.5px] truncate" title={q.detail || q.title}>{q.title}</span>
              <span className="text-[10.5px]" style={{ color: "var(--text4)" }} title={q.repo}>{leaf(q.repo)}</span>
              <button className="agx-work-x" aria-label={`Take "${q.title}" off the list`}
                onClick={() => { void post("/understudy/work/unask", { id: q.id }).then(load); }}>×</button>
            </li>
          ))}
        </ul>
      )}

      {/*
        * What it has done.
        *
        * The worktree path is on every row, including the successful ones,
        * because that is where the branch is and nothing was pushed — the only
        * way to see the work is to go to the directory. A failed run keeps its
        * worktree deliberately, so discarding one is a decision somebody makes
        * after reading it rather than something the loop tidies away.
        */}
      <div className="px-4 py-2.5">
        {/* A register of issued sheets, not a feed. The tally is what somebody
            checks; the rows are what they open. */}
        <div className="text-[10px] pb-1.5 tracking-wide uppercase" style={{ color: "var(--text4)" }}>
          Register of issued sheets
          {runs.length > 0 && <>
            {" · "}<span style={{ color: "var(--success)" }}>{runs.filter((r) => r.state === "done").length} approved</span>
            {runs.some((r) => r.state === "failed" || r.state === "empty" || r.state === "uncommitted") && <>
              {" · "}<span>{runs.filter((r) => r.state === "failed" || r.state === "empty" || r.state === "uncommitted").length} void</span>
            </>}
          </>}
        </div>
        {runs.length === 0 ? (
          <Empty what="runs" where="" note="Nothing has been worked yet." />
        ) : (
          <ul className="list-none p-0 m-0 grid gap-2">
            {runs.map((r) => (
              <li key={r.id} className="grid gap-1 py-1.5" style={{ borderTop: edge(8) }}>
                <div className="flex items-baseline gap-2 flex-wrap">
                  {/* A stamp, not a state name. See `stampFor`: three words
                      replace four, and `void` says the sheet is kept but not
                      to be built from — which "failed" never said. */}
                  {(() => { const st = stampFor(r.state); return (
                    <span className="agx-stamp" style={{ color: `var(--${st.tone})` }}>{st.word}</span>
                  ); })()}
                  <span style={{ fontSize: 12.5, flex: "1 1 200px", minWidth: 0 }}>{r.title}</span>
                  <span className="text-[11px] tabular-nums" style={{ color: "var(--text4)" }}>
                    {when(r.startedAt)} · {took(r)}
                  </span>
                </div>
                <div className="flex items-center gap-2 flex-wrap text-[11px]" style={{ color: "var(--text3)" }}>
                  {/* THE PATH LEAVES THE ROW. Seventy-eight characters of
                      worktree on eighty rows was the single largest block of
                      text in the panel, and it is one path anybody wants at a
                      time. It stays reachable — on the branch name's hover, and
                      in the outcome underneath. */}
                  <code style={{ fontSize: 11 }} title={r.worktree}>{r.branch}</code>
                  {(r.state === "failed" || r.state === "empty") && (() => {
                    /* `empty` is always genuinely commit-free by its own
                       definition. `failed` is not: the sweep spares exactly
                       the branches that have commits on them, which is the
                       "nothing else to lose" tooltip's own claim proven
                       false — read the count it left behind instead of
                       repeating the claim unconditionally. */
                    const spared = commitsSpared(r.outcome);
                    const title = spared > 0
                      ? `Removes the worktree. ${spared} commit${spared === 1 ? "" : "s"} on ${r.branch} that nobody has merged goes with it.`
                      : "Removes the worktree. Nothing was committed, so there is nothing else to lose.";
                    return (
                      <Chip danger onClick={() => void discard(r)} title={title}>
                        Throw it away
                      </Chip>
                    );
                  })()}
                </div>
                {r.state === "uncommitted" && (
                  // The one line this state exists to put in front of somebody:
                  // the work is real and it is sitting right there uncommitted.
                  // No discard chip here — unlike `failed`, there is no commit
                  // yet, so the worktree is the ONLY copy of what it did.
                  <div className="text-[11px]" style={{ color: "var(--warning)" }}>
                    Tests pass, but it never committed. Nothing pushed either — go commit it by hand, or look at why it stopped.
                  </div>
                )}
                {r.state === "empty" && (
                  // No commit, nothing uncommitted either — the tree was clean
                  // because nothing was ever written to it. Say that plainly
                  // rather than let it read like a quiet success.
                  <div className="text-[11px]" style={{ color: "var(--warning)" }}>
                    It finished having produced nothing — no commit, and its own last words did not say why that was the right answer.
                  </div>
                )}
                {r.outcome && (
                  /*
                   * THE VERDICT, THEN THE DUMP — and the dump only when asked.
                   *
                   * This was a 140px scrolling block on EVERY row. Eighty rows
                   * of agent transcript is what "there is a lot of overwhelming info"
                   * looks like: the list of what it has done became unreadable
                   * as a list, which is the only thing a list is for.
                   *
                   * The first line of an outcome is the verdict — "4251 pass, 0
                   * fail", "tests failed", "no commit on the branch" — so that
                   * is what the row shows. Everything under it is still one
                   * click away, and nothing is truncated once it is open.
                   */
                  <div>
                    {/* Quieter than the task it belongs to. Rendered as an
                        underlined link at the row's own size, the verdict read
                        as the headline and the task title read as a caption —
                        the hierarchy upside down on every row. */}
                    <button className="text-[11px] text-left"
                      style={{ color: "var(--text3)", background: "none", border: 0, padding: 0, cursor: "pointer" }}
                      aria-expanded={openOutcome === r.id}
                      onClick={() => setOpenOutcome((v) => (v === r.id ? null : r.id))}>
                      {firstLine(r.outcome) || "no verdict recorded"}
                      <span className="agx-linkish" style={{ color: "var(--text4)", marginLeft: 6 }}>
                        {openOutcome === r.id ? "less" : "more"}
                      </span>
                    </button>
                    {openOutcome === r.id && (
                      <pre className="m-0 mt-1 p-1.5 overflow-auto agx-scroll text-[10.5px] leading-snug"
                        style={{ background: wash("--text", 4), border: edge(8), borderRadius: 4, maxHeight: 320, color: "var(--text3)" }}>
                        {r.outcome}
                      </pre>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
