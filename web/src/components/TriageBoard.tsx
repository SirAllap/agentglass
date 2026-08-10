// The pull requests that want something from you, in lanes.
//
// A board rather than a table, and it is only ever a board over the pull
// requests you have a stake in — yours, and the ones you were asked to look at.
// Three hundred and ninety open pull requests are a table; the table is still
// there, one click away, and this never pretends it could show them.
//
// The two pills it replaces were "Mine" and "Needs my review", and they were
// mutually exclusive: the two populations you care about could not be on screen
// together. Here they are two lanes, side by side, which is the whole point.
//
// Nothing is fetched for this. It reads the two lists the panel already loads
// for the pill counts — see stakeFrom in prLanes.ts — so the board costs what
// the pill row cost, and the numbers cannot disagree with their source.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PrSummary } from "../../../shared/types.ts";
import { LANES, LANE_CAP, board as fileAll, suggestedAction, ACTION_LABEL, type Filed } from "../lib/prLanes.ts";
import { taskLink, taskLinkTitle } from "../lib/taskLink.ts";

const edge = (pct: number) => `1px solid color-mix(in srgb, var(--text) ${pct}%, transparent)`;
const TRUNKS = new Set(["main", "master", "trunk", "develop", "development"]);

/** How long nothing may happen before a pull request counts as quiet. */
const QUIET_DAYS = 30;

/**
 * Has nothing at all happened to it in a month?
 *
 * `updatedAt` is the only clock on `PrSummary`, and it is GitHub's "last
 * touched by anything" — a push, a comment, a label. There is no push
 * timestamp on a summary and asking for one would be the per-card request this
 * board exists to avoid, so the footer says what is actually measured: thirty
 * days without a push OR a comment. Everything counted here really has had no
 * push, because a push would have moved this; there may be more that were
 * commented on and never pushed to. A floor, never an invention.
 *
 * A date that will not parse is not quiet. The list arrives in two passes and
 * fixtures hand over empty strings — counting those would put a number on
 * screen whose real meaning is "we could not read it".
 */
function quietAWhile(iso: string): boolean {
  const t = Date.parse(iso);
  return Number.isFinite(t) && Date.now() - t > QUIET_DAYS * 86_400_000;
}

type Card = PrSummary & { filed: Filed };

