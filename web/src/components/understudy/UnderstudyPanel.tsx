/*
 * The understudy view: what it would have done, how often that matched, and
 * everything it is not allowed to do.
 *
 * The one rule this whole panel is built on: THE CLIENT DERIVES NOTHING. The
 * server sends `mode`, `offered` and a list of sentences saying what is in the
 * way; this file renders them. There is no threshold here, no bound, no
 * arithmetic that could disagree with the arithmetic on the other side of the
 * socket — web/test/understudy-no-thresholds.test.ts reads these files and
 * fails if one appears. A gate about autonomy has to have exactly one
 * implementation, and the one that ships in a cached bundle is not it.
 *
 * The second rule, which is the same rule pointed at safety: A SEAL IS A TEST
 * RESULT, NOT A BUTTON. The design this came from let you click the six seals
 * on and off, which is a user interface that grants autonomy by clicking. They
 * are read-only here, and four of the six read "never run" — because they are
 * proofs about ACTING, held by tests rather than by a run — see the note there
 * for them to have passed.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { UnderstudyClassRow, UnderstudyFrame, UnderstudyMode } from "../../../../shared/types.ts";
import { SERVER, authHeaders } from "../../lib/api.ts";
import { getUnderstudy, refreshUnderstudy, subscribeUnderstudy } from "../../lib/understudyStore.ts";
import { ViewHeader } from "../workspace/ViewHeader.tsx";
import { CHIP_ICON, Chip, IconChip, Segmented, Tabs } from "../workspace/Chrome.tsx";
import { Empty, edge, wash } from "../git/ui.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { Persona } from "./persona/Persona.tsx";
import { Teach } from "./Teach.tsx";
import { Ask } from "./Ask.tsx";
import { Work } from "./Work.tsx";
import { useCosmetic } from "./persona/cosmeticStore.ts";
import { openSettings } from "../../lib/openSettings.ts";

/**
 * How long the understudy's own two stores are kept.
 *
 * MIRRORED from `UNDERSTUDY_SNAPSHOT_DAYS` and `UNDERSTUDY_STUB_DAYS` in
 * server/src/db.ts, which is where the sweep that enforces them lives. A number
 * copied into a second file is a number that drifts, so it does not get to
 * drift quietly: web/test/understudy-no-thresholds.test.ts reads db.ts and
 * fails if these two stop matching it.
 *
 * Copied at all because the browser cannot import a module that opens a SQLite
 * database. The right fix is to put both on `UnderstudyFrame`, next to the seal
 * counts they belong beside, at which point this constant goes away rather than
 * being kept in step by a test.
 */
export const RETENTION = {
  /** The sealed situations, which is the material it read. */
  snapshotDays: 30,
  /** The bare fact of a write. Decisions and refusals never expire: they are
   *  the score, and a score with holes in it is not a score. */
  stubDays: 90,
} as const;

/* ------------------------------------------------------------- the ladder */

interface Rung {
  mode: UnderstudyMode;
  name: string;
  what: string;
}

/**
 * The four rungs, named — and the names matter more than they look.
 *
 * `UnderstudyMode` is the vocabulary the server and the type share; these are
 * the words a person uses about a colleague, which is the question the ladder
 * actually answers. A rung is not a setting: the frame's `level` is a CEILING,
 * the highest rung anything in this build may occupy, and in v1 it is the
 * first one.
 */
const LADDER: readonly Rung[] = [
  {
    mode: "shadow",
    name: "Observer",
    what: "Writes down what it would have done, and is scored against what you did. It says nothing and changes nothing.",
  },
  {
    mode: "guided",
    name: "Advisor",
    what: "Proposes, where the decision is already being made. A person presses; it never presses.",
  },
  {
    mode: "auto-undo",
    name: "Deputy",
    what: "Acts where the act is reversible, says so, and leaves the undo where you can reach it.",
  },
  {
    mode: "auto",
    name: "Stand-in",
    what: "Acts on a branch other people pull, or somewhere off this machine. Nothing reaches here, and no measurement puts anything here: a scorecard can say a class is earned and cannot say that being wrong on somebody else's branch would be cheap.",
  },
];

const rungFor = (mode: UnderstudyMode): Rung => LADDER.find((r) => r.mode === mode) ?? LADDER[0]!;




