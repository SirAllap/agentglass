import { describe, expect, it } from "bun:test";
import { barCells, fileRows, filesTotal, miniCard, parseRefs, pickedLabel, pickedList, relativePath, shortAgo } from "../src/lib/gitLogView.ts";
import { layoutGraph } from "../src/lib/gitGraph.ts";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { RefChips } from "../src/components/git/RefChips.tsx";
import { PickBar } from "../src/components/git/PickBar.tsx";
import { FilesBlock } from "../src/components/git/CommitDetail.tsx";

describe("shortAgo", () => {
  it("shortens git's relative dates", () => {
    expect(shortAgo("12 minutes ago")).toBe("12m");
    expect(shortAgo("3 hours ago")).toBe("3h");
    expect(shortAgo("2 days ago")).toBe("2d");
    expect(shortAgo("1 week ago")).toBe("1w");
    expect(shortAgo("4 months ago")).toBe("4mo");
    expect(shortAgo("an hour ago")).toBe("1h");
    expect(shortAgo("")).toBe("");
  });
});

describe("parseRefs", () => {
  it("splits %D into a chip per ref and tells a remote from a slashed local branch", () => {
    expect(parseRefs("HEAD -> main, origin/main, origin/HEAD, tag: v1.2.0, fix/login")).toEqual([
      { kind: "current", name: "main" }, { kind: "remote", name: "origin/main" },
      { kind: "tag", name: "v1.2.0" }, { kind: "branch", name: "fix/login" },
    ]);
  });
  it("knows the remotes it is given; a lone HEAD is no chip", () => {
    expect(parseRefs("HEAD, acme/topic", ["acme"])).toEqual([{ kind: "remote", name: "acme/topic" }]);
    expect(parseRefs(undefined)).toEqual([]);
  });
  it("draws a ringed chip per kind, and merge for two parents", () => {
    const html = renderToStaticMarkup(React.createElement(RefChips, { refs: "HEAD -> main, origin/main, tag: v1", merge: true }));
    for (const w of ["merge", "main", "origin/main", "v1"]) expect(html).toContain(w);
    expect(html.match(/<svg/g)?.length).toBe(4);
  });
});

describe("pick bar", () => {
  const log = ["a", "b", "c", "d"];
  it("lists the picks oldest first, the order they are applied", () => {
    expect(pickedList(new Set(["b", "d"]), log)).toEqual(["d", "b"]);
  });
  it("folds a long pick into +N", () => {
    expect(pickedLabel(["a", "b"])).toBe("a, b");
    expect(pickedLabel(["a", "b", "c", "d", "e", "f"])).toBe("a, b, c +3");
  });
  it("says how many, the order, and carries the bulk buttons; Squash needs two", () => {
    const bar = (shas: string[]) => renderToStaticMarkup(React.createElement(PickBar, { shas, branch: "main", onPick() {}, onStage() {}, onSquash() {}, onClear() {} }));
    const two = bar(["c14f9aa", "a81e04c"]);
    expect(two).toContain("2 picked");
    expect(two).toContain("c14f9aa, a81e04c");
    expect(two).toContain("in graph order");
    for (const w of ["Cherry-pick 2 onto", "Stage only", "Squash 2", "Clear"]) expect(two.replace(/<!-- -->/g, "")).toContain(w);
    expect(bar(["c14f9aa"])).not.toContain("Squash");
  });
});

