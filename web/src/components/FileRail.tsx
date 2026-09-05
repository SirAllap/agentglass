import { useMemo } from "react";
import { MIN_BOX } from "../lib/iconSize.ts";
// The column beside the diff, scoped to the file under the cursor.
//
// Everything here was already in the pull request and in another tab. What it
// costs to fetch is nothing — the detail the panel loaded to draw the tab strip
// carries the timeline, the reviews and the check rollup — and what it saves is
// the trip: reading the review comment that argues about the file in front of
// you was six moves through the Conversation tab, and the timeline lost your
// place on the way.
//
// One section is not about the file, it is about you: the comments you have
// queued on it. Those live nowhere but the box under the line they were left
// on, so scrolling past them reads exactly like never having written them.
//
// It folds away under 1180px. Three live columns want the width, and below it
// the honest thing is to give the diff the room and put these back in the tabs
// they came from, rather than squeeze all three into something none of them can
// be read in.
import type { PrDetail } from "../../../shared/types.ts";
import { railScan, checksAbout, threadsAbout, queuedOn, heldOn, railAge,  railPreview, type RailDraft, type RailHeld, type RailMention } from "../lib/fileRail.ts";
import { openExternal } from "../lib/externalUrl.ts";
import { mergeBlockedWhy, checksLine, checksStanding, standingLine, mergeVerdict } from "../../../shared/mergeReason.ts";
import { ICON } from "../lib/iconSize.ts";

/** How your own last verdict reads back, and in what colour. Its own map so the
 *  three states are spelled once — the buttons above already spell them as
 *  actions, and "You approved this" is not the same sentence as "Approve". */
const MINE_SAID: Record<string, string> = {
  APPROVED: "approved this",
  CHANGES_REQUESTED: "asked for changes",
  COMMENTED: "commented on this",
  DISMISSED: "reviewed this, and it was dismissed",
};
const MINE_TINT: Record<string, string> = {
  APPROVED: "var(--success)",
  CHANGES_REQUESTED: "var(--error)",
  COMMENTED: "var(--text3)",
  DISMISSED: "var(--text4)",
};

const edge = (pct: number) => `1px solid color-mix(in srgb, var(--text) ${pct}%, transparent)`;

/** An identifier inside a quote, so it stops being a word in the sentence.
 *  Relative, because it belongs to the prose around it — the icon rule below is
 *  about controls, and this is type. */
const QUOTE_CODE = {
  fontFamily: 'var(--font-mono, "SF Mono"), SFMono-Regular, ui-monospace, Menlo, Consolas, monospace',
  fontSize: "0.92em",
  padding: "0 2px",
  borderRadius: 2,
  background: "color-mix(in srgb, var(--text) 8%, transparent)",
} as const;

/**
 * The square the jump control is drawn in.
 *
 * The house rule is `iconSize.ts`: a glyph gets an explicit size off the ladder
 * and a box of its own, because an icon-only control that inherits its row's
 * type scale comes out at seven pixels of ink, and growing the glyph alone
 * leaves the same thin target.
 *
 * Below `HIT`, which is 26, on the escape the same file writes down — "drops to
 * a row's height where a header has none to spare; never below the glyph plus
 * its padding". This header IS that row: a 9.5px meta line in a 320px column,
 * four of them stacked, and a 26px square would make the provenance line taller
 * than the quote it belongs to. 20 clears the 14px glyph with room and keeps the
 * entry's shape.
 *
 * The number itself moved to `iconSize.ts` as `MIN_BOX`, where the rest of this
 * question already lived — it was declared here, alone, and the file that owns
 * the floor had never heard of it.
 */
const JUMP_BOX = MIN_BOX;

/** Past this the list stops being readable at 300px and the Conversation tab is
 *  the better place to be. */
const THREAD_CAP = 4;

const lines = (line: number, startLine?: number | null) =>
  startLine && startLine !== line ? `Lines ${startLine}–${line}` : `Line ${line}`;

/** The three verdicts GitHub takes, in the panel's own spelling. */
export type RailVerdict = "approve" | "request_changes" | "comment";