/**
 * What the understudy says about itself, in the first person.
 *
 * One sentence, and it earns its place: the state this panel spends most of its
 * life in is "nothing has happened yet", and a person reading thirteen rows of
 * zeros cannot tell that apart from a broken feature. Somebody saying they have
 * nothing to report is unmistakably working.
 */
function says(frame: UnderstudyFrame, offered: number, scored: number): string {
  if (frame.halted) return "I have stopped. I am writing nothing down, and every class is back in shadow.";
  if (!frame.enabled) return "I am switched off, so none of this is being recorded. The switch is in Settings, under Clone.";
  if (scored === 0) {
    return "I have written nothing down yet. I am watching thirteen kinds of decision; none has enough of your own for me to be scored on.";
  }
  if (offered === 0) {
    return "I am being scored, and none of the thirteen has met the bar yet. Being scored is not the same as being trusted with anything.";
  }
  const n = offered === 1 ? "One of the thirteen has" : `${offered} of the thirteen have`;
  return `${n} met the bar. I still press nothing — this build has no rung above the first, so being offered is as far as it goes.`;
}

/* -------------------------------------------------------------- the seals */

/*
 * `proven` is the state that was missing, and its absence was making the panel
 * understate itself.
 *
 * Four of these seals are properties of the CODE — no tools on a child, no
 * shell reachable, a halt that unwinds — and there is no runtime measurement
 * that could turn them green, because they are not about what happened, they
 * are about what cannot. They read "never run" for months, which was true of
 * the measurement and false about the claim.
 *
 * It is deliberately not `green`. Green means "measured on your data and it
 * held"; proven means "the code cannot do otherwise, and a test fails if that
 * changes". Collapsing them would let a structural argument borrow the weight
 * of an observation.
 */
type SealState = "green" | "proven" | "red" | "waiting" | "never-run";

interface Seal {
  id: string;
  name: string;
  note: string;
  /** `null` for the ones no run has produced a result for. */
  measure: ((f: UnderstudyFrame) => SealState) | null;
  /*
   * When this seal last failed, 0 for never.
   *
   * A coverage gap keeps its counter red for as long as the window is wide,
   * and without this nothing here could tell a seam that is still broken from
   * one that was fixed hours ago — both showed the same red number. An honest
   * indicator that cannot distinguish those is one people learn to skip.
   */
  since?: (f: UnderstudyFrame) => number;
}

