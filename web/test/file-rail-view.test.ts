/*
 * The rail as a person reads it.
 *
 * `file-rail.test.ts` pins the rules; this pins the sentences they turn into,
 * because every failure this column can have is a sentence that is confidently
 * wrong. A rail that says "nothing in the conversation names it" over a detail
 * that has not landed, or that hangs "names this file" on a check which does
 * not, is not broken in any way a type or a rule test would notice — it renders,
 * it is well formed, and it is lying.
 *
 * There is no DOM here (bun test, no jsdom), so the component is rendered to
 * static markup exactly like `server-banner-desktop.test.ts` does. That covers
 * everything the rail is: it holds no state and runs no effects, so the markup
 * IS the component.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FileRail } from "../src/components/FileRail.tsx";
import type { PrDetail } from "../../shared/types.ts";

const FILE = "web/src/lib/charge-idempotency.ts";

/*
 * A pull request with something to say about that file, and a lot of noise
 * around it. Only the fields the rail reads are filled — the detail is fifty
 * fields wide and the other forty-odd would be scenery.
 */
const detail = (over: Partial<PrDetail> = {}): PrDetail => ({
  mergeState: "CLEAN",
  viewerRequested: false,
  checks: { total: 3, success: 3, failure: 0, skipped: 0, pending: 0, allDone: true, verdict: "green", failing: [] },
  reviews: [],
  comments: [],
  threads: [],
  ...over,
} as unknown as PrDetail);

const noop = () => {};

const render = (props: Partial<Parameters<typeof FileRail>[0]> = {}): string =>
  renderToStaticMarkup(React.createElement(FileRail, {
    d: detail(),
    path: FILE,
    onGoConversation: noop,
    onGoChecks: noop,
    onGoReview: noop,
    onMerge: noop,
    canMerge: true,
    ...props,
  }));

/** How many times a sentence is on screen. `toContain` cannot tell one badge
 *  from three, and "which check got the badge" is the whole question below. */
const times = (html: string, needle: string): number => html.split(needle).length - 1;

/** A section heading, exactly — "Merge" is also three words of prose in the box
 *  underneath it, and `indexOf("Merge")` would find the sentence first. */
const head = (html: string, title: string): number => html.indexOf(`>${title}</h4>`);

/** Whether that text is inside a button rather than beside one. "The row is the
 *  way to the log" is a claim about the element, and `toContain("<button")`
 *  would pass on a button anywhere else in the column. */
const inButton = (html: string, needle: string): boolean => {
  const i = html.indexOf(needle);
  if (i < 0) return false;
  return html.lastIndexOf("<button", i) > html.lastIndexOf("</button>", i);
};

describe("the sections, against the mockup", () => {
  /*
   * The mockup is the contract: SAID ABOUT THIS FILE · CHECKS BLAMING THIS FILE
   * · YOUR REVIEW · MERGE. It is pinned here because the rail has two sections
   * the mockup never had — threads, and what you queued — and the easy way to
   * add a third is to drop it wherever the JSX happened to end.
   */
  test("the four the mockup draws are there, spelled and ordered as it spells them", () => {
    const html = render({ drafts: [] });
    for (const t of ["Said about this file", "Checks blaming this file", "Your review", "Merge"]) {
      expect(head(html, t)).toBeGreaterThan(-1);
    }
    expect(head(html, "Said about this file")).toBeLessThan(head(html, "Checks blaming this file"));
    expect(head(html, "Checks blaming this file")).toBeLessThan(head(html, "Your review"));
    expect(head(html, "Your review")).toBeLessThan(head(html, "Merge"));
  });

  test("the two it does not draw sit beside the one each extends", () => {
    /*
     * A thread is something said about this file that happens to be anchored to
     * a line, so it belongs under what was said. What you queued is what the
     * verdict underneath is about to send, so it belongs above it. Anywhere else
     * and the four above stop reading in the order the mockup put them in.
     */
    const html = render({ drafts: [] });
    expect(head(html, "Said about this file")).toBeLessThan(head(html, "Threads on this file"));
    expect(head(html, "Threads on this file")).toBeLessThan(head(html, "Checks blaming this file"));
    expect(head(html, "Queued by you")).toBeLessThan(head(html, "Your review"));
  });

  test("the merge box says where the rest of itself is", () => {
    // It is a summary of a box with six reasons and eight buttons in it. A
    // summary that does not admit to being one is just a smaller wrong answer.
    expect(render()).toContain("The whole box lives in Overview");
  });
});


