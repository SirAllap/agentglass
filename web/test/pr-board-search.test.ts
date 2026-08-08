/*
 * A search and the board cannot both be on screen, and the board must not be
 * the one that wins.
 *
 * Reported from the app, as the second half of the branch-chip bug: with the
 * board on, pressing the chip typed a number into the search box, the panel
 * counted its way to "388 matches", and the screen never changed — because
 * `TriageBoard` draws `boardMine`/`boardReview`, its own two fetches, and does
 * not look at `prs` at all. The search finished and nothing on screen was about
 * it.
 *
 * `PrPanel` is a six-thousand-line component with no exported seam here, so
 * this reads the source. That is a weak test of behaviour and a strong test of
 * the thing that actually regresses: the gate is one identifier, and the bug
 * was that identifier being the stored setting instead of what is on screen.
 */
import { describe, expect, it } from "bun:test";

const src = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();

describe("a search falls through to the table", () => {
  it("derives what is shown from the query, not only from the stored setting", () => {
    expect(src).toContain("const boardShown = boardOn && !searching;");
    expect(src).toContain("const searching = query.trim().length > 0;");
  });

  it("gates the board on what is shown", () => {
    expect(src).toContain("{boardShown && repo && !listState.needsAuth ? (");
    // The old gate is what shipped the bug. If it comes back, so does the bug.
    expect(src).not.toContain("{boardOn && repo && !listState.needsAuth ? (");
  });

  it("lights the pill by what is on screen", () => {
    /*
     * A lit pill over a table is the panel saying where you are and being
     * wrong. Three style properties read it; all three have to agree.
     */
    expect(src.split("boardShown ? \"var(--bg)\"").length - 1).toBe(1);
    expect(src.split("background: boardShown ?").length - 1).toBe(1);
    expect(src).toContain("border: `1px solid ${boardShown ? \"var(--primary)\"");
  });

  it("gives the pill a way back, because clearing the box is the only one", () => {
    expect(src).toContain("if (searching) setQuery(\"\"); setBoard(true);");
  });

  it("does not light a scope pill while the board is showing", () => {
    // The scopes are the table's; with the board up none of them is active,
    // and with a search up one of them is.
    expect(src).toContain("const on = !boardShown && activeView?.id === v.id;");
  });
});

/*
 * The rail's verdict buttons, and the one guard they must not carry.
 *
 * `FileRail` draws Approve / Request changes / Comment only when it is handed
 * handlers, so a half-wiring degrades to the old sentence instead of to a dead
 * button — which is why "it renders" proves nothing here and this reads the
 * wiring instead.
 *
 * What matters is WHICH state they arm. The panel already holds a review draft
 * that survives a tab change and a rebuild; a second one owned by the rail
 * would mean two verdicts in flight and a Review tab that disagrees with the
 * column beside it about what you decided.
 */
describe("the rail arms the panel's own review", () => {
  it("reads and writes the draft the Review tab uses", () => {
    /*
     * `myReview.verb` unconditionally. It was gated on a stored draft existing,
     * and `setMyReview` DELETES the entry when the verb is "comment" and the
     * body is empty — so pressing Comment with nothing typed un-armed the
     * verdict and left all three buttons unlit. Found by the correctness audit.
     */
    expect(src).toContain("verdict={myReview.verb}");
    expect(src).not.toContain("verdict={hasReviewDraft ? myReview.verb : undefined}");
    for (const verb of ["approve", "request_changes", "comment"]) {
      expect(src).toContain(`setMyReview({ verb: "${verb}" })`);
    }
  });

  it("keeps the Review tab's guard rather than sending an empty verdict", () => {
    // `nothing` in ReviewTab is `!body.trim() && drafts.length === 0`, and its
    // submit is disabled on `verb !== "approve" && nothing`. The rail cannot
    // see the body, so it re-states the same condition instead of trusting one.
    expect(src).toContain('myReview.verb !== "approve" && !myReview.body.trim() && myDrafts.length === 0');
    expect(src).toContain('setTab("review");');
  });

  it("draws nothing when the viewer may not review", () => {
    // Own pull request: the buttons are not disabled, they are absent, which is
    // what the rail does with an undefined handler.
    expect(src).toContain("onApprove={canReview ?");
    expect(src).toContain("onSubmit={canReview ?");
  });
});