/** "at 12:21", or nothing at all when it never happened. */
function lastFailed(seal: Seal, f: UnderstudyFrame): string {
  const at = seal.since?.(f) ?? 0;
  if (!at) return "";
  const d = new Date(at);
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * Six seals, and the honest state of each.
 *
 * Two of them are checkable from the frame itself, because they are properties
 * of the ledger rather than of a build: whether every answer had a sealed
 * situation in front of it, and whether any prediction arrived after the answer
 * it was predicting. Those are the two that make a score mean anything, and
 * they are measured continuously rather than proven once.
 *
 * The other four are engineering proofs about ACTING — a shell that free text
 * cannot reach, a child agent with no tools of ours, a push that fails from
 * inside one, a halt that puts everything back.
 *
 * They read `never run` for months, honestly: nothing acted, so there was
 * nothing to observe, and a green tick for a test that has never been executed
 * is the most expensive lie a safety panel can tell. That is no longer the
 * state. Each is now held by a test that fails if the property stops being
 * true, so they read `proven` — deliberately not `green`.
 *
 * The difference is the whole reason for having two words. Green means
 * "measured against your data and it held". Proven means "the code cannot do
 * otherwise". Collapsing them would let a structural argument borrow the weight
 * of an observation, which is the same dishonesty as the green tick in better
 * clothes.
 */
const SEALS: readonly Seal[] = [
  {
    id: "sealed-first",
    name: "every answer had a sealed situation in front of it",
    note: "An answer with no seal before it cannot be scored honestly, so it is counted rather than dropped.",
    measure: (f) => (f.seals.sealed + f.seals.unsealed === 0 ? "waiting" : f.seals.unsealed === 0 ? "green" : "red"),
    since: (f) => f.seals.lastUnsealed,
  },
  {
    id: "no-hindsight",
    name: "no prediction arrived after the answer",
    note: "A late prediction is kept and scored — dropping them would quietly select for the easy situations — and counted here because it is the one that could have seen the answer.",
    measure: (f) => (f.seals.predicted === 0 ? "waiting" : f.seals.late === 0 ? "green" : "red"),
    since: (f) => f.seals.lastLate,
  },
  {
    id: "no-shell",
    name: "argv and free text cannot reach a shell",
    note: "The clone's allowlist holds two routes, neither of which runs anything. Asserted by name, so adding one fails a test.",
    measure: () => "proven",
  },
  {
    id: "no-tools",
    name: "a child agent is offered none of this app's tools",
    note: "The judge is the only agent it starts, and its argv carries an empty tool list and no permission bypass.",
    measure: () => "proven",
  },
  {
    id: "no-push",
    name: "a push fails from inside a child agent",
    note: "That agent runs in /tmp with no repository, no token and no tools — two independent reasons it cannot push.",
    measure: () => "proven",
  },
  {
    id: "halt-restores",
    name: "a halt mid-sequence puts everything back",
    note: "Halt stops the shift and unwinds every act it made, newest first, and does not abandon the rest if one fails.",
    measure: () => "proven",
  },
];

const SEAL_COLOUR: Record<SealState, string> = {
  green: "var(--success)",
  proven: "var(--primary)",
  red: "var(--error)",
  waiting: "var(--text4)",
  "never-run": "var(--text4)",
};

const SEAL_WORD: Record<SealState, string> = {
  green: "green",
  proven: "proven in the code",
  red: "red",
  waiting: "nothing to measure yet",
  "never-run": "never run",
};

function SealMark({ state }: { state: SealState }) {
  const colour = SEAL_COLOUR[state];
  return (
    <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 24 24" fill="none" stroke={colour} strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0 mt-0.5">
      <circle cx="12" cy="12" r="9" opacity={state === "green" || state === "red" ? 1 : 0.45} />
      {state === "green" && <path d="M8 12.5l2.6 2.5L16 9.5" />}
      {state === "red" && <path d="M9 9l6 6M15 9l-6 6" />}
      {(state === "waiting" || state === "never-run") && <path d="M8.5 12h7" opacity="0.55" />}
    </svg>
  );
}

/* ----------------------------------------------------------- the two POSTs */

async function post(path: string, body: unknown): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(SERVER + path, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({})) as { ok?: boolean; error?: string };
    if (!r.ok || j.ok === false) return { ok: false, error: j.error || `the server answered ${r.status}` };
    return { ok: true };
  } catch {
    return { ok: false, error: "could not reach the server" };
  }
}

/** Stop it. No confirmation and no arguments: a stop that needs a well-formed
 *  request is a stop that can fail to arrive. */
export const haltUnderstudy = (): Promise<{ ok: boolean; error?: string }> => post("/understudy/halt", {});

/**
 * Switch it on or off — and the one path that also lifts a halt.
 *
 * `halted` and `enabled` are two different facts (see UnderstudyFrame): halting
 * leaves it enabled and stopped, and switching it back on is the explicit act
 * that lowers the fence. There is no timer, which is the point.
 *
 * Exported because Settings owns the master switch and this view owns the
 * resume, and both are the same request.
 */
export const setUnderstudyEnabled = (on: boolean): Promise<{ ok: boolean; error?: string }> =>
  post("/understudy/enable", { on });

/**
 * The scorecard, as a hook.
 *
 * The store's snapshot is identity-cached — it hands back the same object until
 * the scorecard actually changes — which is the whole reason useSyncExternalStore
 * can be pointed straight at it. Do not wrap this in a map or a sort: a fresh
 * array per render is a fresh identity per render, and React answers that by
 * painting nothing at all.
 */
export function useUnderstudy(): UnderstudyFrame | null {
  return useSyncExternalStore(subscribeUnderstudy, getUnderstudy, getUnderstudy);
}

/* ------------------------------------------------------------- the panels */

/*
 * One number and what it counts, for a header that had three of them and no
 * data behind any.
 *
 * Tabular figures because they sit in a row and a row of proportional digits
 * reads as ragged; the label under rather than beside, so a long one wraps
 * without pushing the next figure along.
 */