export function FileRail({
  d, path, drafts, held, loading, queuedCount, verdict,
  onGoConversation, onGoChecks, onGoReview, onGoToMention, onMerge, canMerge, awaitingChecks,
  onApprove, onRequestChanges, onComment, onSubmit, body, onBody, busyWhat,
}: {
  d: PrDetail;
  /** The file the diff is showing. Null means nothing is selected yet, which is
   *  a real state and gets a real sentence rather than an empty column. */
  path: string | null;
  /** Every line comment you have queued on this pull request, all files; the
   *  rail keeps the ones on this one. Optional because the rail must still be
   *  drawable by a caller that does not hold a review — with no prop there is
   *  no section, which is the difference between "nothing queued" and "this
   *  panel cannot know". */
  drafts?: RailDraft[];
  /** Every comment GitHub is holding in your unsubmitted review, all files. The
   *  rail keeps this file's. Optional for the same reason `drafts` is: no prop
   *  is "this caller cannot know", not "there are none". */
  held?: RailHeld[];
  /** The detail on screen is being refreshed. Everything below is filtered from
   *  it, so while this is true an empty answer is a wait and not a fact — see
   *  the empty states. */
  loading?: boolean;
  /** How many line comments the whole review will send — every file, not this
   *  one. It is what "one notification, not 3" counts, and it is a different
   *  number from the queued section below, which is scoped to the file.
   *  Defaults to `drafts.length`, which is the same figure by definition, so
   *  wiring either one is enough. */
  queuedCount?: number;
  /** Which verdict the review the panel holds is already set to, so the armed
   *  button can look armed. Undefined means the caller does not say — nothing
   *  is drawn as chosen, which is honest and is what an unwired rail shows. */
  verdict?: RailVerdict;
  onGoConversation: () => void;
  onGoChecks: () => void;
  onGoReview: () => void;
  /**
   * Take me to THIS entry where it lives — the Conversation tab, scrolled to
   * the row this quote is a preview of.
   *
   * Reported as "should have a button that takes us to that exact comment on
   * the conversation section". `onGoConversation` is the section's answer and
   * it is a different question: it opens the tab at the top, with a dozen
   * entries above the one that was being read, which is the trip this column
   * exists to save.
   *
   * Handed the whole `RailMention`, not a bare id, so the caller can decide
   * what "go there" means without the rail deciding for it. `m.nodeId` is the
   * handle: a GraphQL node id, type-prefixed, and already carried on every card
   * the Conversation tab draws. It is never empty when this fires — with no id
   * the control is not drawn, so the caller never has to answer "what do I do
   * with an entry I cannot address".
   *
   * Optional, and absent means the control is not drawn at all rather than
   * drawn dead, exactly like the verdict buttons below.
   */
  onGoToMention?: (m: RailMention) => void;
  onMerge: () => void;
  canMerge: boolean;
  /**
   * The branch just moved and no run has been created yet.
   *
   * The panel computes this once and hands it to the masthead and to Overview;
   * the rail was never given it, so it called `checksStanding` with the default
   * and read an empty rollup as "nothing has reported". Right after Update
   * branch the masthead said "waiting for them to start" and this column, on
   * the same screen, said "Nothing is blocking it" over an enabled Merge — the
   * exact contradiction `mergeReason.ts` exists to prevent.
   */
  awaitingChecks?: boolean;
  /* The verdict controls, each optional on its own.
   *
   * A rail that draws a dead button is worse than one that draws none: the
   * mockup's "Your review" is three buttons and a send, and a caller that holds
   * no review — or has not wired one yet — must still be able to draw the
   * column. So an absent handler removes its button rather than disabling it,
   * and with none of them wired the section falls back to the sentence it has
   * always shown.
   *
   * These ARM the verdict; `onSubmit` is what sends. Splitting them is the
   * mockup's own shape, and it is the only one the rail can honour: the review
   * body lives in the Review tab, so pressing "Request changes" here cannot be
   * the thing that posts. */
  onApprove?: () => void;
  onRequestChanges?: () => void;
  onComment?: () => void;
  onSubmit?: () => void;
  /**
   * The review note being written, and a way to write it.
   *
   * The rail used to carry the three verdicts and the Submit and no field, so
   * everything except an approval bounced you to another tab — "si quiero hacer
   * la review desde aquí no tengo input para meter texto, entonces es inútil".
   *
   * It is the SAME draft the Review tab holds, not a second one: two boxes with
   * two bodies is a way to lose the one you typed in the other.
   */
  body?: string;
  onBody?: (v: string) => void;
  /** The request in flight, by the label the panel gave it. The button that
   *  started it says so — a round trip through `gh` with no feedback but a grey
   *  button is the thing this app was worst at. */
  busyWhat?: string;
}) {
  /*
   * One walk, remembered.
   *
   * `listedOnly` — something named it and nothing argued about it — is a
   * different answer from "nobody mentioned it", and it is the one that stops
   * the empty sentence reading as a broken column to somebody who can see their
   * file listed in the timeline. It also comes out of the SAME scan as the
   * quotes, and asking twice was half the cost of this column.
   *
   * Memoised because this component sits inside the panel and re-renders with
   * it: every 20s poll, every keystroke in the list's filter box, and twice per
   * file you step to. Measured before: 11.9ms per render on a pull request with
   * six 44KB automation reports, so 21ms of pure JS on every j/k.
   */
  const { said, listedOnly } = useMemo(() => railScan(d, path), [d, path]);
  const failing = useMemo(() => checksAbout(d.checks.failing ?? [], path), [d.checks.failing, path]);
  const threads = useMemo(() => threadsAbout(d, path), [d, path]);
  const queued = useMemo(() => queuedOn(drafts, path), [drafts, path]);
  const heldHere = useMemo(() => heldOn(held, path), [held, path]);
  const standing = checksStanding(d.checks, awaitingChecks);
  const allClear = d.mergeState === "CLEAN" && standing === "green";
  /*
   * Whether GitHub will take it, which is a different question from whether the
   * checks are green — and asking only the second one is how this box said
   * "Not mergeable" over a pull request nothing was blocking.
   *
   * `mergeBlockedWhy` answers "why is it blocked", and it has no line for CLEAN
   * because CLEAN is not blocked; it fell through to its own last resort. The
   * repository this happened on runs no required checks, so a green merge
   * button sat under a sentence refusing it.
   *
   * The ladder below is the panel's, copied deliberately rather than improved
   * on. This box is the SHORT VERSION of the one in Overview — the last line
   * says so — and a short version that reaches a different verdict from the
   * long one is not short, it is a second opinion.
   *
   * Not `canMerge`: the rail is handed `CLEAN || BEHIND`, because a branch
   * behind its base is still worth a press with a warning. Behind is a reason,
   * so it must not read as "nothing is blocking it".
   */
  const willTake = d.mergeState === "CLEAN";
  /* Not `verdict` — that name is already the review's, three lines up in the
     props, and this is the merge's. */
  const { line: mergeLine } = mergeVerdict(d.mergeState, d.checks, awaitingChecks);
  const under = standingLine(standing) ?? (allClear ? checksLine(d.checks) : null);
  /* What GitHub cut off. Every "nothing" below is a claim about the page that
     came back, not about the pull request: `truncated.comments` is the number
     RETURNED — the page came back full — so "nothing in the conversation names
     it" is really "nothing in the most recent 80". The fix is the sentence and
     not a flag: there is no more to fetch and nothing to press, and a warning
     over a fact the reader can do nothing about is decoration. Loading still
     wins over all of it, for the reason in the empty states below. */
  const cap = d.truncated ?? {};

  /* Only the verdicts the caller actually wired, in the Review tab's own
     spelling and order so the two surfaces are one control in two places. */
  const verdicts = [
    { id: "approve" as const, label: "✓ Approve", tint: "var(--success)", on: onApprove },
    { id: "request_changes" as const, label: "✕ Request changes", tint: "var(--error)", on: onRequestChanges },
    { id: "comment" as const, label: "💬 Comment", tint: "var(--text)", on: onComment },
  ].filter((v) => !!v.on);
  const armed = verdicts.length > 0 || !!onSubmit;
  /* Your own last review on this pull request, newest first. GitHub keeps every
     one of them, and only the latest says where you stand. */
  const mine = [...(d.reviews ?? [])]
    .filter((r) => r.viewerDidAuthor && r.state !== "PENDING")
    .sort((a, b) => (b.submittedAt || "").localeCompare(a.submittedAt || ""))[0];
  /* The whole review's queued lines, not this file's — what one submit is about
     to send. `drafts` is every file's, so its length is the same number rather
     than an estimate of it, and either prop alone is enough to say this. */
  const willSend = (queuedCount ?? drafts?.length) === undefined
    ? undefined
    : (queuedCount ?? drafts?.length ?? 0) + (held?.length ?? 0);
  /* `held` counts here because submitting from this app finishes the review
     GitHub is holding rather than opening a second one — so those comments go
     out with this verdict. The box used to read "No line comments queued" over
     three comments drafted on the website, which is the one sentence that made
     somebody submit thinking they were sending nothing. */
  const goesWith = willSend
    ? `${willSend} line comment${willSend === 1 ? " goes" : "s go"} with it — one notification, not ${willSend + 1}.`
    : willSend === 0
      ? "No line comments queued — the verdict goes on its own."
      : "The verdict goes with whatever you have queued.";

  return (
    /*
     * 1180, which is the mockup's own number — `@media(max-width:1180px)
     * {.rail{display:none}}`. It was `xl:` here, and Tailwind's `xl` is 1280,
     * so the column was disappearing a hundred pixels earlier than it was drawn
     * to. Nobody chose that; it is what you get for reaching for the nearest
     * named breakpoint when the design names its own.
     */
    <aside className="agx-rail agx-col3 flex-col shrink-0 agx-scroll"
      style={{ width: 320, borderLeft: edge(12) }}>
      {!path && (
        <Sec title="Nothing selected">
          <p className="m-0 text-[10.5px]" style={{ color: "var(--text4)" }}>
            Pick a file and this column fills with what the rest of the pull request says about it.
          </p>
        </Sec>
      )}

      {path && (
        <>
          <Sec title="Said about this file"
            action={said.length ? { label: "Timeline", on: onGoConversation } : undefined}>
            {said.length === 0 ? (
              /* "Nothing names it" is a finding, and a finding drawn from a
                 detail that has not landed yet is a lie with a straight face.
                 While it is in flight the rail says it is still looking — and
                 once it has landed it still only speaks for the page it got. */
              <p className="m-0 text-[10.5px]" style={{ color: "var(--text4)" }}>
                {loading
                  ? "Still reading the conversation."
                  : listedOnly
                    ? "Named only in a list of files — nothing argues about it."
                    : cap.comments
                      ? `Nothing names it in the most recent ${cap.comments} comments — GitHub caps the page there.`
                      : "Nothing in the conversation names it."}
              </p>
            ) : (
              <>
                {said.map((m, i) => {
                  /* Only when there is both somebody to take the trip and an
                     address to take it to. `nodeId` is absent on a detail
                     cached before the field existed, and an entry the panel
                     cannot find again is one this column must not offer to
                     find — a button that goes nowhere is worse than no button
                     in the one section whose whole job is not overclaiming. */
                  const goTo = onGoToMention && m.nodeId ? () => onGoToMention(m) : null;
                  return (
                    <div key={i} className="mb-2 last:mb-0 text-[11px]">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate" style={{ color: "var(--text)" }}>{m.who}</span>
                        <span className="shrink-0 text-[9.5px]" style={{ color: "var(--text4)" }}>
                          {m.kind === "review" ? "review" : "comment"}
                          {/* Whether the argument predates the last push is most of
                              what decides if it still applies to the code below. */}
                          {railAge(m.createdAt) && ` · ${railAge(m.createdAt)}`}
                        </span>
                        {goTo && (
                          /* Per ENTRY, which is the whole of what was asked:
                             "a button that takes us to that exact comment".
                             The section's own Timeline link lands at the top of
                             a tab with a dozen entries above this one, and it
                             cannot know which of the four quotes was being
                             read — the reader knows, and this is where they
                             are standing. Faint and off at the margin, because
                             the quote is the content of a 320px column and an
                             affordance that outshouts it has taken the room it
                             was meant to save. */
                          <button onClick={goTo} data-node={m.nodeId}
                            title="Open this in the conversation"
                            aria-label="Open this in the conversation"
                            className="agx-btn ml-auto shrink-0 rounded flex items-center justify-center"
                            style={{ width: JUMP_BOX, height: JUMP_BOX, fontSize: ICON.sm, lineHeight: 1, color: "var(--text4)" }}>
                            ↗
                          </button>
                        )}
                      </div>
                      <Quote body={m.body} max={260} />
                    </div>
                  );
                })}
                {/* Where it came from, because a paragraph beside your code with
                    no provenance reads as something the panel wrote. */}
                <p className="m-0 mt-1 text-[10px]" style={{ color: "var(--text4)" }}>
                  From Conversation — pulled here because it names this file.
                  {cap.comments ? ` Only the most recent ${cap.comments} comments came back.` : ""}
                </p>
              </>
            )}
          </Sec>

          {/* The threads are drawn under their own lines in the diff as well,
              which is where you answer them. What they cannot do from there is
              tell you how many are waiting on a file you have already scrolled
              past the top of — a count is the one number that decides whether
              to read before you go on. */}
          <Sec title="Threads on this file"
            action={threads.length ? { label: "Conversation", on: onGoConversation } : undefined}>
            {threads.length === 0 ? (
              <p className="m-0 text-[10.5px]" style={{ color: "var(--text4)" }}>
                {loading
                  ? "Still reading the threads."
                  : cap.threads
                    ? `No unresolved thread in the most recent ${cap.threads} sits on its lines — GitHub caps the page there.`
                    : "No unresolved thread sits on its lines."}
              </p>
            ) : (
              <>
                <p className="m-0 mb-1.5 text-[10px]" style={{ color: "var(--text4)" }}>
                  {threads.length} unresolved, anchored in the diff below
                </p>
                {threads.slice(0, THREAD_CAP).map((t) => (
                  <button key={t.id} onClick={onGoConversation}
                    className="block w-full text-left mb-2 last:mb-0 text-[11px]">
                    <span style={{ color: "var(--primary)" }}>{t.line ? lines(t.line, t.startLine) : "Comment"}</span>
                    <span className="ml-1.5 text-[9.5px]" style={{ color: "var(--text4)" }}>
                      {t.comments[0]?.author}
                      {/* Kept, not hidden: the lines moved, the argument did
                          not, and knowing which it is decides whether to read. */}
                      {t.isOutdated && " · outdated"}
                    </span>
                    {/* Read like the paragraphs above it: a thread is anchored
                        to the file and never has to earn its place, but the
                        marker at the top of it is still a machine talking to
                        itself, and its markdown is still markdown. */}
                    <Quote body={t.comments[0]?.body ?? ""} max={120} />
                  </button>
                ))}
                {threads.length > THREAD_CAP && (
                  <p className="m-0 text-[10px]" style={{ color: "var(--text4)" }}>
                    +{threads.length - THREAD_CAP} more, in the conversation
                  </p>
                )}
              </>
            )}
          </Sec>

          {/* The mockup's heading, and the data cannot always keep its promise:
              a check carries a name and a workflow and no log. The red ones are
              still all listed — dropping the check that is blocking the merge
              because it could not be tied to a file would be the rail hiding the
              one thing the reader cannot get anywhere else on this screen — and
              when none of them names the file the section says so above the
              list, so the heading is never left claiming a link on its own. */}
          <Sec title="Checks blaming this file" action={{ label: "All checks", on: onGoChecks }}>
            {failing.length === 0 ? (
              <p className="m-0 text-[10.5px]" style={{ color: "var(--text4)" }}>
                {loading
                  ? "Still reading the checks."
                  : d.checks.failure > 0
                    ? "No failing check could be tied to a file."
                    : cap.checks
                      ? `Nothing is failing in the ${cap.checks} checks GitHub returned — the page caps there.`
                      : "Nothing is failing."}
              </p>
            ) : (
              <>
                {!failing.some((f) => f.namesFile) && (
                  <p className="m-0 mb-1.5 text-[10px]" style={{ color: "var(--text4)" }}>
                    None of these names this file — a check carries a name and no log.
                  </p>
                )}
                {failing.map(({ check, namesFile }) => (
                  /* The log is in the Checks tab, which is where this goes. The
                     mockup puts an "Open the log" under the check; the rail has
                     no log viewer of its own and inventing one here would be a
                     second place to read the same output. */
                  <button key={check.name} onClick={onGoChecks} title="Open the log"
                    className="flex w-full items-baseline gap-1.5 text-left text-[11px] mb-1 last:mb-0">
                    <span style={{ color: "var(--error)" }}>✕</span>
                    <span className="min-w-0 truncate" style={{ color: "var(--text2)" }}>{check.name}</span>
                    {/* Said only when it is true. A check carries a name and no
                        log, so most of the time we cannot know which file broke
                        it — and claiming otherwise is how a panel starts lying
                        quietly. */}
                    {namesFile && <span className="shrink-0 text-[9px] px-1 rounded"
                      style={{ color: "var(--error)", border: "1px solid color-mix(in srgb, var(--error) 32%, transparent)" }}>names this file</span>}
                  </button>
                ))}
              </>
            )}
          </Sec>

          {/* Only when the caller holds a review to ask about. An absent prop
              and an empty queue are different answers and must not share a
              sentence. */}
          {drafts && (
            <Sec title="Queued by you"
              action={queued.length ? { label: "Review", on: onGoReview } : undefined}>
              {queued.length === 0 ? (
                /* Not softened while `loading`: a draft is yours and local, so
                   this answer is already final while the rest of the pane is
                   still arriving. */
                <p className="m-0 text-[10.5px]" style={{ color: "var(--text4)" }}>
                  Nothing queued on this file.
                </p>
              ) : (
                <>
                  <p className="m-0 mb-1.5 text-[10px]" style={{ color: "var(--text4)" }}>
                    {queued.length} pending comment{queued.length === 1 ? "" : "s"} — they go out when the review does.
                  </p>
                  {queued.map((q, i) => (
                    <div key={i} className="mb-2 last:mb-0 text-[11px]">
                      <span style={{ color: "var(--warning)" }}>{lines(q.line, q.startLine)}</span>
                      {/* Yours and not yet sent, so this is the one body with
                          no bot in its history — read the same way anyway,
                          because the moment it goes out GitHub will render it
                          and the preview would stop matching the comment. */}
                      <Quote body={q.body} max={140} />
                    </div>
                  ))}
                </>
              )}
            </Sec>
          )}

          {/* Started on the website and left there. Shown short on purpose: the
              Review tab prints these whole, and what this column is for is
              noticing one exists on the file you are reading — with the way to
              the only place it can be edited, which is GitHub. */}
          {heldHere.length > 0 && (
            <Sec title="Drafted on GitHub"
              action={{ label: "Review", on: onGoReview }}>
              <p className="m-0 mb-1.5 text-[10px]" style={{ color: "var(--text4)" }}>
                {heldHere.length} comment{heldHere.length === 1 ? "" : "s"} in your unsubmitted review — they go out when you submit.
              </p>
              {heldHere.map((h, i) => (
                <div key={i} className="mb-2 last:mb-0 text-[11px] flex items-start gap-1.5">
                  <span className="min-w-0">
                    <span style={{ color: "var(--primary)" }}>
                      {h.line == null ? "Outdated" : lines(h.line)}
                    </span>
                    <Quote body={h.body} max={90} />
                  </span>
                  {h.url && (
                    <button onClick={() => openExternal(h.url!)} title="Edit this comment on GitHub"
                      className="agx-btn shrink-0 ml-auto text-[9.5px] px-1 rounded"
                      style={{ color: "var(--primary)" }}>Edit ↗</button>
                  )}
                </div>
              ))}
            </Sec>
          )}
        </>
      )}

      {/* Not a sentence about reviewing — the review itself. The verdict is the
          reason the sections above it were read, and leaving it was two tabs
          away from the code it is about. */}
      {/*
        * A closed pull request is history, and this column was still offering to
        * act on it. `mergeStateOf` answers "UNKNOWN" for anything GitHub does
        * not report a mergeability for, which is what it reports once a pull
        * request has merged — so the box read "◯ GitHub has not finished working
        * it out" under a "Merge anyway…" button on something that landed an hour
        * ago, while Overview one tab away said "Merged". Overview was fixed for
        * exactly this and said so in a comment; the rail reintroduced it.
        */}
      {/* Explicitly the two closed states, not "anything that is not OPEN": a
          detail that arrives without the field would otherwise be announced as
          closed, which is a worse lie than the one this fixes. */}
      {d.state === "MERGED" || d.state === "CLOSED" ? (
        <Sec title={d.state === "MERGED" ? "Merged" : "Closed"}>
          <p className="m-0 text-[10.5px]" style={{ color: "var(--text4)" }}>
            {d.state === "MERGED"
              ? `Merged into ${d.baseRefName}. Nothing here is waiting on you.`
              : "Closed without merging. Nothing here is waiting on you."}
          </p>
        </Sec>
      ) : (<>
      <Sec title="Your review" action={{ label: "Open", on: onGoReview }}>
        {/*
          * What you already said, before what you might say next.
          *
          * The box drew "Approve / Request changes / Comment" identically
          * whether or not you had already reviewed — reported from a pull
          * request he had approved two hours earlier. Your own last verdict is
          * the one fact that changes what this box is for, so it goes first.
          *
          * `viewerRequested` still shows underneath when it is set: GitHub only
          * keeps that flag while your review is outstanding, so after you have
          * answered it means they have asked you AGAIN.
          */}
        {mine && (
          <p className="m-0 mb-1.5 text-[10.5px]" style={{ color: MINE_TINT[mine.state] ?? "var(--text3)" }}>
            You {MINE_SAID[mine.state] ?? "reviewed this"} {railAge(mine.submittedAt)}.
          </p>
        )}
        {d.viewerRequested && (
          <p className="m-0 mb-1.5 text-[10.5px]" style={{ color: "var(--warning)" }}>
            {mine ? "They have asked you to look again." : "You were asked to look at this."}
          </p>
        )}
        {armed ? (
          <>
            <div className="flex flex-wrap gap-1">
              {verdicts.map(({ id, label, tint, on }) => {
                /* GitHub refuses both of these on your own pull request, and the
                   Review tab already greys them for the same reason. Drawn and
                   disabled rather than dropped: the row is the shape of the
                   choice, and a gap where Approve was reads as a bug. */
                const off = id !== "comment" && d.viewerDidAuthor;
                const chosen = verdict === id;
                return (
                  <button key={id} onClick={on} disabled={off} aria-pressed={chosen}
                    title={off ? "GitHub does not let you approve or block your own pull request" : undefined}
                    className="agx-btn rounded px-1.5 py-0.5 text-[10px] disabled:opacity-40"
                    style={{
                      color: chosen ? tint : "var(--text2)", fontWeight: chosen ? 650 : 400,
                      border: edge(chosen ? 34 : 18),
                      background: chosen ? "color-mix(in srgb, var(--primary) 16%, transparent)" : "transparent",
                    }}>{label}</button>
                );
              })}
            </div>
            {/* The note. Two rows, because a summary is a line or two and the
                column is 320px — anything taller pushes Merge off the fold,
                which is the other decision this rail exists to keep in view. */}
            {onBody && (
              <textarea value={body ?? ""} onChange={(e) => onBody(e.target.value)} rows={2}
                placeholder="Summary — optional for an approval, markdown works"
                className="w-full mt-1.5 rounded-md p-2 text-[10.5px] resize-y"
                style={{ background: "var(--bg2)", color: "var(--text)", border: edge(18) }} />
            )}
            <p className="m-0 mt-1.5 text-[10px]" style={{ color: "var(--text4)" }}>{goesWith}</p>
            {onSubmit && (
              <button onClick={onSubmit} disabled={busyWhat === "Review"}
                className="agx-btn w-full mt-1.5 rounded-md py-1 text-[10.5px] inline-flex items-center justify-center gap-1.5 disabled:opacity-60"
                style={{ background: "var(--primary)", color: "var(--bg)", border: edge(20) }}>
                {busyWhat === "Review" && (
                  <span className="agx-spin" aria-hidden
                    style={{ width: 9, height: 9, borderWidth: 1.5, borderColor: "color-mix(in srgb, var(--bg) 55%, transparent)", borderTopColor: "transparent" }} />
                )}
                Submit review
              </button>
            )}
          </>
        ) : (
          /* Nothing wired: the rail says what the Review tab is for rather than
             drawing three buttons that would do nothing. */
          <p className="m-0 text-[10.5px]" style={{ color: "var(--text4)" }}>
            Approve, request changes or comment — the verdict goes with your queued lines.
          </p>
        )}
      </Sec>

      {/* The short version, so a decision never needs a tab. The whole box —
          every reason, every action — is still in Overview, and the last line
          says so: a reader who cannot see the rest of the reasons has to know
          that there are more of them and where. */}
      <Sec title="Merge">
        <div className="text-[11px]" style={{ color: allClear ? "var(--success)" : "var(--warning)" }}>
          {allClear ? `✓ ${mergeLine}` : `◯ ${mergeLine}`}
        </div>
        {/* What the checks add up to, the mockup's "44 of 45 in". `standingLine`
            speaks when nothing has reported; the count only when the line above
            is "Ready" — a blocked pull request has already been told WHY by
            `mergeBlockedWhy`, and "1 check still running" twice in two lines is
            how a box starts reading like a form letter. */}
        {under && <p className="m-0 mt-1 text-[10px]" style={{ color: "var(--text4)" }}>{under}</p>}
        <button onClick={onMerge} disabled={!canMerge || busyWhat === "Merge"}
          className="agx-btn w-full mt-2 rounded-md py-1 text-[10.5px] inline-flex items-center justify-center gap-1.5 disabled:opacity-40"
          style={{ background: allClear ? "var(--primary)" : "transparent", color: allClear ? "var(--bg)" : "var(--text2)", border: edge(20) }}>
          {/* "anyway" is a word about overriding something. With nothing to
              override it turned a plain press into a dare. */}
          {busyWhat === "Merge" && (
            <span className="agx-spin" aria-hidden
              style={{ width: 9, height: 9, borderWidth: 1.5, borderColor: allClear ? "color-mix(in srgb, var(--bg) 55%, transparent)" : "currentColor", borderTopColor: "transparent" }} />
          )}
          {willTake ? "Merge" : "Merge anyway…"}
        </button>
        <p className="m-0 mt-1.5 text-[10.5px] leading-snug" style={{ color: "var(--text4)" }}>
          The whole box lives in Overview — this is the short version, so a verdict never needs a tab.
        </p>
      </Sec>
      </>)}
    </aside>
  );
}

