/*
 * The Inbox and CI views of the PRs panel after they lost their side rail and
 * their five buttons: the reason chips, the day groups, the four tiles and the
 * one status word of a row are pure functions; the layout rules are asserted
 * against the source because this project has no renderer.
 */
import { describe, expect, test } from "bun:test";
import { emptyCopy, FACETS, inboxScreen, inFacet, reasonChips, rowLook } from "../src/lib/ghInbox.ts";
import { inboxCiState } from "../src/lib/inboxCiText.ts";
import { chipCounts, dayBars, failingDetail, failingPrs, inChip, parseSortChoice, passChip, passDelta, passDetail, sortChoice, SORT_CHOICES, DEFAULT_SORT, statusChip, tileFacts, TILES, tileOf, toRow, viewOfTile } from "../src/lib/ciMetrics.ts";
import type { InboxItem } from "../../shared/types.ts";
import type { CheckAggregate, CheckMetric, SameCommit } from "../../shared/checkBaseline.ts";

const note = (over: Partial<InboxItem>): InboxItem => ({
  id: "1", unread: true, reason: "subscribed", type: "PullRequest",
  repo: "acme/orbit", title: "A title", at: Date.parse("2026-08-19T10:00:00Z"), number: 10,
  ...over,
});

describe("reason chips", () => {
  const items = [
    note({ id: "a", reason: "review_requested" }),
    note({ id: "b", reason: "mention" }),
    note({ id: "c", reason: "mention" }),
    note({ id: "d", reason: "team_mention" }),
    note({ id: "e", reason: "subscribed" }),
  ];
  const by = (id: string) => reasonChips(items).find((c) => c.id === id)!;

  test("the first chip is every reason, and counts the whole list", () => {
    const chips = reasonChips(items);
    expect(chips[0]).toMatchObject({ id: "", label: "Everything", n: 5 });
    expect(chips.slice(1).map((c) => c.id)).toEqual(FACETS.map((f) => f.id));
  });
  test("the six chips of the mockup come first, in its order, then the two GitHub filters it does not draw", () => {
    expect(reasonChips(items).map((c) => c.label)).toEqual([
      "Everything", "Review requested", "Mentioned", "CI", "Assigned", "Subscribed", "Team mentioned", "Participating",
    ]);
  });
  test("CI is the workflow-run reason and Subscribed is watching, whether by default or by hand", () => {
    expect(inFacet(note({ reason: "ci_activity", type: "CheckSuite" }), "ci")).toBe(true);
    expect(inFacet(note({ reason: "subscribed" }), "subscribed")).toBe(true);
    expect(inFacet(note({ reason: "manual" }), "subscribed")).toBe(true);
    expect(inFacet(note({ reason: "mention" }), "subscribed")).toBe(false);
  });
  test("each chip counts what pressing it would leave", () => {
    expect(by("review").n).toBe(1);
    expect(by("mentioned").n).toBe(2);
    expect(by("team").n).toBe(1);
    expect(by("assigned").n).toBe(0);
    expect(by("subscribed").n).toBe(1);
    for (const c of reasonChips(items).slice(1)) expect(c.n).toBe(items.filter((n) => inFacet(n, c.id)).length);
  });
  test("participating counts the threads the person is in, not the ones merely watched", () => {
    expect(by("participating").n).toBe(4);
  });
  test("an empty list is five zeros and the all chip at zero", () => {
    expect(reasonChips([]).every((c) => c.n === 0)).toBe(true);
  });
});

const s = (n: number) => n * 1000;
const flat = (m: number, n = 14) => Array.from({ length: n }, (_, i) => ({ day: `2026-09-${String(i + 1).padStart(2, "0")}`, runs: 3, median: m }));
const steady: SameCommit = { flips: 0, judged: 12, unknown: 0, days: 14 };
const metric = (name: string, o: Partial<CheckAggregate> = {}): CheckMetric => ({
  key: `CI\u0001${name}\u0001pull_request`, workflow: "CI", name, event: "pull_request",
  aggregate: { runs: 40, successes: 38, latest: { ms: s(600), conclusion: "success", completedAt: 0 }, median: s(600), p90: s(700), failureRate: 0.02, trend: flat(s(600)), sameCommit: steady, ...o },
});
const rows = [
  toRow(metric("usual")),
  toRow(metric("slow", { latest: { ms: s(1620), conclusion: "success", completedAt: 0 } })),
  toRow(metric("rerun", { sameCommit: { ...steady, flips: 2 } })),
  toRow(metric("drifting", { trend: [...flat(s(600), 7), ...flat(s(756), 7)] })),
  toRow(metric("broken", { latest: { ms: s(5), conclusion: "failure", completedAt: 0 } })),
];

