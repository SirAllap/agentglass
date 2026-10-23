/*
 * What the Machine tab's preview does with a file, decided where it can be
 * tested: which viewer, which tabs, and the limits that keep a big file from
 * taking the pane down with it.
 */
import { describe, expect, test } from "bun:test";
import { PAGE_CSP, isolatedDoc, GRAPH_MAX_BYTES, HTML_RENDER_MAX_BYTES, JSON_READ_CAP, graphAllowed, htmlRenderable, previewPlan, readWindow } from "../src/lib/finderPreview.ts";
import { GRAPH_MARGIN, elide, graphFrame, graphLayout, jsonPath, searchTree, visibleRows } from "../src/lib/jsonView.ts";

const f = (name: string, kind: string, bytes = 100) => ({ name, kind: kind as never, bytes });

describe("previewPlan", () => {
  test("text is read by default, with the tabs its type earns", () => {
    expect(previewPlan(f("a.py", "text"))).toEqual({ viewer: "code", tabs: ["Reading"] });
    expect(previewPlan(f("notes.md", "text"))).toEqual({ viewer: "markdown", tabs: ["Rendered", "Source"] });
    expect(previewPlan(f("page.html", "text"))).toEqual({ viewer: "html", tabs: ["Source", "Rendered"] });
    expect(previewPlan(f("data.json", "text"))).toEqual({ viewer: "json", tabs: ["Reading", "Tree", "Graph"] });
  });
  test("a .svg is a picture, not source", () => {
    expect(previewPlan(f("logo.svg", "image")).viewer).toBe("image");
  });
  test("media kinds get their own viewer and a binary gets a message", () => {
    for (const k of ["pdf", "audio", "video", "image"]) expect(previewPlan(f("x", k)).viewer).toBe(k as never);
    expect(previewPlan(f("x", "image-convert")).viewer).toBe("convert");
    expect(previewPlan(f("x.bin", "binary")).viewer).toBe("binary");
  });
  test("an upper-case extension is the same extension", () => {
    expect(previewPlan(f("README.MD", "text")).viewer).toBe("markdown");
    expect(previewPlan(f("P.HTM", "text")).viewer).toBe("html");
  });
});

describe("limits", () => {
  test("html renders up to its cap and says so past it", () => {
    expect(htmlRenderable(HTML_RENDER_MAX_BYTES)).toBe(true);
    expect(htmlRenderable(HTML_RENDER_MAX_BYTES + 1)).toBe(false);
    expect(htmlRenderable(3 * 1024 * 1024)).toBe(true);
  });
  test("the graph is for json under about a megabyte, the tree reads more", () => {
    expect(graphAllowed(GRAPH_MAX_BYTES)).toBe(true);
    expect(graphAllowed(GRAPH_MAX_BYTES + 1)).toBe(false);
    expect(JSON_READ_CAP).toBeGreaterThan(GRAPH_MAX_BYTES);
  });
  test("readWindow keeps the first lines and counts what it left", () => {
    const text = Array.from({ length: 10 }, (_, i) => `l${i}`).join("\n");
    expect(readWindow(text, 4)).toEqual({ lines: ["l0", "l1", "l2", "l3"], more: 6 });
    expect(readWindow("a\nb\n", 5)).toEqual({ lines: ["a", "b"], more: 0 });
  });
});

describe("jsonPath", () => {
  test("keys are dotted, indexes bracketed, odd keys quoted", () => {
    expect(jsonPath("$", "files")).toBe("$.files");
    expect(jsonPath("$.files", 3)).toBe("$.files[3]");
    expect(jsonPath("$.files[3]", "path")).toBe("$.files[3].path");
    expect(jsonPath("$", "has space")).toBe('$["has space"]');
    expect(jsonPath("$", 'q"uote')).toBe('$["q\\"uote"]');
    expect(jsonPath("$", "0day")).toBe('$["0day"]');
  });
});

describe("the tree", () => {
  const data = { name: "orbit", files: [{ path: "a" }, { path: "b" }], n: 3 };
  test("only what is expanded is listed, with depth and a path", () => {
    const rows = visibleRows(data, new Set(["$"]));
    expect(rows.map((r) => r.path)).toEqual(["$", "$.name", "$.files", "$.n"]);
    const all = visibleRows(data, new Set(["$", "$.files", "$.files[0]"]));
    expect(all.map((r) => r.path)).toContain("$.files[0].path");
    expect(all.find((r) => r.path === "$.files[0].path")!.depth).toBe(3);
  });
  test("a container says how many it holds", () => {
    const r = visibleRows(data, new Set(["$"]));
    expect(r[0]!.summary).toBe("3 keys");
    expect(r.find((x) => x.path === "$.files")!.summary).toBe("2 items");
  });
  test("a very wide array lists a page and says how many it left", () => {
    const wide = { a: Array.from({ length: 1000 }, (_, i) => i) };
    const rows = visibleRows(wide, new Set(["$", "$.a"]), 200);
    expect(rows.filter((r) => r.path.startsWith("$.a[")).length).toBe(200);
    expect(rows[rows.length - 1]!.more).toBe(800);
  });
  test("search finds keys and values, and names the folds to open", () => {
    const hit = searchTree(data, "b");
    expect(hit.paths.has("$.files[1].path")).toBe(true);
    expect(hit.open.has("$.files")).toBe(true);
    expect(hit.open.has("$.files[1]")).toBe(true);
    expect(searchTree(data, "").paths.size).toBe(0);
    expect(searchTree(data, "ORBIT").paths.has("$.name")).toBe(true);
  });
});