export function TriageBoard({
  mine, review, total, hasTaskProvider, pinned,
  onOpen, onTogglePin, onShowTable, onAct, busy, loading, pinnedList,
}: {
  /** The `mine` scope, as the panel already has it. */
  mine: PrSummary[];
  /** The `review` scope, likewise. Membership of these two IS the stake. */
  review: PrSummary[];
  /** Every open pull request, for the sentence that states the board's scope. */
  total: number;
  /** Whether anything is connected that could resolve a work-item id — see
   *  taskLink.ts for why a convention-shaped id is hidden without one. */
  hasTaskProvider: boolean;
  pinned: (n: number) => boolean;
  onOpen: (n: number) => void;
  onTogglePin: (p: PrSummary) => void;
  onShowTable: () => void;
  /** Perform the card's one suggested action. Only the ones this app can
   *  really do reach here — see suggestedAction. */
  onAct: (p: PrSummary, what: "open" | "merge" | "rerun") => void;
  /** True while an action is in flight, so a card cannot be pressed twice. */
  busy?: boolean;
  /**
   * The ones you pinned, whoever opened them.
   *
   * Not a lane, and not for want of a column: a pin is a fact about YOU, and
   * the lanes are facts about what a pull request needs. It also reaches
   * further than they do — you can pin a colleague's, which no lane here will
   * ever contain — so filing it in one would be wrong twice.
   *
   * It sits at the foot of the first column, in the same place every time. Two
   * of these columns are usually empty and it is tempting to put it wherever
   * the space happens to be; a thing that moves is a thing you hunt for.
   */
  pinnedList?: { number: number; title: string }[];
  /**
   * The two lists are still being fetched and nothing has arrived yet.
   *
   * Without this the board cannot tell its two zeroes apart: `mine` and
   * `review` start as empty arrays and are replaced when the calls land, so a
   * board that has not loaded renders exactly like a board with nothing on it
   * — five "Nothing here. Good." columns, which is a claim, on no evidence, at
   * the moment the answer is least knowable. Optional because a caller that
   * cannot say gets today's behaviour rather than a wrong wait.
   */
  loading?: boolean;
}) {
  const lanes = useMemo(() => {
    // De-duplicated by number before filing: a pull request that is both yours
    // and asked of you arrives twice, and would otherwise be drawn twice.
    const by = new Map<number, PrSummary>();
    for (const p of [...mine, ...review]) if (!by.has(p.number)) by.set(p.number, p);
    const m = new Set(mine.map((p) => p.number));
    const r = new Set(review.map((p) => p.number));
    return fileAll([...by.values()], (p) => ({ mine: m.has(p.number), asked: r.has(p.number) }));
  }, [mine, review]);

  const cards = useMemo(() => [...lanes.values()].flat(), [lanes]);
  const involved = cards.length;
  const canLand = lanes.get("land")?.length ?? 0;
  // Only over the cards in hand. The other few hundred are not loaded here and
  // never will be — see the footer, which says whose staleness this is.
  const quiet = useMemo(() => cards.filter((p) => quietAWhile(p.updatedAt)).length, [cards]);

  /* Waiting is only waiting while there is nothing to show. A refresh with the
     previous answer still on screen must not blank it: last minute's board is
     a better answer than a skeleton, and it is about to be right again. */
  const waiting = !!loading && involved === 0;
  const rest = total - involved;
  /*
   * Whether `total` can be repeated out loud.
   *
   * It is the panel's count of every open pull request, and it has been wrong:
   * it used to be the CURRENT FILTER's count, which had the board announce
   * "the other 0 are a table" over a repository with 388 open. A total smaller
   * than the board standing in front of it is the one case that is provably
   * wrong from in here — the two lists are the evidence — so every sentence
   * built on it drops its number instead of repeating it. Clamping is how a
   * wrong number gets to sound like a right one.
   */
  const totalKnown = rest >= 0;
  const tableLabel = rest > 0 ? `Show all ${total} as a table` : "Show the table";

  /*
   * The keyboard, and why the cursor is a pair rather than an index.
   *
   * A board has two axes and a flat index has one, so `j` from the bottom of a
   * lane would wrap into the top of the next — which reads as the cursor
   * teleporting. Lane and row, and `j` at the end of a lane simply stops.
   */
  /*
   * The columns actually drawn.
   *
   * `LANES` is the policy; this is the screen. Only one lane opts out of being
   * shown empty — see `hideWhenEmpty` — and everything downstream counts
   * columns rather than lanes so the keyboard's 1–5, the h/l walk and the grid
   * template all agree with what is in front of you.
   */
  const cols = useMemo(
    () => LANES.filter((l) => !l.hideWhenEmpty || (lanes.get(l.id)?.length ?? 0) > 0),
    [lanes],
  );
  const [cur, setCur] = useState<{ lane: number; row: number }>({ lane: 0, row: 0 });
  const frame = useRef<HTMLDivElement>(null);
  const shown = useCallback((i: number) => (lanes.get(cols[i]?.id ?? "review") ?? []).slice(0, LANE_CAP), [lanes, cols]);
  const at = shown(cur.lane)[cur.row];

  // Keep the cursor on something. Lanes empty and fill as checks land, and a
  // cursor left pointing past the end is a keypress that does nothing.
  useEffect(() => {
    const n = shown(cur.lane).length;
    if (n === 0) {
      const next = cols.findIndex((_, i) => shown(i).length > 0);
      if (next >= 0) setCur({ lane: next, row: 0 });
    } else if (cur.row >= n) setCur((c) => ({ ...c, row: n - 1 }));
  }, [lanes, cur.lane, cur.row, shown, cols]);

  useEffect(() => {
    frame.current?.querySelector<HTMLElement>("[data-cur=\"1\"]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [cur]);

  const onKey = (e: React.KeyboardEvent) => {
    // Never while somebody is typing in the filter above.
    if ((e.target as HTMLElement)?.closest?.("input,textarea")) return;
    const k = e.key;
    if (k >= "1" && k <= String(cols.length)) {
      const i = Number(k) - 1;
      if (shown(i).length) { e.preventDefault(); setCur({ lane: i, row: 0 }); }
      return;
    }
    if (k === "j" || k === "ArrowDown") { e.preventDefault(); setCur((c) => ({ ...c, row: Math.min(c.row + 1, Math.max(0, shown(c.lane).length - 1)) })); return; }
    if (k === "k" || k === "ArrowUp") { e.preventDefault(); setCur((c) => ({ ...c, row: Math.max(0, c.row - 1) })); return; }
    if (k === "h" || k === "ArrowLeft") { e.preventDefault(); setCur((c) => ({ lane: Math.max(0, c.lane - 1), row: 0 })); return; }
    if (k === "l" || k === "ArrowRight") { e.preventDefault(); setCur((c) => ({ lane: Math.min(cols.length - 1, c.lane + 1), row: 0 })); return; }
    if (!at) return;
    if (k === "Enter") { e.preventDefault(); onOpen(at.number); return; }
    if (k === "p") { e.preventDefault(); onTogglePin(at); return; }
    // One key for "do the thing this card is asking for", whatever that is in
    // this lane — the same button the card draws, so the two cannot drift.
    if (k === "a") { e.preventDefault(); onAct(at, suggestedAction(at, at.filed)); return; }
  };

  return (
    /*
     * `h-full`, and the whole layout below hangs off it.
     *
     * The board is handed a height by the panel — it must take it rather than
     * grow past it, because everything above the cards is what a board is FOR.
     * When this frame was allowed to grow, the panel's own scrollbar carried
     * it, and the first long lane pushed the scope sentence, the lane
     * headings and the keys off the top: you were left scrolling a wall of
     * cards with nothing on screen saying which lane you were in. The
     * scrolling belongs to each column, one per lane, below.
     */
    <div ref={frame} tabIndex={0} onKeyDown={onKey} className="flex flex-col h-full min-h-0 outline-none">
      {/* The scope, said out loud. A board whose reach nobody states is a board
          nobody trusts — and the first question anybody asks it is "where are
          the other three hundred". */}
      <div className="shrink-0 px-4 pt-3 pb-1 text-[12.5px]">
        {waiting ? (
          <>
            {/* No number, because there is no number yet. A zero here is the
                same lie the empty lanes used to tell, in bigger type. */}
            <b className="text-[17px] font-semibold" style={{ color: "var(--text4)" }}>…</b>
            <span className="ml-1">Reading the two lists this board is made of</span>
            <span className="block text-[11px] mt-0.5" style={{ color: "var(--text3)" }}>
              Yours, and the ones you were asked to look at. Until both are in, an empty lane means nothing.
            </span>
          </>
        ) : (
          <>
            <b className="text-[17px] font-semibold">{involved}</b>
            <span className="ml-1">
              {totalKnown ? `of ${total} open pull requests` : "open pull requests"} want something from you
            </span>
            <span className="block text-[11px] mt-0.5" style={{ color: "var(--text3)" }}>
              Yours, and the ones you were asked to look at. The board never shows more than that
              {" — "}
              <button onClick={onShowTable} style={{ color: "var(--primary)" }}>
                {rest > 0 ? `the other ${rest} are a table` : "the rest are a table"}
              </button>.
              {canLand > 0 && <> <span style={{ color: "var(--success)" }}>{canLand}</span> can land right now.</>}
            </span>
          </>
        )}
      </div>

      {/*
        * Every lane's count on one line.
        *
        * A summary, and deliberately not a second way to navigate: the lanes
        * are directly underneath, 1–5 already jumps to them, and a row of
        * buttons up here would read as filters that shrink the board. What it
        * buys is the lanes you cannot see — five columns at 268px do not fit a
        * narrow window, and the counts scrolled off the right edge are exactly
        * what you want before deciding to go and look.
        */}
      {!waiting && (
        <div className="shrink-0 flex flex-wrap gap-1 px-4 pb-1.5">
          {cols.map((l) => {
            const n = lanes.get(l.id)?.length ?? 0;
            return (
              <span key={l.id} data-seg={l.id}
                className="inline-flex items-baseline gap-1.5 rounded px-2 py-0.5 text-[10.5px]"
                style={{
                  color: l.tint,
                  border: `1px solid color-mix(in srgb, ${l.tint} 45%, transparent)`,
                  // An empty lane is still worth a segment — "none asked of you"
                  // is an answer — but it should not compete with a lane of six.
                  opacity: n ? 1 : 0.5,
                }}>
                <b className="tabular-nums font-semibold">{n}</b>
                <span style={{ color: "var(--text3)" }}>{l.label.toLowerCase()}</span>
              </span>
            );
          })}
          <span className="inline-flex items-baseline rounded px-2 py-0.5 text-[10.5px] tabular-nums"
            style={{ color: "var(--text4)", border: edge(16) }}>
            {totalKnown ? `${involved} / ${total}` : `${involved} on the board`}
          </span>
        </div>
      )}

      {/* The keys, printed. A board with a keyboard nobody is told about is a
          board with no keyboard. */}
      <div className="shrink-0 flex gap-3 flex-wrap px-4 pb-1.5 text-[9.5px]" style={{ color: "var(--text4)" }}>
        <span><K>1</K>–<K>{cols.length}</K> lane</span>
        <span><K>j</K><K>k</K> card</span>
        <span><K>h</K><K>l</K> across</span>
        <span><K>⏎</K> open</span>
        <span><K>a</K> do what the card asks</span>
        <span><K>p</K> pin</span>
      </div>

      {/* Sideways only. The five columns still have to be reachable on a narrow
          window; the up-and-down is each column's own, below. */}
      <div className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden agx-scroll px-4 pb-3">
        {!waiting && involved === 0 ? (
          /* Loaded, and genuinely nothing. Said once, plainly, instead of five
             columns each announcing its own emptiness — which is the same
             sentence five times and reads as a board that failed to load. */
          <div className="h-full grid place-items-center text-center">
            <div style={{ maxWidth: 400 }}>
              <div className="text-[13px]" style={{ color: "var(--text2)" }}>Nothing wants anything from you.</div>
              <p className="m-0 mt-1.5 text-[11px] leading-snug" style={{ color: "var(--text3)" }}>
                No open pull request of yours, and nobody has asked you to look at one. Both lists
                are in — this is an answer, not a wait.
              </p>
              <button onClick={onShowTable} className="agx-btn mt-3 rounded px-2 py-1 text-[10.5px]"
                style={{ color: "var(--text2)", border: edge(20) }}>
                {tableLabel}
              </button>
              {/* An empty board is precisely when a pin is the only thing left
                  on screen. Hiding it here would make the feature vanish at the
                  moment it is the whole point. */}
              <div className="mt-4 text-left">
                <PinnedStrip list={pinnedList} onOpen={onOpen} />
              </div>
            </div>
          </div>
        ) : (
          <div className="grid gap-2.5 h-full" style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(268px, 1fr))` }}>
            {cols.map((l, i) => {
              const all = lanes.get(l.id) ?? [];
              const rows = all.slice(0, LANE_CAP);
              const more = all.length - rows.length;
              return (
                /* A column is a box of its own height: heading fixed, cards
                   scrolling under it. `min-h-0` on both the column and its
                   scroller or the flex chain hands them their content height
                   and they grow instead of scrolling. `data-lane` names the box
                   from outside — it is the thing that scrolls, so it is the
                   thing a probe has to be able to point at. */
                <div key={l.id} data-lane={l.id} className="min-w-0 min-h-0 flex flex-col rounded-sm"
                  style={{ borderTop: `2px solid ${l.tint}` }}>
                  <div className="shrink-0">
                    {/*
                      * One line, always — and that is what the ⓘ is for.
                      *
                      * The "why" ran to one line in some lanes and two in
                      * others, so the first card of each column started at a
                      * different height and the board read as though it had
                      * been assembled carelessly. Alignment across five columns
                      * is most of what makes a board scannable, and it cannot
                      * survive a heading whose height depends on how long a
                      * sentence happens to be.
                      *
                      * The sentence is not lost: it is what the ⓘ says, and it
                      * is read once — when you are learning what a lane means —
                      * not on every glance for ever after.
                      */}
                    <h3 className="flex items-center gap-2 m-0 pt-2 pb-2 px-0.5 text-[11px] font-semibold" style={{ color: l.tint }}>
                      <span className="text-[13px] tabular-nums">{waiting ? "—" : all.length}</span>
                      <span className="uppercase tracking-wide truncate">{l.label}</span>
                      <span title={l.why} aria-label={l.why} role="note"
                        className="shrink-0 grid place-items-center rounded-full cursor-help"
                        style={{ width: 20, height: 20, fontSize: 14, color: "var(--text4)" }}>ⓘ</span>
                      <span className="ml-auto text-[9px] px-1 rounded shrink-0" style={{ color: "var(--text4)", border: edge(16) }}>{i + 1}</span>
                    </h3>
                  </div>

                  <div className="flex-1 min-h-0 overflow-y-auto agx-scroll">
                    {waiting ? (
                      /* The shape of the thing being waited for, and no text:
                         a lane cannot honestly say how many it will hold. */
                      <div aria-hidden>
                        {[0, 1].map((k) => (
                          <div key={k} className="rounded-lg mb-2 animate-pulse"
                            style={{ height: 74, background: "var(--bg2)", border: edge(16), animationDelay: `${(i * 2 + k) * 0.08}s` }} />
                        ))}
                      </div>
                    ) : (
                      <>
                        {rows.map((p, r) => (
                          <CardView key={p.number} p={p} hasTaskProvider={hasTaskProvider}
                            cursor={cur.lane === i && cur.row === r}
                            pinned={pinned(p.number)} onOpen={() => onOpen(p.number)} onPin={() => onTogglePin(p)}
                            onAct={onAct} busy={busy} />
                        ))}
                        {/* Counted, not hidden. A lane may be forty on a bad
                            week, and the column scrolls but the cap is what
                            keeps the board a glance rather than a list. */}
                        {more > 0 && (
                          <button onClick={onShowTable} className="w-full rounded-md py-1 text-[10px]"
                            style={{ color: "var(--text3)", border: edge(16) }}>
                            +{more} more in this lane
                          </button>
                        )}
                        {all.length === 0 && (
                          <p className="m-0 px-0.5 text-[10.5px]" style={{ color: "var(--text4)" }}>Nothing here. Good.</p>
                        )}
                      </>
                    )}
                  </div>

                  {/* Always the first column, never "wherever there is room".
                      Its own scroller, so a long pin list cannot push the lane
                      above it out of reach. */}
                  {i === 0 && !waiting && <PinnedStrip list={pinnedList} onOpen={onOpen} />}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/*
        * The footer, and the two things it will not do.
        *
        * There is no "sweep the stale ones". agentglass has no API that closes,
        * comments on or pokes a batch of pull requests, and a button that looks
        * like it can is the same lie as a nudge on a card — the one thing this
        * board has refused from the start.
        *
        * And the staleness is counted over THESE, not over the repository. The
        * other few hundred are not loaded — that is the whole bargain of the
        * board — so a number about them could only be made up. "Of these" is
        * the honest scope, and it is said in the sentence rather than left for
        * the reader to assume.
        */}
      {!waiting && involved > 0 && (
        <div className="shrink-0 flex flex-wrap items-center gap-2.5 px-4 py-2 text-[10.5px]"
          style={{ color: "var(--text3)", borderTop: edge(11) }}>
          {!totalKnown ? (
            <span>How many others are open is not a number this view can trust.</span>
          ) : rest > 0 ? (
            <span>The other <b style={{ color: "var(--text2)" }}>{rest}</b> open pull requests want nothing from you right now.</span>
          ) : (
            <span>That is every open pull request — there is nothing else.</span>
          )}
          <span style={{ color: "var(--text4)" }}>·</span>
          <span title="Measured from each pull request's last update, which GitHub moves for a push, a comment or a label. Counted only over the ones on this board.">
            {quiet > 0
              ? <>{quiet} of these {quiet === 1 ? "has" : "have"} gone {QUIET_DAYS} days without a push or a comment</>
              : <>everything here moved in the last {QUIET_DAYS} days</>}
          </span>
          <button onClick={onShowTable} className="agx-btn ml-auto rounded px-2 py-0.5"
            style={{ color: "var(--text2)", border: edge(20) }}>
            {tableLabel}
          </button>
        </div>
      )}
    </div>
  );
}

function CardView({ p, hasTaskProvider, pinned, cursor, onOpen, onPin, onAct, busy }: {
  p: Card; hasTaskProvider: boolean; pinned: boolean; cursor?: boolean;
  onOpen: () => void; onPin: () => void;
  onAct: (p: PrSummary, what: "open" | "merge" | "rerun") => void; busy?: boolean;
}) {
  const c = p.checks;
  const act = suggestedAction(p, p.filed);
  const task = taskLink(p, hasTaskProvider);
  const tint = c.pending > 0 ? "var(--warning)" : c.verdict === "red" ? "var(--error)"
    : c.verdict === "green" ? "var(--success)" : "var(--text4)";
  /*
   * How much of the suite has reported, as a percentage of the bar.
   *
   * Everything that has an answer counts, failures included: a red run that
   * finished is a finished run, and drawing it half full would say "still
   * going". `total` can be 0 — nothing has reported at all, which is an empty
   * track rather than a full one.
   */
  const done = c.total > 0 ? Math.round(((c.total - c.pending) / c.total) * 100) : 0;
  return (
    /* `data-pr` because a card is the unit anything outside this file counts —
       a test asking how many landed in a lane, a probe asking which column it
       is measuring. The number is already on screen; this just makes it
       addressable without reading the design. */
    <div onClick={onOpen} role="button" tabIndex={-1} data-pr={p.number} data-cur={cursor ? "1" : undefined}
      className="rounded-lg p-2 mb-2 cursor-pointer agx-btn"
      style={{
        border: cursor ? "1px solid color-mix(in srgb, var(--primary) 60%, transparent)" : edge(16),
        background: "var(--bg2)",
        boxShadow: cursor ? "inset 2px 0 0 var(--primary)" : undefined,
      }}>
      {/*
       * Title first, and the pin beside it.
       *
       * The pin used to be a 22px glyph in the bottom corner, which is a
       * target you aim at rather than one you hit — and it sat under a
       * sentence whose length decided where it ended up, so it moved between
       * cards. It is 26px now, in the one place every card has in common, and
       * the whole square is the button rather than the star inside it.
       */}
      <div className="flex gap-1.5 items-start text-[11.5px]" style={{ color: "var(--text)" }}>
        <span className="shrink-0 pt-px text-[10px] tabular-nums" style={{ color: "var(--text4)" }}>#{p.number}</span>
        {/* Two lines, then an ellipsis. A four-line title used to push the
            state, the sentence and the button down by two rows, so a lane of
            long titles was a lane you had to scroll — and the cards stopped
            being the same shape, which is what made the column hard to read
            down. The whole title is on the card's own tooltip. */}
        <span className="min-w-0 flex-1" title={p.title}
          style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", overflowWrap: "anywhere" }}>
          {p.title}
        </span>
        <button onClick={(e) => { e.stopPropagation(); onPin(); }}
          title={pinned ? `Unpin #${p.number}` : `Pin #${p.number} to the bar at the top`}
          aria-label={pinned ? `Unpin #${p.number}` : `Pin #${p.number}`}
          aria-pressed={pinned}
          className="agx-btn shrink-0 -mt-0.5 -mr-0.5 grid place-items-center rounded-md"
          style={{ width: 26, height: 26, fontSize: 15, lineHeight: 1,
            color: pinned ? "var(--primary-hover)" : "var(--text3)",
            border: pinned ? "1px solid color-mix(in srgb, var(--primary) 40%, transparent)" : "1px solid transparent",
            background: pinned ? "color-mix(in srgb, var(--primary) 12%, transparent)" : "transparent" }}>
          {pinned ? "★" : "☆"}
        </button>
      </div>

      {/*
       * The suite as a bar, not as a word.
       *
       * "6/14" and "13/14" are the same shape at ten pixels and read as the
       * same thing at a glance, which is exactly the glance this board is
       * for. The bar is filled by what has reported: a suite half in looks
       * half in. Red fills whatever got that far rather than filling to the
       * end, because a failure is not a finished run — the colour says the
       * verdict and the length says the progress, and they are two different
       * questions.
       *
       * Nothing has reported: an empty track. Not a hidden bar, which would
       * make the card a different height, and not a full grey one, which
       * would read as "done".
       */}
      <div className="mt-1.5 rounded-full overflow-hidden" style={{ height: 3, background: "color-mix(in srgb, var(--text) 12%, transparent)" }}>
        <span className="block h-full rounded-full" style={{ width: `${done}%`, background: tint, transition: "width .25s" }} />
      </div>

      <div className="flex items-center gap-1.5 mt-1 text-[10px]" style={{ color: "var(--text3)" }}>
        {/* The verdict in words, in the bar's own colour — colour alone cannot
            say "red" to somebody who cannot see red. */}
        <span className="shrink-0 tabular-nums" style={{ color: tint }}>
          {c.pending > 0 ? `${c.success} of ${c.total} in` : c.verdict === "red" ? `${c.failure} failing`
            : c.total === 0 ? "no checks" : "green"}
        </span>
        <span style={{ color: "var(--text4)" }}>→</span>
        {/* Where it lands, tinted when it is not the trunk — a stacked pull
            request read as a trunk one is a mistake you make once. */}
        <span className="truncate" style={{ maxWidth: 90, color: TRUNKS.has(p.baseRefName) ? "var(--text4)" : "var(--warning)" }}>{p.baseRefName}</span>
        <span className="ml-auto tabular-nums shrink-0" style={{ color: "var(--text4)" }}>
          +{p.additions} −{p.deletions} · {p.changedFiles}f
        </span>
      </div>

      <div className="flex items-center gap-1.5 mt-1 text-[10px]" style={{ color: "var(--text3)" }}>
        <span className="truncate" style={{ maxWidth: 110 }}>{p.author}</span>
        <span style={{ color: "var(--text4)" }}>·</span>
        <span className="tabular-nums shrink-0">{ago(p.updatedAt)}</span>
        {/* Everything that is only sometimes true, on the line that is allowed
            to be empty. A card with none of these keeps its shape. */}
        <span className="flex items-center gap-1 min-w-0 text-[9.5px] ml-1">
          {p.isCurrentBranch && <Tag tint="var(--primary)">here</Tag>}
          {p.isDraft && <Tag>draft</Tag>}
          {task && <Tag tint="var(--accent, var(--primary))" title={taskLinkTitle(task)}>{task.label}</Tag>}
          {p.labels.slice(0, 1).map((l) => <Tag key={l.name}>{l.name}</Tag>)}
          {p.labels.length > 1 && <span title={p.labels.map((l) => l.name).join(", ")}>+{p.labels.length - 1}</span>}
        </span>
        {!!p.reviewers?.length && (
          <span className="ml-auto shrink-0 text-[9.5px]" title={`Reviewers: ${p.reviewers.map((r) => r.login).join(", ")}`}>
            {p.reviewers.slice(0, 3).map((r) => r.login.slice(0, 2).toUpperCase()).join(" ")}
          </span>
        )}
      </div>

      {/* The sentence that put it in this lane. Without it a board is a list
          whose order you have to re-derive every morning. Two lines, like the
          title: the longest of these runs to four on a narrow lane, and a card
          whose height is decided by a sentence cannot be scanned beside one
          whose sentence is short. */}
      <div className="flex gap-1.5 mt-1.5 text-[10.5px] leading-snug" style={{ color: "var(--text3)" }}>
        <span className="shrink-0" style={{ color: "var(--text4)" }}>↳</span>
        <span title={p.filed.reason}
          style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", overflowWrap: "anywhere" }}>
          {p.filed.reason}
        </span>
      </div>

      <div className="flex items-center gap-1.5 mt-1.5">
        {/* One button, and it is the one this lane is asking for. A row of five
            is a row nobody reads; the rest are a click away inside. */}
        <button onClick={(e) => { e.stopPropagation(); onAct(p, act); }} disabled={busy}
          className="agx-btn rounded px-2 py-0.5 text-[10px] disabled:opacity-40"
          style={act === "merge"
            ? { background: "var(--primary)", color: "var(--bg)", fontWeight: 500 }
            : { color: "var(--text2)", border: edge(20) }}>
          {ACTION_LABEL[act]}
        </button>
      </div>
    </div>
  );
}

const Tag = ({ children, tint, title }: { children: React.ReactNode; tint?: string; title?: string }) => (
  <span title={title} className="rounded px-1" style={{ color: tint ?? "var(--text3)", border: `1px solid color-mix(in srgb, ${tint ?? "var(--text)"} ${tint ? 34 : 16}%, transparent)` }}>
    {children}
  </span>
);

/** Short enough to sit in a row of ten-pixel type. */
function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return "";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

const K = ({ children }: { children: React.ReactNode }) => (
  <span className="rounded px-1 mx-px" style={{ border: `1px solid color-mix(in srgb, var(--text) 16%, transparent)` }}>{children}</span>
);

/**
 * The ones you pinned, drawn wherever there is a board to draw them on.
 *
 * Its own component because it appears in two places that are otherwise
 * unrelated — the foot of the first lane, and the empty state — and the second
 * one matters more than it looks: a board with no lanes is exactly when a pin
 * is the only thing left on screen.
 */
function PinnedStrip({ list, onOpen }: { list?: { number: number; title: string }[]; onOpen: (n: number) => void }) {
  if (!list?.length) return null;
  return (
    <div className="shrink-0 flex flex-col min-h-0 mt-2 pt-2" style={{ borderTop: edge(18), maxHeight: "40%" }}>
      <h4 className="flex items-baseline gap-2 m-0 pb-1 px-0.5 text-[9px] uppercase tracking-wider shrink-0"
        style={{ color: "var(--text3)" }}>
        <span style={{ color: "var(--primary-hover)" }}>★</span> Pinned
        <span className="tabular-nums" style={{ color: "var(--text4)" }}>{list.length}</span>
      </h4>
      <div className="flex-1 min-h-0 overflow-y-auto agx-scroll">
        {list.map((p) => (
          <button key={p.number} onClick={() => onOpen(p.number)} title={p.title}
            className="agx-btn w-full text-left rounded px-1.5 py-1 mb-1 flex items-baseline gap-1.5"
            style={{ border: edge(14) }}>
            <span className="shrink-0 text-[10px] tabular-nums" style={{ color: "var(--text4)" }}>#{p.number}</span>
            <span className="min-w-0 truncate text-[10.5px]" style={{ color: "var(--text2)" }}>{p.title}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
