/*
 * What the rest of the pull request says about the file in front of you.
 *
 * The journey this removes was measured at six moves: Conversation, scroll the
 * timeline, find the file name, Files, find the file, find the line — and the
 * timeline lost your place on the way. The comment was always there; it lived
 * in a different tab from the code it was about.
 *
 * So the tests here are mostly about when to SHUT UP. A rail that guesses is
 * worse than an empty one: it puts somebody else's paragraph beside your code
 * and lets you believe it is about your code.
 */
import { describe, expect, it } from "bun:test";
import { mentionsPath, argues, namedOnlyInRoster, stripMarkers, saidAbout, checksAbout, threadsAbout, threadsOn, queuedOn, railAge, railPreview } from "../src/lib/fileRail.ts";
import type { PrCheck } from "../../shared/types.ts";

describe("what counts as naming a file", () => {
  it("takes a full path, which is unambiguous", () => {
    expect(mentionsPath("this breaks src/billing/charge.ts for retries", "src/billing/charge.ts")).toBe(true);
  });

  it("takes a distinctive basename", () => {
    expect(mentionsPath("charge-idempotency.ts needs the key", "src/billing/charge-idempotency.ts")).toBe(true);
  });

  it("REFUSES a generic basename, which is a word in a sentence", () => {
    /*
     * `index.ts` appears in forty files and in half the sentences anybody
     * writes about a TypeScript project. Missing a mention costs the trip you
     * were already making; inventing one puts an unrelated argument beside your
     * code and you will believe it.
     */
    expect(mentionsPath("the index.ts barrel is a mess", "src/billing/index.ts")).toBe(false);
    expect(mentionsPath("see types.ts", "src/types.ts")).toBe(false);
  });

  it("refuses a bare word with no extension", () => {
    expect(mentionsPath("the charge flow is wrong", "src/billing/charge")).toBe(false);
  });

  it("refuses a short name, which is a word before it is a file", () => {
    expect(mentionsPath("touch a.ts and we are done", "src/a.ts")).toBe(false);
  });

  it("but the refusal is about bare names, not about those files", () => {
    /*
     * `index.ts` is only ambiguous on its own. Written out in full it points at
     * exactly one file, and a reader who took the trouble to type the path meant
     * the path — dropping that would be shutting up in the one case where the
     * sentence really is about the code in front of you.
     */
    expect(mentionsPath("the barrel in src/billing/index.ts re-exports it", "src/billing/index.ts")).toBe(true);
  });

  it("is case-insensitive, because prose is", () => {
    expect(mentionsPath("Charge-Idempotency.TS is wrong", "src/charge-idempotency.ts")).toBe(true);
  });

  it("answers false rather than throwing on nothing", () => {
    expect(mentionsPath("", "a/b.ts")).toBe(false);
    expect(mentionsPath("text", "")).toBe(false);
  });
});

describe("the markers a machine writes to itself", () => {
  /*
   * Reported from the app: every entry in the column opened with the literal
   * text of an HTML comment. It is how a bot recognises its own output on a
   * second pass, and every renderer GitHub uses drops it — which is why nobody
   * writing one thinks of it as text. Here it was being printed as the first
   * line of the paragraph, so the section's own answer to "what does this say
   * about my file" began with a word about a machine.
   */
  it("takes the marker out and leaves the paragraph", () => {
    expect(stripMarkers("<!-- acme-auto-review -->\n\nThe retry double-charges."))
      .toBe("The retry double-charges.");
  });

  it("takes one out of the middle, and a multi-line one", () => {
    expect(stripMarkers("before <!-- id: 91 --> after")).toBe("before  after");
    expect(stripMarkers("a\n<!--\n run: 4\n-->\nb")).toBe("a\n\nb");
  });

  it("leaves a body that never had one exactly as it was", () => {
    // It runs on every body the rail draws, so it has to be identity on the
    // ordinary case rather than a reformatter nobody asked for.
    const plain = "Two paragraphs.\n\nAnd a second one.";
    expect(stripMarkers(plain)).toBe(plain);
    expect(stripMarkers("")).toBe("");
  });

  it("does not cut at an opener that never closes", () => {
    /*
     * A `<!--` with no `-->` is not a marker, it is prose about HTML, or a body
     * GitHub cut off. Dropping everything after it would delete the argument to
     * hide a fragment.
     */
    expect(stripMarkers("we render <!-- verbatim")).toBe("we render <!-- verbatim");
  });
});