/*
 * The one-screen review's three columns, against the mockup that specifies them.
 *
 *   .three{grid-template-columns:250px minmax(0,1fr) 320px}
 *   .three>*{max-height:calc(100vh - 200px)}
 *   .three>*{overflow:auto}
 *
 * The app had 190 and 300, and one scroll for all three: the tree was bounded
 * and the diff and the rail were not, so they grew and the page scrolled
 * underneath them. Reading down the diff dragged the rail's paragraphs off the
 * top with it — reported as «deben tener dos scroll».
 *
 * The numbers are asserted from the stylesheet rather than from the components
 * because that is where they now live, and they live there because the Tailwind
 * build silently drops `min-[1180px]:` — measured: a `bg-red-500` in the same
 * className reaches the CSS and the arbitrary variant does not. A number that
 * can fail to exist is worse than a number in a file.
 */
const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text();
const rail = await Bun.file(new URL("../src/components/FileRail.tsx", import.meta.url)).text();

describe("the three columns", () => {
  it("each scrolls on its own", () => {
    expect(css).toContain(".agx-col3 { max-height: 100%; overflow-y: auto; overflow-x: hidden; }");
    /* Two carry the class; the tree caps itself against the viewport instead,
       for the reason in the test below. */
    expect(src.split("agx-col3").length - 1).toBe(1);
    expect(css).toContain(".agx-tree3 { width: 250px; max-height: calc(100vh - 160px); overflow-y: auto; }");
    expect(rail).toContain("agx-col3");
  });

  it("never scrolls sideways", () => {
    /*
     * Setting either axis to something other than `visible` makes the other
     * compute to `auto`. Asking for a vertical scroll therefore handed the
     * column a horizontal one, and the toolbar inside it was full-bleed by
     * negative margin — 12px of overflow drew a scrollbar across the whole
     * width of the app. Measured: scrollWidth 1605 against clientWidth 1593.
     *
     * Both halves are pinned: the axis is shut, and the thing that stuck out is
     * gone, because clipping a bar that still sticks out only hides it.
     */
    expect(css).toContain("overflow-x: hidden");
    expect(src).not.toContain('sticky top-0 z-30 -mx-3 px-3 py-2');
    expect(src).toContain('tab === "files" ? "overflow-hidden p-0" : "overflow-y-auto p-3"');
  });

  it("does not also sit inside a scrolling page", () => {
    // Three bounded columns inside a scroller is four scrolls and feels like
    // one, which is the bug.
    expect(src).toContain('className="flex min-h-0 gap-0 items-start h-full"');
  });

  it("caps the tree against the viewport, because a percentage cannot resolve there", () => {
    /*
     * The tree is `position: sticky` inside the diff's scroller, so its
     * containing block is a content-sized flex row — and CSS resolves a
     * percentage max-height against one of those as `none`. Measured with the
     * tree forced to 2252px: no scrollbar, and a bottom edge at 2584 against a
     * 617px window. With the viewport cap: max-height 457, scrollHeight 2252,
     * scrollable true.
     */
    expect(css).toContain(".agx-tree3 { width: 250px; max-height: calc(100vh - 160px); overflow-y: auto; }");
    expect(src).not.toContain("agx-tree3 agx-col3");
  });

  it("uses the mockup's widths", () => {
    expect(css).toContain(".agx-tree3 { width: 250px;");
    expect(rail).toContain("width: 320");
    expect(css).not.toContain("width: 190px");
  });

  it("keeps the rail down to the width the mockup draws it to", () => {
    // Tailwind's `xl` is 1280; the mockup hides the rail at 1180. The column was
    // vanishing a hundred pixels early, and nobody chose that.
    expect(css).toContain("@media (min-width: 1180px) { .agx-rail { display: flex; } }");
    expect(rail).not.toContain("xl:flex");
  });
});