function Standing({ value, label, tone }: { value: string; label: string; tone?: string }) {
  return (
    <span className="inline-flex flex-col leading-none">
      <span className="text-[17px] font-semibold tabular-nums tracking-tight"
        style={{ color: tone ?? "var(--text)" }}>{value}</span>
      <span className="text-[10px] uppercase mt-1" style={{ letterSpacing: ".1em", color: "var(--text4)" }}>{label}</span>
    </span>
  );
}

function PanelHead({ eyebrow, title, right }: { eyebrow: string; title: string; right?: React.ReactNode }) {
  return (
    <div className="panel-h">
      <div className="min-w-0">
        <div className="panel-eyebrow">{eyebrow}</div>
        <div className="panel-title truncate">{title}</div>
      </div>
      {right && <span className="flex items-center gap-2 shrink-0">{right}</span>}
    </div>
  );
}

/** The small print under a panel — what the thing above it is actually made
 *  of. Every panel in this view has one, because a scorecard whose provenance
 *  is not on the same screen is a number you have to take on trust. */
function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="m-0 px-4 py-3 text-[10px] leading-relaxed" style={{ color: "var(--text3)", borderTop: edge(8) }}>
      {children}
    </p>
  );
}


function Seals({ frame }: { frame: UnderstudyFrame }) {
  const states = SEALS.map((s) => ({ seal: s, state: s.measure ? s.measure(frame) : ("never-run" as SealState) }));
  const green = states.filter((s) => s.state === "green").length;
  return (
    <>
      <PanelHead eyebrow="Safety" title="Seals of autonomy"
        right={<span className="chip t-dim tabular-nums">{green} of {SEALS.length} green</span>} />
      <div className="px-4 pb-1 flex flex-col gap-2.5">
        {states.map(({ seal, state }) => (
          <div key={seal.id} className="flex items-start gap-2">
            <SealMark state={state} />
            <span className="min-w-0 flex flex-col gap-0.5">
              <span className="text-[11.5px] leading-snug" style={{ color: state === "green" ? "var(--text2)" : "var(--text3)" }}>
                {seal.name}
              </span>
              <span className="text-[11.5px]" style={{ color: SEAL_COLOUR[state] }}>{SEAL_WORD[state]}</span>
              <span className="text-[11.5px] leading-relaxed" style={{ color: "var(--text3)" }}>{seal.note}</span>
            </span>
          </div>
        ))}
      </div>
      <Note>
        A seal is a test result, not a switch — a panel where you can click autonomy green is
        a panel that grants it. Four of the six are proofs about the code rather than readings off your data, so they say proven rather than green.
      </Note>
    </>
  );
}



/* ------------------------------------------------------------ the strip */




/* ---------------------------------------------------------------- the view */