describe("naming a file and being about it, which are not the same thing", () => {
  /*
   * The second half of what he reported: three whole-pull-request summaries
   * beside his file, each pulled in because the file's name appeared in the
   * LIST OF FILES the summary said it had walked over. The same three attached
   * to six files, so switching file changed the column for no reason he could
   * see — and none of the three said anything about any of them.
   *
   * So the rule is per LINE, and the question it asks of the line is whether it
   * has anything to say beyond the name.
   */
  const P = "acme/api/orders.py";
  const ROSTER = "6 files: acme/api/orders.py, acme/api/pricing.py, acme/api/refunds.py, acme/web/cart.ts, acme/web/checkout.ts, acme/jobs/sweep.py";

  it("takes a sentence that argues about the file", () => {
    expect(argues(`The retry in ${P} double-charges when the gateway times out.`, P)).toBe(true);
  });

  it("refuses the manifest of files a summary covered", () => {
    expect(argues(ROSTER, P)).toBe(false);
    expect(argues(ROSTER, "acme/web/checkout.ts")).toBe(false);
  });

  it("refuses a row of a per-file table", () => {
    expect(argues(`| File | Cov |\n| --- | --- |\n| ${P} | 41% |\n| acme/web/cart.ts | 88% |`, P)).toBe(false);
  });

  it("refuses a line that is nothing but the name", () => {
    // A path on a line of its own is an entry in a list, whatever drew the
    // list. It carries no claim to sit beside the code.
    expect(argues(`Files touched:\n${P}\nacme/web/cart.ts`, P)).toBe(false);
  });

  it("refuses one entry of a per-file listing, and keeps a lone terse note", () => {
    /*
     * `- path — 41%` and `- path: double-charges` are the same shape and
     * different things, and no amount of staring at one line separates them.
     * What separates them is siblings: five bullets that all look like that are
     * a table; one is somebody being brief.
     */
    const listing = `- ${P} — 41%\n- acme/web/cart.ts — 88%\n- acme/jobs/sweep.py — 12%`;
    expect(argues(listing, P)).toBe(false);
    expect(argues(`- ${P} — double-charges`, P)).toBe(true);
  });

  it("keeps the argument in a body that is half manifest", () => {
    /*
     * Why the rule reads lines and not bodies. A summary that ends in a
     * paragraph about one of its files is both things at once, and counting the
     * paths in the whole body would throw the paragraph out with the list.
     */
    expect(argues(`${ROSTER}\n\nThe retry in ${P} double-charges.`, P)).toBe(true);
  });

  it("does not count a name that only ever appears inside a marker", () => {
    // Invisible to the reader on GitHub, so it cannot be the reason a paragraph
    // is quoted here — and the paragraph it would drag in says nothing.
    expect(argues(`<!-- reviewed: ${P} -->\n\nLGTM.`, P)).toBe(false);
  });

  it("still refuses what mentionsPath refuses, because it asks it first", () => {
    expect(argues("the charge flow is wrong", "src/billing/charge")).toBe(false);
    expect(argues("", P)).toBe(false);
  });
});