describe("while the detail is still arriving", () => {
  test("it says it is still reading, and claims nothing", () => {
    /*
     * The bug this pins: a rail filtered from a detail in flight found nothing,
     * because there was nothing there yet, and reported that as a finding. The
     * reader's next move — not opening the Conversation tab — was decided by a
     * sentence that was about the network.
     */
    const html = render({ loading: true });
    expect(html).not.toContain("Nothing in the conversation names it");
    expect(html).toContain("Still reading the conversation");
    // The same mistake in the sections beside it: no thread and no failing
    // check are equally findings, drawn from the same unfinished object.
    expect(html).not.toContain("No unresolved thread sits on its lines");
    expect(html).not.toContain("Nothing is failing");
  });

  test("and once it has landed it commits to an answer", () => {
    const html = render();
    expect(html).toContain("Nothing in the conversation names it");
    expect(html).toContain("Nothing is failing");
    expect(html).not.toContain("Still reading");
  });

  test("what it already holds is still shown while it refreshes", () => {
    // Stale-while-revalidate: the held copy is painted at once and corrected
    // behind you. "Loading" must soften the empty sentences, never blank the
    // content — that would be the pane going dark on every poll.
    const html = render({
      loading: true,
      d: detail({ comments: [{ author: "d-okafor", body: `the retry in ${FILE} double-charges`, createdAt: "2026-01-02", isBot: false }] as never }),
    });
    expect(html).toContain("double-charges");
  });
});

describe("when GitHub only sent one page of it", () => {
  /*
   * The same class of lie as the loading state above, and it survives the fix
   * for it: the detail has landed, so nothing is "still reading" — but a
   * hundred-and-first comment was never in the object the rail filters, and
   * "nothing in the conversation names it" is a claim about a conversation the
   * rail has not seen. `truncated.comments` is the number that DID come back —
   * the page came back full — which is why the sentence names it rather than
   * apologising vaguely.
   *
   * It is wording and not a flag on purpose. There is nothing to press: no more
   * to fetch, no setting to change, no second page to ask for. A warning badge
   * over a fact the reader can do nothing about is decoration, and decoration
   * next to a wrong sentence does not make the sentence right.
   */
  const capped = (over: Record<string, number>) => detail({ truncated: over } as never);

  test("the empty answer is scoped to the page it was read from", () => {
    const html = render({ d: capped({ comments: 80 }) });
    expect(html).toContain("Nothing names it in the most recent 80 comments — GitHub caps the page there.");
    expect(html).not.toContain("Nothing in the conversation names it");
  });

  test("and it says so even when it did find something", () => {
    // Finding one mention does not mean it found them all, and the section's
    // own provenance line is where that belongs — the reader is deciding
    // whether this is the whole argument or the visible end of it.
    const html = render({
      d: detail({
        truncated: { comments: 80 },
        comments: [{ author: "d-okafor", body: `the retry in ${FILE} double-charges`, createdAt: "2026-01-02", isBot: false }],
      } as never),
    });
    expect(html).toContain("Only the most recent 80 comments came back");
  });

  test("the neighbouring sections get the same treatment, because a page size is not special to comments", () => {
    /*
     * Threads cap at 80 and checks at 100 on the same wire. Softening one
     * sentence and leaving the two beside it asserting would read as a bug
     * rather than as a policy — which is the reason `loading` softens all three.
     */
    const html = render({ d: capped({ threads: 80, checks: 100 }) });
    expect(html).toContain("No unresolved thread in the most recent 80 sits on its lines");
    expect(html).toContain("Nothing is failing in the 100 checks GitHub returned");
  });

  test("still reading beats capped, because it has not finished counting either", () => {
    const html = render({ loading: true, d: capped({ comments: 80 }) });
    expect(html).toContain("Still reading the conversation");
    expect(html).not.toContain("most recent 80");
  });

  test("and an uncapped page keeps the plain sentence", () => {
    // The control: the caveat must not become the default, or every rail on
    // every small pull request starts hedging about a page nobody hit.
    const html = render();
    expect(html).toContain("Nothing in the conversation names it.");
    expect(html).not.toContain("caps the page");
  });
});

describe("who gets to be beside your code", () => {
  const d = detail({
    comments: [
      { author: "d-okafor", body: `the retry in ${FILE} double-charges`, createdAt: "2026-01-02", isBot: false },
      { author: "codecov", body: `patch coverage of ${FILE} fell to 41 percent`, createdAt: "2026-01-03", isBot: true },
    ] as never,
  });

  test("a person who names the file is quoted", () => {
    // The control for the test below: without it, "the bot is absent" would
    // also pass on a rail that rendered nobody at all.
    const html = render({ d });
    expect(html).toContain("double-charges");
    expect(html).toContain("d-okafor");
  });

  test("a bot never reaches the rail, however precisely it names the file", () => {
    /*
     * The bot names the path better than the human does. That is exactly why
     * the filter cannot be about relevance: a coverage table beside the code is
     * noise wearing the costume of a review, and it would outrank the sentence
     * that actually argues with you.
     */
    const html = render({ d });
    expect(html).not.toContain("codecov");
    expect(html).not.toContain("41 percent");
  });

  test("it says where the paragraph came from, and how old it is", () => {
    /*
     * Both are the mockup's, and both are the same worry. A paragraph beside
     * your code with no provenance reads as something the panel wrote; and one
     * with no age reads as current, when what usually decides whether a review
     * comment still applies is whether it predates the last push.
     */
    const html = render({
      d: detail({ comments: [{ author: "d-okafor", body: `${FILE} double-charges`, createdAt: new Date(Date.now() - 4 * 3600_000).toISOString(), isBot: false }] as never }),
    });
    expect(html).toContain("From Conversation — pulled here because it names this file.");
    expect(html).toContain("comment · 4h");
  });
});

