import { describe, expect, it } from "bun:test";
import { avatarSlot, initialsOf } from "../src/lib/avatarColour.ts";
import { commitMatches, escapeClearsSearch, filterKeepingSelected, pathMatches, reflogMatches, searchEmpty } from "../src/lib/gitSearch.ts";
import { layoutGraph } from "../src/lib/gitGraph.ts";
import { MINI_LANES, miniRow } from "../src/lib/gitMiniGraph.ts";

const panel = await Bun.file(new URL("../src/components/GitPanel.tsx", import.meta.url)).text();
const diffLines = await Bun.file(new URL("../src/components/diff/DiffLines.tsx", import.meta.url)).text();
const isComment = (l: string) => l.trimStart().startsWith("//") || l.trimStart().startsWith("*") || l.trimStart().startsWith("/*");
const code = (t: string) => t.split("\n").filter((l) => !isComment(l)).join("\n");

const commits = [
  { hash: "5d0b7e2aaa", subject: "Merge branch fix/login-redirect", author: "Theo Lind" },
  { hash: "a81e04c000", subject: "Keep invoice totals in cents", author: "Mia Okoye" },
];

describe("search per tab", () => {
  it("Log: message, author, sha prefix, case-insensitive", () => {
    expect(commits.filter((c) => commitMatches(c, "INVOICE")).map((c) => c.hash)).toEqual(["a81e04c000"]);
    expect(commits.filter((c) => commitMatches(c, "theo")).length).toBe(1);
    expect(commits.filter((c) => commitMatches(c, "5d0b")).length).toBe(1);
    expect(commitMatches(commits[0]!, "e2aaa")).toBe(false); // a sha is a prefix, not a substring
    expect(commits.filter((c) => commitMatches(c, "  ")).length).toBe(2);
  });
  it("Reflog: message, action and sha", () => {
    const e = { subject: "wip", action: "checkout", shortHash: "5d0b7e2" };
    expect(reflogMatches(e, "check")).toBe(true);
    expect(reflogMatches(e, "5d0b")).toBe(true);
    expect(reflogMatches(e, "nope")).toBe(false);
  });
  it("Changes: path", () => {
    expect(pathMatches("web/src/auth/Login.tsx", "login")).toBe(true);
    expect(pathMatches("web/src/auth/Login.tsx", "billing")).toBe(false);
  });
  it("a hidden selection is pinned on top; a matching one is not", () => {
    const hidden = filterKeepingSelected(commits, "invoice", commitMatches, "5d0b7e2aaa");
    expect(hidden.rows.map((c) => c.hash)).toEqual(["5d0b7e2aaa", "a81e04c000"]);
    expect(hidden.pinned).toBe("5d0b7e2aaa");
    expect(filterKeepingSelected(commits, "invoice", commitMatches, "a81e04c000").pinned).toBeNull();
    expect(filterKeepingSelected(commits, "zzz", commitMatches, null).rows).toEqual([]);
  });
  it("Escape clears first, then is not ours", () => {
    expect(escapeClearsSearch("abc")).toBe(true);
    expect(escapeClearsSearch("")).toBe(false);
  });
  it("the empty frame needs a typed search and no row left", () => {
    expect(searchEmpty("zzz", 0)).toBe(true);
    expect(searchEmpty("", 0)).toBe(false);
    expect(searchEmpty("  ", 0)).toBe(false);
    expect(searchEmpty("a", 2)).toBe(false);
  });
  it("Changes section counts are the filtered ones", () => {
    expect(code(panel)).toContain('<Section title="Staged" count={shownStaged.length}');
    expect(code(panel)).toContain('<Section title="Changes" count={shownUnstaged.length}');
  });
  it("every tab renders the box and the empty frame", async () => {
    const c = code(panel);
    expect((c.match(/searchEmpty\(q, /g) ?? []).length).toBe(3);
    expect(await Bun.file(new URL("../src/components/git/LogSearch.tsx", import.meta.url)).text()).toContain("Search commits by message, author or sha");
    expect(c).toContain("Search where HEAD has been");
    expect(c).toContain("Search changed files by path");
    expect((c.match(/<NothingMatches /g) ?? []).length).toBe(3);
  });
});

describe("avatar", () => {
  it("initials: two words, one word, empty", () => {
    expect(initialsOf("theo lind")).toBe("TL");
    expect(initialsOf("Theo")).toBe("T");
    expect(initialsOf("Mia Ada Okoye")).toBe("MA");
    expect(initialsOf("")).toBe("?");
  });
  it("colour slot is 1..8 and stable per author, case-blind", () => {
    const s = avatarSlot("Theo@orbit.dev");
    expect(s).toBeGreaterThanOrEqual(1);
    expect(s).toBeLessThanOrEqual(8);
    expect(avatarSlot("theo@ORBIT.dev")).toBe(s);
    expect(new Set(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map(avatarSlot)).size).toBeGreaterThan(2);
  });
});

describe("mini graph lanes", () => {
  // five branches open at once, then merged back: lanes 0..4
  const fixture = [
    { hash: "m", parents: ["a", "b", "c", "d", "e"] },
    { hash: "a", parents: ["z"] }, { hash: "b", parents: ["z"] }, { hash: "c", parents: ["z"] },
    { hash: "d", parents: ["z"] }, { hash: "e", parents: ["z"] }, { hash: "z", parents: [] },
  ];
  const rows = layoutGraph(fixture);
  it("never draws past three lanes and counts what it hid, per row", () => {
    const minis = rows.map((r) => miniRow(r));
    for (const m of minis) {
      expect(m.dot).toBeLessThan(MINI_LANES);
      for (const l of m.links) { expect(l.from).toBeLessThan(MINI_LANES); expect(l.to).toBeLessThan(MINI_LANES); }
    }
    expect(minis.some((m) => m.hidden > 0)).toBe(true);
  });
  it("a row inside three lanes hides nothing", () => {
    const m = miniRow({ hash: "x", dot: 0, merge: false, width: 1, links: [{ from: 0, to: 0, lane: 0 }] });
    expect(m).toEqual({ links: [{ from: 0, to: 0, lane: 0, toEdge: false }], dot: 0, hidden: 0 });
  });
  it("an edge into a hidden lane ends at the edge; one wholly hidden is dropped", () => {
    const m = miniRow({ hash: "x", dot: 0, merge: true, width: 5, links: [{ from: 0, to: 4, lane: 4 }, { from: 3, to: 4, lane: 3 }, { from: 5, to: 5, lane: 5 }] });
    expect(m.links).toEqual([{ from: 0, to: 2, lane: 4, toEdge: true, hiddenEnd: "to" }]);
    expect(m.hidden).toBe(1); // lane 4 joins the dot; lanes 3-4 and 5 only pass through
  });
});

describe("mini graph drawing", () => {
  it("draws the edge dot for a link into a hidden lane, and no lanes for the pinned row", async () => {
    const mini = await Bun.file(new URL("../src/components/git/MiniGraph.tsx", import.meta.url)).text();
    const lists = await Bun.file(new URL("../src/components/git/Lists.tsx", import.meta.url)).text();
    expect(code(mini)).toContain("l.toEdge");
    expect(code(lists)).toContain("row={l.hash === ctx.pinned ? undefined : graph[i]}");
  });
});

describe("one set of hunk buttons", () => {
  it("the split diff draws the buttons on one side only, with no hidden copy", () => {
    const c = code(diffLines);
    const from = c.indexOf("const side = (which");
    const body = c.slice(from, c.indexOf("\n  );\n", from));
    expect((body.match(/hunkAction\(hi\)/g) ?? []).length).toBe(1);
    expect(body).not.toContain('visibility: "hidden" }}>{hunkAction');
  });
  it("the split header is a flex row: title truncates, buttons keep their width", () => {
    expect(diffLines).toContain('className="min-w-0 flex-1 truncate">@@');
    expect(diffLines).toContain('<span className="shrink-0">{hunkAction(hi)}</span>');
  });
  it("the header keeps a min-height so the two sides stay level", () => {
    expect(diffLines).toContain("minHeight: hunkAction ? HUNK_BAR_H");
  });
});