describe("the difference between never named and named in a list", () => {
  /*
   * The sentence the reader gets when the rule above refuses everything.
   * "Nothing in the conversation names it" over a timeline where the file IS
   * listed, six lines up, reads as the column being broken — and sending
   * somebody to check is the trip this section exists to save.
   */
  const P = "acme/api/orders.py";
  const roster = { reviews: [{ author: "p-navarro", body: `6 files: ${P}, acme/web/cart.ts, acme/jobs/sweep.py`, submittedAt: "2026-01-02" }] } as never;

  it("says so when the only thing naming it was a list", () => {
    expect(namedOnlyInRoster(roster, P)).toBe(true);
  });

  it("says nothing of the sort when the file is never named", () => {
    expect(namedOnlyInRoster(roster, "acme/api/nowhere.py")).toBe(false);
    expect(namedOnlyInRoster({} as never, P)).toBe(false);
    expect(namedOnlyInRoster(roster, null)).toBe(false);
  });

  it("and keeps quiet once something really does argue about it", () => {
    // With a paragraph on screen the sentence would be contradicting it.
    const both = { reviews: [
      { author: "p-navarro", body: `6 files: ${P}, acme/web/cart.ts, acme/jobs/sweep.py`, submittedAt: "2026-01-02" },
      { author: "d-okafor", body: `${P} retries without the key`, submittedAt: "2026-01-03" },
    ] } as never;
    expect(namedOnlyInRoster(both, P)).toBe(false);
  });

  it("counts only the entries that could have been quoted", () => {
    /*
     * A bot's comment is kept out of the list below whatever it says, so a bot
     * naming the file cannot be the reason this sentence appears — it would be
     * explaining the absence of a paragraph by a rule that is not the one that
     * removed it.
     */
    const bot = { comments: [{ author: "cov-bot", body: `coverage for ${P} fell`, createdAt: "2026-01-02", isBot: true }] } as never;
    expect(namedOnlyInRoster(bot, P)).toBe(false);
  });
});

describe("what it pulls beside the code", () => {
  const d = {
    reviews: [{ author: "d-okafor", body: "LGTM, but charge-idempotency.ts needs a mirror", submittedAt: "2026-01-02" }],
    comments: [
      { author: "nlombard", body: "unrelated chatter", createdAt: "2026-01-01", isBot: false },
      { author: "ci-bot", body: "coverage for charge-idempotency.ts fell", createdAt: "2026-01-03", isBot: true },
    ],
  } as never;

  it("brings the review that names the file", () => {
    const m = saidAbout(d, "src/charge-idempotency.ts");
    expect(m).toHaveLength(1);
    expect(m[0]!.kind).toBe("review");
  });

  it("leaves the bot out — a coverage table beside the code is noise in a costume", () => {
    expect(saidAbout(d, "src/charge-idempotency.ts").some((x) => x.who === "ci-bot")).toBe(false);
  });

  it("says nothing when no file is selected", () => {
    expect(saidAbout(d, null)).toEqual([]);
  });

  it("brings a person's plain comment too, and says which it was", () => {
    // "A reviewer said" and "somebody commented" are read differently, and the
    // rail labels them, so the two paths into the list are both walked here.
    const withComment = { comments: [
      { author: "nlombard", body: "charge-idempotency.ts is missing the mirror", createdAt: "2026-01-04", isBot: false },
    ] } as never;
    const m = saidAbout(withComment, "src/charge-idempotency.ts");
    expect(m).toHaveLength(1);
    expect(m[0]!.kind).toBe("comment");
  });

  it("reads oldest first, so it is a thread and not a pile", () => {
    const both = {
      reviews: [{ author: "d-okafor", body: "charge-idempotency.ts needs a mirror", submittedAt: "2026-01-05" }],
      comments: [{ author: "nlombard", body: "charge-idempotency.ts again", createdAt: "2026-01-01", isBot: false }],
    } as never;
    expect(saidAbout(both, "src/charge-idempotency.ts").map((m) => m.who)).toEqual(["nlombard", "d-okafor"]);
  });

  it("ignores a verdict left with no words", () => {
    // An approval with an empty body names nothing. It arrives as a review all
    // the same, and an empty paragraph under a heading reads as a bug.
    const empty = { reviews: [{ author: "d-okafor", body: "", submittedAt: "2026-01-02" }] } as never;
    expect(saidAbout(empty, "src/charge-idempotency.ts")).toEqual([]);
  });

  it("survives a detail that carries neither list", () => {
    // Both are optional on the wire, and the rail is drawn from whatever the
    // panel has — including a copy that predates them.
    expect(saidAbout({} as never, "src/charge-idempotency.ts")).toEqual([]);
  });
});