/*
 * Reported from the app, against a real pull request, as two questions asked in
 * one breath: «¿qué significan los comentarios de la derecha? ¿y por qué al
 * seleccionar un file unos tienen unos comentarios y otros otro?»
 *
 * Both are this section failing at the only thing it promises. Every entry
 * opened with the literal text of an HTML comment — a marker a machine writes
 * to recognise its own output, invisible everywhere it was meant to be read and
 * printed here as the first line of the paragraph. And the entries under it
 * were three whole-pull-request summaries, pulled in because the file's name
 * appeared in the LIST OF FILES the summary said it had covered. The same three
 * attached to six different files, so changing file changed the column for no
 * reason the reader could see, and none of the three said anything about any of
 * them.
 *
 * The fixtures are invented and the shapes are his.
 */
describe("what a machine wrote to itself, and what a roster is not", () => {
  const PY = "acme/api/orders.py";
  const TS = "acme/web/checkout.ts";
  const MARKER = "<!-- acme-auto-review -->";
  /** The summary he actually saw: a verdict, a tally, and the manifest of files
   *  the pass walked over. It names six paths and argues about none. */
  const ROSTER = `${MARKER}\n\n**Review Summary**\n\n0 blocking. 0 major. 2 minor.\n\n6 files: acme/api/orders.py, acme/api/pricing.py, acme/api/refunds.py, acme/web/cart.ts, acme/web/checkout.ts, acme/jobs/sweep.py`;
  const review = (body: string, over: Record<string, unknown> = {}) =>
    ({ author: "p-navarro", body, submittedAt: "2026-01-02", isBot: false, state: "COMMENTED", ...over });
  const railOf = (html: string) => html.slice(html.indexOf("Said about this file"), html.indexOf("Threads on this file"));

  test("the marker is a machine talking to itself and never reaches the reader", () => {
    const html = render({
      path: PY,
      d: detail({ reviews: [review(`${MARKER}\n\nThe retry in ${PY} double-charges when the gateway times out.`)] as never }),
    });
    // Rendered, so `<` is `&lt;` — the assertion has to be on the text, not on
    // the punctuation it arrives escaped as.
    expect(html).not.toContain("auto-review");
    expect(html).not.toContain("--&gt;");
    // And the paragraph it was hiding in front of is still there, undamaged.
    expect(html).toContain("double-charges");
  });

  test("a summary that lists the six files it covered is not about any of them", () => {
    const html = render({ path: PY, d: detail({ reviews: [review(ROSTER)] as never }) });
    expect(railOf(html)).not.toContain("0 blocking");
    // Not a quiet drop: the section says it found nothing to quote, which is
    // the state it already knows how to be in. Which sentence, three tests down.
    expect(railOf(html)).not.toContain("From Conversation");
  });

  test("and it is refused on every file it lists, which is the whole complaint", () => {
    /*
     * The bug as he met it: one summary, six files, and a column that changed
     * under him with no pattern he could see. A rule that lets it through on
     * one of the six is the same bug with a smaller blast radius.
     */
    const d = detail({ reviews: [review(ROSTER)] as never });
    for (const p of [PY, TS, "acme/jobs/sweep.py"]) {
      expect(railOf(render({ path: p, d }))).not.toContain("0 blocking");
    }
  });

  test("a coverage table is a table however it is filed", () => {
    // The same shape as the roster and a different author: rows of paths and
    // numbers. It reaches the rail as a review, where the bot rule that keeps
    // coverage comments out does not apply.
    const table = `| File | Coverage |\n| --- | --- |\n| ${PY} | 41% |\n| ${TS} | 88% |`;
    const html = render({ path: PY, d: detail({ reviews: [review(table, { author: "coverage-bot", isBot: true })] as never }) });
    expect(railOf(html)).not.toContain("41%");
  });

  test("a review that argues about the file in prose is still quoted", () => {
    // The control. Refusing the roster is only worth anything if the sentence
    // the reader came for survives it.
    const html = render({
      path: PY,
      d: detail({ reviews: [review(`${PY} retries the charge without the idempotency key.`)] as never }),
    });
    expect(html).toContain("without the idempotency key");
    expect(html).toContain("p-navarro");
  });

  test("a body that lists the files AND then argues about one keeps the argument", () => {
    /*
     * Why the rule reads lines and not whole bodies. A summary that ends in a
     * paragraph about one of its files is both things at once, and a rule that
     * counted the paths in the body would throw the paragraph away with the
     * manifest.
     */
    const html = render({
      path: PY,
      d: detail({ reviews: [review(`${ROSTER}\n\nThe retry in ${PY} double-charges when the gateway times out.`)] as never }),
    });
    expect(html).toContain("double-charges");
  });

  test("a thread anchored to the file is real by construction, marker and all", () => {
    /*
     * Nothing above may touch these. A thread carries the diff's own path and a
     * review comment written ON the file's lines arrives as one, so there is
     * nothing to infer and no roster to mistake it for — but the marker is
     * still a marker.
     */
    const html = render({
      path: PY,
      d: detail({ threads: [{
        id: "t1", path: PY, line: 12, isResolved: false, isOutdated: false,
        comments: [{ id: "t1c", author: "p-navarro", isBot: false, body: `${MARKER}\n\nthis loses the timeout`, createdAt: "2026-01-02" }],
      }] as never }),
    });
    expect(html).toContain("this loses the timeout");
    expect(html).toContain("1 unresolved");
    expect(html).not.toContain("auto-review");
  });

  test("named only in a roster is a different answer from never named", () => {
    /*
     * The sentence he would have read next. "Nothing in the conversation names
     * it" over a timeline where his file IS listed, six lines up, reads as the
     * column being broken — which is exactly the trip this section exists to
     * save. So the empty state says which of the two it is.
     */
    const listed = render({ path: PY, d: detail({ reviews: [review(ROSTER)] as never }) });
    expect(listed).toContain("Named only in a list of files — nothing argues about it.");
    expect(listed).not.toContain("Nothing in the conversation names it");
    // And a pull request that never mentions it keeps the plain sentence.
    expect(render({ path: PY })).toContain("Nothing in the conversation names it");
  });
});