describe("the five tiles", () => {
  test("Pass rate, Median run, Re-run passed, Drifting and Failing now, each the entrance to one chip", () => {
    expect(TILES).toEqual(["pass", "median", "rerun", "drifting", "failing"]);
    expect(TILES.map(viewOfTile)).toEqual(["all", "slow", "rerun", "drifting", "failing"]);
    for (const t of TILES) expect(tileOf(viewOfTile(t))).toBe(t);
  });
  test("each tile filters the history to what its number says, and every old filter is still reachable", () => {
    const counts = chipCounts(rows);
    for (const t of TILES) expect(rows.filter((r) => inChip(viewOfTile(t), r)).length).toBe(counts[viewOfTile(t)]);
    expect(counts.all).toBe(5);
    expect(rows.filter((r) => inChip("slow", r)).map((r) => r.name)).toEqual(["slow"]);
    expect(rows.filter((r) => inChip("rerun", r)).map((r) => r.name)).toEqual(["rerun"]);
    expect(rows.filter((r) => inChip("drifting", r)).map((r) => r.name)).toEqual(["drifting"]);
    expect(rows.filter((r) => inChip("failing", r)).map((r) => r.name)).toEqual(["broken"]);
  });
  test("the figures: counts from the chips, a runs-weighted pass rate, the median of the usual times", () => {
    const f = tileFacts(rows, chipCounts(rows));
    expect(f.rerun.value).toBe("1");
    expect(f.drifting.value).toBe("1");
    expect(f.failing).toMatchObject({ value: "1", tone: "bad" });
    // five checks of 40 runs, each failing 2%: 98%
    expect(f.pass.value).toBe("98%");
    expect(f.median.value).toBe("10m");
    expect(f.median.detail).toBe("1 slow now");
  });
  test("nothing failing reads as good, and no rows read as dashes rather than 0%", () => {
    const none = tileFacts([], chipCounts([]));
    expect(none.pass.value).toBe("\u2014");
    expect(none.median.value).toBe("\u2014");
    expect(none.failing).toMatchObject({ value: "0", tone: "good" });
  });
  test("a poor pass rate changes the tone, not the figure", () => {
    const sick = [toRow(metric("a", { failureRate: 0.4 })), toRow(metric("b", { failureRate: 0.2 }))];
    const f = tileFacts(sick, chipCounts(sick));
    expect(f.pass).toMatchObject({ value: "70%", tone: "warn" });
  });
});