describe("how old the thing beside your code is", () => {
  /*
   * Two characters, because that is the room a 300px column has for it. It
   * exists at all because "d-okafor says this is wrong" reads differently when
   * it was said before the push that rewrote the lines underneath it.
   */
  const now = Date.parse("2026-02-01T12:00:00Z");
  const at = (iso: string) => railAge(iso, now);

  it("counts in the panel's own units, so one comment does not read two ways", () => {
    expect(at("2026-02-01T08:00:00Z")).toBe("4h");
    expect(at("2026-02-01T11:30:00Z")).toBe("30m");
    expect(at("2026-01-29T12:00:00Z")).toBe("3d");
  });

  it("says just now rather than 1m, which is a stopwatch nobody asked for", () => {
    expect(at("2026-02-01T11:59:30Z")).toBe("just now");
  });

  it("says nothing at all when there is no stamp, or a stamp that is not one", () => {
    // An approval with no `submittedAt` is a real thing on the wire, and " · "
    // hanging off a name with nothing after it reads as a bug.
    expect(at("")).toBe("");
    expect(railAge(undefined, now)).toBe("");
    expect(at("not a date")).toBe("");
  });

  it("never goes negative on a clock that is ahead of ours", () => {
    // GitHub's stamp and this machine's clock are two clocks. "-2m ago" is the
    // kind of detail that makes a reader stop trusting the column.
    expect(at("2026-02-01T12:05:00Z")).toBe("just now");
  });
});

describe("the failing checks", () => {
  // `state: "FAILURE"` here was TS2352 in a clean checkout of the commit, and
  // the compiler was right: the server normalises GitHub's `FAILURE` into
  // `"failure"` (prs.ts, `checkState`) before the rail is handed anything, so
  // the uppercase one was a state nothing produces and nothing tests for. The
  // rail reads only `name` and `workflow`, so every assertion below is unmoved
  // — but a fixture that lies about the wire is how the next test gets written
  // against a value that does not exist.
  const c = (name: string, workflow = "CI"): PrCheck => ({ name, workflow, state: "failure", done: true });

  it("does not claim a check blames a file it cannot know about", () => {
    /*
     * A check carries a name and a workflow and no log. The truthful answer is
     * usually "these are failing and I cannot tell you which file broke them" —
     * and promising otherwise is how a panel starts lying quietly.
     */
    const r = checksAbout([c("django-tests")], "src/billing/charge.ts");
    expect(r).toHaveLength(1);
    expect(r[0]!.namesFile).toBe(false);
  });

  it("marks the one that really does name it, and puts it first", () => {
    const r = checksAbout([c("unit"), c("lint src/billing/charge.ts")], "src/billing/charge.ts");
    expect(r[0]!.namesFile).toBe(true);
    expect(r[0]!.check.name).toContain("charge.ts");
  });

  it("reads the workflow as well as the job, because either can carry the name", () => {
    // A matrix job is called "test (3.12)" and the workflow above it is what
    // was named after the thing it builds.
    const r = checksAbout([c("test (3.12)", "charge-idempotency.ts")], "src/charge-idempotency.ts");
    expect(r[0]!.namesFile).toBe(true);
  });

  it("marks nothing while no file is selected", () => {
    // There is no file for a name to match, so a badge would be claiming a link
    // to something the reader has not even picked.
    expect(checksAbout([c("lint src/billing/charge.ts")], null)[0]!.namesFile).toBe(false);
  });
});

describe("threads on this file", () => {
  const d = { threads: [
    { path: "a.ts", isResolved: false }, { path: "a.ts", isResolved: true }, { path: "b.ts", isResolved: false },
  ] } as never;

  it("counts the unresolved ones only — a resolved thread is not something to read", () => {
    expect(threadsOn(d, "a.ts")).toBe(1);
  });

  it("is zero with no file", () => {
    expect(threadsOn(d, null)).toBe(0);
  });

  it("keeps an outdated one — the lines moved, the argument did not", () => {
    const stale = { threads: [{ path: "a.ts", isResolved: false, isOutdated: true, line: null, originalLine: 4 }] } as never;
    expect(threadsAbout(stale, "a.ts")).toHaveLength(1);
  });

  it("lists them in the order you meet them scrolling down", () => {
    const many = { threads: [
      { path: "a.ts", isResolved: false, line: 90 },
      { path: "a.ts", isResolved: false, line: null, originalLine: 12 },
      { path: "a.ts", isResolved: false, line: 3 },
    ] } as never;
    expect(threadsAbout(many, "a.ts").map((t) => t.line ?? t.originalLine)).toEqual([3, 12, 90]);
  });

  it("puts one with no line at all last, not first", () => {
    // Zero would be the natural fallback and it would float the thread nobody
    // can locate above the ones they can.
    const lost = { threads: [
      { path: "a.ts", isResolved: false, line: null },
      { path: "a.ts", isResolved: false, line: 7 },
    ] } as never;
    expect(threadsAbout(lost, "a.ts")[0]!.line).toBe(7);
  });
});