describe("files of a commit", () => {
  it("bars: proportion in five cells, a side that exists keeps one", () => {
    expect(barCells(0, 0)).toEqual(["", "", "", "", ""]);
    expect(barCells(10, 0)).toEqual(["a", "a", "a", "a", "a"]);
    expect(barCells(1, 40)).toEqual(["a", "r", "r", "r", "r"]);
    expect(barCells(3, 3).filter((c) => c === "a").length + barCells(3, 3).filter((c) => c === "r").length).toBeLessThanOrEqual(5);
  });
  it("paths are relative to the repository, the directory apart from the name", () => {
    expect(relativePath("/work/orbit", "/work/orbit/web/src/a.ts")).toBe("web/src/a.ts");
    const rows = fileRows("/work/orbit", [
      { file_path: "/work/orbit/web/src/redirect.ts", status: "modified", additions: 3, deletions: 1 },
      { file_path: "/work/orbit/web/test/redirect.test.ts", status: "added", additions: 5, deletions: 0 },
    ]);
    expect(rows.map((r) => [r.status, r.dir, r.name])).toEqual([["M", "web/src/", "redirect.ts"], ["A", "web/test/", "redirect.test.ts"]]);
    expect(filesTotal(rows)).toEqual({ files: 2, add: 8, del: 1 });
  });
  it("renders the heading with the totals and a row per file", () => {
    const html = renderToStaticMarkup(React.createElement(FilesBlock, { files: { state: "ok", rows: fileRows("/r", [{ file_path: "/r/a/b.ts", status: "added", additions: 2, deletions: 0 }]) } }));
    expect(html).toContain("1 · +2 −0");
    expect(html).toContain("b.ts");
  });
});

describe("miniCard", () => {
  // main: m3 <- m2 <- m1; topic forks at m1 and is merged by m3.
  const lines = [
    { graph: "", hash: "m3", parents: ["m2", "t2"], refs: "HEAD -> main" },
    { graph: "", hash: "t2", parents: ["t1"], refs: "origin/topic" },
    { graph: "", hash: "t1", parents: ["m1"] },
    { graph: "", hash: "m2", parents: ["m1"] },
    { graph: "", hash: "m1", parents: [] },
  ];
  const layout = new Map(layoutGraph(lines.map((l) => ({ hash: l.hash, parents: l.parents }))).map((r) => [r.hash, r]));
  it("puts the selected commit and its neighbours on one track per lane, labelled only by a known ref", () => {
    const m = miniCard(lines, layout, "m3")!;
    expect(m.dots.map((d) => d.hash).sort()).toEqual(["m2", "m3", "t1", "t2"]);
    expect(m.dots.filter((d) => d.sel).map((d) => d.hash)).toEqual(["m3"]);
    expect(m.labels.map((l) => l.text)).toEqual(["main", "topic · 2 commits"]);
    expect(m.edges.length).toBe(5); // m3-m2, m3-t2, t2-t1, and t1 and m2 each reach a parent outside the window
  });
  it("is null for a commit that is not in the log, and draws a stub when the parent is out of the window", () => {
    expect(miniCard(lines, layout, "zzz")).toBeNull();
    const far = Array.from({ length: 12 }, (_, i) => ({ graph: "", hash: `c${i}`, parents: i < 11 ? [`c${i + 1}`] : [] }));
    const lay = new Map(layoutGraph(far.map((l) => ({ hash: l.hash, parents: l.parents }))).map((r) => [r.hash, r]));
    const m = miniCard(far, lay, "c6")!;
    expect(m.dots).toHaveLength(7);
    expect(m.labels).toEqual([]);
  });
});

describe("c picks the commit under the cursor", () => {
  it("indexes the rows on screen (a search filters them), not the whole log", async () => {
    const src = await Bun.file(new URL("../src/components/GitPanel.tsx", import.meta.url)).text();
    const at = src.indexOf('if (lower === "c") {');
    const body = src.slice(at, src.indexOf("\n        }\n", at));
    expect(body).toContain("logCommits[");
    expect(body).not.toContain("graph[rowIdx]");
  });
});

describe("the dock stays on one row at the mockup's width", () => {
  it("draws every dock button at the compact rung", async () => {
    const src = await Bun.file(new URL("../src/components/GitDock.tsx", import.meta.url)).text();
    const at = src.indexOf("const btn = (a: DockAction)");
    const body = src.slice(at, src.indexOf("\n  );\n", at));
    expect(body).toContain('size="compact"');
    expect(src).toContain('data-dock="more" aria-haspopup="menu"');
    expect(src.slice(src.indexOf("{!!more.length && ("), src.indexOf('data-dock="more"'))).toContain('size="compact"');
  });
});