describe("the failing checks", () => {
  const check = (name: string) => ({ name, workflow: "CI", state: "FAILURE", done: true });
  const d = detail({
    mergeState: "UNSTABLE",
    checks: {
      total: 4, success: 2, failure: 2, skipped: 0, pending: 0, allDone: true, verdict: "red",
      failing: [check("integration (postgres)"), check(`lint ${FILE}`)],
    } as never,
  });

  test("only the check whose own name carries the file is badged", () => {
    /*
     * A check carries a name and a workflow and no log. Two are red, one of
     * them says the path out loud, and the other cannot be tied to anything —
     * so exactly one badge. A rail that badged both would be inventing the
     * connection the reader came here to get, and they would believe it.
     */
    const html = render({ d });
    expect(html).toContain("integration (postgres)");
    expect(times(html, "names this file")).toBe(1);
  });

  test("nothing is badged when no file is selected", () => {
    // With no path there is nothing for a name to match, and the badge would be
    // claiming a link to a file the reader has not even picked.
    const html = render({ d, path: null });
    expect(times(html, "names this file")).toBe(0);
  });

  test("under a heading that promises a link, a list with no link says so first", () => {
    /*
     * "Checks blaming this file" is the mockup's heading and the data cannot
     * always keep it: a check carries a name and no log. The red ones are still
     * all listed — hiding what is blocking the merge because it could not be
     * pinned to a file would be the rail keeping back the one thing you cannot
     * get anywhere else on this screen — so the section says it plainly instead.
     */
    const html = render({ d: detail({
      mergeState: "UNSTABLE",
      checks: { total: 2, success: 1, failure: 1, skipped: 0, pending: 0, allDone: true, verdict: "red",
        failing: [check("integration (postgres)")] } as never,
    }) });
    expect(html).toContain("integration (postgres)");
    expect(html).toContain("None of these names this file — a check carries a name and no log.");
  });

  test("and it keeps quiet the moment one of them really does name it", () => {
    // With a badge on screen the disclaimer would be contradicting it.
    expect(render({ d })).not.toContain("None of these names this file");
  });

  test("a failing check is the way to its log, not a line of text", () => {
    // The mockup puts "Open the log" under the check. The rail has no log
    // viewer and the Checks tab does, so the row goes there rather than growing
    // a second place to read the same output.
    const html = render({ d });
    expect(html).toContain(`title="Open the log"`);
    expect(inButton(html, "integration (postgres)")).toBe(true);
  });
});