describe("what you queued on this file", () => {
  const drafts = [
    { path: "b.ts", line: 4, body: "another file's note" },
    { path: "a.ts", line: 61, startLine: 58, body: "fold these" },
    { path: "a.ts", line: 22, body: "no key here" },
  ];

  it("keeps the ones on this file and reads down it", () => {
    expect(queuedOn(drafts, "a.ts").map((q) => q.body)).toEqual(["no key here", "fold these"]);
  });

  it("orders a range by where it starts, not where it ends", () => {
    // A comment on 58–61 begins above one on 60, and the rail claims to read
    // in the file's own order.
    const ranged = [{ path: "a.ts", line: 61, startLine: 58, body: "range" }, { path: "a.ts", line: 60, body: "single" }];
    expect(queuedOn(ranged, "a.ts").map((q) => q.body)).toEqual(["range", "single"]);
  });

  it("matches the path exactly — a draft carries the diff's own, so nothing is inferred", () => {
    expect(queuedOn(drafts, "src/a.ts")).toEqual([]);
  });

  it("is empty with no file, and with no review in hand", () => {
    expect(queuedOn(drafts, null)).toEqual([]);
    expect(queuedOn(undefined, "a.ts")).toEqual([]);
  });
});

/*
 * The handle that survives the trip out of the column.
 *
 * Reported: "should have a button that takes us to that exact comment on the
 * conversation section". A per-entry jump needs a name for the entry that means
 * the same thing on both ends of it, and the detail offers two — `url` and
 * `nodeId`.
 *
 * `nodeId` is the one, because it is an IDENTITY and the other is a
 * DESTINATION. A GraphQL node id names one object and encodes its type in the
 * prefix, so a single string picks out the right entry whichever of the two
 * lists it came from; the panel already threads it through every conversation
 * card, because reactions and edit and delete are keyed on it. A `url` is the
 * address of that entry ON GITHUB — in the panel it is spelled `Open on
 * GitHub`, the one control that leaves the app — and to use it in-app somebody
 * would have to parse `#issuecomment-901` back into a type and an id that were
 * already sent, typed, in the field beside it.
 */
describe("what a quoted entry is called, once it is out of the column", () => {
  const P = "acme/api/charge-idempotency.ts";

  it("carries the review's node id, not just its words", () => {
    const d = {
      reviews: [{ author: "d-okafor", body: `${P} retries without the key`, submittedAt: "2026-01-02", nodeId: "PRR_kwDOacme7", url: "https://github.example/acme/orbit/pull/12#pullrequestreview-7" }],
    } as never;
    expect(saidAbout(d, P)[0]!.nodeId).toBe("PRR_kwDOacme7");
  });

  it("and the comment's, which is a different kind of object under the same rule", () => {
    const d = {
      comments: [{ author: "nlombard", body: `${P} double-charges on a retry`, createdAt: "2026-01-02", isBot: false, nodeId: "IC_kwDOacme901" }],
    } as never;
    expect(saidAbout(d, P)[0]!.nodeId).toBe("IC_kwDOacme901");
  });

  it("treats an empty id as no id, because the server writes one when GitHub sends none", () => {
    /*
     * `nodeId: r.id || ""` on the wire. An empty string is not an address, and
     * a control that promised to take you to `""` would take everybody to the
     * same nowhere — so it has to be indistinguishable from absent here, which
     * is what lets the rail refuse to draw the button at all.
     */
    const d = { comments: [{ author: "nlombard", body: `${P} double-charges`, createdAt: "2026-01-02", isBot: false, nodeId: "" }] } as never;
    expect(saidAbout(d, P)[0]!.nodeId).toBeUndefined();
  });
});