export function UnderstudyView({ active }: { active: boolean }) {
  const frame = useUnderstudy();
  const cos = useCosmetic();
  /* Scorecard, or the evidence behind it. Tabs rather than a fourth column:
     the ledger is a different question ("can I believe this") asked at a
     different moment, and squeezing it beside the scorecard would have made
     both narrower than either deserves. */
  const [tab, setTab] = useState<"work" | "ask" | "teach">("work");

  /*
   * What it knows and what it has finished.
   *
   * Cheap enough to sit in a header — four COUNTs — and deliberately not part
   * of the work tab's own load, which asks every source what it is holding and
   * therefore reaches the network. Refetched when the panel is shown rather
   * than polled: neither number moves without somebody doing something.
   */
  const [standing, setStanding] = useState<
    { precedents: number; rules: number; done: number; failed: number; stuck: number } | null>(null);
  useEffect(() => {
    if (!active) return;
    let gone = false;
    void (async () => {
      try {
        const r = await fetch(SERVER + "/understudy/standing", { headers: authHeaders() });
        const b = (await r.json()) as
          { ok?: boolean; precedents?: number; rules?: number; done?: number; failed?: number; stuck?: number };
        if (!gone && b?.ok) {
          setStanding({
            precedents: b.precedents ?? 0, rules: b.rules ?? 0,
            done: b.done ?? 0, failed: b.failed ?? 0, stuck: b.stuck ?? 0,
          });
        }
      } catch { /* the header simply carries no figures */ }
    })();
    return () => { gone = true; };
  }, [active]);

  /*
   * 7d / 30d / All.
   *
   * Held in a ref as well as in state because the two effects that refresh are
   * not re-run when the window changes; they read the current one instead of
   * closing over a stale value and quietly asking for `all` forever.
   */
  const [windowDays, setWindowDays] = useState<number | null>(30);
  const windowRef = useRef<number | null>(30);
  const pickWindow = useCallback((d: number | null) => {
    windowRef.current = d;
    setWindowDays(d);
    void refreshUnderstudy(d);
  }, []);
  const [problem, setProblem] = useState<string | null>(null);

  /*
   * The cold start.
   *
   * The socket is the normal path and it pushes on the SERVER's clock: a window
   * opened between two recomputes has never seen a frame, and a panel that says
   * "nothing yet" over a scorecard the server has been holding for ten minutes
   * is the panel being wrong about the only thing it says.
   */
  useEffect(() => {
    if (!active) return;
    void refreshUnderstudy(windowRef.current);
  }, [active]);

  const act = useCallback(async (run: () => Promise<{ ok: boolean; error?: string }>) => {
    const r = await run();
    setProblem(r.ok ? null : r.error ?? "that did not work");
    // The server broadcasts a fresh frame on success, but a client that only
    // ever learns from a broadcast cannot tell a slow socket from a refusal.
    void refreshUnderstudy(windowRef.current);
  }, []);

  if (!frame) {
    return (
      <div className="flex flex-col h-full min-h-0">
        <ViewHeader label="Clone">
          <span className="chip t-dim">connecting</span>
        </ViewHeader>
        <div className="flex-1 min-h-0 grid place-items-start justify-center">
          <Empty what="the scorecard" busy />
        </div>
      </div>
    );
  }

  /*
   * The score the scorecard never showed.
   *
   * `offered` and `scored` were both computed and drawn; `hits` was on every
   * row and summed nowhere, so the one figure this feature is named for — how
   * often it agreed with you — existed on no pixel of the screen. The app's own
   * comment in Feed.tsx describes the scorecard as the assertion "it agreed
   * with you 71% of the time", which was a number nothing rendered.
   *
   * Both of these are read off the frame rather than worked out here. The panel
   * deriving its own version of a measurement is the failure
   * web/test/understudy-no-thresholds.test.ts exists to prevent: two ladders
   * that agree until the day they do not.
   */

  const state: { word: string; colour: string } = frame.halted
    ? { word: "halted", colour: "var(--error)" }
    : !frame.enabled
      ? { word: "off", colour: "var(--text4)" }
      : { word: "watching", colour: "var(--success)" };

  return (
    <div className="flex flex-col h-full min-h-0">
      <ViewHeader
        label="Clone"
        actions={
          <>
            {/* The window scopes what is DISPLAYED. It cannot scope the gate:
                a class that has earned its promotion does not un-earn it
                because somebody left the panel on 7d. */}
            <Segmented
              label="How far back to count"
              value={windowDays === null ? "all" : String(windowDays)}
              options={[{ id: "7", label: "7d" }, { id: "30", label: "30d" }, { id: "all", label: "All" }]}
              onChange={(v) => pickWindow(v === "all" ? null : Number(v))}
            />
            <span className="text-[10px] tabular-nums" style={{ color: "var(--text4)" }}
              title={new Date(frame.asOf).toLocaleString()}>
              computed {new Date(frame.asOf).toLocaleTimeString()}
            </span>
            <IconChip onClick={() => void refreshUnderstudy(windowDays)} title="Read the scorecard again">
              <svg width={CHIP_ICON} height={CHIP_ICON} viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M20 11a8 8 0 1 0-.6 4" />
                <path d="M20 5v6h-6" />
              </svg>
            </IconChip>
            {frame.halted || !frame.enabled
              ? (
                <Chip primary onClick={() => void act(() => setUnderstudyEnabled(true))}
                  title="Switch it back on. Halting leaves it enabled and stopped, and this is the explicit act that lowers the fence — there is no timer.">
                  Resume
                </Chip>
              )
              : (
                <Chip danger onClick={() => void act(haltUnderstudy)}
                  title="Stop recording, and drop every class back to shadow. In this build nothing is ever mid-sequence, so it costs nothing to press.">
                  Halt
                </Chip>
              )}
          </>
        }
      >
        {/*
          The one live region on the screen.

          The frame arrives over a websocket and rewrites the state word and the
          counts with no user action, and there was not one `aria-live` in the
          whole directory — so a screen-reader user could press Halt on an
          autonomy control and be told nothing at all about whether it worked.
          Polite and scoped to the two things worth announcing; the per-row
          numbers stay silent, because thirteen rows re-read on every push is
          not information, it is noise.
        */}
        <span role="status" aria-live="polite" className="flex items-center gap-2">
          <span className="chip" style={{ color: state.colour, background: wash("--text", 6) }}>{state.word}</span>
          {/*
            * The classes chip is gone: it counted rows nothing draws.
            *
            * "13 classes · 0 offered" named the predictor's thirteen decision
            * classes, which had a Scorecard tab until twelve of them turned
            * out never to have held a sample. The tab went; the count stayed,
            * in the most prominent strip of the panel, describing a screen
            * that no longer exists.
            *
            * The state word beside it stays, because that one is live and it
            * is the answer to the only question this strip is asked: is it on.
            */}
        </span>
        {/*
          * THE RAISED HAND, where it can be seen without opening anything.
          *
          * The loop stops and writes a question when a task has failed twice,
          * and until now that question lived one tab down. Measured on the runs
          * that made this necessary: 26 of 108 delivered nothing and not one
          * said what it needed — so the first version of "it asks for help" has
          * to be impossible to walk past.
          */}
        {(standing?.stuck ?? 0) > 0 && (
          <button
            className="chip"
            style={{ color: "var(--warning)", background: wash("--warning", 14), cursor: "pointer", border: 0 }}
            title="It stopped on something and needs an answer"
            onClick={() => setTab("work")}
          >
            {standing!.stuck === 1 ? "1 waiting on you" : `${standing!.stuck} waiting on you`}
          </button>
        )}
        <Tabs
          label="What to show"
          panelId="understudy-body"
          value={tab}
          /*
           * NAMED BY WHAT YOU DO, not by the machinery.
           *
           * "Work", "Ask" and "Teach" are the three capabilities, and they are
           * three genuinely separate jobs — but the words are the concepts
           * behind the feature rather than anything a person came here to do,
           * and they read left to right in the reverse of the order they are
           * used in: you teach it, then you check it, then you hand it work.
           * Somebody opening this for the first time lands on the LAST step.
           */
          options={[
            { id: "work" as const, label: "Its work" },
            /* Beside the clone's own work rather than in a view of its own:
               "es tedioso tener dos vistas", and the two answer the same
               question from opposite sides — what the stand-in did, and what
               everybody else is doing right now. */
            { id: "ask" as const, label: "Try it" },
            { id: "teach" as const, label: "What it knows" },
          ]}
          onChange={setTab}
        />
      </ViewHeader>

      {problem && (
        // role="alert": this only ever appears because something you pressed
        // was refused, and it used to appear silently.
        <div role="alert" className="px-4 py-2 text-[11.5px] shrink-0"
          style={{ color: "var(--error)", background: wash("--error", 8), borderBottom: edge(8) }}>
          {problem}
        </div>
      )}

      {!frame.enabled && !frame.halted && (
        <div className="px-4 py-2 text-[11.5px] shrink-0 flex items-center gap-3 flex-wrap"
          style={{ color: "var(--text2)", background: wash("--warning", 8), borderBottom: edge(8) }}>
          <span>
            The clone is off. It is recording nothing, and the numbers below are the ones it had when it stopped.
          </span>
          {/* The old copy pointed at Settings — and said so twice, once here and
              once in the first person under the portrait — while the control
              that does it is the Resume chip in this view's own header. */}
        </div>
      )}

      {/*
        THE STATUS STRIP, then a master and its detail.

        What this replaces: six `.panel` cards in a `p-3 gap-3` column stack,
        which is DashboardView's shell verbatim — and the five rebuilt views
        (Diff, PRs, Tasks, Docker, Git) use `.panel` zero times between them,
        because 16px is this app's MODAL radius. A workspace body built out of
        it reads as a stack of dialogs, which is exactly what was reported.

        Three columns became two for a reason that is not taste: the old third
        column was a glossary — six seals and three lock kinds, read once and
        then never — and it needed 1,179px inside a 767px column, so the legend
        explaining the colour on all thirteen rows was never on screen at 1080p.
        It belongs beside the class it explains, which is the detail pane.
      */}
      <div className="flex-1 min-h-0 flex flex-col" id="understudy-body" role="tabpanel" aria-label="Scorecard">
        <div className="shrink-0 flex items-center gap-6 flex-wrap px-4 py-3" style={{ borderBottom: edge(14) }}>
          <div className="flex items-center gap-3 min-w-0">
            {/* 64, not 188. The largest element above the fold carried no live
                information and pushed the counts and the seal discipline below
                the fold with it. */}
            <Persona px={64} cos={cos} label="The clone" />
            <span className="min-w-0">
              {/*
                THIS IS A SETTING, NOT A NAME.
                A 13px semibold word beside a portrait is read as the portrait's
                name — reported: "I don't understand why you called it deputy, I'm
                not sure it really fits this". It never was a name:
                the clone is called "the clone" (the label on the portrait), and
                this word is the rung of autonomy it is standing on. So the rung
                says what it is, in the same micro-label every other setting on
                this screen uses.
              */}
              <span className="block text-[9.5px] uppercase tracking-wider" style={{ color: "var(--text4)" }}>
                how much it may do
              </span>
              <span className="block text-[13px] font-semibold tracking-tight font-sans" style={{ color: "var(--text)" }}>
                {frame.halted ? "Halted" : !frame.enabled ? "Off" : rungFor(frame.level).name}
              </span>
              <span className="block text-[11.5px] mt-0.5" style={{ color: "var(--text4)" }}>
                {frame.seals.sealed.toLocaleString()} sealed
                {frame.seals.unsealed > 0 && <> · <span style={{ color: "var(--error)" }}>{frame.seals.unsealed} with no seal</span></>}
              </span>
              <Chip className="mt-1.5" onClick={() => openSettings("understudy")}
                title="Change how it looks — Settings → Clone">
                Appearance
              </Chip>
            </span>
          </div>

          {standing && (
            <div className="flex items-baseline gap-6">
              <Standing value={standing.precedents.toLocaleString()} label="precedents" />
              <Standing value={standing.rules.toLocaleString()} label="rules" />
              <Standing value={standing.done.toLocaleString()} label="worked" />
              {standing.failed > 0 && (
                <Standing value={standing.failed.toLocaleString()} label="broke" tone="var(--error)" />
              )}
            </div>
          )}

          {/*
            * TWELVE CONTROLS THAT GOVERNED NOTHING, and they had the best
            * position on the screen.
            *
            * Two rows — Initiative (off · watching · asked · offering · queued
            * · undo · acting) and Reach (read · draft · its own worktree ·
            * shared branch · outward) — described the predictor's ladder: how
            * far it could go on its own, and how far its reversible acts could
            * reach. That machinery is gone.
            *
            * Counted rather than assumed, in the code the loop actually runs:
            * `setStance`, `setReach` and `stanceFor` have ZERO callers across
            * the loop, the task sources, the shift and the work module. The
            * things that do reach it are `understudyEnabled`, `isHalted`,
            * `openProjectName` and `proposeScope` — on, stopped, where, and
            * whether the tracker may speak.
            *
            * A dial that is wired to nothing is worse than no dial: somebody
            * sets it before walking away and believes they have bounded the
            * thing. What actually bounds a run — the shift, the fence, the
            * disposable worktree — is on the Work tab beside the button that
            * starts it, which is where a limit belongs.
            */}
        </div>

        {tab === "work" && (
          <div className="flex-1 min-h-0 flex flex-col">
            {/* The header already asks for these on every open, so the first-run
                line costs no extra round trip — and `goTo` is how its one button
                reaches the tab that step actually lives in. */}
            <Work active standing={standing} goTo={setTab} />
          </div>
        )}
        {tab === "ask" && <div className="flex-1 min-h-0 flex flex-col"><Ask active /></div>}
        {tab === "teach" && <div className="flex-1 min-h-0 flex flex-col overflow-y-auto agx-scroll"><Teach active /></div>}

      </div>
    </div>
  );
}