describe("your review, which is a review and not a sentence about one", () => {
  /*
   * The mockup's "Your review" is three verdicts, the count of what goes with
   * them and a send — all of it in the rail, because the verdict is the reason
   * the sections above it were read and it was two tabs away from the code it
   * is about.
   *
   * Every handler is optional, and that is the interesting part: the rail must
   * still draw for a caller that holds no review, and a button with no handler
   * is not drawn dead, it is not drawn.
   */
  const wired = { onApprove: noop, onRequestChanges: noop, onComment: noop, onSubmit: noop };

  test("unwired, it says what the tab is for and offers no buttons", () => {
    const html = render();
    expect(html).toContain("Approve, request changes or comment");
    expect(html).not.toContain("Submit review");
    expect(html).not.toContain("✓ Approve");
  });

  test("wired, the three verdicts and the send are in the column", () => {
    const html = render({ ...wired, queuedCount: 2 });
    expect(html).toContain("✓ Approve");
    expect(html).toContain("✕ Request changes");
    expect(html).toContain("💬 Comment");
    expect(html).toContain("Submit review");
    // And the sentence they replace is gone: with the buttons on screen it was
    // reading them back to you.
    expect(html).not.toContain("Approve, request changes or comment —");
  });

  test("each button is only there if something answers it", () => {
    // Half-wired is a real state while a caller is being built, and three
    // buttons of which two do nothing is the worst version of it.
    const html = render({ onApprove: noop, onSubmit: noop });
    expect(html).toContain("✓ Approve");
    expect(html).not.toContain("✕ Request changes");
    expect(html).toContain("Submit review");
  });

  test("it counts the whole review, where the section above counts this file", () => {
    /*
     * "One notification, not 3" is about what submitting sends, and a review
     * sends every file's queued lines. Two numbers, different on purpose, one
     * screen apart — the rail must not swap them.
     */
    const html = render({ ...wired, drafts: [
      { path: FILE, line: 22, body: "on this file" },
      { path: "web/src/lib/other.ts", line: 4, body: "on another" },
    ] });
    expect(html).toContain("2 line comments go with it — one notification, not 3.");
    expect(html).toContain("1 pending comment");
  });

  test("one of them is not spelled as one comments go", () => {
    expect(render({ ...wired, queuedCount: 1 })).toContain("1 line comment goes with it — one notification, not 2.");
  });

  test("nothing queued says so rather than counting to zero", () => {
    expect(render({ ...wired, queuedCount: 0 })).toContain("No line comments queued — the verdict goes on its own.");
  });

  test("your own pull request cannot be approved or blocked, and the row shows it", () => {
    /*
     * GitHub refuses both on your own work and the Review tab already greys them
     * for it. Drawn and disabled rather than dropped: the row is the shape of
     * the choice, and a gap where Approve was reads as a bug in the rail.
     */
    const html = render({ ...wired, d: detail({ viewerDidAuthor: true } as never) });
    expect(html).toContain("✓ Approve");
    expect(times(html, "disabled=")).toBe(2);
    expect(html).toContain("GitHub does not let you approve or block your own pull request");
  });

  test("the armed verdict looks armed, and an unwired one claims nothing", () => {
    // Submitting from here sends whatever the panel holds, so which one it
    // holds is the one fact this section cannot leave out. Absent prop, no
    // claim: three buttons and none of them pressed.
    expect(render({ ...wired, verdict: "request_changes" })).toContain(`aria-pressed="true"`);
    expect(render({ ...wired })).not.toContain(`aria-pressed="true"`);
  });

  test("being asked by name still gets said", () => {
    // Not in the mockup, kept anyway: it is the answer to "why am I in this
    // pull request at all", and it is only ever on screen when it is true.
    expect(render({ ...wired, d: detail({ viewerRequested: true } as never) })).toContain("You were asked to look at this.");
  });
});

describe("the threads sitting on this file", () => {
  const thread = (id: string, line: number | null, over: Record<string, unknown> = {}) => ({
    id, path: FILE, line, isResolved: false, isOutdated: false,
    comments: [{ id: `${id}c`, author: "nlombard", isBot: false, body: `thread ${id} body`, createdAt: "2026-01-02" }],
    ...over,
  });

  test("counts the unresolved ones and offers the way over", () => {
    const html = render({ d: detail({ threads: [
      thread("t1", 12),
      thread("t2", 40),
      thread("t3", 8, { isResolved: true }),
      { ...thread("t4", 5), path: "web/src/other.ts" },
    ] as never }) });
    expect(html).toContain("2 unresolved");
    expect(html).toContain("Conversation");
    // The one on another file must not be counted with them, resolved or not.
    expect(html).not.toContain("thread t4 body");
    expect(html).not.toContain("thread t3 body");
  });

  test("reads down the file, not in the order GitHub returned them", () => {
    const html = render({ d: detail({ threads: [thread("t1", 90), thread("t2", 12)] as never }) });
    expect(html.indexOf("thread t2 body")).toBeLessThan(html.indexOf("thread t1 body"));
  });
});