/*
 * The quote, as markdown and not as its punctuation.
 *
 * Reported from the app, against a real review: the first entry in the column
 * read `Review Summary 1 Critical. 1 High. 5 Medium. 4 Low. **Pre-check
 * reports:** could not read /tmp/…` — asterisks and backticks on screen,
 * because the column drew the body as plain text.
 *
 * INLINE only, and that is the whole design. This is a 320px column showing a
 * three-line preview of a forty-line body; rendering the block structure would
 * grow the preview into the thing it is a preview OF, and the jump beside it is
 * what takes somebody to the full one. So a heading is a sentence here, a list
 * is its items, a fence is nothing, and what survives is the marks that change
 * what a sentence MEANS: emphasis, an identifier, and the words of a link.
 */
describe("the preview, once the marks are read rather than printed", () => {
  const plain = (spans: { text: string }[]) => spans.map((s) => s.text).join("");
  const kinds = (spans: { kind: string; text: string }[], k: string) => spans.filter((s) => s.kind === k).map((s) => s.text);

  it("turns bold into bold and keeps its words", () => {
    const s = railPreview("**Review Summary** 1 critical, 4 low.", 260);
    expect(kinds(s, "bold")).toEqual(["Review Summary"]);
    expect(plain(s)).toBe("Review Summary 1 critical, 4 low.");
    expect(plain(s)).not.toContain("*");
  });

  it("marks an identifier as code without its backticks", () => {
    const s = railPreview("could not read `/tmp/acme-precheck.json`", 260);
    expect(kinds(s, "code")).toEqual(["/tmp/acme-precheck.json"]);
    expect(plain(s)).not.toContain("`");
  });

  it("reduces a link to the words it was written as", () => {
    // The URL is the one part of a link that cannot be read at 320px, and the
    // entry now has a button whose whole job is going somewhere.
    const s = railPreview("see [the earlier thread](https://github.example/acme/orbit/pull/12#issuecomment-9)", 260);
    expect(plain(s)).toBe("see the earlier thread");
  });

  it("flattens the blocks instead of drawing them", () => {
    /*
     * Every one of these is a shape that would either print its punctuation or
     * grow the preview past the three lines it has. A heading becomes its
     * sentence, a list becomes its items, a fence becomes nothing, and a
     * table's rule row is a drawing rather than a reading.
     */
    const body = "## Findings\n\n- one thing\n- another\n\n```ts\nconst x = 1;\n```\n\n> quoted\n\n| File | Cov |\n| --- | --- |\n| a.ts | 41% |";
    const out = plain(railPreview(body, 400));
    expect(out).toBe("Findings one thing another const x = 1; quoted File · Cov a.ts · 41%");
    for (const mark of ["##", "```", "|", "- one"]) expect(out).not.toContain(mark);
  });

  it("still strips the marker a machine wrote to itself", () => {
    // The rule that got this column readable in the first place, and it has to
    // survive being routed through a new function.
    expect(plain(railPreview("<!-- acme-auto-review -->\n\nthe retry double-charges", 260))).toBe("the retry double-charges");
  });

  it("spends the budget on words rather than on markup", () => {
    /*
     * The clip used to count the raw body, so `**Review Summary**` cost 18 of
     * the 260 characters the column has and showed 14 of them. Counting what is
     * actually drawn is the only version of "260" a reader could verify.
     */
    const s = railPreview("**abcdefghij** klmno", 12);
    expect(plain(s)).toBe("abcdefghij k…");
    expect(kinds(s, "bold")).toEqual(["abcdefghij"]);
  });

  it("says nothing about a body that had nothing in it", () => {
    expect(railPreview("", 260)).toEqual([]);
    expect(railPreview("<!-- only a marker -->", 260)).toEqual([]);
  });

  it("leaves a Python dunder alone, which is why __bold__ is not read", () => {
    /*
     * `__init__` and `__all__` are the commonest double-underscore runs in any
     * review of Python, and they are identifiers rather than emphasis. Reading
     * `__` as bold would eat the name and print `init` in bold in the middle of
     * a sentence about it, so only the asterisk form is emphasis — the cost is
     * that a body written with `__bold__` keeps its underscores, which is a
     * visible nuisance rather than a wrong word.
     */
    expect(plain(railPreview("the retry in __init__ and __all__ is unguarded", 260)))
      .toBe("the retry in __init__ and __all__ is unguarded");
  });
});