/**
 * A body as a preview of itself.
 *
 * Reported from the app: the column drew every body as plain text, so a review
 * written in markdown arrived with its syntax showing — `**Pre-check
 * reports:**` and backticked paths, in the one place that is read at a glance.
 *
 * INLINE only, and `railPreview` is where that rule is written and tested. What
 * is drawn here is the three marks that change what a sentence MEANS — emphasis
 * makes a word the point, a backtick makes it a name rather than a word, and a
 * link's address is the one part of it nobody can read at 320px. Everything
 * that would change the SHAPE of the preview is flattened before it arrives:
 * this is three lines standing in for forty, and the button beside it is what
 * takes a reader to the forty.
 */
function Quote({ body, max }: { body: string; max: number }) {
  return (
    <p className="m-0 mt-0.5 leading-snug" style={{ color: "var(--text2)" }}>
      {railPreview(body, max).map((s, i) =>
        s.kind === "code" ? <code key={i} style={QUOTE_CODE}>{s.text}</code>
          : s.kind === "bold" ? <b key={i} style={{ fontWeight: 600, color: "var(--text)" }}>{s.text}</b>
            : s.kind === "italic" ? <i key={i}>{s.text}</i>
              : <span key={i}>{s.text}</span>)}
    </p>
  );
}

function Sec({ title, action, children }: {
  title: string; action?: { label: string; on: () => void }; children: React.ReactNode;
}) {
  return (
    <section className="px-2.5 py-2" style={{ borderBottom: edge(12) }}>
      <div className="flex items-baseline gap-2 mb-1.5">
        <h4 className="m-0 text-[9px] uppercase tracking-wider" style={{ color: "var(--text4)" }}>{title}</h4>
        {action && (
          <button onClick={action.on} className="ml-auto text-[9.5px]" style={{ color: "var(--primary)" }}>{action.label}</button>
        )}
      </div>
      {children}
    </section>
  );
}