describe("the rail follows the file on screen", () => {
  it("is handed what is drawn, not what was clicked", () => {
    /*
     * In one-file mode nothing is picked until you click, and Files falls back
     * to the first file the filter left. The rail did not, so a diff with a
     * file in it sat beside a column saying "Nothing selected".
     */
    expect(src).toContain("path={showingFile ?? selFile}");
    expect(src).toContain("const showing = oneFile ? (sel ?? shownFiles[0]?.path ?? null) : sel;");
    expect(src).toContain("onShowing?.(showing)");
  });

  it("draws the same file it names", () => {
    // The render filters on the same expression, so the two cannot drift.
    expect(src).toContain("shownFiles.filter((f) => f.path === showing)");
  });
});

/*
 * Round two, all four reported from the app with screenshots.
 *
 * These read the source. `PrPanel` is six thousand lines with no seam at any of
 * these points, and a source assertion is a weak test of behaviour but a strong
 * test of the thing that actually regressed here: in three of the four the bug
 * was one literal — a hard-coded lane, a missing fold, a sentence chosen for the
 * wrong surface.
 */
const dialog = await Bun.file(new URL("../src/components/MergeDialog.tsx", import.meta.url)).text();

describe("who is talking, in the Humans/Bots filter", () => {
  it("reads the lane off the thread instead of assuming a person", () => {
    /*
     * A line-comment thread was pushed with `lane: "human"` whatever wrote it,
     * so automation arguing on the diff was counted as people: "Humans 8" on a
     * pull request no person had touched but the author.
     */
    expect(src).toContain('const lane: Lane = t.comments[0]?.isBot ? "bot" : "human";');
    expect(src).not.toContain('key: `t${t.id}`, lane: "human"');
  });
});

describe("a resolved thread arrives folded", () => {
  it("opens on the flag, so pressing Resolve folds it there and then", () => {
    expect(src).toContain("const [open, setOpen] = useState(!t.isResolved);");
    expect(src).toContain("useEffect(() => { setOpen(!t.isResolved); }, [t.isResolved]);");
  });

  it("says how much is under it, so a done can be told from an argument", () => {
    expect(src).toContain("Show resolved · ");
    expect(src).toContain("{t.comments.length}");
  });
});

describe("merging past a review somebody owes you", () => {
  it("carries who was asked, and whether a person approved", () => {
    // `reviewers` is GitHub's outstanding request list — it drops somebody the
    // moment they submit — so non-empty on an open PR is "asked, still waiting".
    expect(src).toContain("awaitingReview: detail.reviewers.map((r) => r.login)");
    expect(src).toContain('humanApproved: detail.reviews.some((r) => !r.isBot && r.state === "APPROVED")');
  });

  it("warns in the dialog rather than blocking the button", () => {
    // There are good reasons to land ahead of a review you asked for. What the
    // panel must not do is let the press happen without the fact on screen.
    expect(dialog).toContain("awaitingReview?: string[]");
    expect(dialog).toContain("asked to review and");
    expect(dialog).toContain("The approval that unblocked this came from automation.");
    expect(dialog).not.toContain("disabled={pending.awaitingReview");
  });
});