describe("what you have queued on this file", () => {
  const drafts = [
    { path: FILE, line: 22, body: "this retries without the key" },
    { path: FILE, line: 61, startLine: 58, body: "fold these three into the helper" },
    { path: "web/src/lib/other.ts", line: 4, body: "unrelated note" },
  ];

  test("counts only the ones on this file, and shows what they say", () => {
    /*
     * The whole point of the section: a queued comment lives in a box under one
     * line, so once you have scrolled past it you cannot tell it from a comment
     * you never wrote. Two here, and the third belongs to another file's rail.
     */
    const html = render({ drafts });
    expect(html).toContain("2 pending comments");
    expect(html).toContain("this retries without the key");
    expect(html).toContain("fold these three into the helper");
    expect(html).not.toContain("unrelated note");
    // A range says where it starts, because "Line 61" on a three-line comment
    // sends you to the wrong end of it.
    expect(html).toContain("Lines 58–61");
  });

  test("one is not spelled as one comments", () => {
    expect(render({ drafts: [drafts[0]!] })).toContain("1 pending comment —");
  });

  test("an empty queue answers, an absent one keeps quiet", () => {
    /*
     * Two different states that would read identically if the section always
     * drew itself: "you have left nothing here" is worth saying, and "this
     * caller does not hold a review" is not something to say at all.
     */
    expect(render({ drafts: [] })).toContain("Nothing queued on this file");
    expect(render()).not.toContain("Queued by you");
  });

  test("and it is not shown against a file you have not picked", () => {
    // The rail's promise is "about this file". With no file there is no this.
    expect(render({ drafts, path: null })).not.toContain("Queued by you");
  });
});

/*
 * The verdict, which is about GitHub and not about CI.
 *
 * Found by the agent that wrote the sections above and left as pre-existing:
 * with `mergeState: "CLEAN"` and nothing reported, this box drew "◯ Not
 * mergeable" over a repository that would have merged it on the spot. The line
 * came from `mergeBlockedWhy`, which answers "why is it blocked" and has no
 * entry for CLEAN because CLEAN is not blocked — so it reached its own last
 * resort and printed it as a fact.
 *
 * The panel's box never had the bug: it asks whether GitHub will take it first
 * and only then why not. These pin the rail to that same ladder, because the
 * rail's own last line calls itself the short version of that box.
 */
describe("the merge verdict", () => {
  const noChecks = { total: 0, success: 0, failure: 0, skipped: 0, pending: 0, allDone: false, verdict: "none", failing: [] };

  test("CLEAN with nothing reported is not called unmergeable", () => {
    const html = render({ d: detail({ mergeState: "CLEAN", checks: noChecks as never }) });
    expect(html).not.toContain("Not mergeable");
    expect(html).toContain("Nothing is blocking it");
  });

  test("CLEAN with checks still running says to wait, not that it is blocked", () => {
    const html = render({ d: detail({ mergeState: "CLEAN",
      checks: { total: 45, success: 44, failure: 0, skipped: 0, pending: 1, allDone: false, verdict: "pending", failing: [] } as never }) });
    expect(html).toContain("Waiting for the checks");
    expect(html).not.toContain("Not mergeable");
  });

  test("CLEAN over a red check says GitHub is not requiring it, not that it is blocked", () => {
    /*
     * The state that reads as a contradiction and is not: `mergeState` is
     * GitHub's answer about branch protection, and a failing check it never
     * asked for does not change it. Saying "blocked" here sends somebody to fix
     * a check nothing is waiting on.
     */
    const html = render({ d: detail({ mergeState: "CLEAN",
      checks: { total: 3, success: 2, failure: 1, skipped: 0, pending: 0, allDone: true, verdict: "red",
        failing: [{ name: "lint", workflow: "ci" }] } as never }) });
    expect(html).toContain("GitHub is not requiring it");
    expect(html).not.toContain("Not mergeable");
  });

  test("green and CLEAN still reads as ready", () => {
    expect(render()).toContain("Ready to merge");
  });

  test("a real block still says what is blocking it", () => {
    const html = render({ d: detail({ mergeState: "DIRTY" }) });
    expect(html).toContain("conflicts with the base branch");
    expect(html).not.toContain("Nothing is blocking it");
  });

  test("the button only dares you to override when there is something to override", () => {
    // The rail is handed `CLEAN || BEHIND`, so a pressable button is not proof
    // that nothing is in the way — behind the base branch is a reason.
    expect(render({ d: detail({ mergeState: "CLEAN", checks: noChecks as never }) })).not.toContain("Merge anyway");
    const behind = render({ d: detail({ mergeState: "BEHIND" }) });
    expect(behind).toContain("Merge anyway");
    expect(behind).toContain("update the branch first");
  });
});