describe("the lines under the pass rate and Failing now", () => {
  /** Two weeks of days, each with the counts the server keeps: the older week first. */
  const weeks = (before: [number, number], now: [number, number]) => [
    ...Array.from({ length: 7 }, (_, i) => ({ day: `2026-09-${i + 1}`, runs: 1, median: s(60), passed: i === 0 ? before[0] : 0, failed: i === 0 ? before[1] : 0 })),
    ...Array.from({ length: 7 }, (_, i) => ({ day: `2026-09-${i + 8}`, runs: 1, median: s(60), passed: i === 0 ? now[0] : 0, failed: i === 0 ? now[1] : 0 })),
  ];
  test("the week's change is whole points of the pass rate over all checks, and says nothing out of too few runs", () => {
    expect(passDelta([{ trend: weeks([90, 10], [92, 8]) }])).toBe(2);
    expect(passDelta([{ trend: weeks([92, 8], [88, 12]) }])).toBe(-4);
    // two checks pool their runs: 18/20 against 19/20 is five points, not an average of two small weeks
    expect(passDelta([{ trend: weeks([9, 1], [9, 1]) }, { trend: weeks([9, 1], [10, 0]) }])).toBe(5);
    expect(passDelta([{ trend: weeks([2, 1], [90, 10]) }])).toBeNull();
    expect(passDelta([{ trend: weeks([90, 10], [2, 1]) }])).toBeNull();
    // a record kept before the days were counted has no week to compare
    expect(passDelta([{ trend: flat(s(600)) }])).toBeNull();
  });
  test("Pass rate reads 'last N runs' with the change when there is one", () => {
    expect(passDetail(100, 2)).toBe("last 100 runs \u00b7 +2 vs last week");
    expect(passDetail(100, -3)).toBe("last 100 runs \u00b7 \u22123 vs last week");
    expect(passDetail(100, 0)).toBe("last 100 runs \u00b7 level with last week");
    expect(passDetail(120, null)).toBe("last 120 runs");
    expect(passDetail(1, null)).toBe("last 1 run");
  });
  test("Failing now names the pull requests only when the record does", () => {
    expect(failingPrs([{ failed: true, thisPr: 1044 }, { failed: true, thisPr: 1051 }, { failed: true, thisPr: 1044 }, { failed: false, thisPr: 1060 }])).toBe(2);
    expect(failingPrs([{ failed: true, thisPr: null }])).toBeNull();
    expect(failingDetail(2)).toBe("on 2 pull requests");
    expect(failingDetail(1)).toBe("on 1 pull request");
    expect(failingDetail(null)).toBe("newest run failed");
  });
  test("the tiles carry both lines", () => {
    const sick = [
      toRow(metric("a", { trend: weeks([90, 10], [92, 8]), runs: 200, latest: { ms: s(5), conclusion: "failure", completedAt: 0, pr: 1044 } })),
      toRow(metric("b", { trend: weeks([90, 10], [92, 8]), runs: 200, latest: { ms: s(5), conclusion: "failure", completedAt: 0, pr: 1051 } })),
    ];
    const f = tileFacts(sick, chipCounts(sick));
    expect(f.pass.detail).toBe("last 400 runs \u00b7 +2 vs last week");
    expect(f.failing.detail).toBe("on 2 pull requests");
  });
});

describe("a row's one status chip", () => {
  const word = (name: string) => statusChip(rows.find((r) => r.name === name)!)?.label ?? null;
  test("says what is notable, and nothing for a run that is just usual", () => {
    expect(word("usual")).toBeNull();
    expect(word("slow")).toBe("much slower");
    expect(word("rerun")).toBe("Re-run passed");
    expect(word("drifting")).toBe("drifting");
    expect(word("broken")).toBe("Failed");
  });
  test("a failed run outranks a re-run, which outranks a slow one", () => {
    const base = rows[0]!;
    expect(statusChip({ ...base, failed: true, rerun: true, verdict: "much-slower" })?.label).toBe("Failed");
    expect(statusChip({ ...base, rerun: true, verdict: "much-slower" })?.label).toBe("Re-run passed");
    expect(statusChip({ ...base, verdict: "slower", drift: 0.3 })?.label).toBe("slower");
  });
  test("faster is the only good news", () => {
    expect(statusChip({ ...rows[0]!, verdict: "faster" })).toEqual({ label: "faster", tone: "good" });
  });
});

describe("how a row looks", () => {
  test("the tile's tone follows the reason and its icon follows the kind of thing", () => {
    expect(rowLook({ type: "PullRequest", reason: "review_requested" })).toEqual({ icon: "review", tone: "warn" });
    expect(rowLook({ type: "PullRequest", reason: "mention" })).toEqual({ icon: "comment", tone: "bad" });
    expect(rowLook({ type: "CheckSuite", reason: "ci_activity" })).toEqual({ icon: "ci", tone: "warn" });
    expect(rowLook({ type: "Issue", reason: "subscribed" })).toEqual({ icon: "issue", tone: "muted" });
    expect(rowLook({ type: "PullRequest", reason: "author" })).toEqual({ icon: "pr", tone: "muted" });
  });
  test("an unknown reason and type fall back to a quiet pull request tile, never to nothing", () => {
    expect(rowLook({ type: "Release", reason: "something_new" })).toEqual({ icon: "pr", tone: "muted" });
  });
});