describe("the strip, at the mockup's wording", () => {
  it("says the short version of the checks, counting only what passed", async () => {
    /*
     * Asserted on the generators rather than on the panel's source, because
     * these are pure and importable and the panel is not. The earlier version
     * of this test read `PrPanel.tsx` as text and went green the moment the
     * expression moved — which is the whole failure mode a source assertion
     * has.
     *
     * `success`, never `total`: the rollup counts skipped, stale and neutral in
     * its total, so a repository with path-filtered jobs read "45 passed" in
     * green when forty had run.
     */
    const { checksShort, checksLine } = await import("../src/lib/mergeReason.ts");
    const c = { total: 45, success: 40, failure: 0, skipped: 5, pending: 0, allDone: true, verdict: "green", failing: [] } as never;
    expect(checksShort(c)).toBe("40 passed · 5 skipped");
    // And the cell's own tooltip must not disagree with the cell. It did, by
    // five checks, because the fix landed in one of the two and not the other.
    expect(checksLine(c)).toContain("40 checks passed");
    expect(checksLine(c)).toContain("5 checks skipped");
    expect(checksLine(c)).not.toContain("45 checks passed");
  });

  it("never presents a capped page as the whole story", async () => {
    const { checksShort, checksLine } = await import("../src/lib/mergeReason.ts");
    const c = { total: 130, success: 100, failure: 0, skipped: 30, pending: 0, allDone: true, verdict: "green", failing: [] } as never;
    expect(checksShort(c, true)).toContain("of the page returned");
    expect(checksLine(c, undefined, true)).toContain("of the page GitHub returned");
    // No arithmetic about the cap: `total` is the size of the page that came
    // back, so a number there would be about the wrong set.
    expect(checksShort(c, true)).not.toContain("130");
  });

  it("still names what failed, where there is room for a name", () => {
    // A count sends you to the browser; a name does not.
    expect(src).toContain('c.failure > 0 ? mergeBlockedWhy("UNSTABLE", c)');
  });

  it("prints the review zeros rather than dropping the cell's shape", () => {
    expect(src).not.toContain("{threads > 0 && <>");
    expect(src).not.toContain("{queued > 0 && <>");
    expect(src).toContain("{queued} queued");
  });

  it("draws labels as words, not as boxes — in the strip, and only there", () => {
    /*
     * Scoped to the strip's own cell on purpose. The row list and the sidebar
     * keep their coloured chips: those have room, and there a colour is how you
     * find a label without reading. It is the row of nine cells that has to
     * read as one line.
     */
    const cell = src.slice(src.indexOf('<Field label="Labels" max={300}>'));
    const strip = cell.slice(0, cell.indexOf("</Field>"));
    expect(strip).not.toContain("<Chip");
    expect(strip).toContain('<span className="uppercase tracking-wide truncate">{l.name}</span>');
    // The other surfaces are untouched, and this says so out loud.
    expect(src).toContain("{shownLabels.map((l) => <Chip key={l.name}");
  });
});

describe("a reply looks like a reply", () => {
  it("hangs off what it answers, with air and a line back to it", () => {
    /*
     * Reported: "manage better spacing between the comment and the responses,
     * proper spacing and proper line to identify what that comment is
     * answering". A reply was indented fourteen pixels past the remark above it
     * and tinted, which on a long thread reads as another paragraph — and with
     * several replies nothing said which one each was answering.
     *
     * Measured on the rendered thread afterwards: the reply block sits at
     * padding-left 30 against the remark's 12, has 12px of air above and below
     * (it had 8), carries a 1px rule between blocks, and the rail runs its full
     * 66px height at x=15.
     */
    expect(src).toContain("paddingLeft: i ? 30 : 12,");
    expect(src).toContain('borderTop: i ? "1px solid color-mix(in srgb, var(--text) 10%, transparent)" : undefined,');
    expect(src).toContain("{ left: 15, top: 0, bottom: 0, width: 2, borderRadius: 1,");
  });

  it("the rail is decoration and says so", () => {
    // It carries no information a screen reader needs — the indentation and
    // the order already say who is answering whom.
    const i = src.indexOf('style={{ left: 15, top: 0, bottom: 0, width: 2');
    expect(src.slice(Math.max(0, i - 200), i)).toContain("aria-hidden");
  });
});