/*
 * Reported against the column, in one line: "should have a button that takes us
 * to that exact comment on the conversation section".
 *
 * The section already had a way out — `Timeline` in its header — and it is the
 * wrong shape for what the reader is doing. It drops you at the TOP of the
 * Conversation tab, with a dozen entries above the one you were reading, and
 * the thing you were looking at is a three-line preview of a forty-line body.
 * So the way through belongs to the ENTRY, not to the section.
 *
 * Optional, and absent means not drawn. A rail must still be drawable by a
 * caller that has not wired the jump yet, and a button that goes nowhere is
 * worse than no button: it is a promise the column cannot keep, made in the one
 * place whose whole job is not lying about what it knows.
 */
describe("the way from a quote to the entry it came from", () => {
  const NODE = "IC_kwDOacme901";
  /** The address on GitHub, which is a different thing from the identity — see
   *  the rules test. It is here so the assertions can watch it NOT be used. */
  const URL = "https://github.example/acme/orbit/pull/12#issuecomment-901";

  const one = (over: Record<string, unknown> = {}) => detail({
    comments: [{
      author: "d-okafor", body: `the retry in ${FILE} double-charges`,
      createdAt: "2026-01-02", isBot: false, url: URL, nodeId: NODE, ...over,
    }] as never,
  });

  /** The jump control's own opening tag, so a claim about its size is a claim
   *  about IT — the column is full of buttons and `toContain("width:20px")`
   *  would pass on any of them. */
  const jumpTag = (html: string): string => {
    const i = html.indexOf("data-node=");
    if (i < 0) return "";
    return html.slice(html.lastIndexOf("<button", i), html.indexOf(">", i) + 1);
  };

  test("with nobody to take the jump, the control is not drawn at all", () => {
    const html = render({ d: one() });
    // The quote is there — this is the state where only the button is missing.
    expect(html).toContain("double-charges");
    expect(html).not.toContain("data-node=");
    expect(html).not.toContain("Open this in the conversation");
  });

  test("wired, the entry carries its own way through, addressed by node id", () => {
    const html = render({ d: one(), onGoToMention: noop });
    expect(html).toContain(`data-node="${NODE}"`);
    expect(html).toContain("Open this in the conversation");
    /*
     * And NOT by url. The two are both on the detail and only one of them is an
     * identity: a url is where the entry lives on github.com — the panel spells
     * it "Open on GitHub", the one control that leaves the app — and the ask was
     * to land on it in the Conversation tab, here.
     */
    expect(html).not.toContain("issuecomment-901");
  });

  test("a review is addressed the same way, which is why one handler can take both", () => {
    // A node id encodes the type in its prefix, so `PRR_…` and `IC_…` cannot be
    // confused for one another and the caller needs no second argument to say
    // which list to look in.
    const html = render({
      onGoToMention: noop,
      d: detail({ reviews: [{ author: "p-navarro", body: `${FILE} retries without the key`, submittedAt: "2026-01-02", nodeId: "PRR_kwDOacme7" }] as never }),
    });
    expect(html).toContain(`data-node="PRR_kwDOacme7"`);
  });

  test("one per entry, not one per section", () => {
    /*
     * The whole complaint. A single link in the header is what the section had,
     * and it cannot say WHICH of the four quotes you were reading — which is the
     * only thing the reader knows and the only thing the trip needs.
     */
    const html = render({
      onGoToMention: noop,
      d: detail({ comments: [
        { author: "d-okafor", body: `the retry in ${FILE} double-charges`, createdAt: "2026-01-02", isBot: false, nodeId: "IC_1" },
        { author: "nlombard", body: `${FILE} needs the mirror too`, createdAt: "2026-01-03", isBot: false, nodeId: "IC_2" },
      ] as never }),
    });
    expect(times(html, "data-node=")).toBe(2);
    expect(html).toContain(`data-node="IC_1"`);
    expect(html).toContain(`data-node="IC_2"`);
    // The section's own link stays: it is the answer to a different question —
    // "show me the conversation" rather than "show me this".
    expect(html).toContain("Timeline");
  });

  test("an entry with no identity gets no button, even with the handler wired", () => {
    /*
     * `nodeId: r.id || ""` on the wire, and a cached detail taken before the
     * field existed has none at all. A control drawn over an entry that cannot
     * be found again would be the column making a promise it has no address for.
     */
    const html = render({ d: one({ nodeId: "" }), onGoToMention: noop });
    expect(html).toContain("double-charges");
    expect(html).not.toContain("data-node=");
  });

  test("the control is sized as an icon, not as the 9.5px line it sits on", () => {
    /*
     * The house rule, and the reason it is written down: an icon-only control
     * that inherits its row's type scale comes out at seven pixels of ink. So
     * the glyph gets an explicit size off the ladder — ICON.sm, "inline with
     * body text, for an affordance that should not lead" — and the box gets a
     * size of its own, because growing the glyph alone leaves the same thin
     * target.
     */
    const tag = jumpTag(render({ d: one(), onGoToMention: noop }));
    expect(tag).toContain("font-size:14px");
    expect(tag).toContain("width:20px");
    expect(tag).toContain("height:20px");
    // An icon with no words needs one somewhere, or the control is a shape.
    expect(tag).toContain(`aria-label="Open this in the conversation"`);
  });
});