describe("the dot on a row", () => {
  const pr = (number: number, headRefName: string, c: Partial<{ total: number; failure: number; pending: number }>) =>
    ({ number, headRefName, checks: { total: 3, success: 3, failure: 0, skipped: 0, pending: 0, allDone: true, verdict: "green" as const, failing: [], ...c } });
  const prs = [pr(7, "feat/a", {}), pr(8, "feat/b", { failure: 1 }), pr(9, "feat/c", { pending: 2 }), pr(10, "feat/d", { total: 0 })];
  const row = (number: number | undefined, over: Partial<InboxItem> = {}) => note({ number, repo: "acme/orbit", ...over });
  test("failing wins over running, which wins over green", () => {
    expect(inboxCiState(row(7), prs, "acme/orbit")).toBe("ok");
    expect(inboxCiState(row(8), prs, "acme/orbit")).toBe("bad");
    expect(inboxCiState(row(9), prs, "acme/orbit")).toBe("run");
  });
  test("a pull request with no checks, one that is not loaded, an issue and another repository have no dot", () => {
    expect(inboxCiState(row(10), prs, "acme/orbit")).toBeNull();
    expect(inboxCiState(row(99), prs, "acme/orbit")).toBeNull();
    expect(inboxCiState(row(7, { type: "Issue" }), prs, "acme/orbit")).toBeNull();
    expect(inboxCiState(row(7), prs, "acme/other")).toBeNull();
  });
  test("a failed workflow run finds its pull request by branch", () => {
    expect(inboxCiState(row(undefined, { type: "CheckSuite", title: "CI workflow run failed for feat/b branch" }), prs, "acme/orbit")).toBe("bad");
  });
});

describe("what the list area shows", () => {
  test("a refused read with nothing to show is an error, never an empty inbox", () => {
    expect(inboxScreen(null, "", 0)).toBe("loading");
    expect(inboxScreen(null, "Could not reach the server", 0)).toBe("error");
    expect(inboxScreen(0, "API rate limit exceeded", 0)).toBe("error");
  });
  test("rows already on screen stay when a later read is refused", () => {
    expect(inboxScreen(4, "API rate limit exceeded", 4)).toBe("rows");
    expect(inboxScreen(4, "", 0)).toBe("empty");
    expect(inboxScreen(0, "", 0)).toBe("empty");
  });
  const base = { shelf: "inbox", repo: "acme/orbit", query: "", reason: false, unreadOnly: false };
  test("a clean inbox is Inbox zero, with the ghost rows; every narrower empty says what narrowed it", () => {
    expect(emptyCopy(base)).toMatchObject({ title: "Inbox zero", sentence: "GitHub notifications for acme/orbit land here.", ghost: true, clear: false });
    expect(emptyCopy({ ...base, unreadOnly: true })).toMatchObject({ title: "Nothing unread", ghost: false });
    expect(emptyCopy({ ...base, reason: true }).title).toBe("Nothing for this reason");
    expect(emptyCopy({ ...base, shelf: "saved" }).title).toBe("Nothing saved yet");
    expect(emptyCopy({ ...base, shelf: "done" }).title).toBe("Nothing finished yet");
    expect(emptyCopy({ ...base, shelf: "turn" }).title).toBe("Nothing waits on you");
  });
  test("a search that found nothing offers to clear itself, and outranks the shelf", () => {
    expect(emptyCopy({ ...base, shelf: "done", query: " #12 " })).toMatchObject({ title: "Nothing matches \u201c#12\u201d", clear: true, ghost: false });
  });
});

const inbox = await Bun.file(new URL("../src/components/prs/Inbox.tsx", import.meta.url)).text();
const ci = await Bun.file(new URL("../src/components/prs/CiMetrics.tsx", import.meta.url)).text();
const code = (t: string) => t.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*|\{\/\*)/.test(l)).join("\n");

