/*
 * The Inbox and CI views of the PRs panel after they lost their side rail and
 * their five buttons: the reason chips, the day groups, the four tiles and the
 * one status word of a row are pure functions; the layout rules are asserted
 * against the source because this project has no renderer.
 */
import { describe, expect, test } from "bun:test";
import { byDay, FACETS, inFacet, reasonChips } from "../src/lib/ghInbox.ts";
import { chipCounts, inChip, statusChip, TILES, tileOf, toRow, viewOfTile, type CiView } from "../src/lib/ciMetrics.ts";
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
    expect(chips[0]).toMatchObject({ id: "", label: "All reasons", n: 5 });
    expect(chips.slice(1).map((c) => c.id)).toEqual(FACETS.map((f) => f.id));
  });
  test("each chip counts what pressing it would leave", () => {
    expect(by("review").n).toBe(1);
    expect(by("mentioned").n).toBe(2);
    expect(by("team").n).toBe(1);
    expect(by("assigned").n).toBe(0);
    for (const c of reasonChips(items).slice(1)) expect(c.n).toBe(items.filter((n) => inFacet(n, c.id)).length);
  });
  test("participating counts the threads the person is in, not the ones merely watched", () => {
    expect(by("participating").n).toBe(4);
  });
  test("an empty list is five zeros and the all chip at zero", () => {
    expect(reasonChips([]).every((c) => c.n === 0)).toBe(true);
  });
});

describe("day groups", () => {
  const now = Date.parse("2026-08-19T12:00:00Z");
  test("newest first stays newest first inside the groups, and the groups keep the list's order", () => {
    const rows = [
      note({ id: "a", at: now - 3600_000 }),
      note({ id: "b", at: now - 7200_000 }),
      note({ id: "c", at: now - 86_400_000 }),
      note({ id: "d", at: now - 9 * 86_400_000 }),
    ];
    const g = byDay(rows, now);
    expect(g.map((x) => x.label).slice(0, 2)).toEqual(["Today", "Yesterday"]);
    expect(g.map((x) => x.items.map((n) => n.id))).toEqual([["a", "b"], ["c"], ["d"]]);
  });
  test("nothing is dropped and an empty list has no group", () => {
    expect(byDay([], now)).toEqual([]);
    const rows = Array.from({ length: 7 }, (_, i) => note({ id: String(i), at: now - i * 86_400_000 }));
    expect(byDay(rows, now).reduce((n, g) => n + g.items.length, 0)).toBe(7);
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

describe("the four tiles", () => {
  test("a tile is the chip of its own name, and the fourth holds Drifting and Failing tests", () => {
    expect(TILES).toEqual(["all", "slow", "rerun", "attention"]);
    const views: CiView[] = ["all", "slow", "rerun", "drifting", "tests"];
    expect(views.map(tileOf)).toEqual(["all", "slow", "rerun", "attention", "attention"]);
  });
  test("pressing a tile opens the view with a table; the fourth opens on Drifting", () => {
    expect(TILES.map(viewOfTile)).toEqual(["all", "slow", "rerun", "drifting"]);
    for (const t of TILES) expect(tileOf(viewOfTile(t))).toBe(t);
  });
  test("each tile filters the table to what its number says, and the five old filters are all still reachable", () => {
    const counts = chipCounts(rows);
    for (const t of TILES) expect(rows.filter((r) => inChip(viewOfTile(t), r)).length).toBe(counts[viewOfTile(t)]);
    expect(counts.all).toBe(5);
    expect(rows.filter((r) => inChip("slow", r)).map((r) => r.name)).toEqual(["slow"]);
    expect(rows.filter((r) => inChip("rerun", r)).map((r) => r.name)).toEqual(["rerun"]);
    expect(rows.filter((r) => inChip("drifting", r)).map((r) => r.name)).toEqual(["drifting"]);
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

const inbox = await Bun.file(new URL("../src/components/prs/Inbox.tsx", import.meta.url)).text();
const ci = await Bun.file(new URL("../src/components/prs/CiMetrics.tsx", import.meta.url)).text();
const code = (t: string) => t.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*|\{\/\*)/.test(l)).join("\n");

describe("the bar owns the search box", () => {
  test("neither view draws a text input; both take the text from a prop and keep no copy of it", () => {
    expect(code(inbox)).not.toMatch(/<input\b/);
    expect(code(ci)).not.toMatch(/<input\b|<FilterField/);
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
  test("a card wraps its trailing columns under the title instead of squeezing it", () => {
    expect(row).toContain("group flex flex-wrap items-start");
    expect(row).toMatch(/min-w-\[\d+px\] flex-1 text-left/);
  });
  test("the tick and the verbs are always laid out, so hovering moves nothing", () => {
    expect(row.match(/agx-hover-show/g)!.length).toBe(2);
    expect(row).not.toMatch(/hidden[^"]*group-hover|group-hover:(flex|block|inline)/);
  });
  test("the unread edge is drawn inside the card, which keeps its size when it is read", () => {
    expect(row).toContain("inset 3px 0 0 var(--primary)");
  });
  test("the bulk verbs live in a menu inside the view", () => {
    expect(inbox).toContain("Mark this repository read");
    expect(inbox).toContain("Mark all read (");
  });
  test("the same request budget: one read, one poll through usePoll, no timer", () => {
    expect(inbox).toContain("usePoll(active");
    expect(inbox).not.toContain("setInterval(");
    expect(inbox.match(/api\.prsInbox\(/g)!.length).toBe(1);
  });
});

describe("the CI view", () => {
  test("the header stays under the scroll: sticky, and the table is not clipped", () => {
    expect(ci).toContain("sticky top-0");
    const table = ci.slice(ci.indexOf('role="table"'), ci.indexOf('role="table"') + 160);
    expect(table).not.toContain("overflow-hidden");
  });
  test("the tiles are buttons with a pressed state, and the fourth holds two", () => {
    expect(ci).toContain("aria-pressed={on}");
    expect(ci).toContain('setChip("drifting")');
    expect(ci).toContain('setChip("tests")');
  });
});