/*
 * The quote, as markdown and not as its punctuation.
 *
 * Reported from the app, against a real review. The first entry in the column
 * read, literally:
 *
 *   Review Summary 1 Critical. 1 High. 5 Medium. 4 Low. **Pre-check reports:**
 *   could not read `/tmp/…`
 *
 * — because the column drew every body as plain text, so a review written in
 * markdown arrived with its marks on show.
 *
 * INLINE only. This is a 320px column showing a three-line preview of a
 * forty-line body: rendering the block structure would grow the preview into
 * the thing it is a preview of, and the button beside it is what takes somebody
 * to the full one. `file-rail.test.ts` pins the flattening rule; these pin that
 * the rail is what renders it.
 */
describe("the quote reads as it was written", () => {
  const said = (body: string) => detail({
    comments: [{ author: "d-okafor", body, createdAt: "2026-01-02", isBot: false, nodeId: "IC_1" }] as never,
  });

  test("bold is bold, an identifier is code, and neither shows its marks", () => {
    const html = render({ d: said(`**Pre-check reports:** could not read \`/tmp/acme.json\` for ${FILE}`) });
    expect(html).toContain("<b");
    expect(html).toContain("Pre-check reports:</b>");
    expect(html).toContain("<code");
    expect(html).toContain("/tmp/acme.json</code>");
    // The marks themselves are gone. `**` would arrive verbatim; a backtick is
    // not escaped by React, so it would arrive verbatim too.
    expect(html).not.toContain("**");
    expect(html).not.toContain("`");
  });

  test("a link keeps its words and drops its address", () => {
    const html = render({ d: said(`see [the earlier thread](https://github.example/acme/orbit/pull/9) about ${FILE}`) });
    expect(html).toContain("see the earlier thread");
    expect(html).not.toContain("github.example");
  });

  test("no block structure reaches the column, because a preview that grows is not one", () => {
    const html = render({ d: said(`## Findings\n\n- ${FILE} double-charges\n- and it retries\n\n\`\`\`ts\nconst x = 1;\n\`\`\``) });
    expect(html).toContain("Findings");
    expect(html).toContain("double-charges");
    for (const tag of ["<h1", "<h2", "<h3", "<ul", "<ol", "<li", "<pre", "<table"]) {
      expect(html).not.toContain(tag);
    }
    // And the punctuation that would have been drawn is not printed instead.
    expect(html).not.toContain("##");
    expect(html).not.toContain("```");
  });
});

/*
 * Three the audits found in this column, all of them the same shape: a box that
 * keeps acting on a pull request it should have stopped acting on.
 */
describe("what the rail stops saying", () => {
  const green = { total: 3, success: 3, failure: 0, skipped: 0, pending: 0, allDone: true, verdict: "green", failing: [] };
  const empty = { total: 0, success: 0, failure: 0, skipped: 0, pending: 0, allDone: false, verdict: "none", failing: [] };

  test("a merged pull request is history, not something to merge", () => {
    /*
     * `mergeStateOf` answers "UNKNOWN" for anything GitHub reports no
     * mergeability for, which is what it reports once a pull request has
     * merged. So this column drew "◯ GitHub has not finished working it out"
     * under a "Merge anyway…" button on something that landed an hour ago,
     * while Overview one tab away said "Merged".
     */
    const html = render({ d: detail({ state: "MERGED", mergeState: "UNKNOWN", checks: green as never }) });
    expect(html).not.toContain("Merge anyway");
    expect(html).not.toContain("GitHub has not finished working it out");
    expect(html).toContain("Merged into");
  });

  test("a closed one says so too, and offers nothing", () => {
    const html = render({ d: detail({ state: "CLOSED", mergeState: "UNKNOWN", checks: green as never }) });
    expect(html).toContain("Closed without merging");
    expect(html).not.toContain("Submit review");
  });

  test("an open one keeps its box", () => {
    expect(render({ d: detail({ state: "OPEN", mergeState: "CLEAN", checks: green as never }) }))
      .toContain("Ready to merge");
  });

  test("right after a push it waits, like every other surface", () => {
    // The panel computes `awaitingChecks` once and hands it to the masthead and
    // to Overview. The rail was never given it, so an empty rollup read as
    // "nothing has reported" and the column said "Nothing is blocking it" while
    // the masthead said "waiting for them to start" on the same screen.
    const d = detail({ state: "OPEN", mergeState: "CLEAN", checks: empty as never });
    expect(render({ d })).toContain("Nothing is blocking it");
    expect(render({ d, awaitingChecks: true } as never)).toContain("Waiting for the checks");
  });
});