describe("a check row's pass chip, day bars and sort menu", () => {
  test("the pass chip reads the fail rate, in three tones, and says nothing without one", () => {
    expect(passChip({ failRate: 0.03 })).toEqual({ label: "97% pass", tone: "good" });
    expect(passChip({ failRate: 0.12 })).toEqual({ label: "88% pass", tone: "warn" });
    expect(passChip({ failRate: 0.4 })).toEqual({ label: "60% pass", tone: "bad" });
    expect(passChip({ failRate: null }).tone).toBe("neutral");
  });
  test("a day with no success is a stub, never zero seconds; the others scale to the tallest day", () => {
    const day = (median: number | null) => ({ day: "2026-08-01", runs: 1, median, n: 1 }) as CheckAggregate["trend"][number];
    expect(dayBars([day(60_000), day(30_000), day(null)])).toEqual([1, 0.5, null]);
    expect(dayBars([day(null)])).toEqual([null]);
  });
  test("every sort choice parses back to itself, and an unknown one is the default", () => {
    for (const c of SORT_CHOICES) expect(sortChoice(parseSortChoice(c.value))).toBe(c.value);
    expect(parseSortChoice("nonsense:up")).toEqual(DEFAULT_SORT);
  });
});

describe("each view filters its own rows from a box in its own header", () => {
  test("the bar's box is the board's search; Inbox and CI draw the kit's FilterField and keep no copy of the text", () => {
    expect(code(inbox)).not.toMatch(/<input\b/);
    expect(code(ci)).not.toMatch(/<input\b/);
    expect(code(inbox)).toContain("<FilterField");
    expect(code(ci)).toContain("<FilterField");
    expect(inbox).toContain("const q = filterText;");
    expect(ci).toContain("const query = filterText;");
  });
});