describe("the graph", () => {
  const measure = (t: string) => t.length * 7;
  test("a long value is elided and the node is as wide as its text, no wider than the cap", () => {
    expect(elide("x".repeat(200), 30).length).toBe(30);
    expect(elide("short", 30)).toBe("short");
    const g = graphLayout({ title: "t", long: "y".repeat(500) }, measure);
    const root = g.nodes[0]!;
    expect(root.w).toBeLessThanOrEqual(g.maxW);
    expect(root.w).toBeGreaterThan(measure("title: t"));
    const small = graphLayout({ a: 1 }, measure).nodes[0]!;
    expect(small.w).toBeLessThan(root.w);
  });
  test("nested objects and arrays become linked nodes in columns by depth", () => {
    const g = graphLayout({ name: "x", files: [{ p: 1 }, { p: 2 }], meta: { k: true } }, measure);
    expect(g.nodes.length).toBe(5);
    expect(g.edges.length).toBe(4);
    const xs = g.nodes.map((n) => n.x);
    expect(xs[0]).toBe(0);
    for (const e of g.edges) expect(g.nodes[e.to]!.x).toBeGreaterThan(g.nodes[e.from]!.x);
  });
  test("nodes never overlap inside a column", () => {
    const g = graphLayout({ a: [{ x: 1 }, { x: 2 }, { x: 3 }], b: [{ y: 1 }, { y: 2 }] }, measure);
    for (const a of g.nodes) for (const b of g.nodes) {
      if (a === b || a.x !== b.x) continue;
      expect(a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true);
    }
  });
  test("the drawing is bounded and says how many nodes it left out", () => {
    const big = { a: Array.from({ length: 2000 }, (_, i) => ({ i })) };
    const g = graphLayout(big, measure);
    expect(g.nodes.length).toBeLessThanOrEqual(g.maxNodes);
    expect(g.omitted).toBeGreaterThan(0);
  });
  test("every box sits inside the frame it is drawn in, margin included", () => {
    const g = graphLayout({ name: "x", files: [{ p: 1 }, { p: 2 }], meta: { k: "v".repeat(90), deep: { a: { b: [1, { c: 2 }] } } } }, measure);
    const f = graphFrame(g);
    for (const n of g.nodes) {
      expect(n.x + GRAPH_MARGIN).toBeGreaterThanOrEqual(0);
      expect(n.y + GRAPH_MARGIN).toBeGreaterThanOrEqual(0);
      expect(n.x + n.w + GRAPH_MARGIN).toBeLessThanOrEqual(f.w);
      expect(n.y + n.h + GRAPH_MARGIN).toBeLessThanOrEqual(f.h);
    }
  });
  test("a box is wide enough for the longest line it holds", () => {
    const g = graphLayout({ key: "z".repeat(40), other: 1, nested: { a: 1 } }, measure);
    for (const n of g.nodes) for (const line of [n.title, ...n.rows]) expect(n.w).toBeGreaterThanOrEqual(Math.min(g.maxW, measure(line) + 20));
  });
  test("a bare value is one node and no edges", () => {
    const g = graphLayout(42, measure);
    expect(g.nodes.length).toBe(1);
    expect(g.edges.length).toBe(0);
  });
});

describe("isolatedDoc", () => {
  test("the policy goes inside <head>, after the doctype, so the page stays in standards mode", () => {
    const out = isolatedDoc("<!doctype html><html><head><title>t</title></head><body>x</body></html>");
    expect(out.startsWith("<!doctype html>")).toBe(true);
    expect(out.indexOf("Content-Security-Policy")).toBeGreaterThan(out.indexOf("<head>"));
    expect(out.indexOf("Content-Security-Policy")).toBeLessThan(out.indexOf("<title>"));
    expect(out).toContain(PAGE_CSP);
  });
  test("a fragment, or a doctype with no head, still gets it first", () => {
    expect(isolatedDoc("<p>hi</p>").startsWith("<meta")).toBe(true);
    const d = isolatedDoc("<!DOCTYPE html><p>hi</p>");
    expect(d.startsWith("<!DOCTYPE html><meta")).toBe(true);
  });
  test("the policy allows no script, no connection and no remote picture", () => {
    expect(PAGE_CSP).toContain("default-src 'none'");
    expect(PAGE_CSP).not.toMatch(/script-src|connect-src|https?:/);
  });
});

import { sortedOrder } from "../src/lib/finderPreview.ts";
describe("a markdown table sorts by its header", () => {
  test("numbers as numbers, text by name, empty cells last either way", () => {
    expect(sortedOrder(["10", "9", "100"], "asc")).toEqual([1, 0, 2]);
    expect(sortedOrder(["10", "9", "100"], "desc")).toEqual([2, 0, 1]);
    expect(sortedOrder(["b", "", "a"], "asc")).toEqual([2, 0, 1]);
    expect(sortedOrder(["b", "", "a"], "desc")).toEqual([0, 2, 1]);
  });
});