describe("the Inbox layout", () => {
  /** The renderRow function's own text, to its closing brace. */
  const row = inbox.slice(inbox.indexOf("const renderRow = ("), inbox.indexOf("const unreadHere"));
  test("has no side rail: the list takes the whole width", () => {
    expect(inbox).not.toContain("railFolds");
    expect(inbox).not.toContain("INBOX_RAIL_WIDTH");
  });
  test("a row is the mockup's grid: tick, tile, title, tag with CI dot and age, verbs", () => {
    expect(row).toContain('className="agx-irow"');
    expect(row).toContain('className="agx-srow-tile"');
    expect(row).toContain("inboxCiState(n, prs, repo)");
    expect(row).toContain("agx-pc-tag");
    const css = Bun.file(new URL("../src/index.css", import.meta.url));
    return css.text().then((t) => {
      expect(t).toMatch(/\.agx-irow \{[^}]*grid-template-columns: 18px 22px minmax\(0, 1fr\) auto auto/);
      expect(t).toMatch(/\.agx-irow \{[^}]*min-height: 50px/);
    });
  });
  test("the verbs are drawn at rest, as the design has them, and laid out in every state so nothing moves", () => {
    expect(row).not.toContain("agx-hover-show");
    expect(row).toContain('className="agx-irow-acts"');
    expect(row).not.toMatch(/hidden[^"]*group-hover|group-hover:(flex|block|inline)/);
    for (const verb of ['label="Mark read"', 'label={saved ? "Saved" : "Save"}', 'label={done ? "Put back" : "Done"}']) expect(row).toContain(verb);
  });
  test("an unread row is bold with a 7px accent dot, and the row keeps its size when it is read", () => {
    expect(row).toContain('data-unread={unread ? "1" : undefined}');
    expect(row).toContain('className="agx-udot"');
    expect(row).not.toContain("inset 3px 0 0");
  });
  test("the bulk verbs live in a menu inside the view", () => {
    expect(inbox).toContain("Mark this repository read");
    expect(inbox).toContain("Mark all read (");
  });
  test("the bulk bar sits under the list: N selected, then Mark read, Save, Done, Unsubscribe (danger) and Clear, with select all", () => {
    const bar = inbox.slice(inbox.indexOf('className="agx-pickbar"'));
    expect(bar).toContain('label="Select all"');
    expect(bar).toContain("{picked.size} selected");
    expect(bar).toContain('tone="danger"');
    expect(bar.indexOf('tone="danger"')).toBeLessThan(bar.indexOf("Unsubscribe"));
    expect(bar.indexOf('tone="danger"')).toBeGreaterThan(bar.indexOf("Done"));
    expect(bar.indexOf("Mark read")).toBeLessThan(bar.indexOf("Unsubscribe"));
    expect(bar.indexOf("Unsubscribe")).toBeLessThan(bar.indexOf(">Clear<"));
    expect(inbox.indexOf('className="agx-pickbar"')).toBeGreaterThan(inbox.indexOf("{screen === \"rows\" && botBlock}"));
  });
  test("the header is the kit's: Segmented shelves, Segmented order, a square reverse and a square more", () => {
    expect(inbox).toContain('label="Shelf"');
    expect(inbox).toContain('label="Sort"');
    expect(inbox).toContain('label="Reverse order"');
    expect(inbox).toContain('<Pop square title="More"');
    expect(code(inbox)).not.toMatch(/function Switch/);
  });
  test("the reason chips are 24 high, carry no number, and keep the two extra filters in More", () => {
    expect(inbox).toContain('data-sm=""');
    expect(inbox).not.toContain("agx-vchip-k");
    expect(inbox).toContain("CHIP_FACETS.includes(c.id) || c.id === facet");
    expect(inbox).toContain("FACETS.filter((f) => !CHIP_FACETS.includes(f.id))");
  });
  test("a refused first read is the notice with Try again; an empty list is the blank, never a bare sentence", () => {
    expect(inbox).toContain('<PrNotice title="GitHub said no"');
    expect(inbox).toContain(">Try again</Button>");
    expect(inbox).toContain("<PrBlank");
    expect(inbox).toContain("emptyCopy(");
  });
  test("the same request budget: one read, one poll through usePoll, no timer", () => {
    expect(inbox).toContain("usePoll(active");
    expect(inbox).not.toContain("setInterval(");
    expect(inbox.match(/api\.prsInbox\(/g)!.length).toBe(1);
  });
  test("no raw colour: tokens only, so dark follows", () => {
    expect(code(inbox)).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(/);
  });
});

describe("the CI view", () => {
  test("the table is not clipped, and a row is a disclosure button that says whether it is open", () => {
    expect(ci).toContain("aria-expanded={open}");
    const table = ci.slice(ci.indexOf('role="table"'), ci.indexOf('role="table"') + 160);
    expect(table).not.toContain("overflow-hidden");
  });
  test("the tiles are buttons with a pressed state, in a four column grid, and each opens its chip", () => {
    expect(ci).toContain("aria-pressed={on}");
    expect(ci).toContain("onClick={() => setChip(viewOfTile(t))}");
    expect(ci).toContain('className="agx-tiles2"');
    expect(ci).toContain("TILES.map(");
  });
  test("the history and the failing tests are two boxes on the page, with the history's counts in its header", () => {
    expect(ci).toContain("Check history");
    expect(ci.match(/className="agx-cibox"/g)!.length).toBe(1);
    expect(ci).toContain("<FailingTestsLens");
    expect(ci.indexOf("Check history")).toBeLessThan(ci.indexOf("<FailingTestsLens"));
  });
  test("every fact of the old columns is still on a row or in its opened panel, and the sort is a menu in the header", () => {
    for (const w of ["Slow end", "Fails", "This run against its own history", "Status", "usual"]) expect(ci).toContain(w);
    expect(ci).toContain("<DayBars");
    expect(ci).toContain("<Spark");
    expect(ci).toContain("SORT_CHOICES.map(");
    expect(ci).toContain("setSort(parseSortChoice(v))");
  });
  test("a failed read of the history is the notice with Try again; no runs is the blank", () => {
    expect(ci).toContain('title="Could not read the check history"');
    expect(ci).toContain('title="0 runs recorded"');
    expect(ci).toContain(">Try again</Button>");
  });
  test("no raw colour in the tiles' hues: tokens only", () => {
    expect(code(ci)).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(/);
  });
});
